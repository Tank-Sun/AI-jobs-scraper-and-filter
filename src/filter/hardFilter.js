import { normalizeJob } from './normalize.js';

function includesAny(text, targets) {
  return targets.some((target) => text.includes(target));
}

function pushReason(reasons, field, message) {
  reasons.push({ field, message });
}

export function applyHardFilters(jobs, requirements, normalization) {
  const accepted = [];
  const rejected = [];
  const needsReview = [];

  for (const job of jobs) {
    const normalized = normalizeJob(job, normalization);
    const reasons = [];
    const reviewFlags = [];

    if (!normalized.locationBucket) {
      reviewFlags.push('missing_location_bucket');
    } else if (!requirements.must_have_locations.includes(normalized.locationBucket)) {
      pushReason(reasons, 'location', `Location bucket ${normalized.locationBucket} is not allowed`);
    }

    if (!normalized.companySizeBucket) {
      reviewFlags.push('missing_company_size_bucket');
    } else if (!requirements.must_have_company_size.includes(normalized.companySizeBucket)) {
      pushReason(reasons, 'companySize', `Company size ${normalized.companySizeBucket} is not allowed`);
    }

    if (!normalized.employmentTypeBucket) {
      reviewFlags.push('missing_employment_type_bucket');
    } else if (!requirements.must_have_employment_types.includes(normalized.employmentTypeBucket)) {
      pushReason(reasons, 'employmentType', `Employment type ${normalized.employmentTypeBucket} is not allowed`);
    }

    if (!normalized.visaBucket) {
      reviewFlags.push('missing_visa_bucket');
    } else if (!requirements.must_have_visa_policy.includes(normalized.visaBucket)) {
      pushReason(reasons, 'visaPolicy', `Visa policy ${normalized.visaBucket} is not allowed`);
    }

    if (!includesAny(normalized.normalizedTitle, requirements.target_titles)) {
      pushReason(reasons, 'title', 'Title does not match any target title');
    }

    if (includesAny(normalized.normalizedDescription, requirements.red_flags)) {
      pushReason(reasons, 'redFlags', 'Description matched a red flag');
    }

    const enriched = {
      ...job,
      normalized,
      lowConfidence: reviewFlags.length > 0,
      reviewFlags,
    };

    if (reasons.length > 0) {
      rejected.push({ ...enriched, reasons });
      continue;
    }

    accepted.push(enriched);
    if (reviewFlags.length > 0) {
      needsReview.push(enriched);
    }
  }

  return { accepted, rejected, needsReview };
}
