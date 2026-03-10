import { access, readFile } from 'node:fs/promises';

function normalizeSkill(token) {
  return token.toLowerCase().replace(/[^a-z0-9+.#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractSkillKeywords(text) {
  const matches = text.match(/[A-Za-z0-9+.#-]{2,}/g) ?? [];
  const blocked = new Set([
    'summary',
    'github.com',
    'linkedin.com',
    'gmail.com',
    'tank',
    'sun',
  ]);
  return [...new Set(matches.map(normalizeSkill).filter((value) => value && !blocked.has(value)))];
}

export async function resolveResumePath(preferredPath) {
  const candidates = [preferredPath, preferredPath.replace(/resume\.[^.]+$/, 'resume.md'), preferredPath.replace(/resume\.[^.]+$/, 'resume.pdf')]
    .filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No resume file found. Tried: ${candidates.join(', ')}`);
}

export async function parseResumeFile(filePath) {
  const resolvedPath = await resolveResumePath(filePath);
  const buffer = await readFile(resolvedPath);
  let text = '';

  if (resolvedPath.endsWith('.txt') || resolvedPath.endsWith('.md')) {
    text = buffer.toString('utf8');
  } else if (resolvedPath.endsWith('.pdf')) {
    try {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = pdfParseModule.default ?? pdfParseModule;
      const parsed = await pdfParse(buffer);
      text = parsed.text;
    } catch {
      throw new Error('Unable to parse resume PDF. Install dependencies and provide a readable PDF.');
    }
  } else {
    text = buffer.toString('utf8');
  }

  return {
    path: resolvedPath,
    text,
    skills: extractSkillKeywords(text),
    summary: text.slice(0, 4000),
  };
}
