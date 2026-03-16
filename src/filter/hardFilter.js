import { normalizeJob } from './normalize.js';

/*
 * Legacy deterministic filtering helpers.
 *
 * The active scoring pipeline is AI-first / AI-only for business screening and does
 * not call applyHardFilters() during normal score runs. We keep this module as a
 * backup/reference path for experiments, regression checks, or a future fallback mode.
 */

function includesAny(text, targets) {
  return targets.some((target) => text.includes(target));
}

function pushReason(reasons, field, message) {
  reasons.push({ field, message });
}

function matchesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function matchingTerms(text, terms) {
  return terms.filter((term) => text.includes(term));
}


function extractExperienceRequirement(job) {
  const text = [job.normalized?.normalizedTitle, job.normalized?.normalizedDescription, job.title, job.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const patterns = [
    { pattern: /(?:minimum|min\.?|at least)\s+(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/g, getRange: (match) => [Number(match[1]), null] },
    { pattern: /(\d{1,2})\+\s*(?:years?|yrs?)\s+(?:of\s+)?experience/g, getRange: (match) => [Number(match[1]), null] },
    { pattern: /(\d{1,2})\s*\+\s*years/g, getRange: (match) => [Number(match[1]), null] },
    { pattern: /(\d{1,2})\s*-\s*(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?experience/g, getRange: (match) => [Number(match[1]), Number(match[2])] },
    { pattern: /(?:requires|required|requirement)\s+(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/g, getRange: (match) => [Number(match[1]), null] },
    { pattern: /(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?experience/g, getRange: (match) => [Number(match[1]), Number(match[1])] },
  ];

  let minimum = null;
  let maximum = null;
  for (const { pattern, getRange } of patterns) {
    for (const match of text.matchAll(pattern)) {
      const [rangeMinimum, rangeMaximum] = getRange(match);
      if (!Number.isFinite(rangeMinimum)) {
        continue;
      }
      minimum = minimum == null ? rangeMinimum : Math.min(minimum, rangeMinimum);
      if (Number.isFinite(rangeMaximum)) {
        maximum = maximum == null ? rangeMaximum : Math.max(maximum, rangeMaximum);
      }
    }
  }

  return { minimum, maximum };
}
function getCompanySizeRange(bucket, normalization) {
  return normalization.companySizeBands?.[bucket] ?? null;
}

function hasAiRelatedOverride(job) {
  const text = [
    job.title,
    job.company,
    job.description,
    job.normalized?.normalizedTitle,
    job.normalized?.normalizedDescription,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const aiTerms = [
    ' ai ',
    'ai-powered',
    'ai powered',
    'artificial intelligence',
    'generative ai',
    'genai',
    'llm',
    'machine learning',
    'copilot',
    'assistant',
  ];

  return aiTerms.some((term) => text.includes(term.trim()) || text.includes(term));
}

function splitCompanySizeDecision(job, requirements, normalization) {
  const bucket = job.normalized.companySizeBucket;
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

  if (hasAiRelatedOverride(job)) {
    return { accepted: true, signal: 'ai_company_size_override' };
  }

  return { accepted: false, signal: null };
}

// Legacy backup mode: not used by the default score pipeline.
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

    const companySizeDecision = splitCompanySizeDecision({ ...job, normalized }, requirements, normalization);
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

    const matchedRedFlags = matchingTerms(normalized.normalizedDescription, requirements.red_flags);
    if (matchedRedFlags.length > 0) {
      pushReason(reasons, 'redFlags', `Matched red flags: ${matchedRedFlags.join(', ')}`);
    }

    const experienceRequirement = extractExperienceRequirement({ ...job, normalized });
    if (experienceRequirement.minimum != null && experienceRequirement.minimum > 5) {
      pushReason(reasons, 'experience', `Role explicitly requires ${experienceRequirement.minimum}+ years of experience`);
    }

    const explicitlyTooJunior = matchesAny(normalized.normalizedTitle, ['intern', 'internship', 'junior', 'new grad', 'new graduate', 'entry level', 'entry-level']);
    const juniorWithinTargetRange =
      explicitlyTooJunior &&
      experienceRequirement.minimum != null &&
      experienceRequirement.minimum >= 1 &&
      experienceRequirement.maximum != null &&
      experienceRequirement.maximum <= 3;
    if (explicitlyTooJunior && !juniorWithinTargetRange) {
      pushReason(reasons, 'seniority', 'Title indicates an entry-level role');
    }
    const explicitlyTooSenior = matchesAny(normalized.normalizedTitle, ['staff', 'principal', 'distinguished']);
    if (explicitlyTooSenior) {
      pushReason(reasons, 'seniority', 'Title indicates a role above the target experience range');
    }

    const explicitlyWrongDiscipline = matchesAny(normalized.normalizedTitle, [
      'data scientist',
      'research scientist',
      'applied scientist',
      'ml engineer',
      'machine learning engineer',
    ]);
    if (explicitlyWrongDiscipline) {
      pushReason(reasons, 'title', 'Title indicates a data science or ML modeling role outside the target scope');
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


