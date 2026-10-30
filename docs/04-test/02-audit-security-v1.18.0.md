---
title: 首轮审计 · 安全视角
version: v1.18.0
created: 2026-10-29
status: final
---


# 安全审计：shell-guard / PreToolUse hook / init / 凭据与环境

- 审计对象：cc-code-review MCP server v1.18.0（工作目录 /Users/kent/Desktop/projects/cc-code-review_MCP）
- 范围（只读）：src/shell-guard.js(735 行)、scripts/pre-tool-hook.js(170)、scripts/init.mjs(224)、src/claude.js 凭据/guard 设置相关函数、src/prompt.js 的 allow/deny 渲染（核对两层一致性）、src/skill.js、SECURITY.md。
- 方法：静态走读 + 纯字符串分析探针（直接 import analyseCommand；用真实 payload 调 pre-tool-hook.js）+ 无害语义验证（find ... `\-exec echo`、`git diff $'--no-index' /etc/hosts /etc/shells`、`sort -o/不存在目录` 的错误探针、`new URL()` 解析）。未运行付费脚本、未联网、未执行 npm test（用 lead 的 /tmp/npm-test.log）、未改 src/ 与 scripts/。
- 结论先行：守卫框架正确，但它把"原始命令字符串"当成了"argv"。bash 在 exec 前做引号/转义/ANSI-C 展开，而 parseCommand() 只建模其中一部分；凡是"字符串 token 与 argv token 不同"的写法（`$'...'`、`$"..."`、`\-exec`、`-oFILE`），后面所有精确匹配的 deny 表全部失明，形成可执行的读/写/RCE 边界穿透。与 SECURITY.md:18/19 的承诺直接冲突。

## 级别统计

| 级别 | 数量 |
|---|---|
| P0 | 3 |
| P1 | 5 |
| P2 | 9 |
| P3 | 10 |

---

# P0

## SEC-01 [P0] ANSI-C 引号 $'...' 与 locale 引号 $"..." 未解析 → 任意命令执行 / 任意文件读写

**证据**
- src/shell-guard.js:124-197 的 parseCommand() 只处理 `'...'` 与 `"..."` 两种引号；$ 之后仅对 `$(` / `${` 置 unsafe（161、190 行），没有 `$'` / `$"` 分支。于是 `$'--output=/tmp/x'` 被当成一个以 $ 开头的普通 word，而 bash 在 exec 前把它展开成 `--output=/tmp/x`。
- 后续检查全是精确/前缀匹配：FIND_WRITE_FLAGS.has(w)（448-450）、gitWriteFlagIn()（516-524）、OUTRIGHT_DENY（278-297、425-434）、rg --pre（451-453），对带 $ 前缀的 token 一律不命中。
- git 的 pathArgs() 直接返回 []（322 行），git 参数完全不做路径校验。

**验证（实测，均无害）**
~~~text
git diff $'--output=/tmp/pwn'                    -> ALLOW（analyseCommand + 真实 hook 进程均无 deny）
git diff $'--no-index' /etc/passwd /etc/hosts     -> ALLOW
git blame $'--contents' /etc/passwd HEAD          -> ALLOW
rg $'--pre=sh' x                                  -> ALLOW
git diff $"--output=/tmp/pwn"                     -> ALLOW（locale 引号同穿透）
bash: printf '%s\n' $'--no-index' $"--no-index" -> --no-index / --no-index
bash: git diff $'--no-index' /etc/hosts /etc/shells -> 直接打印两个系统文件内容
~~~

**利用场景**
1. RCE：`find . -name x $'-exec' sh -c 'id' ;` → bash 展开为 `find . -name x -exec sh -c id ;`。`$'-exec'` 位于表达式段、不被 pathArgs 检查，FIND_WRITE_FLAGS 不命中 → 放行。实测无害版 `find . -maxdepth 0 $'\x2dexec' echo PWNED-ANSIC ;` 打出 PWNED-ANSIC。
2. 任意文件读：`git diff $'--no-index' ~/.ssh/id_rsa /dev/null` → 内容进入 reviewer 上下文 / run log / 报告。
3. 任意文件写：`git diff $'--output=/tmp/x'`；同类还有 `$'--output=.git/hooks/pre-commit'`（Bash 写不经过 Write 工具的路径域名单）。
4. 同族：`rg $'--pre=sh'`（--pre 让 rg 对每个文件执行程序）。

**修复**：在 parseCommand() 里把 $ 后紧跟 ' 或 " 直接判为 unsafe="substitution"（与 `$(` / `${` 同级），并补测试；彻底做法是解析器输出 raw 与 argv 两个视图，所有 deny/路径检查对 argv 视图执行。

## SEC-02 [P0] 反斜杠转义 token（\-exec、\--output=、\--contents）绕过所有精确 flag 黑名单 → 任意命令执行 / 任意读写

**证据**
- src/shell-guard.js:166-177：引号外遇到反斜杠时，若下一字符属于 [A-Za-z0-9._\-/@:] 则保留反斜杠（word += "\\" + next，175 行）。注释说是为 Windows 路径可识别，但当 next 是 -（属于该类）时 token 变成 `\-exec`，而 bash 的 argv 是 `-exec`（POSIX 反斜杠去掉、字符字面化）。
- 所有黑名单都是精确匹配（同上：115、448-450、516-524、278-297、425-434、451-453、460-462），带前导反斜杠的 token 全部不命中。且 `\-delete` 这类 token 不以 - 开头，pathArgs()（328-353）会把它当"位置参数/路径"，路径检查反而当 repo 内路径放行。

