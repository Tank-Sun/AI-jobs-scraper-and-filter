import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GoogleGenAI, Type } from '@google/genai';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_SCORE_CONCURRENCY = 4;
const SCORING_SIGNATURE_VERSION = '2026-03-14-title-skill-priority-v11';
const AI_HEURISTIC_BLEND_RATIO = 0.4;

const PRODUCT_ENGINEERING_TERMS = [
  'product',
  'product engineering',
  'customer',
  'customer-facing',
  'user-facing',
  'user facing',
  'full stack',
  'full-stack',
  'backend',
  'api',
  'node',
  'node.js',
  'typescript',
  'javascript',
  'react',
  'frontend',
  'front-end',
  'web application',
  'design systems',
  'developer experience',
  'devex',
  'platform engineering',
  'end-to-end',
  'ship features',
  'product and design decisions',
  'ownership',
  'ai-powered',
  'ai powered',
  'copilot',
  'assistant',
];

const FULL_STACK_TERMS = [
  'full stack',
  'full-stack',
  'end-to-end',
  'across the stack',
  'frontend and backend',
  'front-end and back-end',
];

const FITTED_BACKEND_TERMS = [
  'backend',
  'api',
  'node',
  'node.js',
  'typescript',
  'javascript',
  'graphql',
  'full stack',
  'full-stack',
];

const FRONTEND_TERMS = [
  'frontend',
  'front-end',
  'react',
  'next.js',
  'design systems',
  'ui',
  'ux',
  'responsive',
];

const DEVEX_POSITIVE_TERMS = [
  'developer productivity',
  'developer experience',
  'devex',
  'backstage',
  'internal developer portal',
  'developer portal',
  'improve developer workflows',
];

const INTERNAL_TOOLS_NEGATIVE_TERMS = [
  'tools team',
  'internal tools',
  'game tools',
  'tooling for artists',
  'tooling for designers',
  'editor tooling',
];

const AVOID_DIRECTION_TERMS = [
  'java',
  'spring',
  '.net',
  'c#',
  'c++',
  'rust',
  'embedded',
  'sap',
  'netsuite',
  'dynamics',
  'telecom',
  'wireless core',
  'hpc',
  'gpu',
  'operations research',
  'observability',
  'networking',
];

const NATIVE_MOBILE_TERMS = [
  'android',
  'ios',
  'kotlin',
  'swift',
  'jetpack compose',
  'android sdk',
  'objective-c',
  'uikit',
  'xcode',
  'mobile developer',
  'mobile engineer',
  'native mobile',
];

const REACT_NATIVE_TERMS = [
  'react native',
  'expo',
];

const CONSULTING_TERMS = [
  'consulting',
  'consultant',
  'client engagement',
  'professional services',
  'implementation partner',
  'staffing',
  'recruiting agency',
  'bodyshop',
  'contract for client',
];

const EVERGREEN_TERMS = [
  'future opportunities',
  'future opportunity',
  'evergreen',
  'talent pool',
  'pipeline role',
];

const AI_INFRA_TERMS = [
  'ml platform',
  'model serving',
  'distributed systems',
  'data pipeline',
  'streaming',
  'infrastructure',
  'platform team',
  'backend services',
  'networking',
  'observability',
];

const AI_APPLICATION_TERMS = [
  'ai-powered',
  'ai powered',
  'copilot',
  'assistant',
  'agent',
  'agents',
  'ai feature',
  'ai features',
  'user-facing ai',
  'customer-facing ai',
  'generative ai',
  'genai',
  'llm',
];

const AI_MODELING_TERMS = [
  'model training',
  'train models',
  'training infrastructure',
  'distributed training',
  'fine-tuning',
  'fine tuning',
  'research scientist',
  'applied scientist',
  'ml research',
  'deep learning',
  'model evaluation',
  'evaluation pipeline',
  'feature store',
  'inference infrastructure',
];

const BACKEND_PLATFORM_TERMS = [
  'growth platform',
  'integrations services',
  'streaming',
  'backend services',
  'ml platform',
  'platform team',
  'enterprise ai',
  'internal platform',
  'platform developer',
  'enterprise platform',
];

const WRONG_FULL_STACK_TERMS = [
  'java',
  'spring',
  '.net',
  'c#',
  'c++',
  'sap',
  'dynamics',
  'netsuite',
];

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function jobText(job) {
  return `${job.title ?? ''} ${job.company ?? ''} ${job.description ?? ''}`.toLowerCase();
}

function ratioOfTerms(text, terms) {
  if (terms.length === 0) {
    return 0;
  }
  const hits = terms.filter((term) => text.includes(term)).length;
  return hits / terms.length;
}

function hasReactNativeSignal(job) {
  return ratioOfTerms(jobText(job), REACT_NATIVE_TERMS) > 0;
}

