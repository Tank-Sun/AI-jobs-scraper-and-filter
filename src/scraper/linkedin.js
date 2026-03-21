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

function getFailedDetailUrlsPath(rawJobsPath) {
  return path.join(path.dirname(rawJobsPath), 'failed-detail-urls.json');
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

async function readFailedDetailUrls(rawJobsPath) {
  const failedUrlsPath = getFailedDetailUrlsPath(rawJobsPath);

  try {
    await access(failedUrlsPath);
    const raw = await readFile(failedUrlsPath, 'utf8');
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

async function writeFailedDetailUrls(rawJobsPath, links) {
  const failedUrlsPath = getFailedDetailUrlsPath(rawJobsPath);
  await writeFile(failedUrlsPath, `${JSON.stringify(links, null, 2)}
`, 'utf8');
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

async function getValidJobCardIndexes(page, locator, count) {
  if (count === 0) {
    return [];
  }

  return locator.evaluateAll((elements) => {
    const indexes = [];
    for (const [index, element] of elements.entries()) {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      const hasTitle = text.length > 0;
      const hasHref = Boolean(element.querySelector('a[href]'));
      const hasTracking = Boolean(element.querySelector('[data-view-tracking-scope]'));
      if (hasTitle || hasHref || hasTracking) {
        indexes.push(index);
      }
    }
    return indexes;
  }).catch(() => Array.from({ length: count }, (_, index) => index));
}


async function inspectJobCards(locator) {
  return locator.evaluateAll((elements) => {
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

          const decoded = new TextDecoder().decode(Uint8Array.from(data));
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

    return elements.flatMap((element, index) => {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      const hasText = text.length > 0;
      if (!hasText && !element.querySelector('a[href]') && !element.querySelector('[data-view-tracking-scope]')) {
        return [];
      }

      const trackingValues = [...element.querySelectorAll('[data-view-tracking-scope]')]
        .map((node) => node.getAttribute('data-view-tracking-scope'))
        .filter(Boolean);
      for (const raw of trackingValues) {
        const jobId = extractJobIdFromTrackingScope(raw);
        if (jobId) {
          return [{ index, text, hasText, jobId }];
        }
      }

      const hrefs = [...element.querySelectorAll('a[href]')]
        .map((node) => node.getAttribute('href'))
        .filter(Boolean);
      for (const href of hrefs) {
        const jobId = extractJobIdFromHref(href);
        if (jobId) {
          return [{ index, text, hasText, jobId }];
        }
      }

      return [{ index, text, hasText, jobId: null }];
    });
  }).catch(() => []);
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

async function goToNextResultsPage(page, start) {
  const previousUrl = page.url();
  const nextButton = page.locator('[data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next:not([disabled]), button[aria-label="Next"]:not([disabled]), button[aria-label="Next Page"]:not([disabled])').first();

  const nextCount = await nextButton.count().catch(() => 0);
  if (nextCount > 0) {
    console.log(`[scrape] Moving to next page via Next button (start=${start})`);
    await nextButton.click({ timeout: 3000 }).catch(() => {});

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(250);
      const currentUrl = page.url();
      if (currentUrl !== previousUrl) {
        return;
      }
    }
  }

  const nextPageUrl = buildSearchResultsPageUrl(previousUrl, start);
  if (nextPageUrl === previousUrl) {
    return;
  }

  console.log(`[scrape] Moving to next page via URL (start=${start})`);
  await page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

async function extractJobIdFromDetailPane(page) {
  const hrefs = await page
    .locator('main a[href*="/jobs/view/"], aside a[href*="/jobs/view/"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')).filter(Boolean))
    .catch(() => []);

  return hrefs.map(extractJobIdFromHref).find(Boolean) ?? null;
}
async function waitForDetailPaneJobIdChange(page, previousJobId, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentJobId = getCurrentJobIdFromUrl(page.url());
    if (currentJobId && currentJobId !== previousJobId) {
      return currentJobId;
    }

    const detailJobId = await extractJobIdFromDetailPane(page);
    if (detailJobId && detailJobId !== previousJobId) {
      return detailJobId;
    }

    await page.waitForTimeout(150);
  }

  return null;
}
async function triggerJobCardSelection(cardHandle) {
  try {
    await cardHandle.evaluate((element) => element.click());
    return true;
  } catch {
    return false;
  }
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

  const nextButtons = page.locator('[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]');
  const nextStates = await nextButtons.evaluateAll((elements) => elements.map((element) => {
    const htmlElement = element;
    const style = globalThis.getComputedStyle ? getComputedStyle(htmlElement) : null;
    const hiddenByLayout = 'offsetParent' in htmlElement ? htmlElement.offsetParent === null : false;
    return {
      testId: htmlElement.getAttribute('data-testid'),
      disabledAttr: htmlElement.getAttribute('disabled'),
      ariaDisabled: htmlElement.getAttribute('aria-disabled'),
      className: htmlElement.getAttribute('class') || '',
      hiddenByLayout,
      display: style?.display || '',
      visibility: style?.visibility || '',
    };
  })).catch(() => []);
  if (nextStates.some((state) => {
    const disabled = state.disabledAttr !== null || state.ariaDisabled == 'true' || /disabled/i.test(state.className || '');
    const hidden = state.testId == 'pagination-controls-next-button-hidden' || state.hiddenByLayout || state.display == 'none' || state.visibility == 'hidden';
    return !disabled && !hidden;
  })) {
    return false;
  }
  if (nextStates.length > 0) {
    return true;
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

function buildSignalDiagnosticKey(signal) {
  return normalizeWhitespace(signal.text || '').slice(0, 180);
}

function trackCollectedLink(links, seen, jobId, stallState) {
  if (!jobId || seen.has(jobId)) {
    return false;
  }

  seen.add(jobId);
  links.push(buildLinkedInJobUrl(jobId));
  if (stallState) {
    stallState.lastAddedAt = Date.now();
  }
  return true;
}

async function resolveSignalJobId(page, cardHandle, previousJobId, timeoutMs = 1200) {
  let clicked = await triggerJobCardSelection(cardHandle);
  if (!clicked) {
    clicked = await cardHandle.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
  }
  if (!clicked) {
    return null;
  }

  let jobId = getCurrentJobIdFromUrl(page.url());
  if (jobId && jobId !== previousJobId) {
    return jobId;
  }

  jobId = await waitForDetailPaneJobIdChange(page, previousJobId, timeoutMs);
  if (!jobId) {
    jobId = getCurrentJobIdFromUrl(page.url());
  }
  if (!jobId) {
    jobId = await extractJobIdFromDetailPane(page);
  }
  return jobId;
}

async function retryUnresolvedSignals(page, unresolvedSignals, links, seen, stallState, limit) {
  if (unresolvedSignals.length === 0 || links.length >= limit) {
    return unresolvedSignals;
  }

  await page.waitForTimeout(400);
  const { locator: liveCards } = await getJobCardsState(page);
  const liveSignals = (await inspectJobCards(liveCards)).filter((signal) => signal.hasText);
  const liveHandles = await liveCards.elementHandles().catch(() => []);
  const usedLiveIndexes = new Set();
  const stillUnresolved = [];

  for (const originalSignal of unresolvedSignals) {
    if (links.length >= limit) {
      stillUnresolved.push(originalSignal);
      continue;
    }

    const signalKey = buildSignalDiagnosticKey(originalSignal);
    const matchingSignal = liveSignals.find((signal) => {
      if (usedLiveIndexes.has(signal.index)) {
        return false;
      }
      return buildSignalDiagnosticKey(signal) === signalKey;
    });

    if (!matchingSignal) {
      stillUnresolved.push(originalSignal);
      continue;
    }

    usedLiveIndexes.add(matchingSignal.index);

    if (matchingSignal.jobId && trackCollectedLink(links, seen, matchingSignal.jobId, stallState)) {
      continue;
    }

    const cardHandle = liveHandles[matchingSignal.index];
    if (!cardHandle) {
      stillUnresolved.push(originalSignal);
      continue;
    }

    const previousJobId = getCurrentJobIdFromUrl(page.url());
    const jobId = await resolveSignalJobId(page, cardHandle, previousJobId, 2200);
    if (!trackCollectedLink(links, seen, jobId, stallState)) {
      stillUnresolved.push(originalSignal);
    }
  }

  return stillUnresolved;
}

async function collectJobLinks(page, limit, options = {}) {
  const { stallState = null, lastPage = false, snapshotSignals = null } = options;
  const startedAt = Date.now();
  const { locator: cards } = await getJobCardsState(page);
  const links = [];
  const seen = new Set();
  const pageSignals = (snapshotSignals ?? await inspectJobCards(cards)).filter((signal) => signal.hasText);
  const cardHandles = await cards.elementHandles().catch(() => []);
  const unresolvedSignals = [];
  let selectedSeedCount = 0;

  const selectedJobId = getCurrentJobIdFromUrl(page.url());
  let selectedSeedKey = '';
  if (selectedJobId) {
    if (trackCollectedLink(links, seen, selectedJobId, stallState)) {
      selectedSeedCount = 1;
    }
    const selectedSignal = pageSignals.find((signal) => signal.jobId === selectedJobId);
    if (selectedSignal) {
      selectedSeedKey = buildSignalDiagnosticKey(selectedSignal);
    }
    if (links.length >= limit) {
      return {
        links,
        unresolvedSignals,
        stats: {
          selectedSeedCount,
          initialAddedCount: links.length,
          initialPassAddedCount: Math.max(0, links.length - selectedSeedCount),
          retryRecoveredCount: 0,
          finalUnresolvedCount: 0,
        },
      };
    }
  }

  if (lastPage) {
    const directCount = pageSignals.filter((signal) => Boolean(signal.jobId)).length;
    console.log(`[scrape] Last page collect: ${pageSignals.length} visible signals, ${directCount} direct ids`);
  }

  for (const signal of pageSignals) {
    if (links.length >= limit) {
      break;
    }

    if (signal.jobId && trackCollectedLink(links, seen, signal.jobId, stallState)) {
      continue;
    }

    const cardHandle = cardHandles[signal.index];
    if (!cardHandle) {
      unresolvedSignals.push(signal);
      continue;
    }

    const previousJobId = getCurrentJobIdFromUrl(page.url());
    const jobId = await resolveSignalJobId(page, cardHandle, previousJobId, 1200);
    if (!trackCollectedLink(links, seen, jobId, stallState)) {
      if (!(selectedSeedKey && buildSignalDiagnosticKey(signal) === selectedSeedKey)) {
        unresolvedSignals.push(signal);
      }
    }
  }

  const initialAddedCount = links.length;
  const initialPassAddedCount = Math.max(0, initialAddedCount - selectedSeedCount);
  const remainingUnresolved = await retryUnresolvedSignals(page, unresolvedSignals, links, seen, stallState, limit);
  const retryRecoveredCount = links.length - initialAddedCount;

  if (lastPage) {
    console.log(`[scrape] Last page collect finished in ${Date.now() - startedAt}ms`);
  }
  return {
    links,
    unresolvedSignals: remainingUnresolved,
    initialUnresolvedSignals: unresolvedSignals,
    stats: {
      selectedSeedCount,
      initialAddedCount,
      initialPassAddedCount,
      retryRecoveredCount,
      finalUnresolvedCount: remainingUnresolved.length,
    },
  };
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

  async function mergeCollectedLinks(pageLinks) {
    let added = 0;

    for (const jobUrl of pageLinks) {
      if (seen.has(jobUrl)) {
        continue;
      }

      seen.add(jobUrl);
      links.push(jobUrl);
      added += 1;
      stallState.lastAddedAt = Date.now();
      stallState.collectedCount = links.length;

      if (typeof onLinkCollected === 'function') {
        await onLinkCollected(jobUrl, [...links]);
      }

      if (links.length >= limit) {
        break;
      }
    }

    return added;
  }

  while (links.length < limit && stagnantPages < 2) {
    await waitForJobCardsOrNoResults(page);
    if (await isNoResultsPage(page)) {
      break;
    }

    const isLastPageStart = Date.now();
    const lastPage = await isLastPaginationPage(page);
    if (lastPage) {
      console.log(`[scrape] Last page detected after ${Date.now() - isLastPageStart}ms`);
    }

    const { locator: cards, count: cardCount } = await getJobCardsState(page);
    const snapshotSignals = await inspectJobCards(cards);
    const visibleCount = snapshotSignals.filter((signal) => signal.hasText).length;

    let addedThisPage = 0;

    const {
      links: visibleLinks,
      unresolvedSignals,
      initialUnresolvedSignals = [],
      stats = {
        selectedSeedCount: 0,
        initialAddedCount: 0,
        retryRecoveredCount: 0,
        finalUnresolvedCount: unresolvedSignals.length,
      },
    } = await collectJobLinks(page, limit - links.length, { stallState, lastPage, snapshotSignals });
    addedThisPage += await mergeCollectedLinks(visibleLinks);

    const initialUnresolvedDiagnostics = initialUnresolvedSignals
      .map((signal) => buildSignalDiagnosticKey(signal))
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 5);

    const finalUnresolvedDiagnostics = unresolvedSignals
      .map((signal) => buildSignalDiagnosticKey(signal))
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 5);

    const fullyCollectedPage = visibleCount > 0 && addedThisPage >= visibleCount;
    const effectiveFinalUnresolvedCount = fullyCollectedPage ? 0 : stats.finalUnresolvedCount;
    const effectiveFinalUnresolvedDiagnostics = fullyCollectedPage ? [] : finalUnresolvedDiagnostics;

    if (visibleCount > 0) {
      console.log(`[scrape] Collected ${addedThisPage}/${visibleCount} visible jobs on this page; moving on`);
      console.log(`[scrape] Page debug: selected seed ${stats.selectedSeedCount}, first pass added ${stats.initialPassAddedCount}, first pass total ${stats.initialAddedCount}, retry recovered ${stats.retryRecoveredCount}, still unresolved ${effectiveFinalUnresolvedCount}`);
    }

    if (initialUnresolvedDiagnostics.length > 0) {
      console.log(`[scrape] Initial unresolved cards: ${initialUnresolvedDiagnostics.join(' || ')}`);
    }

    if (effectiveFinalUnresolvedDiagnostics.length > 0) {
      console.log(`[scrape] Still unresolved after retry: ${effectiveFinalUnresolvedDiagnostics.join(' || ')}`);
    }

    if (links.length >= limit) {
      break;
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

    if (lastPage) {
      break;
    }

    stagnantPages = addedThisPage === 0 ? stagnantPages + 1 : 0;
    start += 25;
    await goToNextResultsPage(page, start);
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
    .replace(/閳ユ獨/g, "'s")
    .replace(/閳ユ獟/gi, "'l")
    .replace(/閳ユ獧e/g, "'re")
    .replace(/閳ユ獡/g, "'m")
    .replace(/閳ユ獓/g, "'d")
    .replace(/閳?/g, '')
    .replace(/\s*Show less$/i, '')
    .replace(/\?more$/i, '')
    .replace(/\.\.\. more$/i, '')
    .replace(/鈥?more$/i, '')
    .replace(/(?:\?|閳?)?more$/i, '')
    .replace(/\s*more$/i, '')
    .trim();
}

function normalizeLinkedInMainText(text) {
  return normalizeWhitespace(text)
    .replace(/\s+[路鈥㈣矾]\s+/g, ' | ')
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

function isPlaywrightTimeoutError(error) {
  const message = error?.message || '';
  return error?.name == 'TimeoutError' || /Timeout\s*\d+ms exceeded/i.test(message) || /page\.goto: Timeout/i.test(message);
}

async function loadJobDetailPage(page, jobUrl, options = {}) {
  const {
    maxAttempts = 2,
    timeoutMs = 60000,
    settleMs = 2200,
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(settleMs);
      return;
    } catch (error) {
      lastError = error;
      if (!isPlaywrightTimeoutError(error) || attempt >= maxAttempts) {
        throw error;
      }
      console.log(`[scrape] Detail page timeout for ${jobUrl}; retrying (${attempt + 1}/${maxAttempts})`);
      await page.waitForTimeout(1000);
    }
  }

  throw lastError;
}

async function scrapeJobDetail(page, jobUrl) {
  await loadJobDetailPage(page, jobUrl);

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

async function scrapeJobsViaPlaywright({ cdpUrl, limit, rawJobsPath, retryFailedDetails = false }) {
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
    const failedDetailUrls = await readFailedDetailUrls(rawJobsPath);
    if (existingJobLinks.length > 0) {
      console.log(`[scrape] Reusing ${existingJobLinks.length} saved links from ${getCollectedJobLinksPath(rawJobsPath)}`);
    }

    let jobLinks = [];
    if (retryFailedDetails) {
      jobLinks = selectJobLinksForDetailScrape(failedDetailUrls, limit);
      if (jobLinks.length === 0) {
        throw new Error(`No failed detail URLs found in ${getFailedDetailUrlsPath(rawJobsPath)}.`);
      }
      console.log(`[scrape] Retrying ${jobLinks.length} failed detail URL(s) from ${getFailedDetailUrlsPath(rawJobsPath)}`);
    } else {
      jobLinks = existingJobLinks.length > 0
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
    }

    console.log(`[scrape] Starting detail scrape for ${jobLinks.length} jobs`);
    const detailPage = await context.newPage();
    try {
      const jobs = [];
      const remainingFailedDetailUrls = [];
      let skippedDetailPages = 0;
      for (const [index, jobUrl] of jobLinks.entries()) {
        if (index === 0 || (index + 1) % 10 === 0) {
          console.log(`[scrape] Scraping job ${index + 1}/${jobLinks.length}`);
        }
        try {
          const job = await scrapeJobDetail(detailPage, jobUrl);
          jobs.push(job);
        } catch (error) {
          if (!isPlaywrightTimeoutError(error)) {
            throw error;
          }
          skippedDetailPages += 1;
          remainingFailedDetailUrls.push(jobUrl);
          console.log(`[scrape] Skipping timed out detail page ${index + 1}/${jobLinks.length}: ${jobUrl}`);
        }
      }
      await writeFailedDetailUrls(rawJobsPath, remainingFailedDetailUrls);
      if (skippedDetailPages > 0) {
        console.log(`[scrape] Skipped ${skippedDetailPages} timed out detail page(s)`);
        console.log(`[scrape] Failed detail URLs saved to ${getFailedDetailUrlsPath(rawJobsPath)}`);
      }
      return {
        jobs,
        failedDetailUrls: remainingFailedDetailUrls,
        attemptedDetailUrls: jobLinks,
      };
    } finally {
      await detailPage.close();
    }
  } finally {
    await browser.close();
  }
}

export async function collectJobs({ rawJobsPath, limit = 200, cdpUrl, source = 'auto', retryFailedDetails = false }) {
  if (source === 'raw') {
    return {
      jobs: await readJobsFromFile(rawJobsPath),
      failedDetailUrls: await readFailedDetailUrls(rawJobsPath),
      attemptedDetailUrls: [],
    };
  }

  if (cdpUrl) {
    try {
      return await scrapeJobsViaPlaywright({ cdpUrl, limit, rawJobsPath, retryFailedDetails });
    } catch (error) {
      if (source === 'live') {
        throw error;
      }
    }
  }

  return {
    jobs: await readJobsFromFile(rawJobsPath),
    failedDetailUrls: await readFailedDetailUrls(rawJobsPath),
    attemptedDetailUrls: [],
  };
}

export const __testables = {
  buildSearchResultsPageUrl,
  parseHeaderFromMainText,
  parseDescriptionFromMainText,
  parseCompanySizeFromMainText,
  buildSignalDiagnosticKey,
  getCollectedJobLinksPath,
  getFailedDetailUrlsPath,
  getValidJobCardIndexes,
  goToNextResultsPage,
  hasLinkCollectionStalled,
  selectJobLinksForDetailScrape,
  isLastPaginationPage,
  isNoResultsPage,
  parseTotalResultsCount,
  parseSalaryFromMainText,
  extractJobIdFromDetailPane,
  isPlaywrightTimeoutError,
  loadJobDetailPage,
  resolveSignalJobId,
  waitForDetailPaneJobIdChange,
  triggerJobCardSelection,
  extractJobIdFromTrackingScope,
  readCollectedJobLinks,
  readFailedDetailUrls,
  sanitizeDescription,
  writeCollectedJobLinks,
  writeFailedDetailUrls,
};






