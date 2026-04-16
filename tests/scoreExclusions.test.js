import test from 'node:test';
import assert from 'node:assert/strict';

function normalizeCompanyNameForExclusion(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitExcludedCompanies(jobs, requirements) {
  const excluded = (requirements.excluded_companies ?? []).map(normalizeCompanyNameForExclusion).filter(Boolean);
  if (excluded.length === 0) {
    return { accepted: jobs, rejected: [] };
  }

  const accepted = [];
  const rejected = [];

  for (const job of jobs) {
    const normalizedCompany = normalizeCompanyNameForExclusion(job.company);
    const matched = excluded.find((company) => normalizedCompany.includes(company));
    if (!matched) {
      accepted.push(job);
      continue;
    }

    rejected.push({
      ...job,
      reasons: [{ field: 'company', message: `Company ${job.company} is on the excluded companies list` }],
    });
  }

  return { accepted, rejected };
}

test('splitExcludedCompanies removes configured companies before scoring', () => {
  const jobs = [
    { company: 'Stripe', title: 'Full Stack Engineer' },
    { company: 'Microsoft Canada', title: 'Software Engineer' },
    { company: 'Amazon Web Services', title: 'Developer' },
    { company: 'Affirm', title: 'Backend Engineer' },
    { company: 'Guidepoint', title: 'AI Engineer' },
  ];

  const result = splitExcludedCompanies(jobs, {
    excluded_companies: ['stripe', 'microsoft', 'amazon', 'affirm'],
  });

  assert.deepEqual(result.accepted.map((job) => job.company), ['Guidepoint']);
  assert.deepEqual(result.rejected.map((job) => job.company), ['Stripe', 'Microsoft Canada', 'Amazon Web Services', 'Affirm']);
  assert.match(result.rejected[0].reasons[0].message, /excluded companies list/i);
});