function nativeMobileRatio(job) {
  const text = jobText(job);
  const baseRatio = ratioOfTerms(text, NATIVE_MOBILE_TERMS);
  if (hasReactNativeSignal(job)) {
    return Math.max(0, baseRatio - 0.08);
  }
  return baseRatio;
}

function overlapScore(haystack, needles) {
  const text = jobText(haystack);
  const hits = needles.filter((needle) => text.includes(needle)).length;
  return needles.length === 0 ? 0 : hits / needles.length;
}

function skillCoverageScore(job, requirements, resume) {
  const text = jobText(job);
  const niceToHaveRatio = overlapScore(job, requirements.nice_to_have_skills);
  const resumeRatio = resume.skills.length === 0 ? 0 : overlapScore(job, resume.skills.slice(0, 80));
  const mustHaveCoverage = (job.mustHaveSkillMatches?.length ?? 0) / Math.max(requirements.must_have_skills.length, 1);
  const fullStackBoost = fullStackSignal(job) * 18;
  const backendBoost = fittedBackendSignal(job) * 14;
  const frontendBoost = frontendSignal(job) * 6;
  const frontendAiBoost = hasFrontendAiProductSignal(job) ? 12 : 0;
  const pseudoFullStackPenalty = hasWrongFullStackSignal(job) ? 20 : 0;
  const negativePenalty = Math.min((job.negativeSkillMatches?.length ?? 0) * 18, 45);
  const avoidRatioPenalty = ratioOfTerms(text, AVOID_DIRECTION_TERMS) * 25;
  const nativeMobilePenalty = nativeMobileRatio(job) * 55;
  const reactNativePenalty = hasReactNativeSignal(job) ? 8 : 0;
  const missingCorePenalty = mustHaveCoverage === 0 && !hasAiProductSignal(job) ? 22 : 0;
  return clampScore((mustHaveCoverage * 0.55 + niceToHaveRatio * 0.15 + resumeRatio * 0.3) * 100 + fullStackBoost + backendBoost + frontendBoost + frontendAiBoost - negativePenalty - avoidRatioPenalty - nativeMobilePenalty - reactNativePenalty - missingCorePenalty - pseudoFullStackPenalty);
}

function seniorityScore(job, requirements) {
  const normalizedTitle = (job.title ?? '').toLowerCase();
  const explicitlyJunior = ['intern', 'internship', 'junior', 'new grad', 'new graduate', 'entry level', 'entry-level']
    .some((term) => normalizedTitle.includes(term));
  if (explicitlyJunior) {
    return 20;
  }

  const explicitlyTooSenior = ['staff', 'principal', 'distinguished', 'director', 'manager', 'lead architect']
    .some((term) => normalizedTitle.includes(term));
  if (explicitlyTooSenior) {
    return normalizedTitle.includes('staff') || normalizedTitle.includes('principal') ? 35 : 25;
  }

  const midPreferredLevels = ['mid', 'mid-level', 'intermediate', 'software engineer ii'];
  if (midPreferredLevels.some((term) => normalizedTitle.includes(term))) {
    return 90;
  }

  const seniorPreferredLevels = ['senior', 'senior software engineer', 'software engineer iii'];
  if (seniorPreferredLevels.some((term) => normalizedTitle.includes(term))) {
    return 82;
  }

  if (requirements.experience_level.some((level) => normalizedTitle.includes(level.replace('-level', '').trim()))) {
    return 84;
  }

  return 68;
}

function hasGenericAiSignal(job) {
  const text = jobText(job);
  const aiTerms = ['ai product', 'artificial intelligence', 'generative ai', 'genai', 'llm', 'machine learning'];
  return aiTerms.some((term) => text.includes(term)) || /\bai\b/.test(text);
}

function hasAiModelingOrInfraSignal(job) {
  const text = jobText(job);
  return ratioOfTerms(text, AI_INFRA_TERMS) > 0.18 || ratioOfTerms(text, AI_MODELING_TERMS) > 0 || backendPlatformRatio(job) > 0.15;
}

function hasAiProductSignal(job) {
  const text = jobText(job);
  if (!hasGenericAiSignal(job)) {
    return false;
  }

  const explicitApplicationSignal = ratioOfTerms(text, AI_APPLICATION_TERMS) > 0;
  const backendProductSignal = fittedBackendSignal(job) > 0.12 && (
    text.includes('user-facing') ||
    text.includes('customer-facing') ||
    text.includes('product features') ||
    text.includes('workflow') ||
    text.includes('application')
  );
  const productContextSignal =
    hasStrongProductSignal(job) ||
    fullStackSignal(job) > 0.12 ||
    frontendSignal(job) > 0.08 ||
    hasDevexSignal(job) ||
    backendProductSignal;

  if (!explicitApplicationSignal && !productContextSignal) {
    return false;
  }

  if (hasAiModelingOrInfraSignal(job) && !explicitApplicationSignal && !hasStrongProductSignal(job)) {
    return false;
  }

  return true;
}

