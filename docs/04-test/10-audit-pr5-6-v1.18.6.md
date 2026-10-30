---
title: PR #5/#6 最终审计报告
version: v1.18.6
created: 2026-10-30
status: final
---

# 最终审计报告 — PR #5 / PR #6（v1.18.5 + v1.18.6）

- **审计对象**：`KentQi/cc-code-review`
  - PR #5 `fix/1.18.5-security-audit`（base `fcc8ff62` → head `9f6d6336`，26 files，+2900/-653）
  - PR #6 `fix/1.18.6-security-audit`（base `9f6d6336` → head `92974060`，15 files，+1035/-368）
  - 合并评审范围：`fcc8ff62` → `92974060`（= 本地工作树，逐文件 blob SHA 一致）
- **日期**：2026-10-30
- **工作目录**：`/Users/kent/Desktop/projects/cc-code-review_MCP`（**非 git 工作副本**，无 `.git`）
- **diff 获取方式**：`gh pr diff` + `gh api .../tarball` 三棵树（1.18.4 base / 1.18.5 head / 1.18.6 head）落盘 `/tmp/cr56/`

---

## 0. 一句话结论

**这一轮修得比前几轮更接近根因**：`GIT_HARDENING` 单表 + 加载期断言把「子进程加固 / `-c` 加固 / 扫描器」三层的漂移从「约定」变成了「启动即失败」，我实测复现了 P0-1 / P0-2 / P0-3 三个家族**全部被拦住**；hook 的写入边界（含 rename 型 install hook 与符号链接逃逸）也全部按文档工作。

但仍有 **1 条安全边界缺口**（`find --files0-from`）与 **1 条被夸大的单源声明**（`FIX_PROTECTED_WRITE_GLOBS` 号称 "ONE table"，实际仍是三份手工同步的清单，且已经不一致）。

**门禁是绿的且这次是真的绿**：我把本轮新增的 28 条 deny 断言回放到 PR 前的 1.18.4 代码上，**21 条在旧代码上不成立、在新代码上全部成立**——即新增断言确实在锁修复，而不是「新旧都过」。

### 计分卡

| 级别 | 条数 | 说明 |
|---|---:|---|
| **P0** | 0 | 未发现可实测的宿主任意命令执行 |
| **P1** | 1 | 安全边界缺口：`find --files0-from` 双横线拼写未被拒（PLAUSIBLE） |
| **P2** | 6 | 单源声明失真 + 冗余状态 + 重复实现 + hook 双重 realpath |
| **P3** | 5 | 死导出、README 计数过期、audit 文档违反 R3、`.env.example` 双层不一致 |
| **合计** | **12** | 其中 P1 及以上 1 条 |

---

## 1. P1 — `find --files0-from` 的双横线拼写绕过了拒止表

**文件**：`src/shell-guard.js:483`（`OUTRIGHT_DENY.find`）
**状态**：PLAUSIBLE（机制已在代码层确认；触发取决于宿主的 `find` 实现，见下）

```js
  // GNU find only, but the guard must not depend on which find the host has:
  // the flag follows a NUL-separated list of start paths from an arbitrary file.
  find: {
    "-files0-from": "`find -files0-from` follows a list of paths that may point outside the repository",
  },
```

本 PR 的核心工程决定是：**长选项可以被缩写成任意无歧义前缀**，为此新增了 `longOptionIs()`，并明确写道「git accepts `--cont` for `--contents`, GNU sort accepts `--files0` for `--files0-from`」。但 `denyReasonIn()` 只在表项本身以 `--` 开头时才走缩写逻辑：

```js
function denyReasonIn(table, word) {
  const name = flagName(word);
  for (const [option, why] of Object.entries(table)) {
    if (option.startsWith("--") ? longOptionIs(name, option) : name === option) return why;
  }
```

`find` 这一项拼成**单横线** `-files0-from`，于是它走的是 `name === option` 的精确匹配分支，`longOptionIs` 完全不起作用。实测（`node` 直接 import HEAD 的 `analyseCommand`，repoRoot 指向一个真实 git 仓库）：

```
BLOCK "find -files0-from /etc/passwd"
ALLOW "find --files0-from /etc/passwd"     <== 缺口
ALLOW "find --files0-from=/etc/passwd"     <== 缺口
ALLOW "find --files0 /etc/passwd"          <== 缺口
```

