## JS 本地 LinkedIn 职位筛选器（规则主导 + AI 兜底）实施计划

### Summary
- 在 `~/job-search-2026` 新建一个 Node.js CLI 工具，无需 UI。
- 你手动登录并打开 LinkedIn Job Search 页面后，工具用 Playwright 抓取“列表 + 每个职位详情”信息。
- 读取 `resume.pdf` 与 `requirements.md`，先做规则硬过滤（location、company size、visa、employment type 等），仅在字段缺失或模糊时用 Gemini 1.5 Flash 做硬条件补判，再对通过项做软评分排序。
- 输出 `Top 50`，同时生成 `CSV + Markdown` shortlist，包含总分和分项分数，附职位链接供你手动投递。

### Implementation Changes
- 项目结构与技术栈
  - `Node.js + JavaScript (ESM)`，核心依赖：`playwright`, `pdf-parse`, `csv-writer`（或等价）, `zod`, `dotenv`。
  - 目录：`src/cli`, `src/scraper`, `src/parser`, `src/filter`, `src/scoring`, `src/output`, `config`, `data`, `reports`。
- 输入与配置约定
  - `data/resume.pdf`：你的简历 PDF。
  - `data/requirements.md`：你的筛选要求（定义固定模板字段：must_have_locations、must_have_company_size、must_have_employment_types、must_have_visa_policy、target_titles、nice_to_have_skills、red_flags、weights）。
  - `config/normalization.json`：location、employment type、company size 等字段的归一化词典与区间映射。
  - `.env`：`GEMINI_API_KEY`。
- 抓取流程（Playwright）
  - CLI 启动后连接本地浏览器会话（默认 Chromium），要求你已登录 LinkedIn 并打开目标搜索结果页。
  - 自动滚动加载列表，收集职位卡片 URL，再逐个打开详情页提取字段：title、company、location、posted time、applicant info、employment type、visa/sponsorship、company size、job description、job url。
  - 保存原始抓取结果到 `reports/raw-jobs.json`，用于复跑调试。
- 解析与过滤
  - `resume.pdf` 转文本后提取技能关键词集合（规则提取 + 简单归一化）。
  - `requirements.md` 解析成结构化对象。
  - 先执行规则硬过滤：location、company size、visa/sponsorship、employment type 等字段做标准化匹配，不满足 must 条件的职位直接剔除并记录原因。
  - location 使用“归一化词典 + bucket”匹配，例如把 `Greater Denver Area`、`Denver, CO`、`Hybrid in Denver` 映射到同一 location bucket。
  - company size 使用区间映射，例如 `11-50`、`51-200`、`201-500`。
  - 当职位字段缺失、描述模糊或规则判断低置信度时，才调用 Gemini 做“是否满足硬条件”的补判，并标记 `low_confidence`。
- 评分（Gemini 1.5 Flash）
  - 只对通过硬过滤或被 AI 补判放行的职位调用 Gemini，输入：职位信息 + 简历摘要 + requirements 结构化内容。
  - Gemini 主要负责软评分：技能匹配、职责匹配、成长性、简历 gap 分析。
  - 统一输出 JSON：`total_score(0-100)` + 分项分（skills/responsibilities/growth/title/seniority/risk）+ `why_recommended` + `gaps`。
  - 增加重试与速率控制（指数退避 + 并发上限），失败项标记为 `scoring_failed` 但不中断整体流程。
- 输出结果
  - `reports/shortlist.csv`：按总分降序，字段包含总分、分项分、关键理由、职位链接。
  - `reports/shortlist.md`：可读版清单（Top 50），每条含排名、分数、公司、地点、摘要理由、链接。
  - `reports/rejected.md`：硬过滤被拒职位及原因，便于你调整 requirements。
  - `reports/needs-review.md`：规则低置信度且依赖 AI 补判的职位，便于你人工 audit。

### Test Plan
- 单元测试
  - `requirements.md` 解析正确性（正常模板、缺字段、格式错误）。
  - 硬过滤规则（location/company size/visa/employment type/title）边界场景。
  - 归一化词典与 bucket 映射正确性（例如 Denver 相关变体归并）。
  - AI 硬条件补判结果 schema 校验（Gemini 返回异常/缺字段时的兜底）。
  - 软评分结果 schema 校验（Gemini 返回异常/缺字段时的兜底）。
- 集成测试
  - 用 5-10 条 mock 职位数据跑完整流水线，验证硬过滤、AI 补判、排序与文件生成。
  - 真实页面小样本抓取（10-20 职位）验证抓取稳定性、详情页字段完整性、链接可点击。
- 验收标准
  - 单次运行可稳定输出 `CSV + MD + rejected + needs-review` 四份结果。
  - shortlist 默认 50 条（不足则输出实际数量）。
  - 每条推荐都有总分、分项分、理由和原始职位链接。
  - 硬过滤被拒职位必须带确定性拒绝原因；AI 补判职位必须带 `low_confidence` 标记。

### Assumptions And Defaults
- 运行环境为你本机本地执行，不部署云端，不做 fancy UI。
- 你负责在运行前登录 LinkedIn 并打开目标搜索结果页。
- 第一版聚焦英文职位文案解析（中文职位可处理但不做专项优化）。
- 先按模板化 `requirements.md` 输入；若你后续想改成 JSON，可在第二迭代加双格式兼容。
- 默认采用“规则主导 + AI 兜底”策略，不把所有硬过滤都交给模型判断。
- 若 Gemini 调用受限，流程仍完成；硬过滤继续按规则执行，无法补判或评分的职位输出“未评分”或“待人工确认”标记，不阻断其余职位处理。
