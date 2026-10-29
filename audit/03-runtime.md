# 运行时与进程管理审计 — `src/claude.js`（v1.18.0）

- 审计对象：`src/claude.js`（1984 行，全部通读）+ 必要时对照 `src/index.js` 的调用点（仅用于判定影响，未审计 index.js 本身）
- 方法：逐行静态分析 + 在 `/tmp` 下用本文件导出的纯函数/真实函数跑离线复现（未运行任何付费脚本、未联网、未修改 `src/` 与 `scripts/`）
- 环境：macOS（`os.tmpdir()=/var/folders/...`，`/tmp -> /private/tmp`），node v26.12.1，git 2.x
- 复现脚本位于 `/tmp/cc-audit-*`（可重跑），下文「复现」段落的输出均为实测

## 结论总览

| 级别 | 数量 | 编号 |
|---|---|---|
| P0 | 3 | R-1（仓库文件的同步阻塞读 → 可克隆触发的服务器冻结/任意读）、R-2（子目录 `.gitattributes` 绕过拒绝 → RCE）、R-3（同行 section header 绕过拒绝 → RCE） |
| P1 | 2 | R-4（guard 写入失败被当成「guard 关闭」，静默无钩子运行）、R-5（completed run 被判超时 + 20s 卡死 + 子进程残留） |
| P2 | 5 | R-6 ~ R-10 |
| P3 | 11 | R-11 ~ R-21 |

一句话：**进程/流式解析的常规路径写得比平均水准高（超时/取消实测真能杀干净、stream 截断不影响结果事件、guard 文件生命周期正确）；洞集中在「把仓库当攻击者」的两处边界——git 配置/属性扫描器（用同步、无上限、跟随符号链接的读 + 用正则模拟 git 语义），以及 guard 安装失败时的 fail-open。**

---

## P0

### R-1 仓库里的同步无上限读：提交一个 `.gitattributes` 符号链接即可冻结整个 MCP server（可远程触发）

- 位置：`src/claude.js:1836-1851`（`repoAttributeFiles` 用 `fs.readFileSync(file, "utf8")` 读根 `.gitattributes` / `.git/info/attributes` / 一级子目录 `.gitattributes`，只包了 try/catch）；`src/claude.js:1786-1833`（`repoConfigFiles` 同样 `readFileSync`，且会跟随任意 `[include] path`）；调用点 `src/index.js:1116`（review 预检，**同步**、在 spawn、超时、guard 之前）；`src/index.js:1591`（followup 预检）
- 触发：git 会把符号链接当作可提交对象，`git clone` 会在工作区重建它。恶意仓库提交 `.gitattributes -> /dev/stdin`（或 `/dev/zero`、任意绝对路径）。用户对该仓库调用 `claude_code_review`（或 followup）时，预检同步执行 `repoRunsGitPrograms()` → `readFileSync` 跟随链接读 **本进程 fd 0**（MCP stdio 传输的 JSON-RPC 管道），read 永远等不到 EOF。
- 后果：
  1. 单线程事件循环被永久阻塞：该 tool call 永不返回，其他所有工具（status/env）也不再响应，没有任何超时能救（阻塞点在 timeout 机制之外）；客户端只能杀掉 server。
  2. 若指向 `/dev/zero`：无 EOF 字符设备 → 无上限分配（OOM/长时间卡死）。
  3. 若指向任意可读文件：整份内容被读进内存；行内容命中 `CONFIG_CMD_PATTERNS` 时会被拼进 refusal 文本返回给调用方（`claude.js:1896-1900`），即"符号链接指向哪个文件，就允许读哪个文件"。
- 复现（实测）：
  ```
  # 攻击者仓库: git init; ln -s /dev/stdin .gitattributes; git add -A; git commit; git clone ...
  cloned .gitattributes isSymlink = true -> /dev/stdin
  RESULT: repoRunsGitPrograms(clonedRepo) HUNG >3s => MCP server frozen; killed
  # 对照（同一仓库，探针进程 stdin=/dev/null）: verdict: {"refusals":[],"notes":[]} 正常返回
  # 同样原理，.git/config 的 [include] path = /dev/stdin 也 HANG
  ```
  注意：`git clone` 自带的 `git add` 过程会打印 `unable to access '.gitattributes': Too many levels of symbolic links` 警告，但**仍然提交符号链接 blob 并在 clone 后重建**，不影响攻击。
