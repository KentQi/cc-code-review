---
title: cc-code-review 首轮审计报告（五专家）
version: v1.18.0
created: 2026-10-29
status: final
---

# cc-code-review MCP v1.18.0 — 多专家审计总报告

> **状态更新（2026-10-29 晚）**：本报告的 **9 条 P0 与 12 条 P1 已修复并发布为 v1.18.1**，`npm test` 从红（230/3）转为绿（6 套件全过）。修复明细、回归证据与未修项见 [FIXES.md](11-fix-round1-v1.18.1.md)。 PR：[#1](https://github.com/KentQi/cc-code-review/pull/1)（未合并）。下文保留审计当时的原始结论，作为问题记录与验收依据。
>
> **更正一条**：本报告 L2/L11/Q3 的"仓库没有任何 CI"是**本地工作副本缺 `.github/` 等点文件**造成的假象——上游仓库本来就有 `.github/workflows/ci.yml`。该结论作废。但实际情况并不更好：1.18.0 的 main 上 **CI 六个 job 全红**（macOS 3 红、Ubuntu 2 红、Windows 1 红，正是本报告 L1 的 realpath bug 与两条平台不可移植用例），红色 badge 被忽略了。本次已修掉这些失败，并把 `p0-regression` 加进 CI。

**审计对象**：`/Users/kent/Desktop/projects/cc-code-review_MCP`（v1.18.0，约 8,500 行，Node ESM + @modelcontextprotocol/sdk）
**审计方式**：5 位领域专家并行静态审计 + Lead 独立黑盒/动态复现（真实 hook 进程、真实 bash 执行、真实 stdio MCP 客户端）
**审计日期**：2026-10-29

---

## 0. 一句话结论

**架构和工程品味都在平均线之上（单点真相的 BASH_POLICY、guard 自检、429 增量抢救、进程组 kill 都做得比同类好），但安全地基有系统性裂缝：**

1. **shell guard 把"原始命令字符串"当成了 argv** —— `$'...'`、`\-` 转义、`-o<值>` 紧贴短选项三类写法直接穿透全部 deny 表，实测**任意命令执行 / 任意读写**；
2. **"把仓库当攻击者"的两处边界没守住** —— `.gitattributes` 符号链接可冻结整个 server；深度≥2 的 `.gitattributes`、同行 section header 可让 `git diff` 执行仓库自带的 textconv 命令（RCE）；
3. **fix 模式的 deny-list 承诺不成立** —— 能写 `.claude/settings.json`、`.envrc`、`.github/workflows/`、`.GIT/config`，都是"跑完还留在用户机器上"的持久化执行点；
4. **质量门禁名存实亡** —— `npm test` 当前 3 红（POSIX），无任何 CI（README 的 CI badge 指向不存在的 workflow），且 `&&` 串联让首个失败吞掉后面 272 条检查。

**建议：P0 全部修完并补回归测试之前，不要在不受信任的仓库上使用 fix 模式。**

---

## 1. 计分卡

| 来源 | P0 | P1 | P2 | P3 | 合计 |
|---|---:|---:|---:|---:|---:|
| 01 安全（sec-auditor） | 3 | 5 | 9 | 10 | 27 |
| 02 协议（protocol-auditor） | 0 | 2 | 8 | 10 | 20 |
| 03 运行时（runtime-auditor） | 3 | 2 | 5 | 11 | 21 |
| 04 提示词（prompt-auditor） | 1 | 4 | 13 | 10 | 28 |
| 05 质量（quality-auditor） | 1 | 3 | 11 | 5 | 20 |
| **专家小计** | **8** | **16** | **46** | **46** | **116** |
| Lead 实证（去重后新增/复核） | +1 组合链 | +1 | +3 | +3 | +8 |
| **去重合计** | **9** | **17** | **~45** | **~45** | **~116** |

**验证状态**：所有 P0 与多数 P1 由 Lead 独立复现（不是采信专家结论）。每条标注 `[已实测]` / `[代码路径确认]` / `[仅静态]`。

明细文件：
- [00-lead-empirical.md](07-audit-lead-empirical-v1.18.0.md) — Lead 的 16 条实证（L1–L16）
- [01-security.md](02-audit-security-v1.18.0.md) · [02-protocol.md](03-audit-protocol-v1.18.0.md) · [03-runtime.md](04-audit-runtime-v1.18.0.md) · [04-prompt.md](05-audit-prompt-v1.18.0.md) · [05-quality.md](06-audit-quality-v1.18.0.md)

---

## 2. P0 — 必须立刻修（9 条）

### P0-1 shell guard 的 tokenizer 不建模 bash 的引号/转义 → 任意命令执行、任意读写 `[已实测]`
**文件**：`src/shell-guard.js:124-197`（`parseCommand`）、`448-450`、`516-524`、`278-297`、`425-434`

guard 按空白切分原始字符串，但 bash 在执行前会展开 `$'...'`（ANSI-C 引用）、`$"..."`、反斜杠转义。所有 deny 表都是 token 精确匹配，于是 `$'-exec'` 与 `-exec` 是两个世界。

Lead 用**真实 hook 进程 + 真实 bash 执行**双重验证：

| 命令 | hook | 实际效果 |
|---|---|---|
| `find . -name x -exec sh -c id \;` | DENIED | — |
| `find . -name x $'-exec' sh -c 'echo PWNED > /tmp/x' \;` | **ALLOWED** | **PWNED 文件生成（RCE）** |
| `git diff --output=/tmp/x` | DENIED | — |
| `git diff \--output=/tmp/x` | **ALLOWED** | **仓库外写入成功** |
| `git diff $'--no-index' /etc/passwd /etc/hosts` | **ALLOWED** | 读仓库外任意文件 |

**修法**：`parseCommand` 对 `$'`、`$"`、引号外 `\` 直接判 unsafe（与现有 `$(`/`${}` 同级）；根治做法是输出 raw + argv 双视图，所有 deny/路径检查对 argv 视图执行。**同时补 hook 进程级回归**（当前 `shell-guard-test` 只测了分隔形式）。

### P0-2 紧贴短选项值绕过 `[已实测]`
**文件**：`src/shell-guard.js:334-353`（`pathArgs` 把 `-xVALUE` 当自包含 flag）、`259-264`（`FLAG_KINDS.sort` 无 `-o`）、`460-462`

`git log | sort -o/tmp/x` 放行（带空格的 `sort -o /tmp/x` 才被拦）。实测写仓库外文件成功。可覆盖 `~/.zshrc` / `~/.ssh/authorized_keys` 实现持久化。同族：`rg -f/etc/passwd`、`git ls-files -X /etc/passwd`。

**修法**：`FLAG_KINDS` 支持短选项紧贴值（`-o<path>` 拆成 name+value 后走路径检查）；对 pipe sink 的紧贴短选项做结构性拒绝。

### P0-3 仓库提交的 `.gitattributes` 符号链接可冻结整个 MCP server `[已实测]`
**文件**：`src/claude.js:1836-1851`（`repoAttributeFiles` 用 `readFileSync`，无 lstat / 无上限 / 跟链）、调用点 `src/index.js:1116`（同步、在 spawn/timeout/guard 之前）

```
.gitattributes -> /dev/zero   => 6s 超时（无上限分配）
.gitattributes -> /dev/stdin  => 阻塞到 stdin 管道关闭（实测 7.9s；MCP 的 stdin 永不关 => 永久冻结）
```
单线程事件循环被同步阻塞，任何工具都不再响应，没有超时能救。`git clone` 会重建该符号链接 → 可远程触发。

**修法**：读前 `lstatSync` 只接受普通文件（或 `O_NOFOLLOW`）；`realpath` 后校验仍在 repo 内；加大小上限；`[include] path` 同样处理。

### P0-4 深度 ≥2 的 `.gitattributes` 不扫描 → `git diff` 执行仓库自带 textconv（RCE）`[已实测]`
**文件**：`src/claude.js:1836-1851`（函数注释自认 "one directory deep"）、`1904-1943`

实测：`src/deep/.gitattributes` 引用 repo config 里的 `[diff "evil"] textconv = <cmd>` → `repoRunsGitPrograms()` 返回 `refusals: []` → 评审继续 → reviewer 的 `git diff` 执行命令 → **PWNED 落地**。

### P0-5 同行 section header 绕过扫描（RCE）`[已实测]`
**文件**：`src/claude.js:1879-1888`（`sectionsOf` 要求 header 独占一行）、`1932-1936`、`1941-1943`

`[diff "evil"] textconv = cmd` 是合法 git config（`git config --get` 能读出），但被归到上一个 `[diff "..."]` section 后 `continue` → 驱动永不登记 → 既不 refusal 也不 note。实测 RCE 成立。

**P0-4/5 修法**：用 `git config --file <cfg> --list -z --includes` 拿规范化 key/value，不要用行扫描模拟 config 语法；`.gitattributes` 改为递归扫描或直接 `git check-attr -a --stdin`；`[diff|filter]` section 里的命令行一律 refusal（不要"被引用才拒绝"）。

### P0-6 大小写变体的 `.GIT` 写入绕过仍然存在（CHANGELOG 谎报已修）`[已实测]`
**文件**：`scripts/pre-tool-hook.js:120`、`src/prompt.js:361`

`CHANGELOG.md:10` 声称 1.18.0 已修 "case-sensitive `.GIT` write bypass"，实测：
```
Write <repo>/.git/hooks/pre-commit  => DENIED
Write <repo>/.GIT/hooks/pre-commit  => ALLOWED   <-- 绕过
写入后 fs.existsSync(<repo>/.git/hooks/pre-commit) === true
```
两层都漏：hook 正则大小写敏感；deny glob 只有小写。测试只覆盖小写 `.git`。

**修法**：两侧统一按平台做大小写归一；补 `.GIT`/`.Git`/`**/.GIT/**` 回归用例。

### P0-7 fix 模式的 deny-list 承诺不成立：可写仓库内"可执行配置" `[已实测]`
**文件**：`src/prompt.js:359-368`（只按名字封 `.git` + 密钥名）、`scripts/pre-tool-hook.js:117-122`（只拦 `.git/` 与仓外）

实测 fix 模式下全部 **ALLOWED**：`.claude/settings.json`、`.claude/settings.local.json`、`.envrc`、`.github/workflows/ci.yml`、`package.json`。

项目自己在 `src/claude.js:1201-1204` 认定项目级 `.claude/settings.json` 的 hooks = 任意代码执行。仓库内容可指示 reviewer 在 fix 时写入 → **用户下次在该仓库正常打开 Claude Code 时执行**。deny 注释里的 "cannot plant a hook" 不成立。

**修法**：deny 名单加入 `.claude/**`、`.envrc`、`.github/workflows/**`、`.vscode/**`、`.idea/**`、`package.json` 的 scripts 键（或整体 deny 后再白名单）；hook 层同步（不能只靠 claude 的 glob）。

### P0-8 组合链：`.GIT` + textconv = 持久化 RCE（Lead 新发现）`[各环节已实测]`
1. fix 模式授予 Write/Edit；
2. hook 允许写 `repo/.GIT/config`（P0-6），写入真的落到 `.git/config`；
3. `.gitattributes` 不在 deny 名单，可写；
4. 下一次 reviewer 跑允许清单内的 `git diff` → 触发 `[diff "evil"] textconv` → RCE（P0-4/5 已证执行），且 **config 与 attributes 留在用户仓库里**。

这条链不需要"仓库以压缩包投递"这个前提，因此把 P0-4/5 从"有条件 P0"提升为无条件 P0。

### P0-9 空报告按成功返回：客户端把"没产出"当"没有 finding" `[代码路径确认]`
**文件**：`src/index.js:1215-1217`、`1368-1375`；`src/claude.js:1578-1581`

`ok = subtype==="success" && !is_error && !looksLikeApiError` —— 不检查 `j.result` 是否为空。原生 pipeline 的 synthetic 兜底只覆盖 stream-json 路径。结果：一次没产出任何内容的 run 以 `isError:false` + `status:"success"` 返回，调用方（和模型）会认为"评审通过"。

**修法**：`ok` 增加 `String(j.result||"").trim().length > 0`；空报告返回 `isError:true` + "the reviewer produced no report"（附 logFile/subagentsFile）。

---

## 3. P1 — 高优先级（17 条，去重后重点 12 条）

| 编号 | 问题 | 位置 | 验证 |
|---|---|---|---|
| P1-1 | **凭据明文进 review 报告**：env 与 settings.json 的 token 不一致时，`JSON.stringify` 完整打印 `ANTHROPIC_AUTH_TOKEN/API_KEY` | `src/index.js:652-660` | 代码确认 |
| P1-2 | `init.mjs` 把 gateway token 打到 stdout，且 `~/.zcode` 配置未设 0600 | `scripts/init.mjs:202-218` | 代码确认 |
| P1-3 | **guard 安装失败静默 fail-open**：`writeGuardSettings()` 写失败返回 null，调用方不判空 → 无 hook 跑完，报告仍写 `shellGuard: PreToolUse hook` | `src/claude.js:1162-1190`、`src/index.js:600,668` | 代码确认 |
| P1-4 | **`postToPR` 是死功能**：提示词指示模型跑 `gh pr comment`、权限层也授权，但 `BASH_POLICY` 的 gh 前缀没有 `comment` → 实测 `BLOCKED(unlisted)` | `src/prompt.js:155-156,256-257,374-376` vs `src/shell-guard.js:92-98` | 已实测 |
| P1-5 | **`baseRef` 允许空格 → argv flag 注入**：`baseRef="main --fix"` → `/code-review high main --fix`，在 `fix=false` 的运行里请求 fix/comment | `src/index.js:224-241`、`src/prompt.js:230-236` | 已实测 |
| P1-6 | **realpath 不对称**：root 已 realpath、绝对路径 token 没有 → repo 含符号链接前缀时合法读取被误杀（macOS `/tmp`、`/var`） | `src/shell-guard.js:388-393` | 已实测 |
| P1-7 | `rg --files <path>` 把路径当 pattern → 读边界失效（可枚举任意目录） | `src/shell-guard.js` pathArgs | 已实测（专家） |
| P1-8 | **sync `waitForResult` 取消后已付费报告不可达**：唯一含 subagent 报告的 `interruptedResult` 被 SDK 丢弃，且 sync 路径不建 job | `src/index.js:1398 vs 1408` | 代码确认 |
| P1-9 | **已完成的 run 被判超时**：只监听 `close` + `alive` 门槛 → 父进程 exit 0 且有完整 result，22s 后仍判 timedOut，结果被丢弃、后代进程残留 | `src/claude.js:1488-1504,1622,475-494` | 已实测（专家） |
| P1-10 | `scope=pr` 不要求 `pr` → 提示词出现 "the GitHub pull request **undefined**"，native 静默改审别的目标 | `src/index.js`、`src/prompt.js` | 代码确认 |
| P1-11 | fix+postToPR=false 的 fleet 提示词自相矛盾：同段既 "read-only" 又 "FIX MODE"（默认 `effort=max` 即命中） | `src/prompt.js` | 代码确认 |
| P1-12 | **`npm test` 是红的且吞掉后续套件**：230 passed / 3 failed；`&&` 串联使 audit-fixes 272 条与 smoke 根本不执行；无任何 CI（README badge 指向不存在的 workflow） | `package.json:48`、`README.md:3` | 已实测 |

---

## 4. P2 — 值得排期的系统性债（~45 条，归纳为 8 个主题）

1. **仓库当攻击者的扫描器不完备**：`core.sshCommand`/`credential.helper` 未扫、固定 `/tmp/cc-code-review` 可被预创建替换、reviewer 的 git 无 `GIT_HARDENING_ARGS`、`.git/config`/`.env` 对 reviewer 可读可 echo。
2. **测试有效性**：4 个 headline 能力（429 抢救/增量报告/取消停计费/异步 job）在默认门禁零覆盖；`cancel-test` Windows-only + 付费；多处"自证式"断言；`validation-test` 在 macOS 5/16 失败。
3. **协议一致性**：`structuredContent` 生命周期 4 种形状、`jobId` 在最终结果消失、大结果不截断且 text/structured 双份、`logsDir()` 无 try/catch、无并发锁、默认 async 与 `instructions` 不一致。
4. **提示词自洽性**：REPORT_FORMAT 与 SKILL.md 两套格式、`>=80` 过滤与 0/25/50/75/100 标尺互斥（PLAUSIBLE 永远活不下来）、`sed -n` 被宣传可用但 guard 不认、`buildFallbackPrompt` 死代码。
5. **fail-open 残留**：`CLAUDE_REVIEW_ALLOW_UNGUARDED=1` 对"guard 安装失败"也生效；hook 内部错误路径与"一律 deny"的自述矛盾。
6. **凭据卫生**：reviewer 能 `echo $ANTHROPIC_AUTH_TOKEN`；env 工具/report 打印 gateway URL（若含 userinfo 则泄漏）。
7. **发布与兼容**：CHANGELOG 零 breaking 标注（followup 改 async、effort 默认 max、默认无费用上限）；`engines>=18.19` 从未验证（Node 18 已 EOL）；`overrides` 对消费者不生效；`files:["scripts"]` 多塞 190KB 测试代码。
8. **文档与实现不符**（多处）：README:172 "两侧都 realpath"、SECURITY.md "每条防线都被 npm test 锁定"、CHANGELOG "CI 跑 e2e"、`.GIT` "已修"。

---

## 5. 修复路线图（建议顺序）

### 第 1 批：安全地基（1–2 天）
1. **重写 tokenizer**：`$'`、`$"`、引号外反斜杠判 unsafe；`FLAG_KINDS` 支持 `-xVALUE`。补 8 条 hook 进程级回归（P0-1、P0-2）。
2. **修 `.GIT` 大小写**：hook 与 deny glob 双改；补 3 条回归（P0-6）。
3. **扩 deny-list**：`.claude/**`、`.envrc`、`.github/workflows/**`、`.vscode/**`、`.idea/**`（P0-7）。
4. **仓库文件读取硬化**：`lstat` 只收普通文件 + 大小上限 + realpath 校验（P0-3）。
5. **git config 扫描换成 `git config --list -z`**，`.gitattributes` 递归（P0-4/5）。

### 第 2 批：正确性与可信度（1 天）
6. 空报告 → `isError:true`（P0-9）；sync 取消保留报告（P1-8）；completed 判超时（P1-9）。
7. 凭据脱敏（P1-1、P1-2）；guard 写失败 fail-closed（P1-3）。
8. `postToPR` 链路打通或删除该参数（P1-4）；`baseRef` 禁空格（P1-5）；realpath 双向（P1-6）。

### 第 3 批：质量门禁（半天）
9. `npm test` 改汇总退出（不再 `&&` 吞套件）；修 3 条 POSIX 失败；把 `cross-cases` 的 C8/C16/C17/C19 并入。
10. 恢复 `.github/workflows/ci.yml`（matrix：ubuntu/macos/windows × node 20/22/24）——否则 README 的 badge 应删除。
11. 修正 CHANGELOG/README/SECURITY 中所有与实现不符的承诺。

---

## 6. 做得好的地方（审计中确认，不要误伤）

- **单点真相**：`BASH_POLICY` 同时渲染 claude 权限规则与 hook 判定，架构方向正确（问题在 tokenizer 不在分层）。
- **guard 自检**（`guardSelfTest` 三探针）与"装上了不等于能用"的判断是对的，且 stale-process 检测很务实。
- **进程组 kill**：正常超时/取消实测 800ms/503ms 返回且 pid 死去。
- **429 增量抢救**：每个 subagent 完成即 append JSONL + 从 transcript 恢复，设计对得起"不浪费已付费工作"。
- **stdout 零污染**：黑盒实测 stdout 无任何非 JSON 行；错误全部 `isError:true` + 可操作文案；progress token 字段正确。
- **输入校验**：相对路径、非 git 仓库、未知 jobId、`-rf` 注入 sessionId 全部被拦，文案专业。
- **文档诚实度高于平均**：`claude_review_env` 会主动报告版本降级、模型替换、gateway 差异。

---

## 7. 方法与可复现性

- 专家各自只读 `src/`/`scripts/`，写各自 `audit/0X-*.md`；Lead 未修改任何源码。
- 所有 P0 与关键 P1 由 Lead 独立复现，脚本在 `/tmp/probe*.mjs`（可重跑）。
- 未运行任何付费脚本（`paid-smoke`/`cross-cases`/`e2e`），未联网，未 `npm install`。
- 基线：`npm test` = shell-guard 230/3、audit-fixes 272/0、smoke PASS（完整日志 `/tmp/npm-test.log`）。
