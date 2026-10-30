---
title: 首轮审计 · 协议视角
version: v1.18.0
created: 2026-10-29
status: final
---

# 02 — MCP 协议与工具面审计（`src/index.js` 全量）

> 审计员：protocol-auditor（task-2）。只读 `src/`、`scripts/`；**未运行任何付费 run**（paid-smoke / cross-cases / e2e 均未执行），没有 npm install、没有联网。
> 方法：① `src/index.js` 1795 行逐行；② 交叉核对 `src/claude.js`（runClaude/killTree/guard settings/CLI 解析）、`src/prompt.js`（native 命令/allowlist）、`package.json`、已安装 SDK；③ 免费真机探针：真实 spawn server 通过 stdio 做 `initialize` / `tools/list` / 15 个 `tools/call`（其中 8 个 review 调用全部用不存在的 repoPath，在 spawn claude 之前就失败）+ 一次 `claude_review_env`（纯本地探测，255ms）。
> 环境实测：Node 26.12.1，SDK **1.32.1**（`^1.12.0` 解析结果），zod 3.25.76，claude 2.1.133。
> 与同伴审计的去重：`04-P1-3`（baseRef 空格注入 `--fix`/`--comment`）、`04-P2-7`（focus 换行）、`04-P3-1/P3-2/P3-3`（outputLanguage / sanitizeBaseRef / validatePr）、`04-P3-4`（followup 提示词承诺）、`04-P2-10`（env 诊断文本）、L5/L6（listChanged、outputSchema）、SEC-12/R-18（activeSubagentFiles 死代码）、R-5/R-20/R-21（进程树、信号退出码）、L4（unhandledRejection）**均已由他人覆盖，本文不重复计数**；仅在其上补充协议面/工具面角度。

---

## 0. 结论总览

| 级别 | 数量 | 条目 |
|---|---|---|
| P0 | 0 | 本文件范围内未发现可远程触发/数据损坏级问题（注入面仍被权限层兜住，见 P-00 说明） |
| P1 | 2 | P-01 空报告按 success 返回；P-02 sync 被取消后付费结果不可达 |
| P2 | 8 | P-03 ~ P-10 |
| P3 | 10 | P-11 ~ P-20 |

**P-00 为什么没有 P0**：本文件审查的协议面里唯一能改变执行语义的入口是 native 命令串，但 `baseRef` 空格注入（04-P1-3）受两道权限层约束——`fix=false` 时 `Edit/Write/NotebookEdit` 被无条件 deny（`src/prompt.js:457-460`），`postToPR=false` 时 `Bash(gh pr comment:*)` 不在 allowlist（`src/index.js:1093`）；`focus` 换行（04-P2-7）只是同一调用方对自己付费 run 的提示词改写，不越权。故记为 P1 而非 P0。

---

## P1

### P-01 [P1] 空报告以 `isError:false` + `status:"success"` 返回：客户端无法区分“评审干净”与“评审根本没产出”

**证据**
- `src/index.js:1215-1217`：`ok = j.subtype === "success" && j.is_error !== true && !looksLikeApiError` —— **完全没有检查 `j.result` 是否为空**；`looksLikeApiError` 只匹配 `/^API Error/i`（1215）。
- `src/index.js:1368-1375`：`ok` 为真即返回 `structuredContent: { status: "success", report: j.result, ... }`（report 可能是 `""`）。
- `src/index.js:327-336`：文本通道把空报告渲染成 `"(claude returned an empty report)"`，随后仍附 `- status: success` 的 metadata；**没有任何 warning，isError 保持 false**。
- 触发路径真实存在：`src/claude.js:1578-1581` 的注释自述“forked slash command 报 `num_turns 0` + 空 result，答案在合成 assistant message 里”，修复代码 `if (json && !json.result && lastAssistantText) json.result = lastAssistantText` **只覆盖 stream-json 路径**（`lastAssistantText` 由流事件累积）；当 `supportsStreamJson(cli)` 为 false（help 文本读不到/包装脚本，`src/claude.js:926-929` 的 `supportsFlag` 失败即 false）时走 `--output-format json`（`src/claude.js:1259-1260`），此时没有任何流事件，空 result 原样成为“成功报告”。

**复现/影响**：包装过的 claude（gateway shim、自定义 wrapper）或 help 探测失败的机器上，一次已付费的 native review 会返回 `status: "success"`、`report: ""`、`isError` 缺失。ZCode 里的 agent 若按 `status`/`isError` 判断，会把“没产出”当成“没有 finding”，用户可能据此合并代码。文本里的 “(claude returned an empty report)” 是唯一提示，但结构化通道没有任何降级标记。