- 修复：读任何仓库内文件前先 `fs.lstatSync`，只接受 `isFile()`（FIFO/设备/符号链接一律拒绝，或 `openSync(O_NOFOLLOW)`）；`realpathSync` 后校验仍在 repoPath 之内；给 `readFileSync` 加硬上限（如 `st.size > 4MB` 直接 skip/refuse）并把这种拒绝计入 refusal 而不是静默跳过。`repoConfigFiles` 的 `[include]` 目标同样处理（当前它甚至会读 repo 之外的路径）。

### R-2 深度 ≥2 的 `.gitattributes` 完全不扫描 → 仓库内定义的 live diff/filter 驱动不被拒绝，`git diff` 直接执行它（RCE）

- 位置：`src/claude.js:1836-1851`（`repoAttributeFiles` 只收 root、`.git/info/attributes`、**一级**子目录，函数头注释 `1835` 自己承认 "one directory deep"）；`src/claude.js:1904-1943`（`[diff "x"]`/`[filter "x"]` section 内的命令行只登记进 `driverLive`，**不 refusal**）；`src/claude.js:1946-1957`（refusal 只在"被扫描到的 attributes 引用了 live driver"时产生）
- 触发：仓库自带 `.git/config`（zip/整目录拷贝，作者在 `1729-1735` 明确把这种场景纳入威胁模型）含 `[diff "evil"]` + `textconv = sh -c '...'`，而引用它的 attributes 放在 `src/deep/.gitattributes`（monorepo 里非常常见的深度）。
- 后果：预检返回 `refusals: []` → review 继续 → 允许清单内的 `git diff` / `git show` / `git log -p`（reviewer 必然执行）触发 textconv → 以服务进程用户身份执行任意命令。`GIT_HARDENING_ARGS`（`1646-1658`）无法用 `-c` 关闭"按驱动名配置的 textconv"（只有 `diff.external` 是全局键），所以这条扫描是唯一防线——它被绕过了。
- 复现（实测，`repoRunsGitPrograms` + 真实 `git`）：
  ```
  A 根 .gitattributes       -> {"refusals":["... driver \"evil\" is defined in the repo's git config"]}   # 被拒绝(正确)
  B src/deep/.gitattributes -> {"refusals":[],"notes":[]}                                                # 扫描器看不见
  B 之后 git diff 执行了 textconv: PWNED-A 文件被创建 = true
  C 对照：根 attributes 被拒绝，但裸 git diff 同样执行（证明 refusal 是唯一阻拦）
  ```
- 评级说明：`git clone` 不携带 `.git/config`，所以这条路要求"评审来源是带 `.git/` 的目录/压缩包"。若接受这一投递方式（`deadPathOnThisMachine` 的注释说明作者接受），按 P0 处理；只认 clone 的话降为 P1。
- 修复：递归扫描整棵工作树的 `.gitattributes`（或改成 `git check-attr -a --stdin` 让 git 自己解析，且用 `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` 控制住配置来源）；要么把 `[diff|filter]` section 里的命令行直接 refusal（当前"只有被 attributes 引用才拒绝"的策略给了太多藏身余地）。

### R-3 同行 section header（合法 git config）让驱动"不存在"：`[diff "evil"] textconv = cmd` 一行写 → 拒绝逻辑两条腿同时失效

