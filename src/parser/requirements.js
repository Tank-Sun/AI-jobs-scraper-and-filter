import { readFile } from 'node:fs/promises';

function normalizeValue(value) {
  return value.trim().toLowerCase();
}

function parseScalar(value) {
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

export async function parseRequirementsFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const result = {};
  let currentKey = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const sectionMatch = /^(\w[\w_]*):\s*$/.exec(line.trim());
    if (sectionMatch) {
      currentKey = sectionMatch[1];
      result[currentKey] = [];
      continue;
    }

    const scalarMatch = /^(\w[\w_]*):\s+(.+)$/.exec(line.trim());
    if (scalarMatch && !line.startsWith('  ')) {
      result[scalarMatch[1]] = parseScalar(scalarMatch[2]);
      currentKey = null;
      continue;
    }

    if (currentKey && line.trim().startsWith('- ')) {
      result[currentKey].push(normalizeValue(line.trim().slice(2)));
      continue;
    }

    if (currentKey === 'weights' && line.startsWith('  ')) {
      const [rawKey, rawValue] = line.trim().split(/:\s+/);
      result.weights ??= {};
      result.weights[rawKey] = Number(rawValue);
    }
  }

  const requiredArrays = [
    'must_have_locations',
    'must_have_company_size',
    'must_have_employment_types',
    'must_have_visa_policy',
    'target_titles',
    'nice_to_have_skills',
    'red_flags',
  ];

  for (const key of requiredArrays) {
    if (!Array.isArray(result[key])) {
      throw new Error(`Missing required list: ${key}`);
    }
  }

  if (!result.weights || typeof result.weights !== 'object') {
    throw new Error('Missing required weights section');
  }

  return result;
}
