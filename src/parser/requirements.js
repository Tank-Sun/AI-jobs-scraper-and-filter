import { readFile } from 'node:fs/promises';

function normalizeValue(value) {
  return value.trim().toLowerCase();
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}

const listKeys = new Set([
  'must_have_locations',
  'must_have_company_size',
  'must_have_employment_types',
  'visa_policy',
  'target_titles',
  'acceptable_titles',
  'experience_level',
  'must_have_skills',
  'nice_to_have_skills',
  'industry_preferences',
  'negative_skills',
  'red_flags',
]);

const scalarKeys = new Set([
  'min_salary_annual',
]);

const defaultWeights = {
  skills: 40,
  responsibilities: 20,
  company_quality: 10,
  title: 10,
  seniority: 10,
  growth: 5,
  risk: 5,
};

function ensureList(result, key) {
  result[key] ??= [];
}

function finalizeRequirements(result) {
  for (const key of listKeys) {
    ensureList(result, key);
  }

  result.weights = {
    ...defaultWeights,
    ...(result.weights ?? {}),
  };

  result.min_salary_annual = Number.isFinite(result.min_salary_annual) ? result.min_salary_annual : null;

  const requiredLists = [
    'must_have_locations',
    'must_have_company_size',
    'must_have_employment_types',
    'visa_policy',
    'target_titles',
    'must_have_skills',
    'nice_to_have_skills',
    'red_flags',
  ];

  for (const key of requiredLists) {
    if (!Array.isArray(result[key])) {
      throw new Error(`Missing required list: ${key}`);
    }
  }

  result.all_titles = [...new Set([...result.target_titles, ...result.acceptable_titles])];
  return result;
}

export async function parseRequirementsFile(filePath) {
  const raw = stripBom(await readFile(filePath, 'utf8'));
  const lines = raw.split(/\r?\n/);
  const result = { weights: {} };
  let currentKey = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const scalarMatch = /^(\w[\w_]*):\s*(\S.*)$/.exec(trimmed);
    if (scalarMatch && scalarKeys.has(scalarMatch[1])) {
      currentKey = null;
      result[scalarMatch[1]] = Number(scalarMatch[2]);
      continue;
    }

    const sectionMatch = /^(\w[\w_]*):\s*$/.exec(trimmed);
    if (sectionMatch) {
      currentKey = sectionMatch[1];
      if (currentKey !== 'weights') {
        ensureList(result, currentKey);
      }
      continue;
    }

    if (currentKey === 'weights' && line.startsWith('  ')) {
      const [rawKey, rawValue] = trimmed.split(/:\s+/);
      result.weights[rawKey] = Number(rawValue);
      continue;
    }

    if (currentKey && trimmed.startsWith('- ')) {
      ensureList(result, currentKey);
      result[currentKey].push(normalizeValue(trimmed.slice(2)));
    }
  }

  return finalizeRequirements(result);
}
