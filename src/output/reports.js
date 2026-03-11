import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function escapeCsv(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatMountainTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const folderName = `${map.year}-${map.month}-${map.day}_${map.hour}-${map.minute}-${map.second}_MT`;
  const label = `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} MT`;
  return { folderName, label };
}

function toCsvRows(shortlist) {
  const headers = [
    'rank',
    'total_score',
    'company',
    'title',
    'location',
    'skills',
    'responsibilities',
    'company_quality',
    'growth',
    'title_score',
    'seniority',
    'risk',
    'why_recommended',
    'job_url',
  ];

  const rows = shortlist.map((job, index) => [
    index + 1,
    job.totalScore,
    job.company,
    job.title,
    job.location,
    job.breakdown.skills,
    job.breakdown.responsibilities,
    job.breakdown.company_quality,
    job.breakdown.growth,
    job.breakdown.title,
    job.breakdown.seniority,
    job.breakdown.risk,
    job.whyRecommended,
    job.jobUrl,
  ]);

  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function toShortlistMarkdown(shortlist, runLabel) {
  const body = shortlist
    .map((job, index) => {
      const reasons = [
        `Total: ${job.totalScore}`,
        `Skills: ${job.breakdown.skills}`,
        `Responsibilities: ${job.breakdown.responsibilities}`,
        `Company Quality: ${job.breakdown.company_quality}`,
        `Growth: ${job.breakdown.growth}`,
        `Title: ${job.breakdown.title}`,
        `Seniority: ${job.breakdown.seniority}`,
        `Risk: ${job.breakdown.risk}`,
      ].join(' | ');
      return `## ${index + 1}. ${job.title} @ ${job.company}\n\n- Location: ${job.location}\n- Scores: ${reasons}\n- Why: ${job.whyRecommended}\n- AI Signals: ${(job.aiSignals ?? []).join(', ') || 'None'}\n- Gaps: ${(job.gaps ?? []).join(', ') || 'None'}\n- URL: ${job.jobUrl}\n`;
    })
    .join('\n');

  return `# Shortlist\n\n- Generated: ${runLabel}\n\n${body}`;
}

function toRejectedMarkdown(rejected, runLabel) {
  const body = rejected
    .map((job) => `## ${job.title} @ ${job.company}\n\n- URL: ${job.jobUrl}\n- Reasons: ${job.reasons.map((reason) => `${reason.field}: ${reason.message}`).join('; ')}\n`)
    .join('\n');

  return `# Rejected\n\n- Generated: ${runLabel}\n\n${body}`;
}

function toScoringFailuresMarkdown(scoringFailures, runLabel) {
  const body = scoringFailures
    .map((job) => `## ${job.title} @ ${job.company}\n\n- URL: ${job.jobUrl}\n- Scoring failure: ${job.message}\n`)
    .join('\n');

  return `# Scoring Failures\n\n- Generated: ${runLabel}\n\n${body}`;
}

export async function writeReports({ projectRoot, shortlist, rejected, scoringFailures, rawJobs, summary }) {
  const reportsDir = path.join(projectRoot, 'reports');
  const timestamp = formatMountainTimestamp();
  const runDir = path.join(reportsDir, timestamp.folderName);
  await mkdir(runDir, { recursive: true });

  await writeFile(path.join(runDir, 'raw-jobs.json'), JSON.stringify(rawJobs, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'shortlist.csv'), toCsvRows(shortlist), 'utf8');
  await writeFile(path.join(runDir, 'shortlist.md'), toShortlistMarkdown(shortlist, timestamp.label), 'utf8');
  await writeFile(path.join(runDir, 'rejected.md'), toRejectedMarkdown(rejected, timestamp.label), 'utf8');
  await writeFile(path.join(runDir, 'scoring-failures.md'), toScoringFailuresMarkdown(scoringFailures, timestamp.label), 'utf8');
  await writeFile(
    path.join(runDir, 'run-summary.json'),
    JSON.stringify({
      ...summary,
      generatedAt: timestamp.label,
      reportDir: runDir,
    }, null, 2),
    'utf8'
  );

  return {
    runDir,
    generatedAt: timestamp.label,
  };
}
