import { writeFile } from 'node:fs/promises';
import path from 'node:path';

function escapeCsv(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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
    job.breakdown.growth,
    job.breakdown.title,
    job.breakdown.seniority,
    job.breakdown.risk,
    job.whyRecommended,
    job.jobUrl,
  ]);

  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function toShortlistMarkdown(shortlist) {
  return shortlist
    .map((job, index) => {
      const reasons = [
        `Total: ${job.totalScore}`,
        `Skills: ${job.breakdown.skills}`,
        `Responsibilities: ${job.breakdown.responsibilities}`,
        `Growth: ${job.breakdown.growth}`,
        `Title: ${job.breakdown.title}`,
        `Seniority: ${job.breakdown.seniority}`,
        `Risk: ${job.breakdown.risk}`,
      ].join(' | ');
      return `## ${index + 1}. ${job.title} @ ${job.company}\n\n- Location: ${job.location}\n- Scores: ${reasons}\n- Why: ${job.whyRecommended}\n- Gaps: ${(job.gaps ?? []).join(', ') || 'None'}\n- URL: ${job.jobUrl}\n`;
    })
    .join('\n');
}

function toRejectedMarkdown(rejected) {
  return rejected
    .map((job) => `## ${job.title} @ ${job.company}\n\n- URL: ${job.jobUrl}\n- Reasons: ${job.reasons.map((reason) => `${reason.field}: ${reason.message}`).join('; ')}\n`)
    .join('\n');
}

function toNeedsReviewMarkdown(needsReview, scoringFailures) {
  const flagged = needsReview.map((job) => `## ${job.title} @ ${job.company}\n\n- URL: ${job.jobUrl}\n- Review flags: ${job.reviewFlags.join(', ')}\n`);
  const failures = scoringFailures.map((job) => `## ${job.title} @ ${job.company}\n\n- URL: ${job.jobUrl}\n- Scoring failure: ${job.message}\n`);
  return [...flagged, ...failures].join('\n');
}

export async function writeReports({ projectRoot, shortlist, rejected, needsReview, scoringFailures }) {
  const reportsDir = path.join(projectRoot, 'reports');
  await writeFile(path.join(reportsDir, 'shortlist.csv'), toCsvRows(shortlist), 'utf8');
  await writeFile(path.join(reportsDir, 'shortlist.md'), toShortlistMarkdown(shortlist), 'utf8');
  await writeFile(path.join(reportsDir, 'rejected.md'), toRejectedMarkdown(rejected), 'utf8');
  await writeFile(path.join(reportsDir, 'needs-review.md'), toNeedsReviewMarkdown(needsReview, scoringFailures), 'utf8');
}
