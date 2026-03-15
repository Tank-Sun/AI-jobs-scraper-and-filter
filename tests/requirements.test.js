import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseRequirementsFile } from '../src/parser/requirements.js';

test('parseRequirementsFile reads the richer requirements schema', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-req-'));
  const target = path.join(tempDir, 'requirements.md');

  await writeFile(
    target,
    `must_have_locations:
  - remote-us

must_have_company_size:
  - 51-200

must_have_employment_types:
  - full-time

visa_policy:
  - tn-eligible

target_titles:
  - software engineer

acceptable_titles:
  - senior software engineer

experience_level:
  - senior

must_have_skills:
  - typescript

nice_to_have_skills:
  - playwright

industry_preferences:
  - ai

negative_skills:
  - java

red_flags:
  - unpaid

weights:
  skills: 40
  responsibilities: 20
  company_quality: 10
  title: 10
  seniority: 10
  growth: 5
  risk: 5
`,
    'utf8'
  );

  const parsed = await parseRequirementsFile(target);
  assert.deepEqual(parsed.must_have_locations, ['remote-us']);
  assert.deepEqual(parsed.visa_policy, ['tn-eligible']);  assert.equal(parsed.weights.company_quality, 10);
  assert.equal(parsed.weights.responsibilities, 20);
  assert.deepEqual(parsed.all_titles, ['software engineer', 'senior software engineer']);
});
