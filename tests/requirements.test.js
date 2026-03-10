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
    `must_have_locations:\n  - remote-us\n\nmust_have_company_size:\n  - 51-200\n\nmust_have_employment_types:\n  - full-time\n\nvisa_policy:\n  - tn-eligible\n\ntarget_titles:\n  - software engineer\n\nacceptable_titles:\n  - senior software engineer\n\nexperience_level:\n  - senior\n\nmust_have_skills:\n  - typescript\n\nnice_to_have_skills:\n  - playwright\n\nindustry_preferences:\n  - ai\n\nnegative_skills:\n  - java\n\nred_flags:\n  - unpaid\n\nweights:\n  skills: 40\n  responsibilities: 15\n  company_quality: 15\n  title: 10\n  seniority: 10\n  growth: 5\n  risk: 5\n`,
    'utf8'
  );

  const parsed = await parseRequirementsFile(target);
  assert.deepEqual(parsed.must_have_locations, ['remote-us']);
  assert.deepEqual(parsed.visa_policy, ['tn-eligible']);
  assert.equal(parsed.weights.company_quality, 15);
  assert.deepEqual(parsed.all_titles, ['software engineer', 'senior software engineer']);
});