**验证（实测）**
~~~text
bash: find . -maxdepth 0 \-exec echo PWNED-BACKSLASH \;   -> PWNED-BACKSLASH（真实执行）
hook: find . -name x \-exec sh -c 'id' \;                  -> ALLOW
hook: git diff \--output=/tmp/pwn                            -> ALLOW
hook: git blame \--contents /etc/passwd HEAD                 -> ALLOW
hook: rg \--pre=sh x                                         -> ALLOW
bash: printf '%s\n' \-exec \--output=/tmp/x            -> -exec / --output=/tmp/x
~~~

**影响**：与 SEC-01 同级，读/写/执行三条边界同时失效；写 repo 内任意文件（`find . \-fprint src/index.js`、`git diff \--output=.git/hooks/pre-commit`）也被放行。

**修复**：不要在 token 里保留反斜杠（按 bash 语义去转义得到 argv 视图），或对每个 word 同时用 raw 与去反斜杠两种形态跑所有 deny/路径检查（取最严）；对 `\-exec` / `\-delete` / `\--output=` / `\--no-index` / `\--contents` / `\--pre=` 加回归。仅对 bash 确实会去反斜杠的字符做去转义，路径分隔符反斜杠保留，避免弄坏 Windows 路径。

## SEC-03 [P0] sort -o<FILE> 紧贴短选项值绕过 → 任意路径文件写入（可覆盖 ~/.zshrc 等）

**证据**
- pathArgs() 对未知形式的 `-xVALUE` 一律当"自包含 flag"（src/shell-guard.js:334-353，353 行 `continue; // self-contained flag`）：`-o/tmp/x` 既不是 `-o` 也不是 `--output=...`。
- segmentProblem() 的 sort 检查是精确/前缀匹配（460-462 行：`w === "-o" || w.startsWith("--output")...`），`-o/tmp/x` 不命中。
- FLAG_KINDS.sort（259-264）没有 -o 条目，短选项紧贴值不会被拆成 name/value。
- sort 作为 pipe sink 可用（PIPE_SINKS 第 48 行），`git log | sort ...` 是 review 的自然写法；engine 侧 `Bash(git log:*)` 前缀规则也会放行整条。

**验证（实测，无文件落地）**
~~~text
printf 'b\na\n' | sort -o/tmp                      -> sort: Is a directory
printf 'b\na\n' | sort -o/nonexistent-dir-xyz/out  -> sort: No such file or directory
hook: git log | sort -o/tmp/pwn   -> ALLOW
hook: git log | sort -o /tmp/pwn  -> deny（对照：带空格能拦住）
~~~

**利用**：`git log | sort -o/Users/kent/.zshrc`、`git log | sort -o/Users/kent/.ssh/authorized_keys` —— 把 git 输出（内容可被仓库文件/README 控制）写进 home 任意文件，写 .zshrc/LaunchAgents 即可持久化执行。SECURITY.md:18 明确声称 sort -o 会被拦截，实际只拦了带空格形式。

**修复**：FLAG_KINDS 解析支持短选项紧贴值（t 匹配短选项 + 剩余值，按 kind 处理，path 就查路径）；sort 另加结构性拒绝：任一参数匹配"以 - 开头且含 o 或 T 的短选项紧贴值"即拒绝；把 -o 加入 FLAG_KINDS.sort 并标为写入。同步审计其他 pipe sink 的紧贴短选项。

---

# P1

## SEC-04 [P1] 凭据值被自动写进 review 报告（无需任何注入）

**证据**
- src/index.js:652-660：当同一 key 在进程 env 与 ~/.claude/settings.json 的 env block 里值不同时，notes 用 `JSON.stringify(fromProcess)` / `JSON.stringify(fromSettings)` 打印完整值，包括 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY。
- 流向：prepareRunHardening 返回 note（index.js:671）→ guardSetupNote（920）→ warnings（1300）→ meta.warning（1310）→ runMetaLines 的 `- warning: ...`（306）→ 返回 MCP 客户端的 result text / structuredContent；async 模式进 job 结果；followup 也走 prepareRunHardening（1548-1550）。

**利用**：机器上同时存在 CC Switch 的 settings.json token 与 shell env token（常见的混合配置），只要不同，每次 review 都把两把钥匙明文放进报告；报告常被贴进聊天/issue/CI。

**修复**：只报"哪个 key 不一致"，永不打印值；如需可区分信息用 `sha256(value).slice(0,8)` 或前缀 6 位 + 长度。

## SEC-05 [P1] init.mjs 把 gateway token 打到 stdout，并落盘到非 0600 的 ZCode 配置

