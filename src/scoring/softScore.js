import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GoogleGenAI, Type } from '@google/genai';

const DEFAULT_MODEL = 'gemini-2.5-flash';

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function overlapScore(haystack, needles) {
  const text = `${haystack.title ?? ''} ${haystack.description ?? ''}`.toLowerCase();
  const hits = needles.filter((needle) => text.includes(needle)).length;
  return needles.length === 0 ? 0 : hits / needles.length;
}

function skillCoverageScore(job, requirements, resume) {
  const niceToHaveRatio = overlapScore(job, requirements.nice_to_have_skills);
  const resumeRatio = resume.skills.length === 0 ? 0 : overlapScore(job, resume.skills.slice(0, 80));
  const mustHaveCoverage = (job.mustHaveSkillMatches?.length ?? 0) / Math.max(requirements.must_have_skills.length, 1);
  return clampScore((niceToHaveRatio * 0.4 + resumeRatio * 0.3 + mustHaveCoverage * 0.3) * 100);
}

function seniorityScore(job, requirements) {
  const normalizedTitle = (job.title ?? '').toLowerCase();
  if (requirements.experience_level.some((level) => normalizedTitle.includes(level.replace('-level', '').trim()))) {
    return 85;
  }
  if (normalizedTitle.includes('staff') || normalizedTitle.includes('principal')) {
    return 60;
  }
  return 70;
}

function companyQualityScore(job, requirements) {
  const text = `${job.company ?? ''} ${job.description ?? ''}`.toLowerCase();
  return clampScore(requirements.industry_preferences.some((preference) => text.includes(preference)) ? 80 : 55);
}

function riskScore(job) {
  const signalPenalty = Math.min((job.aiSignals?.length ?? 0) * 8, 25);
  const negativePenalty = Math.min((job.negativeSkillMatches?.length ?? 0) * 12, 30);
  return clampScore(95 - signalPenalty - negativePenalty);
}

function heuristicScore(job, requirements, resume) {
  const weights = requirements.weights;
  const breakdown = {
    skills: skillCoverageScore(job, requirements, resume),
    responsibilities: clampScore(Math.min(1, ((job.description ?? '').length || 0) / 4000) * 100),
    company_quality: companyQualityScore(job, requirements),
    growth: clampScore((job.description ?? '').toLowerCase().includes('growth') ? 80 : 45),
    title: clampScore(overlapScore(job, requirements.all_titles) * 100),
    seniority: seniorityScore(job, requirements),
    risk: riskScore(job),
  };

  const totalScore = clampScore(
    (breakdown.skills * weights.skills +
      breakdown.responsibilities * weights.responsibilities +
      breakdown.company_quality * weights.company_quality +
      breakdown.title * weights.title +
      breakdown.seniority * weights.seniority +
      breakdown.growth * weights.growth +
      breakdown.risk * weights.risk) /
      100
  );

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
    '- Bad signs: titles or work that are mainly product owner, project/program manager, QA, IT admin, support, consulting bodyshop work, low-level systems, embedded, native mobile, or backend stacks centered on Java/Spring or .NET unless the rest of the role is still clearly aligned.',
    '',
    'Decision policy:',
    '- Be selective. A role should only be shortlisted if there is positive evidence that it is a genuinely strong fit, not merely acceptable.',
    '- Prefer actual day-to-day work over a flattering title. If the title sounds good but the responsibilities are off-target, reject it.',
    '- Prefer evidence from the job description and metadata. Do not invent missing facts.',
    '- Missing company size is fine. Company size is only a soft preference and should not by itself cause rejection.',
    '- If company size is outside the preferred range but the role is otherwise strong, that should usually lower enthusiasm rather than force rejection.',
    '- If title fit, core stack fit, and day-to-day work are all weak or ambiguous, reject rather than giving the benefit of the doubt.',
    '- Treat evergreen or generic future-opportunity postings more skeptically unless the role still looks unusually aligned.',
    '- Use aiSignals as hints about uncertainty or possible concerns, but do not blindly mirror them.',
    '',
    'Scoring guidance:',
    '- skills: how well the role matches the candidate\'s actual strengths and required stack.',
    '- responsibilities: how well the actual work matches product/full-stack/frontend/AI application engineering goals.',
    '- company_quality: domain and company context fit, treated as secondary to the role itself.',
    '- title: how well the title aligns with the target or acceptable titles.',
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
  return {
    decision: parsed.decision,
    totalScore: clampScore(parsed.total_score),
    breakdown: {
      skills: clampScore(parsed.breakdown.skills),
      responsibilities: clampScore(parsed.breakdown.responsibilities),
      company_quality: clampScore(parsed.breakdown.company_quality),
      title: clampScore(parsed.breakdown.title),
      seniority: clampScore(parsed.breakdown.seniority),
      growth: clampScore(parsed.breakdown.growth),
      risk: clampScore(parsed.breakdown.risk),
    },
    whyRecommended: parsed.why_recommended,
    rejectReason: parsed.reject_reason ?? '',
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 8) : [],
    scoringSource: 'gemini',
  };
}

