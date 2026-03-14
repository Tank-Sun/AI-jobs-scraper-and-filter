import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

function getCollectedJobLinksPath(rawJobsPath) {
  return path.join(path.dirname(rawJobsPath), 'collected-job-links.json');
}

async function readCollectedJobLinks(rawJobsPath) {
  const jobLinksPath = getCollectedJobLinksPath(rawJobsPath);

  try {
    await access(jobLinksPath);
    const raw = await readFile(jobLinksPath, 'utf8');
    const links = JSON.parse(raw);
    if (!Array.isArray(links)) {
      return [];
    }

    return links.filter((value) => typeof value === 'string' && value.startsWith('https://www.linkedin.com/jobs/view/'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeCollectedJobLinks(rawJobsPath, links) {
  const jobLinksPath = getCollectedJobLinksPath(rawJobsPath);
  await writeFile(jobLinksPath, `${JSON.stringify(links, null, 2)}\n`, 'utf8');
}

function selectJobLinksForDetailScrape(existingJobLinks, limit) {
  return existingJobLinks.slice(0, limit);
}

const LINK_COLLECTION_IDLE_MS = 30_000;

function hasLinkCollectionStalled({ lastLinkAddedAt, collectedCount, now = Date.now(), idleMs = LINK_COLLECTION_IDLE_MS }) {
  return collectedCount > 0 && now - lastLinkAddedAt >= idleMs;
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

const JOB_CARD_SELECTORS = [
  'main div[data-display-contents="true"] > div[role="button"]',
  '[data-view-name="job-search-job-card"]',
  'li[data-occludable-job-id]',
  '.jobs-search-results__list-item',
];

async function getJobCardsState(page) {
  for (const selector of JOB_CARD_SELECTORS) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { selector, locator, count };
    }
  }

  const fallbackSelector = JOB_CARD_SELECTORS[0];
  return {
    selector: fallbackSelector,
    locator: page.locator(fallbackSelector),
    count: 0,
  };
}

function scoreJobsPageCandidate({ url, cardCount }) {
  let score = Math.min(cardCount, 200);
  if (url.includes('/jobs/search-results/')) {
    score += 500;
  } else if (url.includes('/jobs/search/')) {
    score += 400;
  } else if (url.includes('linkedin.com/jobs')) {
    score += 100;
  }

  if (url.includes('currentJobId=')) {
    score += 50;
  }
  if (url.includes('start=')) {
    score += 20;
  }

  return score;
}

async function findJobsPage(context) {
  const pages = context.pages();
  const jobsPages = pages.filter((page) => page.url().includes('linkedin.com/jobs'));

  let bestPage = null;
  let bestScore = -1;

  for (const page of jobsPages) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const { count } = await getJobCardsState(page);
    const score = scoreJobsPageCandidate({ url: page.url(), cardCount: count });
    if (score > bestScore) {
      bestScore = score;
      bestPage = page;
    }
  }

  if (bestPage) {
    return bestPage;
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

async function waitForJobCardsOrNoResults(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { count } = await getJobCardsState(page);
    if (count > 0) {
      return;
    }

    const mainText = await textOrEmpty(page.locator('main')).catch(() => '');
    if (/no results found/i.test(mainText)) {
      return;
    }

    await page.waitForTimeout(250);
  }
}

async function autoScrollJobsList(page) {
  const { locator } = await getJobCardsState(page);
  for (let index = 0; index < 20; index += 1) {
    await locator.nth(Math.max(0, index - 1)).scrollIntoViewIfNeeded().catch(() => {});
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(450);
  }
}

function buildLinkedInJobUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

function buildSearchResultsPageUrl(urlValue, start) {
  const url = new URL(urlValue);
  url.searchParams.delete('currentJobId');
  url.searchParams.set('start', String(start));
  return url.toString();
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

function extractJobIdFromTrackingScope(raw) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const scopes = Array.isArray(parsed) ? parsed : [parsed];
    for (const scope of scopes) {
      const data = scope?.breadcrumb?.content?.data;
      if (!Array.isArray(data)) {
        continue;
      }

      const decoded = Buffer.from(data).toString('utf8');
      const match = decoded.match(/normalized_jobPosting:(\d+)/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function extractJobIdFromCard(card) {
  const trackingValues = await card
    .locator('[data-view-tracking-scope]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-view-tracking-scope')).filter(Boolean))
    .catch(() => []);

  for (const raw of trackingValues) {
    const jobId = extractJobIdFromTrackingScope(raw);
    if (jobId) {
      return jobId;
    }
  }

  const hrefs = await card
    .locator('a[href]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')).filter(Boolean))
    .catch(() => []);

  return hrefs.map(extractJobIdFromHref).find(Boolean) ?? null;
}

async function isNoResultsPage(page) {
  const { count } = await getJobCardsState(page);
  if (count > 0) {
    return false;
  }

  const mainText = await textOrEmpty(page.locator('main')).catch(() => '');
  return /no results found/i.test(mainText);
}

function parseTotalResultsCount(text) {
  const match = normalizeWhitespace(text).match(/(\d+(?:,\d{3})*)(\+)?\s+results\b/i);
  if (!match || match[2]) {
    return null;
  }

  return Number(match[1].replace(/,/g, ''));
}

async function isLastPaginationPage(page) {
  const start = Number(new URL(page.url()).searchParams.get('start') ?? '0');
  const { count: cardCount } = await getJobCardsState(page);
  const summaryText = await textOrEmpty(page.locator('body')).catch(() => '');
  const totalResults = parseTotalResultsCount(summaryText);

  if (Number.isFinite(totalResults) && cardCount > 0 && start + cardCount >= totalResults) {
    return true;
  }

  const nextButton = page.locator('[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]');
  const nextCount = await nextButton.count().catch(() => 0);
  if (nextCount > 0) {
    const testId = await nextButton.first().getAttribute('data-testid').catch(() => null);
    const disabledAttr = await nextButton.first().getAttribute('disabled').catch(() => null);
    const ariaDisabled = await nextButton.first().getAttribute('aria-disabled').catch(() => null);
    const className = await nextButton.first().getAttribute('class').catch(() => '');
    if (testId === 'pagination-controls-next-button-hidden') {
      return true;
    }
    if (disabledAttr !== null || ariaDisabled === 'true' || /disabled/i.test(className ?? '')) {
      return true;
    }
  }

  const indicatorButtons = page.locator('button[data-testid^="pagination-indicator-"]');
  const indicatorCount = await indicatorButtons.count().catch(() => 0);
  if (indicatorCount > 0) {
    const currentPageText = await textOrEmpty(page.locator('button[data-testid^="pagination-indicator-"][aria-current="true"]')).catch(() => '');
    const indicatorTexts = await indicatorButtons.evaluateAll((elements) => elements.map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())).catch(() => []);
    const pageNumbers = indicatorTexts.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const currentPage = Number(currentPageText);
    if (Number.isFinite(currentPage) && pageNumbers.length > 0) {
      return currentPage === Math.max(...pageNumbers);
    }
  }

  const paginationText = await textOrEmpty(page.locator('.jobs-search-two-pane__pagination, .jobs-search-results-list__pagination, .artdeco-pagination, [data-testid="pagination-controls-list"]')).catch(() => '');
  const currentPageText = await textOrEmpty(page.locator('.artdeco-pagination__indicator--number.active, .artdeco-pagination__indicator.artdeco-pagination__indicator--number.selected, .artdeco-pagination__pages button[aria-current="true"], .artdeco-pagination__pages li.selected, .artdeco-pagination__pages .active')).catch(() => '');

  if (!paginationText || !currentPageText) {
    return false;
  }

  const pageNumbers = [...paginationText.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  const currentPageMatch = currentPageText.match(/\b(\d+)\b/);
  if (pageNumbers.length === 0 || !currentPageMatch) {
    return false;
  }

  const currentPage = Number(currentPageMatch[1]);
  return currentPage === Math.max(...pageNumbers);
}

async function collectJobLinks(page, limit, options = {}) {
  const { stallState = null } = options;
  const { locator: cards, count: cardCount } = await getJobCardsState(page);
  const links = [];
  const seen = new Set();

  const selectedJobId = getCurrentJobIdFromUrl(page.url());
  if (selectedJobId) {
    seen.add(selectedJobId);
    links.push(buildLinkedInJobUrl(selectedJobId));
    if (stallState) {
      stallState.lastAddedAt = Date.now();
    }
    if (links.length >= limit) {
      return links;
    }
  }

  for (let index = 0; index < Math.min(cardCount, limit * 4); index += 1) {
    if (stallState && hasLinkCollectionStalled({
      lastLinkAddedAt: stallState.lastAddedAt,
      collectedCount: stallState.collectedCount,
    })) {
      break;
    }
    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    const cardText = normalizeWhitespace(await card.textContent({ timeout: 1000 }).catch(() => ''));
    if (!cardText) {
      continue;
    }

    let jobId = await extractJobIdFromCard(card);

    if (!jobId) {
      const previousJobId = getCurrentJobIdFromUrl(page.url());
      await card.click({ timeout: 1500 }).catch(() => {});

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await page.waitForTimeout(200);
        jobId = getCurrentJobIdFromUrl(page.url());
        if (jobId && jobId !== previousJobId) {
          break;
        }
      }

      if (!jobId) {
        jobId = await extractJobIdFromCard(card);
      }
    }

    if (!jobId || seen.has(jobId)) {
      continue;
    }

    seen.add(jobId);
    links.push(buildLinkedInJobUrl(jobId));
    if (stallState) {
      stallState.lastAddedAt = Date.now();
    }
    if (links.length >= limit) {
      break;
    }
  }

  return links;
}

async function collectJobLinksAcrossPages(page, limit, options = {}) {
  const {
    seedLinks = [],
    onLinkCollected = null,
  } = options;
  const links = [...seedLinks.slice(0, limit)];
  const seen = new Set(links);
  const stallState = {
    lastAddedAt: Date.now(),
    collectedCount: links.length,
  };
  let start = Number(new URL(page.url()).searchParams.get('start') ?? '0');
  let stagnantPages = 0;

  while (links.length < limit && stagnantPages < 2) {
    await waitForJobCardsOrNoResults(page);
    if (await isNoResultsPage(page)) {
      break;
    }

    await autoScrollJobsList(page);
    const pageLinks = await collectJobLinks(page, limit - links.length, { stallState });
    let addedThisPage = 0;

    for (const jobUrl of pageLinks) {
      if (seen.has(jobUrl)) {
        continue;
      }

      seen.add(jobUrl);
      links.push(jobUrl);
      addedThisPage += 1;
      stallState.lastAddedAt = Date.now();
      stallState.collectedCount = links.length;

      if (typeof onLinkCollected === 'function') {
        await onLinkCollected(jobUrl, [...links]);
      }

      if (links.length >= limit) {
        break;
      }
    }

    if (links.length >= limit) {
      break;
    }

    if (hasLinkCollectionStalled({
      lastLinkAddedAt: stallState.lastAddedAt,
      collectedCount: links.length,
    })) {
      break;
    }

    if (await isLastPaginationPage(page)) {
      break;
    }

    stagnantPages = addedThisPage === 0 ? stagnantPages + 1 : 0;
    start += 25;

    const nextPageUrl = buildSearchResultsPageUrl(page.url(), start);
    if (nextPageUrl === page.url()) {
      break;
    }

    await page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

function sanitizeDescription(text) {
  return normalizeWhitespace(text)
    .replace(/鈥檚/g, "'s")
    .replace(/鈥檒/gi, "'l")
    .replace(/鈥檙e/g, "'re")
    .replace(/鈥檓/g, "'m")
    .replace(/鈥檇/g, "'d")
    .replace(/鈥\?/g, '')
    .replace(/\s*Show less$/i, '')
    .replace(/\?more$/i, '')
    .replace(/\.\.\. more$/i, '')
    .replace(/… more$/i, '')
    .replace(/(?:\?|鈥\?)?more$/i, '')
    .replace(/\s*more$/i, '')
    .trim();
}

function normalizeLinkedInMainText(text) {
  return normalizeWhitespace(text)
    .replace(/\s+[·•路]\s+/g, ' | ')
    .replace(/Promoted by hirer/gi, '')
    .replace(/Responses managed off LinkedIn/gi, '')
    .replace(/Easy Apply/gi, '')
    .replace(/Use AI to assess(?: how you fit)?/gi, '')
    .replace(/Show match details/gi, '')
    .replace(/Tailor my resume/gi, '')
    .replace(/Create cover letter/gi, '')
    .replace(/Help me stand out/gi, '')
    .replace(/\s+\|\s+/g, ' | ')
    .trim();
}

function cleanHeaderPart(value) {
  return normalizeWhitespace(value)
    .replace(/Promoted by hirer/gi, '')
    .replace(/Responses managed off LinkedIn/gi, '')
    .replace(/Easy Apply/gi, '')
    .replace(/Use AI to assess(?: how you fit)?/gi, '')
    .replace(/Show match details/gi, '')
    .replace(/Tailor my resume/gi, '')
    .replace(/Create cover letter/gi, '')
    .replace(/Help me stand out/gi, '')
    .trim();
}

function parseHeaderFromMainText(mainText, pageTitle) {
  const normalizedText = normalizeLinkedInMainText(mainText);
  const titleParts = pageTitle.split(' | ').map((part) => normalizeWhitespace(part));
  const parsedTitle = titleParts[0] ?? '';
  const parsedCompany = titleParts[1] ?? '';

  const headerStart = `${parsedCompany}${parsedTitle}`;
  const startIndex = normalizedText.indexOf(headerStart);
  const sliced = startIndex >= 0 ? normalizedText.slice(startIndex + headerStart.length).trim() : normalizedText;
  const aboutIndex = sliced.search(/About the job|About us|About the role|Description|Job Description/i);
  const headerSegment = (aboutIndex >= 0 ? sliced.slice(0, aboutIndex) : sliced).slice(0, 320).trim();

  const parts = headerSegment
    .split('|')
    .map((part) => cleanHeaderPart(part))
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  let location = '';
  let postedTime = '';
  let applicantInfo = '';
  let employmentType = '';

  for (const part of parts) {
    const isPostedTime = /\b(?:today|yesterday|\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago|reposted\s+\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago)\b/i.test(part);
    const applicantMatch = part.match(/(?:over\s+)?\d+\+?\s+people clicked apply|\d+\+?\s+applicants?/i);
    const employmentMatch = part.match(/\b(Full-time|Part-time|Contract|Temporary|Internship|Volunteer)\b/i);

    if (!postedTime && isPostedTime) {
      postedTime = part;
      continue;
    }

    if (!applicantInfo && applicantMatch) {
      applicantInfo = applicantMatch[0];
    }

    if (!employmentType && employmentMatch) {
      employmentType = employmentMatch[1];
    }

    if (!location && !isPostedTime && !applicantMatch && !employmentMatch) {
      location = part;
    }
  }

  return {
    title: parsedTitle,
    company: parsedCompany,
    location,
    postedTime,
    applicantInfo,
    employmentType,
  };
}

function parseDescriptionFromMainText(mainText) {
  const normalizedText = normalizeWhitespace(mainText);
  const aboutIndex = normalizedText.search(/About the job/i);
  if (aboutIndex < 0) {
    return '';
  }

  let description = normalizedText.slice(aboutIndex).replace(/^About the job\s*/i, '');
  description = description.replace(/^(Description|Job Description|About Kinaxis)\s*/i, (match) => match.trim() + ' ');

  const stopPatterns = [
    /Set alert for similar jobs/i,
    /See how you compare/i,
    /About the company/i,
    /Show Premium Insights/i,
    /Interested in working with us/i,
    /Interview process/i,
    /Benefits found in job post/i,
    /Exclusive Job Seeker Insights/i,
  ];

  let stopIndex = description.length;
  for (const pattern of stopPatterns) {
    const match = pattern.exec(description);
    if (match && match.index < stopIndex) {
      stopIndex = match.index;
    }
  }

  return sanitizeDescription(description.slice(0, stopIndex));
}

function parseCompanySizeFromMainText(mainText) {
  const normalizedText = normalizeWhitespace(mainText);
  const overMatch = normalizedText.match(/\bover\s+(\d+(?:,\d{3})*)\s+employees\b/i);
  if (overMatch) {
    return `${overMatch[1].replace(/,/g, '')}+`;
  }

  const rangeMatch = normalizedText.match(/\b(\d+(?:,\d{3})*)\s*-\s*(\d+(?:,\d{3})*)\s+employees\b/i);
  if (rangeMatch) {
    return `${rangeMatch[1].replace(/,/g, '')}-${rangeMatch[2].replace(/,/g, '')}`;
  }

  const plusMatch = normalizedText.match(/\b(\d+(?:,\d{3})*)\+\s*employees\b/i);
  if (plusMatch) {
    return `${plusMatch[1].replace(/,/g, '')}+`;
  }

  const exactMatch = normalizedText.match(/\b(\d+(?:,\d{3})*)\s+employees\b/i);
  return exactMatch?.[1].replace(/,/g, '') ?? '';
}

function parseSalaryFromMainText(mainText) {
  const normalizedText = normalizeWhitespace(mainText);
  const hasNonAnnualCompSignal = /\b(?:per month|\/\s*mo|\/\s*month|monthly|per hour|\/\s*hr|hourly|per week|weekly|bi-weekly|per day|daily)\b/i.test(normalizedText);
  if (hasNonAnnualCompSignal) {
    return '';
  }

  const annualRangeMatch = normalizedText.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?\s*-\s*\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?\s*(?:\/\s*yr|\/\s*year|per year|annually|a year)\b/i);
  if (annualRangeMatch) {
    const low = annualRangeMatch[2] ? Number(annualRangeMatch[1].replace(/,/g, '')) * 1000 : Number(annualRangeMatch[1].replace(/,/g, ''));
    const high = annualRangeMatch[4] ? Number(annualRangeMatch[3].replace(/,/g, '')) * 1000 : Number(annualRangeMatch[3].replace(/,/g, ''));
    return `$$${Math.round(low).toLocaleString()}-$$${Math.round(high).toLocaleString()}/yr`.replace(/\$\$/g, '$');
  }

  const annualSingleMatch = normalizedText.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?\s*(?:\/\s*yr|\/\s*year|per year|annually|a year)\b/i);
  if (annualSingleMatch) {
    const value = annualSingleMatch[2] ? Number(annualSingleMatch[1].replace(/,/g, '')) * 1000 : Number(annualSingleMatch[1].replace(/,/g, ''));
    return `$$${Math.round(value).toLocaleString()}/yr`.replace(/\$\$/g, '$');
  }

  return '';
}

async function scrapeJobDetail(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2200);

  const pageTitle = await page.title();
  const mainText = await textOrEmpty(page.locator('main').first());
  const header = parseHeaderFromMainText(mainText, pageTitle);
  const descriptionFromText = parseDescriptionFromMainText(mainText);
  const companySizeFromText = parseCompanySizeFromMainText(mainText);
  const salaryFromText = parseSalaryFromMainText(mainText);

  const title = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__job-title, .t-24.job-details-jobs-unified-top-card__job-title')),
    header.title
  );
  const company = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name, a[href*="/company/"]')),
    header.company
  );
  const location = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(0)),
    header.location
  );
  const postedTime = firstNonEmpty(
    await textOrEmpty(page.locator('.job-details-jobs-unified-top-card__primary-description-container span').nth(1)),
    header.postedTime
  );
  const applicantInfo = firstNonEmpty(
    await textOrEmpty(page.locator('.jobs-unified-top-card__subtitle-secondary-grouping, .job-details-jobs-unified-top-card__tertiary-description')),
    header.applicantInfo
  );
  const description = firstNonEmpty(
    await textOrEmpty(page.locator('.jobs-description__content, .jobs-box__html-content, .jobs-description-content__text, .show-more-less-html__markup, .description__text')),
    descriptionFromText
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
    employmentType: firstNonEmpty(parsedCriteria.employmentType, header.employmentType),
    visaPolicy: inferVisaPolicy(description),
    companySize: firstNonEmpty(parsedCriteria.companySize, companySizeFromText),
    salary: salaryFromText,
    description,
    jobUrl,
  };
}