function hasDevexSignal(job) {
  return ratioOfTerms(jobText(job), DEVEX_POSITIVE_TERMS) > 0;
}

function fullStackSignal(job) {
  return ratioOfTerms(jobText(job), FULL_STACK_TERMS);
}

function fittedBackendSignal(job) {
  const text = jobText(job);
  const base = ratioOfTerms(text, FITTED_BACKEND_TERMS);
  const hasWrongBackend = ['java', 'spring', '.net', 'c#', 'c++', 'kotlin', 'ruby'].some((term) => text.includes(term));
  return hasWrongBackend ? Math.max(0, base - 0.18) : base;
}

function frontendSignal(job) {
  return ratioOfTerms(jobText(job), FRONTEND_TERMS);
}

function hasInternalToolsSignal(job) {
  const text = jobText(job);
  return text.includes('tools') || ratioOfTerms(text, INTERNAL_TOOLS_NEGATIVE_TERMS) > 0;
}

function hasStrongProductSignal(job) {
  const text = jobText(job);
  const productTerms = ['product engineering', 'product and design decisions', 'ship features end-to-end', 'end-to-end', 'user-facing', 'customer-facing', 'product specs'];
  return productTerms.some((term) => text.includes(term));
}


function hasWrongFullStackSignal(job) {
  const text = jobText(job);
  return (text.includes('full stack') || text.includes('full-stack')) && WRONG_FULL_STACK_TERMS.some((term) => text.includes(term));
}

function backendPlatformRatio(job) {
  return ratioOfTerms(jobText(job), BACKEND_PLATFORM_TERMS);
}

function hasFrontendAiProductSignal(job) {
  const text = jobText(job);
  return frontendSignal(job) > 0 && hasAiProductSignal(job) && (hasStrongProductSignal(job) || text.includes('ship features') || text.includes('user-facing') || text.includes('customer-facing'));
}


function companySizeBucket(job) {
  const rawBucket = String(job.companySize ?? '').trim().toLowerCase();
  return job.normalized?.companySizeBucket ?? (rawBucket || null);
}

function companySizePreferenceAdjustment(job) {
  const bucket = companySizeBucket(job);

  if (bucket === '1001-5000') {
    return { companyQualityPenalty: 10, riskPenalty: 6, growthPenalty: 3 };
  }

  if (bucket === '5000+') {
    return { companyQualityPenalty: 20, riskPenalty: 12, growthPenalty: 8 };
  }

  if ((job.aiSignals ?? []).includes('company_size_outside_preferred_range')) {
    return { companyQualityPenalty: 12, riskPenalty: 8, growthPenalty: 4 };
  }

  return { companyQualityPenalty: 0, riskPenalty: 0, growthPenalty: 0 };
}

function companyQualityScore(job, requirements) {
  const text = jobText(job);
  const { companyQualityPenalty } = companySizePreferenceAdjustment(job);
  if (ratioOfTerms(text, CONSULTING_TERMS) > 0) {
    return 20;
  }
  if (ratioOfTerms(text, EVERGREEN_TERMS) > 0) {
    return 35;
  }
  if (hasInternalToolsSignal(job) && !hasDevexSignal(job)) {
    return clampScore((hasFrontendAiProductSignal(job) ? 55 : 30) - companyQualityPenalty);
  }
  if (hasAiProductSignal(job)) {
    return clampScore(92 - companyQualityPenalty);
  }
  if (hasStrongProductSignal(job) || fullStackSignal(job) > 0.12) {
    return clampScore(84 - companyQualityPenalty);
  }
  if (ratioOfTerms(text, AI_INFRA_TERMS) > 0.18 || backendPlatformRatio(job) > 0.15) {
    return clampScore(42 - companyQualityPenalty);
  }
  const baseScore = requirements.industry_preferences.some((preference) => text.includes(preference)) ? 80 : 55;
  return clampScore(baseScore - companyQualityPenalty);
}