- 位置：`src/claude.js:1879-1888`（`sectionsOf` 的 header 正则要求 header 独占一行）；`src/claude.js:1906` + `1932-1936`（该行被算到**上一个** section；若上一个 section 也是 `[diff|filter "x"]`，命令行被静默记成那个驱动的，然后 `continue`）；`src/claude.js:1941-1943`（注册 `driverLive` 的第二次 `matchAll` 同样要求 header 独占一行）→ attributes 交叉检查时 `driverLive.has("evil")===false`，既不 refusal 也不 note
- 触发：`.git/config` 里先放一个无害的 `[diff "benign"]` section，再写 `[diff "evil"] textconv = sh -c '...'`（git 的 config 语法允许 key 跟在 section header 同一行；实测 `git config --get diff.evil.textconv` 能读出来）。
- 复现（实测）：
  ```
  B git parses diff.evil.textconv as: "sh -c 'date > .../PWNED-B'"
  B scan verdict: {"refusals":[],"notes":[]}
  B PWNED created: true            # git diff 真的执行了
  C 对照(正常 section)：refusal 正确产生
  ```
- 后果：同 R-2（任意命令执行），且不需要躲到子目录。
- 修复：不要用行扫描模拟 config 语法；用 `git config --file <cfg> --list -z`（带 `--includes`）拿规范化后的 key/value，或在正则里支持"header 后跟首个变量"的形态。

---

## P1

### R-4 `writeGuardSettings()` 把「guard 被关闭」和「写文件失败」都返回 `null`，调用方不检查 → 静默 fail-open，报告仍宣称钩子已装

- 位置：`src/claude.js:1162-1191`：`1169` 当 guard 关闭且无 extra 时 `return null`（合法），`1188-1189` `catch { return null; }`（**安装失败**也返回 null）；函数文档 `1160` 只写了 "Returns the settings path, or null when the guard is switched off."；调用点 `src/index.js:600-601` 直接拿返回值往下传，没有判空；`src/index.js:664-669` 在结果里写 `shellGuard: guard.state === "on" ? "PreToolUse hook" : "off"`，而 `guard.state` 只证明"临时目录可写"（`1022-1037`，probe 写成功后立即删除），不证明这次 run 的 settings 写成功。
- 触发：`guardState()` 探针写成功之后、`prepareRunHardening` 正式写文件时失败一次即可（ENOSPC、EMFILE、/tmp 被清理竞态、AV 锁文件……）；或两次写之间 `/tmp/cc-code-review` 被外部清理后 `mkdirSync` 失败。
- 后果：整条 review 在**没有任何 PreToolUse 钩子**的情况下跑完（`runClaude` 的 `--settings` 参数不会出现，`1276`），但 `prepareRunHardening` 已经通过了"refuse to run unguarded"的闸门，报告 hardening 段仍写 "PreToolUse hook"，返回文本也声称 shell chaining 被阻断。这正是模块注释反复强调要避免的"看起来有保护"。
- 修复：区分三种返回：`{file}` / `{disabled:true}` / `{error}`；调用方对 `{error}` 必须走与 `guard.state!=="on"` 相同的拒绝路径（或至少 `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` 才继续）；`hardening.shellGuard` 用"本次 run 实际传入的 --settings 路径"而非 guardState 的结论。
- 备注：同一 `null` 语义还会让 `markGuardSettingsInFlight(null,true)` 静默 no-op，掩盖问题。

### R-5 只监听 `close` + `killTree` 的 `alive` 门槛：完成的 run 被判「超时」、卡 20s、并留下活着的后代进程（已实测）

- 位置：`src/claude.js:1622`（只监听 `close`，没有 `exit`）；`1501-1504`（failsafe 在 `timeoutMs+20s` 强行 `finish(-1,"SIGKILL")`）；`1488-1491`（timer 无条件 `timedOut = true`，即使子进程早已正常退出）；`475-494`（`alive === exitCode==null && signalCode==null`，为 false 时**跳过** `process.kill(-pid)` 组杀）；`1582-1584`（`ok = !timedOut && code===0 && json`）
- 触发：claude 正常退出（exit 0、已输出完整 result），但它的某个后代进程继承了 stdout/stderr 且活得比它久（Bash 工具里的后台进程、daemonize 的 helper、任何 `&`/`setsid` 出来的进程）。Node 的 `close` 事件要等 stdio 流关闭 → 永不触发；timer 到点后 `killTree` 因为 `exitCode` 已设置而**不杀进程组**；只有 failsafe 能把 Promise 解开。
- 实测（timeoutMs=2000，fake claude 打印合法 result 后退出并留一个 detached 且 `stdio: inherit` 的后代）：
  ```
  elapsedMs: 22006
  ok: false | timedOut: true | exitCode: -1 | json present: true | json.result: COMPLETED-OK
  grandchild alive after resolve: true
  ```
