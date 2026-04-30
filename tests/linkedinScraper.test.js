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
  getJobCardsState,
  getInitialJobCardsState,
  getValidJobCardIndexes,
  inspectJobCards,
  waitForJobCardsOrNoResults,
  autoScrollJobsList,
  getPaginationNextStates,
  isUsableNextState,
  getUsableNextStateIndex,
  hasUsableNextButton,
  getUsableNextButton,
  shouldStopAfterPartialVisiblePage,
  goToNextResultsPage,
  hasLinkCollectionStalled,
  isLastPaginationPage,
  isNoResultsPage,
  selectJobLinksForDetailScrape,
  parseHeaderFromMainText,
  parseLinkedInPageTitle,
  parseMetadataFieldsFromText,
  firstValidJobTitle,
  firstValidLocation,
  firstValidPostedTime,
  hasUsableJobDetailHeader,
  waitForUsableJobDetailHeader,
  hasUsableJobDetailDescription,
  waitForUsableJobDetailDescription,
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

function createCardElement({ text = '', href = null, trackingScope = null, dataJobId = null } = {}) {
  const linkNode = href
    ? {
        getAttribute(name) {
          return name === 'href' ? href : null;
        },
      }
    : null;
  const trackingNode = trackingScope
    ? {
        getAttribute(name) {
          return name === 'data-view-tracking-scope' ? trackingScope : null;
        },
      }
    : null;
  const dataJobNode = dataJobId
    ? {
        getAttribute(name) {
          return name === 'data-job-id' ? dataJobId : null;
        },
      }
    : null;

  return {
    textContent: text,
    getAttribute(name) {
      return name === 'data-job-id' ? dataJobId : null;
    },
    querySelector(selector) {
      if (selector === 'a[href]') {
        return linkNode;
      }
      if (selector === '[data-view-tracking-scope]') {
        return trackingNode;
      }
      if (selector === '[data-job-id]') {
        return dataJobNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href]') {
        return linkNode ? [linkNode] : [];
      }
      if (selector === '[data-view-tracking-scope]') {
        return trackingNode ? [trackingNode] : [];
      }
      return [];
    },
  };
}

test("getJobCardsState recognizes the semantic job-card selector", async () => {
  const page = {
    locator(selector) {
      return {
        count: async () => (selector === '[data-view-name="job-card"]' ? 12 : 0),
      };
    },
  };

  const state = await getJobCardsState(page);
  assert.equal(state.selector, '[data-view-name="job-card"]');
  assert.equal(state.count, 12);
});


test("getJobCardsState prefers the selector with the highest card count", async () => {
  const counts = new Map([
    ['[data-view-name="job-card"]', 8],
    ['.scaffold-layout__list-item', 25],
  ]);
  const page = {
    locator(selector) {
      return {
        count: async () => counts.get(selector) ?? 0,
      };
    },
  };

  const state = await getJobCardsState(page);
  assert.equal(state.selector, '.scaffold-layout__list-item');
  assert.equal(state.count, 25);
});


