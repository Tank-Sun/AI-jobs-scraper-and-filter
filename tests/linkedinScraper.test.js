import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { __testables } from "../src/scraper/linkedin.js";

const {
  buildSearchResultsPageUrl,
  getCollectedJobLinksPath,
  isLastPaginationPage,
  isNoResultsPage,
  parseHeaderFromMainText,
  parseCompanySizeFromMainText,
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


test("isNoResultsPage detects empty LinkedIn results pages", async () => {
  const pageWithNoResults = {
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
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
    locator() {
      return { count: async () => 3 };
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

test("isLastPaginationPage detects disabled next button and visible last page number", async () => {
  const pageWithDisabledNext = {
    locator(selector) {
      if (selector === '.artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ attributes: { 'aria-disabled': 'true', class: 'artdeco-pagination__button artdeco-pagination__button--next' } });
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithLastVisibleNumber = {
    locator(selector) {
      if (selector === '.artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ count: 0 });
      }
      if (selector === '.jobs-search-two-pane__pagination, .jobs-search-results-list__pagination, .artdeco-pagination') {
        return createLocator({ text: 'Previous 15 16 17' });
      }
      if (selector === '.artdeco-pagination__indicator--number.active, .artdeco-pagination__indicator.artdeco-pagination__indicator--number.selected, .artdeco-pagination__pages button[aria-current="true"], .artdeco-pagination__pages li.selected, .artdeco-pagination__pages .active') {
        return createLocator({ text: '17' });
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithMorePages = {
    locator(selector) {
      if (selector === '.artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return createLocator({ attributes: { class: 'artdeco-pagination__button artdeco-pagination__button--next' } });
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await isLastPaginationPage(pageWithDisabledNext), true);
  assert.equal(await isLastPaginationPage(pageWithLastVisibleNumber), true);
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
