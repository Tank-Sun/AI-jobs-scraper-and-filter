import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findLatestRunDirectory, resolveScoreInput } from '../src/cli/reportRuns.js';

async function makeProjectRoot() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-runs-'));
  const projectRoot = path.join(tempRoot, 'project');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, 'reports'), { recursive: true });
  return projectRoot;
}

test('findLatestRunDirectory returns the most recent run with raw-jobs.json', async () => {
  const projectRoot = await makeProjectRoot();
  const olderRunDir = path.join(projectRoot, 'reports', '2026-03-11_09-00-00_MT');
  const newerRunDir = path.join(projectRoot, 'reports', '2026-03-11_10-00-00_MT');
  await mkdir(olderRunDir, { recursive: true });
  await mkdir(newerRunDir, { recursive: true });

  const olderRawJobs = path.join(olderRunDir, 'raw-jobs.json');
  const newerRawJobs = path.join(newerRunDir, 'raw-jobs.json');
  await writeFile(olderRawJobs, '[]', 'utf8');
  await writeFile(newerRawJobs, '[]', 'utf8');
  await utimes(olderRawJobs, new Date('2026-03-11T16:00:00.000Z'), new Date('2026-03-11T16:00:00.000Z'));
  await utimes(newerRawJobs, new Date('2026-03-11T17:00:00.000Z'), new Date('2026-03-11T17:00:00.000Z'));

  const latest = await findLatestRunDirectory(projectRoot);

  assert.ok(latest);
  assert.equal(latest.runDir, newerRunDir);
  assert.equal(latest.rawJobsPath, newerRawJobs);
});

test('resolveScoreInput prefers explicit input and runDir before auto-latest lookup', async () => {
  const projectRoot = await makeProjectRoot();
  const explicitInput = 'reports/custom/raw-jobs.json';
  const explicitRunDir = 'reports/manual-run';

  const fromInput = await resolveScoreInput({
    projectRoot,
    input: explicitInput,
    runDir: explicitRunDir,
  });
  assert.equal(fromInput.source, 'input');
  assert.equal(fromInput.rawJobsPath, path.join(projectRoot, explicitInput));

  const fromRunDir = await resolveScoreInput({
    projectRoot,
    input: null,
    runDir: explicitRunDir,
  });
  assert.equal(fromRunDir.source, 'runDir');
  assert.equal(fromRunDir.rawJobsPath, path.join(projectRoot, explicitRunDir, 'raw-jobs.json'));
});

test('resolveScoreInput falls back to the latest run and then reports/raw-jobs.json when needed', async () => {
  const projectRoot = await makeProjectRoot();
  const latestRunDir = path.join(projectRoot, 'reports', '2026-03-11_11-22-33_MT');
  await mkdir(latestRunDir, { recursive: true });
  const latestRawJobs = path.join(latestRunDir, 'raw-jobs.json');
  await writeFile(latestRawJobs, '[]', 'utf8');

  const latest = await resolveScoreInput({ projectRoot, input: null, runDir: null });
  assert.equal(latest.source, 'latest');
  assert.equal(latest.rawJobsPath, latestRawJobs);

  const emptyProjectRoot = await mkdtemp(path.join(os.tmpdir(), 'jobs-filter-empty-'));
  const fallback = await resolveScoreInput({ projectRoot: emptyProjectRoot, input: null, runDir: null });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.rawJobsPath, path.join(emptyProjectRoot, 'reports', 'raw-jobs.json'));
});