**影响已被实测证实**：`-files0-from` 会把**宿主文件的全文**打到 stderr，而 stderr 会进入 run log 与报告：

```
$ find -files0-from /etc/passwd
bfs: error: ##
# User Database
# 
# Note that this file is consulted directly only when the system is running
...
```

即：被审仓库只要让评审 agent 跑一句 `find --files0-from ~/.ssh/id_rsa`（或 `/etc/passwd`、`.env`），宿主持有者就能读到文件全文并进入交给调用方的报告——与上一轮 P0-4/P0-5/P0-7 同一后果。

**为什么标 PLAUSIBLE 而不是 CONFIRMED**：本机 `find` 是 `bfs 4.1.1`，它**拒绝**双横线拼写并主动提示单横线形式：

```
$ find --files0-from /dev/null
bfs: error: Unknown argument; did you mean -files0-from?
```

GNU findutils 把该选项文档化为单横线（`-files0-from file`），且其全局选项存在 `-help, --help` 这类双横线别名；GNU find 的选项解析是 `getopt_long_only` 风格（单横线长名是 find 的历史形式），而 `getopt_long_only(3)` 的语义是「`-` 与 `--` 都可以引导长选项」。因此 GNU find 极可能同时接受两种拼写，但**我无法在本机实测**（无 GNU find）。确认方式：在一台装有 GNU findutils 的 Linux 宿主上重放上面四条命令。

**为什么这仍然是一条缺陷（无论 GNU find 是否接受）**：guard 自己的设计原则是「不得依赖宿主上是哪个 find」。表项拼成单横线、而 PR 专门加的缩写机制又只覆盖 `--` 表项，这个不对称就是缺口本身。修法与 PR 已有的 `git`/`wc`/`sort` 表项一致：把 `find` 表项写成 `--files0-from`（并保留单横线别名），或让 `denyReasonIn` 对 `-` 开头的长名也走 `longOptionIs`。

**覆盖缺口**：`scripts/shell-guard-test.mjs` 新增了 `wc`/`sort` 的 `--files0-from` 与 `git` 的 `--cont`/`--exclude-f` 缩写断言，但**没有任何一条断言覆盖 `find` 的这个拼写**——这正是本轮测试回放（见 §4）里唯一漏掉的方向。

---

## 2. P2 — 「ONE table」是假的：写入保护仍是三份手工同步的清单

**文件**：`src/prompt.js:797`（`FIX_PROTECTED_WRITE_GLOBS` 的文档注释）
**状态**：CONFIRMED（无安全洞，但声明失真且清单已不一致）

`src/prompt.js` 注释写道：

> Path classes fix mode may not write, as permission-engine globs. **ONE table:** … The list lives here, exported, so the hook can import it instead of hand-porting a glob dialect a second time.

但 hook **并没有 import 它**。`scripts/pre-tool-hook.js:53` import 的是 `src/shell-guard.js` 的 `PROTECTED_WRITE`（22 条正则），而 `src/shell-guard.js:496` 自己写着：

> prompt.js still renders its own glob list for the permission engine. … **The two lists are kept in step by hand**

此外 hook 内还有第三份 `.git` 内联规则（`scripts/pre-tool-hook.js:265`）。三份清单**已经不一致**，实测对比（把 54 个代表性路径逐个喂给真实 hook 进程）：

| 路径 | 权限引擎 globs | hook | 结论 |
|---|---|---|---|
| `.pre-commit-config.yml` | 否 | 是 | 仅 hook 有 |
| `.docker/config.json` | 是 | 否（但被 `SECRET_READ` 拦） | glob 独有 |
| `.env` / `.env.local` | 是 | 否（但被 `SECRET_READ` 拦） | glob 独有 |
| `.husky/`、`.github/actions/`、`.circleci/`、`.vscode/`、`.idea/`、`.mcp.json`、`.gitmodules`、`.gitattributes`、`.gitconfig`、`.claude/`、`.devcontainer/`、`.Git/config` | 否 | 是 | 仅 hook 有 |
| 其余 41 个路径 | 是 | 是 | 一致 |