- 后果：`src/index.js:1200` 命中 `run.timedOut` → 返回 interruptedResult（"review timed out"），**已完成的父进程综合报告被丢弃**（只保留 subagent 报告）；同时后代进程永不被清理（持续持有管道/可能的账单），且这次"超时"没有 SIGTERM→SIGKILL 升级可言——`killTree` 只发 SIGKILL（`490-492`），没有给 CLI flush 的机会。
- 修复：同时监听 `exit`，记录"子进程已退出"；timer 里若已退出则只落 `finish(exitCode)` 不置 `timedOut`；在 `exit` 事件里立刻对组 `kill(-pid)`（此时 pid 尚未复用，比 `close` 早得多），而不是在 `close` 之后按 `alive` 判断；`finish` 里对 stdout/stderr 做 `destroy()` 以强制 `close`。至少要修"已完成却报超时"这一半。
---

## P2

### R-6 `recoverReportFromTranscript` 不校验 role/type：把用户的提示词当成 subagent 的"部分报告"

- 位置：`src/claude.js:731-743`：对最后 256KB 里每一行只做 `JSON.parse` → `ev?.message?.content` → 收集所有 `{type:"text"}`；没有 `ev.type==="assistant"` / `message.role==="assistant"` 过滤，也不跳过 `isMeta` / `isSidechain` / system-reminder。
- 复现（实测）：
  ```
  transcript 只有一行 {"type":"user","message":{"role":"user","content":[{"type":"text","text":"PROMPT: You are reviewer #3..."}]}}
  recoverReportFromTranscript => {"report":"PROMPT: You are reviewer #3. Review the diff and output findings.","partial":true,...}
  ```
- 后果：一个在写出任何分析前就被 429/预算/超时杀掉的 reviewer，会以"partial report = 它自己的提示词（或 system-reminder）"的形式进入最终报告的 subagent 列表（`finish` 里 `1519-1549` 和 `1432-1437` 两处都会用），把"付费抢救回来的工作"变成噪声/误导。
- 修复：只接受 assistant 且非 sidechain 的 text block，且可选要求 `ev.timestamp` 在 run 期间。注意该函数在 `720-723` 已有路径白名单，缺的是消息类型白名单。

### R-7 `isAllowedTranscriptPath` 只做字符串比较：不 realpath、不解析符号链接、且"含 claude 前缀的任一段"就算合法

- 位置：`src/claude.js:671-683`
- 复现（实测）：
  ```
  /var/folders/.../T/claude-x/tasks/a.output         => true   (预期)
  /var/folders/.../T/attacker/tasks/claude.output    => true   ("claude" 出现在文件名里也算)
  /private/var/folders/.../T/claude-x/tasks/a.output => false  (macOS os.tmpdir()=/var/...，realpath 后的 /private/var 形式被拒)
  $TMPDIR/claude-x/tasks/link.output -> /etc/hosts   => 通过校验并真的读了 /etc/hosts
  ```
- 后果：(a) 若 CLI 报的是 realpath 之后的 transcript 路径（macOS `/var`→`/private/var` 是系统级符号链接），所有 `output_file` 恢复会**静默失效**，无任何告警；(b) 校验不看 `lstat`，同机其他进程可以用符号链接把读操作引到任意可读文件；(c) 边界比设计意图宽（设计意图见测试 `scripts/audit-fixes-test.mjs:726`：`$TMPDIR/elsewhere/tasks/x.output` 应被拒）。
- 修复：两侧 `realpathSync` 统一后再 `path.relative`；只允许 `rel` 的第一段匹配 `/^claude/i`；`lstat().isFile()` 拒绝符号链接；失败时在 run 结果里记一条 "transcript recovery disabled" 而不是静默。

### R-8 npm root 探测失败被永久 memo，`refresh` 也救不回来（与注释承诺相反）

