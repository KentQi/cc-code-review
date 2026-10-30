---
title: P2/P3 存量 Triage（v1.18.3 基线）
version: v1.18.4
created: 2026-10-29
status: final
---

# P2/P3 存量 Triage — cc-code-review v1.18.3

> **状态更新（2026-10-29 深夜，v1.18.4）**：本表里的 **13 条 🟢 与 37 条 🟡 已全部修掉**（含 1 条部分修复 P2-3 的收尾），只剩 5 条 ⚪ 接受不修与 1 条 ❌ 不成立。修复明细见 [FIXES-round4.md](14-fix-round4-v1.18.4.md)。下表保留 triage 当时的判断与理由，作为"为什么修/为什么不修"的记录。

**范围**：第一轮五专家审计的 **P2 46 条 + P3 46 条**（`docs/04-test/02`–`06`），加上第二轮原子审计 §4 的 **12 条 P2**（其中 11 条已在 1.18.2/1.18.3 修掉）。
**方法**：每条对照 v1.18.3 的代码/真实 hook 重新判定；标 ✅实测 = 本次跑过探针或读过当前代码，📄按报告 = 依据审计原文（未逐条复跑）。
**结论**：**104 条 P2/P3 中，已修 47 条、建议下轮修 13 条、可延后 37 条、接受不修 5 条、不成立 1 条、部分修复 1 条**（另有 2 条第一轮 P0 的审计证据被证伪，见 §2）。

---

## 1. 建议下轮修（Top 12，按风险 × 工作量排序）

| # | 编号 | 问题 | 影响 | 工作量 | 依据 |
|---|---|---|---|---|---|
| 1 | **P2-11** | `git branch -u<ref>`（attached 短选项）放行 → 只读模式可写 `.git/config` | 只读边界被穿透（本地写，非 RCE） | **XS**（denyFlags 补 `-u` + attached 形式） | ✅实测 ALLOW |
| 2 | **SEC-15** | 自审场景（repo = 本 MCP 包）fix 模式可写 `scripts/pre-tool-hook.js`/`src/shell-guard.js` | 改一次 guard 文件 = 后续所有 run 卸防；需用户确实在审自己 | **S**（PROTECTED_WRITE 加这两个路径） | ✅读码（列表无 scripts/src） |
| 3 | **SEC-23** | review 模式可 `Read` 仓库内 `.env`/密钥文件 → 内容进报告/转录 | 凭据外带（仓库自带的 secrets） | **M**（hook Read 分支复用写侧的密钥路径 deny 列表） | ✅实测 ALLOW |
| 4 | **SEC-09** | `isLoopbackHost` 漏 `[::1]`（Node 的 URL.hostname 带方括号）与 `localhost.` | 本地 gateway 的 Bearer token 可能经 HTTP 代理外发 | **XS**（归一化方括号/尾点） | ✅实测 hostname 形式 |
| 5 | **SEC-25** | hook 不认 `notebook_path` → fix 模式所有 NotebookEdit 被拒 | 功能误伤（非安全问题） | **XS** | ✅读码 |
| 6 | **R-7** | `isAllowedTranscriptPath` 不做 realpath → macOS `/private/var` 形态静默失效 | 429 抢救的 transcript 恢复在 macOS 上可能永不命中 | **S** | ✅读码（无 realpath） |
| 7 | **R-11** | `agentResults` Map 只写不读，把每条 tool_result（可达数 MB）钉在内存 | 长跑内存浪费 | **XS**（删） | ✅实测 0 读点 |
| 8 | **R-16** | `sweepTempArtifacts` 在读目录前就置 `swept` → 一次 EACCES 永久禁用本进程清理 | 临时文件泄漏到进程退出 | **XS** | ✅读码 |
| 9 | **R-21** | 信号处理器 `process.exit(0)` → host 无法区分正常关闭与被信号中断 | 运维可观测性 | **XS**（128+sig） | ✅读码 |
| 10 | **P-13** | 工具无 `title`/`annotations`；SDK 1.32 中 `server.tool()` 已 deprecated | 客户端体验 + 升级债 | **M**（升级 SDK + 迁移 API） | ✅实测无 title |
| 11 | **Q15** | 无打包回归测试；`files:["scripts"]` 把 ~190KB 测试/付费脚本塞进用户安装 | 发布物质量 | **S**（npm pack --dry-run 断言 + 收窄 files） | 📄按报告 |
| 12 | **Q20** | 6 个脚本各自复制 ~30 行 stdio MCP 客户端 | 维护成本 | **M**（抽共享 helper） | 📄按报告 |