**实测结论：54 个路径中 53 个被 hook 拒，唯一放行的是 `.env.example`**（`SECRET_READ_ALLOW` 有意放行模板）。所以**没有安全洞**——hook 是父集，且它是唯一能看到「尚不存在的路径」的层。代价是维护性的：注释声称的单源不存在，三个副本只能靠人同步，而它们已经漂移（`.pre-commit-config.yml` 就是实例）。更简单形式：一份导出的路径类表，权限引擎 glob 与 hook 正则都从它派生。

---

## 3. 其余 P2

### 3.1 `tilde` 数组完全可由 `unquoted` 推导 — `src/shell-guard.js:230`

PR 在 `words`/`unquoted` 之外加了第三条平行数组 `tilde`：

```js
    if (c === "~" && !inWord) wordTilde = true;
    wordUnquoted += c;
```

`wordTilde` 仅在「单词首字符是无引号 `~`」时为真，而此刻 `wordUnquoted` 恰好以 `~` 开头；`~` 出现在词中时 `inWord` 为真，`wordTilde` 保持 false 且 `wordUnquoted` 不以 `~` 开头。因此 `wordTilde === wordUnquoted.startsWith("~")` 恒成立。它只被读一次（`src/shell-guard.js:1099` 的 `Boolean(tilde[i + 1])`）。更简单形式：删掉 `tilde` 数组、`segmentProblem` 的 `tilde` 参数与两处 `segs[i].tilde` 实参，改用 `(unquoted[i + 1] || "").startsWith("~")`。留着的代价：三条平行数组必须在 `endWord`/`endSeg` 里同步 push 与 reset，将来改 tokenizer 时忘记同步 `tilde` 就会静默与 `unquoted` 分叉。

### 3.2 `ensureOwnedPrivateDir()` 是新增副本，没有取代原实现 — `src/claude.js:1676`

新 helper 的注释自称「Same three checks the guard-settings directory uses」，但它是**加在**原来的内联块旁边，而不是替换它：`writeGuardSettings()`（`src/claude.js:1630-1642`）仍然自己带着一份 `mkdirSync` + `isSymbolicLink` + `getuid` + `chmod`。同一文件里现在有两份目录属主安全检查，只靠人工同步（措辞都已不同：新副本说 `what + " directory"`，旧副本说 `"guard directory"`）。`grep -n ensureOwnedPrivateDir src/claude.js` → 仅 1676（定义）与 1864（唯一调用点）。更简单形式：删掉 1630-1642，改调 `ensureOwnedPrivateDir(dir, "guard")`——外层 try/catch 已把 throw 转成 `return null`，替换是行为等价的。

### 3.3 `GIT_HARDENING` 的 `env` / `args` 两个布尔永远相同 — `src/claude.js:406`

16 个固定键条目全部拼 `env: true, args: true`，6 个 pattern 条目两个都不拼。所以 `env` 100% 可由 `args` 推导，永无合法分歧；而加载期断言还要花约 5 行 policing 它们（`src/claude.js:469-476` 的第二条 throw 在 `args === env` 的表上永不触发）。两个消费者 `GIT_HARDENING.filter((e) => e.args)`（:530）与 `GIT_HARDENING.filter((e) => e.env)`（:597）选出同一批 16 行。更简单形式：一个 `harden: true` 字段，同时把 :490 的 `entry.env === true || entry.args === true` pattern 检查折叠进去。

### 3.4 `launchAckBody()` 复制了 `looksLikeLaunchAck()` 的整段形状前置检查 — `src/claude.js:1047`

新函数把四个形状测试逐字重写了一遍（`ACK_HEAD` 匹配、`/^\([^)]*\)?$/` 括号规则、`agentId`/background 检查），只在返回类型上分叉（boolean vs body|null）。参数化形式：一个 `ackShape(text)` 返回 `{nl, firstLine, head, ok}`，`looksLikeLaunchAck` 变成 `ackShape(...).ok`。留着的代价：括号规则现在写了两遍，若一份收紧另一份没有，`launchAckBody` 就会接受一个 `looksLikeLaunchAck` 有意排除的形状，而调用点 `r.ack || ackBody !== null || looksLikeLaunchAck(r.text)`（:1964）便会把一份被刻意排除的 tool_result 的正文当成评审报告归档。

### 3.5 hook 每次工具调用做两次包含性判定 — `scripts/pre-tool-hook.js:249`