function riskScore(job) {
  const text = jobText(job);
  const signalPenaltyByType = {
    missing_location_bucket: 2,
    missing_company_size_bucket: 0,
    company_size_outside_preferred_range: 0,
    ai_company_size_override: 0,
    missing_employment_type_bucket: 0,
    missing_visa_bucket: 0,
    title_not_in_preferred_lists: 8,
    must_have_skills_not_fully_confirmed: 6,
    negative_skill_overlap: 0,
  };
  const signalPenalty = Math.min(
    (job.aiSignals ?? []).reduce((total, signal) => total + (signalPenaltyByType[signal] ?? 3), 0),
    24
  );
  const { riskPenalty: companySizeRiskPenalty } = companySizePreferenceAdjustment(job);
  const negativePenalty = Math.min((job.negativeSkillMatches?.length ?? 0) * 12, 36);
  const consultingPenalty = ratioOfTerms(text, CONSULTING_TERMS) > 0 ? 22 : 0;
  const evergreenPenalty = ratioOfTerms(text, EVERGREEN_TERMS) > 0 ? 12 : 0;
  const infraPenalty = hasAiModelingOrInfraSignal(job) && !hasFrontendAiProductSignal(job) ? 18 : 0;
  const backendPlatformPenalty = backendPlatformRatio(job) > 0.15 && !hasFrontendAiProductSignal(job) ? 18 : 0;
  const pseudoFullStackPenalty = hasWrongFullStackSignal(job) ? 12 : 0;
  const nativeMobilePenalty = nativeMobileRatio(job) * 42;
  const reactNativePenalty = hasReactNativeSignal(job) ? 6 : 0;
  return clampScore(95 - signalPenalty - companySizeRiskPenalty - negativePenalty - consultingPenalty - evergreenPenalty - infraPenalty - backendPlatformPenalty - pseudoFullStackPenalty - nativeMobilePenalty - reactNativePenalty);
}

function calculateWeightedTotalScore(breakdown, weights) {
  return clampScore(
    (breakdown.skills * weights.skills +
      breakdown.responsibilities * weights.responsibilities +
      breakdown.company_quality * weights.company_quality +
      breakdown.title * weights.title +
      breakdown.seniority * weights.seniority +
      breakdown.growth * weights.growth +
      breakdown.risk * weights.risk) /
      100
  );
}

function responsibilityAlignmentScore(job) {
  const text = jobText(job);
  const positiveRatio = ratioOfTerms(text, PRODUCT_ENGINEERING_TERMS);
  const avoidRatio = ratioOfTerms(text, AVOID_DIRECTION_TERMS);
  const consultingPenalty = ratioOfTerms(text, CONSULTING_TERMS) > 0 ? 20 : 0;
  const infraPenalty = hasAiModelingOrInfraSignal(job) && !hasFrontendAiProductSignal(job) ? 30 : 0;
  const backendPlatformPenalty = backendPlatformRatio(job) > 0.15 && !hasFrontendAiProductSignal(job) ? 24 : 0;
  const internalToolsPenalty = hasInternalToolsSignal(job) && !hasDevexSignal(job) ? 26 : 0;
  const nativeMobilePenalty = nativeMobileRatio(job) * 55;
  const reactNativePenalty = hasReactNativeSignal(job) ? 8 : 0;
  const aiBoost = hasAiProductSignal(job) ? 12 : 0;
  const devexBoost = hasDevexSignal(job) ? 10 : 0;
  const productBoost = hasStrongProductSignal(job) ? 24 : 0;
  const frontendAiBoost = hasFrontendAiProductSignal(job) ? 24 : 0;
  const pseudoFullStackPenalty = hasWrongFullStackSignal(job) ? 16 : 0;
  const fullStackBoost = fullStackSignal(job) * 18;
  const backendBoost = fittedBackendSignal(job) * 14;
  const frontendBoost = frontendSignal(job) * 7;
  return clampScore(28 + positiveRatio * 66 - avoidRatio * 45 - consultingPenalty - infraPenalty - backendPlatformPenalty - internalToolsPenalty - nativeMobilePenalty - reactNativePenalty - pseudoFullStackPenalty + aiBoost + devexBoost + productBoost + frontendAiBoost + fullStackBoost + backendBoost + frontendBoost);
}

function titleAlignmentScore(job, requirements) {
  const normalizedTitle = (job.title ?? '').toLowerCase();
  let score = clampScore(overlapScore(job, requirements.all_titles) * 100);

  if (normalizedTitle.includes('product engineering')) {
    score += 24;
  }
  if (normalizedTitle.includes('fullstack') || normalizedTitle.includes('full stack')) {
    score += hasWrongFullStackSignal(job) ? 2 : 16;
  }
  if (normalizedTitle.includes('backend')) {
    score += normalizedTitle.includes('java') || normalizedTitle.includes('.net') || normalizedTitle.includes('c++') ? -8 : 8;
  }
  if (normalizedTitle.includes('frontend')) {
    score += hasFrontendAiProductSignal(job) ? 14 : 8;
  }
  if (normalizedTitle.includes('developer productivity') || normalizedTitle.includes('developer experience')) {
    score += 14;
  }
  if (normalizedTitle.includes('tools') && !hasDevexSignal(job)) {
    score -= 16;
  }
  if (normalizedTitle.includes('growth platform') || normalizedTitle.includes('integrations')) {
    score -= 12;
  }
  if (normalizedTitle.includes('staff') || normalizedTitle.includes('principal')) {
    score -= 22;
  }
  if (normalizedTitle.includes('android') || normalizedTitle.includes('ios') || normalizedTitle.includes('mobile')) {
    score -= hasReactNativeSignal(job) ? 8 : 24;
  }
  if (normalizedTitle.includes('java') || normalizedTitle.includes('.net') || normalizedTitle.includes('c++')) {
    score -= 18;
  }
  if ((job.aiSignals ?? []).includes('title_not_in_preferred_lists')) {
    score -= 12;
  }

  return clampScore(score);
}

