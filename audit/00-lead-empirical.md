# Lead 实证发现（黑盒/动态验证）

> 这些是 Lead 亲自运行代码验证的结论，与五位专家的静态审计互为交叉验证。

## L1 [P1] realpath 只解析一侧，符号链接前缀下的合法读取被误杀
- **代码**: `src/shell-guard.js:390` `const target = path.resolve(realRoot, token);`
  `realRoot` 已 realpath（`repoRealpath` 366-373），但 `token` 为绝对路径时原样保留；`path.relative` 于是得到 `../../../../var/...`。
- **实测**（macOS）:
  ```
  REPO=/var/folders/.../T/probe-guard-HsSVyY   (realpath=/private/var/...)
  find "<REPO>" -name x        => DENIED  "resolves outside it"
  find "<realpath>" -name x    => allowed
  ls/rg "<REPO>"               => DENIED
  ```
- **文档矛盾**: `README.md:172` 明确声称"边界判定走 realpath（**两侧都解析真实路径**）"——代码只解析 root，声明与实现不符。
- **影响**: repoPath 含符号链接前缀（macOS `/tmp`、`/var`、`~/code -> /Volumes/...`）时，Claude 用绝对路径读取仓库内文件会被拒，白烧 review turn；同时"两侧都解析"这条安全承诺实际未兑现。
- **回归测试**: `scripts/shell-guard-test.mjs` 中 "allow in-repo read: find <tmpdir> -name x" 正是锁定此行为的用例，**当前 FAIL**。
- **建议修法**: token 为绝对路径时先 `fs.realpathSync`（对不存在路径用最近已存在祖先），再与 realRoot 比较；或对 lexically-inside 与 realpath-inside 取"任一为真即放行 + 最终 realpath 必须仍在 root 内"。

## L2 [P2] `npm test` 当前是红的：230 passed / 3 failed
- 实测三个套件：shell-guard-test **230 passed / 3 failed**；audit-fixes-test 272/0；smoke-test PASS。
- `CHANGELOG.md:15` 声称 "Suites: shell-guard **233** (+15 ...)"，读起来是全绿；实际 233 个用例里有 3 个失败。
- 项目根目录**没有 `.github/`**，即无 CI——红色测试无人拦截，可直接发版。
- `README.md:164` / `README.md:251` 仍写 "218 条"（1.17.0 的数字），与 changelog 的 233、实际的 233 都不一致。

## L3 [P2] 两个用例平台不可移植（失败 2/3）
1. `scripts/shell-guard-test.mjs:216` "double backslash is a literal root-relative path (outside)"：POSIX 上 `\dir` 是仓库内合法文件名，放行**正确**；用例只在 Windows UNC/驱动器相对语义下成立。属测试可移植性问题，不是安全洞（需在 Windows 分支上确认 deny 行为仍然成立）。
2. `scripts/shell-guard-test.mjs:415` "replay: the cd+git chain from a real run is allowed"：用例硬编码 Windows 路径 `C:/Users/admin/AppData/Local/Temp/...`，却用 `os.tmpdir()`（macOS）当 repoRoot，平台不匹配必失败。

## L4 [P2] 未处理 `unhandledRejection` / `uncaughtException`
- `src/index.js` 与 `src/claude.js` 中 `process.on` 仅覆盖 `SIGTERM/SIGINT/SIGHUP/exit`（`src/claude.js:498-505`），没有 `unhandledRejection`。
- Node 18+ 默认 unhandled rejection **直接终止进程**：MCP server 崩溃 = 所有 jobId 失效、in-flight review 的进程树依赖 exit handler 兜底（有兜底，但 job 状态、日志、报告全丢）。异步作业模型下这是可被单点触发的全局故障。

## L5 [P3] 声明了 `tools.listChanged: true` 但从不发送 list_changed
- 黑盒握手实测 `CAPS: {"tools":{"listChanged":true}}`；`src/index.js` 中无 `sendToolListChanged` 调用，工具集也是静态的。声明了不会发生的能力，客户端会等一个永不来的通知。