**证据**
- 读 token：scripts/init.mjs:120-130（gatewayTarget() 存在时把 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY 从 process.env 放进 envBlock）。
- 写入：init.mjs:202-211 的 `fs.writeFileSync(zcodeConfigPath, ...)` 没有 mode；新文件按 umask 通常 0644；目录 `mkdirSync`（209）默认 0755。路径 ~/.zcode/cli/config.json 的 mcp.servers.cc-code-review.env 即明文 token。
- 打印：init.mjs:218 把整条 entry（含 env）`say()` 到 stdout，即使"already registered, nothing to change"分支也会打印。安装输出常被复制进终端历史/CI/issue。
- 附带不一致：注释（124-126）称 gateway auth 来自 effective env（settings.json env block 或 host env），代码只用 process.env；token 只在 ~/.claude/settings.json 时 init 不会写入（功能 P3）。

**修复**：打印前 redact（敏感 key 替换为 *** 或只打 key 名）；writeFileSync 加 mode:0o600，目录 mode:0o700 并对已存在文件 chmod 收敛；确需传 token 给 ZCode 时给明确警告。

## SEC-06 [P1] writeGuardSettings() 写失败时静默 fail-open：run 无 hook 执行，报告仍声称 "PreToolUse hook"

**证据**
- src/claude.js:1162-1190：writeGuardSettings() 在 catch 里 return null（1188-1190，注释 "a broken guard must not take the review down with it"）。
- src/index.js:600-601：`const guardSettings = writeGuardSettings(...); markGuardSettingsInFlight(...)` —— 没有检查 null。
- src/claude.js:1276：`if (guardSettings) args.push("--settings", guardSettings)` → null 时不传 --settings，hook 完全没装。
- src/index.js:664-671：`hardening.shellGuard = guard.state === "on" ? "PreToolUse hook" : "off"`；guard.state 来自之前的 guardState()（只证明探测文件可写），与实际 guardSettings 无关 → 报告谎报 hook 生效，run 照常进行（付费 review 在无分段守卫下跑）。
- 触发：guardState() 探测写成功→删除；随后真正写失败（tmp 目录被清理/磁盘满/权限变化/杀软锁定/并发进程清理）。窗口小但存在，属于"控制失效 + 谎报"。

**修复**：guard.state==="on" 且 writeGuardSettings() 返回 null 时拒绝启动（与 guard.state!=="on" 同一 fail-closed 路径，除非逃生门）；或重试一次并在仍失败时把 hardening.shellGuard 设为 off 且强制走 allowUnguarded 判定。

## SEC-07 [P1] rg --files <path> 把路径当 pattern 跳过 → 读边界失效（任意目录/文件名枚举）

**证据**
- pathArgs() 的启发式："rg/grep/sed 的第一个位置参数是 pattern"（src/shell-guard.js:356-359）。rg --files 模式没有 pattern，第一个位置参数其实是搜索路径：token 被 continue 跳过，不进入 isInsideRepo。

**验证（实测）**
~~~text
hook: rg --files /etc          -> ALLOW；实际输出 /etc/notify.conf、/etc/mail.rc ...（并暴露 Permission denied 路径）
rg --files /Users/kent         -> 可枚举 home 下所有文件名
rg --files /                   -> 可枚举根目录
对照：rg --files -- /etc 被拦（-- 之后全部按路径检查）；rg -n pattern /etc 被拦
~~~

**影响**：读边界失效，可做主机文件/目录存在性与结构探测（用户名、项目名、~/.ssh 布局），为后续绕过/社工提供信息。

**修复**：识别无 pattern 模式（rg --files 等），该模式下所有位置参数都按路径检查；或 pattern 判定例外处理 --files。

## SEC-08 [P1] realpath 不对称：repo 根含符号链接前缀时，合法的绝对路径 in-repo 读取被误杀（lead 已实测，补充影响面/修法）

**证据**
- src/shell-guard.js:388-393：
~~~js
const realRoot = repoRealpath(root);          // 已 canonicalize
if (!realRoot) return false;
const target = path.resolve(realRoot, token); // token 是绝对路径时 path.resolve 直接返回 token 原样
const rel = path.relative(realRoot, target);
~~~
  macOS 上 /var/... realpath 后是 /private/var/...；传入的绝对路径仍是 /var/... → path.relative 以 .. 开头 → 判为 repo 外。root 被 canonicalize、token 没有。
- 现场证据：/tmp/npm-test.log:92-94（lead 跑的 npm test）中 shell-guard-test.mjs:146 的 `find "$REPO" -name x` 把 `mkdtemp(os.tmpdir())` 的 /var/folders/... 当 repoRoot 时被判 "resolves outside it"；同一路径的 `find <realpath>` 通过。
- 影响面：repoPath 或命令路径经过符号链接前缀的场景——macOS /tmp、/var；工作区 ~/code -> /Volumes/...；CI 的 WORKSPACE=/tmp/ws。表现为"明明在仓库内的绝对路径读取被拒绝"，白烧 turn。受影响命令：find/rg/ls/grep/sink 的路径参数（git 因 pathArgs 为空不受影响）。
- cdProblem 没有同样问题：shell-guard.js:494-513 里 `want=realpathSync(resolve(repoRoot))`、`got=realpathSync(resolve(want,target))`，两边都 realpath（复核 `cd /var/...` 与 `cd <realpath>` 均通过）。