**修复**：在 `ok` 判定前加 `const emptyReport = !String(j.result || "").trim();`，为空时走 `isError: true` + `structuredContent.status = "empty_report"` + 可操作提示（检查 `--output-format stream-json` 支持、看 logFile），并在 `runMetaLines` 输出 `- warning: claude returned an empty report`。同步修 `claude.js:1578-1581` 的非流路径（json 模式可读 assistant 数组拼接答案）。

### P-02 [P1] `waitForResult=true` 被客户端取消/超时后，已付费的 subagent 报告与 JSONL 路径全部不可达

**证据**
- 同步路径直接 `return executeRun(...)`（`src/index.js:1398`），**不创建 job**（对比异步 1400-1432 会 `reviewJobs.set`）。
- 请求被取消时 SDK 丢弃响应：`Protocol._onrequest` 的 `.then(result => { if (abortController.signal.aborted) return; ... })`（已安装 SDK `dist/esm/shared/protocol.js` 内同逻辑）；仓库自己的 `scripts/cancel-test.mjs:7-12` 也把这条写成已知行为。
- 而 `executeRun` 在取消时构造的 `interruptedResult`（`src/index.js:432-465`）恰恰携带唯一一份 recovered subagent 报告与 `subagentsFile` 路径——它随响应一起被丢弃。
- async 路径的工作成果会进 job registry（1408），sync 路径没有等价物；`claude_review_status` 只能按 jobId 或列 job（1450-1457），无法找到一次 sync 运行的结果。

**复现/影响**：文档（`src/index.js:880-881`）让“没有 30s 超时的客户端”用 `waitForResult=true`。但真实网络/客户端取消/用户点 Stop 都会 abort 请求：runClaude 被杀（计费停止，这点正确），然而已经花费的子 agent 报告、`partial_reports_file`、log 路径全部不进任何可查询结构。这正是项目自己在 `src/index.js:432-437` 声称“cancel 也不能让付费工作不可达”要防的失败模式，只是 async 路径修了、sync 路径漏了。

**修复**：sync 模式也先创建 `reviewJobs` 条目（不需要提前返回 jobId，但让后续 `claude_review_status`（不带 jobId 的列表 + 可选 jobId）能取到）；或在 job 列表里显示“sync run（由被取消的请求产生）”，并在 `interruptedResult` 里把 `subagentsFile` 同时写进 stderr 日志行。

---

## P2

### P-03 [P2] async job 的 `structuredContent` 在生命周期内有 4 种形状；`jobId` 在最终结果里消失；崩溃结果没有 structuredContent

**证据（全部为真实代码路径，探针验证了校验错误分支的形状）**
| 阶段 | 位置 | structuredContent 形状 |
|---|---|---|
| 初始调用 | `src/index.js:1431` | `{jobId,status:"running",repoPath,scope,effort,fix,startedAt}` |
| 轮询 running | `src/index.js:1489-1492` | `{jobId,status:"running",elapsedSec,subagentsSoFar,subagentsFile}` |
| 完成（success/failed run） | `src/index.js:1495` 原样返回 job.result | success 见 1370-1394、失败见 1341-1363，**没有 jobId** |
| job 崩溃/cancel/timeout | `src/index.js:1420,1745` → `err()`；或 `interruptedResult` 453-463 | `err()` **完全没有 structuredContent**；interrupted 有 `{status,...}` 但无 jobId |

附：校验类错误（`err()` 418-420）也没有 structuredContent —— 真机探针确认 `isError:true`、`structuredContent` 缺失、文本 `"MCP error -32602: Input validation error ..."`。

**影响**：客户端若按 `structuredContent.status` 做状态机（这是 `claude_review_status` 存在的主要理由），在 running→done 这一步 `jobId` 会凭空消失，且 done 之后 `status` 的语义从 “running” 变成 “success”/`subtype`；崩溃时整个对象消失。多 job 客户端无法在最终结果里确认这是哪个 job，只能靠“最后一次 poll 的 jobId”上下文。工具没有 `outputSchema`（L6 已报），没有任何机器可读契约能约束这种形状漂移。

**修复**：让 `claude_review_status` 在返回 `job.result` 时补上统一外套：`{jobId, status, result: <原 result>}`（或至少在 result.structuredContent 里补 jobId）；为三个工具声明 `outputSchema`（同时解决 L6）；`err()` 增加最小 structured `{status:"error", code}`。

### P-04 [P2] 大结果无截断、双通道重复、每次 poll 重发：报告可能在 text+structured 里各来一份

