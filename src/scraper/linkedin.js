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
  const listSelector = '.jobs-search-results-list, .scaffold-layout__list, .jobs-search-results-list__list';
  const list = page.locator(listSelector).first();
  const hasList = (await list.count()) > 0;

  if (!hasList) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1000);
    return;
  }

  for (let index = 0; index < 12; index += 1) {
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(900);
  }
}

async function collectJobLinks(page, limit) {
  const selectors = [
    'a.job-card-list__title',
    'a.job-card-container__link',
    '.jobs-search-results-list a[href*="/jobs/view/"]',
  ];

  const links = new Set();

  for (const selector of selectors) {
    const hrefs = await page.locator(selector).evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute('href'))
        .filter(Boolean)
        .map((href) => {
          if (href.startsWith('http')) {
            return href;
          }
          return new URL(href, 'https://www.linkedin.com').toString();
        })
    );
    for (const href of hrefs) {
      links.add(href);
      if (links.size >= limit) {
        return [...links];
      }
    }
  }

  return [...links];
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
    text.includes('not eligible for sponsorship')
  ) {
    return 'no sponsorship';
  }
  return '';
}

async function scrapeJobDetail(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  const title = await textOrEmpty(
    page.locator('.job-details-jobs-unified-top-card__job-title, .t-24.job-details-jobs-unified-top-card__job-title')
  );
  const company = await textOrEmpty(
    page.locator('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name')
  );
  const location = await textOrEmpty(
    page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(0)
  );
  const postedTime = await textOrEmpty(
    page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(1)
  );
  const applicantInfo = await textOrEmpty(
    page.locator('.jobs-unified-top-card__subtitle-secondary-grouping, .job-details-jobs-unified-top-card__tertiary-description')
  );
  const description = await textOrEmpty(
    page.locator('.jobs-description__content, .jobs-box__html-content, .jobs-description-content__text')
  );

  const criteriaEntries = await page
    .locator('.description__job-criteria-item')
    .evaluateAll((items) =>
      items.map((item) => {
        const label = item.querySelector('.description__job-criteria-subheader')?.textContent ?? '';
        const value = item.querySelector('.description__job-criteria-text')?.textContent ?? '';
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
    employmentType: parsedCriteria.employmentType,
    visaPolicy: inferVisaPolicy(description),
    companySize: parsedCriteria.companySize,
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

export async function collectJobs({
  rawJobsPath,
  limit = 200,
  cdpUrl,
  source = 'auto',
}) {
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
