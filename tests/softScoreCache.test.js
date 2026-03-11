import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scoreJobs, __testables } from '../src/scoring/softScore.js';

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

test('riskScore ignores missing employment and visa metadata by themselves', () => {
  const score = riskScore({
    aiSignals: ['missing_employment_type_bucket', 'missing_visa_bucket', 'missing_company_size_bucket'],
    negativeSkillMatches: [],
  });

  assert.equal(score, 95);
});

test('buildGeminiPrompt treats missing metadata and unconfirmed stack as uncertainty rather than rejection', () => {
  const prompt = buildGeminiPrompt(jobs[0], requirements, resume);

  assert.match(prompt, /Missing employment type or visa policy should not by itself cause rejection or lower fit\./);
  assert.match(prompt, /Missing explicit mention of TypeScript, React, or Node\.js should be treated as uncertainty, not as an automatic rejection/);
  assert.match(prompt, /Do not reject merely because avoid-list technologies appear somewhere in the posting\./);
  assert.match(prompt, /Missing metadata and unconfirmed skills are not disqualifiers by themselves\./);
});

const { buildGeminiPrompt, buildScoreSignature, calculateWeightedTotalScore, hasAiProductSignal, hasDevexSignal, hasStrongProductSignal, heuristicScore, mergeAiAndHeuristicScores, normalizeGeminiResult, riskScore } = __testables;

test('hasAiProductSignal boosts AI product and AI-powered feature roles', () => {
  assert.equal(
    hasAiProductSignal({
      title: 'Senior Software Engineer',
      company: 'Acme',
      description: 'Build AI-powered features and copilots for customer workflows.',
    }),
    true
  );
  assert.equal(
    hasAiProductSignal({
      title: 'Backend Engineer',
      company: 'Acme',
      description: 'Maintain internal billing services.',
    }),
    false
  );
});

test('buildScoreSignature changes when job content changes', () => {
  const first = buildScoreSignature(jobs[0], 'gemini-2.5-flash');
  const second = buildScoreSignature({ ...jobs[0], description: `${jobs[0].description} with AI-powered assistant` }, 'gemini-2.5-flash');
  assert.notEqual(first, second);
});

test('scoreJobs keeps low-scoring accepted jobs in scored results instead of aiRejected', async () => {
  const lowFitJob = {
    ...jobs[0],
    title: 'Senior Java Backend Developer',
    company: 'BackEndCo',
    jobUrl: 'https://example.com/job-low-fit',
    description: 'Java Spring backend services role for internal enterprise systems',
    mustHaveSkillMatches: [],
    negativeSkillMatches: ['java'],
    aiSignals: ['negative_skill_overlap', 'title_not_in_preferred_lists'],
  };

  const result = await scoreJobs({
    jobs: [lowFitJob],
    requirements,
    resume,
    env: {},
    cachePath: '',
  });

  assert.equal(result.aiRejected.length, 0);
  assert.equal(result.scored.length, 1);
  assert.equal(result.scored[0].modelDecision, 'reject');
  assert.ok(result.scored[0].totalScore < 60);
});