**证据**
- 主报告本体**从不截断**：`src/index.js:1369` 文本里是 `runResultText(j.result, meta)`（完整 report），`1374` structuredContent 又放一份 `report: j.result`。
- 只截 subagent 报告，且两个通道阈值不同：文本 `subagentReportsText` 每 agent 4000 字符（`src/index.js:345-357`），structured `subagentsView` 每 agent 8000 字符（`423-430`）；截断标记是字符串 `"…(truncated)"`，不是机器可读字段。
- running 轮询**完全不截断**：`src/index.js:1472-1476` 把 `r.report` 原样塞进 `structuredContent.subagentsSoFar`（每条可能是一份完整 review），`1483` 只对文本行截 300 字符——**结构化的那份没有 cap**。
- 完成后每次 poll 都原样重发完整 result（`src/index.js:1495`），没有“已交付/摘要”模式。
- 上限参照：`src/claude.js:11` `MAX_STREAM_BYTES = 8MB`，报告理论最大接近 8MB；典型 fleet run 的 `subagentsSpawned` 可 >15（schema 描述 862-863 自述 max 结构上超过 15），structured 侧 15×8000 ≈ 120KB + 主报告，text 侧再 +60KB。

**影响**：stdio JSON-RPC 本身没有帧上限（newline-delimited，实测正常），但 ① 模型上下文双倍 token（同一三万字报告进两次）；② ZCode/客户端的工具结果大小限制直接失败；③ 每个 finished poll 重复注入同样的大结果，轮询两次就 double 成本；④ `subagentsSoFar` 让 running 轮询成为最大的消息来源，而它本应是“轻量进度”。

**修复**：主报告在 text 里超过 N KB 时截断并给 `full_text_file`；structuredContent 不再重复 text 的完整 report（或只在首次交付时给，后续 poll 给 `delivered:true`）；running 轮询的 subagentsSoFar 只给 `{description,status,reportChars}` 或短的 report（比如 ≤500 字符）；把截断做成布尔+原始长度字段。

### P-05 [P2] 同步阶段没有 30 秒预算：async 首包与 `claude_review_env` 都可能超过客户端截止

**证据（全为串行 await，无总超时）**
- async 首包**先跑完整预检**才返回 jobId；预检里的慢点：`claudeVersion`（30s，`src/claude.js:856-858`）、`claudeHelp`（30s，`899-901`，`prepareRunHardening` 与 `supportsFlag×3` 都会走到）、`gitPreflight` 两次 git（各 15s，`src/claude.js:1674`）、`ghPreflight` 两次 gh（各 15s，`src/index.js:393`）、`probeGateway`（2.5s，`claude.js:411`）、guardSelfTest（`src/index.js:575` 同步等待 3 次 hook spawn）。
- `claude_review_env`（**唯一没有 async 逃生门的工具**）：`claudeVersion`+4×`supportsFlag`（`695-707`，各 30s 上限）、guard self-test `refresh:true`（`719`）、git/gh 各 15s（`784-791`）。
- 健康机器实测：`claude_review_env` 255ms、initialize 101ms——正常时无问题；但该工具正是“环境坏了”时用户要调用的诊断工具，坏了的时候恰是最慢的路径（claude 卡住 30s + help 30s 就能超 30s）。

**影响**：a) 客户端在 async 首包上超时取消时既拿不到 jobId（`src/index.js:1411-1417` 会 abort 掉还没启动的 run），也看不到错误；b) env 工具在故障机上超时，用户失去唯一可自诊的入口。

**修复**：给每个探测一个 AbortSignal 总和预算（如 `probeBudgetMs=8s`，超时即返回“probe timed out/couldn't verify”），env 工具照常返回部分结果；async 首包把预检里非必要的探测（supportsFlag 可延迟到 spawn 前）移入 `executeRun`，让首包只剩 guard+repo 两个必要检查；文案承诺从“at once”改为“after a short free preflight”。

### P-06 [P2] 启动 prewarm 没有关闭“首调竞态”：handler 用的是同步 `resolveClaudeCli()`，冷窗口内首调仍报 NOT_FOUND

**证据**
- prewarm 明确用 settled 变体并 await 掉 npm-root 探测：`src/index.js:1779-1795`（`await resolveClaudeCliSettled()`）；`src/claude.js:230-242` 注释称该函数 “Closes the first-call race on installs reachable ONLY via a custom npm prefix”。
- 但三个工具入口全部用**同步** `resolveClaudeCli()`：`src/index.js:907`（review）、`1542`（followup）、`695`（env）。同步版本在 npm-root 探测未落地时只能看到 `npmRootCache === undefined`（`claude.js:139-155`），于是返回 null → review 直接 `err("Claude Code CLI not found. Install it (https://...)...")`（`907-910`）。
- 竞态窗口 = 启动后 npm root 探测落地前（注释自述冷 npm cache 可 ~10s，`claude.js:185-190`）。prewarm 在 connect 之后启动（`index.js:1774-1778`），客户端完全可能在这个窗口里发出首个工具调用。

