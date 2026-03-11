import { access, readFile } from 'node:fs/promises';

import { chromium } from 'playwright';

async function readJobsFromFile(rawJobsPath) {
  try {
    await access(rawJobsPath);
    const raw = await readFile(rawJobsPath, 'utf8');
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs)) {
      throw new Error('Raw jobs file must contain an array');
    }
    return jobs;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('No raw jobs input found. Provide reports/raw-jobs.json or use Playwright live scraping.');
    }
    throw error;
  }
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function textOrEmpty(locator) {
  const count = await locator.count();
  if (count === 0) {
    return '';
  }
  return normalizeWhitespace(await locator.first().textContent());
}

function firstNonEmpty(...values) {
  return values.map((value) => normalizeWhitespace(value)).find(Boolean) ?? '';
}

async function findJobsPage(context) {
  const pages = context.pages();
  const matchingPage = pages.find((page) => page.url().includes('linkedin.com/jobs'));
  if (matchingPage) {
    return matchingPage;
  }
  return pages[0] ?? context.newPage();
}

async function ensureLinkedInJobsPage(page) {
  await page.waitForLoadState('domcontentloaded');
  const url = page.url();
  if (!url.includes('linkedin.com/jobs')) {
    throw new Error('Open a LinkedIn jobs search page in the connected browser before running the CLI.');
  }
}

async function autoScrollJobsList(page) {
  const cardSelector = '[data-view-name="job-search-job-card"]';
  for (let index = 0; index < 20; index += 1) {
    await page.locator(cardSelector).nth(Math.max(0, index - 1)).scrollIntoViewIfNeeded().catch(() => {});
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(450);
  }
}

function buildLinkedInJobUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

function getCurrentJobIdFromUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.searchParams.get('currentJobId');
  } catch {
    return null;
  }
}

