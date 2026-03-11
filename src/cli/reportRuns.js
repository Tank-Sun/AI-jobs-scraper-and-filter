import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findLatestRunDirectory(projectRoot) {
  const reportsDir = path.join(projectRoot, 'reports');
  if (!(await pathExists(reportsDir))) {
    return null;
  }

  const entries = await readdir(reportsDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDir = path.join(reportsDir, entry.name);
    const rawJobsPath = path.join(runDir, 'raw-jobs.json');
    if (!(await pathExists(rawJobsPath))) {
      continue;
    }

    const details = await stat(rawJobsPath);
    candidates.push({
      runDir,
      rawJobsPath,
      mtimeMs: details.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.runDir.localeCompare(left.runDir));
  return candidates[0] ?? null;
}

export async function resolveScoreInput({ projectRoot, input, runDir }) {
  if (input) {
    const rawJobsPath = path.resolve(projectRoot, input);
    return {
      rawJobsPath,
      runDir: path.dirname(rawJobsPath),
      source: 'input',
    };
  }

  if (runDir) {
    const absoluteRunDir = path.resolve(projectRoot, runDir);
    return {
      rawJobsPath: path.join(absoluteRunDir, 'raw-jobs.json'),
      runDir: absoluteRunDir,
      source: 'runDir',
    };
  }

  const latestRun = await findLatestRunDirectory(projectRoot);
  if (latestRun) {
    return {
      rawJobsPath: latestRun.rawJobsPath,
      runDir: latestRun.runDir,
      source: 'latest',
    };
  }

  const fallbackPath = path.resolve(projectRoot, 'reports/raw-jobs.json');
  return {
    rawJobsPath: fallbackPath,
    runDir: path.dirname(fallbackPath),
    source: 'fallback',
  };
}