- 位置：`src/claude.js:192-223`（`npmRootCache` 连**失败**一起 memo：`219 npmRootCache = null`；`200` 命中 null 直接返回）；`src/claude.js:44-58`（`refresh` 只绕过 `cachedCli`，不会清 `npmRootCache`，也没有重新探测 npm root 的路径）；注释 `55-56` 承诺 "a later install/upgrade should be picked up without a restart"；`src/claude.js:237-242` 的 `resolveClaudeCliSettled` 专为"只能通过自定义 npm prefix 找到 CLI"的场景而写（注释 `230-236`）
- 后果：恰好是 settled 机制要救的那类机器（GUI 启动、PATH 稀疏、CLI 只在自定义 npm prefix 下），只要启动时那次 `npm root -g` 超时/失败一次（`211` 的 10s timeout，冷 npm cache 很常见），**本进程生命周期内永远 NOT_FOUND**，`refresh` 和重试都无效，只能重启 MCP host；而此时磁盘上 claude 已装好，用户的直观感受是"服务坏了"。
- 修复：失败结果带 TTL（如 60s）而不是永久 null；`refresh:true` 时清空 `npmRootCache`/`npmRootInflight`；另外 `resolveClaudeCli({refresh:true})` 目前**全仓库没有任何调用点**（grep 仅定义，index.js 四个调用点都是无参），这个逃生舱口是死的。

### R-9 version/help 缓存无 TTL，原地升级后整个进程继续用旧版本判据（对照：guardSelfTest 特意加了 TTL）

- 位置：`src/claude.js:845-848`（`versionCache/helpCache` 以 `cli.path` 为 key）；`851-865`（成功才写缓存，永不过期）；`894-907`（help 同理）；`916-924`（`supportsFlag` 任何异常都返回 false 且不缓存失败——看起来安全，但**成功**的 help 永远有效）；对照 `1049-1065` 的注释明确写了 "long-lived MCP server outlives install"，并为 guard 自检加了 5 分钟 TTL
- 后果：`claude` 原地升级（npm 同 prefix 重装、homebrew 升级）后，本进程的 `claudeSemver` 仍是旧版本：`index.js:616-622` 的版本地板可能一直判 "TOO OLD"，于是 `--permission-mode manual` 永远不传（硬化降级但报告只写一句 note），或新支持的 flag 永不启用。与 `resolveClaudeCli` 对二进制消失的失效处理（`35-41`）相比，这是同一类漂移的另一半没做。
- 修复：version/help 缓存加 TTL（与 SELF_TEST_TTL 一致）或把 `--version` 结果与文件 mtime 绑定（`statSync(cli.path).mtimeMs` 变化即失效）。

### R-10 git 驱动扫描的两个稳定误报：仓库内置 git-lfs 配置、`merge.<x>.driver = true`

- 位置：`src/claude.js:1904-1943`（`[filter "lfs"] clean/smudge/process` 被识别为 live driver）+ `1946-1957`（committed `.gitattributes` 引用 `filter=lfs` → refusal）；`src/claude.js:1713`（`/\bdriver\s*=/i`）
- 复现（实测）：
  ```
  [filter "lfs"] clean = git-lfs clean -- %f ... + *.psd filter=lfs diff=lfs
    => {"refusals":["... driver \"lfs\" is defined in the repo's git config", "...(同一行重复一次)"]}
  [merge "ours"] driver = true
    => {"refusals":[".git/config: driver = true"]}
  ```
- 后果：`git lfs install --local`（CI/系统级安装很常见）过的仓库、或整目录拷贝来的 LFS 仓库，会被整条拒绝，提示 "its own git configuration executes programs"；`merge.ours.driver = true` 是广泛使用的无害惯用法，也会被拒。fail-closed 可以接受，但这是"合法仓库无法评审"的用户可感知失败，且错误信息把用户引向"删掉 .git/config 里的 LFS 配置"。
- 建议：对 `filter.lfs.*` 的已知值（`git-lfs clean/smudge/filter-process`）判定为安全白名单；对 `driver = true`/`driver = false` 这类 trivial 命令按 fsmonitor 的布尔豁免同样处理。顺带：LFS 那行输出重复了两次（`matchAll` 对同一行的 `filter=` 和 `diff=` 各产生一条），去重。