**影响**：npm 全局前缀安装（非 PATH、非 well-known 目录）的机器上，host 启动后第一次 review/followup/env 失败并给出误导性“未安装”提示；用户重试后恢复。和 prewarm 注释承诺相反。

**修复**：三个 handler 改用 `await resolveClaudeCliSettled()`（已导出，改动 3 行）；或让 `resolveClaudeCli()` 在 npm 探测 in-flight 时返回一个 pending 状态由调用方 await。注意 env 工具的错误文案应区分 “not found yet (probe in flight)” 与 “not installed”。

### P-07 [P2] `logsDir()` 抛错打破两个契约：默认异步路径报 “review job crashed: <裸 fs 错误>”，同步模式泄漏 60s progress timer（请求结束后仍发 notification）

**证据**
- `logsDir()` 直接 `fs.mkdirSync(...)`（`src/index.js:96-104`），没有 try/catch；而下游 `writeLogFile` 是“best-effort”（`106-128` 整体 try/catch，失败只返回 `{error}`）——两种容错策略不一致。
- 调用点：`subagentsDir: logsDir()` 在 `executeRun` 内（`src/index.js:1179`）和 followup（`1652`），发生在 `runClaude` 之前；抛错路径：async 被 `.catch` 捕获成 `err("review job crashed: " + e.message)`（`1420`，无 structuredContent、无下一步建议），sync 直接抛给 SDK。
- timer 顺序：progressTimer 在 `1150-1156` 创建，`clearInterval` 在 `await runClaude(...)` 之后（`1191`）——**中间任何同步 throw 都不会 clear**；followup 同样（`1621-1627` / `1660`）。泄漏的 interval 每 60s 调 `extra.sendNotification`，请求早已结束 → SDK 客户端收到 `Received a progress notification for an unknown token` 类错误（SDK `_onprogress` 行为）。

**触发**：`CLAUDE_REVIEW_LOG_DIR` 指向文件/不可写目录/磁盘满，或 tmpdir 只读。注意 `claude.js:1353-1354` 本来有 “subagentsDir 缺省 → os.tmpdir()” 的 fallback，只是 index.js 传参时把 logsDir() 的异常提前抛了。

**修复**：把 `progressTimer` 的 clear 放进 `try/finally`；把 `logsDir()` 包成 `safeLogsDir()`（失败返回 undefined 并记 warning，让 claude.js 自己的 fallback 生效）；async catch 里附带可操作提示（“check CLAUDE_REVIEW_LOG_DIR”）。

### P-08 [P2] 没有并发控制：同 repo 并行 review 互相污染 fix 验证；同 sessionId 并行 followup 无锁

**证据**
- job 注册表只按随机 jobId 索引，没有任何 repoPath/sessionId 去重或排队逻辑（`src/index.js:90-95`、`1402-1408`；grep 全文件无 repoPath 比较/锁）。
- fix 验证用“运行前/运行后 `git status --porcelain` 字符串对比”归因到本次 run：`src/index.js:1132`（before）、`1247-1256`（after）。同 repo 的另一个 fix run 在这期间写入，会被 A 记成 “fix verification: N file(s) modified”；两个 run 写同一文件还会产生互相覆盖的编辑。
- followup 直接 `--resume <sessionId>`（`src/index.js:1642`），并发两个同 sessionId 的 followup 会同时读写同一个 claude session 文件，无任何检测。

**影响**：MCP 客户端普遍会并行发起工具调用（多个仓库/多个 question）。后果：a) fix 验证假阳性；b) 用户以为“review A 已修好”；c) 并发 resume 产生丢 turn/写竞争（claude 侧行为不可控）；d) 成本翻倍且没有提示。

**修复**：维护 `activeByRepo` / `activeBySession` 两个 Map，第二个同键请求返回可操作错误（“a review for <repo> is already running as job X”）或排队；fix 验证至少在同一 repo 的 lock 内串行。

### P-09 [P2] 进程被不可捕获信号/崩溃杀死时，detached claude 子进程成为孤儿继续计费，而注释承诺 “in-flight reviews are killed”

