# jobs-filter

## 快速运行

每次运行时，按这个顺序做：

1. 在 PowerShell 启动 Chrome：

    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-codex"

2. 在这个 Chrome 里确认已经登录 LinkedIn，并且浏览器停在 LinkedIn Jobs 搜索结果页。

3. 在 WSL 里抓取职位：

    cd ~/job-search-2026/jobs-filter
    node src/cli/index.js --mode=scrape --source=live

4. 在 WSL 里对最新一次抓取结果打分：

    node src/cli/index.js --mode=score

5. 如果你只想看前 20 条 shortlist：

    node src/cli/index.js --mode=score --limit=20

补充说明：

- 第一次使用这个 Chrome profile 时，需要手动登录 LinkedIn。
- 在这台机器上，WSL 通过转发后的地址 http://172.19.16.1:9223 连接 Chrome。
- 之后通常不用每次重新登录，只要登录状态还有效就行。
- 如果你今天只想重跑打分，不重新抓取，直接运行第 4 步。

## 抓取安全建议

- 现在这套方式已经基本可用，但仍然属于自动化访问 LinkedIn，存在一定风控风险。
- 建议低频使用，比如一天跑 1 到 3 次，每次抓几十条到一两百条，不要连续高频反复跑。
- 更常见的风险通常不是直接封号，而是要求重新登录、出现验证码、或者某次抓取突然拿不到完整结果。
- 如果 LinkedIn 明显出现验证码、额外验证、页面异常，先停下来，不要继续硬跑。

## 端口说明

- Chrome 自己在 Windows 上监听 127.0.0.1:9222。
- 在这台机器上，WSL 不能直接连这个 9222 端口。
- Windows 会把 172.19.16.1:9223 转发到 Chrome 的 127.0.0.1:9222。
- 所以 PowerShell 里的 Chrome 启动命令仍然要用 --remote-debugging-port=9222。
- 而 .env 里的 PLAYWRIGHT_CDP_URL 应该指向 http://172.19.16.1:9223。

简化理解：

- 9222 = Chrome 自己的调试端口
- 9223 = WSL 实际连接的转发端口

## 如果 Scrape 连不上

通常你会在运行 scrape 时发现这个问题，例如：

    node src/cli/index.js --mode=scrape --source=live

常见表现：

- connect ECONNREFUSED
- browserType.connectOverCDP failed
- scrape 无法连接 Chrome 调试端点

按这个顺序检查：

1. 先确认 Chrome 是用下面这个 PowerShell 命令启动的：

    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-codex"

2. 在 WSL 里检查当前 Windows 主机 IP：

    ip route | awk '/default/ {print $3}'

3. 把这个 IP 和 .env 里的 PLAYWRIGHT_CDP_URL 对比一下。

4. 如果 IP 变了，把 .env 改成这样：

    PLAYWRIGHT_CDP_URL=http://CURRENT_WINDOWS_IP:9223

5. 再试一次 scrape。

6. 只有还不行时，再回管理员 PowerShell 里重跑 portproxy 和防火墙命令。

这是一个面向 LinkedIn Jobs 的筛选工具。
它会先从你当前打开的 LinkedIn Jobs 页面抓职位，再做去重、硬过滤和 AI 打分，最后输出 shortlist。

## 现在是不是差不多可以跑了

可以，已经到了按流程可用的状态。

目前项目里已经有：

- scrape 模式：连接浏览器，抓 LinkedIn 职位
- score 模式：读取 raw-jobs.json，做过滤和打分
- run 模式：一次跑完 scrape + score

我刚刚在本地跑过测试，10 个测试全部通过。

需要注意的是，live 抓取是否稳定，仍然取决于这些前提：

- Chrome 已经以远程调试模式启动
- LinkedIn 处于登录状态
- Chrome 里已经打开一个 LinkedIn Jobs 搜索结果页
- .env、data/requirements.md、data/resume.md 已准备好