---

## P3

| 编号 | 位置 | 问题 |
|---|---|---|
| R-11 | `claude.js:1336`, `1405` | `const agentResults = new Map()` 只写不读（全文无读取点）：整个 run 期间把**每一条** tool_result 文本（git diff 等，可达数 MB）钉在内存里，纯浪费。删掉即可。 |
| R-12 | `claude.js:76-86`, `177-178` | `hasShebang` 是死代码（全仓库仅定义、无调用）。且实现有 bug：`openSync` 成功后若 `readSync` 抛错，`closeSync` 不会执行 → fd 泄漏。要么删，要么用于 `classifySpawnTarget` 做真实判定（现在 `177-178` 的注释还说 "bare shebang would fail as EACCES later"，与实际实现不符）。 |
| R-13 | `claude.js:650-663` | 同一段注释块**逐字重复**两遍（"An async Agent dispatch's tool_result is only a launch acknowledgement…"）。`1632-1645` 与 `1692-1708` 也各有一份高度重叠的 git 扫描设计说明，易随时间漂移。 |
| R-14 | `claude.js:637-648` | `parseUnrecognizedModels` 用 `(\{.*?\})` 非贪婪截取，遇到嵌套 JSON（`{"model":"x","meta":{"a":1}}`）会在第一个 `}` 处截断 → `JSON.parse` 失败 → 整条模型替换证据被静默丢弃。当前真实日志行是扁平的，属隐患。 |
| R-15 | `claude.js:518-529`, `1259-1260`, `1550-1552`, `1577` | `parseResultJson` 只能在**单行**里找到 result：实测 pretty-printed 的 result 返回 null；且 stdout 被 8MB 截断时最后一行必被切断（`1552` 只在 stderr 里加一句提示）。非 stream-json 路径（老 CLI）会因此把一次成功 run 报成 "exited without a parseable result JSON"。建议对截断场景打独立错误码/提示。 |
| R-16 | `claude.js:977-983` | `sweepTempArtifacts` 在 `readdirSync` **之前**就把 `sweptTempArtifacts = true`；一次瞬时 EACCES 就永久禁用本进程的清理。应先成功再置位。 |
| R-17 | `claude.js:49` vs `56` | `!cachedCli.error` 是死条件：错误分支从不写入 `cachedCli`（`56` 只缓存成功），所以缓存里永远没有 `.error` 条目。要么缓存错误（带 TTL），要么删条件。 |
| R-18 | `claude.js:1962-1964` + `1356`，对照 `index.js:120-122` | `activeSubagentFiles` 的注释说 "retention must not delete these while their result can still be read"，但它**从未被 index.js 或任何脚本 import**（grep 全仓库仅本文件两处）。实际保留策略是 `writeLogFile` 里按 mtime 保留最新 20 个 `run-*`/`subagents-*.jsonl`——一个 60 分钟长任务期间只要有 ≥10 次其它 run 收尾，它的 JSONL 就会在客户端仍引用 `subagentsFile` 时被删（后续 append 会重建新文件，记录被切成两段）。要么接线，要么删注释。 |
| R-19 | `claude.js:692-696`, `1447` | `looksLikeLaunchAck` 只看"文本是否以 ack 首行开头 + 含 agentId/working in the background"。实测 `"Async agent launched successfully? No — the real finding is:\nagentId: x"` → true：一份以该短语开头的同步 subagent 报告会被当 ack 丢掉（只有 strict ack 才有 `output_file` 可恢复，loose 形态直接丢）。仓库内容可 prompt-inject 出这种开头。 |
| R-20 | `claude.js:481-486`, `490-492` | Windows 只有 kill 当刻的 `taskkill /T /F`，没有 Job Object/进程组等价物：后代若重新 parent（中间 cmd.exe 退出）即逃逸；fallback `child.kill("SIGKILL")` 只杀直接子进程。POSIX 侧只发 SIGKILL、无 SIGTERM 阶段（CLI 没有 flush transcript 的机会，只能靠已落盘的 JSONL 补救）。README 已声明 Windows 残留风险，但 R-5 说明这两条组合会有实际后果。 |
| R-21 | `claude.js:498-504` | SIGTERM/SIGINT/SIGHUP 处理器杀完子进程后 `process.exit(0)`：异常终止以 0 退出，MCP host 无法区分"正常关闭"和"被信号中断"；且 `exit` 处理器会再用 `alive` 逻辑重复 kill 一次（`505-515`）。建议用 128+sig 退出码。 |

