import { readFile } from 'node:fs/promises';

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9+.#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findBucket(value, buckets) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

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

  const normalized = String(value).trim().toLowerCase();
  if (companySizeBands[normalized]) {
    return normalized;
  }

  if (normalized === '5000+' || normalized === '5001+' || normalized === '5000 plus') {
    return '5000+';
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


function normalizeAnnualSalaryRange(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || !/(\/\s*yr|\/\s*year|per year|annually|a year)/i.test(normalized)) {
    return null;
  }

  const rangeMatch = normalized.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?\s*-\s*\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?/i);
  if (rangeMatch) {
    const low = rangeMatch[2] ? Number(rangeMatch[1].replace(/,/g, '')) * 1000 : Number(rangeMatch[1].replace(/,/g, ''));
    const high = rangeMatch[4] ? Number(rangeMatch[3].replace(/,/g, '')) * 1000 : Number(rangeMatch[3].replace(/,/g, ''));
    return Number.isFinite(low) && Number.isFinite(high) ? { min: Math.round(low), max: Math.round(high) } : null;
  }

  const singleMatch = normalized.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?/i);
  if (!singleMatch) {
    return null;
  }

  const valueNumber = singleMatch[2] ? Number(singleMatch[1].replace(/,/g, '')) * 1000 : Number(singleMatch[1].replace(/,/g, ''));
  return Number.isFinite(valueNumber) ? { min: Math.round(valueNumber), max: Math.round(valueNumber) } : null;
}

export async function loadNormalizationConfig(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

export function normalizeJob(job, normalization) {
  return {
    locationBucket: findBucket(job.location, normalization.locationBuckets),
    employmentTypeBucket: findBucket(job.employmentType, normalization.employmentTypes),
    visaBucket: findBucket(`${job.visaPolicy ?? ''} ${job.description ?? ''}`, normalization.visaPolicies),
    companySizeBucket: normalizeCompanySize(job.companySize, normalization.companySizeBands),
    salaryRange: normalizeAnnualSalaryRange(job.salary),
    normalizedTitle: normalizeText(job.title),
    normalizedDescription: normalizeText(job.description),
    normalizedCompany: normalizeText(job.company),
  };
}
