import { readFile } from 'node:fs/promises';

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9+.#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findBucket(value, buckets) {
  const normalized = normalizeText(value);
  for (const [bucket, variants] of Object.entries(buckets)) {
    if (variants.some((variant) => normalized.includes(normalizeText(variant)))) {
      return bucket;
    }
  }
  return null;
}

function normalizeCompanySize(value, companySizeBands) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string' && companySizeBands[value]) {
    return value;
  }

  const numeric = Number(String(value).replace(/[^0-9]/g, ''));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  for (const [bucket, range] of Object.entries(companySizeBands)) {
    if (numeric >= range[0] && numeric <= range[1]) {
      return bucket;
    }
  }
  return null;
}

export async function loadNormalizationConfig(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function normalizeJob(job, normalization) {
  return {
    locationBucket: findBucket(job.location, normalization.locationBuckets),
    employmentTypeBucket: findBucket(job.employmentType, normalization.employmentTypes),
    visaBucket: findBucket(job.visaPolicy ?? job.description, normalization.visaPolicies),
    companySizeBucket: normalizeCompanySize(job.companySize, normalization.companySizeBands),
    normalizedTitle: normalizeText(job.title),
    normalizedDescription: normalizeText(job.description),
  };
}