function heuristicScore(job, requirements, resume) {
  const weights = requirements.weights;
  const growthBase = (job.description ?? '').toLowerCase().includes('growth') ? 80 : 45;
  const { growthPenalty: companySizeGrowthPenalty } = companySizePreferenceAdjustment(job);
  const growthPenalty = ((hasAiModelingOrInfraSignal(job) || backendPlatformRatio(job) > 0.15) && !hasFrontendAiProductSignal(job) ? 18 : 0) + companySizeGrowthPenalty;
  const productGrowthBoost = hasStrongProductSignal(job) ? 10 : 0;
  const frontendAiGrowthBoost = hasFrontendAiProductSignal(job) ? 10 : 0;
  const breakdown = {
    skills: skillCoverageScore(job, requirements, resume),
    responsibilities: responsibilityAlignmentScore(job),
    company_quality: companyQualityScore(job, requirements),
    growth: clampScore((hasAiProductSignal(job) ? Math.max(growthBase, 90) : hasStrongProductSignal(job) ? Math.max(growthBase, 80) : growthBase) + productGrowthBoost + frontendAiGrowthBoost - growthPenalty),
    title: titleAlignmentScore(job, requirements),
    seniority: seniorityScore(job, requirements),
    risk: riskScore(job),
  };

  const totalScore = calculateWeightedTotalScore(breakdown, weights);

  return {
    decision: totalScore >= 60 ? 'shortlist' : 'reject',
    totalScore,
    breakdown,
    whyRecommended:
      totalScore >= 60
        ? 'Heuristic fallback kept this role because it passed deterministic filters and matched the resume reasonably well.'
        : 'Heuristic fallback rejected this role because its overall fit score was too low.',
    rejectReason: totalScore >= 60 ? '' : 'Heuristic fallback score below shortlist threshold.',
    gaps: requirements.nice_to_have_skills.filter((skill) => !(job.description ?? '').toLowerCase().includes(skill)).slice(0, 5),
    scoringSource: 'heuristic',
  };
}

