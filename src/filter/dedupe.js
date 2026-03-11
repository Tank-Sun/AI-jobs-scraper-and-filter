import { normalizeJob } from './normalize.js';

function normalizeLocationKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePostedTimeRank(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text) {
    return Number.POSITIVE_INFINITY;
  }

  if (text.includes('today') || text.includes('just now')) {
    return 0;
  }

  const match = text.match(/(\d+)\s+(minute|hour|day|week|month|year)/i);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors = {
    minute: 1 / 60,
    hour: 1,
    day: 24,
    week: 24 * 7,
    month: 24 * 30,
    year: 24 * 365,
  };

  return amount * (factors[unit] ?? Number.POSITIVE_INFINITY);
}

function completenessScore(job) {
  let score = 0;
  if (job.location) score += 1;
  if (job.postedTime) score += 1;
  if (job.applicantInfo) score += 1;
  if (job.companySize) score += 1;
  if (job.description) score += 3;
  return score;
}

function pickPreferredJob(current, candidate) {
  const currentCompleteness = completenessScore(current);
  const candidateCompleteness = completenessScore(candidate);
  if (candidateCompleteness !== currentCompleteness) {
    return candidateCompleteness > currentCompleteness ? candidate : current;
  }

  const currentPostedRank = parsePostedTimeRank(current.postedTime);
  const candidatePostedRank = parsePostedTimeRank(candidate.postedTime);
  if (candidatePostedRank !== currentPostedRank) {
    return candidatePostedRank < currentPostedRank ? candidate : current;
  }

  return (candidate.description ?? '').length > (current.description ?? '').length ? candidate : current;
}

function buildDedupeKey(job, normalization) {
  const normalized = normalizeJob(job, normalization);
  const companyKey = normalized.normalizedCompany || 'unknown-company';
  const titleKey = normalized.normalizedTitle || 'unknown-title';
  const locationKey = normalizeLocationKey(job.location) || normalized.locationBucket || 'unknown-location';

  return [companyKey, titleKey, locationKey].join('::');
}

export function dedupeJobs(jobs, normalization) {
  const uniqueJobs = [];
  const duplicateGroups = [];
  const seen = new Map();

  for (const job of jobs) {
    const dedupeKey = buildDedupeKey(job, normalization);
    const existingIndex = seen.get(dedupeKey);

    if (existingIndex == null) {
      seen.set(dedupeKey, uniqueJobs.length);
      uniqueJobs.push({ ...job, duplicateJobUrls: [job.jobUrl].filter(Boolean), duplicateCount: 1 });
      continue;
    }

    const current = uniqueJobs[existingIndex];
    const preferred = pickPreferredJob(current, job);
    const mergedUrls = [...new Set([...(current.duplicateJobUrls ?? [current.jobUrl]), job.jobUrl].filter(Boolean))];
    const mergedJob = {
      ...(preferred === job ? job : current),
      duplicateJobUrls: mergedUrls,
      duplicateCount: (current.duplicateCount ?? 1) + 1,
    };

    uniqueJobs[existingIndex] = mergedJob;
    duplicateGroups.push({
      dedupeKey,
      keptJobUrl: mergedJob.jobUrl,
      duplicateJobUrl: job.jobUrl,
      company: job.company,
      title: job.title,
      location: job.location,
    });
  }

  return {
    uniqueJobs,
    duplicateGroups,
    duplicatesRemoved: jobs.length - uniqueJobs.length,
  };
}
