import test from 'node:test';
import assert from 'node:assert/strict';

import { applyHardFilters } from '../src/filter/hardFilter.js';

const normalization = {
  locationBuckets: {
    'remote-us': ['remote'],
    'seattle-wa': ['seattle'],
  },
  employmentTypes: {
    'full-time': ['full-time', 'full time'],
  },
  visaPolicies: {
    'tn-eligible': ['tn eligible'],
    'no-sponsorship-required': ['no sponsorship'],
  },
  companySizeBands: {
    '51-200': [51, 200],
    '201-500': [201, 500],
    '5000+': [5000, 1000000],
  },
};

const requirements = {
  must_have_locations: ['remote-us', 'seattle-wa'],
  must_have_company_size: ['51-200', '201-500'],
  must_have_employment_types: ['full-time'],
  visa_policy: ['tn-eligible', 'no-sponsorship-required'],
  target_titles: ['software engineer'],
  acceptable_titles: ['senior software engineer'],
  all_titles: ['software engineer', 'senior software engineer'],
  experience_level: ['mid-level', 'senior'],
  must_have_skills: ['typescript', 'react'],
  nice_to_have_skills: ['playwright'],
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

test('applyHardFilters accepts deterministic matches and keeps AI signals for ambiguity', () => {
  const jobs = [
    {
      title: 'Product Engineer',
      company: 'Acme',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'TN eligible',
      companySize: '51-200',
      description: 'Typescript React role with platform work',
      jobUrl: 'https://example.com/1',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.match(result.accepted[0].aiSignals.join(','), /title_not_in_preferred_lists/);
});

test('applyHardFilters keeps company-size mismatches as AI signals instead of hard rejection', () => {
  const jobs = [
    {
      title: 'Software Engineer',
      company: 'BigCo',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'No sponsorship',
      companySize: '5000+',
      description: 'Typescript React product role',
      jobUrl: 'https://example.com/2',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.match(result.accepted[0].aiSignals.join(','), /company_size_outside_preferred_range/);
});

test('applyHardFilters rejects explicit hard filter mismatches', () => {
  const jobs = [
    {
      title: 'Software Engineer',
      company: 'BigCo',
      location: 'Austin, TX',
      employmentType: 'Full-Time',
      visaPolicy: 'No sponsorship',
      companySize: '5000+',
      description: 'Unpaid trial project in Java',
      jobUrl: 'https://example.com/3',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reasons.map((item) => item.field).join(','), /location|redFlags/);
});