**证据**
- 承诺：`src/index.js:1766-1772` “Client went away (stdio closed): stop any in-flight review ... claude.js registers an 'exit' handler that kills the whole child tree”；`claude.js:496-515` 确实只覆盖 `SIGTERM/SIGINT/SIGHUP` + `exit`。
- 但 claude 子进程是产物组 leader 的 detached 进程（`src/claude.js:1296-1298` `detached: !IS_WIN`），父进程被 `SIGKILL`（OOM killer、host 强杀、系统休眠崩溃、Windows TerminateProcess）时 Node 不会执行任何 handler，子进程继续跑自己的 `--max-turns`/30min timeout；默认 `maxBudgetUsd=0` 也不封顶（`src/index.js:71, 869-870`）。
- Windows 侧同问题更直接（无 PDEATHSIG 等价物，R-20 已从进程树角度记录）。

**影响**：一次 OOM/强杀后，用户的钱继续按 30 分钟计；而且没有任何地方（job registry 也会随进程消失）能停掉它。

**修复**：默认给 `--max-budget-usd` 一个非零安全值（文档已解释 cap 的代价，可作为可选 suggestion）；或者 spawn 一个极小的 watchdog（父 pid 存活检查，父死则 kill 子进程组）；README/SECURITY 明确“SIGKILL 下无法保证停计费”。

### P-10 [P2] 默认 async 与 server `instructions`/工具描述不一致：按 instructions 走的模型不会轮询，拿不到报告

**证据**
- `src/index.js:519-527` 的 `instructions` 写的是 “Typical flow: claude_code_review(repoPath, scope) -> fix code -> claude_code_review again, or claude_review_followup(sessionId)”，**完全没提 `claude_review_status`，也没提默认返回 jobId**。
- `claude_code_review` 描述首句是 “Run Claude Code's code-review skill ... and return the markdown report”（`src/index.js:844-848`），“returns a jobId at once” 只藏在最后一个参数的 describe（`880-881`）。
- 实际默认路径首包返回的是 jobId 文本（`src/index.js:1422-1432`），session_id 只有在完成后才存在（`1304`、`1371`）——instructions 里“then followup(sessionId)”在默认 async 下第一步就拿不到 sessionId。

**影响**：只消费 server instructions 或首句描述、不细读参数说明的客户端模型，会把 “Review started in the background” 当最终答案回传用户；用户看到“已开始”却永远看不到报告（工具其实可用，是契约文案把模型带偏）。这不是风格问题：MCP 的 instructions 是客户端注入模型上下文的主要语义来源。

**修复**：instructions 改成 “claude_code_review 默认 async：先返回 jobId；用 claude_review_status(jobId) 轮询，完成后才有 session_id 供 followup；单次调用需要阻塞时用 waitForResult=true”；首句加 “(async by default — see waitForResult)”。

---

## P3

### P-11 [P3] `claude_review_status`：`cancel:true` 没有 jobId 时被静默忽略；list/无 job 分支没有 structuredContent
- 证据：`src/index.js:1449-1457` 先判 `if (!jobId)` 直接列表返回，此时 `cancel` 参数被丢弃（schema 却允许独立传 `cancel`，`1446-1448`）；list 分支与 no-jobs 分支都只给 text，无 structuredContent（对比 running 分支 1489-1492）。
- 影响：客户端传 `{cancel:true}` 期望报错或取消，实际得到作业列表；列表通道无法被结构化消费。
- 修复：`cancel && !jobId` → `err("jobId is required with cancel")`；列表分支补 `structuredContent: { jobs: [...] }`。

### P-12 [P3] `transport.onclose` 覆盖了 SDK 在 `connect()` 时安装的 onclose wrapper，跳过 SDK 的 `_onclose()` 清理
- 证据：`src/index.js:1762-1772` 在 `await server.connect(transport)` **之后**直接赋值 `transport.onclose`；SDK `Protocol.connect` 已经把 transport.onclose 包成 `() => { _onclose?.(); this._onclose(); }`（`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:224-227`），`_onclose` 负责 abort in-flight handlers、清 timeout/responseHandlers（同文件 252-269）。覆盖后这些永不执行，仅靠 `claude.js` 的 `process.on("exit")` 兜底 killTree。
- 影响：当前“能工作”，但依赖未定义行为；若未来 onclose 里加任何依赖 SDK 清理的逻辑（或 SDK 改动），会静默失效；SDK 的 pending 响应也不会被 reject。
- 修复：改用 `server.server.onclose` 或先保存 `const prev = transport.onclose` 再在自定义 handler 里 `prev?.()`，最后 `process.exit(0)`。