`repoRelative(root, target)` 之后紧跟 `isInsideRepo(root, target, {...})`，而 `isInsideRepo` 内部算的就是同一个 `path.relative(realRoot, realpathNearest(target))`（`src/shell-guard.js:884-885`）。Write/Read/Grep/Glob 每条调用因此付两次 `repoRealpath` + `realpathNearest` 文件系统遍历，比较两个只可能相同的答案。`isInsideRepo(root, token, {allowRoot})` 恰恰等于 `repoRelative(root, token)` 加一个 `""` 判定，那个 `{allowRoot, shellSyntax}` 选项对象只是为了重新推导 `rel` 已经说出的结论。更简单形式：保留一次调用，对已算出的 `rel` 做一个小谓词。（注意：`rel` 仍被 `relSlash` 的 secret/PROTECTED_WRITE 检查需要，所以不是纯浪费，是 2 次遍历 vs 1 次。）

---

## 4. 门禁充分性（Angle L）— 这次是真绿

本轮测试增量：`shell-guard-test.mjs` +60/-0，`audit-fixes-test.mjs` +120/-11，`p0-regression-test.mjs` +328/-4，`pack-test.mjs` +61/-2。测试源码注释自称已做变异测试（"mutation-tested"），我独立验证了这一点：

把本轮新增的 **28 条 deny 断言 + 12 条 allow 断言**分别在 **1.18.4（PR 前）** 与 **1.18.6（PR 后）** 的 `src/shell-guard.js` 上回放：

```
base:  7/28 deny-cases blocked, 12/12 allow-cases allowed
head: 28/28 deny-cases blocked, 12/12 allow-cases allowed
```

即 **21 条 deny 断言在旧代码上不成立、在新代码上全部成立**——它们确实在锁修复，不是「新旧都过」的空断言。未覆盖的 7 条（`rg --files /etc`、`find . -newer /etc/passwd` 等）在 1.18.4 就已被拦，属于上一轮 P2-12 的回归锁。

同时验证**没有过度拦截回归**：把 prompt / SKILL.md / README 告知评审者可以跑的 45 条命令形状全部喂给 HEAD guard，**45/45 放行**（含 `gh pr view KentQi/cc-code-review#5`、`gh pr comment 5 --body "..."`、`git log --oneline main...HEAD`、`cd <repo> && git show HEAD`、`git show HEAD | head -50`、`rg -n TODO src`、`grep -rn x src`）。本轮新增的 `rg --hidden/-u/--no-ignore` 与根级递归 `grep` 拒止没有误伤文档承诺的命令面。

---

## 5. 已实测确认「前几轮 P0 全部真的修好了」

用 9 个敌意 fixture 直接调用 HEAD 的 `repoRunsGitPrograms()`：

| fixture | 期望 | 实测 |
|---|---|---|
| `.git/config` 设 `protocol.ext.allow = user` | 拒 | **拒** ✅ |
| `.gitattributes` + config 里的 `diff.evil.textconv` | 拒 | **拒** ✅ |
| `node_modules/.gitattributes` 引用同一 driver（P0-3） | 拒 | **拒** ✅ |
| `.git/config.worktree` 设 `core.pager` 与 `url.insteadOf`（P0-2） | 拒 | **拒**（2 条）✅ |
| `[include] path` 指向仓库外且含 `core.pager`（P1-1） | 拒 | **拒** ✅ |
| `core.pager = /bin/echo PWNED` | 拒 | **拒** ✅ |
| `url.<base>.insteadOf` 改写（P0-1 家族） | 拒 | **拒** ✅ |

`[include]` 逃逸一例还由 git 自身交叉验证：`git -C <repo> config core.pager` 真的返回 `/bin/echo PWNED`，证明 scanner 拒的不是假想敌。

hook 侧用真实子进程验证了 20 个 payload：`.env` 读写、仓库外写、`.github/workflows` 写、Grep/Glob 路径越界、`rg .env`、`git show HEAD:.env`、`cat .*`、Edit/MultiEdit 型 install hook（**含 `preinstal` → `preinstall` 改名这一 PR 专门声称修掉的形态**）、NotebookEdit 越界、经仓库内符号链接写 `/etc`——**全部 DENY**；`rg -n x .env.example` 与 `git status` 正确 PASS。secret 读取面另测 12 条变体（`git log -p -- .env`、`git diff HEAD -- .env`、`rg -g .env`、`grep -r x ./.env`、`find . -name .env`、`ls -la .ssh`、`git ls-files .env`、`git show HEAD:.npmrc` …）**全部 DENY**。