function buildGeminiPrompt(job, requirements, resume) {
  return [
    'You are evaluating whether a LinkedIn job should stay on a shortlist for Tank Sun.',
    'Hard filters already removed deterministic mismatches. Your job is to make the final shortlist-or-reject decision using overall fit, not just keyword overlap.',
    '',
    'Candidate profile summary:',
    '- Best fit: product engineering, frontend-heavy full-stack roles, platform/product engineering, developer experience, and AI-enabled application work.',
    '- Strongest stack: TypeScript, JavaScript, React, Node.js.',
    '- Good signs: user-facing product ownership, modern web engineering, AI features tied to real product value, cross-functional execution, and strong engineering quality.',
    '- Extra-strong positive: companies building AI products or roles shipping AI-powered features to users, especially when the work is still product/full-stack/frontend oriented.',
    '- Bad signs: titles or work that are mainly product owner, project/program manager, QA, IT admin, support, consulting bodyshop work, low-level systems, embedded, native mobile, or backend stacks centered on Java/Spring or .NET unless the rest of the role is still clearly aligned.',
    '',
    'Decision policy:',
    '- Be selective. A role should only be shortlisted if there is positive evidence that it is a genuinely strong fit, not merely acceptable.',
    '- Prefer actual day-to-day work over a flattering title. If the title sounds good but the responsibilities are off-target, reject it.',
    '- Prefer evidence from the job description and metadata. Do not invent missing facts.',
    '- Missing company size is fine. Company size is a filtering preference, not a score bonus. Jobs within the allowed size range should not get extra credit for simply being larger.',
    '- Missing employment type or visa policy should not by itself cause rejection or lower fit. Only explicit incompatible values should count against the role.',
    '- Missing explicit mention of TypeScript, React, or Node.js should be treated as uncertainty, not as an automatic rejection, if the title and responsibilities still point to strong product/full-stack/frontend work.',
    '- Many postings mention broad or secondary tech stacks. Do not reject merely because avoid-list technologies appear somewhere in the posting. Treat them as strong negatives only when the core responsibilities or must-have requirements are centered on them.',
    '- If company size is outside the preferred range but the role is otherwise strong, that should usually lower enthusiasm rather than force rejection.',
    '- Strong positive signal if the company is building AI products or the role clearly ships AI-powered features to users. Prefer these when the rest of the role is also a fit.',
    '- Treat AI application/product work as much stronger than AI infra, ML platform, model training, research, or backend-only AI roles that are detached from user-facing product engineering.',
    '- Do not give the same boost to AI strategy, AI consulting, or backend/infra/platform work that is detached from product-facing engineering.',
    '- If both title fit and core stack fit are clearly weak, reject even if the company or AI domain sounds attractive.',
    '- If title fit, core stack fit, and day-to-day work are all weak or ambiguous, reject rather than giving the benefit of the doubt.',
    '- Treat evergreen or generic future-opportunity postings more skeptically unless the role still looks unusually aligned.',
    '- Use aiSignals as weak hints about uncertainty or possible concerns. Missing metadata and unconfirmed skills are not disqualifiers by themselves.',
    '',
    'Scoring guidance:',
    "- skills: how well the role matches the candidate's actual strengths and primary required stack, not every incidental technology mentioned in the posting. This is one of the highest-priority dimensions.",
    '- responsibilities: how well the actual work matches product/full-stack/frontend/AI application engineering goals. Give extra credit for shipping AI-powered product features.',
    '- company_quality: domain and company context fit, treated as secondary to the role itself. Give extra credit to AI product companies, but not just any AI-adjacent consulting or infrastructure work.',
    '- title: how well the title aligns with the target or acceptable titles. This is one of the highest-priority dimensions.',
    '- seniority: whether the expected level is a good fit for mid-level to senior roles.',
    '- growth: whether the role appears to offer strong ownership, scope, and learning potential.',
    '- risk: penalize unclear fit, heavy mismatch to avoid-list directions, consulting/bodyshop signals, or noisy/ambiguous postings.',
    '',
    'Requirements:',
    JSON.stringify({
      must_have_locations: requirements.must_have_locations,
      must_have_company_size: requirements.must_have_company_size,
      must_have_employment_types: requirements.must_have_employment_types,
      visa_policy: requirements.visa_policy,
      target_titles: requirements.target_titles,
      acceptable_titles: requirements.acceptable_titles,
      experience_level: requirements.experience_level,
      must_have_skills: requirements.must_have_skills,
      nice_to_have_skills: requirements.nice_to_have_skills,
      industry_preferences: requirements.industry_preferences,
      negative_skills: requirements.negative_skills,
      red_flags: requirements.red_flags,
      weights: requirements.weights,
    }, null, 2),
    '',
    'Resume summary:',
    resume.summary,
    '',
    'Resume skills sample:',
    JSON.stringify(resume.skills.slice(0, 120)),
    '',
    'Job:',
    JSON.stringify({
      title: job.title,
      company: job.company,
      location: job.location,
      employmentType: job.employmentType,
      visaPolicy: job.visaPolicy,
      companySize: job.companySize,
      postedTime: job.postedTime,
      applicantInfo: job.applicantInfo,
      description: job.description,
      aiSignals: job.aiSignals,
      mustHaveSkillMatches: job.mustHaveSkillMatches,
      negativeSkillMatches: job.negativeSkillMatches,
    }, null, 2),
    '',
    'Return JSON only.',
    'why_recommended should be concise and specific.',
    'reject_reason should name the main mismatch plainly.',
    'gaps should list the most important missing skills or concerns, not generic filler.',
  ].join('\n');
}

function geminiResponseSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      decision: { type: Type.STRING, enum: ['shortlist', 'reject'] },
      total_score: { type: Type.INTEGER },
      breakdown: {
        type: Type.OBJECT,
        properties: {
          skills: { type: Type.INTEGER },
          responsibilities: { type: Type.INTEGER },
          company_quality: { type: Type.INTEGER },
          title: { type: Type.INTEGER },
          seniority: { type: Type.INTEGER },
          growth: { type: Type.INTEGER },
          risk: { type: Type.INTEGER },
        },
        required: ['skills', 'responsibilities', 'company_quality', 'title', 'seniority', 'growth', 'risk'],
      },
      why_recommended: { type: Type.STRING },
      reject_reason: { type: Type.STRING },
      gaps: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
    required: ['decision', 'total_score', 'breakdown', 'why_recommended', 'reject_reason', 'gaps'],
  };
}

function buildScoreCacheKey(job) {
  return job.jobUrl || `${job.company ?? ''}::${job.title ?? ''}::${job.location ?? ''}`;
}

function buildScoreSignature(job, model) {
  return createHash('sha1')
    .update(
      JSON.stringify({
        model,
        scoringVersion: SCORING_SIGNATURE_VERSION,
        title: job.title,
        company: job.company,
        location: job.location,
        employmentType: job.employmentType,
        visaPolicy: job.visaPolicy,
        companySize: job.companySize,
        postedTime: job.postedTime,
        applicantInfo: job.applicantInfo,
        description: job.description,
        aiSignals: job.aiSignals,
        mustHaveSkillMatches: job.mustHaveSkillMatches,
        negativeSkillMatches: job.negativeSkillMatches,
      })
    )
    .digest('hex');
}