---

## 已核实为正确/稳固的部分（避免只报坏消息时误伤）

1. **常规超时/取消真的能杀干净**：实测 `timeoutMs=800` → 803ms 返回 `timedOut=true`，pid 已消失；`abort()` → 503ms 返回 `cancelled=true`，pid 已消失（`detached:!IS_WIN` + `kill(-pid)` 正常路径工作）。
2. **`MAX_STREAM_BYTES` 不会吞掉 result 事件**：`ingest` 在**实时 chunk** 上跑（`1467-1478`），8MB 上限只影响留存 stdout（日志/回退解析），stream-json 的 result 事件即使在超大输出下也能拿到；`soPartial` 4MB 上限还顺手消掉了 O(n²) concat。
3. **guard settings 文件生命周期正确**：正常 run 结束删除、spawn 前已取消删除、probe 文件即时删除（`1032`/`556`/`577`）；文件 `0600` 在 `0700` 目录（实测 mode 600）。`sweepTempArtifacts` 的 2h 门槛相对 `timeoutMinutes` 上限 60min 是安全的。
4. **`guardSelfTest` 的三探针设计**（direct / clean / shell-rendered）与 TTL 缓存是这轮审计里设计质量最高的部分：它确实覆盖了"钩子路径失效"和"引号渲染回归"两类真实故障。
5. **CLI 解析的细节处理**：零字节 Windows app-execution alias 拒绝（`64-68`）、跳过 `WindowsApps` 目录、不用 `where` 以避开 CJK 代码页、desktop-app 兜底、npm-root 异步预取（`192-228`）都合理；`gitSpawnOpts` 的 `HOME`/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` 重定向 + `maxBuffer 64MB` 处理得当。
6. **`repoConfigFiles` 的 worktree/submodule 处理**（`.git` 是文件时解析 `gitdir:`、`config.worktree`、`commondir`）超出一般水准。
7. `recoverReportFromTranscript` 的 fd 在 `finally` 关闭、路径白名单硬门（`723`）都在。

## 无法离线确认、需真机验证的假设

1. 真机上 claude 是否会产生"继承 stdout/stderr 且比 claude 活得久"的后代（决定 R-5 的触发频率）；Windows 上同等场景是否必现。
2. 真 CLI 的 `output_file` 是否为 realpath 形式（决定 R-7 是否已经在 macOS 上静默失效）。
3. `runClaude:1263` 把 `allowedTools` 用空格 `join(" ")` 后作为**单个 argv** 传给 `--allowedTools`（其中元素含空格，如 `Bash(git log:*)`）。这依赖 CLI 内部再切分；若它按变参处理，allowlist 会变成一条非法 tool 名 → manual 模式下全部工具被拒。属 unverified assumption，建议加一条启动自检或改为逐项传参。
4. `--output-format json` 是否 pretty-print（决定 R-15 的现实性）。

---

### 建议修复顺序

1. R-1（同步无上限读 + 符号链接）——一行 `lstat` 校验就能堵住远程 DoS，性价比最高。
2. R-2 / R-3（git 扫描器）——把"扫文本"换成 "`git config --list -z` + `git check-attr`"，或用更保守策略：`[diff|filter]` 段内出现命令值即拒绝。
3. R-4（guard 写失败 fail-open）——改返回契约，一行判断。
4. R-5（close→exit + 组杀时机）——修"已完成却报超时"。
5. R-6 / R-7（报告完整性与路径校验）——小改动、直接提升报告可信度。