`gitHardening` 侧我也验证了一个我本来怀疑的假设：`-c core.hooksPath=`（空值）是否会把 hook 目录重定向到**当前工作目录**（那会让仓库里的 `post-checkout` 变成 hook）。实测（对照组证明 `.git/hooks` 在无加固时确实会触发）：

```
### TEST 1: -c core.hooksPath= (empty), real switch  -> (no marker)
### TEST 2: env GIT_CONFIG_KEY_0=core.hooksPath        -> (no marker)
### TEST 3: control, no hardening at all               -> MARK_GITDIR_HOOK
```

假设被**否证**：空 `core.hooksPath` 确实中和了 `.git/hooks`，这项加固成立。

---

## 6. P3

### 6.1 `export { GIT_HARDENING }` 是死导出 — `src/claude.js:524`

注释说「exported so the self-test can prove the three views agree」，但同一 PR 加的自测并不 import 它：`scripts/audit-fixes-test.mjs:18` 只 import `GIT_HARDENING_ARGS`，并用**对源码文本做正则**的方式证明该性质（`scripts/audit-fixes-test.mjs:1078`：`(claudeSrc.match(/const GIT_HARDENING = \[/g) || []).length, 1`）。要么删掉导出与注释，要么真的在自测里 import 并断言三个视图。

### 6.2 `reportContractSource()` 是死导出 — `src/prompt.js:499`

`loadReportContract()` 返回 `{source, lines}`，其中 `source` 除 `reportContractSource()` 外无人读取，而 `reportContractSource()` 无人调用（实测 `reportContractSource()` 返回 `"skill"`，即 asset 提取成功）。`source` 判别符与整个访问器都是死重。要么删掉，要么真的把降级（fallback） surfaced 给调用方——后者更有价值：契约降级到内置副本时，调用方现在无从得知。

### 6.3 README 的测试计数已过期 — `README.md:165` / `README.en.md:167`

两个 README 都写「契约由 `scripts/shell-guard-test.mjs`（238 条…）与 `scripts/p0-regression-test.mjs`（95 条…）锁定」，而同一 PR 的 `CHANGELOG.md:14` 写「shell-guard 298, audit-fixes 314, p0-regression 206…」，实跑套件也确认为 298 / 206。一个 PR 内两份文件对同一批套件给出不同数字，安全模型因此少报 60 + 111 条覆盖。

### 6.4 `README.en.md` 缺 1.18.5/1.18.6 的安全边界章节 — `README.en.md:167`

PR #6 把整段 1.18.5/1.18.6 安全叙事（`GIT_HARDENING` 单表、`rg --hidden/--no-ignore/-u` 与根级递归 `grep` 被拒、fail-closed 的 `.git/config` 不可解析即拒评审、install-hook 检查、指纹覆盖内联规则代码、lockfile 的 94 个 tarball URL 迁回 `registry.npmjs.org`）加进 `README.md`，但 PR #6 的文件清单里**没有 `README.en.md`**；`grep GIT_HARDENING\|no-ignore\|--hidden\|npmmirror README.en.md` 零命中。两个本应互为翻译的文件现在描述不同的威胁模型。

### 6.5 `README.md:88` 与代码相反 — `README.md:88`

参数表写 `baseRef`「非法字符会被忽略」，而 `src/index.js:1895-1896` 是硬拒：`if (!baseRefCheck.ok) return err(baseRefCheck.error);`。同一份 README 在 132 行后又自相矛盾（「因此直接拒绝而不是"忽略"」），英文孪生 `README.en.md:90` 正确地写 "illegal characters rejected"。按中文 README 行事的调用方传 `baseRef="release 1.2"` 会得到评审前拒绝，而非文档承诺的静默回退。

### 6.6 新增的 5 份 audit 文档违反 `CLAUDE-PROJECT-RULES.md` §四（R3） — 现 `docs/04-test/16-fix-round6-v1.18.6.md:1`

