import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../parser/env.js';
import { loadNormalizationConfig } from '../filter/normalize.js';
import { parseRequirementsFile } from '../parser/requirements.js';
import { parseResumeFile } from '../parser/resume.js';
import { collectJobs } from '../scraper/linkedin.js';
import { dedupeJobs } from '../filter/dedupe.js';
import { applyHardFilters } from '../filter/hardFilter.js';
import { scoreJobs } from '../scoring/softScore.js';
import { ensureRunDirectory, readJsonFile, writeRawJobsSnapshot, writeReports } from '../output/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--')) {
      continue;
    }
    const [key, value = 'true'] = entry.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function parseScrapeLimit(value) {
  if (value == null) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid scrape limit: ${value}`);
  }

  return parsed;
}

async function ensureDirectories() {
  await mkdir(path.join(projectRoot, 'reports'), { recursive: true });
  await mkdir(path.join(projectRoot, 'data'), { recursive: true });
}

function resolveRawJobsPath(args, runDir) {
  if (args.input) {
    return path.resolve(projectRoot, args.input);
  }
  if (runDir) {
    return path.join(runDir, 'raw-jobs.json');
  }
  return path.resolve(projectRoot, 'reports/raw-jobs.json');
}

async function runScrapePhase({ args, source, cdpUrl }) {
  const scrapeLimit = parseScrapeLimit(args.scrapeLimit);
  const runContext = await ensureRunDirectory(projectRoot, args.runDir);
  const jobs = await collectJobs({
    rawJobsPath: path.join(runContext.runDir, 'raw-jobs.json'),
    limit: scrapeLimit,
    cdpUrl,
    source,
  });

  const summary = {
    mode: 'scrape',
    jobsSeen: jobs.length,
    source,
    usedCdpUrl: Boolean(cdpUrl),
  };

  await writeRawJobsSnapshot({
    runDir: runContext.runDir,
    rawJobs: jobs,
    summary,
    generatedAt: runContext.generatedAt,
  });

  console.log(JSON.stringify({
    ...summary,
    rawJobsPath: path.join(runContext.runDir, 'raw-jobs.json'),
    reportDir: runContext.runDir,
    generatedAt: runContext.generatedAt,
  }, null, 2));
}

async function runScorePhase({ args, requirements, resume, normalization, env }) {
  const requestedRunDir = args.runDir ? path.resolve(projectRoot, args.runDir) : null;
  const rawJobsPath = resolveRawJobsPath(args, requestedRunDir);
  const runDir = requestedRunDir ?? path.dirname(rawJobsPath);
  const generatedAt = new Date().toISOString();
  const jobs = await readJsonFile(rawJobsPath);
  const dedupeResult = dedupeJobs(jobs, normalization);
  const filteringResult = applyHardFilters(dedupeResult.uniqueJobs, requirements, normalization);
  const scoringResult = await scoreJobs({
    jobs: filteringResult.accepted,
    requirements,
    resume,
    env,
    cachePath: path.join(runDir, 'scoring-cache.json'),
  });

  const shortlistLimit = Number(args.limit ?? 50);
  const shortlist = [...scoringResult.scored]
    .sort((left, right) => right.totalScore - left.totalScore)
    .slice(0, shortlistLimit);
  const allRejected = [...filteringResult.rejected, ...scoringResult.aiRejected];

  const summary = {
    mode: 'score',
    jobsSeen: jobs.length,
    jobsAfterDedupe: dedupeResult.uniqueJobs.length,
    duplicatesRemoved: dedupeResult.duplicatesRemoved,
    deterministicRejected: filteringResult.rejected.length,
    sentToScoring: filteringResult.accepted.length,
    aiRejected: scoringResult.aiRejected.length,
    shortlisted: shortlist.length,
    scoringFailures: scoringResult.failures.length,
    scoringMode: scoringResult.scoringMode,
    resumePath: resume.path,
    cachePath: scoringResult.cachePath,
    rawJobsPath,
  };

  const reportResult = await writeReports({
    runDir,
    generatedAt,
    shortlist,
    rejected: allRejected,
    scoringFailures: scoringResult.failures,
    rawJobs: jobs,
    processedJobs: dedupeResult.uniqueJobs,
    summary,
  });

  console.log(JSON.stringify({
    ...summary,
    reportDir: reportResult.runDir,
    generatedAt: reportResult.generatedAt,
  }, null, 2));
}

async function main() {
  await ensureDirectories();
  loadEnv(projectRoot);

  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? 'run';
  const source = args.source ?? 'auto';
  const cdpUrl = args.cdpUrl ?? process.env.PLAYWRIGHT_CDP_URL;

  if (mode === 'scrape') {
    await runScrapePhase({ args, source, cdpUrl });
    return;
  }

  const requirementsPath = path.resolve(projectRoot, args.requirements ?? 'data/requirements.md');
  const resumePath = path.resolve(projectRoot, args.resume ?? 'data/resume.md');
  const normalization = await loadNormalizationConfig(path.join(projectRoot, 'config', 'normalization.json'));
  const requirements = await parseRequirementsFile(requirementsPath);
  const resume = await parseResumeFile(resumePath);

  if (mode === 'score') {
    await runScorePhase({ args, requirements, resume, normalization, env: process.env });
    return;
  }

  const runContext = await ensureRunDirectory(projectRoot, args.runDir);
  const scrapeLimit = parseScrapeLimit(args.scrapeLimit);
  const jobs = await collectJobs({
    rawJobsPath: path.join(runContext.runDir, 'raw-jobs.json'),
    limit: scrapeLimit,
    cdpUrl,
    source,
  });

  await writeRawJobsSnapshot({
    runDir: runContext.runDir,
    rawJobs: jobs,
    summary: {
      mode: 'run',
      jobsSeen: jobs.length,
      source,
      usedCdpUrl: Boolean(cdpUrl),
    },
    generatedAt: runContext.generatedAt,
  });

  await runScorePhase({
    args: {
      ...args,
      input: path.relative(projectRoot, path.join(runContext.runDir, 'raw-jobs.json')),
      runDir: path.relative(projectRoot, runContext.runDir),
    },
    requirements,
    resume,
    normalization,
    env: process.env,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