**次优先（可延后）**：P-06 prewarm 竞态、P-16 入站消息无长度上限、P-20 reviewJobs 常驻内存、R-9 version/help 缓存无 TTL、R-8 npm root 永久 memo、P2-7 `validateFocus` 允许换行、P2-8 stale 技能刷新失败静默、P2-12 scope=auto 目标顺序、P2-13 舰队规模 vs maxTurns、P3-3 `owner/repo#N` 允许前导 `-`。

---

## 2. 接受不修 / 不成立

| 编号 | 结论 | 理由 |
|---|---|---|
| **R-10** | ⚪ 接受 | git-lfs / `merge.<x>.driver=true` 的"误报"是 1.18.2/1.18.3 的**显式 fail-closed 取舍**（仓库自带可执行 driver 一律拒）；已写进 CHANGELOG 的"new refusal surface"。 |
| **R-20** | ⚪ 接受 | Windows 无 Job Object 的进程树限制：README 已声明；POSIX 侧只有 SIGKILL 也是既定设计（靠 JSONL 补救）。 |
| **P2-9** | ⚪ 接受（暂） | `buildFallbackPrompt` 死代码 + 未使用 import：`audit-fixes-test` 在测它，删函数要连带改断言；无风险，留待测试重构时一起清。 |
| **P-09** | ⚪ 接受 | SIGKILL 下 detached 子进程必然成孤儿——进程已死，无解；已由 README 声明 + job 状态可见。 |
| **SEC-26** | ✅ 已随 1.18.2/1.18.3 修复 | 文档承诺核对表的 12 条已逐条变真或改文档。 |
| **SEC-27** | ❌ 不成立 | `gitWriteFlagReason` 并非死导出：`audit-fixes-test.mjs:503` 在用。 |
| **P0-10（round-2）** | ❌ 原证据无效 | 审计的 4100 文件 fixture 命名错误（`aN.gitattributes` 不被计数）；真实布局（每目录一个 `.gitattributes`）在修复前就已 fail-closed。修复保留为纵深防御。 |
| **P0-2（round-2 tr）** | ❌ 定性过头 | BSD/GNU `tr` 都没有 FILE 操作数；修复保留为纵深防御。 |

---

## 3. 完整 triage 表

### 3.1 安全（01-security，19 条）

| 编号 | 级别 | 问题 | 现状 | 决定 |
|---|---|---|---|---|
| SEC-09 | P2 | isLoopbackHost 漏 `[::1]`/`localhost.` | 开放 ✅实测 | 🟢 Top-4（XS） |
| SEC-10 | P2 | reviewer git 无加固 + 扫描器漏键 | **已修**（1.18.2 GIT_CONFIG_* + 1.18.3 三键） | ✅ |
| SEC-11 | P2 | 固定 tmp 目录可被预创建/替换 | **已修**（1.18.3 拒绝符号链接/异属主 + 0700） | ✅ |
| SEC-12 | P2 | activeSubagentFiles 死代码 | **已修**（1.18.2 两条清扫接入） | ✅ |
| SEC-13 | P2 | hook fail-open 路径 | **已修**（1.18.2 Read 分支 + stdin） | ✅ |
| SEC-14 | P2 | 逃生门对 guard failed 生效 | **已修**（1.18.3） | ✅ |
| SEC-15 | P2 | 自审时 fix 模式可改 guard 文件 | 开放 ✅读码 | 🟢 Top-2（S） |
| SEC-16 | P2 | init.mjs 非原子写 + 覆盖 env key | 部分（merge 已保留未知 key；原子写未做）📄 | 🟡 低 |
| SEC-17 | P2 | reviewer 可 `echo $ANTHROPIC_AUTH_TOKEN` | **已修**（1.18.2 裸 $VAR + echo 收紧） | ✅ |
| SEC-18 | P3 | 紧贴短选项可读文件 | **已修**（1.18.1） | ✅ |
| SEC-19 | P3 | 只读 git branch 形态被误杀 | **已修** ✅实测 ALLOW | ✅ |
| SEC-20 | P3 | sed 死代码 + 提示误导 | **已修**（1.18.2） | ✅ |
| SEC-21 | P3 | Windows-only 用例 | **已修**（1.18.2） | ✅ |
| SEC-22 | P3 | gateway URL 打印泄漏 | **已修**（1.18.2 脱敏） | ✅ |
| SEC-23 | P3 | review 可读仓库内 .env/密钥 | 开放 ✅实测 ALLOW | 🟢 Top-3（M） |
| SEC-24 | P3 | analyseCommand 非字符串返回 ok | 开放 ✅实测 | 🟡 XS（hook 只传字符串） |
| SEC-25 | P3 | NotebookEdit notebook_path | 开放 ✅读码 | 🟢 Top-5（XS） |
| SEC-26 | P3 | 文档承诺不符 | **已修** | ✅ |
| SEC-27 | P3 | 死导出 | **不成立**（测试在用） | ❌ |