async function scrapeJobsViaPlaywright({ cdpUrl, limit, rawJobsPath }) {
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context found. Launch Chrome with remote debugging and keep one window open.');
    }

    const searchPage = await findJobsPage(context);
    await ensureLinkedInJobsPage(searchPage);
    await waitForJobCardsOrNoResults(searchPage);
    const initialCards = await getJobCardsState(searchPage);
    console.log(`[scrape] Using jobs page: ${searchPage.url()}`);
    console.log(`[scrape] Detected ${initialCards.count} job cards with selector ${initialCards.selector}`);
    const existingJobLinks = await readCollectedJobLinks(rawJobsPath);
    if (existingJobLinks.length > 0) {
      console.log(`[scrape] Reusing ${existingJobLinks.length} saved links from ${getCollectedJobLinksPath(rawJobsPath)}`);
    }
    const jobLinks = existingJobLinks.length > 0
      ? selectJobLinksForDetailScrape(existingJobLinks, limit)
      : await collectJobLinksAcrossPages(searchPage, limit, {
          seedLinks: existingJobLinks,
          onLinkCollected: async (_jobUrl, allJobLinks) => {
            await writeCollectedJobLinks(rawJobsPath, allJobLinks);
            const count = allJobLinks.length;
            if (count === 1 || count % 10 === 0) {
              console.log(`[scrape] Collected ${count} job links so far`);
            }
          },
        });
    if (jobLinks.length > 0) {
      await writeCollectedJobLinks(rawJobsPath, jobLinks);
    }
    if (jobLinks.length === 0) {
      throw new Error('No LinkedIn job links were found on the current page.');
    }

    console.log(`[scrape] Starting detail scrape for ${jobLinks.length} jobs`);
    const detailPage = await context.newPage();
    try {
      const jobs = [];
      for (const [index, jobUrl] of jobLinks.entries()) {
        if (index === 0 || (index + 1) % 10 === 0) {
          console.log(`[scrape] Scraping job ${index + 1}/${jobLinks.length}`);
        }
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
      return await scrapeJobsViaPlaywright({ cdpUrl, limit, rawJobsPath });
    } catch (error) {
      if (source === 'live') {
        throw error;
      }
    }
  }

  return readJobsFromFile(rawJobsPath);
}

export const __testables = {
  buildSearchResultsPageUrl,
  parseHeaderFromMainText,
  parseDescriptionFromMainText,
  parseCompanySizeFromMainText,
  getCollectedJobLinksPath,
  hasLinkCollectionStalled,
  selectJobLinksForDetailScrape,
  isLastPaginationPage,
  isNoResultsPage,
  parseTotalResultsCount,
  parseSalaryFromMainText,
  extractJobIdFromTrackingScope,
  readCollectedJobLinks,
  sanitizeDescription,
  writeCollectedJobLinks,
};