test("isUsableNextState rejects hidden or aria-disabled next buttons", () => {
  assert.equal(isUsableNextState({ disabledAttr: null, ariaDisabled: 'true', className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' }), false);
  assert.equal(isUsableNextState({ disabledAttr: null, ariaDisabled: null, className: 'artdeco-button--disabled', hiddenByLayout: false, display: 'block', visibility: 'visible' }), false);
  assert.equal(isUsableNextState({ disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: true, display: 'block', visibility: 'visible' }), false);
  assert.equal(isUsableNextState({ disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' }), true);
});


test("hasUsableNextButton only treats visible enabled next buttons as usable", async () => {
  const page = {
    locator(selector) {
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: 'true', className: 'artdeco-button artdeco-button--disabled', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
          ],
        };
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await hasUsableNextButton(page), false);
  assert.deepEqual(await getPaginationNextStates(page), [
    { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: 'true', className: 'artdeco-button artdeco-button--disabled', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
  ]);
});


test("shouldStopAfterPartialVisiblePage stops partial pages without a usable next button", async () => {
  const pageWithoutNext = {
    locator(selector) {
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: 'true', className: 'artdeco-button--disabled', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
          ],
        };
      }
      return createLocator({ count: 0 });
    },
  };

  const pageWithNext = {
    locator(selector) {
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
          ],
        };
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await shouldStopAfterPartialVisiblePage(pageWithoutNext, 20), true);
  assert.equal(await shouldStopAfterPartialVisiblePage(pageWithNext, 20), false);
  assert.equal(await shouldStopAfterPartialVisiblePage(pageWithoutNext, 25), false);
});


test("getInitialJobCardsState reloads once when selectors stay empty through the initial waits", async () => {
  let afterReload = false;
  let reloads = 0;
  let waits = 0;
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => {
    now += 3000;
    return now;
  };

  try {
    const page = {
      async reload() {
        reloads += 1;
        afterReload = true;
      },
      async waitForTimeout() {
        waits += 1;
      },
      locator(selector) {
        if (selector === '.scaffold-layout__list-item') {
          return {
            count: async () => (afterReload ? 26 : 0),
            evaluateAll: async () => (afterReload
              ? Array.from({ length: 26 }, (_, index) => ({ index, text: `Job ${index}`, hasText: true, jobId: `${1000 + index}` }))
              : []),
          };
        }
        if (selector === 'main') {
          return {
            count: async () => 1,
            first() {
              return {
                textContent: async () => 'Software developer jobs in Alberta, Canada',
              };
            },
          };
        }
        return {
          count: async () => 0,
          evaluateAll: async () => [],
        };
      },
    };

    const state = await getInitialJobCardsState(page);
    assert.equal(reloads, 1);
    assert.ok(waits >= 1);
    assert.equal(state.selector, '.scaffold-layout__list-item');
    assert.equal(state.count, 26);
  } finally {
    Date.now = originalNow;
  }
});


test("getInitialJobCardsState does not reload a true no-results page", async () => {
  let reloads = 0;
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => {
    now += 3000;
    return now;
  };

  try {
    const page = {
      async reload() {
        reloads += 1;
      },
      async waitForTimeout() {},
      locator(selector) {
        if (selector === 'main') {
          return {
            count: async () => 1,
            first() {
              return {
                textContent: async () => 'No matching jobs found. Please broaden your filters.',
              };
            },
          };
        }
        return {
          count: async () => 0,
          evaluateAll: async () => [],
        };
      },
    };

    const state = await getInitialJobCardsState(page);
    assert.equal(reloads, 0);
    assert.equal(state.count, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("inspectJobCards ignores known non-job explainer signals", async () => {
  const locator = {
    evaluateAll: async (callback) => callback([
      createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' }),
      createCardElement({ text: 'Associate Software Developer', dataJobId: '4405440356' }),
    ]),
  };

  const signals = await inspectJobCards(locator);
  assert.deepEqual(signals, [
    { index: 1, text: 'Associate Software Developer', hasText: true, jobId: '4405440356' },
  ]);
});


test("inspectJobCards does not rely on outer helper bindings inside evaluateAll", async () => {
  const locator = {
    evaluateAll: async (callback) => {
      const source = callback.toString();
      assert.match(source, /const isExcludedSignal = normalized === 'how promoted jobs are ranked'/);
      assert.doesNotMatch(source, /isExcludedJobSignalText\(/);
      return callback([
        createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' }),
        createCardElement({ text: 'Associate Software Developer', dataJobId: '4405440356' }),
      ]);
    },
  };

  const signals = await inspectJobCards(locator);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].jobId, '4405440356');
});


test("getValidJobCardIndexes ignores explainer-only cards", async () => {
  const locator = {
    evaluateAll: async (callback) => callback([
      createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' }),
      createCardElement({ text: 'Intermediate Developer', dataJobId: '4389958578' }),
    ]),
  };

  const indexes = await getValidJobCardIndexes(null, locator, 2);
  assert.deepEqual(indexes, [1]);
});


test("waitForJobCardsOrNoResults waits for multiple credible job signals before settling", async () => {
  let now = 1;
  let waitCalls = 0;
  let stage = 0;
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const page = {
      async waitForTimeout(ms) {
        waitCalls += 1;
        now += ms;
        if (waitCalls >= 2) {
          stage = 1;
        }
      },
      locator(selector) {
        if (selector === '.scaffold-layout__list-item') {
          return {
            count: async () => 26,
            evaluateAll: async (callback) => callback(
              stage === 0
                ? [createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' })]
                : [
                    createCardElement({ text: 'Intermediate Developer', dataJobId: '1' }),
                    createCardElement({ text: 'SAP Developer', dataJobId: '2' }),
                    createCardElement({ text: 'Senior Mobile Engineer', dataJobId: '3' }),
                  ]
            ),
          };
        }
        if (selector === 'main') {
          return {
            count: async () => 1,
            first() {
              return {
                textContent: async () => 'Software developer jobs in Alberta, Canada',
              };
            },
          };
        }
        return {
          count: async () => 0,
          evaluateAll: async () => [],
        };
      },
    };

    await waitForJobCardsOrNoResults(page, 4000, 500);
    assert.ok(waitCalls >= 4);
    assert.equal(stage, 1);
  } finally {
    Date.now = originalNow;
  }
});


test("autoScrollJobsList uses at least the detected card count as scroll passes", async () => {
  let scrollCalls = 0;
  let wheelCalls = 0;
  let waits = 0;
  const page = {
    mouse: {
      wheel: async () => {
        wheelCalls += 1;
      },
    },
    waitForTimeout: async () => {
      waits += 1;
    },
    locator(selector) {
      if (selector !== '.scaffold-layout__list-item') {
        return {
          count: async () => 0,
          nth() {
            return {
              scrollIntoViewIfNeeded: async () => {},
            };
          },
        };
      }

      return {
        count: async () => 25,
        nth(index) {
          return {
            scrollIntoViewIfNeeded: async () => {
              scrollCalls += 1;
              assert.ok(index >= 0);
            },
          };
        },
      };
    },
  };

  await autoScrollJobsList(page, { targetCount: 25 });
  assert.equal(scrollCalls, 25);
  assert.equal(wheelCalls, 25);
  assert.equal(waits, 25);
});


test("hasUsableNextButton matches the same next-button selector used by goToNextResultsPage", async () => {
  const pageWithGenericNextOnly = {
    locator(selector) {
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: 'true', className: 'artdeco-button artdeco-button--disabled', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
          ],
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const pageWithUsableNext = {
    locator(selector) {
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
          ],
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  assert.equal(await hasUsableNextButton(pageWithGenericNextOnly), false);
  assert.equal(await hasUsableNextButton(pageWithUsableNext), true);
});


test("goToNextResultsPage clicks the usable visible Next button before falling back to a direct URL", async () => {
  let clickedIndex = null;
  const waits = [];
  const page = {
    _url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=123',
    url() {
      return this._url;
    },
    locator(selector) {
      if (selector === 'main') {
        return {
          count: async () => 1,
          first() {
            return {
              textContent: async () => 'Page one jobs',
            };
          },
        };
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [
            { testId: 'pagination-controls-next-button-hidden', disabledAttr: null, ariaDisabled: 'true', className: 'artdeco-button--disabled', hiddenByLayout: true, display: 'none', visibility: 'hidden' },
            { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
          ],
          nth(index) {
            return {
              click: async () => {
                clickedIndex = index;
                page._url = 'https://www.linkedin.com/jobs/search-results/?start=25';
              },
            };
          },
        };
      }
      return createLocator({ count: 0 });
    },
    waitForTimeout: async (ms) => {
      waits.push(ms);
    },
    goto: async () => {
      throw new Error('goto should not be used when next button succeeds');
    },
  };

  await goToNextResultsPage(page, 25);
  assert.equal(clickedIndex, 1);
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


test("goToNextResultsPage falls back to a direct URL when page content changes but the URL does not", async () => {
  let clicked = 0;
  const waits = [];
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => {
    now += 5000;
    return now;
  };

  try {
    const calls = [];
    let pageText = 'Page one jobs';
    const page = {
      _url: 'https://www.linkedin.com/jobs/search-results/?keywords=software%20developer',
      url() {
        return this._url;
      },
      locator(selector) {
        if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
          return {
            evaluateAll: async () => [
              { testId: 'pagination-controls-next-button-visible', disabledAttr: null, ariaDisabled: null, className: '', hiddenByLayout: false, display: 'block', visibility: 'visible' },
            ],
            nth() {
              return {
                click: async () => {
                  clicked += 1;
                  pageText = 'Page two jobs';
                },
              };
            },
          };
        }
        if (selector === 'main') {
          return {
            count: async () => 1,
            first() {
              return {
                textContent: async () => pageText,
              };
            },
          };
        }
        return {
          count: async () => 0,
          first() {
            return {
              textContent: async () => '',
            };
          },
        };
      },
      waitForTimeout: async (ms) => {
        waits.push(ms);
      },
      goto: async (url) => {
        calls.push(url);
      },
    };

    await goToNextResultsPage(page, 25);
    assert.equal(clicked, 1);
    assert.deepEqual(calls, ['https://www.linkedin.com/jobs/search-results/?keywords=software+developer&start=25']);
    assert.ok(waits.length >= 1);
  } finally {
    Date.now = originalNow;
  }
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
    '[data-view-name="job-card"]',
    'li[data-occludable-job-id]',
    '.jobs-search-results__list-item',
    '.scaffold-layout__list-item',
  ]);

  function createEmptyResultsPage(text) {
    return {
      locator(selector) {
        if (cardSelectors.has(selector)) {
          return { count: async () => 0 };
        }
        if (selector === 'main') {
          return {
            count: async () => 1,
            first() {
              return {
                textContent: async () => text,
              };
            },
          };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      },
    };
  }

  const pageWithNoResults = createEmptyResultsPage('No results found Try shortening or rephrasing your search.');
  const pageWithNoMatchingJobs = createEmptyResultsPage('No matching jobs found Please broaden your filters.');

  const pageWithCards = {
    locator(selector) {
      if (cardSelectors.has(selector)) {
        return { count: async () => (selector === '.scaffold-layout__list-item' ? 3 : 0) };
      }
      return { count: async () => 0 };
    },
  };

  assert.equal(await isNoResultsPage(pageWithNoResults), true);
  assert.equal(await isNoResultsPage(pageWithNoMatchingJobs), true);
  assert.equal(await isNoResultsPage(pageWithCards), false);
});


function createLocator({ count = 1, text = '', attributes = {}, evaluateAllResult = [] } = {}) {
  return {
    count: async () => count,
    evaluateAll: async () => evaluateAllResult,
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
        return createLocator({ count: 4, evaluateAllResult: Array.from({ length: 4 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
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
        return createLocator({ count: 4, evaluateAllResult: Array.from({ length: 4 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
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
        return createLocator({ count: 25, evaluateAllResult: Array.from({ length: 25 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
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
      return createLocator({ count: 25, evaluateAllResult: Array.from({ length: 25 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
    }
    if (selector === 'body') {
      return createLocator({ text: '99+ results Alberta, Canada Previous 1 2 3 Next' });
    }
    if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
      return {
        count: async () => 1,
        first() {
          return {
            count: async () => 1,
          };
        },
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
        return createLocator({ count: 25, evaluateAllResult: Array.from({ length: 25 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
      }
      if (selector === 'body') {
        return createLocator({ text: '54 results Alberta, Canada Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          count: async () => 1,
          first() {
            return {
              count: async () => 1,
            };
          },
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



test("isLastPaginationPage treats a partial page with pagination text but no usable next button as the last page", async () => {
  const page = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=0';
    },
    locator(selector) {
      if (selector === '.scaffold-layout__list-item') {
        return {
          count: async () => 18,
          evaluateAll: async (callback) => callback([
            createCardElement({ text: 'Lead Data Engineer - Databricks (Remote)', dataJobId: '1' }),
            createCardElement({ text: 'Software Developer', dataJobId: '2' }),
            createCardElement({ text: 'Intermediate Developer', dataJobId: '3' }),
            createCardElement({ text: 'Frontend Engineer', dataJobId: '4' }),
            createCardElement({ text: 'Platform Engineer', dataJobId: '5' }),
            createCardElement({ text: 'Backend Developer', dataJobId: '6' }),
            createCardElement({ text: 'API Engineer', dataJobId: '7' }),
            createCardElement({ text: 'DevOps Engineer', dataJobId: '8' }),
            createCardElement({ text: 'QA Automation Developer', dataJobId: '9' }),
            createCardElement({ text: 'Web Developer', dataJobId: '10' }),
            createCardElement({ text: 'Data Engineer', dataJobId: '11' }),
            createCardElement({ text: 'Full Stack Engineer', dataJobId: '12' }),
            createCardElement({ text: 'React Developer', dataJobId: '13' }),
            createCardElement({ text: 'JavaScript Developer', dataJobId: '14' }),
            createCardElement({ text: 'Software Engineer in Test', dataJobId: '15' }),
            createCardElement({ text: 'CICD Programmer Analyst II', dataJobId: '16' }),
            createCardElement({ text: 'Lead Software Engineer', dataJobId: '17' }),
            createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' }),
          ]),
        };
      }
      if (selector === 'body') {
        return createLocator({ text: '17 results Alberta, Canada Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [],
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
        return createLocator({ text: '1' });
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await isLastPaginationPage(page), true);
});


test("isLastPaginationPage treats a partial page with no next or pagination controls as the last page", async () => {
  const page = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=0';
    },
    locator(selector) {
      if (selector === '.scaffold-layout__list-item') {
        return {
          count: async () => 17,
          evaluateAll: async (callback) => callback([
            createCardElement({ text: 'Senior Data Engineer (Remote)', dataJobId: '1' }),
            createCardElement({ text: 'Software Developer II', dataJobId: '2' }),
            createCardElement({ text: 'Frontend Developer', dataJobId: '3' }),
            createCardElement({ text: 'Intermediate Developer', dataJobId: '4' }),
            createCardElement({ text: 'Platform Engineer', dataJobId: '5' }),
            createCardElement({ text: 'Backend Engineer', dataJobId: '6' }),
            createCardElement({ text: 'Full Stack Engineer', dataJobId: '7' }),
            createCardElement({ text: 'Web Developer', dataJobId: '8' }),
            createCardElement({ text: 'Data Engineer', dataJobId: '9' }),
            createCardElement({ text: 'DevOps Engineer', dataJobId: '10' }),
            createCardElement({ text: 'API Engineer', dataJobId: '11' }),
            createCardElement({ text: 'JavaScript Developer', dataJobId: '12' }),
            createCardElement({ text: 'React Developer', dataJobId: '13' }),
            createCardElement({ text: 'Software Engineer', dataJobId: '14' }),
            createCardElement({ text: 'QA Automation Developer', dataJobId: '15' }),
            createCardElement({ text: 'Engineering Analyst', dataJobId: '16' }),
            createCardElement({ text: 'How promoted jobs are ranked', href: '/help/linkedin/promoted-jobs' }),
          ]),
        };
      }
      if (selector === 'body') {
        return createLocator({ text: 'Software developer jobs in Alberta, Canada' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          evaluateAll: async () => [],
        };
      }
      if (selector === 'button[data-testid^="pagination-indicator-"]') {
        return {
          count: async () => 0,
          evaluateAll: async () => [],
          first() {
            return {
              textContent: async () => '',
              getAttribute: async () => null,
            };
          },
        };
      }
      return createLocator({ count: 0 });
    },
  };

  assert.equal(await isLastPaginationPage(page), true);
});


test("isLastPaginationPage prefers a visible next button even when a hidden next button is also present in the DOM", async () => {
  const pageWithBothNextStates = {
    url() {
      return 'https://www.linkedin.com/jobs/search-results/?start=50';
    },
    locator(selector) {
      if (selector === '[data-view-name="job-search-job-card"]') {
        return createLocator({ count: 25, evaluateAllResult: Array.from({ length: 25 }, (_, index) => ({ index, text: `Job ${index + 1}`, hasText: true, jobId: String(index + 1) })) });
      }
      if (selector === 'body') {
        return createLocator({ text: '99+ results Greater Vancouver, BC Previous 1 2 3 Next' });
      }
      if (selector === '[data-testid="pagination-controls-next-button-hidden"], [data-testid="pagination-controls-next-button-visible"], .artdeco-pagination__button--next, button[aria-label="Next"], button[aria-label="Next Page"]') {
        return {
          count: async () => 1,
          first() {
            return {
              count: async () => 1,
            };
          },
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
    title: async () => 'Software Engineer | Example Co | LinkedIn',
    goto: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('page.goto: Timeout 60000ms exceeded.');
        error.name = 'TimeoutError';
        throw error;
      }
    },
    locator(selector) {
      if (selector.includes('job-details-jobs-unified-top-card__company-name')) {
        return createLocator({ text: 'Example Co' });
      }
      if (selector.includes('job-details-jobs-unified-top-card__job-title')) {
        return createLocator({ text: 'Software Engineer' });
      }
      if (selector.includes('jobs-description__content')) {
        return createLocator({ text: 'About the job This role builds reliable customer-facing product features with JavaScript, TypeScript, Node.js, APIs, testing, and operational ownership across the full software lifecycle.' });
      }
      return createLocator({ count: 0 });
    },
    waitForTimeout: async (ms) => {
      waits.push(ms);
    },
  };

  await loadJobDetailPage(page, 'https://www.linkedin.com/jobs/view/123/');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test("parseLinkedInPageTitle and field validators reject partially hydrated company-only headers", () => {
  assert.deepEqual(parseLinkedInPageTitle('| Hopper | LinkedIn'), { title: '', company: 'Hopper' });
  assert.deepEqual(parseLinkedInPageTitle('Senior Backend Engineer | Hopper | LinkedIn'), { title: 'Senior Backend Engineer', company: 'Hopper' });
  assert.equal(firstValidJobTitle('Hopper', '| Hopper'), '');
  assert.equal(firstValidJobTitle('Hopper', '| Hopper', 'Senior Backend Engineer'), 'Senior Backend Engineer');
  assert.equal(firstValidLocation('Hopper', '', 'Hopper', 'Vancouver, BC'), 'Vancouver, BC');
  assert.equal(firstValidPostedTime('61 years ago', 'Reposted 19 hours ago'), 'Reposted 19 hours ago');
});

test("parseMetadataFieldsFromText ignores company-only partial detail metadata", () => {
  assert.deepEqual(parseMetadataFieldsFromText('Hopper · 61 years ago · Over 100 people clicked apply'), {
    location: '',
    postedTime: '',
    applicantInfo: 'Over 100 people clicked apply',
    employmentType: '',
  });
});

test("waitForUsableJobDetailHeader waits through a partially hydrated company-only page", async () => {
  let waits = 0;
  const page = {
    title: async () => (waits === 0 ? '| Scribd, Inc. | LinkedIn' : 'Senior Frontend Engineer | Scribd, Inc. | LinkedIn'),
    locator(selector) {
      if (selector.includes('job-details-jobs-unified-top-card__company-name')) {
        return createLocator({ text: 'Scribd, Inc.' });
      }
      if (selector.includes('job-details-jobs-unified-top-card__job-title')) {
        return createLocator({ text: waits === 0 ? '' : 'Senior Frontend Engineer' });
      }
      return createLocator({ count: 0 });
    },
    waitForTimeout: async () => {
      waits += 1;
    },
  };

  assert.equal(await hasUsableJobDetailHeader(page), false);
  assert.equal(await waitForUsableJobDetailHeader(page, 1000), true);
  assert.equal(waits, 1);
});

test("waitForUsableJobDetailDescription waits through an initially empty detail body", async () => {
  let waits = 0;
  const loadedDescription = 'About the job This Security Developer role includes designing application security tooling, building services, integrating APIs, writing production code, and collaborating with software teams.';
  const page = {
    locator(selector) {
      if (selector.includes('jobs-description__content')) {
        return createLocator({ text: waits === 0 ? '' : loadedDescription });
      }
      if (selector === 'main') {
        return createLocator({ text: waits === 0 ? 'Security Developer Raise Calgary, AB' : loadedDescription });
      }
      return createLocator({ count: 0 });
    },
    waitForTimeout: async () => {
      waits += 1;
    },
  };

  assert.equal(await hasUsableJobDetailDescription(page), false);
  assert.equal(await waitForUsableJobDetailDescription(page, 1000), true);
  assert.equal(waits, 1);
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
      { textContent: '', getAttribute: () => null, querySelector: (selector) => selector === '[data-view-tracking-scope]' ? null : null },
      { textContent: 'Senior Engineer', getAttribute: () => null, querySelector: () => null },
      { textContent: '', getAttribute: () => null, querySelector: (selector) => selector === 'a[href]' ? {} : null },
      { textContent: '', getAttribute: () => null, querySelector: (selector) => selector === '[data-view-tracking-scope]' ? {} : null },
      { textContent: '', getAttribute: (name) => name === 'data-job-id' ? '4388589355' : null, querySelector: () => null },
    ]),
  };

  assert.deepEqual(await getValidJobCardIndexes({}, locator, 5), [1, 2, 3, 4]);
  assert.deepEqual(await getValidJobCardIndexes({}, locator, 0), []);
});

test("inspectJobCards extracts direct job ids from data-job-id attributes", async () => {
  const locator = {
    evaluateAll: async (fn) => fn([
      {
        textContent: '',
        getAttribute: (name) => name === 'data-job-id' ? '4388589355' : null,
        querySelector: () => null,
        querySelectorAll: () => [],
      },
    ]),
  };

  assert.deepEqual(await inspectJobCards(locator), [
    { index: 0, text: '', hasText: false, jobId: '4388589355' },
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

