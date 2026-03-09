import { access, readFile } from 'node:fs/promises';

export async function collectJobs({ rawJobsPath }) {
  try {
    await access(rawJobsPath);
    const raw = await readFile(rawJobsPath, 'utf8');
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs)) {
      throw new Error('Raw jobs file must contain an array');
    }
    return jobs;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('No raw jobs input found yet. Save sample jobs to reports/raw-jobs.json or wire up Playwright scraping next.');
    }
    throw error;
  }
}