## L6 [P3] 四个工具均未声明 `outputSchema`，却返回 `structuredContent`
- 黑盒 `tools/list` 实测：4 个工具 `outputSchema: false`；但 `src/index.js` 有 10 处 `structuredContent`（如 `claude_review_status` 返回 `{jobId,status,repoPath,sessionId,startedAt}`）。
- 按 MCP spec，无 outputSchema 时 structuredContent 仍可传，但客户端无法校验/类型化，部分客户端会直接忽略。声明 schema 才能让 ZCode 这类客户端用上结构化结果。

## L7 [P3，环境相关] 本机 claude 2.1.133 低于硬化门槛，硬防护被静默降级
- `claude_review_env` 实测输出：`--permission-mode manual` 需要 >= 2.1.200（**TOO OLD**）、`--permission-prompts none` 需要 >= 2.1.259（TOO OLD）→ "hardened mode is skipped"。
- 代码在 `src/index.js:616-626` 会写 note 说明降级，设计是诚实的；但用户只有在 review 报告里才会看到，env 工具之外无主动提示。建议 README 明确写出"低于 2.1.200 时 shell guard 是唯一防线"。

## L8 [验证通过，非缺陷] 黑盒协议行为良好
- stdio 握手 130ms，stdout 完全干净（日志全走 stderr）。
- 4 个工具 schema 正确、必填项正确；错误全部以 `isError:true` + 可操作文案返回（相对路径、非 git 仓库、未知 jobId、`-rf` 注入 sessionId 均被拦截）。
- 已实现 progress token（`src/index.js:1147-1155`、`1617-1625`）与 `extra.signal` 取消传递——比多数 MCP server 做得好。


## L9 [P0 已独立复现] 大小写变体的 `.GIT` 写入绕过仍然存在（CHANGELOG 声称已修）
- **声称**: `CHANGELOG.md:10` —— "the case-sensitive `.GIT` write bypass in fix mode ... are all refused"（1.18.0 已修）。
- **实测**（Lead 亲自跑 live hook，macOS 大小写不敏感 FS）:
  ```
  Write <repo>/.git/hooks/pre-commit   => DENIED
  Write <repo>/.GIT/hooks/pre-commit   => ALLOWED (no decision)   <-- 绕过
  Write <repo>/.Git/config             => ALLOWED (no decision)
  写入后 fs.existsSync(<repo>/.git/hooks/pre-commit) === true     <-- 真的落到 .git/hooks/
  ```
- **根因（两层都漏）**:
  1. `scripts/pre-tool-hook.js:120` `/^\.git([\\/]|$)/` 大小写敏感，且 `realContainment` 保留输入大小写；
  2. `src/prompt.js:361` deny glob 只有小写 `.git` / `.git/**` 等，无 `.GIT` 变体。
  `src/shell-guard.js:509` 只在 `cdProblem` 的 win32 分支做了 toLowerCase，与本路径无关。
- **危害**: fix 模式下 Write/Edit 是授予的；被审仓库里的内容（提示注入）可诱导模型写 `.GIT/hooks/pre-commit`。macOS/Windows 大小写不敏感文件系统上该文件就是 `.git/hooks/pre-commit`，下一次 git 操作即在**仓库外执行任意代码并持久化**——正是 hook 注释里"a hook written there would outlive this run"要防的事。
- **测试**: `scripts/shell-guard-test.mjs:359-360` 只覆盖小写 `.git`，全仓无 `.GIT`/`.Git` 用例 → 修复既无代码证据也无回归测试。
- **建议**: 两侧统一按平台做大小写归一（或一律 case-insensitive 匹配 `.git` 段）；同时把 deny glob 补上大小写变体，并加 3 条回归用例（`.GIT`、`.Git`、`**/.GIT/**`）。