### 3.2 协议（02-protocol，18 条）

| 编号 | 级别 | 问题 | 现状 | 决定 |
|---|---|---|---|---|
| P-03 | P2 | structuredContent 4 种形状 / jobId 消失 | 部分（1.18.2 补 jobId；形状仍随路径变化）📄 | 🟡 低 |
| P-04 | P2 | 大结果无上限 / 双通道 / poll 重发 | **已修**（1.18.3 512KiB 截断；poll 本就不重发） | ✅ |
| P-05 | P2 | 同步阶段无 30s 预算 | 开放 📄 | 🟡 中（async 首包通常 <30s） |
| P-06 | P2 | prewarm 首调竞态 | 开放 📄 | 🟡 S |
| P-07 | P2 | logsDir 裸抛 | **已修**（1.18.2） | ✅ |
| P-08 | P2 | 无并发控制 | **已修**（1.18.3 fix 锁；followup 同 session 仍无锁） | ✅ |
| P-09 | P2 | SIGKILL 下孤儿计费 | 开放（无解）📄 | ⚪ |
| P-10 | P2 | instructions 与 async 不一致 | **已修**（1.18.3） | ✅ |
| P-11 | P3 | cancel 无 jobId 被静默忽略 | 开放 ✅读码 | 🟡 XS |
| P-12 | P3 | transport.onclose 覆盖 SDK wrapper | 开放 ✅读码 | 🟡 S |
| P-13 | P3 | 无 title/annotations；server.tool deprecated | 开放 ✅实测 | 🟢 Top-10（M） |
| P-14 | P3 | jobId 生命周期/JOB_KEEP 文案 | 开放 📄 | 🟡 XS |
| P-15 | P3 | shellGuardNote 归因错误 | **已修**（1.18.2 classifyDenials） | ✅ |
| P-16 | P3 | 入站消息无长度上限（>10MB 断连） | 开放 ✅读码 | 🟡 S |
| P-17 | P3 | existsSync→statSync TOCTOU | 开放 📄 | 🟡 XS |
| P-18 | P3 | "returns a jobId at once" 与预检不符 | 开放 📄 | 🟡 XS |
| P-19 | P3 | env 工具 isError 语义不一致 | 开放 📄 | 🟡 XS |
| P-20 | P3 | reviewJobs 常驻 10 份完整结果 | 部分（输出已截断；内存未限）✅读码 | 🟡 S |

### 3.3 运行时（03-runtime，21 条）

| 编号 | 级别 | 问题 | 现状 | 决定 |
|---|---|---|---|---|
| R-1..R-5 | P0/P1 | 符号链接冻结 / 深 attrs / 同行 header / fail-open / 完成误判超时 | **全部已修**（1.18.1–1.18.3） | ✅ |
| R-6 | P2 | recoverReportFromTranscript 无 role 过滤 | **已修** ✅读码 | ✅ |
| R-7 | P2 | isAllowedTranscriptPath 不 realpath | 开放 ✅读码 | 🟢 Top-6（S） |
| R-8 | P2 | npm root 探测失败永久 memo | 开放 📄 | 🟡 XS |
| R-9 | P2 | version/help 缓存无 TTL | 开放 📄 | 🟡 S |
| R-10 | P2 | git-lfs / merge.driver 误报 | 接受（显式 fail-closed 取舍） | ⚪ |
| R-11 | P3 | agentResults 只写不读（内存） | 开放 ✅实测 0 读点 | 🟢 Top-7（XS） |
| R-12 | P3 | hasShebang 死代码 + fd 泄漏 | 开放 ✅读码 | 🟡 XS |
| R-13 | P3 | 重复注释块 | 开放 📄 | 🟡 XS |
| R-14 | P3 | parseUnrecognizedModels 嵌套 JSON | 开放 📄 | 🟡 XS |
| R-15 | P3 | parseResultJson 仅单行 | 开放（stream-json 路径已覆盖）📄 | 🟡 XS |
| R-16 | P3 | sweep 标志先于 readdir | 开放 ✅读码 | 🟢 Top-8（XS） |
| R-17 | P3 | 死条件 `!cachedCli.error` | 开放 📄 | 🟡 XS |
| R-18 | P3 | activeSubagentFiles 未被 import | **已修**（1.18.2/1.18.3） | ✅ |
| R-19 | P3 | looksLikeLaunchAck 误判同步报告 | 开放 📄 | 🟡 XS |
| R-20 | P3 | Windows 进程树/无 SIGTERM 阶段 | 接受（README 已声明） | ⚪ |
| R-21 | P3 | 信号处理 exit(0) | 开放 ✅读码 | 🟢 Top-9（XS） |