`/Users/kent/.claude/CLAUDE-PROJECT-RULES.md` §四.2 规定命名 `NN-类型-主题-vX.Y.md`，§四.3 规定「头部必带 YAML frontmatter(title / version / created / status)」，§四.1 规定文档统一在 `/docs/`；R3 机检这条。PR #5/#6 新增 `docs/04-test/10-audit-pr5-6-v1.18.6.md`、`docs/04-test/10-audit-pr5-6-v1.18.6.md`、`docs/04-test/10-audit-pr5-6-v1.18.6.md`、`docs/04-test/10-audit-pr5-6-v1.18.6.md`、`docs/04-test/10-audit-pr5-6-v1.18.6.md`——均无 frontmatter、均不匹配命名式、仓库无 `/docs/` 树。代价：本 PR 赖以论证「closes P0-1 / P1-4 / …」的审计轨迹对机检的文档契约不可见。

### 6.7 `.env.example` 在两层不一致（有意但未文档化到代码层） — `src/prompt.js:531` vs `src/shell-guard.js:562`

权限引擎 glob `.env.*` 会拒 `.env.example`，hook 的 `SECRET_READ_ALLOW` 有意放行它，prompt 也告诉模型「`.env.example` / `.env.sample` templates are allowed」。由于权限引擎的 deny 是外层，`.env.example` 实际上仍不可写——与 prompt 的承诺相反。属轻微过度限制，非洞。

---

## 7. 验证方式与复现入口

| 项 | 命令 / 位置 |
|---|---|
| guard 探针（28 deny + 12 allow + 45 文档命令 + find 拼写） | `node /tmp/cr56/scratch/probe.mjs '<cmd>' …` |
| 新旧代码回放（证明断言有效） | `node /tmp/cr56/scratch/mut.mjs base` / `head` |
| hook 真实子进程探针 | `node /tmp/cr56/scratch/hook.mjs '[[label,payload],…]'` |
| hook 对 glob 保护路径的覆盖 | `node /tmp/cr56/scratch/hookpaths.mjs <rel>…` |
| 敌意 fixture 扫描器 | `node /tmp/cr56/scratch/scan.mjs <repo>` |
| `core.hooksPath=` 空值行为 | `git -c core.hooksPath= checkout other`（见 §5） |
| 三棵源码树 + 分文件 diff | `/tmp/cr56/trees/{base-1.18.4,head-1.18.5,head-1.18.6}`、`/tmp/cr56/pf/*.diff` |

**说明**：本机 `find` 为 `bfs 4.1.1`，非 GNU findutils；§1 的 GNU find 行为为依据 `getopt_long_only(3)` 语义与 findutils 文档的推断，未在本机实测。

---

## 8. 审计过程记录（含未完成部分，诚实交代）

- 计划 12 路独立 finder 角度并行 + 每候选 1 票验证 + 缺口清扫。
- **实际完成 2 路**（Angle G 简化 / Angle J 约定与文档契约）后，账号触达 **Token Plan 用量上限（HTTP 429）**，其余 10 路（逐行 diff ×3、删改行为、跨文件、语言陷阱、包装器、效率、层次、对抗红队、上轮修复闭环）**全部中途失败**。
- 用户随即要求「每一次并发不要超过 5 个 subagents」——首次 12 路并发本身就是违规，且已造成额度浪费。
- 剩余的 10 个角度由本会话**自行顺序完成**（未再启动任何 subagent）：逐行 diff（`src/claude.js`、`src/index.js`、`src/prompt.js`、`src/shell-guard.js`、`scripts/pre-tool-hook.js` 全部通读）、删改行为比对（三棵树 `diff -rq` + 删除行 invariants 追查）、跨文件 tracer（`nativeTarget`/`baseRef`/`paidPreflight`/`subagentsView`/`pruneReviewJobs` 全部追到调用点）、语言陷阱、包装器与 hook 协议适配、效率、层次（根因 vs 特例）、对抗红队（guard 与 hook 的实证绕过尝试）、上轮修复闭环（P0-1/P0-2/P0-3 家族逐个复现）。
- **因此本报告的覆盖面低于原计划**：尤其「删改行为」与「上轮 P1 闭环」两个角度只做了抽查而非 14 条逐条闭环，PR #5/#6 声称关闭的 7 P0 + 14 P1 中我逐条实测确认的是 P0 家族 7 项与 P1 中直接相关的数项，其余依据代码阅读判断。