test('heuristicScore prefers full stack over fitted backend over frontend-only roles', () => {
  const fullStack = heuristicScore({
    ...jobs[0],
    title: 'Senior Full Stack Engineer',
    description: 'Build end-to-end product features across the stack with TypeScript, React, Node.js, APIs, and product ownership.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const backend = heuristicScore({
    ...jobs[0],
    title: 'Senior Backend Engineer',
    description: 'Build product APIs and backend services with Node.js, TypeScript, GraphQL, and customer-facing product systems.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const frontend = heuristicScore({
    ...jobs[0],
    title: 'Senior Frontend Engineer',
    description: 'Build frontend experiences with React, Next.js, design systems, and UI polish.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  assert.ok(fullStack.totalScore > backend.totalScore);
  assert.ok(backend.totalScore > frontend.totalScore);
});

test('heuristicScore ranks web roles above React Native, and React Native above native mobile', () => {
  const webRole = heuristicScore({
    ...jobs[0],
    title: 'Senior Frontend Engineer',
    company: 'WebCo',
    description: 'Build user-facing web applications with TypeScript, React, Node.js, design systems, and product ownership.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const reactNativeRole = heuristicScore({
    ...jobs[0],
    title: 'Senior React Native Engineer',
    company: 'MobileCo',
    description: 'Build React Native and Expo mobile experiences with TypeScript and React for customer-facing product features.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const nativeMobileRole = heuristicScore({
    ...jobs[0],
    title: 'Senior Android Developer',
    company: 'NativeCo',
    description: 'Build Android applications with Kotlin, Android SDK, Jetpack Compose, and native mobile architecture.',
    aiSignals: ['title_not_in_preferred_lists'],
    mustHaveSkillMatches: [],
    negativeSkillMatches: [],
  }, requirements, resume);

  assert.ok(webRole.totalScore > reactNativeRole.totalScore);
  assert.ok(reactNativeRole.totalScore > nativeMobileRole.totalScore);
  assert.ok(reactNativeRole.breakdown.risk >= nativeMobileRole.breakdown.risk);
});

test('devex and product signals outrank generic internal tools signals', () => {
  assert.equal(
    hasDevexSignal({ title: 'Senior Fullstack Developer, Developer Productivity', description: 'Build an Internal Developer Portal using Backstage to improve developer workflows.' }),
    true
  );
  assert.equal(
    hasStrongProductSignal({ title: 'Senior Software Engineer, Product Engineering', description: 'Ship features end-to-end, write product specs, and make product and design decisions.' }),
    true
  );

  const devexRole = heuristicScore({
    ...jobs[0],
    title: 'Senior Fullstack Developer, Developer Productivity',
    company: 'MongoDB',
    description: 'Build an Internal Developer Portal using Backstage to improve developer workflows with TypeScript, React, and Node.js.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const internalToolsRole = heuristicScore({
    ...jobs[0],
    title: 'Software Developer - Tools',
    company: 'GameCo',
    description: 'Build editor tooling for artists and designers using C++ and internal tools workflows.',
    aiSignals: [],
    mustHaveSkillMatches: [],
    negativeSkillMatches: [],
  }, requirements, resume);

  assert.ok(devexRole.totalScore > internalToolsRole.totalScore);
  assert.ok(devexRole.breakdown.responsibilities > internalToolsRole.breakdown.responsibilities);
});

test('seniorityScore prefers mid-to-senior roles over junior or staff titles', () => {
  const mid = heuristicScore({
    ...jobs[0],
    title: 'Software Engineer II',
    description: 'TypeScript React Node.js product engineering role',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const junior = heuristicScore({
    ...jobs[0],
    title: 'Junior Software Engineer',
    description: 'TypeScript React Node.js role',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const staff = heuristicScore({
    ...jobs[0],
    title: 'Staff Software Engineer',
    description: 'TypeScript React Node.js role',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  assert.ok(mid.breakdown.seniority > junior.breakdown.seniority);
  assert.ok(mid.breakdown.seniority > staff.breakdown.seniority);
});

test('heuristicScore ranks strong AI product full-stack roles above consulting .NET roles', () => {
  const strongFit = heuristicScore({
    ...jobs[0],
    title: 'Senior Full Stack Engineer',
    company: 'AI Product Co',
    description: 'Build AI-powered product features with TypeScript, React, Node.js, customer-facing web applications, design systems, and product ownership.',
    aiSignals: [],
    mustHaveSkillMatches: ['typescript'],
    negativeSkillMatches: [],
  }, requirements, resume);

  const weakFit = heuristicScore({
    ...jobs[0],
    title: '.NET Full Stack Developer',
    company: 'Consulting Partner',
    description: 'Consulting role implementing C# .NET solutions for client engagement, backend services, enterprise systems, and Java integration.',
    aiSignals: ['negative_skill_overlap', 'title_not_in_preferred_lists'],
    mustHaveSkillMatches: [],
    negativeSkillMatches: ['java'],
  }, requirements, resume);

  assert.ok(strongFit.totalScore > weakFit.totalScore);
  assert.ok(strongFit.breakdown.skills > weakFit.breakdown.skills);
  assert.ok(strongFit.breakdown.risk > weakFit.breakdown.risk);
});

test('mergeAiAndHeuristicScores tempers overly optimistic AI scores with heuristic guardrails', () => {
  const merged = mergeAiAndHeuristicScores(
    {
      decision: 'shortlist',
      totalScore: 96,
      breakdown: {
        skills: 100,
        responsibilities: 100,
        company_quality: 90,
        title: 80,
        seniority: 100,
        growth: 90,
        risk: 100,
      },
      whyRecommended: 'AI likes it.',
      rejectReason: '',
      gaps: [],
      scoringSource: 'gemini',
    },
    {
      decision: 'reject',
      totalScore: 32,
      breakdown: {
        skills: 10,
        responsibilities: 20,
        company_quality: 40,
        title: 30,
        seniority: 80,
        growth: 30,
        risk: 20,
      },
      whyRecommended: '',
      rejectReason: 'Low fit.',
      gaps: [],
      scoringSource: 'heuristic',
    },
    requirements.weights
  );

  assert.equal(merged.totalScore, 54);
  assert.deepEqual(merged.breakdown, {
    skills: 46,
    responsibilities: 52,
    company_quality: 60,
    title: 50,
    seniority: 88,
    growth: 54,
    risk: 52,
  });
  assert.equal(merged.aiTotalScore, 96);
  assert.equal(merged.heuristicTotalScore, 32);
});

test('normalizeGeminiResult scales 1-10 Gemini scores up to 0-100 and recomputes total from weights', () => {
  const normalized = normalizeGeminiResult({
    decision: 'shortlist',
    total_score: 8,
    breakdown: {
      skills: 9,
      responsibilities: 8,
      company_quality: 7,
      title: 9,
      seniority: 8,
      growth: 7,
      risk: 6,
    },
    why_recommended: 'Strong fit.',
    reject_reason: '',
    gaps: ['kubernetes'],
  }, requirements.weights);

  assert.equal(normalized.totalScore, 82);
  assert.deepEqual(normalized.breakdown, {
    skills: 90,
    responsibilities: 80,
    company_quality: 70,
    title: 90,
    seniority: 80,
    growth: 70,
    risk: 60,
  });
});

test('normalizeGeminiResult ignores inconsistent Gemini total_score and recomputes from normalized breakdown', () => {
  const normalized = normalizeGeminiResult({
    decision: 'shortlist',
    total_score: 92,
    breakdown: {
      skills: 9,
      responsibilities: 85,
      company_quality: 8,
      title: 90,
      seniority: 7,
      growth: 88,
      risk: 6,
    },
    why_recommended: 'Strong fit.',
    reject_reason: '',
    gaps: [],
  }, requirements.weights);

  assert.equal(normalized.totalScore, 84);
  assert.deepEqual(normalized.breakdown, {
    skills: 90,
    responsibilities: 85,
    company_quality: 80,
    title: 90,
    seniority: 70,
    growth: 88,
    risk: 60,
  });
});

test('calculateWeightedTotalScore matches the documented requirements weights', () => {
  const breakdown = {
    skills: 90,
    responsibilities: 85,
    company_quality: 80,
    title: 90,
    seniority: 70,
    growth: 88,
    risk: 60,
  };

  assert.equal(calculateWeightedTotalScore(breakdown, requirements.weights), 84);
});

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

  assert.equal(first.scored.length, 1);
  assert.equal(first.aiRejected.length, 0);

  const firstCache = await readFile(cachePath, 'utf8');
  const second = await scoreJobs({
    jobs,
    requirements,
    resume,
    env: {},
    cachePath,
  });
  const secondCache = await readFile(cachePath, 'utf8');

  assert.equal(second.scored.length, 1);
  assert.equal(second.aiRejected.length, 0);
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