**修复**：在 isInsideRepo() 里先 canonicalize token 的已存在前缀（复用最深存在祖先 realpath 逻辑），再 path.relative；或双向比较同时接受 raw symlink 前缀与 canonical 形式（以 canonical 为准，raw 仅用于兼容前缀，不能放过 .. 穿越）。回归测试把 shell-guard-test.mjs:146 扩成 raw 与 realpath 两种写法都必须通过（该用例在 macOS 本来就 FAIL，说明只有它覆盖到这个平台）。

---

# P2

## SEC-09 [P2] isLoopbackHost() 漏判 [::1] 与 localhost. → 本地 gateway 请求可能进 HTTP 代理（Bearer token 暴露给代理）

**证据**
- src/claude.js:341-343：`h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)`。
- gatewayTarget()（392-401）返回 `new URL(...).hostname`；WHATWG URL 对 IPv6 返回带方括号的 `"[::1]"`（实测 `new URL("http://[::1]:4000").hostname === "[::1]"`），永远不等于 `"::1"`；`http://localhost.:4000` 的 hostname 是 `"localhost."`。
- 后果 1：buildClaudeEnv() 的 NO_PROXY 补丁（379-387）不生效 → 有 HTTP(S)_PROXY 时 claude 对本地 gateway 的请求走代理（代理可见 Authorization，即 gateway token 泄漏面）。
- 后果 2：probeGateway()（411-413）直接 skipped → gateway 挂掉时不再快速失败，用户看到误导性 timeout。

**修复**：先规范化（去方括号、去尾点、小写），再 `net.isIP(h)===4` 且 127. 前缀、`h==="::1"`，纳入 0.0.0.0；单测覆盖 [::1]、localhost.、0.0.0.0。

## SEC-10 [P2] reviewer 的 git 命令没有 GIT_HARDENING_ARGS；预检扫描漏 core.sshCommand/credential.helper 与深层 .gitattributes

**证据**
- MCP 自己的 git spawn 很谨慎：GIT_HARDENING_ARGS 含 `-c core.fsmonitor= -c diff.external= -c core.sshCommand= -c credential.helper=` 等（src/claude.js:1646-1658），env 还切掉 global/system config（1679-1688）。
- 但 reviewer 的 Bash 在 claude 子进程里跑，子进程 env 只有 `buildClaudeEnv() + CLAUDE_REVIEW_REPO_ROOT`（claude.js:1295），没有 GIT_CONFIG_*/-c；reviewer 的 git status/diff/log/show/blame/remote show 会读仓库自己的 .git/config。唯一防线是运行前 repoRunsGitPrograms() 预检（index.js:1112-1128 拒绝）。
- 预检两个缺口：
  1. CONFIG_CMD_PATTERNS（claude.js:1709-1718）只覆盖 textconv/external/diffFilter/driver/command/process/filter.clean/smudge，没有 sshCommand、credential.helper、uploadpack。而 git remote show 在允许列表里（shell-guard.js:65），它会 ls-remote → 对 ssh remote 执行 core.sshCommand，对 https remote 可能调 credential helper → repo 可控命令执行。
  2. .gitattributes 只扫 root + 一级子目录（claude.js:1839-1841，repoAttributeFiles）；更深的 `sub/dir/.gitattributes` + `[diff "evil"] command=...` 不会被拒（driver 在 config 扫描里只进 driverLive 不直接拒绝，1902-1943；只有被扫到的 attributes 引用才触发 refusal，1946-1957）。

**前置条件**：仓库 .git/config 可被攻击者控制（下载的 zip/整目录拷贝/他人给的 workspace；单纯 git clone 不会带 .git/config）。reviewer 执行到 `git remote show` 或对深层文件 `git diff` 时触发。与 SECURITY.md:3 的承诺有差距。

**修复**：给 claude 子进程注入等价硬化——git 支持 `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n` 环境变量，可在 buildClaudeEnv() 里设成覆盖（reviewer 的 Bash 继承）；把 sshCommand/credential.helper/pager/editor/uploadpack 加入扫描模式；.gitattributes 递归扫描（限深度/数量）。

## SEC-11 [P2] 固定 tmp 目录 + "0700 仅在创建时生效" → guard settings（hook 注入点）可被预创建/替换

**证据**
- src/claude.js:1171-1175：`dir = os.tmpdir()/cc-code-review`；`fs.mkdirSync(dir,{recursive:true,mode:0o700})` —— recursive 时已存在目录不改权限；目录名固定；guard 文件 `guard-settings-<pid>-<rand>.json`（0600）。
- src/index.js:100-102：日志目录同一个 `os.tmpdir()/cc-code-review`。
- Linux 多用户机 os.tmpdir() 默认 /tmp（世界可写）：攻击者可预创建 /tmp/cc-code-review（属主攻击者），本 server mkdirSync 成功、写入落在攻击者目录；攻击者可在写完与 claude 启动之间替换 JSON（目录属主可 rename/unlink），注入 hooks.PreToolUse 命令 → 以用户权限执行任意命令。macOS os.tmpdir() 是 per-user（仅同用户），风险低一档；Windows %TEMP% 同理同用户。
- sweepTempArtifacts()（claude.js:970-994）只清 >2h 旧文件，防不了这个。

