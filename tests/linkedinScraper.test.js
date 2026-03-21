import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { __testables } from "../src/scraper/linkedin.js";

const {
  buildSearchResultsPageUrl,
  getCollectedJobLinksPath,
  getFailedDetailUrlsPath,
  getValidJobCardIndexes,
  goToNextResultsPage,
  hasLinkCollectionStalled,
  isLastPaginationPage,
  isNoResultsPage,
  selectJobLinksForDetailScrape,
  parseHeaderFromMainText,
  parseMetadataFieldsFromText,
  parseTotalResultsCount,
  parseCompanySizeFromMainText,
  extractJobIdFromDetailPane,
  waitForDetailPaneJobIdChange,
  triggerJobCardSelection,
  extractJobIdFromTrackingScope,
  parseSalaryFromMainText,
  isPlaywrightTimeoutError,
  loadJobDetailPage,
  resolveSignalJobId,
  readCollectedJobLinks,
  readFailedDetailUrls,
  sanitizeDescription,
  writeCollectedJobLinks,
  writeFailedDetailUrls,
} = __testables;

test("goToNextResultsPage prefers the visible Next button before falling back to a direct URL", async () => {
  let clicked = 0;
  const waits = [];
  const page = {
    _url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=123',
    url() {
      return this._url;
    },
    locator(selector) {
      assert.match(selector, /pagination-controls-next-button-visible/);
      return {
        first: () => ({
          count: async () => 1,
          click: async () => {
            clicked += 1;
            page._url = 'https://www.linkedin.com/jobs/search-results/?start=25';
          },
        }),
      };
    },
    waitForTimeout: async (ms) => {
      waits.push(ms);
    },
    goto: async () => {
      throw new Error('goto should not be used when next button succeeds');
    },
  };

  await goToNextResultsPage(page, 25);
  assert.equal(clicked, 1);
  assert.equal(page.url(), 'https://www.linkedin.com/jobs/search-results/?start=25');
  assert.ok(waits.length >= 1);
});

