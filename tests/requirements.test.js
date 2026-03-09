import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseRequirementsFile } from '../src/parser/requirements.js';

test('parseRequirementsFile reads template lists and weights', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-req-'));
  const target = path.join(tempDir, 'requirements.md');

  await writeFile(
    target,
    `must_have_locations:\n- denver-co\n\nmust_have_company_size:\n- 11-50\n\nmust_have_employment_types:\n- full-time\n\nmust_have_visa_policy:\n- sponsorship-available\n\ntarget_titles:\n- backend engineer\n\nnice_to_have_skills:\n- node.js\n\nred_flags:\n- unpaid\n\nweights:\n  skills: 35\n  responsibilities: 20\n  growth: 15\n  title: 10\n  seniority: 10\n  risk: 10\n`,
    'utf8'
  );

  const parsed = await parseRequirementsFile(target);
  assert.deepEqual(parsed.must_have_locations, ['denver-co']);
  assert.equal(parsed.weights.skills, 35);
  assert.equal(parsed.target_titles[0], 'backend engineer');
});