**修复**：用 `fs.mkdtempSync(os.tmpdir()+"/cc-code-review-")` 每进程随机目录（mkdtemp 保证 0700 且新建）；或写前 lstat 校验 isDirectory && !isSymbolicLink && uid===process.getuid() && (mode & 0o077)===0，不满足 fail closed（与 SEC-06 一起改）。

## SEC-12 [P2] activeSubagentFiles 是死代码：增量 journal 会被 retention/2h sweep 清理，违反 SECURITY.md:27

**证据**
- src/claude.js:1961-1964 注释："JSONL journals a live/finished job still references — retention must not delete these while their result can still be read." 并 `export const activeSubagentFiles = new Set()`；生成时 `activeSubagentFiles.add(subagentsFile)`（1356）。
- 全仓库没有任何读取点（grep 仅这两处）：writeLogFile() 的 retention 只按 mtime 保留最新 `LOG_KEEP=20` 个 run/subagents 文件（index.js:87、118-122），不查该 Set；sweepTempArtifacts() 删除 >2h 的 `subagents-*.jsonl`（claude.js:989-990）也不查。
- 后果：并发多个 review 或日志较多时，正在被 job 结果引用的 `partial_reports_file` 可能被删；>2h 的 job 会被其它 server 进程 sweep 掉。SECURITY.md:27 写的是 "journal 文件至少存活到对应 job 结果可读"；报告 meta 还会给出该路径（index.js:318），用户点开可能不存在。

**修复**：retention 与 sweep 跳过 activeSubagentFiles（以及正在运行的 job 的 subagentsFile）。

## SEC-13 [P2] PreToolUse hook 存在 fail-open 路径，且与模块自述"内部错误一律 deny"矛盾

**证据**
- scripts/pre-tool-hook.js:39-41：`process.stdin.on("error", () => process.exit(0))` → 输入流错误直接 exit 0（allow）。
- scripts/pre-tool-hook.js:94-99：`JSON.parse` 失败 `process.exit(0); // not our payload shape; let the normal permission path decide`。
- 模块头注释（22-25）承诺 "Unexpected internal errors deny as well — a broken guard must fail closed"，测试（shell-guard-test.mjs:390-392）却把 garbage stdin 允许写成期望。两者不一致。
- 可利用性：payload 由 Claude Code 生成、非仓库可控；只有 CLI/hook 管道异常时发生，实际风险低，但这是"守卫 fail-closed"的例外。

**修复**：JSON 解析失败 / stdin error 时输出 deny（matcher 已限定工具集，不会误伤其他工具）；或至少在报告/README 如实标注该例外。

## SEC-14 [P2] CLAUDE_REVIEW_ALLOW_UNGUARDED=1 逃生门对 "guard failed"（非用户主动关闭）也生效

**证据**
- src/index.js:550-571：`allowUnguarded` 只要 env 精确等于 "1"；guard.state !== "on" 时（off 或 failed）都放行，仅 notes 加一行警告。
- src/index.js:575-594：self-test 失败时同样只 note 警告然后继续跑。
- 风险：该变量随宿主/CI/父进程环境继承（一次设置永久生效）；当 guard 因升级/AV/权限真的坏了（state=failed），恰好是最需要 fail-closed 的场景，却因 profile 里遗留的 =1 静默无守卫运行；报告警告藏在 warnings 段落，用户很可能看不到。off（用户主动 CLAUDE_REVIEW_SHELL_GUARD=0）与 failed（意外坏）被同一逃生门覆盖，语义应区分。

**修复**：逃生门只对 guard.state==="off"（用户显式关闭）生效；failed / self-test 失败永不自动放行；放行时把警告放到报告顶部。

## SEC-15 [P2] 自审场景（repo == 本 MCP 包）下 fix 模式可写 scripts/pre-tool-hook.js / src/shell-guard.js，等于给后续所有 run 卸守卫

**证据**
- hook 的写工具守卫只做 realpath 包含性 + `.git/` 拒绝（scripts/pre-tool-hook.js:104-124，120-122）。注释（16-20）已意识到"写这个 hook 文件会卸掉后续 run 的守卫"，但只拦了绝对路径逃逸；被审仓库就是本包时 hook 文件在 repo 内，包含性检查放行。
- 实测：`CLAUDE_REVIEW_REPO_ROOT=<包根>` 驱动真实 hook，`Write scripts/pre-tool-hook.js`、`Write src/shell-guard.js` 均 ALLOW（无 deny）；`Write /tmp/pwn.txt` 与 `Write .git/config` 均 DENY（对照）。
- 前置：fix 模式且 review 对象是本包/其拷贝。影响：prompt-injected reviewer 改 hook/shell-guard 后，本次剩余或之后所有 run 的守卫被静默削弱。

**修复**：hook 里把本包自己的 scripts/pre-tool-hook.js、src/shell-guard.js、src/claude.js 按 realpath 加入 deny；或对 repo==包根的 run 禁用 fix 并提示。

## SEC-16 [P2] init.mjs 非原子写配置 + 静默覆盖用户手工 env key

