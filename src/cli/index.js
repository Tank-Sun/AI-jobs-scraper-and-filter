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
import { resolveScoreInput } from './reportRuns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_REPORT_LIMIT = 50;

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

function parsePositiveInteger(value, label, fallback) {
  if (value == null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parseScrapeLimit(value) {
  return parsePositiveInteger(value, 'scrape limit', Number.POSITIVE_INFINITY);
}

function parseShortlistLimit(value) {
  return parsePositiveInteger(value, 'shortlist limit', DEFAULT_REPORT_LIMIT);
}

async function ensureDirectories() {
  await mkdir(path.join(projectRoot, 'reports'), { recursive: true });
  await mkdir(path.join(projectRoot, 'data'), { recursive: true });
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
}

async function scrapeJobsToRunDirectory({ args, source, cdpUrl, mode }) {
  const scrapeLimit = parseScrapeLimit(args.scrapeLimit);
  const runContext = await ensureRunDirectory(projectRoot, args.runDir);
  const rawJobsPath = path.join(runContext.runDir, 'raw-jobs.json');
  const jobs = await collectJobs({
    rawJobsPath,
    limit: scrapeLimit,
    cdpUrl,
    source,
  });

  const summary = {
    mode,
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

  return {
    rawJobsPath,
    runDir: runContext.runDir,
    generatedAt: runContext.generatedAt,
    summary,
  };
}

async function runScrapePhase({ args, source, cdpUrl }) {
  const scrapeResult = await scrapeJobsToRunDirectory({
    args,
    source,
    cdpUrl,
    mode: 'scrape',
  });

  printSummary({
    ...scrapeResult.summary,
    rawJobsPath: scrapeResult.rawJobsPath,
    reportDir: scrapeResult.runDir,
    generatedAt: scrapeResult.generatedAt,
  });
}

async function runScorePhase({ args, requirements, resume, normalization, env }) {
  const scoreInput = await resolveScoreInput({
    projectRoot,
    input: args.input,
    runDir: args.runDir,
  });
  const rawJobsPath = scoreInput.rawJobsPath;
  const runDir = scoreInput.runDir;
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

  const shortlistLimit = parseShortlistLimit(args.limit);
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

  printSummary({
    ...summary,
    reportDir: reportResult.runDir,
    generatedAt: reportResult.generatedAt,
  });
}

async function loadScoringInputs(args) {
  const requirementsPath = path.resolve(projectRoot, args.requirements ?? 'data/requirements.md');
  const resumePath = path.resolve(projectRoot, args.resume ?? 'data/resume.md');

  const [normalization, requirements, resume] = await Promise.all([
    loadNormalizationConfig(path.join(projectRoot, 'config', 'normalization.json')),
    parseRequirementsFile(requirementsPath),
    parseResumeFile(resumePath),
  ]);

  return {
    normalization,
    requirements,
    resume,
  };
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

  const { normalization, requirements, resume } = await loadScoringInputs(args);

  if (mode === 'score') {
    await runScorePhase({ args, requirements, resume, normalization, env: process.env });
    return;
  }

  const scrapeResult = await scrapeJobsToRunDirectory({
    args,
    source,
    cdpUrl,
    mode: 'run',
  });

  await runScorePhase({
    args: {
      ...args,
      input: path.relative(projectRoot, scrapeResult.rawJobsPath),
      runDir: path.relative(projectRoot, scrapeResult.runDir),
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
