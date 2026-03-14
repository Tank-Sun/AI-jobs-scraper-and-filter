import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { __testables } from "../src/scraper/linkedin.js";

const {
  buildSearchResultsPageUrl,
  getCollectedJobLinksPath,
  getValidJobCardIndexes,
  hasLinkCollectionStalled,
  isLastPaginationPage,
  isNoResultsPage,
  selectJobLinksForDetailScrape,
  parseHeaderFromMainText,
  parseTotalResultsCount,
  parseCompanySizeFromMainText,
  extractJobIdFromTrackingScope,
  parseSalaryFromMainText,
  readCollectedJobLinks,
  sanitizeDescription,
  writeCollectedJobLinks,
} = __testables;

test("buildSearchResultsPageUrl removes currentJobId and advances start", () => {
  const nextPageUrl = buildSearchResultsPageUrl(
    "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&currentJobId=4383817907&start=25",
    50
  );

  assert.equal(
    nextPageUrl,
    "https://www.linkedin.com/jobs/search/?keywords=software+engineer&start=50"
  );
});


test("parseTotalResultsCount returns exact counts and ignores plus-style approximations", () => {
  assert.equal(parseTotalResultsCount('54 results Alberta, Canada'), 54);
  assert.equal(parseTotalResultsCount('2,553 results across Canada'), 2553);
  assert.equal(parseTotalResultsCount('99+ results Alberta, Canada'), null);
  assert.equal(parseTotalResultsCount('No matching jobs'), null);
});