**证据**
- scripts/init.mjs:199-211：`mergedEnv = { ...prevEnv, ...derivedEnv }`，derivedEnv 来自当前进程 env；用户之前手工加进 ZCode 配置的 ANTHROPIC_*_KEY/TOKEN 若命中 derived 集会被静默覆盖（注释只说 wider set 保留，derived 集内用户改动不保留也不提示）。
- `fs.writeFileSync(zcodeConfigPath, ...)` 直接覆盖整个文件，无 tmp+rename：写一半崩溃/断电留截断 JSON，ZCode 解析失败；无备份。与 SEC-05 的权限问题叠加（0600 缺失）。

**修复**：写同目录临时文件 + renameSync 原子替换；写前对 prevEnv 与 derived 的差异给出提示/要求 --force；文件 mode 0o600。

## SEC-17 [P2] reviewer 进程能读到全部 auth env（echo $ANTHROPIC_AUTH_TOKEN 被放行），token 可进入 transcript / run log

**证据**
- echo 在策略里（shell-guard.js:91）；parseCommand 只拦 `$(` / `${`，不拦裸 `$VAR`（190 行）；buildClaudeEnv() 把宿主 env 原样传给 claude 子进程（claude.js:360-361、1295），reviewer 的 Bash 继承全部 ANTHROPIC_AUTH_TOKEN/API_KEY。实测 hook 对 `echo $ANTHROPIC_AUTH_TOKEN` 放行。
- 输出随 claude stdout 写入 run-*.log（index.js:117，0600）并进入模型上下文；若模型写进最终报告则返回客户端。
- 边界：reviewer 没有网络出口（WebFetch/WebSearch 被 deny，git fetch/clone/ls-remote 被 deny），不是远程外泄通道，是本地日志/报告暴露。

**修复**：writeLogFile 对已知环境变量值做 redaction；或在 hook 中拒绝包含 ANTHROPIC_(AUTH_TOKEN|API_KEY)、CLAUDE_CODE_OAUTH_TOKEN 字样的 Bash 命令（字符串级，不影响正常 review）。

---

# P3

## SEC-18 [P3] 紧贴短选项值可读任意文件：rg -f/etc/passwd、grep -f/etc/passwd、git ls-files -X /etc/passwd、sort --random-source=/etc/passwd

- pathArgs() 对 `-f/etc/passwd` 不拆值（334-353）；rg/grep 的 -f 在 FLAG_KINDS 标为 path（223-246）但只匹配分开写形式。实测 hook ALLOW：`rg -f/etc/passwd x`、`grep -f/etc/passwd x`；`grep -f/nonexistent-xyz` 的报错证明它把 /nonexistent-xyz 当 pattern 文件读。
- git 的 pathArgs() 恒空（322），`git ls-files -X /etc/passwd` 与 `--exclude-from=/etc/passwd` 被允许（任意文件当 exclude 模式列表）。
- sort 的 `--random-source=/etc/passwd` 在 FLAG_KINDS.sort 标为 skip（259-264）；实测 `sort -R --random-source=/etc/hosts` 被接受（"random seed is too large" 报错证明读到了文件）。
- 影响：读的是模式/随机源而非内容，通常不回显明文，但违反"读取限定 repo"，可作存在性/内容 oracle。修复同 SEC-03 的紧贴值解析，并把 --random-source/--exclude-from/-X 标 path 或 deny。

## SEC-19 [P3] 只读的 git branch 形态被误杀，且拒绝文案错误

- shell-guard.js:596-606 的 `requireFlagsOnly` 只看有没有非 flag token，于是 `git branch --contains HEAD~1`、`git branch -r --contains HEAD`、`git branch --list 'fix/*'`、`git branch --no-merged main` 全部被拒（实测），它们是纯读。文案还错写成 "git branch HEAD~1 creates a branch"（把参数拼进提示），误导 reviewer。
- 影响：白烧 turn。修复：对 --contains/--no-merged/--merged/--points-at/--list 显式允许其值参数，并修文案。

## SEC-20 [P3] sed 相关代码是死代码，ALLOWED_HINT 却告诉模型 sed -n 可用

- PIPE_SINKS（shell-guard.js:44-48）不含 sed → matchPolicy 不认、pipe sink 不认 → sed 永远 unlisted（安全但过严）。
- ALLOWED_HINT（526-530）却写 "after a pipe: ... sed -n"；FLAG_KINDS.sed（247-251）、OUTRIGHT_DENY.sed（289-292）、segmentProblem 的 sed 分支（463-473）全部不可达。模型按提示写 `| sed -n '1,5p'` 会被拒（白烧 turn）。
- 修复：删提示和死代码（或补齐 sed 脚本语言检测后再纳入 sink）。

## SEC-21 [P3] 两个测试用例只在 Windows 成立，POSIX 必 FAIL（非安全洞；回答 lead 第 2 问）

