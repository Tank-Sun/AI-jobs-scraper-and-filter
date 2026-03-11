import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeJobs } from '../src/filter/dedupe.js';

const normalization = {
  locationBuckets: {
    'alberta-ca': ['calgary', 'edmonton', 'alberta'],
    'remote-canada': ['remote', 'canada remote'],
  },
  employmentTypes: {},
  visaPolicies: {},
  companySizeBands: {},
};

test('dedupeJobs collapses repeated company-title-location postings and keeps the richer record', () => {
  const jobs = [
    {
      title: 'Senior Full Stack Engineer',
      company: 'AltaML',
      location: 'Calgary, AB',
      postedTime: '6 days ago',
      applicantInfo: '',
      companySize: '',
      description: 'Short description',
      jobUrl: 'https://example.com/older',
    },
    {
      title: 'Senior Full Stack Engineer',
      company: 'AltaML',
      location: 'Calgary, AB',
      postedTime: '1 day ago',
      applicantInfo: '24 applicants',
      companySize: '51-200',
      description: 'Much richer description with more implementation detail',
      jobUrl: 'https://example.com/newer',
    },
    {
      title: 'Senior Full Stack Engineer',
      company: 'AltaML',
      location: 'Edmonton, AB',
      postedTime: '1 day ago',
      applicantInfo: '12 applicants',
      companySize: '51-200',
      description: 'Separate location should remain',
      jobUrl: 'https://example.com/edmonton',
    },
  ];

  const result = dedupeJobs(jobs, normalization);

  assert.equal(result.uniqueJobs.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.uniqueJobs[0].jobUrl, 'https://example.com/newer');
  assert.deepEqual(result.uniqueJobs[0].duplicateJobUrls.sort(), ['https://example.com/newer', 'https://example.com/older']);
});
