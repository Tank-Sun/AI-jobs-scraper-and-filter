# jobs-filter

A LinkedIn Jobs scraping, filtering, and AI scoring tool.

Current flow:
- Scrape jobs from a LinkedIn Jobs search results page that you already opened
- Save job details to `reports/<run>/raw-jobs.json`
- Use `requirements + resume + job information` to let AI decide reject / shortlist / score
- Output `shortlist.csv`, `shortlist.md`, `rejected.md`, and `run-summary.json`

## Quick Start

### 1. Install dependencies

Run in WSL:

```bash
cd ~/job-search-2026/jobs-filter
npm install
```

### 2. Prepare files

By default the project reads:
- `.env`
- `data/requirements.md`
- `data/resume.md`

Template files included in the repo:
- `data/requirements.example.md`
- `data/resume.example.md`
- `.env.example`

### 3. Configure `.env`

Minimal example:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
PLAYWRIGHT_CDP_URL=http://WINDOWS_HOST_IP:9223
```

Notes:
- `GEMINI_API_KEY`: required for AI scoring.
- `GEMINI_MODEL`: `gemini-2.5-flash` is the default recommended model.
- `PLAYWRIGHT_CDP_URL`: used to connect to Chrome's remote debugging port.

## Daily Run Steps

### 1. Start Chrome on Windows

Run in PowerShell:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-codex"
```

It is recommended to reuse the same `user-data-dir`, so you usually do not need to sign in to LinkedIn every time.

### 2. Open and confirm a LinkedIn Jobs search results page

In that Chrome window:
- Make sure you are signed in to LinkedIn
- Open a LinkedIn Jobs search results page
- Manually set filters such as keywords, location, Remote / On-site, and Experience level

### 3. Scrape jobs in WSL

```bash
cd ~/job-search-2026/jobs-filter
node src/cli/index.js --mode=scrape --source=live
```

### 4. If you only want to retry timed-out detail pages from a previous run

```bash
node src/cli/index.js --mode=scrape --source=live --runDir=reports/YOUR_RUN_DIR --retry-failed-details
```

This reads `failed-detail-urls.json` from that run directory, retries only those detail pages, and merges successful retries back into the same `raw-jobs.json`.

### 5. Score the latest scrape result in WSL

```bash
node src/cli/index.js --mode=score
```

### 6. If you only want the top 20 shortlist items

```bash
node src/cli/index.js --mode=score --limit=20
```

## Run Modes

### `scrape`

Only scrapes job details and generates:
- `raw-jobs.json`
- `run-summary.json`
- `collected-job-links.json` (for live scrape)
- `failed-detail-urls.json` (when some detail pages time out)

### `score`

Reads one scrape result and generates:
- `shortlist.csv`
- `shortlist.md`
- `rejected.md`
- `scoring-failures.md`
- `run-summary.json`

By default it reads the latest scrape result. You can also specify a run explicitly:

```bash
node src/cli/index.js --mode=score --runDir=reports/YOUR_RUN_DIR
```

### `run`

Runs scrape and score in one command:

```bash
node src/cli/index.js --mode=run --source=live
```

## Output Files

Each run creates a directory under `reports/`, for example:

```text
reports/2026-03-16_00-10-43_MT/
```

Common files:
- `raw-jobs.json`: raw scraped job data
- `processed-jobs.json`: deduplicated job data
- `shortlist.csv`: jobs most worth manual review
- `shortlist.md`: Markdown version of the shortlist
- `rejected.md`: jobs rejected by AI and the reasons
- `run-summary.json`: summary numbers for the run
- `scoring-cache.json`: AI scoring cache
- `collected-job-links.json`: LinkedIn job URLs already collected during live scrape
- `failed-detail-urls.json`: detail-page URLs that still timed out and can be retried later

## If Scrape Gets Stuck Midway

If live scrape gets stuck while paging or near the last page, you do not need to restart from zero.

The program writes collected links in real time to `collected-job-links.json` in the current run directory.

For example:

```text
reports/2026-03-13_09-30-00_MT/collected-job-links.json
```

If it gets stuck, rerun against the same runDir:

```bash
node src/cli/index.js --mode=scrape --source=live --runDir=reports/YOUR_RUN_DIR
```

If that directory already contains `collected-job-links.json`, the program will reuse those saved links first and continue scraping details.

If some detail pages timed out, the scraper writes them to `failed-detail-urls.json` in the same run directory. You can retry only those failed detail pages with:

```bash
node src/cli/index.js --mode=scrape --source=live --runDir=reports/YOUR_RUN_DIR --retry-failed-details
```

If `raw-jobs.json` already exists, you do not need to rerun scrape. Just run:

```bash
node src/cli/index.js --mode=score --runDir=reports/YOUR_RUN_DIR
```

## Windows / WSL Chrome Connection Notes

A common setup is:
- Chrome listens on `127.0.0.1:9222` on Windows
- Windows port forwarding exposes a WSL-accessible endpoint to that port
- `.env` points `PLAYWRIGHT_CDP_URL` to that forwarded endpoint

For example:
- Chrome debugging port: `127.0.0.1:9222`
- WSL-accessible endpoint: `http://WINDOWS_HOST_IP:9223`

`WINDOWS_HOST_IP` may differ across machines. Do not copy someone else's IP into your own `.env`.

## Scraping Safety Notes

- This workflow is still automated access to LinkedIn and does carry account-risk / rate-limit risk.
- Use it at a low frequency. Avoid repeatedly scraping many pages in a short period.
- The more common failure modes are re-login prompts, CAPTCHA, or incomplete scrape results, not necessarily an immediate ban.
- If LinkedIn starts showing CAPTCHA, extra verification, or clearly abnormal pages, stop and do not keep pushing the scraper.

## Current Screening Strategy

The current scoring pipeline is AI-first:
- It no longer depends on a large brittle business hard-filter layer to reject jobs first
- AI decides reject / shortlist / score directly from `requirements + resume + job information`
- You then manually review the top shortlist results

Current preference shape:
- `full stack` first
- `fitted backend` second
- `frontend` is also acceptable, but not the only preferred direction
- `AI product / AI-powered features / user-facing application work` is strongly positive
- `consulting / bodyshop / low-level systems / data science / ML modeling / native mobile / Java/.NET-heavy core stacks` are usually weak fits or likely rejects

Notes:
- The repo still keeps `applyHardFilters()` and related deterministic logic.
- But that logic is now considered legacy / backup mode, not part of the default runtime path.
- The default `score` flow does not run deterministic business filtering first.
