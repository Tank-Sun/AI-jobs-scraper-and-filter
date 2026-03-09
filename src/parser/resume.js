import { readFile } from 'node:fs/promises';

function normalizeSkill(token) {
  return token.toLowerCase().replace(/[^a-z0-9+.#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractSkillKeywords(text) {
  const matches = text.match(/[A-Za-z0-9+.#-]{2,}/g) ?? [];
  return [...new Set(matches.map(normalizeSkill).filter(Boolean))];
}

export async function parseResumeFile(filePath) {
  const buffer = await readFile(filePath);
  let text = '';

  if (filePath.endsWith('.txt') || filePath.endsWith('.md')) {
    text = buffer.toString('utf8');
  } else if (filePath.endsWith('.pdf')) {
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
    text,
    skills: extractSkillKeywords(text),
    summary: text.slice(0, 4000),
  };
}