## L10 [P1 已确认] `npm test` 的 `&&` 串联让 3 个失败吞掉 272 条测试
- `package.json` test 脚本 = `node scripts/shell-guard-test.mjs && node scripts/audit-fixes-test.mjs && node scripts/smoke-test.mjs`。
- shell-guard-test 退出码 1 → 后两个套件**根本不执行**。实测：`npm test` 只输出 "FAILURES: 230 passed, 3 failed" 就结束；单独跑 audit-fixes-test 是 272/0 全绿、smoke 也通过。
- 后果：真实的回归信号被前一个套件的红色掩盖，且 `npm test` 的实际退出码在管道场景下更易被误读。

## L11 [P2 已确认] README 挂了不存在的 CI badge
- `README.md:3` 指向 `https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml/badge.svg`，但**仓库根目录没有 `.github/`**（实测 `ls .github` 不存在）。
- 即：badge 是死链，"CI 绿"是视觉假象；`CHANGELOG.md` 与 `CONTRIBUTING.md` 也声称 CI 跑 e2e。

## L12 [P2] 策略表遗漏 `git grep`（真实误杀）
- `src/shell-guard.js:55-99` 的 `BASH_POLICY` 允许 `grep`、`rg`、`git ls-tree`、`git blame` 等，但**没有 `git grep`**——而 `git grep` 是仓库内最常用的只读搜索之一，实测被拒："not part of the review's Bash surface"。
- 同类：`git tag`（只读列举）也被拒。
- 定量：对 48 条"reviewer 常见命令"语料实测放行 33 / 拒绝 15（31%）；其中大多数是**设计如此**（cat/head/tail/sed/wc/awk/node/npm/jq/python 一律由 Read/Grep/Glob 替代），真正不合理的误杀是 `git grep` 与 `git tag`。
- 影响：每次误杀消耗一个 review turn（CHANGELOG 1.17.0 自己记录过"首轮 36 次 denial"的代价）。



## L13 [P0 已独立复现] runtime-auditor 的 R-2 / R-3：仓库内 git diff driver 可执行任意命令（RCE）
威胁模型：评审的仓库来自目录/压缩包（项目自己在 `src/claude.js:1729-1735` 明确把"整目录拷贝/迁移"纳入威胁模型），其 `.git/config` 可带 `[diff "evil"] textconv = <cmd>`。`repoRunsGitPrograms()` 是唯一防线（`-c diff.external=` 关不掉按驱动名配置的 textconv）。

Lead 实测（用 `repoRunsGitPrograms` 真函数 + reviewer 会跑的裸 `git diff`，非 mock）：
```
CONTROL  root .gitattributes + 正常 section      | scan refusals: 1 | RCE: YES   <- 被 refusal 拦住，run 不会启动
R-2      src/deep/.gitattributes + 正常 section  | scan refusals: 0 | RCE: YES   <- 扫描器看不见深度>=2
R-3      root attrs + [diff "benign"] 后再写 [diff "evil"] textconv = cmd 同行 | scan refusals: 0 | RCE: YES
```
- R-2 根因：`src/claude.js:1836-1851` `repoAttributeFiles` 只扫 root / `.git/info/attributes` / **一级**子目录（函数注释自认 "one directory deep"）。
- R-3 根因：`sectionsOf`（`1879-1888`）要求 header 独占一行；`[diff "evil"] textconv = cmd` 是合法 git config（`git config --get diff.evil.textconv` 可读出），该行被归到上一个 `[diff "..."]` section（`1932-1936`）后 `continue`，驱动永不登记 → 交叉检查 `driverLive.has("evil")===false` → 既不 refusal 也不 note。
- 两处均需补回归用例：深度≥2 的 attributes、同行 section header。

## L14 [P0 已独立复现] R-1：仓库提交的 `.gitattributes` 符号链接可冻结整个 MCP server
Lead 实测（`repoRunsGitPrograms` 同步 `readFileSync`，无 lstat / 无大小上限 / 跟链）：
```
.gitattributes -> /dev/zero    => 6s 超时被杀（无上限分配）
.gitattributes -> /dev/stdin   => 阻塞到 stdin 管道关闭（实测 7.9s，管道一关才返回）
```
真实 MCP server 的 stdin 就是永不关闭的 JSON-RPC 管道 → 单线程事件循环永久阻塞，任何工具都不再响应，没有超时能救。调用点 `src/index.js:1116`（review 预检，同步，在 spawn/timeout/guard 之前）。

