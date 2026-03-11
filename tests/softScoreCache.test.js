import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scoreJobs } from '../src/scoring/softScore.js';

const requirements = {
  must_have_locations: ['remote-us'],
  must_have_company_size: ['51-200'],
  must_have_employment_types: ['full-time'],
  visa_policy: ['tn-eligible'],
  target_titles: ['software engineer'],
  acceptable_titles: ['senior software engineer'],
  all_titles: ['software engineer', 'senior software engineer'],
  experience_level: ['senior'],
  must_have_skills: ['typescript'],
  nice_to_have_skills: ['react'],
  industry_preferences: ['ai'],
  negative_skills: ['java'],
  red_flags: ['unpaid'],
  weights: {
    skills: 40,
    responsibilities: 15,
    company_quality: 15,
    title: 10,
    seniority: 10,
    growth: 5,
    risk: 5,
  },
};

const resume = {
  path: '/tmp/resume.md',
  summary: 'Product-minded full-stack engineer strong in TypeScript and React.',
  skills: ['typescript', 'react', 'node.js'],
};

const jobs = [
  {
    title: 'Senior Software Engineer',
    company: 'Acme AI',
    location: 'Remote',
    employmentType: 'Full-Time',
    visaPolicy: 'TN eligible',
    companySize: '51-200',
    postedTime: '1 day ago',
    applicantInfo: '12 applicants',
    description: 'TypeScript React role building AI product features',
    jobUrl: 'https://example.com/job-1',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  },
];

test('scoreJobs persists and reuses scoring cache entries', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-cache-'));
  const cachePath = path.join(tempDir, 'scoring-cache.json');

  const first = await scoreJobs({
    jobs,
    requirements,
    resume,
    env: {},
    cachePath,
  });

  assert.equal(first.scored.length + first.aiRejected.length, 1);

  const firstCache = await readFile(cachePath, 'utf8');
  const second = await scoreJobs({
    jobs,
    requirements,
    resume,
    env: {},
    cachePath,
  });
  const secondCache = await readFile(cachePath, 'utf8');

  assert.equal(second.scored.length + second.aiRejected.length, 1);
  assert.equal(secondCache, firstCache);
});

test('scoreJobs preserves input order while processing multiple jobs concurrently', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-order-'));
  const cachePath = path.join(tempDir, 'scoring-cache.json');
  const multiJobs = [
    {
      ...jobs[0],
      title: 'Senior Software Engineer',
      company: 'Acme AI',
      jobUrl: 'https://example.com/job-1',
      description: 'TypeScript React role building AI product features',
    },
    {
      ...jobs[0],
      title: 'Senior Software Engineer',
      company: 'Beta AI',
      jobUrl: 'https://example.com/job-2',
      description: 'TypeScript React product role with customer-facing features',
    },
    {
      ...jobs[0],
      title: 'Senior Software Engineer',
      company: 'Gamma AI',
      jobUrl: 'https://example.com/job-3',
      description: 'TypeScript React Node.js role for AI workflow tooling',
    },
  ];

  const result = await scoreJobs({
    jobs: multiJobs,
    requirements,
    resume,
    env: { SCORE_CONCURRENCY: '3' },
    cachePath,
  });

  assert.deepEqual(
    result.scored.map((job) => job.jobUrl),
    multiJobs.map((job) => job.jobUrl)
  );

  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 3);
});
