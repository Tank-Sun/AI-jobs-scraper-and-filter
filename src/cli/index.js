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
import { writeReports } from '../output/reports.js';

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

async function ensureDirectories() {
  await mkdir(path.join(projectRoot, 'reports'), { recursive: true });
  await mkdir(path.join(projectRoot, 'data'), { recursive: true });
}

async function main() {
  await ensureDirectories();
  loadEnv(projectRoot);

  const args = parseArgs(process.argv.slice(2));
  const requirementsPath = path.resolve(projectRoot, args.requirements ?? 'data/requirements.md');
  const resumePath = path.resolve(projectRoot, args.resume ?? 'data/resume.md');
  const rawJobsPath = path.resolve(projectRoot, args.input ?? 'reports/raw-jobs.json');
  const limit = Number(args.limit ?? 50);
  const source = args.source ?? 'auto';
  const cdpUrl = args.cdpUrl ?? process.env.PLAYWRIGHT_CDP_URL;

  const normalization = await loadNormalizationConfig(path.join(projectRoot, 'config', 'normalization.json'));
  const requirements = await parseRequirementsFile(requirementsPath);
  const resume = await parseResumeFile(resumePath);
  const jobs = await collectJobs({
    rawJobsPath,
    limit: Number(args.scrapeLimit ?? 200),
    cdpUrl,
    source,
  });
  const dedupeResult = dedupeJobs(jobs, normalization);

  const filteringResult = applyHardFilters(dedupeResult.uniqueJobs, requirements, normalization);
  const scoringResult = await scoreJobs({
    jobs: filteringResult.accepted,
    requirements,
    resume,
    env: process.env,
  });

  const shortlist = [...scoringResult.scored]
    .sort((left, right) => right.totalScore - left.totalScore)
    .slice(0, limit);

  const allRejected = [...filteringResult.rejected, ...scoringResult.aiRejected];

  const summary = {
    jobsSeen: jobs.length,
    jobsAfterDedupe: dedupeResult.uniqueJobs.length,
    duplicatesRemoved: dedupeResult.duplicatesRemoved,
    deterministicRejected: filteringResult.rejected.length,
    sentToScoring: filteringResult.accepted.length,
    aiRejected: scoringResult.aiRejected.length,
    shortlisted: shortlist.length,
    scoringFailures: scoringResult.failures.length,
    source,
    usedCdpUrl: Boolean(cdpUrl),
    scoringMode: scoringResult.scoringMode,
    resumePath: resume.path,
  };

  const reportResult = await writeReports({
    projectRoot,
    shortlist,
    rejected: allRejected,
    scoringFailures: scoringResult.failures,
    rawJobs: dedupeResult.uniqueJobs,
    summary,
  });

  console.log(JSON.stringify({
    ...summary,
    reportDir: reportResult.runDir,
    generatedAt: reportResult.generatedAt,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
