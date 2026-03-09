import test from 'node:test';
import assert from 'node:assert/strict';

import { applyHardFilters } from '../src/filter/hardFilter.js';

const normalization = {
  locationBuckets: {
    'denver-co': ['denver, co', 'greater denver area'],
    'remote-us': ['remote'],
  },
  employmentTypes: {
    'full-time': ['full-time', 'full time'],
  },
  visaPolicies: {
    'sponsorship-available': ['sponsorship available'],
    'no-sponsorship': ['no sponsorship'],
  },
  companySizeBands: {
    '11-50': [11, 50],
    '51-200': [51, 200],
  },
};

const requirements = {
  must_have_locations: ['denver-co', 'remote-us'],
  must_have_company_size: ['11-50', '51-200'],
  must_have_employment_types: ['full-time'],
  must_have_visa_policy: ['sponsorship-available'],
  target_titles: ['backend engineer'],
  nice_to_have_skills: ['node.js'],
  red_flags: ['unpaid'],
  weights: {
    skills: 35,
    responsibilities: 20,
    growth: 15,
    title: 10,
    seniority: 10,
    risk: 10,
  },
};

test('applyHardFilters accepts deterministic matches', () => {
  const jobs = [
    {
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Denver, CO',
      employmentType: 'Full-Time',
      visaPolicy: 'Sponsorship available',
      companySize: '51-200',
      description: 'Node.js services and distributed systems',
      jobUrl: 'https://example.com/1',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test('applyHardFilters rejects disallowed jobs with explicit reasons', () => {
  const jobs = [
    {
      title: 'Frontend Engineer',
      company: 'BigCo',
      location: 'Austin, TX',
      employmentType: 'Full-Time',
      visaPolicy: 'No sponsorship',
      companySize: '5000',
      description: 'Unpaid trial project',
      jobUrl: 'https://example.com/2',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reasons.map((item) => item.field).join(','), /location|visaPolicy|redFlags/);
});