## 先回答你的关键问题

### 每次都需要重新登录 LinkedIn 吗

不一定。

准确说法是：

- 每次做 live 抓取前，都需要有一个已经打开的、可连接的 Chrome
- 这个 Chrome 里需要有一个已登录的 LinkedIn Jobs 页面
- 但是如果你一直复用同一个 Chrome profile，登录状态通常会保留

所以一般情况是：

- 第一次使用：需要登录 LinkedIn
- 之后多数时候：不用重新登录，只需要确认登录状态还在

通常只有下面几种情况才需要重新登录：

- 你换了新的 Chrome profile 目录
- 你删了原来的 profile 目录
- LinkedIn 会话过期
- 这个专用 Chrome 本来就没有登录

## 默认工作方式

以后建议全部从 WSL 发起，不用来回切 PowerShell。

虽然 Chrome 是 Windows 程序，但你可以直接在 WSL 里启动它。

## 首次配置

### 1. 安装依赖

在 WSL 中执行：

    cd ~/job-search-2026/jobs-filter
    npm install

### 2. 准备输入文件

项目默认使用这几个文件：

- data/requirements.md
- data/resume.md
- .env

如果你要参考模板，可以看：

- data/requirements.example.md

当前仓库里已经有：

- data/requirements.md
- data/resume.md
- data/resume.pdf

### 3. 配置 .env

最小配置如下：

    GEMINI_API_KEY=你的_key
    GEMINI_MODEL=gemini-2.5-flash
    PLAYWRIGHT_CDP_URL=http://172.19.16.1:9223

说明：

- GEMINI_API_KEY：AI 打分会用到
- GEMINI_MODEL：默认保留 gemini-2.5-flash 即可
- PLAYWRIGHT_CDP_URL：程序通过它连接到 Chrome

通常先直接用 http://127.0.0.1:9222。
如果 WSL 无法连通，再改成 Windows 主机 IP 对应的地址。

## 每次具体操作流程

推荐你日常都按下面这个顺序来。

### 步骤 1：在 WSL 里启动 Windows Chrome

在 WSL 里执行：

    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-codex"

说明：

- 这是在 WSL 里直接启动 Windows Chrome
- --remote-debugging-port=9222 是给 Playwright 连接用的
- --user-data-dir=C:\tmp\chrome-codex-linkedin 会把登录状态保存在一个固定目录里

建议一直复用同一个 user-data-dir，这样以后通常不用反复登录。

### 步骤 2：确认 LinkedIn 已登录

第一次用这个 profile 时：

- 打开 LinkedIn
- 手动登录

后续再跑时：

- 只要登录状态还在，这一步可以直接跳过

### 步骤 3：在 Chrome 里打开 LinkedIn Jobs 搜索结果页

运行抓取前，Chrome 当前上下文里必须已经有一个 LinkedIn Jobs 页面。

例如页面 URL 形态类似：

- https://www.linkedin.com/jobs/...

建议你先手动把搜索条件调好，比如：

- 关键词
- 地区
- Remote 或 On-site
- Experience level
- Easy Apply

这个工具会从你当前打开的 Jobs 搜索结果页继续抓，不会替你自动输入搜索词。

### 步骤 4：在 WSL 里先抓取

    cd ~/job-search-2026/jobs-filter
    node src/cli/index.js --mode=scrape --source=live

这一步会：

- 连接到上面那个 Chrome
这是一个面向 LinkedIn Jobs 的筛选工具。
- 读取职位卡片
- 逐个打开详情页抓内容
- 输出 reports/2026-03-11_00-34-41_MT/raw-jobs.json

如果你只想先少抓一点做测试：

    node src/cli/index.js --mode=scrape --source=live --scrapeLimit=40

### 步骤 5：在 WSL 里再打分

    node src/cli/index.js --mode=score

这一步不再依赖 LinkedIn 页面，也不要求 Chrome 保持打开。
它会：