- shell-guard-test.mjs:214-217（double backslash）：`rg -n x `+两个反斜杠+`dir`。Windows：path.resolve 把“两个反斜杠 + dir”按“当前盘根的根相对路径”解析（repo 外） → 期望 deny，守卫 deny，用例 Windows 通过。POSIX：bash 把两个反斜杠的 `dir` 处理成 argv 单个反斜杠+dir（或 dir），`path.resolve(root, ...)` 落在 repo 内 → 放行才是正确安全行为 → 用例 FAIL。结论：测试可移植性（P3），不是安全洞；建议 `if (process.platform === "win32")` 包裹，POSIX 改为"repo 内文件名必须允许"。
- shell-guard-test.mjs:408-418（replay cd+git）：硬编码 `C:/Users/admin/...` 与 `join(os.tmpdir(),"cc-paid-smoke-pI0twf")` 比较，POSIX 上 cd 目标不存在 → 必 FAIL，同属平台假设。
- 由此 npm test 230 passed / 3 failed：1 条真实产品 bug（SEC-08 realpath 不对称，macOS 上 find "$REPO" 被拒），2 条平台假设（本 P3）。

## SEC-22 [P3] env 工具/report 打印 gateway URL，URL 若含 userinfo/token 会泄漏

- src/index.js:736、750、757 直接输出 `t.url`（gatewayTarget 的 `new URL(...)`）；499 的失败提示带 `ANTHROPIC_BASE_URL=${t.url}`。若用户配 `http://user:token@host`（部分网关/反代文档推荐），凭据进 env 工具输出与报告。修复：打印前清 user/password，query 中的 key/token 打码。

## SEC-23 [P3] repo 内 .git/config / .env / 密钥文件对 reviewer 可读，可被 echo 进报告/日志；review 模式没有敏感文件读取策略

- pre-tool-hook.js:127-141 的 Read 守卫只做 repo 包含性；fixDisallowedTools()（prompt.js:359-369）只禁 Edit/Write/NotebookEdit 的 .env/.ssh/id_rsa 等，读取不受限。`git remote -v`（shell-guard.js:64）会把 .git/config 里可能嵌 token 的 remote URL 打出来。属仓库自身内容，不算越界读取，但与"不泄漏凭据"目标相关；建议给 Read/Bash 输出加已知密钥值 redaction 或在文档明示。

## SEC-24 [P3] analyseCommand() 对非字符串/缺字段 command 返回 ok（hook 层小口子）

- shell-guard.js:539：`if (typeof cmd !== "string" || !cmd.trim()) return { ok: true }`；pre-tool-hook.js:163 直接传 `payload?.tool_input?.command`。若某 CLI 版本用其他字段名/类型传命令，hook 放行（engine allowlist 仍在）。实测 hook 对 `command: 123`、缺 command 均 ALLOW（测试也允许，shell-guard-test.mjs:391-392）。建议 Bash payload 缺 command 字符串时 deny（与 SEC-13 一起改）。

## SEC-25 [P3] NotebookEdit 入参键很可能是 notebook_path，hook 只读 file_path/path → fix 模式所有 NotebookEdit 被拒

- pre-tool-hook.js:107、129 只取 `file_path ?? path`；NotebookEdit 的 schema（Claude Code 工具定义）用 `notebook_path`。取不到 → target="" → `realContainment(root,"")` 得 rel="" → `!rel` 判 deny（117），错误信息 target 为空。方向安全（deny 而非放行），但 fix 模式无法改 notebook。需用实际 CLI 版本确认 payload 后再定级；若确认，同时读 notebook_path。

## SEC-26 [P3] 文档承诺与实现不符（安全承诺类）

- SECURITY.md:18 声称 `find -exec`、`rg --pre`、`sort -o/-T/--compress-program` "按段直接拦截" —— 被 SEC-01/02/03 推翻。
- SECURITY.md:19 声称 `--no-index`、`blame --contents`、`--output=` "直接拒绝" —— 被 SEC-01/02 穿透。
- SECURITY.md:20 声称 "hook 未生效/自检失败/脚本缺失时两个工具都拒绝发起 review" —— 漏了 `writeGuardSettings()==null`（SEC-06）；CLI 版本过旧时 permission-mode 只是 note 警告。
- SECURITY.md:27 声称 journal "至少存活到对应 job 结果可读" —— 被 SEC-12 推翻。
- shell-guard.js:526-530 的 ALLOWED_HINT 与 PIPE_SINKS 自相矛盾（SEC-20）。
- 修复：修完 P0/P1/P2 后同步 README/SECURITY.md/ALLOWED_HINT 与测试。

## SEC-27 [P3] 死导出 gitWriteFlagReason 无人调用

- shell-guard.js:718-730 导出，index.js:31 的 import 列表里没有它；仅作为"报告路径事后分类"预留。属维护性噪音：以后有人接上时容易忘记它不做引号/转义归一（同样受 SEC-01/02 影响）。

---

# 已复核、未发现可利用问题的点（覆盖性清单）