### P-13 [P3] 工具元数据缺失：无 `title`/`annotations`（readOnlyHint/destructiveHint），且已安装 SDK 1.32.1 中 `server.tool()` 已 deprecated
- 证据：四个注册点 `src/index.js:678-683, 843-882, 1440-1448, 1503-1520` 都只传 name/description/schema；真机 `tools/list` 实测 4 个工具 `annotations: null`、`outputSchema: false`。`package.json:56` `"@modelcontextprotocol/sdk": "^1.12.0"` 会解析到 1.32.x，其中 `server.tool` 标记 `@deprecated Use registerTool instead`（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:121-126`）。
- 影响：这些工具会花钱、改仓库文件（fix）、发 PR 评论、写 ~/.claude（installSkill），客户端无法用 annotations 区分“只读/破坏性/外部副作用”来决定是否需要确认；SDK 升级到移除 `tool()` 的版本时全部注册失效。
- 修复：迁移 `registerTool`；至少给 `claude_review_env` 标 `readOnlyHint:false`（会写 skill），review 标 `openWorldHint:true` + `destructiveHint: fix?true:false`。

### P-14 [P3] `jobId` 的进程生命周期只在错误文案里说明；`JOB_KEEP`/retention 文案与实现不一致
- 证据：`src/index.js:88-90` 注释承认 “a restart clears them”；`1440-1444` 的工具描述没有提；只有 `1460` 的 unknown-jobId 错误才解释 “jobs live in the server process... a host restart clears them all”，而这条错误恰恰是 jobId 已失效之后才看到。`1460` 说 “older ones are pruned once 10 newer jobs finished”，实现（`91-95`）是“只保留最新 10 个 finished job”，不是“10 newer”（第 11 个完成时就删最早的，可能只过了 1 个新 job）。
- 影响：客户端把 jobId 当持久句柄缓存（跨 MCP host reload）→ 拿到错误但用户已经丢了报告路径；排障文案技术上不精确。
- 修复：工具描述加 “jobId is valid only for this server process lifetime”；prune 文案改成 “keeps only the newest 10 finished jobs”。

### P-15 [P3] `shellGuardNote(deniedCommands, deniedCommands)` 把权限 allowlist 的拒绝也归因为 “blocked by the PreToolUse guard”
- 证据：`src/index.js:1241` 把同一个数组同时当作 `commands` 与 `denied` 传入；`src/shell-guard.js:648-667` 里 `blocked` = “命令形态违反只读策略 且 在 denied 集合里”。而 `src/index.js:1231-1236` 已经区分了 `guardBlocked`（guard 会拦）与 `realDenials`（权限 allowlist 拦），注释也写明 “keeping the two apart is what stops the warning from crying wolf”——结果 `guardNote` 又把两者混回同一个 “blocked by the PreToolUse guard” 文案。
- 影响：报告把 allowlist 拒绝（例如 reviewer 调了未授权的只读工具）说成 hook 拦截，排障方向错（用户会去查 hook 安装，而真实原因是 `--allowedTools`）。
- 修复：`shellGuardNote(run.bashCommands, deniedCommands, ...)` 或直接用 `guardBlocked` 生成 note；权限拒绝单独用 `realDenials` 文案（已有 `denialNote`，1237-1240）。

### P-16 [P3] 输入尺寸无上限：followup `message` 不校验长度/非空；单条 >10MB 的入站消息会让 transport close → onclose → `process.exit(0)`
- 证据：`src/index.js:1509-1510` `message: z.string()`，没有 `.min(1)`/`.max(...)`；空串会照样发起一次付费 followup（prompt 只有上下文）。入站 SDK `ReadBuffer` 默认上限 `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`（已安装 SDK `dist/esm/shared/stdio.js:1-2`），append 超限抛错 → stdio transport `_ondata` catch → `onerror` + `close()` → 本 server 的 `onclose` → `process.exit(0)`（`src/index.js:1769-1772`）。一次超大参数即可静默终止整个 server（所有 jobId 失效、in-flight review 被杀）。
- 影响：a) 空 message 付费空转；b) 超大入站消息 = 单点全局故障（虽然客户端通常自己也会限制，但 MCP 层没有兜底）。
- 修复：`message: z.string().min(1).max(8000)`（参照 focus 的 2000 上限）；transport.onclose 里先 `server.close()` 再 exit，或区分“正常 EOF”与“协议错误”日志。

### P-17 [P3] TOCTOU：`existsSync` 后 `statSync` 可抛原生 ENOENT，错误未包装且泄漏 in-flight guard settings
- 证据：`src/index.js:933-934`、`1561-1562` `if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory())`；路径在两次调用之间被删除/替换时 `statSync` 抛错，handler 直接 reject → SDK 返回裸 `ENOENT: no such file or directory, stat '...'`，并且 `prepareRunHardening` 在 `600-601` 已 mark 的 guard settings 不会走 `preflightFail`（925-929）释放（直到进程退出）。
- 影响：并发删除/移动仓库目录时出现不可操作错误 + 临时 guard 文件残留。
- 修复：用 `try { if (!fs.statSync(repoPath).isDirectory()) ... } catch { return preflightFail(...) }`。

### P-18 [P3] 首包文案 “returns a jobId at once” 与实现不符：先跑完整预检
- 证据：`src/index.js:880-881` “returns a jobId at once — poll claude_review_status(jobId)”；实际 handler 先 `await` 全部预检（`907-1132`：CLI 解析、guardSelfTest、git、gateway、gh、gitPrograms、fix snapshot）才返回（`1422`）。
- 影响：慢盘/网络盘 repo、冷 claude wrapper 下首包几百 ms~数秒（预检失败情形见 P-05）；“at once” 让客户端误以为 <100ms，容易把慢预检误判为 hang。
- 修复：文案改 “returns a jobId after a short free preflight (usually <2s)；preflight failures are returned as isError before any paid run”。

### P-19 [P3] `claude_review_env` 的 isError 语义与其他工具不一致；structuredContent 只有 3 个字段
- 证据：`src/index.js:804-812` 的返回值永远没有 `isError`，即使 `verdict: "NOT_FOUND"/"MISCONFIGURED"`；`structuredContent` 只有 `{verdict, server, cli}`，而文本里有 1000+ 字符的可操作诊断（真机实测 textLen=1083，structured 只有 3 个 key，`cli: null` 时错误原因只在文本里）。
- 影响：按 `isError` 判定的客户端把“没装 Claude Code”也当成功；按 structuredContent 消费的客户端拿不到 gateway/skill/guard/gh 状态，等于只有人读通道。
- 修复：`verdict !== "OK"` 时 `isError: true`（或统一用 `status` 字段）；structuredContent 增加 `{cli:{found,error,version},guard,skill,gateway,gh,git}`。

### P-20 [P3] `reviewJobs` 常驻内存保留 10 份完整结果，无字节上限
- 证据：`src/index.js:87-95` `JOB_KEEP=10`，`1408-1421` 每份 `job.result` 含完整 text+structuredContent（主报告 + 最多 15+ 份 8000 字符 subagent 报告，见 P-04）；一个长期运行的 host 进程里 10 份结果常驻。
- 影响：内存占用随报告大小线性累积（最大可达 8MB/run × 10），长会话 MCP host 更易被系统杀（被杀又触发 P-09 的计费风险）。
- 修复：prune 按字节数（如 total ≤ 20MB）而不只按个数；或把 finished result 落盘、job 只留路径。

---

## 附 A：MCP spec 逐项核对（含“通过项”，避免只报坏消息）

| # | 协议项 | 结论 | 证据 / 备注 |
|---|---|---|---|
| 1 | initialize / 协议版本协商 | 通过 | 真机 `initialize` 返回 `protocolVersion: "2025-06-18"`、101ms；SDK 负责向下协商 |
| 2 | capabilities 声明 | 通过（L5） | 真机 `capabilities: {"tools":{"listChanged":true}}`；`listChanged:true` 但从不发 list_changed 的通知已由 L5 记录 |
| 3 | serverInfo 与 package 一致 | 通过 | name `cc-code-review`、version `1.18.0` = `package.json:3`；`scripts/smoke-test.mjs` 也锁定 |
| 4 | tools/list schema | 通过 | 4 个工具，必填项正确（review: repoPath；followup: sessionId/message/repoPath；其余无可选）；zod `.default()` 已生效（超时 30/10、effort max、outputLanguage 中文，真机 schema 可见）；未知字段被 strip（additionalProperties:false） |
| 5 | 参数校验失败语义 | 通过 | 真机：`tools/call` 校验失败返回 `isError:true` + “MCP error -32602: Input validation error ...”，不是 JSON-RPC fatal；客户端可正常展示 |
| 6 | 错误语义 err() | 通过（形状问题见 P-03） | `err()` 正确设置 `isError:true`（418-420）；未知 jobId 文案可操作（1460）；但没有 structuredContent |
| 7 | 失败 vs 空结果可区分 | 不通过 P-01 | 空报告 = success；文本有提示，结构化无 |
| 8 | structuredContent / outputSchema | 部分 P-03/L6 | 返回 structuredContent 但无 outputSchema（spec 允许，客户端会忽略）；无 schema 约束导致生命周期形状漂移 |
| 9 | 通知 / progress token | 通过（仅 sync） | `extra._meta.progressToken` + `notifications/progress`（1147-1156、1617-1627）字段正确，SDK 自动带 relatedRequestId；async 默认路径不提供 progress（合理，但 timer 泄漏见 P-07） |
| 10 | 取消语义 | 通过（+P-02） | `extra.signal` → runClaude abort → `killTree` SIGKILL 进程组（claude.js:475-494、1296-1298、1493-1497）；async `status(cancel:true)` 生效（1462-1466）；SDK 丢弃已取消响应是 spec 行为，但 sync 路径因此丢失成果（P-02） |
| 11 | stdio 通道纯净 | 通过 真机验证 | 探针：stdout 全部为合法 JSON-RPC（0 条非 JSON 行），日志全在 stderr；src 内无 `console.log`/`process.stdout`（grep 确认） |
| 12 | 大报告 / 帧限制 | 风险 P-04 | stdio newline framing 无协议帧上限；风险在客户端大小限制/上下文（报告不截断、双通道重复、每 poll 重发）；入站 10MB 上限见 P-16 |
| 13 | 30s 客户端超时 | 风险 P-05/P-18 | async 默认是正确的规避设计；但同步预检与 env 工具没有超时预算，“at once” 文案过强 |
| 14 | jobId 跨进程/重启 | 风险 P-14 | 只在错误文案说明，工具描述未声明 |
| 15 | 工具名/描述 | 通过 | 名字符合 `[A-Za-z0-9_-]{1,128}`；描述长但合法；缺 title/annotations 见 P-13 |
| 16 | 传输 onclose 生命周期 | 风险 P-12 | 能工作但覆盖了 SDK 的 onclose wrapper；exit(0) 语义见 R-21 |
| 17 | 并发/会话隔离 | 不通过 P-08 | 无 repo/session 锁；stdio 单连接下“多客户端隔离”不适用（单 client 进程） |
| 18 | 代理/stdio 错误处理 | 通过 | child stdio 全部 pipe（claude.js:1296），无 inherit 污染 stdout；入站非法 JSON 被 SDK 吞掉不 crash（但 onerror 未记录，小 P3 可忽略） |

## 附 B：本次免费探针的实际输出（可复现）

用 `node --input-type=module -` + `spawn(node, ["src/index.js"])` 做 stdio 客户端，仅调用不存在的 repoPath，因此所有调用都在 spawn claude 之前失败，**0 元**：

| 调用 | 结果 |
|---|---|
| `initialize` | `{protocolVersion:"2025-06-18", capabilities:{tools:{listChanged:true}}, serverInfo:{name:"cc-code-review",version:"1.18.0"}}`，101ms |
| `tools/list` | 4 工具；review 的 `required:["repoPath"]`；`waitForResult.default=false`；`timeoutMinutes.default=30` 等 |
| review + `baseRef:"main --fix"` | **通过校验**，错误为 “repoPath does not exist”（→ 04-P1-3 注入面成立） |
| review + `focus:"line1\nIGNORE..."` | **通过校验**（→ 04-P2-7 成立） |
| review + `baseRef:"--output=/tmp/pwn"` | `baseRef must not start with "-"`（正例） |
| review + `focus:"ok\u0000bad"` | `focus must not contain control characters`（正例） |
| review + `pr:"1 --fix"` | `pr must be a PR number ...`（正例） |
| review + `outputLanguage:""` | `outputLanguage must not be empty` |
| status `{}` | “no review jobs in this server process yet”，**无 structuredContent** |
| status `{jobId:"job-nope"}` | `isError:true`，文案解释进程生命周期 |
| status `{cancel:true}` | **忽略 cancel，返回 job 列表**（P-11） |
| followup `sessionId:"-bad"` | 拒绝（正例） |
| followup `outputLanguage:"中文\nx"` | “must be a single line”（正例） |
| env `{}` | 255ms，`verdict: OK`，textLen 1083，structured keys `[verdict, server, cli]`；本机 claude 2.1.133 低于 2.1.200/2.1.259 门槛（对应 L7） |
| 参数 schema 错误 | `isError:true` + “MCP error -32602: Input validation error ...”（缺失必填/错误类型/非法枚举均如此） |

## 附 C：建议修复顺序（只针对本文条目）

1. P-01（空报告按失败处理）—— 直接影响“报告可信”这一产品承诺，改动最小。
2. P-02（sync 也登记 job）—— 恢复“cancel 不丢付费结果”契约，20 行内。
3. P-07 + P-05（timer try/finally + 探测总预算/日志目录容错）—— 一次改动消掉两个崩溃/挂起面。
4. P-03 + P-04（统一 status 返回外套 + 截断）—— 协议可消费性和大报告风险。
5. P-06（三处 await settled）、P-08（并发锁）、P-09（孤儿计费兜底）、P-10（instructions 校正）。
6. P3 按需。