function extractJobIdFromHref(href) {
  if (!href) {
    return null;
  }

  try {
    const absolute = href.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString();
    const url = new URL(absolute);
    const currentJobId = url.searchParams.get('currentJobId');
    if (currentJobId) {
      return currentJobId;
    }

    const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
    return viewMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

async function collectJobLinks(page, limit) {
  const cardSelector = '[data-view-name="job-search-job-card"]';
  const cards = page.locator(cardSelector);
  const cardCount = await cards.count();
  const links = [];
  const seen = new Set();

  for (let index = 0; index < Math.min(cardCount, limit * 4); index += 1) {
    const card = cards.nth(index);
    const cardText = normalizeWhitespace(await card.textContent());
    if (!cardText) {
      continue;
    }

    await card.scrollIntoViewIfNeeded().catch(() => {});

    const hrefs = await card.locator('a[href]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('href')).filter(Boolean)
    ).catch(() => []);

    let jobId = hrefs.map(extractJobIdFromHref).find(Boolean) ?? null;

    if (!jobId) {
      await card.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);
      jobId = getCurrentJobIdFromUrl(page.url());
    }

    if (!jobId || seen.has(jobId)) {
      continue;
    }

    seen.add(jobId);
    links.push(buildLinkedInJobUrl(jobId));
    if (links.length >= limit) {
      break;
    }
  }

  return links;
}

function parseCriteria(criteriaEntries) {
  const parsed = {
    employmentType: '',
    companySize: '',
  };

  for (const entry of criteriaEntries) {
    const label = entry.label.toLowerCase();
    if (label.includes('employment type')) {
      parsed.employmentType = entry.value;
    }
    if (label.includes('company size')) {
      parsed.companySize = entry.value;
    }
  }

  return parsed;
}

function inferVisaPolicy(description) {
  const text = description.toLowerCase();
  if (
    text.includes('visa sponsorship available') ||
    text.includes('sponsorship available') ||
    text.includes('will sponsor')
  ) {
    return 'sponsorship available';
  }
  if (
    text.includes('no sponsorship') ||
    text.includes('unable to sponsor') ||
    text.includes('cannot sponsor') ||
    text.includes('not eligible for sponsorship') ||
    text.includes('must be authorized to work')
  ) {
    return 'no sponsorship';
  }
  return '';
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJobFromMainText(mainText, pageTitle) {
  const normalizedText = normalizeWhitespace(mainText);
  const titleParts = pageTitle.split(' | ').map((part) => normalizeWhitespace(part));
  const parsedTitle = titleParts[0] ?? '';
  const parsedCompany = titleParts[1] ?? '';

  const headerPattern = new RegExp(`${escapeForRegex(parsedCompany)}\\s*${escapeForRegex(parsedTitle)}\\s+(.+?)\\s+?\\s+(.+?)\\s+?\\s+(.+?)Responses managed`, 'i');
  const headerMatch = normalizedText.match(headerPattern);

  const location = headerMatch?.[1] ?? '';
  const postedTime = headerMatch?.[2] ?? '';
  const applicantInfo = headerMatch?.[3] ?? '';

  const workModeMatch = normalizedText.match(/Responses managed off LinkedIn(.*?)(Apply|Save|Use AI to assess)/i);
  const headerTail = workModeMatch?.[1] ?? '';
  const employmentType = headerTail.match(/(Full-time|Part-time|Contract|Temporary|Internship)/i)?.[1] ?? '';

  const descriptionMatch = normalizedText.match(/About the jobDescription\s*(.*?)(Set alert for similar jobs|See how you compare|About the company|Show Premium Insights|Interested in working with us)/i);
  const description = descriptionMatch?.[1] ?? '';

  const companySizeMatch = normalizedText.match(/(\d{1,3}(?:,\d{3})*[-+]?(?:\d{1,3}(?:,\d{3})*)?\s+employees)/i);
  const companySize = companySizeMatch?.[1]?.replace(/\s+employees/i, '') ?? '';

  return {
    title: parsedTitle,
    company: parsedCompany,
    location,
    postedTime,
    applicantInfo,
    employmentType,
    companySize,
    description,
    visaPolicy: inferVisaPolicy(description),
  };
}

async function scrapeJobDetail(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1800);

  const pageTitle = await page.title();
  const mainText = await textOrEmpty(page.locator('main').first());
  const parsedFromText = parseJobFromMainText(mainText, pageTitle);

  const title = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__job-title, .t-24.job-details-jobs-unified-top-card__job-title')),
    parsedFromText.title
  );
  const company = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name, a[href*="/company/"]')),
    parsedFromText.company
  );
  const location = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(0)),
    parsedFromText.location
  );
  const postedTime = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(1)),
    parsedFromText.postedTime
  );
  const applicantInfo = firstNonEmpty(
    await textOrEmpty(page.locator('.jobs-unified-top-card__subtitle-secondary-grouping, .job-details-jobs-unified-top-card__tertiary-description')),
    parsedFromText.applicantInfo
  );
  const description = firstNonEmpty(
    await textOrEmpty(page.locator('.jobs-description__content, .jobs-box__html-content, .jobs-description-content__text, .show-more-less-html__markup, .description__text')),
    parsedFromText.description
  );

  const criteriaEntries = await page
    .locator('.description__job-criteria-item, .job-criteria__item')
    .evaluateAll((items) =>
      items.map((item) => {
        const label = item.querySelector('.description__job-criteria-subheader, .job-criteria__subheader')?.textContent ?? '';
        const value = item.querySelector('.description__job-criteria-text, .job-criteria__text')?.textContent ?? '';
        return {
          label: label.replace(/\s+/g, ' ').trim(),
          value: value.replace(/\s+/g, ' ').trim(),
        };
      })
    )
    .catch(() => []);

  const parsedCriteria = parseCriteria(criteriaEntries);

  return {
    title,
    company,
    location,
    postedTime,
    applicantInfo,
    employmentType: firstNonEmpty(parsedCriteria.employmentType, parsedFromText.employmentType),
    visaPolicy: firstNonEmpty(parsedFromText.visaPolicy, inferVisaPolicy(description)),
    companySize: firstNonEmpty(parsedCriteria.companySize, parsedFromText.companySize),
    description,
    jobUrl,
  };
}

async function scrapeJobsViaPlaywright({ cdpUrl, limit }) {
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context found. Launch Chrome with remote debugging and keep one window open.');
    }

    const searchPage = await findJobsPage(context);
    await ensureLinkedInJobsPage(searchPage);
    await autoScrollJobsList(searchPage);

    const jobLinks = await collectJobLinks(searchPage, limit);
    if (jobLinks.length === 0) {
      throw new Error('No LinkedIn job links were found on the current page.');
    }

    const detailPage = await context.newPage();
    try {
      const jobs = [];
      for (const jobUrl of jobLinks) {
        const job = await scrapeJobDetail(detailPage, jobUrl);
        jobs.push(job);
      }
      return jobs;
    } finally {
      await detailPage.close();
    }
  } finally {
    await browser.close();
  }
}

export async function collectJobs({ rawJobsPath, limit = 200, cdpUrl, source = 'auto' }) {
  if (source === 'raw') {
    return readJobsFromFile(rawJobsPath);
  }

  if (cdpUrl) {
    try {
      return await scrapeJobsViaPlaywright({ cdpUrl, limit });
    } catch (error) {
      if (source === 'live') {
        throw error;
      }
    }
  }

  return readJobsFromFile(rawJobsPath);
}