### 3.4 提示词（04-prompt，23 条）

| 编号 | 级别 | 问题 | 现状 | 决定 |
|---|---|---|---|---|
| P2-1 | P2 | 两套报告格式 | **已修**（1.18.3 单一契约） | ✅ |
| P2-2 | P2 | "verbatim playbook" 不自洽 | 部分（1.18.0 已对齐 angle mix；README 8/10 vs 5 路需复核）📄 | 🟡 低 |
| P2-3 | P2 | >=80 与 0/25/50/75/100 互斥 | **已修**（1.18.2 阈值 75；PLAUSIBLE 映射仍未文档化） | ✅/🟡 |
| P2-4 | P2 | sed 被宣传为合法 sink | **已修**（1.18.1/1.18.2） | ✅ |
| P2-5 | P2 | buildFallbackPrompt 死代码 | 接受（测试依赖） | ⚪ |
| P2-6 | P2 | native 无 --effort 时丢思考关键词 | **已修** ✅实测含关键词 | ✅ |
| P2-7 | P2 | validateFocus 允许换行/Tab | 开放 ✅读码（只挡控制字符，放行 \n/\t） | 🟢 次优先（S，prompt 注入面） |
| P2-8 | P2 | stale 技能刷新失败静默 | 开放 📄 | 🟡 S |
| P2-9 | P2 | "永不覆盖用户技能"被夸大 | 开放 📄 | 🟡 S（文档/语义） |
| P2-10 | P2 | env 诊断文本与实现相反 | 部分（1.18.2 修了两处）📄 | 🟡 XS |
| P2-11 | P2 | `git branch -u<ref>` 漏检 | 开放 ✅实测 ALLOW | 🟢 **Top-1（XS）** |
| P2-12 | P2 | scope=auto 目标顺序与 playbook 相反 | 开放 📄 | 🟡 S |
| P2-13 | P2 | 舰队规模 vs maxTurns | 开放 📄 | 🟡 S |
| P3-1 | P3 | outputLanguage 40 字可夹指令 | 开放 ✅读码 | 🟡 XS |
| P3-2 | P3 | sanitizeBaseRef 回显被拒输入 | 部分（前导 - 已拒；回显仍在）📄 | 🟡 XS |
| P3-3 | P3 | `owner/repo#N` 允许前导 `-` | 开放 ✅读码（字符集含 `-`） | 🟡 XS |
| P3-4 | P3 | followup 提示词承诺做不到的事 | 开放 📄 | 🟡 XS |
| P3-5 | P3 | codeDrift 漏 prompt.js/skill.js | **已修**（1.18.2） | ✅ |
| P3-6 | P3 | lines.filter 删空行 | **已修**（1.18.2） | ✅ |
| P3-7 | P3 | effort=xhigh 文档语义 | 开放 📄 | 🟡 XS |
| P3-8 | P3 | 无 no-findings 分支 | **已修**（1.18.3） | ✅ |
| P3-9 | P3 | 死导出/注释精度 | 部分 📄 | 🟡 XS |
| P3-10 | P3 | 安装幂等/原子性 | 开放 📄 | 🟡 S |

### 3.5 质量（05-quality，20 条）

