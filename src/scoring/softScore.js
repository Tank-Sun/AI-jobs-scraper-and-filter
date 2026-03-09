function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function overlapScore(haystack, needles) {
  const text = `${haystack.title ?? ''} ${haystack.description ?? ''}`.toLowerCase();
  const hits = needles.filter((needle) => text.includes(needle)).length;
  return needles.length === 0 ? 0 : hits / needles.length;
}

function heuristicScore(job, requirements, resume) {
  const weights = requirements.weights;
  const skillRatio = overlapScore(job, requirements.nice_to_have_skills);
  const titleRatio = overlapScore(job, requirements.target_titles);
  const resumeRatio = resume.skills.length === 0 ? 0 : overlapScore(job, resume.skills.slice(0, 50));
  const responsibilities = Math.min(1, ((job.description ?? '').length || 0) / 4000);
  const growth = (job.description ?? '').toLowerCase().includes('growth') ? 0.8 : 0.4;
  const seniority = (job.title ?? '').toLowerCase().includes('senior') ? 0.7 : 0.5;
  const risk = job.lowConfidence ? 0.4 : 0.9;

  const breakdown = {
    skills: clampScore((skillRatio * 0.7 + resumeRatio * 0.3) * 100),
    responsibilities: clampScore(responsibilities * 100),
    growth: clampScore(growth * 100),
    title: clampScore(titleRatio * 100),
    seniority: clampScore(seniority * 100),
    risk: clampScore(risk * 100),
  };

  const totalScore = clampScore(
    (breakdown.skills * weights.skills +
      breakdown.responsibilities * weights.responsibilities +
      breakdown.growth * weights.growth +
      breakdown.title * weights.title +
      breakdown.seniority * weights.seniority +
      breakdown.risk * weights.risk) /
      100
  );

  return {
    totalScore,
    breakdown,
    whyRecommended: job.lowConfidence
      ? 'Passed hard filters with at least one low-confidence field that may need manual review.'
      : 'Strong rule match with heuristic alignment to target skills and responsibilities.',
    gaps: requirements.nice_to_have_skills.filter((skill) => !(job.description ?? '').toLowerCase().includes(skill)).slice(0, 5),
    scoringSource: 'heuristic',
  };
}

export async function scoreJobs({ jobs, requirements, resume }) {
  const scored = [];
  const failures = [];

  for (const job of jobs) {
    try {
      const result = heuristicScore(job, requirements, resume);
      scored.push({ ...job, ...result });
    } catch (error) {
      failures.push({
        ...job,
        scoringFailed: true,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scored, failures };
}