function resolveScoreConcurrency(env) {
  const parsed = Number(env.SCORE_CONCURRENCY ?? DEFAULT_SCORE_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCORE_CONCURRENCY;
  }
  return Math.max(1, Math.floor(parsed));
}

async function loadScoreCache(cachePath) {
  if (!cachePath) {
    return { entries: {} };
  }

  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

async function saveScoreCache(cachePath, cache) {
  if (!cachePath) {
    return;
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function normalizeGeminiScoreValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  const normalized = parsed >= 0 && parsed <= 10 ? parsed * 10 : parsed;
  return clampScore(normalized);
}

function blendBreakdowns(aiBreakdown, heuristicBreakdown) {
  return {
    skills: clampScore(aiBreakdown.skills * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.skills * (1 - AI_HEURISTIC_BLEND_RATIO)),
    responsibilities: clampScore(aiBreakdown.responsibilities * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.responsibilities * (1 - AI_HEURISTIC_BLEND_RATIO)),
    company_quality: clampScore(aiBreakdown.company_quality * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.company_quality * (1 - AI_HEURISTIC_BLEND_RATIO)),
    title: clampScore(aiBreakdown.title * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.title * (1 - AI_HEURISTIC_BLEND_RATIO)),
    seniority: clampScore(aiBreakdown.seniority * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.seniority * (1 - AI_HEURISTIC_BLEND_RATIO)),
    growth: clampScore(aiBreakdown.growth * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.growth * (1 - AI_HEURISTIC_BLEND_RATIO)),
    risk: clampScore(aiBreakdown.risk * AI_HEURISTIC_BLEND_RATIO + heuristicBreakdown.risk * (1 - AI_HEURISTIC_BLEND_RATIO)),
  };
}

function mergeAiAndHeuristicScores(aiResult, heuristicResult, weights) {
  const breakdown = blendBreakdowns(aiResult.breakdown, heuristicResult.breakdown);
  return {
    ...aiResult,
    totalScore: calculateWeightedTotalScore(breakdown, weights),
    breakdown,
    heuristicTotalScore: heuristicResult.totalScore,
    aiTotalScore: aiResult.totalScore,
    scoringSource: 'gemini+heuristic',
  };
}

function normalizeGeminiResult(parsed, weights) {
  const breakdown = {
    skills: normalizeGeminiScoreValue(parsed.breakdown.skills),
    responsibilities: normalizeGeminiScoreValue(parsed.breakdown.responsibilities),
    company_quality: normalizeGeminiScoreValue(parsed.breakdown.company_quality),
    title: normalizeGeminiScoreValue(parsed.breakdown.title),
    seniority: normalizeGeminiScoreValue(parsed.breakdown.seniority),
    growth: normalizeGeminiScoreValue(parsed.breakdown.growth),
    risk: normalizeGeminiScoreValue(parsed.breakdown.risk),
  };

  return {
    decision: parsed.decision,
    totalScore: calculateWeightedTotalScore(breakdown, weights),
    breakdown,
    whyRecommended: parsed.why_recommended,
    rejectReason: parsed.reject_reason ?? '',
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 8) : [],
    scoringSource: 'gemini',
  };
}


function hasCriticalTitleAndSkillMismatch(result) {
  return (result.breakdown?.title ?? 100) <= 20 && (result.breakdown?.skills ?? 100) <= 35;
}

function toAiRejectionReasons(result) {
  return [
    { field: 'aiDecision', message: result.rejectReason || 'AI rejected this role because title and core skills fit were too weak.' },
    { field: 'title', message: `Title fit score ${result.breakdown.title} is too low` },
    { field: 'skills', message: `Skills fit score ${result.breakdown.skills} is too low` },
  ];
}

function buildCacheEntry({ key, signature, mode, status, result, reasons, message, originalMessage }) {
  return {
    key,
    signature,
    mode,
    status,
    result,
    reasons,
    message,
    originalMessage,
    updatedAt: new Date().toISOString(),
  };
}

async function callGemini({ apiKey, model, job, requirements, resume }) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: buildGeminiPrompt(job, requirements, resume),
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema(),
    },
  });

  if (!response.text) {
    throw new Error('Gemini response did not contain text output.');
  }

  const parsed = JSON.parse(response.text);
  return normalizeGeminiResult(parsed, requirements.weights);
}