- 读取 raw-jobs.json
- 去重
- 做 hard filter
- 调用 Gemini 做 soft scoring
- 生成 shortlist 和 rejected 报告

如果你只想看前 20 条 shortlist：

    node src/cli/index.js --mode=score --limit=20

## 最推荐的日常用法

### 方案 A：分两步跑，最稳

这是最推荐的方式：

    node src/cli/index.js --mode=scrape --source=live
    node src/cli/index.js --mode=score

优点：

- 抓取和打分分开，更容易排查问题
- 抓取成功以后，可以反复重跑 score
- 不需要每次都重新去 LinkedIn 抓数据

### 方案 B：一条命令跑完

    node src/cli/index.js --mode=run --source=live

这个等价于：

1. 先 scrape
2. 再 score

等你确认流程稳定以后，可以用这个一把跑完。

## 真正的每次操作清单

如果你只是想知道每天到底按什么顺序跑，就按这个版本：

### 场景 1：今天要抓新的职位

1. 在 WSL 启动上面的 Chrome 命令
2. 确认这个 Chrome 里的 LinkedIn 还是登录状态
这是一个面向 LinkedIn Jobs 的筛选工具。
4. 在 WSL 运行：

    cd ~/job-search-2026/jobs-filter
    node src/cli/index.js --mode=scrape --source=live
    node src/cli/index.js --mode=score

### 场景 2：今天只想重跑打分

如果 raw-jobs.json 已经有了，那就不需要打开 Chrome，也不需要重新登录 LinkedIn，直接：

    cd ~/job-search-2026/jobs-filter
    node src/cli/index.js --mode=score --runDir=reports/EXISTING_RUN_DIR

这也是为什么我更推荐分成 scrape 和 score 两步来跑。

## 输出文件说明

每个 run 目录里通常会有：

- raw-jobs.json：原始抓取结果
- processed-jobs.json：去重后的职位数据
- scoring-cache.json：AI 打分缓存
- shortlist.csv：适合表格查看
- shortlist.md：适合直接阅读
- rejected.md：被过滤掉的职位和原因
- scoring-failures.md：AI 打分失败项
- run-summary.json：本次运行摘要

## 缓存机制

score 阶段会写入：

- reports/EXISTING_RUN_DIR/scoring-cache.json

这意味着：

- 同一批 raw-jobs.json 可以重复打分
- 你调整 shortlist 数量或部分规则时，不一定每次都要重新请求 AI

## 常见报错

### 报错：Open a LinkedIn jobs search page in the connected browser before running the CLI.

说明 Chrome 虽然连上了，但当前打开的不是 LinkedIn Jobs 搜索页。

处理方法：

- 在那个被远程调试的 Chrome 里打开 LinkedIn Jobs 页面
- 不要只停在 LinkedIn 首页

### 报错：No browser context found. Launch Chrome with remote debugging and keep one window open.

说明程序没有连到一个可用的 Chrome。

处理方法：

- 重新执行上面的 Chrome 启动命令
- 确保至少有一个窗口开着

### 报错：连不上 127.0.0.1:9222

处理方法：

1. 确认 Chrome 是带 --remote-debugging-port=9222 启动的
2. 确认 .env 里的 PLAYWRIGHT_CDP_URL 没写错
3. 如果 WSL 下 127.0.0.1:9222 不通，再改成 Windows 主机 IP

### 报错：AI 打分失败

先检查：

- GEMINI_API_KEY 是否有效
- 当前网络是否可访问 Gemini API

程序会把失败项写到：

- scoring-failures.md

## 一句话版本

如果你要一个最简单的使用习惯，那就是：

- 固定使用同一个 Chrome profile
- 第一次登录 LinkedIn
- 以后多数时候不用重新登录
这是一个面向 LinkedIn Jobs 的筛选工具。
- 想重看结果或改规则时，只跑 score

这样你日常基本就可以全部在 WSL 里完成。