- 重定向 `< > >> 2> &>`：parseCommand（189）一律 unsafe=redirection，含 `2>/dev/null`（测试锁定）；引号内 `>` 不当重定向（与 bash 一致）。
- 命令替换 `$( )` / 反引号 / `${...}`（含双引号内）：161、190 置 substitution 并拒绝；只有 `$'` 与 `$"` 漏网（SEC-01）。
- 后台 `&`：181-183 记 op，563-568 拒绝；`|&` 也会被 `&` 命中。
- 分段 `;` / 换行 / `&&` / `||`：逐段 matchPolicy + segmentProblem；超过 MAX_SEGMENTS=8 整条拒绝（570-572，不是"只查前 8 段"，方向正确）。
- 环境变量前缀 `FOO=bar git status`：words[0] 不匹配任何 prog → unlisted 拒绝（实测）。
- `git -c`/`-C`/`--git-dir`/`--no-pager status`：matchPolicy 要求 git 后第一个词就是子命令（199-212），前置 flag 全部被拒（安全；虽然 -C 的拒绝可能过度，review 不需要）。
- `xargs`/`tee`/`cp`/`mv`/`chmod`/`ln`/`sh`/`bash`/`node`/`sed`：不在 BASH_POLICY 也不在 PIPE_SINKS → 首命令或管道下游均 unlisted（xargs 实测拒绝；sed 连 -n 都被拒，见 SEC-20）。
- 花括号扩展 `{..,/etc}`、`~`、`$VAR`、`..` 路径：isInsideRepo（382-387、390-393）直接拒绝或 realpath 后判出界。
- 符号链接/junction 逃逸（读与写）：isInsideRepo 用"最深存在祖先 realpath"（394-410）；hook 的 realContainment 同思路（pre-tool-hook.js:66-92），测试覆盖 in-repo junction。
- `cd`：只允许首段、只允许正好落到 repo 根、两边都 realpath（cdProblem 490-514）；`cd ..`、`cd /etc`、第二段 cd、管道 cd 均拒绝（测试）。
- find/rg 的字面写/执行形态（`-delete/-exec/-execdir/-ok/-fprint/-fprintf/-fls`、`rg --pre/--pre-glob`）按精确 token 拒绝；`git --output=/--output-directory=/--output-to=/-o`、`git --no-index/--contents`、`wc/sort --files0-from` 同样；`git branch <name>/-d/-D/-m/-c/-f/--set-upstream-to` 等拒绝。
- hook fail-closed：缺 `CLAUDE_REVIEW_REPO_ROOT` 时 Bash/Write/Read 直接 deny；guard 动态 import 失败 deny；guard 抛异常 deny（pre-tool-hook.js:145-168，实测）。
- guard 设置文件本身：0600、目录 0700（新建时）；`--settings` 只传路径不含凭据；写→mark 之间无 await，并发 env 调用不会误删（claude.js:950-968）。
- `--setting-sources user` + `--permission-mode manual` + `--permission-prompts none` 组合方向正确（版本 floor 只覆盖后两者，见 SEC-26）。
- 凭据不进 argv：token 只走 env，ps 看不到（除 --settings 路径）。
- `authEnvResidue()`（claude.js:442-458）只输出变量名不输出值（对比 SEC-04 泄漏点）。
- `buildClaudeEnv()` 删 CLAUDE_CODE_ENTRYPOINT/EFFORT_LEVEL、追加而非前置 PATH、loopback 时补 NO_PROXY（补丁本身对 localhost/127.x 正确，漏判见 SEC-09）。

# 未验证 / 需实测（不作为结论）

- Claude Code CLI 是否真正执行 `--settings` 里的 hooks 与 `onFailure:"block"`：guardSelfTest 只证明"hook 脚本本身能跑并给出 deny"（claude.js:1068-1142，直接 spawn 脚本而非经 CLI），没有版本 floor 或自检证明 CLI 会加载该 settings 的 hooks。若某版本静默忽略，会 fail-open 且报告仍写 "PreToolUse hook"。建议增加"经 CLI 的 PreToolUse 探测"或用版本 floor 锁定。
- `Workflow` 工具（prompt.js:324 授予）：其内部工具调用是否经过 PreToolUse hook 取决于 CLI 实现，无法在仓库内证实；若不经 hook，是未覆盖的 Bash 旁路。建议实测后再决定 ultracode 是否要限制。
- NotebookEdit payload 字段名（SEC-25）。

# 给 lead 的三个直接回答

1. realpath 不对称（你的实测）：确认是 isInsideRepo 的 root/token 处理不对称（shell-guard.js:388-390），影响所有路径参数命令（find/rg/ls/grep/sink），git 不受影响（pathArgs 恒空）；macOS 上任何 /var、/tmp、symlink 前缀 repo 都会误杀；修法：先 canonicalize token（复用 deepest-existing-ancestor realpath）再 path.relative，或双向比较兼容 raw symlink 前缀。cdProblem 无同样问题（497-503 两边都 realpath，实测 raw/realpath 两种 cd 写法均通过）。
2. double backslash 用例：Windows 语义下会 deny（Windows 的 path.resolve 把“两个反斜杠 + dir”解析成盘根相对路径 → repo 外），该用例只对 Windows 有意义；POSIX 上两个反斜杠的 dir 是 repo 内文件名，放行是正确安全行为。结论：测试可移植性 P3，不是安全洞（SEC-21）。
3. pre-tool-hook fail-open / 逃生门 / settings / 凭据 / isLoopbackHost 的新发现：SEC-06（writeGuardSettings null → 无 hook 但报告声称有）、SEC-05（init token 打印+落盘）、SEC-04（review 报告打印 token 值）、SEC-07（rg --files）、SEC-14（逃生门对 failed 也放行）、SEC-09（[::1]/localhost. 漏判 → token 可能进代理）、SEC-11（固定 tmp 目录可预创建替换 hook settings）。
