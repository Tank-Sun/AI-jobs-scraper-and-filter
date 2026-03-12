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
    '11-50': [11, 50],
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
  min_salary_annual: 70000,
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

test('applyHardFilters soft-flags oversized companies but rejects undersized ones and keeps missing company size as ambiguity', () => {
  const oversized = [
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

  const oversizedResult = applyHardFilters(oversized, requirements, normalization);
  assert.equal(oversizedResult.accepted.length, 1);
  assert.equal(oversizedResult.rejected.length, 0);
  assert.match(oversizedResult.accepted[0].aiSignals.join(','), /company_size_outside_preferred_range/);

  const missing = [
    {
      title: 'Software Engineer',
      company: 'UnknownCo',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'No sponsorship',
      companySize: '',
      description: 'Typescript React product role',
      jobUrl: 'https://example.com/2b',
    },
  ];

  const missingResult = applyHardFilters(missing, requirements, normalization);
  assert.equal(missingResult.accepted.length, 1);
  assert.equal(missingResult.rejected.length, 0);
  assert.match(missingResult.accepted[0].aiSignals.join(','), /missing_company_size_bucket/);
});


test('applyHardFilters still rejects companies below the preferred size range', () => {
  const tooSmall = [
    {
      title: 'Software Engineer',
      company: 'TinyCo',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'No sponsorship',
      companySize: '11-50',
      description: 'Typescript React product role',
      jobUrl: 'https://example.com/2c',
    },
  ];

  const result = applyHardFilters(tooSmall, requirements, normalization);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reasons.map((item) => item.field).join(','), /companySize/);
});

test('applyHardFilters rejects titles that are clearly outside the target experience range', () => {
  const jobs = [
    {
      title: 'Staff Software Engineer',
      company: 'Acme',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'TN eligible',
      companySize: '51-200',
      description: 'Typescript React Node.js role',
      jobUrl: 'https://example.com/staff',
    },
    {
      title: 'Junior Software Engineer',
      company: 'Acme',
      location: 'Remote',
      employmentType: 'Full-Time',
      visaPolicy: 'TN eligible',
      companySize: '51-200',
      description: 'Typescript React Node.js role',
      jobUrl: 'https://example.com/junior',
    },
  ];

  const result = applyHardFilters(jobs, requirements, normalization);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected.map((job) => job.reasons.map((item) => item.field).join(',')).join(','), /seniority/);
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


test('applyHardFilters rejects only salary ranges fully below the configured minimum and ignores missing salary', () => {
  const belowMinimum = [{
    title: 'Software Engineer',
    company: 'BudgetCo',
    location: 'Remote',
    employmentType: 'Full-Time',
    visaPolicy: 'TN eligible',
    companySize: '51-200',
    salary: '$50,000-$65,000/yr',
    description: 'Typescript React Node.js role',
    jobUrl: 'https://example.com/salary-low',
  }];

  const lowResult = applyHardFilters(belowMinimum, requirements, normalization);
  assert.equal(lowResult.accepted.length, 0);
  assert.equal(lowResult.rejected.length, 1);
  assert.match(lowResult.rejected[0].reasons.map((item) => item.field).join(','), /salary/);

  const overlappingSalary = [{
    title: 'Software Engineer',
    company: 'StretchCo',
    location: 'Remote',
    employmentType: 'Full-Time',
    visaPolicy: 'TN eligible',
    companySize: '51-200',
    salary: '$65,000-$90,000/yr',
    description: 'Typescript React Node.js role',
    jobUrl: 'https://example.com/salary-overlap',
  }];

  const overlapResult = applyHardFilters(overlappingSalary, requirements, normalization);
  assert.equal(overlapResult.accepted.length, 1);
  assert.equal(overlapResult.rejected.length, 0);

  const missingSalary = [{
    title: 'Software Engineer',
    company: 'UnknownPayCo',
    location: 'Remote',
    employmentType: 'Full-Time',
    visaPolicy: 'TN eligible',
    companySize: '51-200',
    salary: '',
    description: 'Typescript React Node.js role',
    jobUrl: 'https://example.com/salary-missing',
  }];

  const missingResult = applyHardFilters(missingSalary, requirements, normalization);
  assert.equal(missingResult.accepted.length, 1);
  assert.equal(missingResult.rejected.length, 0);
});