## L15 [P0 组合链，Lead 新发现] `.GIT` 绕过 + textconv = fix 模式下的持久化 RCE
两个已独立验证的缺陷可以串成一条链，比单独任何一条都严重：
1. fix 模式授予 Write/Edit；
2. hook 允许写 `repo/.GIT/config`（L9 实测 ALLOWED，且写入真的落到 `.git/config`）；
3. `.gitattributes` 不在 deny 名单（`src/prompt.js:360-367` 只 deny `.git/.env/密钥`），可写；
4. 下一次 reviewer 执行允许清单内的 `git diff` → 触发 `[diff "evil"] textconv` → 以服务进程用户身份执行任意命令（L13 实测）。
→ 被审仓库里的提示注入内容即可诱导模型完成 2+3，RCE 且**持久化在用户仓库里**（.git/config + .gitattributes 都留在工作区）。这条链不需要"仓库以压缩包形式投递"这个前提，因此把 R-2/R-3 的严重性从"有条件 P0"提升为"P0"。



## L16 [P0 已独立复现] shell-guard 的根本缺陷：把原始命令串当 argv，未建模 bash 的引号/转义展开
Lead 用**真实 hook 进程** + **真实 bash 执行**双重验证（不是静态推断）：

| 用例 | hook 判定 | bash 实际效果 |
|---|---|---|
| `find . -name x -exec sh -c id \;`（基线） | **DENIED** | — |
| `find . -name x $'-exec' sh -c 'echo PWNED > /tmp/ansi-pwn' \;` | **ALLOWED** | **PWNED 文件生成 = 任意命令执行** |
| `git diff --output=/tmp/x`（基线） | **DENIED** | — |
| `git diff \--output=/tmp/out-pwn` | **ALLOWED** | **仓库外写入成功** |
| `git diff $'--no-index' /etc/passwd /etc/hosts` | **ALLOWED** | 读仓库外任意文件 |
| `git log \| sort -o /tmp/x`（基线） | **DENIED** | — |
| `git log \| sort -o/tmp/sort-pwn` | **ALLOWED** | **仓库外写入成功** |

根因：
1. `parseCommand` 直接按空白切分原始字符串，**不展开** `$'...'`（ANSI-C 引用）、`$"..."`、反斜杠转义；而 bash 会在执行前展开。所有 deny 表（`FLAG_KINDS`/`OUTRIGHT_DENY`/`FIND_WRITE_FLAGS`/`gitWriteFlagIn`）都是**token 精确匹配**，于是 `$'-exec'` 与 `-exec` 是两个世界。
2. `FLAG_KINDS` 只识别 `-x VALUE` 分隔形式，不拆 `-xVALUE` 紧贴形式 → `sort -o/tmp/x`、`sort -T/tmp` 等全部漏检（`src/shell-guard.js` 中 `FLAG_KINDS` 与 `sort` 的处理）。

影响：这是**整套防护的地基**——`BASH_POLICY` 渲染成 claude 的 `Bash(...)` 权限规则，而 hook 是唯一逐段判定点；hook 可被提示注入内容诱导模型用一条 `$'...'` 命令绕过。项目把"hook 放行 = 引擎放行不可能漂移"当作安全承诺（README:164），实际两者都建立在同一个不完整的 tokenizer 上。

修法建议（按优先级）：
- 用真正的 shell 词法/语法分析（如 `bash -n` + `shell-quote` 类库的完整模式）替代手写切分；至少显式拒绝含 `$'`、`$"`、`\` 转义、`${...}`、`$(` 的命令（当前只拒 `$(`/反引号/`${}`）。
- `FLAG_KINDS` 增加紧贴短选项（`-o<val>`）的拆解规则。
- 为每个 P0 用例加 hook 进程级回归测试（当前 shell-guard-test 只测了 `find -exec` 分隔形式）。