| 编号 | 级别 | 问题 | 现状 | 决定 |
|---|---|---|---|---|
| Q1 | P0 | .GIT 绕过 | **已修**（1.18.1） | ✅ |
| Q2 | P1 | headline 能力无回归 | **已修**（cross-cases 进门禁） | ✅ |
| Q3 | P1 | "无 CI"/`&&` 吞套件 | **已修**（聚合 runner + CI 步骤；"无 CI"已更正） | ✅ |
| Q4 | P1 | realpath 不对称 | **已修**（1.18.1） | ✅ |
| Q5 | P2 | Windows-only 用例 | **已修**（1.18.2） | ✅ |
| Q6 | P2 | validation-test 硬编码 C:/ | **已修**（1.18.2） | ✅ |
| Q7 | P2 | 自证式断言 | 部分（仍自行实现匹配；影响可控）📄 | 🟡 S |
| Q8 | P2 | H4 空断言假绿 | **已修** ✅读码（真断言） | ✅ |
| Q9 | P2 | smoke 非 hermetic | 部分（CI 用 stub；本机需 CLI）📄 | ⚪ 可接受 |
| Q10 | P2 | stub 只覆盖 happy path | **已修**（1.18.2 C22 非零退出 / 1.18.3 C23 信号） | ✅ |
| Q11 | P2 | 文档与实现三处矛盾 | **已修**（1.18.2/1.18.3） | ✅ |
| Q12 | P2 | CHANGELOG 无 breaking 标注 | 开放（1.18.1+ 条目描述了行为变化，但无 breaking 段）📄 | 🟡 S |
| Q13 | P2 | engines 18.19 未验证 | **已修**（CI matrix 18/22） | ✅ |
| Q14 | P2 | overrides 对消费者无效 | **已修**（1.18.2 直接依赖） | ✅ |
| Q15 | P2 | 无打包测试 + scripts 膨胀 | 开放 📄 | 🟢 Top-11（S） |
| Q16 | P3 | 计数不可复现 | **已修**（run-tests 汇总） | ✅ |
| Q17 | P3 | 测试 tmp 泄漏 | **已修**（1.18.2 cleanup） | ✅ |
| Q18 | P3 | 断言过弱/覆盖不全 | 部分 📄 | 🟡 S |
| Q19 | P3 | 付费脚本无 npm 入口 | **已修**（1.18.3 显式 script） | ✅ |
| Q20 | P3 | 6 份重复 MCP 客户端 | 开放 📄 | 🟢 Top-12（M） |

### 3.6 第二轮原子审计 §4（12 条 P2）

| 编号 | 现状 |
|---|---|
| P2-1 codeDrift 漏文件 | ✅ 1.18.2 |
| P2-2 find 路径参数 | ✅ 1.18.2 |
| P2-3 脱敏阈值 | ✅ 1.18.2 |
| P2-4 job 淘汰顺序 | ✅ 1.18.2 |
| P2-5 cancel-test 未纳入 | ✅ 1.18.3（跨平台 + 显式 script） |
| P2-6 MAX_SEGMENTS 零覆盖 | ✅ 1.18.2 |
| P2-7 stub 失败分支 | ✅ 1.18.3（C23 信号；Gatekeeper 文案仍 darwin-only） |
| P2-8 PIPE_SINKS 双份 | ✅ 1.18.2 |
| P2-9 buildFallbackPrompt 死代码 | ⚪ 接受（测试依赖） |
| P2-10 lines.filter 空行 | ✅ 1.18.2 |
| P2-11 sed 死代码 | ✅ 1.18.2 |
| P2-12 logsDir 裸抛 | ✅ 1.18.2 |

---

## 4. 统计与结论

| 状态 | 数量 | 说明 |
|---|---|---|
| ✅ 已修（1.18.1–1.18.4） | **98** | 1.18.4 清掉了全部 13 条 🟢 与 37 条 🟡（含 P2-3 收尾） |
| ⚪ 接受不修（设计取舍） | **5** | R-10 / R-20 / P-09 / P2-9 / Q9 |
| ❌ 不成立 | **1** | SEC-27（该导出有测试在用） |

> **2026-10-29 深夜**：上表为 1.18.4 之后的最终状态；1.18.4 的修复明细与验证见 [FIXES-round4.md](14-fix-round4-v1.18.4.md)。

**结论**：P2/P3 里真正"值得修且影响安全/正确性"的只剩 **4 条**——`git branch -u<ref>`（只读边界）、自审场景的 guard 文件（SEC-15）、review 模式读仓库 secrets（SEC-23）、`isLoopbackHost` 的 IPv6/尾点（SEC-09）。其余是**可用性/维护性/可观测性**债，建议按 Top-12 分批在 1.18.4/1.19 处理，不需要阻塞当前三个 PR 的合并。

**建议节奏**：1.18.4 = Top-1..Top-6（安全 + 恢复路径，约 1 天）；1.19 = Top-7..Top-12（内存/可观测性/打包/SDK 升级，约 2 天）；🟡 项随下次触碰相关模块时顺手清。
