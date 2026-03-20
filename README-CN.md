# jobs-filter

这是一个用于 LinkedIn Jobs 的抓取、筛选和 AI 打分工具。

当前流程是：
- 从你已打开的 LinkedIn Jobs 搜索结果页抓取职位
- 保存职位详情到 `reports/<run>/raw-jobs.json`
- 用 `requirements + resume + job information` 让 AI 做 reject / shortlist / score
- 输出 `shortlist.csv`、`shortlist.md`、`rejected.md`、`run-summary.json`

## 快速开始

### 1. 安装依赖

在 WSL 中运行：

```bash
cd ~/job-search-2026/jobs-filter
npm install
```

### 2. 准备文件

项目默认会读取：
- `.env`
- `data/requirements.md`
- `data/resume.md`

仓库中提供的模板文件：
- `data/requirements.example.md`
- `data/resume.example.md`
- `.env.example`

### 3. 配置 `.env`

最小配置示例：

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
PLAYWRIGHT_CDP_URL=http://WINDOWS_HOST_IP:9223
```

说明：
- `GEMINI_API_KEY`：AI 打分必需。
- `GEMINI_MODEL`：默认可用 `gemini-2.5-flash`。
- `PLAYWRIGHT_CDP_URL`：程序用它连接 Chrome 的远程调试端口。

## 日常运行步骤

### 1. 在 Windows 启动 Chrome

在 PowerShell 中运行：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-codex"
```

建议一直复用同一个 `user-data-dir`，这样通常不需要每次重新登录 LinkedIn。

### 2. 打开并确认 LinkedIn Jobs 搜索结果页

在这个 Chrome 里：
- 确认已经登录 LinkedIn
- 打开一个 LinkedIn Jobs 搜索结果页
- 手动设置好关键词、地区、Remote / On-site、Experience level 等筛选条件

### 3. 在 WSL 抓取职位

```bash
cd ~/job-search-2026/jobs-filter
node src/cli/index.js --mode=scrape --source=live
```

### 4. 在 WSL 对最新一次抓取结果打分

```bash
node src/cli/index.js --mode=score
```

### 5. 如果只想看前 20 条 shortlist

```bash
node src/cli/index.js --mode=score --limit=20
```

## 运行模式

### `scrape`

只抓取职位详情并生成：
- `raw-jobs.json`
- `run-summary.json`
- `collected-job-links.json`（live scrape 时）

### `score`

读取某次抓取结果并生成：
- `shortlist.csv`
- `shortlist.md`
- `rejected.md`
- `scoring-failures.md`
- `run-summary.json`

默认会读取最新一次抓取结果；也可以显式指定：

```bash
node src/cli/index.js --mode=score --runDir=reports/YOUR_RUN_DIR
```

### `run`

一次执行抓取和打分：

```bash
node src/cli/index.js --mode=run --source=live
```

## 输出文件说明

每次运行会在 `reports/` 下生成一个目录，例如：

```text
reports/2026-03-16_00-10-43_MT/
```

常见文件：
- `raw-jobs.json`：抓到的原始职位数据
- `processed-jobs.json`：去重后的职位数据
- `shortlist.csv`：最适合人工继续查看的岗位
- `shortlist.md`：同样内容的 Markdown 版本
- `rejected.md`：被 AI 判定为 reject 的岗位及原因
- `run-summary.json`：这次运行的汇总数字
- `scoring-cache.json`：AI 打分缓存
- `collected-job-links.json`：live scrape 时已收集到的 LinkedIn job URLs

## 如果 Scrape 中途卡住

如果 live scrape 卡在翻页或最后一页附近，不用从零开始。

程序会把已抓到的链接实时写到当前 run 目录的 `collected-job-links.json`。

例如：

```text
reports/2026-03-13_09-30-00_MT/collected-job-links.json
```

如果中途卡住，可以对同一个 runDir 重跑：

```bash
node src/cli/index.js --mode=scrape --source=live --runDir=reports/YOUR_RUN_DIR
```

如果该目录里已经有 `collected-job-links.json`，程序会优先复用已保存的链接继续抓详情。

如果已经有 `raw-jobs.json`，就不需要重跑 scrape，直接跑：

```bash
node src/cli/index.js --mode=score --runDir=reports/YOUR_RUN_DIR
```

## Windows / WSL 连接 Chrome 说明

常见做法是：
- Chrome 在 Windows 上监听 `127.0.0.1:9222`
- 通过 Windows 端口转发，把一个 WSL 可访问的地址转发到该端口
- 在 `.env` 里把 `PLAYWRIGHT_CDP_URL` 指向这个转发后的地址

例如：
- Chrome 调试端口：`127.0.0.1:9222`
- WSL 访问地址：`http://WINDOWS_HOST_IP:9223`

不同机器的 `WINDOWS_HOST_IP` 可能不同，不要把别人的 IP 直接照抄到自己的 `.env`。

## 抓取安全建议

- 这套方式本质上仍然是自动化访问 LinkedIn，存在风控风险。
- 建议低频使用，不要连续高频反复抓很多页。
- 更常见的风险通常不是直接封号，而是要求重新登录、出现验证码、或者某次抓取拿不到完整结果。
- 如果 LinkedIn 明显出现验证码、额外验证或页面异常，先停下来，不要继续硬跑。

## 当前筛选方式

当前评分主流程是 AI-first：
- 不再依赖大量脆弱的业务 hard filter 先砍岗位
- AI 直接根据 `requirements + resume + job information` 做 reject / shortlist / score
- 输出结果后，再由你人工看 shortlist 前几条

整体偏好大致是：
- `full stack` 优先
- `fitted backend` 次之
- `frontend` 也可以，但不是唯一优先方向
- `AI product / AI-powered features / user-facing application work` 强正向
- `consulting / bodyshop / low-level systems / data science / ML modeling / native mobile / Java/.NET-heavy core stacks` 通常偏弱或会被 reject

说明：
- 仓库里仍然保留 `applyHardFilters()` 这套 deterministic 逻辑。
- 但它现在被视为 legacy / 备用模式，不是默认运行路径的一部分。
- 当前默认行为是 AI-first：`score` 阶段不会先调用 deterministic business filtering。