test("goToNextResultsPage falls back to a direct URL when the next button is unavailable", async () => {
  const calls = [];
  const page = {
    _url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=123&keywords=software%20developer',
    url() {
      return this._url;
    },
    locator() {
      return {
        first: () => ({
          count: async () => 0,
          click: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
    goto: async (url) => {
      calls.push(url);
      page._url = url;
    },
  };

  await goToNextResultsPage(page, 25);
  assert.deepEqual(calls, ['https://www.linkedin.com/jobs/search-results/?keywords=software+developer&start=25']);
});

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
        return {
          evaluateAll: async () => [],
        };
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
        return {
          evaluateAll: async () => [{ testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: true, display: 'none', visibility: 'hidden' }],
        };
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
        return {
          evaluateAll: async () => [],
        };
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

  const pageWithVisibleNextButCurrentIndicatorAtEdge = {
  url() {
    return 'https://www.linkedin.com/jobs/search-results/?start=50';
  },
  locator(selector) {
    if (selector === '[data-view-name="job-search-job-card"]') {
      return createLocator({ count: 25 });
    }
    if (selector === 'body') {
      return createLocator({ text: '99+ results Alberta, Canada Previous 1 2 3 Next' });
    }
    if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
      return {
        evaluateAll: async () => [{ testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' }],
      };
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
      return createLocator({ text: '3' });
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
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
            { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
          ],
        };
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
  assert.equal(await isLastPaginationPage(pageWithVisibleNextButCurrentIndicatorAtEdge), false);
  assert.equal(await isLastPaginationPage(pageWithMorePages), false);
});

test("isLastPaginationPage prefers a visible next button even when a hidden next button is also present in the DOM", async () => {
  const pageWithBothNextStates = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=50';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 25 });
      }
      if (selector === 'body') {
        return createLocator({ text: '99+ results Greater Vancouver, BC Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
            { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
          ],
        };
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
        return createLocator({ text: '3' });
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await isLastPaginationPage(pageWithBothNextStates), false);
});

test("failed LinkedIn detail URLs are persisted per run and filtered on reload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-failed-detail-"));
  const rawJobsPath = path.join(tempDir, "raw-jobs.json");

  await writeFailedDetailUrls(rawJobsPath, [
    "https://www.linkedin.com/jobs/view/111/",
    "https://example.com/not-linkedin",
    42,
    "https://www.linkedin.com/jobs/view/222/",
  ]);

  const savedPath = getFailedDetailUrlsPath(rawJobsPath);
  const savedText = await readFile(savedPath, "utf8");
  assert.match(savedText, /111/);
  assert.deepEqual(await readFailedDetailUrls(rawJobsPath), [
    "https://www.linkedin.com/jobs/view/111/",
    "https://www.linkedin.com/jobs/view/222/",
  ]);
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


test("triggerJobCardSelection uses a direct DOM click", async () => {
  let clicked = 0;
  const handle = {
    evaluate: async (fn) => {
      fn({ click: () => { clicked += 1; } });
    },
  };

  assert.equal(await triggerJobCardSelection(handle), true);
  assert.equal(clicked, 1);
});

test("triggerJobCardSelection returns false when DOM click throws", async () => {
  const handle = {
    evaluate: async () => {
      throw new Error('detached');
    },
  };

  assert.equal(await triggerJobCardSelection(handle), false);
});

test("resolveSignalJobId prefers currentJobId from the URL before waiting for the detail pane", async () => {
  const page = {
    _url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=111',
    url() {
      return this._url;
    },
    locator(selector) {
      assert.equal(selector, 'main a[href*="/jobs/view/"], aside a[href*="/jobs/view/"]');
      return {
        evaluateAll: async (fn) => fn([
          { getAttribute: () => 'https://www.linkedin.com/jobs/view/111/' },
        ]),
      };
    },
    waitForTimeout: async () => {},
  };
  const handle = {
    evaluate: async (fn) => {
      fn({ click: () => { page._url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=222'; } });
    },
    click: async () => {
      throw new Error('fallback click should not run');
    },
  };

  assert.equal(await resolveSignalJobId(page, handle, '111', 500), '222');
});

test("waitForDetailPaneJobIdChange returns the new detail-pane job id after a click-triggered change", async () => {
  let waits = 0;
  const page = {
    _url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=111',
    url() {
      return this._url;
    },
    locator(selector) {
      assert.equal(selector, 'main a[href*="/jobs/view/"], aside a[href*="/jobs/view/"]');
      return {
        evaluateAll: async (fn) => fn([
          { getAttribute: () => waits >= 1 ? 'https://www.linkedin.com/jobs/view/222/' : 'https://www.linkedin.com/jobs/view/111/' },
        ]),
      };
    },
    waitForTimeout: async () => {
      waits += 1;
      page._url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=222';
    },
  };

  assert.equal(await waitForDetailPaneJobIdChange(page, '111', 500), '222');
});

test("isPlaywrightTimeoutError recognizes Playwright-style navigation timeouts", () => {
  assert.equal(isPlaywrightTimeoutError({ name: 'TimeoutError', message: 'page.goto: Timeout 60000ms exceeded.' }), true);
  assert.equal(isPlaywrightTimeoutError({ message: 'page.goto: Timeout 60000ms exceeded.' }), true);
  assert.equal(isPlaywrightTimeoutError(new Error('random failure')), false);
});

test("loadJobDetailPage retries once after a timeout and then succeeds", async () => {
  const waits = [];
  let calls = 0;
  const page = {
    goto: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('page.goto: Timeout 60000ms exceeded.');
        error.name = 'TimeoutError';
        throw error;
      }
    },
    waitForTimeout: async (ms) => {
      waits.push(ms);
    },
  };

  await loadJobDetailPage(page, 'https://www.linkedin.com/jobs/view/123/');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000, 2200]);
});

test("extractJobIdFromDetailPane reads the selected job id from detail links", async () => {
  const page = {
    locator(selector) {
      assert.equal(selector, 'main a[href*="/jobs/view/"], aside a[href*="/jobs/view/"]');
      return {
        evaluateAll: async (fn) => fn([
          { getAttribute: () => 'https://www.linkedin.com/jobs/view/4388173035/?trackingId=abc' },
          { getAttribute: () => null },
        ]),
      };
    },
  };

  assert.equal(await extractJobIdFromDetailPane(page), '4388173035');
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

test("parseMetadataFieldsFromText parses bullet-separated top-card metadata", () => {
  const parsed = parseMetadataFieldsFromText("Toronto, ON, Canada · 2 days ago · 48 applicants · Full-time");

  assert.equal(parsed.location, "Toronto, ON, Canada");
  assert.equal(parsed.postedTime, "2 days ago");
  assert.equal(parsed.applicantInfo, "48 applicants");
  assert.equal(parsed.employmentType, "Full-time");
});

test("parseHeaderFromMainText handles title-first LinkedIn headers with bullet separators", () => {
  const mainText = "Senior Forward Deployed Developer, Applied AI Google Toronto, ON, Canada · 2 days ago · 48 applicants · Full-time About the job Build things";
  const pageTitle = "Senior Forward Deployed Developer, Applied AI | Google | LinkedIn";

  const parsed = parseHeaderFromMainText(mainText, pageTitle);

  assert.equal(parsed.location, "Toronto, ON, Canada");
  assert.equal(parsed.postedTime, "2 days ago");
  assert.equal(parsed.applicantInfo, "48 applicants");
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