test("isNoResultsPage detects empty LinkedIn results pages", async () => {
  const cardSelectors = new Set([
    'main div[data-display-contents="true"] > div[role="button"]',
    '[data-view-name="job-search-job-card"]',
    'li[data-occludable-job-id]',
    '.jobs-search-results__list-item',
  ]);

  const pageWithNoResults = {
    locator(selector) {
      if (cardSelectors.has(selector)) {
        return { count: async () => 0 };
      }
      if (selector === 'main') {
        return {
          count: async () => 1,
          first() {
            return {
              textContent: async () => 'No results found Try shortening or rephrasing your search.',
            };
          },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const pageWithCards = {
    locator(selector) {
      if (cardSelectors.has(selector)) {
        return { count: async () => (selector === '.jobs-search-results__list-item' ? 3 : 0) };
      }
      return { count: async () => 0 };
    },
  };

  assert.equal(await isNoResultsPage(pageWithNoResults), true);
  assert.equal(await isNoResultsPage(pageWithCards), false);
});


function createLocator({ count = 1, text = '', attributes = {} } = {}) {
  return {
    count: async () => count,
    first() {
      return {
        textContent: async () => text,
        getAttribute: async (name) => attributes[name] ?? null,
      };
    },
  };
}

test("isLastPaginationPage detects exact final windows, hidden next buttons, and current indicator pages", async () => {
  const pageWithExactFinalWindow = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=50';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 4 });
      }
      if (selector === 'body') {
        return createLocator({ text: '54 results Alberta, Canada Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ count: 0 });
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithHiddenNext = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=50';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 4 });
      }
      if (selector === 'body') {
        return createLocator({ text: '99+ results Alberta, Canada Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ attributes: { 'data-testid': 'pagination-controls-next-button-hidden' } });
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithCurrentIndicatorAtEnd = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=400';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 25 });
      }
      if (selector === 'body') {
        return createLocator({ text: '99+ results Alberta, Canada Previous 15 16 17 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ count: 0 });
      }
      if (selector === 'button[data-testid^="pagination-indicator-"]') {
        return {
          count: async () => 3,
          evaluateAll: async () => ['15', '16', '17'],
          first() {
            return {
              textContent: async () => '',
              getAttribute: async () => null,
            };
          },
        };
      }
      if (selector === 'button[data-testid^="pagination-indicator-"][aria-current="true"]') {
        return createLocator({ text: '17' });
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithMorePages = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=25';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 25 });
      }
      if (selector === 'body') {
        return createLocator({ text: '54 results Alberta, Canada Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ attributes: { 'data-testid': 'pagination-controls-next-button-visible' } });
      }
      if (selector === 'button[data-testid^="pagination-indicator-"]') {
        return {
          count: async () => 3,
          evaluateAll: async () => ['1', '2', '3'],
          first() {
            return {
              textContent: async () => '',
              getAttribute: async () => null,
            };
          },
        };
      }
      if (selector === 'button[data-testid^="pagination-indicator-"][aria-current="true"]') {
        return createLocator({ text: '2' });
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await isLastPaginationPage(pageWithExactFinalWindow), true);
  assert.equal(await isLastPaginationPage(pageWithHiddenNext), true);
  assert.equal(await isLastPaginationPage(pageWithCurrentIndicatorAtEnd), true);
  assert.equal(await isLastPaginationPage(pageWithMorePages), false);
});

test("collected LinkedIn job URLs are persisted per run and filtered on reload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-scraper-"));
  const rawJobsPath = path.join(tempDir, "raw-jobs.json");

  await writeCollectedJobLinks(rawJobsPath, [
    "https://www.linkedin.com/jobs/view/123/",
    "https://example.com/not-linkedin",
    42,
    "https://www.linkedin.com/jobs/view/456/",
  ]);

  const savedPath = getCollectedJobLinksPath(rawJobsPath);
  const savedText = await readFile(savedPath, "utf8");
  assert.match(savedText, /123/);
  assert.deepEqual(await readCollectedJobLinks(rawJobsPath), [
    "https://www.linkedin.com/jobs/view/123/",
    "https://www.linkedin.com/jobs/view/456/",
  ]);
});


test("selectJobLinksForDetailScrape reuses saved links and respects the limit", () => {
  const links = [
    "https://www.linkedin.com/jobs/view/123/",
    "https://www.linkedin.com/jobs/view/456/",
    "https://www.linkedin.com/jobs/view/789/",
  ];

  assert.deepEqual(selectJobLinksForDetailScrape(links, 2), [
    "https://www.linkedin.com/jobs/view/123/",
    "https://www.linkedin.com/jobs/view/456/",
  ]);
  assert.deepEqual(selectJobLinksForDetailScrape(links, 10), links);
});


test("hasLinkCollectionStalled only trips after 30 seconds with at least one saved link", () => {
  assert.equal(hasLinkCollectionStalled({ lastLinkAddedAt: 0, collectedCount: 0, now: 30_000 }), false);
  assert.equal(hasLinkCollectionStalled({ lastLinkAddedAt: 10_000, collectedCount: 5, now: 39_999 }), false);
  assert.equal(hasLinkCollectionStalled({ lastLinkAddedAt: 10_000, collectedCount: 5, now: 40_000 }), true);
});


test("extractJobIdFromTrackingScope decodes LinkedIn tracking buffers", () => {
  const raw = JSON.stringify([{
    contentTrackingId: 'abc',
    topicName: 'JobImpressionEventV2',
    breadcrumb: {
      content: {
        data: Array.from(Buffer.from('{\"jobPosting\":{\"objectUrn\":\"urn:li:fs_normalized_jobPosting:4384294101\"}}', 'utf8')),
      },
    },
  }]);

  assert.equal(extractJobIdFromTrackingScope(raw), '4384294101');
  assert.equal(extractJobIdFromTrackingScope('not json'), null);
});


test("getValidJobCardIndexes keeps only cards with job signals", async () => {
  const locator = {
    evaluateAll: async (fn) => fn([
      { textContent: '', querySelector: (selector) => selector === '[data-view-tracking-scope]' ? null : null },
      { textContent: 'Senior Engineer', querySelector: () => null },
      { textContent: '', querySelector: (selector) => selector === 'a[href]' ? {} : null },
      { textContent: '', querySelector: (selector) => selector === '[data-view-tracking-scope]' ? {} : null },
    ]),
  };

  assert.deepEqual(await getValidJobCardIndexes({}, locator, 4), [1, 2, 3]);
  assert.deepEqual(await getValidJobCardIndexes({}, locator, 0), []);
});

test("parseHeaderFromMainText splits location, posted time, applicant info, and employment type from main text", () => {
  const mainText = "KinaxisSenior Software Developer, C++ Calgary, AB | 9 hours ago | 6 people clicked apply | Full-time About the job Build things";
  const pageTitle = "Senior Software Developer, C++ | Kinaxis | LinkedIn";

  const parsed = parseHeaderFromMainText(mainText, pageTitle);

  assert.equal(parsed.title, "Senior Software Developer, C++");
  assert.equal(parsed.company, "Kinaxis");
  assert.equal(parsed.location, "Calgary, AB");
  assert.equal(parsed.postedTime, "9 hours ago");
  assert.equal(parsed.applicantInfo, "6 people clicked apply");
  assert.equal(parsed.employmentType, "Full-time");
});

test("parseCompanySizeFromMainText prefers full employee counts instead of trailing digits", () => {
  assert.equal(parseCompanySizeFromMainText("global organization with over 2,000 employees around the world"), "2000+");
  assert.equal(parseCompanySizeFromMainText("Software Development | 51-200 employees | 110 on LinkedIn"), "51-200");
  assert.equal(parseCompanySizeFromMainText("A company with 1001+employees in North America"), "1001+");
});


test("parseSalaryFromMainText extracts only explicit pure annual salary formats", () => {
  assert.equal(parseSalaryFromMainText("Compensation $65K-$90K/yr plus benefits"), "$65,000-$90,000/yr");
  assert.equal(parseSalaryFromMainText("Expected salary is $72,500 per year"), "$72,500/yr");
  assert.equal(parseSalaryFromMainText("Pay range is $40-$50/hr"), "");
  assert.equal(parseSalaryFromMainText("Compensation is $4,000 per month ($48,000 per year)"), "");
});

test("sanitizeDescription trims LinkedIn noise markers", () => {
  assert.equal(sanitizeDescription("We're hiring?more Show less"), "We're hiring");
});
