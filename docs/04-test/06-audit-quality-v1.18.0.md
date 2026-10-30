---
title: 首轮审计 · 质量视角
version: v1.18.0
created: 2026-10-29
status: final
---

# 05 — 测试与工程质量审计（scripts/ + 发布配置）

审计对象：cc-code-review v1.18.0（`package.json:3`）。范围：`scripts/` 全部 12 个脚本、`package.json`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`（测试/发布相关）。全程只读 `src/`/`scripts/`，未联网、未运行任何付费脚本。

**问题计数**：P0×1、P1×3、P2×11、P3×5（共 20 条，全部带 文件:行号 证据）。

**结论一句话**：这套测试里确实有真东西（hook 进程级回归、真实 review 命令回放、junction/软链逃逸、stub 端到端），但**默认门禁 `npm test` 只覆盖"guard + 纯函数 + git 预检"，且它在 POSIX 上必红（macOS 3 条、Linux 2 条），又没有任何 CI**；README/CHANGELOG 声称的 4 个 headline 能力（429 抢救、增量报告、取消停计费、异步 job 模型）在默认门禁里**零回归**。另发现 1 条 CHANGELOG 声称已修的 P0 在真实 hook 上仍可绕过（`.GIT` 写 hook），且没有任何测试守着它。

---

## 0. 本次审计实际执行的验证（全部免费、无外网）

| 动作 | 结果 |
|---|---|
| `node scripts/audit-fixes-test.mjs`（HOME/XDG 指向临时目录） | **272 passed / 0 failed**，exit 0（与 `CHANGELOG.md:18` 的 272 一致） |
| `node scripts/validation-test.mjs` | **16 checks 中 5 FAILED**，exit 1（见 Q6；该套件不在 `npm test`） |
| `node scripts/smoke-test.mjs` | PASSED（本机有 claude CLI；无 claude 时会失败，见 Q9） |
| `npm pack --dry-run --json` + `npm pack --pack-destination /tmp` | 26 个文件 / 203,249 B 压缩 / 613,667 B 解压；**含 `scripts/pre-tool-hook.js` 与 `assets/skills/code-review/SKILL.md`**（见 Q15） |
| `npm ci --dry-run --offline` / `npm ls --all` | exit 0 / exit 0 → **lock 与 package.json 同步** |
| `npm ls @hono/node-server` | `1.19.9 overridden`（见 Q14） |
| 直接 probe `analyseCommand()` 与 `scripts/pre-tool-hook.js`（node 进程内，无 claude） | 复现 Q1、Q4、Q11 的行为 |
| `find . -name '*.yml'` / `ls .github` | **无任何 yml、无 .github 目录**（见 Q3） |
| `grep -rn 429\|cancel\|incremental scripts/*.mjs` | 确认能力覆盖分布（见第 2 节矩阵） |

未运行：`paid-smoke.mjs`、`cross-cases.mjs`、`e2e-test.mjs`、`followup-e2e.mjs`、`cancel-test.mjs`（付费或需真实 CLI；按任务要求回避）。

---

## 1. 问题清单

### P0

#### Q1【P0】CHANGELOG 声称已修的 `.GIT` 写 hook 绕过，在真实 hook 上仍然放行，且无任何回归测试
**证据**
- 声称：`CHANGELOG.md:10` "**[P0/M] Smaller policy holes**: … the case-sensitive `.GIT` write bypass in fix mode … are all refused."
- 实际控制点：`scripts/pre-tool-hook.js:117-122`，判定是大小写敏感正则 `/^\.git([\\/]|$)/.test(rel)`；`realContainment()`（`pre-tool-hook.js:66-92`）调用 `fs.realpathSync`，而 **macOS/Windows 大小写不敏感卷上 realpath 仍保留用户写入的大小写**，所以 `rel = ".GIT/hooks/pre-commit"`，正则不命中。
- 实测（本机 macOS，直接 spawn 真实 hook，非 mock）：
```
<repo>/.git/hooks/pre-commit  => {"permissionDecision":"deny", ...}   ← 正常拦截
<repo>/.GIT/hooks/pre-commit  => （空输出 = allow）
<repo>/.Git/config            => （空输出 = allow）
```
- 另一层（Claude Code 的 deny glob，`src/prompt.js:359-368` 只写了 `.git`/`**/.git` 等小写形态）是否在大小写不敏感文件系统上兜住，**无法从仓库内验证**；而 `scripts/audit-fixes-test.mjs:122-126` 自己写明 "Assert the hook, which is the deterministic control"——确定性控制层现在放行。
- 测试侧：`scripts/shell-guard-test.mjs:359-360` 只测 `.git/`（小写）；`scripts/audit-fixes-test.mjs:180-181` 只断言 deny 规则**字符串**存在。全仓 `grep -n '\.GIT\|\.Git'` 在 scripts/ 下 0 命中。
**影响**：fix 模式下被 prompt-injected 的评审者可以写 `repo/.GIT/hooks/pre-commit`（在大小写不敏感卷上落到真实 `.git/hooks/`），用户之后任何 commit 都会执行它。这是 CHANGELOG 明确按 P0 处理的同一条洞。
**修复**：hook 内对 `rel` 做大小写不敏感匹配（`win32`/`darwin` 用 `/^\.git([\\/]|$)/i`，或用已 realpath 的 `.git` 实际目录做前缀比较）；同时补 `Write/Edit → repo/.GIT/hooks/pre-commit` 与 `.Git/config` 的 hook 进程级回归用例。同步更正 CHANGELOG:10（若上游另有修法，请把该修法落到本仓库代码）。

---

### P1

#### Q2【P1】README 的 4 个 headline 能力在 `npm test` 里没有任何回归保护；唯一免费覆盖在 `cross-cases.mjs`，而它不在默认门禁里
**证据**
- 默认门禁只有 3 个脚本：`package.json:48` `"test": "node scripts/shell-guard-test.mjs && node scripts/audit-fixes-test.mjs && node scripts/smoke-test.mjs"`。
- 429 抢救：集成逻辑在 `src/claude.js:1515-1550`（finish() 的 recovery pass）、`src/claude.js:1425-1443`（空 summary 回退 transcript）、`src/index.js:490-495`（429 文案）。`npm test` 只测了纯函数 `parseAgentLaunchAck/recoverReportFromTranscript`（`audit-fixes-test.mjs:692-739`）；**429 文案与 finish() 恢复链路只有 `cross-cases.mjs` C17/C13**（`cross-cases.mjs:603-623`、`456-476`），而 429 关键词本身没有任何测试命中（全仓 `grep 429 scripts/` 只在注释里）。
- 增量报告：`src/claude.js:1343-1390`（每次完成即 append JSONL）、`src/index.js:1182-1191`；只有 C16/C19（`cross-cases.mjs:556-601`、`646-678`）验证"运行中 poll 可见 + 文件行数一致 + 取消后保留"。
- 取消停计费：`src/claude.js:475-494 killTree()`、`:1488-1503`（timeout/abort/kill failsafe）、`src/index.js:1462-1466`（status cancel）。免费覆盖只有 C8（`cross-cases.mjs:345-367`，用 stub pidfile 证明进程真死）；真实 MCP `notifications/cancelled` 路径只有 `scripts/cancel-test.mjs`，而它 **Windows-only（`cancel-test.mjs:50-55` 用 `tasklist`，其他平台 `execSync` 抛错→`claudeProcs()` 恒为 0→`started=false` 必 FAIL）且付费（`cancel-test.mjs:13`）**。README 的"取消后约 2 秒内…立刻停止计费"（`README.md:203`）在 macOS（作者当前平台）**没有任何可执行验证**。
- 异步 job 模型：`src/index.js:1136-1141`（默认 async）、`:1449-1496`（poll/cancel/list）。`npm test` 的 smoke 只做握手 + `claude_review_env`，从不调用 `claude_code_review`（`scripts/smoke-test.mjs:80-86`）。
**影响**：这 4 项是本项目最贵、最容易回归的路径（尤其 `killTree`/timeout/JSONL 追加），但改坏了 `npm test` 仍然全绿——除非有人手动记得跑 `node scripts/cross-cases.mjs`。
**修复**：把 `cross-cases.mjs`（或至少 C8/C16/C17/C19 四块）加进 `npm test`：它本身免费（stub claude），只需在 CI/本地设 `CLAUDE_CODE_PATH=<repo>/scripts/stub-claude.mjs`；跨平台取消测试用 stub pidfile 的 `process.kill(pid,0)` 断言替代 `tasklist`。

#### Q3【P1】"CI 会跑"是失实的：仓库没有任何 CI 配置；`npm test` 用 `&&` 串联，首个套件一红就吞掉后面 272 项检查
**证据**
- `README.md:3` / `README.en.md:3` 挂了 `ci.yml` 的 CI badge；`CHANGELOG.md:144` 写 "The e2e suite now runs in CI… Added `npm run test:e2e` and a hermetic CI step"；`CONTRIBUTING.md:10` 写 "（免费，无需 claude CLI/网络；CI 也会跑）"。
- 实测：整仓（除 node_modules）**没有任何 `.yml/.yaml`，没有 `.github/`**；本目录甚至不是 git 仓库（`git rev-parse` fatal）。Lead 的 `/tmp/npm-test.log` 也印证：245 行日志只跑到 shell-guard 的 `FAILURES: 230 passed, 3 failed` 就结束，audit-fixes 与 smoke 的输出完全不存在。
- 根因：`package.json:48` 用 `&&`；`shell-guard-test.mjs:429-430` 首套件失败即 exit 1。
**影响**：质量门禁名存实亡。当前 macOS 上 `npm test` 必然红，且红的结果是"后面两套根本不知道有没有过"；README 的安全性承诺失去持续验证。Lead 已跑出 230/3、exit 1，与"无 CI、无人发现"一致。
**修复**：恢复 `.github/workflows/ci.yml`（矩阵 ubuntu/macos/windows × node 18.19/20/22；跑 `npm test`、`npm run validate`、`npm run test:e2e`（stub））；`npm test` 改成依次跑、汇总退出（例如 `node scripts/run-all.mjs` 或 `npm-run-all -c`），不要让第一套失败掩盖其余套件。

#### Q4【P1】`isInsideRepo()` 的 realpath 不对称是真实产品 bug（Lead 已定位；本审计确认测试用例本身合法）
**证据**
- `src/shell-guard.js:388-393`：`realRoot = repoRealpath(root)`（已 realpath），但 `const target = path.resolve(realRoot, token)` 对**绝对路径 token 不会 realpath**，随后 `path.relative(realRoot, target)`。
- 实测 macOS：`os.tmpdir()=/var/folders/…`，`realpath(tmp)=/private/var/folders/…`；`analyseCommand("find \"<lexical repo>\" -name x")` → `ok:false, kind:"dangerous", reason:"… resolves outside it"`。`find . -name x` 正常。
- 失败的是 `scripts/shell-guard-test.mjs:146`（SCOPE_OK 数组，经 `:155` 断言 allowed）；这是合理契约："模型把仓库根路径写进 find 的参数"本来就该放行，实际被误杀。`/tmp/npm-test.log:92` 与该用例对应。
**影响**：任何 repo 路径经过符号链接（macOS 的 /tmp、/var；Linux 的 symlinked workspace）时，合法的绝对路径读命令会被 hook 拒绝（turn 浪费、评审退化）；而相对路径正常，所以只在特定环境暴露。属 P1 功能错误。
**修复**：containment 比较统一口径——先把 token 按**词法 root** 解析（`path.resolve(root, token)`），再对已存在的最深祖先 realpath（`isInsideRepo` 后半段已有此逻辑，只是前面用错了 root），或对 `realRoot` 与 `realpathSync(target)` 两侧同时 realpath。回归用例保留 `find "<REPO>"`，再加一条"repo 根本身是 symlink"的固定夹具。

---

### P2

#### Q5【P2】`shell-guard-test.mjs` 有 2 条硬编码 Windows 语义的用例，导致测试在 macOS/Linux 必红
**证据**
- `scripts/shell-guard-test.mjs:216-217`：`analyseCommand("rg -n x " + BS + BS + "dir")` 期望 `false`（注释："a doubled backslash is a literal drive-root-relative path"）。POSIX 下 `\\dir` 是**仓库内的合法文件名**，实测 `ok:true` → FAIL（`/tmp/npm-test.log:138`）。
- `scripts/shell-guard-test.mjs:408-418`：`REAL_CD` 硬编码 `C:/Users/admin/AppData/Local/Temp/cc-paid-smoke-pI0twf`，却把 `repoRoot` 设为 `path.join(os.tmpdir(),"cc-paid-smoke-pI0twf")`。Windows 上两者同一路径；POSIX 上 `C:/…` 永远解析不到 → FAIL（`/tmp/npm-test.log:239`，`shell-guard-test.mjs:415`）。
- 同一数组第 2 条（`ls -R`）用 `REAL_CD.slice(0,1)` 只跑第 1 条，属于死数据（`:412`）。
**影响**：`npm test` 在 macOS（作者当前环境）3 红、在 Linux 2 红，只有 Windows 绿——与 `CONTRIBUTING.md:27` 的"跨平台行为请说明在哪个平台实测"要求直接冲突；红门禁又因为 Q3 无人发现。
**修复**：`process.platform !== "win32"` 时把双反斜杠用例改为断言 allowed（或 skip 并计入 skipped 数）；`cd+git` 回放改成用 `os.tmpdir()` 现造路径拼 `cd "<fake>" && git show HEAD`，不要写死 `C:/Users/admin`。

#### Q6【P2】`validation-test.mjs` 在 macOS 上 5/16 失败：硬编码 `C:/` 绝对路径，且不在 `npm test` 里所以没人发现
**证据**（本机实跑，`/tmp/validation.log`）
- `scripts/validation-test.mjs:110` / `:112`：`repoPath: "C:/no/such/repo/xyz"`；POSIX 上 `path.isAbsolute` 为 false → 返回 "must be an absolute path"，与期望的 "does not exist" 不符 → 2 FAIL。
- `scripts/validation-test.mjs:165`：`bogusRepo = "C:/no/such/repo/for/guard-test"`，用于 3 条 fail-closed 断言（`:167`、`:170`、`:177`）→ 3 FAIL。
- 结果：`16 checks → 5 FAILED`（其余 11 通过，含 repoPath/pr/outputLanguage/focus/空仓库/非 git 目录/guard-off 主路径）。
- 该套件确实不在 `npm test`；它有 `npm run validate` 别名（`package.json:47`），但 README/CONTRIBUTING 只教 `node scripts/validation-test.mjs`（`README.md:253`、`CONTRIBUTING.md:11`），等于没人跑。
**影响**：输入校验（`src/index.js:149-300` 的 7 个 validate 函数）本来只有这一个执行级覆盖，现在在 POSIX 上不可用，无法作为"付费调用前全部拒绝"的证据（README.md:261 的承诺）。
**修复**：无效路径改用平台无关写法（`path.join(os.tmpdir(),"no-such-repo-" + process.pid)`）；把该套件并入 CI / `npm test`（它全免费）。

#### Q7【P2】疑似"自证式"断言：测试在内部重新实现被测语义 / 从被测常量反推期望值
**证据**
- `scripts/audit-fixes-test.mjs:73-76`（`deniedByRule`）、`:93-96`（`matchesDeny`）、`:99-102`（`allowedByRule`）：测试自己用 `cmd.startsWith(rulePrefix)` 模拟 Claude Code 的权限匹配，再断言"匹配成功"。文件自己承认引擎语义无法从外部验证（`:89-91` "whether the engine honours a mid-rule \`*\` cannot be verified from out here"、`:104-107`），因此这批 ~40 条断言（`:44-57`、`:64-80`、`:103-121`、`:466-470`）**证明的是测试的模型，不是产品行为**；真正确定的控制只在 hook（同文件 `:125-126` 也这么写）。
- `scripts/shell-guard-test.mjs:249-264`：先 `bashAllowRules()`，再对 `BASH_POLICY` 里每个 prefix 拼出 `prog + words` 命令，断言 `analyseCommand()` 放行——**命令由同一张表生成**，属于同义反复；如果给 `PIPE_SINKS` 重新加回 `sed`，这条测试照样全绿。
- `scripts/audit-fixes-test.mjs:191`：`check("floor constants", [PERMISSION_MODE_MANUAL_MIN, PERMISSION_PROMPTS_MIN], ["2.1.200","2.1.259"])`——只是把常量定义抄一遍；若地板本身定错（比如真实要求 2.1.210），测试不会失败。
**影响**：这些用例给人"deny/allow 已被回归锁定"的错觉；实际权限引擎若改变匹配语义（中段 `*`、glob 大小写等），测试仍绿。项目已有 hook 兜底，所以不是安全洞，但作为"回归保护"名不副实。
**修复**：把这些标注为"策略表一致性检查"；对真正要锁的行为，用 hook 进程级断言替代（hook 是确定性层）；给 `PIPE_SINKS`/策略表加"危险条目不得存在"的负向断言（例如 `sed` 必须以 unlisted 形式被拒，见 Q11）。

#### Q8【P2】`audit-fixes-test.mjs` 的 H4 worktree 分支是"空断言通过"（假绿），与 cross-cases 的 skip 处理自相矛盾
**证据**
- `scripts/audit-fixes-test.mjs:346-362`：`try { … git init/worktree … check("H4: a live driver defined in a WORKTREE's real config is refused", repoRunsGitPrograms(wt).refusals.length, 1); } catch (e) { check("H4: worktree fixture runnable (git worktree support)", true, true); console.log("(worktree fixture skipped…)"); }`。
- 即"夹具建不起来"时打印的是 **PASS**（`check(..., true, true)`），测试总数/退出码不受影响；该用例守的是"worktree 的 .git 是文件时仍要扫真实 config"这条安全修复，恰好会在无 git / 旧 git 的机器上静默失效。
- 对照：`cross-cases.mjs:21-26` 的 `skip()` 明确 `ok:true, skipped:true`，并在汇总里单列 SKIPPED（`:782-788`），注释写"a green check that asserted nothing is worse than a visible skip"（`:253-255`）——同一作者在另一套件里做对了，这套没跟上。
**修复**：改为 `skip()` 语义（单独计数、汇总报 SKIPPED），或直接 `process.exitCode = 1`；不要用恒真 check 冒充通过。

#### Q9【P2】`npm test` 不 hermetic：smoke 依赖真实 `claude` CLI；而"无 claude 也能跑"只写在 CONTRIBUTING 里，没落到脚本
**证据**
- `scripts/smoke-test.mjs:86`：`if (/NOT FOUND/.test(text)) fail("Claude Code CLI not resolved — fix resolution before shipping");`
- `src/index.js:694-698`：无 CLI 时 `claude_review_env` 输出 "NOT FOUND — install Claude Code…" 且 `verdict: NOT_FOUND`，必然命中上述正则。
- `CONTRIBUTING.md:9` 自己承认"（需要本机装有 claude CLI）"，`:14` 给出手动替代命令；但 `npm test` 本身没有"仅前两套"的模式，CI 若想跑就必须备 claude。
- 另外 smoke 会调用 `claude_review_env`，该工具会读用户真实 `~/.claude/settings.json`（`src/claude.js:327-359`）并按配置做 loopback TCP 探测（`src/claude.js:411-432`，仅 loopback，不触外网），属于读取开发者机器状态，不是隔离测试。
**影响**：`npm test` 无法在干净容器/无 Claude 的 CI runner 上跑；而真正的 hermetic 套件（cross-cases）反而不在 test 里。
**修复**：smoke-test 增加 `--no-cli`/环境变量分支（无 CLI 时只断言 verdict/工具列表/version，不失红）；把 stub 版心跳 case 纳入 `npm test`。

#### Q10【P2】`stub-claude.mjs` 只覆盖 happy path，`runClaude` 的失败/取消/超时分支没有任何免费测试
**证据**
- stub 行为单一：`--version` 固定 2.1.300（`stub-claude.mjs:14-17`）、`--help` 声称所有 flag 都支持（`:18-31`，所以 `supportsFlag` 恒真）、headless 固定 `sleep(4000)` 后 **exit 0**（`:60`、`:208-210`）；没有任何开关模拟"非零退出 / 被 SIGKILL / 超时 / permission_denials / spawn ENOENT / 大 stderr"。
- 于是 `src/claude.js` 的这些分支只有**付费手工脚本**或 cross-cases 才碰得到，而 cross-cases 不在 `npm test`：abort-before-spawn `:1244-1249`、`:1278-1285`；spawn 失败 `:1294-1303`；timeout `:1488-1491`；abort/kill failsafe `:1493-1503`；finish() recovery `:1515-1550`；Gatekeeper SIGKILL 提示 `:1559-1581`。
- `paid-smoke.mjs`/e2e 只能人跑，没有断言这些分支。
**影响**：v1.8.3 修过的"cancel-before-listener 竞态 / TDZ 崩溃 / guard 文件泄漏"这类回归，只有真实付费运行才可能暴露；stub 建好了却没有把失败面用起来。
**修复**：给 stub 加 `STUB_EXIT_CODE`、`STUB_SIGNAL_AFTER_MS`、`STUB_STDERR`、`STUB_PERMISSION_DENIALS`、`STUB_HANG=1` 等开关，在 cross-cases/新单测里覆盖上述分支，并把该套件放进 `npm test`。

#### Q11【P2】文档与实现三处互相打脸：`sed` 已禁但提示语/README 仍说可用；测试计数过期；SECURITY.md 的"每条防线都被 npm test 锁定"不成立
**证据**
- 1.18.0 确实把 `sed` 从 sink 移除：`src/shell-guard.js:44-48` `PIPE_SINKS` 无 sed；实测 `git diff | sed -n '1,5p'` → `ok:false`。
- 但同文件 **`src/shell-guard.js:526-530` 的 ALLOWED_HINT 仍然告诉模型** "after a pipe: head, tail, cat, wc, uniq, cut, tr, grep, sort, sed -n"；实测该提示原文出现在每次 unlisted 拒绝的 reason 里。模型会照着这句改用 `sed -n`，再被拒一次（正是这个项目最在意的"白烧 turn"）。
- 模块 docstring 同样过期：`src/shell-guard.js:22-29` 仍写 "or be a pipe sink (head/tail/sed -n/…)"、"sed -i stay refused"（暗示非 -i 可用）。`sed` 的专门处理代码 `src/shell-guard.js:247-251`、`:289-292`、`:463-471` 现在是不可达/半死代码。
- README 自相矛盾：`README.md:152` 把 `sed -n` 列为允许的 sink，`README.md:158` 又说"`sed` 不在许可的 sink 之列"（EN 版 `README.en.md:154` / `:160` 同样）。
- 计数过期：`README.md:164`、`:251` 与 `README.en.md:166`、`:253` 都写 shell-guard "218 条"，实际 233（`CHANGELOG.md:18`、Lead 日志 230+3）；`CONTRIBUTING.md:20` 写"60+ 条契约"。
- 过度承诺：`SECURITY.md:30` "每条防线的契约都由 `npm test` 里的回归测试锁定"——取消/进程树、输入校验、异步 job、增量/429 四项都不在 `npm test`（见 Q2）。
**影响**：安全文档与工具返回给模型的指令互相矛盾；README/SECURITY 的"已锁定"叙述会让维护者跳过手动验证。
**修复**：改 `ALLOWED_HINT`（删 `sed -n`）、删/更新 docstring 与死代码；README 两处 sed 段落统一；跑一次 233/272 后同步计数；SECURITY.md:30 改成准确表述（"npm test 锁定 guard/deny/输入校验中的一部分；**取消/增量/429 见 cross-cases**"）。

#### Q12【P2】CHANGELOG 无任何 breaking/migration 标注，但升级会改变计费与返回形状
**证据**（`grep -ci breaking CHANGELOG.md` = **0**）
- `CHANGELOG.md:132`（1.12.0）`effort` 默认 high→max（单次 review 从 $ 级涨到约 $5.7/23 分钟，README.md:236 实测数据）。
- `CHANGELOG.md:124`（1.13.0）`maxBudgetUsd` 默认 25→0 = **默认不再设费用上限**。
- `CHANGELOG.md:230`（1.9.0）+ `:226`：`claude_review_followup` 默认改为 async，同步返回形状只在 `waitForResult=true` 时存在——接入方必须改代码。
- 这些都以 1.x minor 发布，CHANGELOG 只写成普通 bullet，没有 "Breaking changes / migration" 段，也没有在 README 顶部提示升级会变贵。
**修复**：为上述版本补 "Breaking / 行为变更" 标注（至少 1.9.0 的 followup 形状、1.12/1.13 的默认值与计费），README 升级提示里写清"默认无费用上限"。

#### Q13【P2】`engines: node>=18.19` 未被任何环境验证；本地/审计用 Node 26，仓库无 CI 矩阵，且 Node 18 已 EOL
**证据**
- `package.json:52-54` `"node": ">=18.19"`；README badge 也写 ≥18.19（`README.md:5`）。
- 静态核查：`grep` `src/` 未发现 >18.19 的 API（无 `import.meta.dirname`、`Promise.withResolvers`、`fs.glob`、`Array.fromAsync`、`using` 等）；74 个已安装依赖的 `engines` 也没有 >18.19 的（最大 @hono 1.19.9 要求 >=18.14.1）→ **声明与用到的 API 匹配**。
- 但本机 `node -v` = **v26.12.1**（`npm test` 实际就是在这个版本上跑的），无 CI 矩阵（Q3），Node 18.19 从未被这套代码执行过；Node 18 上游已于 2025-04 停止维护。
**影响**：不是立即错误，而是"声明了一个从未测试的运行时下限"；一旦 18.19 上某个 `fs`/`util` 行为不同（例如 `fs.realpathSync` 在 junction 上的行为），问题只会在用户机器上出现。
**修复**：CI 加 node 18.19/20/22 矩阵；或提升 `engines` 到仍受支持的 LTS（20+）并同步 README badge。

#### Q14【P2】`overrides: @hono/node-server 1.19.9` 只在本仓库安装时生效（npm 仅根项目应用 overrides），发布包消费者拿不到这个 pin
**证据**
- `package.json:59-61`；理由写在 `CHANGELOG.md:234`（lock 曾解析到 2.1.5，engines 要求 Node>=20，在 engine-strict 下与声明的 >=18.19 冲突；本项目只用 Stdio，不加载 hono importer）。实测 `npm ls @hono/node-server` → `1.19.9 overridden`；SDK 里 importer 只有库代码 `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js:9` 和一个 example（`examples/server/honoWebStandardStreamableHttp.js:11`），stdio 路径都不加载。
- 问题：npm 的 overrides 语义是"只在根 `package.json` 生效"，依赖包里的 `overrides` 会被忽略。因此：
  1. 本仓库 `npm i` 受保护（已实测 lock 同步）；
  2. 用户 `npm i -g cc-code-review` / `npx` 安装时，SDK 仍可解析到 2.x（engine-strict + Node18 的 EBADENGINE 场景在消费者侧依然存在；默认 npm 只是 warning，不致命）；
  3. SDK 若未来移除 1.x 支持，这个 pin 会在 `npm install` 时变成硬冲突（当前范围 `^1.19.9 || ^2.0.5` 允许 2.x）。
**影响**：一个"看起来修了、其实是开发机专属"的兼容性修复；文档把它写成通用修复（CHANGELOG:234）会误导。
**修复**：注释/CHANGELOG 标注"仅开发安装生效"；对消费者更稳的做法是提高 `engines` 到真正需要的版本，或不依赖该传递依赖（stdio-only 可用 `--omit=optional` 无法删它，但可在 README 说明 Node18 + engine-strict 需自行 pin）。

#### Q15【P2】发布包当前**没有**漏发运行时文件（已实测），但没有任何测试守着打包，且 `files: ["scripts"]` 把 190KB 测试/付费脚本塞进每个用户安装
**证据**
- 运行时必需文件：`src/claude.js:13` `HOOK_SCRIPT = path.join(SRC_DIR, "..", "scripts", "pre-tool-hook.js")`，`:999-1006 guardHookCommand()/hookScriptPath()`；`src/skill.js:31-33` 读 `../assets/skills/code-review/SKILL.md`。
- 实测 `npm pack --dry-run --json`：26 个文件，**包含** `scripts/pre-tool-hook.js`（6913 B）与 `assets/skills/code-review/SKILL.md`（8925 B）；我另外 `npm pack` 到 /tmp 并 `tar -tvzf` 复核，两个文件都在。→ **files 字段没有漏发 hook**，任务的怀疑点不成立。
- 但 `package.json:32-42` `files: ["src","scripts","assets",…]` 把 `scripts/` 整个发布：audit-fixes 53KB + cross-cases 51KB + shell-guard-test 24KB + stub 11KB + paid-smoke 9KB … 合计约 190KB 测试代码进入每个用户的 `node_modules`（解压合计 613KB，其中运行时真正需要约 280KB）。`stub-claude.mjs` 里为测试写的内容（pidfile 等）已挪到 tmp 是对的（`stub-claude.mjs:49-54`），但脚本本体照样发布。
- 打包无回归测试：`npm test` 里没有任何 `npm pack`/`files` 断言；唯一相关断言只是 `audit-fixes-test.mjs:367` 检查 `hookScriptPath()` 字符串含 `scripts/pre-tool-hook.js`（在 checkout 里恒真，与发布包无关）。若将来把 `files` 改成 `"scripts/*.js"` 或加 `.npmignore`，所有测试仍绿，用户侧 `guardState()`→"hook script missing"→两个工具全部拒跑。
**修复**：`files` 收窄为 `"scripts/pre-tool-hook.js"`（保留 assets/README/SECURITY）；在 CI 加一条 `npm pack --dry-run --json | jq` 断言 hook 与 SKILL.md 在文件清单里（几行代码即可）。

---

### P3

#### Q16【P3】测试套件自述/计数与实际不符，且 CHANGELOG 的 suite 计数没有任何可复现入口
**证据**
- `cross-cases.mjs:3` 写 "19 MECE cases"，实际 case id 有 C1–C21（`cross-cases.mjs` 内 21 个 `{ … }` 块），README 也写 21（`README.md:254`）。
- `CHANGELOG.md:18` "Suites: shell-guard 233, audit-fixes 272, validate 16, cross-cases 136/136"：其中 validate 与 cross-cases 都不在 `npm test`，也没有 `npm test:all` 之类的聚合命令；只有 `npm run validate` / `npm run test:e2e` / 手动 node（`package.json:47-50`）。所以 CHANGELOG 的数字无法用一条文档化的命令复现。
- `CONTRIBUTING.md:20` "60+ 条契约" 与 233 条不符（低报，无危害）。
**修复**：统一 21；CHANGELOG 的 suites 行注明复现命令；CONTRIBUTING 更新计数或去掉具体数字。

#### Q17【P3】测试遗留临时目录（跨运行泄漏）
**证据**
- `audit-fixes-test.mjs:843-856`：`home = mkdtempSync(...)`，块结束没有任何 `rmSync(home)`。
- `validation-test.mjs:52`（emptyRepo）、`:57`（cleanRepo）、`:102`（plainDir）创建后从不清理；`:124` 只 kill server。
- `cross-cases.mjs:28` `tmp = mkdtempSync(...)` 全文件未见清理。
- 对照：`shell-guard-test.mjs:426-427`、`audit-fixes-test.mjs:306/345/363` 都有清理。
**影响**：每次测试在 %TEMP% 留若干目录（含伪造的 .zcode/config.json、.git 仓库），长期堆积；不影响正确性。
**修复**：统一 `try/finally` 或结束时累加清理。

#### Q18【P3】若干断言过弱 / 覆盖不完整，但被文档描述为"已覆盖"
**证据**
- `audit-fixes-test.mjs:368` `check("guard state is one of on/off/failed", ["on","off","failed"].includes(guardState().state), true)`：只验枚举成员，不验当前应为 `on`（真正断言在 `:833`）。
- `audit-fixes-test.mjs:366` `/^".+" ".+"$/.test(guardHookCommand())`：只验证引号形状，不验证路径存在/在发布包内（Q15）。
- `finderFleetRule()`（`src/prompt.js:75-86`）测试只覆盖：low 全对象（`:652`）、max/high 的 `finders`（`:654-655`）。medium 完全是空的，max/high 的 `candidates/cap/angles` 未测；而 `CHANGELOG.md:18` 声称 1.18.0 修了"每级自己的 angle mix"。
- `versionAtLeast`（`src/claude.js:884-891`）测试覆盖"beta 比更老 stable 大"（`:184-185`），但**同基线的预发布**没测：`cmpVer` 的 `numPart` 丢弃后缀（`src/claude.js:244-248`），所以 `versionAtLeast("2.1.259-beta.1","2.1.259")` 返回 true——一个有 beta 后缀、可能还没带 `--permission-prompts` 的 CLI 会被判定"达标"。README.md:265 却写"版本比较（含预发布号）"。
**修复**：补 medium/angles/cap 断言；明确预发布语义（要么写测试锁定"beta 视为同版本"，要么按 semver 让 beta < stable）；把弱断言替换为具体期望（`guardState().state === "on"`）。

#### Q19【P3】3 个付费脚本没有 npm 入口、断言也只有 isError
**证据**
- `package.json:43-51`：无 `e2e-test`/`followup-e2e`/`cancel-test` 别名（只有 `test:paid`→paid-smoke、`test:e2e`→cross-cases）。
- `e2e-test.mjs:63-69`、`followup-e2e.mjs:48-54`：只判断 `res.result.isError`，报告内容仅打印不校验；`cancel-test.mjs:95` `const cancelAt = Date.now();` 从未使用（死变量）。
**修复**：加 npm 别名并在脚本里断言最小结构（session_id、报告含 Findings 段）；删死变量。

#### Q20【P3】6 个脚本各自复制了 ~30 行 stdio MCP 客户端（JSON-RPC 分帧/超时/pending map）
**证据**：`smoke-test.mjs:15-48`、`validation-test.mjs:16-38`、`cross-cases.mjs:54-93`、`e2e-test.mjs:19-41`、`followup-e2e.mjs:16-38`、`paid-smoke.mjs:101-132` 基本同构；且行为已出现分叉（`cross-cases.mjs:72` 有 `startsWith("{")}` 过滤，smoke/validation 没有；超时 30s/60s/90s/120s/15min 各不相同）。
**影响**：修一个客户端 bug 要改 6 处；这也是 Q7 那类"每套各写一套逻辑"的温床。
**修复**：抽 `scripts/lib/mcp-stdio-client.mjs`（或直接用 SDK 的 `StdioClientTransport`，依赖已在），统一超时/错误处理。

---

## 2. 覆盖矩阵：README 宣称的能力 × 测试 × 是否在默认门禁

| 能力（README/CHANGELOG 宣称） | 实现位置 | 覆盖它的测试 | 在 `npm test`？ | 在 CI？ |
|---|---|---|---|---|
| Bash 分段/路径/junction 守卫 | `src/shell-guard.js` | `shell-guard-test.mjs` 233 条（含 hook 进程级） | ✅（但 POSIX 3 红） | ❌ 无 CI |
| guard 自检（hook 真拦真放） | `src/claude.js:1058-1142` | `audit-fixes-test.mjs:373-379`（refresh 重探） | ✅ | ❌ |
| deny/allow 规则不互踩 | `src/prompt.js:390+` | `audit-fixes-test.mjs:40-181`（但引擎语义自证，见 Q7） | ✅（部分） | ❌ |
| git 仓库执行面预检 | `src/claude.js:1872-1960` | `audit-fixes-test.mjs:212-363`（真夹具） | ✅ | ❌ |
| 输入校验（付费前全拒） | `src/index.js:149-300` | `validation-test.mjs` 16 条 | ❌（5/16 在 macOS 失败） | ❌ |
| 429 抢救 | `src/claude.js:1425-1550`、`src/index.js:490-495` | 纯函数 `audit-fixes-test.mjs:692-739`；集成仅 `cross-cases` C17/C13 | ⚠️ 仅纯函数 | ❌ |
| 增量报告/JSONL | `src/claude.js:1343-1390` | 仅 `cross-cases` C16/C19 | ❌ | ❌ |
| 取消停计费/进程树 | `src/claude.js:475-494`、`:1488-1503` | `cross-cases` C8（免费）；`cancel-test.mjs`（Windows-only + 付费） | ❌ | ❌ |
| 异步 job 模型 | `src/index.js:1136-1200`、`:1449-1496` | 仅 `cross-cases` C8；smoke 只握手 | ❌ | ❌ |
| 并行 finder 结构 | `src/prompt.js:75-86`、`:137-210` | 文本断言 `audit-fixes-test.mjs:663-665`；运行时仅 `cross-cases` C11/C21 | ⚠️ 仅 prompt 文本 | ❌ |
| native/fleet 选择 | `src/index.js`、`src/prompt.js` | 仅 `cross-cases` C21 | ❌ | ❌ |
| 模型溯源 | `src/claude.js:781-801` | `audit-fixes-test.mjs:757-801` | ✅ | ❌ |
| ultracode/--settings | `src/claude.js:1162-1208` | `audit-fixes-test.mjs:675-689`；集成仅 C14 | ⚠️ 部分 | ❌ |
| 发布包含 hook/SKILL | `src/claude.js:13`、`src/skill.js:31` | **无**（本次人工验证通过） | ❌ | ❌ |

---

## 3. 对 Lead 三个失败的归因复核

| Lead 结论 | 本审计复核 |
|---|---|
| ① `shell-guard-test.mjs:28` 的 mkdtemp 路径经 macOS /var→/private/var 触发 `src/shell-guard.js:390` 真实 P1 产品 bug | **成立**。我直接 probe 复现：`find "<lexical REPO>"` 被 hook 判 outside；`find .` 正常。根因是 `shell-guard.js:388-393` 对 root 做 realpath 而对绝对 token 不做（Q4）。测试用例本身合法，不应改成迁就 bug。 |
| ② `shell-guard-test.mjs:216` 双反斜杠 FAIL 是测试可移植性 bug | **成立**。POSIX 下 `\\dir` 是仓库内合法文件名，实测 `ok:true`；断言写死了 Windows 盘符语义（Q5）。 |
| ③ `shell-guard-test.mjs:415` 的 `cd+git` 回放 FAIL 是平台不可移植 | **成立**。用例硬编码 `C:/Users/admin/…` 却用 `os.tmpdir()` 当 repoRoot（`shell-guard-test.mjs:408-418`）；除此之外该数组还有一条 `ls -R` 是死数据（`slice(0,1)`）。 |
| 补充 | 这 3 条之外，`npm test` 的 `&&`（`package.json:48`）意味着这 3 条红直接把 `audit-fixes-test`（272 条，本机实测全绿）与 smoke 全部跳过；再叠加"无 CI"，就是"红门禁长期无人发现"的完整链路（Q3）。 |

---

## 4. 直接回答任务里的 4 个必答问题

**（1）测试真实性**
- 有真东西：`shell-guard-test.mjs` 的 hook 进程级用例（`:303-392`）、junction/软链逃逸（`:363-389`）、真实 review 17 条命令回放（`:394-404`）、`audit-fixes-test.mjs` 的 `repoRunsGitPrograms` 真夹具（`:212-363`）、`cross-cases` 的反"空通过"设计（C8 等 pidfile `:348-356`、C16 校验运行中 JSONL 行数 `:574-582`）。
- 但存在 Q7 的自证式断言、Q8 的恒真 check、Q18 的弱断言；`audit-fixes-test` 相当一部分是"复述实现/常量"而非验证行为；`shell-guard-test` 对"1.18.0 的 sed 移除"和"`.GIT` 大小写绕过"都没有直接用例（Q1/Q11）。
- 只测 happy path 的现象主要在失败面：`runClaude` 的失败/超时/取消分支、429 文案、异步 job 全在默认门禁外（Q2/Q10）。

**（2）覆盖缺口（按函数名）**
默认门禁（`npm test`）完全没有执行到的关键函数/分支：
- `src/claude.js`：`runClaude()`（`:1209-1645`，含 abort-before-spawn、spawn 失败、timeout、kill failsafe、finish() recovery、synthetic result、Gatekeeper SIGKILL 提示）、`killTree()`（`:475-494`）、`parseResultJson()`（`:518`）、`buildClaudeEnv()`（`:360`）、`gatewayTarget()/probeGateway()`（`:392-432`）、`authEnvResidue()/modelEnvOverrides()`（`:442-490`）、`peekSettingsEnv()/settingsParseProblem()`（`:327-340`）、`claudeVersion()/claudeSemver()/claudeHelp()/supportsFlag()/supportsStreamJson()/supportsPermissionPrompts()`（`:851-935`，只有 smoke 间接触发且无断言）、`shellGuardStatus()`（`:1009-1013`）、`markGuardSettingsInFlight()/cleanupGuardSettings()`（`:957-995`）、`gitPreflight()`（`:1966-1984`）、`uninstallBundledSkill()`（`src/skill.js:108`）。
- `src/index.js`：全部 7 个 validate 函数（`:149-300`）、`ghPreflight()`（`:389`）、`gitStatusSnapshot()`（`:365`）、`failureBanner()`（`:473`）、`interruptedResult()`（`:438`）、`runMetaLines()`（`:303`）、`pruneReviewJobs()`（`:92`）、`writeLogFile()`（`:106`）、async job store 与 `claude_review_status` 的 cancel/poll 分支（`:1136-1200`、`:1449-1496`）。
- 以上大多有 cross-cases/validation 覆盖，但两者都不在 `npm test`、也没有 CI。

**（3）可运行性（无 claude / 无网络 / 无 GitHub token）**
- `shell-guard-test.mjs`：完全免费、无 claude、无网络（只 spawn node + hook；实测）+ 需 git（部分夹具）。
- `audit-fixes-test.mjs`：免费；但会 spawn 真实 `claude --version`/`--help`（`init.mjs` 自检路径，`init.mjs:47-76` 与 `audit-fixes-test.mjs:847-851`）——无 claude 时该子进程打印 NOT FOUND 但测试仍通过（我隔离 HOME 实测 272/272）；需要 git（worktree 夹具，失败时按 Q8 假绿）。
- `smoke-test.mjs`：**无 claude 必失败**（Q9）；无网络可跑（gateway 探测仅 loopback，`src/claude.js:411-413`）；不需要 GitHub token（`gh --version` 即可）。
- `validation-test.mjs`：免费、无网络、无 token，但 macOS 5/16 失败（Q6）。
- `cross-cases.mjs`：设计为免费（C9 需 `--paid`+`CC_LOOP_PAID=1`，`cross-cases.mjs:372`），但 C1 的 server 不注入 `CLAUDE_CODE_PATH`（`:98`），会用宿主机真实 claude；只有靠 preflight 拒绝才不产生费用——建议显式设 `CLAUDE_CODE_PATH=scripts/stub-claude.mjs` 再跑。
- `cancel-test.mjs`：Windows-only + 付费（Q2）；`e2e-test/followup-e2e/paid-smoke`：付费，需 CLI/网络。
- 结论：**无 claude、无网络时可以跑 2 个套件（shell-guard、audit-fixes）**，这正是 CONTRIBUTING.md:14 说的"没有也能跑前两个套件"；但 `npm test` 做不到。

**（4）工程质量**
- engines：静态匹配（见 Q13），但未在 18.19 上验证、Node 18 EOL。
- overrides：必要（`CHANGELOG.md:234` 有据、stdio 不加载 hono）但**只在根项目生效**，消费者侧不继承（Q14）。
- package-lock：**已同步**（`npm ci --dry-run --offline` exit 0、`npm ls --all` exit 0、根 version 1.18.0 一致）。
- files：**没有漏发运行时文件**——`npm pack` 实测含 `scripts/pre-tool-hook.js` 与 `assets/skills/code-review/SKILL.md`；问题在"无打包回归测试 + 顺带发布 190KB 测试脚本"（Q15）。

---

## 5. 值得肯定的部分（避免误伤作者的有效投入）

- `shell-guard-test.mjs` 的 hook **进程级**用例（`:303-392`）与 junction/软链逃逸（`:363-389`）是真的在打真实执行路径，不是 mock。
- `cross-cases` 的防"空通过"设计（C8 先等 pidfile 再断言 kill，`:348-356`；C16 要求运行中 JSONL 行数 === poll 可见数，`:574-582`）比大多数项目的 e2e 更诚实。
- `audit-fixes-test.mjs` 的 `repoRunsGitPrograms` 夹具（`:212-363`）覆盖了死/活 fsmonitor、include 链、worktree、注释行等真实攻击面，是真回归。
- `npm pack` / lock 同步 / 版本号（1.18.0 在 `package.json:3`、`package-lock.json:3/9`、`src/version.js:16`、`CHANGELOG.md:3` 一致）没问题；smoke 的 serverInfo 版本断言（`smoke-test.mjs:66-68`）能防版本漂移。

---

## 6. 建议的修复优先级（如果只做三件事）

1. **修 Q1**（`.GIT` hook 绕过）并补 hook 回归；同步更正 `CHANGELOG.md:10`——这是当前唯一可被实际利用的安全回归。
2. **恢复 CI + 拆掉 `&&` 串联**（Q3），同时修 Q5/Q6 的平台用例，让 `npm test` 在 macOS/Windows/Linux 全绿并把 `cross-cases`（stub）纳入。
3. **把 `cross-cases` 里 C8/C16/C17/C19 的关键断言并入 `npm test`**（Q2），并给 `stub-claude` 加失败/超时开关（Q10）——这是让"429 抢救 / 增量报告 / 取消停计费"从"文档承诺"变成"回归保护"的最低成本路径。