export async function scoreJobs({ jobs, requirements, resume, env, cachePath }) {
  const scored = [];
  const failures = [];
  const aiRejected = [];
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const scoringMode = apiKey ? model : 'heuristic-only';
  const cache = await loadScoreCache(cachePath);

  for (const job of jobs) {
    const cacheKey = buildScoreCacheKey(job);
    const signature = buildScoreSignature(job, scoringMode);
    const cached = cache.entries?.[cacheKey];

    if (cached && cached.signature === signature && cached.mode === scoringMode) {
      if (cached.status === 'scored') {
        scored.push({ ...job, ...cached.result });
        continue;
      }
      if (cached.status === 'rejected') {
        aiRejected.push({ ...job, ...cached.result, reasons: cached.reasons ?? [] });
        continue;
      }
      if (cached.status === 'failed') {
        failures.push({
          ...job,
          scoringFailed: true,
          message: cached.message,
          originalMessage: cached.originalMessage,
        });
        continue;
      }
    }

    try {
      const result = apiKey
        ? await callGemini({ apiKey, model, job, requirements, resume })
        : heuristicScore(job, requirements, resume);

      const enriched = { ...job, ...result };
      if (result.decision === 'reject') {
        const reasons = [{ field: 'ai', message: result.rejectReason || result.whyRecommended }];
        aiRejected.push({ ...enriched, reasons });
        cache.entries[cacheKey] = buildCacheEntry({
          key: cacheKey,
          signature,
          mode: scoringMode,
          status: 'rejected',
          result,
          reasons,
        });
        await saveScoreCache(cachePath, cache);
        continue;
      }

      scored.push(enriched);
      cache.entries[cacheKey] = buildCacheEntry({
        key: cacheKey,
        signature,
        mode: scoringMode,
        status: 'scored',
        result,
      });
      await saveScoreCache(cachePath, cache);
    } catch (error) {
      try {
        const fallback = heuristicScore(job, requirements, resume);
        const enriched = {
          ...job,
          ...fallback,
          scoringFailureMessage: error instanceof Error ? error.message : String(error),
        };
        if (fallback.decision === 'reject') {
          const reasons = [{ field: 'fallback', message: fallback.rejectReason || fallback.whyRecommended }];
          aiRejected.push({ ...enriched, reasons });
          cache.entries[cacheKey] = buildCacheEntry({
            key: cacheKey,
            signature,
            mode: scoringMode,
            status: 'rejected',
            result: fallback,
            reasons,
          });
        } else {
          scored.push(enriched);
          cache.entries[cacheKey] = buildCacheEntry({
            key: cacheKey,
            signature,
            mode: scoringMode,
            status: 'scored',
            result: fallback,
          });
        }
        await saveScoreCache(cachePath, cache);
      } catch (fallbackError) {
        const failure = {
          ...job,
          scoringFailed: true,
          message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          originalMessage: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        cache.entries[cacheKey] = buildCacheEntry({
          key: cacheKey,
          signature,
          mode: scoringMode,
          status: 'failed',
          message: failure.message,
          originalMessage: failure.originalMessage,
        });
        await saveScoreCache(cachePath, cache);
      }
    }
  }

  return { scored, failures, aiRejected, scoringMode, cachePath };
}

export const __testables = {
  buildScoreCacheKey,
  buildScoreSignature,
};
