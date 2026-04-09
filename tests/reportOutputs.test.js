import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeReports } from '../src/output/reports.js';

test('writeReports includes Gemini fallback messages in shortlist and rejected reports', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-reports-'));

  await writeReports({
    runDir,
    generatedAt: '2026-04-09T08:27:59.590Z',
    shortlist: [
      {
        title: 'Software Engineer',
        company: 'Acme',
        location: 'Remote',
        jobUrl: 'https://example.com/short',
        totalScore: 80,
        breakdown: {
          skills: 80,
          responsibilities: 80,
          company_quality: 80,
          growth: 80,
          title: 80,
          seniority: 80,
          risk: 80,
        },
        whyRecommended: 'Strong fit.',
        aiSignals: [],
        gaps: [],
        scoringFailureMessage: '503 backend unavailable',
      },
    ],
    rejected: [
      {
        title: 'Backend Engineer',
        company: 'Beta',
        jobUrl: 'https://example.com/reject',
        reasons: [
          { field: 'aiDecision', message: 'Heuristic fallback score below shortlist threshold.' },
        ],
        scoringFailureMessage: '429 Too Many Requests',
      },
    ],
    scoringFailures: [],
    rawJobs: [],
    processedJobs: [],
    summary: {},
  });

  const shortlistMd = await readFile(path.join(runDir, 'shortlist.md'), 'utf8');
  const rejectedMd = await readFile(path.join(runDir, 'rejected.md'), 'utf8');

  assert.match(shortlistMd, /Scoring fallback: 503 backend unavailable/);
  assert.match(rejectedMd, /Scoring fallback: 429 Too Many Requests/);
});
