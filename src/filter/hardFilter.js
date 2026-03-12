import { normalizeJob } from './normalize.js';

function includesAny(text, targets) {
  return targets.some((target) => text.includes(target));
}

function pushReason(reasons, field, message) {
  reasons.push({ field, message });
}

function matchesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function getCompanySizeRange(bucket, normalization) {
  return normalization.companySizeBands?.[bucket] ?? null;
}

function splitCompanySizeDecision(bucket, requirements, normalization) {
  if (!bucket) {
    return { accepted: true, signal: 'missing_company_size_bucket' };
  }

  if (requirements.must_have_company_size.includes(bucket)) {
    return { accepted: true, signal: null };
  }

  const candidateRange = getCompanySizeRange(bucket, normalization);
  const preferredRanges = requirements.must_have_company_size
    .map((preferredBucket) => getCompanySizeRange(preferredBucket, normalization))
    .filter(Boolean);

  if (!candidateRange || preferredRanges.length === 0) {
    return { accepted: false, signal: null };
  }

  const preferredUpperBound = Math.max(...preferredRanges.map((range) => range[1]));
  if (candidateRange[1] > preferredUpperBound) {
    return { accepted: true, signal: 'company_size_outside_preferred_range' };
  }

  return { accepted: false, signal: null };
}

export function applyHardFilters(jobs, requirements, normalization) {
  const accepted = [];
  const rejected = [];

  for (const job of jobs) {
    const normalized = normalizeJob(job, normalization);
    const reasons = [];
    const aiSignals = [];

    if (!normalized.locationBucket) {
      aiSignals.push('missing_location_bucket');
    } else if (!requirements.must_have_locations.includes(normalized.locationBucket)) {
      pushReason(reasons, 'location', `Location bucket ${normalized.locationBucket} is not allowed`);
    }

    const companySizeDecision = splitCompanySizeDecision(normalized.companySizeBucket, requirements, normalization);
    if (companySizeDecision.signal) {
      aiSignals.push(companySizeDecision.signal);
    }
    if (!companySizeDecision.accepted) {
      pushReason(reasons, 'companySize', `Company size ${normalized.companySizeBucket} is not allowed`);
    }

    if (!normalized.employmentTypeBucket) {
      aiSignals.push('missing_employment_type_bucket');
    } else if (!requirements.must_have_employment_types.includes(normalized.employmentTypeBucket)) {
      pushReason(reasons, 'employmentType', `Employment type ${normalized.employmentTypeBucket} is not allowed`);
    }

    if (!normalized.visaBucket) {
      aiSignals.push('missing_visa_bucket');
    } else if (!requirements.visa_policy.includes(normalized.visaBucket)) {
      pushReason(reasons, 'visaPolicy', `Visa policy ${normalized.visaBucket} is not allowed`);
    }

    if (includesAny(normalized.normalizedDescription, requirements.red_flags)) {
      pushReason(reasons, 'redFlags', 'Description matched a red flag');
    }


    if (
      Number.isFinite(requirements.min_salary_annual) &&
      normalized.salaryRange &&
      Number.isFinite(normalized.salaryRange.max) &&
      normalized.salaryRange.max < requirements.min_salary_annual
    ) {
      pushReason(reasons, 'salary', `Annual salary ceiling ${normalized.salaryRange.max} is below minimum ${requirements.min_salary_annual}`);
    }

    const explicitlyTooJunior = matchesAny(normalized.normalizedTitle, ['intern', 'internship', 'junior', 'new grad', 'new graduate', 'entry level', 'entry-level']);
    if (explicitlyTooJunior) {
      pushReason(reasons, 'seniority', 'Title indicates an entry-level role');
    }

    const explicitlyTooSenior = matchesAny(normalized.normalizedTitle, ['staff', 'principal', 'distinguished']);
    if (explicitlyTooSenior) {
      pushReason(reasons, 'seniority', 'Title indicates a role above the target experience range');
    }

    if (requirements.all_titles.length > 0 && !includesAny(normalized.normalizedTitle, requirements.all_titles)) {
      aiSignals.push('title_not_in_preferred_lists');
    }

    const mustHaveSkillMatches = requirements.must_have_skills.filter((skill) =>
      normalized.normalizedDescription.includes(skill) || normalized.normalizedTitle.includes(skill)
    );
    if (mustHaveSkillMatches.length < requirements.must_have_skills.length) {
      aiSignals.push('must_have_skills_not_fully_confirmed');
    }

    const negativeSkillMatches = requirements.negative_skills.filter((skill) =>
      normalized.normalizedDescription.includes(skill)
    );
    if (negativeSkillMatches.length > 0) {
      aiSignals.push('negative_skill_overlap');
    }

    const enrichedJob = {
      ...job,
      normalized,
      aiSignals,
      mustHaveSkillMatches,
      negativeSkillMatches,
    };

    if (reasons.length > 0) {
      rejected.push({ ...enrichedJob, reasons });
      continue;
    }

    accepted.push(enrichedJob);
  }

  return { accepted, rejected };
}