function buildCacheAwareResult({ job, cacheKey, signature, scoringMode, cached }) {
  if (!cached || cached.signature !== signature || cached.mode !== scoringMode) {
    return null;
  }

  if (cached.status === 'scored') {
    return {
      type: 'scored',
      value: { ...job, ...cached.result },
    };
  }

  if (cached.status === 'rejected') {
    return {
      type: 'rejected',
      value: { ...job, ...cached.result, reasons: cached.reasons ?? [] },
    };
  }

  if (cached.status === 'failed') {
    return {
      type: 'failed',
      value: {
        ...job,
        scoringFailed: true,
        message: cached.message,
        originalMessage: cached.originalMessage,
      },
    };
  }

  return null;
}

async function scoreSingleJob({ job, requirements, resume, apiKey, model, scoringMode, cache, cacheKey, signature }) {
  const cachedResult = buildCacheAwareResult({
    job,
    cacheKey,
    signature,
    scoringMode,
    cached: cache.entries?.[cacheKey],
  });
  if (cachedResult) {
    return cachedResult;
  }

  try {
    const heuristic = heuristicScore(job, requirements, resume);
    const result = apiKey
      ? mergeAiAndHeuristicScores(await callGemini({ apiKey, model, job, requirements, resume }), heuristic, requirements.weights)
      : heuristic;

    if (apiKey && result.decision !== 'shortlist' && hasCriticalTitleAndSkillMismatch(result)) {
      const reasons = toAiRejectionReasons(result);
      const rejectedResult = {
        ...result,
        modelDecision: result.decision,
        decision: 'reject',
      };

      cache.entries[cacheKey] = buildCacheEntry({
        key: cacheKey,
        signature,
        mode: scoringMode,
        status: 'rejected',
        result: rejectedResult,
        reasons,
      });

      return {
        type: 'rejected',
        value: { ...job, ...rejectedResult, reasons },
      };
    }

    const scoredResult = {
      ...result,
      modelDecision: result.decision,
      decision: 'scored',
    };

    cache.entries[cacheKey] = buildCacheEntry({
      key: cacheKey,
      signature,
      mode: scoringMode,
      status: 'scored',
      result: scoredResult,
    });

    return {
      type: 'scored',
      value: { ...job, ...scoredResult },
    };
  } catch (error) {
    try {
      const fallback = heuristicScore(job, requirements, resume);
      const enriched = {
        ...job,
        ...fallback,
        scoringFailureMessage: error instanceof Error ? error.message : String(error),
      };

      const scoredFallback = {
        ...fallback,
        modelDecision: fallback.decision,
        decision: 'scored',
      };
      const enrichedScored = {
        ...enriched,
        ...scoredFallback,
      };

      cache.entries[cacheKey] = buildCacheEntry({
        key: cacheKey,
        signature,
        mode: scoringMode,
        status: 'scored',
        result: scoredFallback,
      });
      return {
        type: 'scored',
        value: enrichedScored,
      };
    } catch (fallbackError) {
      const failure = {
        ...job,
        scoringFailed: true,
        message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        originalMessage: error instanceof Error ? error.message : String(error),
      };
      cache.entries[cacheKey] = buildCacheEntry({
        key: cacheKey,
        signature,
        mode: scoringMode,
        status: 'failed',
        message: failure.message,
        originalMessage: failure.originalMessage,
      });
      return {
        type: 'failed',
        value: failure,
      };
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  if (items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function scoreJobs({ jobs, requirements, resume, env, cachePath }) {
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const scoringMode = apiKey ? model : 'heuristic-only';
  const scoreConcurrency = resolveScoreConcurrency(env);
  const cache = await loadScoreCache(cachePath);

  const results = await mapWithConcurrency(jobs, scoreConcurrency, async (job) => {
    const cacheKey = buildScoreCacheKey(job);
    const signature = buildScoreSignature(job, scoringMode);
    return scoreSingleJob({
      job,
      requirements,
      resume,
      apiKey,
      model,
      scoringMode,
      cache,
      cacheKey,
      signature,
    });
  });

  await saveScoreCache(cachePath, cache);

  const scored = [];
  const failures = [];
  const aiRejected = [];

  for (const result of results) {
    if (result.type === 'scored') {
      scored.push(result.value);
    } else if (result.type === 'rejected') {
      aiRejected.push(result.value);
    } else if (result.type === 'failed') {
      failures.push(result.value);
    }
  }

  return { scored, failures, aiRejected, scoringMode, cachePath };
}

export const __testables = {
  buildGeminiPrompt,
  buildScoreCacheKey,
  buildScoreSignature,
  calculateWeightedTotalScore,
  hasAiProductSignal,
  hasCriticalTitleAndSkillMismatch,
  hasDevexSignal,
  hasStrongProductSignal,
  heuristicScore,
  mergeAiAndHeuristicScores,
  mapWithConcurrency,
  normalizeGeminiResult,
  normalizeGeminiScoreValue,
  resolveScoreConcurrency,
  riskScore,
};
