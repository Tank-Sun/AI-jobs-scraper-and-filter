import test from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/scraper/linkedin.js';

const { parseHeaderFromMainText, parseCompanySizeFromMainText, sanitizeDescription } = __testables;

test('parseHeaderFromMainText splits location, posted time, applicant info, and employment type from main text', () => {
  const mainText = 'KinaxisSenior Software Developer, C++ Calgary, AB 路 9 hours ago 路 6 people clicked apply 路 Full-time About the job Build things';
  const pageTitle = 'Senior Software Developer, C++ | Kinaxis | LinkedIn';

  const parsed = parseHeaderFromMainText(mainText, pageTitle);

  assert.equal(parsed.title, 'Senior Software Developer, C++');
  assert.equal(parsed.company, 'Kinaxis');
  assert.equal(parsed.location, 'Calgary, AB');
  assert.equal(parsed.postedTime, '9 hours ago');
  assert.equal(parsed.applicantInfo, '6 people clicked apply');
  assert.equal(parsed.employmentType, 'Full-time');
});

test('parseCompanySizeFromMainText prefers full employee counts instead of trailing digits', () => {
  assert.equal(parseCompanySizeFromMainText('global organization with over 2,000 employees around the world'), '2000+');
  assert.equal(parseCompanySizeFromMainText('Software Development · 51-200 employees · 110 on LinkedIn'), '51-200');
  assert.equal(parseCompanySizeFromMainText('A company with 1001+employees in North America'), '1001+');
});

test('sanitizeDescription trims LinkedIn noise markers', () => {
  assert.equal(sanitizeDescription('We鈥檙e hiring鈥?more Show less'), "We're hiring");
});
