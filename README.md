# cc-code-review

[![CI](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518.19-brightgreen)

[English](README.en.md) | 简体中文

**EN**: An MCP server that wraps Claude Code's code-review skill (5 parallel reviewer subagents, 0–100 confidence scoring, keeps findings ≥ 80). Run reviews — PR / branch / working dir / last commit, effort `low→max`, optional fix mode — from ZCode or any MCP client and get the full report back. Works with a CC-Switch-style local gateway, direct OAuth login, or an API key, on Windows and macOS, with the standalone CLI or the desktop-app-embedded CLI.

把 **Claude Code 的 code review 能力**封装成 MCP server，让 ZCode（或任何 MCP 客户端）直接调用：
ZCode → MCP → `claude -p`（headless）→ code-review skill（5 并行评审 subagent + 0-100 置信度打分 + ≥80 过滤）→ 审查报告原样返回给 ZCode → ZCode 根据报告改代码 → 再次调用复核。

```
ZCode ──MCP(stdio)──▶ cc-code-review ──spawn──▶ claude -p --output-format stream-json
                            │                              │  cwd = 目标仓库
                            │                              └─ ~/.claude/skills/code-review（本 MCP 自动安装）
                            ◀── result(报告 + session_id + 花费) ──┘
```

## 前置条件

- Node ≥ **18.19**（本机用 `C:\Program Files\nodejs\node.exe` 启动）
- 已安装 Claude Code。**无需 OAuth 登录**，三种接入方式均可：
  - **CC Switch / claude-code-router 等网关**：配置写在 `~/.claude/settings.json` 的 `env` 块，claude 每次启动自行读取（同名键 settings 覆盖进程环境变量），所以切换供应商对下一次 review 立即生效。本 MCP 会对**本地回环网关**（127.0.0.1 等）做 TCP 预检，网关挂了会立刻报"gateway not reachable"而不是干等到超时；本地网关流量不会走 HTTP 代理（自动补 `NO_PROXY`）。
  - **官方账号登录（OAuth/Pro/Max）**：首次需在终端交互式跑一次 `claude` 完成登录，之后 headless 直接可用。注意：若 MCP 宿主以服务/计划任务方式运行且读不到当前用户凭证（Windows Credential Manager / macOS Keychain），会报 "Not logged in"。
  - **ANTHROPIC_API_KEY 环境变量**：从宿主环境继承，天然可用。
- PR 范围审查需要 `gh` 已登录；本地 diff 审查（working-dir / branch / last-commit）只需 git。

## 跨平台与安装方式支持

`claude` 可执行文件按以下优先级解析（`claude_review_env` 可查看命中来源）：

| 优先级 | 来源 | Windows 路径 | macOS 路径 |
|---|---|---|---|
| 1 | `CLAUDE_CODE_PATH` 环境变量 | 任意可执行文件或 cli.js（不接受 .cmd/.bat/.ps1 shim） | 同左 |
| 2 | PATH 扫描 | `claude.exe` | `claude`（可执行） |
| 3 | 常见安装位置 | `%USERPROFILE%\.local\bin\claude.exe`（native installer）、winget Links、npm 默认前缀包内 exe | `~/.local/bin/claude`（native）、`/opt/homebrew/bin/claude`、`/usr/local/bin/claude`、`~/.claude/local/claude` |
| 4 | npm 全局 root（尊重自定义 prefix） | `<npm root -g>/@anthropic-ai/claude-code/bin/claude.exe` 或 `cli.js` | 同左 |
| 5 | Claude 桌面 app 内置 CLI（兜底，非官方入口） | `%APPDATA%\Claude\claude-code\<版本>\claude.exe` | `~/Library/Application Support/Claude/claude-code/<版本>/claude.app/Contents/MacOS/claude` |

说明：
- 不用 `where`/`which` 子进程（中文 Windows 上 `where` 输出 GBK 会解成乱码），直接用 Node 读 PATH 逐目录探测。
- **只装桌面 app、没装 CLI 也能用**：兜底到 app 内嵌的版本化 CLI（取最新版本目录；app 更新后路径可能漂移，建议正式使用装一份 CLI）。
- macOS 注意：若宿主从 Dock/Finder 启动，继承的是 launchd 的精简 PATH，本 MCP 会自动把 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin` 等**追加**进 claude 子进程的 PATH（npm shim 的 `#!/usr/bin/env node` 与 claude 内部的 git/gh 都依赖它；追加而非前置，是为了不遮蔽用户自己的 PATH 优先级）。同理，ZCode 的 MCP 配置里 `command` 建议写 node 的**绝对路径**。
- macOS native 二进制首次 headless 运行若被 Gatekeeper 拦截（SIGKILL），错误信息会提示先在终端跑一次 `claude --version`。
- 超时/取消会杀整棵进程树（Windows `taskkill /T /F`，Unix 进程组 SIGKILL）；MCP server 自身退出时也会清理存活子进程。

## 注册到 ZCode（已完成则跳过）

**推荐：一条命令自动配置（v1.7.0 起）**。克隆/安装本仓库后，在里面跑：

```bash
npm install
npm run init
```

`init` 会做一轮**免费自检**（claude CLI 解析与版本、加固 flag 地板、shell guard 实测、skill 状态、git/gh、网关连通性），然后**按本机环境**把注册写进 `~/.zcode/cli/config.json`——node 用的是当前运行的绝对路径、入口文件用本仓库的绝对路径、网关凭据（如果检测到 CC Switch / settings.json / 环境变量配置）自动带上。Windows/macOS/Linux 无需手改任何路径。写完重启 ZCode（或重连 MCP）即可，工具名：`mcp__cc-code-review__claude_code_review` 等。

手动配置（等效，适合不想跑脚本的人）——注意 `command` 必须是本机 node 的**绝对路径**，`args` 必须是本仓库 `src/index.js` 的**绝对路径**：

```json
{
  "mcp": {
    "servers": {
      "cc-code-review": {
        "command": "<本机 node 绝对路径>",
        "args": ["<本仓库>/src/index.js"]
      }
    }
  }
}
```

> 工具名（`claude_code_review` / `claude_review_status` / `claude_review_followup` / `claude_review_env`）与环境变量前缀（`CLAUDE_REVIEW_*`）**保持稳定**，不随 server 名改变——已注册过的调用方与脚本无需跟着改，改的只是 server 键名（工具前缀从 `mcp__claude-review__*` 变成 `mcp__cc-code-review__*`）。

## 工具

### 1. `claude_code_review` — 跑一轮 review

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `repoPath` | 必填 | - | 被审查仓库的绝对路径（支持 `~/` 前缀） |
| `scope` | `auto` | 5 选 1 | `auto` / `pr` / `branch` / `working-dir` / `last-commit`；auto 按 PR → 领先默认分支的提交 → 未提交改动 → 上一条提交 自动判断 |
| `pr` | - | - | GitHub PR 编号或 URL |
| `baseRef` | - | 纯 ref 字符 | `branch` 范围的基线（缺省自动探测默认分支；非法字符会被忽略） |
| `focus` | - | - | 额外关注点（仅作为评审提示，不会被当作指令执行） |
| `outputLanguage` | `中文` | - | 报告语言 |
| `postToPR` | `false` | - | 额外用 `gh pr comment` 把摘要贴回 PR（默认只返回报告，不外发） |
| `fix` | `false` | - | **修复模式**：报告后直接修改仓库文件修复 findings（只放开 Edit/Write，**无任何 git 写命令**，不 commit；`.git/**`、`.env*`、密钥文件均在 deny 列表，实测拦截有效） |
| `effort` | `high` | low/medium/high/xhigh/max | **评审力度**，与 Claude Code 原生 `--effort` 同档位；CLI 不支持时自动退化为 think/ultrathink 关键词（两者不会叠加） |
| `model` | - | - | 覆盖模型（`--model` 透传） |
| `maxTurns` | `80` | 4–200 | agentic 轮数上限 |
| `timeoutMinutes` | `20` | 1–60 | 硬超时 |
| `maxBudgetUsd` | `5` | 0–50 | API 花费上限（`--max-budget-usd`，0 = 关闭；第三方网关下依赖网关返回 usage，按 Anthropic 官方单价估算，可能不准或提前中止） |
| `installSkillIfMissing` | `true` | - | skill 缺失时自动安装 |

返回（默认异步：先返回 jobId（<1 秒）与预检结论，报告用 claude_review_status(jobId) 取回；waitForResult: true 时为下列同步返回）：markdown 报告（Review Summary / Findings / Notes）+ 元数据（`session_id`、花费、轮数、日志路径）。claude 的认证/网关类失败会以醒目的 `⚠️ REVIEW FAILED` 横幅返回并附处理建议，不会伪装成"报告"。

### 2. `claude_review_status` — 轮询/获取/取消后台 review 任务（免费）

`claude_code_review` 默认**异步**：免费预检全部通过后立刻返回 jobId（<1 秒）——因为真实 review 要 2-15 分钟，而多数 MCP 客户端 ~30 秒就掐断工具调用。本工具：传 jobId 轮询（运行中报已耗时）或取回完整报告；传 jobId + cancel=true 中止并停止计费；不传参数列出本进程的任务。需要同步语义的客户端在 claude_code_review 里传 waitForResult: true。

### 3. `claude_review_followup` — 追问 / 复核

拿着上一次返回的 `session_id` 继续对话（`claude --resume`）。

### 4. `claude_review_env` — 环境自检（免费）

CLI 解析结果与来源、版本、`--effort`/`--max-budget-usd` 支持情况、skill 状态、网关连通性（回环网关 TCP 预检）、宿主环境中残留的认证变量告警、`git`/`gh` 可用性、`CLAUDE_CODE_EFFORT_LEVEL` 覆盖告警。首行输出机器可读的 `verdict: OK|NOT_FOUND|MISCONFIGURED`。`installSkill: true` 可手动（重）装 skill。

## code-review skill 说明

- `~/.claude/skills/code-review` 不存在时，首次调用自动安装本仓库自带版本（Anthropic 官方 code-review 管线改编），带 `installed-by-cc-code-review` 标记（旧版 `installed-by-claude-review-mcp` 标记仍被识别为"本 MCP 装的"，下次安装时自动迁移成新标记，不会被误判成你自己的 skill）。
- 该目录已有你自己的 skill 时**原样使用、绝不覆盖**。
- 不想自动安装：`installSkillIfMissing: false` 或 `CLAUDE_REVIEW_AUTO_INSTALL_SKILL=0`，退化为内置精简评审提示词。

## 安全模型（多轮独立审计后）

**进程边界（v1.3.0 新增，实测验证）**

- `--setting-sources user`：被审仓库可能自带 `.claude/settings.json`（project/local 作用域），加载它会执行仓库控制的 SessionStart hook（任意代码执行）并覆盖 `ANTHROPIC_*`（凭据外带）。本 MCP 只加载用户级 settings。已用对照实验验证：带恶意 settings.json 的仓库在不加该旗标时 hook 确实执行、API 连接被劫持，加上后两者都消失。
- `--permission-mode manual` + `--permission-prompts none`：allowlist 成为**硬边界**——不在名单内的调用直接拒绝，不再经过模型驱动的权限分类器（提示注入可以绕过分类器）。`--permission-prompts none` 让"本该弹窗询问"的调用也直接拒绝（headless 下没有宿主能回答弹窗）。代价是名单必须完整，实测中已补齐 `Skill`、`TodoWrite`、`Bash(git remote show:*)` 等评审管线必需项。

**工具权限**

- 评审模式**只读**：文件读取 + git/gh 只读命令 + subagent + skill 加载。**无** `gh api`（前缀规则无法区分 HTTP method，等于全量 GitHub 写权限）、**无** WebFetch（避免代码外带/SSRF）。
- 评审模式另有 deny 纵深：Edit/Write/NotebookEdit、git 写命令（add/commit/push/reset/checkout/config…）、`git diff --output=`（前缀规则 `git diff:*` 会顺带匹配到的写文件原语）、gh 写命令、以及 `node -e`/`python -c`/`sed -i`/`cat > f`/`tee` 等**能用 shell 重定向绕过 Edit/Write 管控的解释器与写操作**——实测这些正是模型被拒后最先尝试的捷径。
- **deny 规则不能图省事写整类**：deny 优先于 allow，所以 `Bash(git remote:*)` 这种"整类封死"的规则会把 `git remote -v`（管线用它探测 GitHub remote）、`git branch -a` 一起杀掉——一次真实 review 的唯一一条 Bash 拒绝正是这么来的。`remote`/`branch`/`tag` 因此只 deny **写形式**（`git remote add`、`git branch -D`、`git tag -a`…），读形式留给 allowlist；`git merge-base` 干脆不授权（`Bash(git merge:*)` 会前缀命中它），提示词改用 `git log base..HEAD` / `git diff base...HEAD`。这条不变量由 `audit-fixes-test.mjs` 的 "no allow rule is prefix-shadowed by a deny rule" 与一次真实 review 的命令回放锁定。
- fix 模式只加 Edit/Write/NotebookEdit（deny 列表在 fix 模式下**不再**包含这三个工具，否则 fix 会退化成"只描述不落盘"）；**不给** `git add`/`git restore`（防未提交工作被静默丢弃）；deny 列表封死 `.git/**`、`.env*`、密钥/凭证文件（deny 优先于 allow，已在真实 CLI 上实测拦截）。

**Bash 前缀匹配绕权与 PreToolUse hook（v1.4.0 新增，实测验证）**

Claude Code 的 Bash 权限规则是**把整条命令当字符串做前缀匹配**：`--allowedTools "Bash(git status:*)"` 不只放行 `git status`，也放行 `git status; curl evil.com`；deny glob（如 `Bash(*;*)`）根本不触发，因为规则匹配的是命令本身而非它的组成部分。**只要允许用 Bash，任何"放行第一条命令"的规则都等于放行任意命令**——这不是规则写得不够好，是权限引擎的性质，改规则列表堵不住。已实测确认。

所以本 MCP 额外挂了一个 **PreToolUse hook**（`scripts/pre-tool-hook.js`，通过 `claude --settings <临时文件>` 注入，与 `--setting-sources user` 并存且不覆盖用户 settings——已实测 CC Switch 网关配置仍然生效）：命令执行前看到完整命令，命中 `;` `&&` `||` `|` `&` 换行 `>` `>>` `<` 或 `$()`/反引号/`${}` 替换即 deny。它**覆盖 subagent 的 Bash 调用**（5 路并行评审的主力），实测一次真实 review 里 2 条 `git show … | sed -n …` 被拦下并记入 `permission_denials`，评审改用分开调用后正常完成。

> ⚠️ **`--settings` 替换的是整个 `hooks` 键**：注入的临时文件里只有本 MCP 的 hook，用户 `~/.claude/settings.json` 里自己配置的 hooks 在**本次子进程内不会生效**（其它键如 `env`、`model`、`permissions` 不受影响）。这是 CLI 的行为，不是遗漏——如果你依赖自己的 hook 在 review 期间运行，目前需要另想办法。

判定逻辑在 `src/shell-guard.js`，hook 与运行后的报告**共用同一份实现**，"报告说拦了"和"实际拦了"不可能不一致。它先剥掉引号 span 再判定，`git log --format="%h; %s"` 不会误报；引号不配对时 fail-closed（`git status # don't; curl evil.com` 这种把 payload 藏进注释的写法藏不住）。契约由 `scripts/shell-guard-test.mjs` 锁定（63 条，含一次真实 5-subagent review 的命令回放）——**改那行正则前先跑 `npm test`**。关掉它：`CLAUDE_REVIEW_SHELL_GUARD=0`（此时整体会 fail-closed 拒跑，见下文"纵深失效即拒跑"）。

hook 还有第二条确定性规则：**git 的 `--output=` / `--output-directory=` 会让"只读"命令写文件**（`git diff/show/log --output=<file>`、`git format-patch --output-directory=` 实测都会落盘；`--output-to=` 不是真实旗标）。deny glob 对这条无能为力——Bash 规则是整条命令前缀匹配，`Bash(git diff --output=*)` 拦不住 `git diff HEAD --output=x`，而中间带 `*` 的规则语义无法从 CLI 外验证——所以这一条由 hook 直接判掉。注意 `grep --output`、`find -print` 等非 git 的 `--output` 不受影响。

**写入面收敛（hook 的另一半职责，v1.5.0）**

Edit / Write / NotebookEdit / Read 也被 hook 审查，且以 `CLAUDE_REVIEW_REPO_ROOT` 为界：目标路径必须解析到被审仓库内，`.git/**`、`.env*`、`id_rsa*`/`*.pem`/`*.key` 等密钥路径一律 deny；没有传 `repoRoot`（hook 配置没生效）时 fail-closed 全部拒绝，而不是放行。边界判定走 **realpath**（两侧都解析真实路径），所以仓库里的目录 junction/软链接（`repo/link -> ~/.ssh` 这种"词法在仓库内、实际在外面"的逃逸）也会被拦下（有回归测试锁定）；未命中已有目标的写入按"最近的已存在祖先"解析。

**仓库即代码执行面（v1.5.0 新增，v1.7.0 起按"存活"判定）**

git 会执行**仓库自己**的配置：`core.fsmonitor`、`diff.<driver>.command`、`.gitattributes` 的 filter/textconv 驱动、`core.hooksPath`、`[include] path = ../x`（可指向仓库外）。`-c` 覆盖只能中和已知键，驱动名是任意的。所以每次运行前会扫描 `.git/config`（含 include 链）与各级 `.gitattributes`：**发现仓库控制的程序执行就直接拒跑**，而不是带病开审。

扫描是精确的，不会误伤普通仓库：`.gitattributes` 里写了 `*.png filter=lfs` 但驱动定义在用户全局 config（git-lfs 的常见装法）时**不**拒；`core.fsmonitor = true`（布尔，且本来就被 `-c` 中和）也**不**拒。v1.7.0 起进一步区分"活的"与"死的"配置：

- **死路径降级为提示**：从另一台机器整目录拷贝/迁移过来的仓库，`.git/config` 里常带着原机器的绝对路径（如在 Windows 上看到 `core.hooksPath = /Users/kent/Desktop/...`）。路径在本机**不存在就执行不了任何东西**——降级为报告中的一条 note，不再阻塞 review（有回归测试锁定）。
- **`core.hooksPath` 即使是活的也只提示不拒**：git hooks 只在 commit/merge/rebase 这类**变更型**操作时触发，而评审 allowlist 从不授权任何变更型 git 命令；本 MCP 自己的 git 调用也总是带着 `-c core.hooksPath=` 中和它。fsmonitor/textconv/external/filter 驱动则不同——它们在 `git status`/`git diff` 这些**只读命令**上就会触发，所以活的一律拒，死的提示后放行。

**纵深失效即拒跑（fail closed）**

hook 没装上、`guardSelfTest()` 自检失败（hook 真的能拦下一条链式命令、真的放行一条干净命令）或 guard 状态为 `failed` 时，两个工具都会**直接拒绝发起 review**，并说明缺了哪一层——因为 manual 模式的 allowlist 单靠自己挡不住前缀匹配绕权。确实要无防护运行（例如排查误报）才设 `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` 显式解锁。

**版本地板（v1.5.0 新增）**

`--permission-mode manual` 需要 CLI ≥ 2.1.200、`--permission-prompts none` 需要 ≥ 2.1.259。把未知旗标传给旧版 claude 会以一句难懂的报错结束整次运行，所以运行前读一次 `claude --version` 做门控（版本比较对 `2.1.301-beta.1` 这类预发布版安全），不达标就不传该旗标并在结果里说明退化情况。`claude_review_env` 会打印这两个地板与当前 CLI 版本。

**输入校验（v1.3.0 新增，全部在发起付费调用前）**

| 输入 | 规则 | 原因 |
|---|---|---|
| `repoPath` | 必须是绝对路径（`~/` 会展开） | 相对路径会按 MCP 服务器自己的 cwd 解析，可能审错仓库还花了钱 |
| `repoPath` | 必须是 git/hg/svn 仓库 | 所有 scope 都读 git 历史，非仓库只会得到一次注定失败的付费调用 |
| 空仓库 | 无提交且无未提交改动 → 直接报错 | 没什么可审 |
| `pr` | 只接受 `123` / `#123` / `owner/repo#123` / GitHub PR URL | 该值会拼进评审提示词 |
| `outputLanguage` | 单行、≤40 字符、无反引号 | 同上，防止夹带指令 |
| `baseRef` | 纯 ref 字符，且不接受以 `-` 开头 | 会拼进 `git merge-base <ref>`；以 `-` 开头会被 git 当成旗标（`git merge-base --output=<file>` 还会写文件），因此直接拒绝而不是"忽略" |
| `focus` | 单行、≤2000 字符、拒绝控制字符 | 同上 |

**取消语义**：MCP SDK 对已取消的请求会**故意丢弃响应**（协议规范如此，客户端本就已知自己取消了）。所以取消后你看不到"已取消"的返回值，但子进程树会在取消后约 2 秒内被 taskkill 杀掉、立刻停止计费；客户端断开 stdio 时同样会杀掉在跑的 review。

**可观测性（v1.3.0 新增）**：结果元数据里带 `permission_denials` 与 `reviewer_subagents_spawned`。manual 模式下 allowlist 漏项不会中断运行、只会让评审静默退化（例如 5 个 reviewer 子代理根本没起来），这两个字段把这种退化变成可见的。fix 模式还会比对运行前后的 `git status`，若工作区毫无变化会明确报 `FIX MODE VERIFICATION FAILED`——评审者"描述"了修复但没落盘时不会被误判成功。

v1.4.0 起元数据另加 `bashCalls`（本次发起的 Bash 调用数）与 `shellGuardBlocked`（被 hook 拦下的链式命令数），并区分两类拒绝：链式命令被拦是 **hook 正常工作**（提示模型拆成多次调用即可，不算评审退化），只有其它拒绝才报"评审可能不完整"。若出现 `⚠ SHELL-CHAINED COMMANDS RAN WITHOUT BEING BLOCKED`，说明有命令绕过了 hook 真实执行了，此时才需要把该仓库当敌对环境处理。

- 运行日志（含被审代码引用）写入 `%TEMP%/cc-code-review/`，目录 0700、文件 0600，只保留最近 20 份。
- CLI 自带一份内置安全命令白名单（`ls`、`cat`、`echo` 等只读工具），即使不在 `--allowedTools` 里也会放行。已实测 `node -e`、`python -c`、`rm`、`git push`、`git commit`、`curl`、Write 工具调用**全部被拒**，所以这不是提权口子，但"只放行白名单里的命令"要按"白名单 + 这批内置只读命令"来理解。
- 模型可以把被 hook 拦下的复合命令拆成多次允许的调用分别执行——hook 拦的是"一条命令里串多步"，不是"一个回合里做多件事"。真正的能力边界仍然是 manual 模式的 allowlist，hook 保证每一步都可被单独审计。
- 已知残留风险：仓库内其他文件的 fix 改动、prompt 注入诱导的"看起来合理"的编辑——fix 模式改动留在工作区不 commit，请像审 PR 一样 `git diff` 检查后再采纳。
- 已知残留风险（Windows）：日志目录/文件的 0700/0600 是尽力而为——NTFS 不存 POSIX 权限位，同一台机器上的其他本地用户理论上可读 `%TEMP%\cc-code-review\run-*.log`（内含被审代码引用）。需要更严的隔离请设 `CLAUDE_REVIEW_LOG_DIR` 指向受限目录，或接受该风险（多数单用户桌面场景等同无风险）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDE_CODE_PATH` | 自动探测 | claude 可执行文件 / cli.js（不接受 shell shim） |
| `CLAUDE_REVIEW_TIMEOUT_MIN` | `20` | 默认超时（分钟） |
| `CLAUDE_REVIEW_MAX_BUDGET_USD` | `5` | 默认花费上限（0 = 关闭） |
| `CLAUDE_REVIEW_MODEL` | - | 默认模型 |
| `CLAUDE_REVIEW_AUTO_INSTALL_SKILL` | `1` | 是否自动安装 skill |
| `CLAUDE_REVIEW_SHELL_GUARD` | `1` | `0` 关闭 PreToolUse shell 链式命令拦截（仅用于排查误报，不推荐；单独设它不会放行，还会连带拒跑） |
| `CLAUDE_REVIEW_ALLOW_UNGUARDED` | - | 设 `1` 才允许"hook 未生效/自检失败"时仍然开跑。默认拒跑 |
| `CLAUDE_REVIEW_LOG_DIR` | `%TEMP%/cc-code-review` | 运行日志目录（日志含被审代码引用；Windows 上无 POSIX 权限位，可指向自有 ACL 的目录） |

提示：若宿主环境残留 `ANTHROPIC_API_KEY` 等认证变量但 settings.json 未管理它们，可能与 CC Switch 冲突（`claude_review_env` 会告警）；网关用户可在 `~/.claude/settings.json` 加 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"` 减少非必要流量。

## 成本与时长

- 每次真实 review 消耗 Claude 额度（走你的订阅/网关），典型 2–15 分钟、$0.3–5（视 diff 与 effort）；`maxBudgetUsd` 兜底。
- `claude_review_env` 与版本/flag 探测免费（结果有缓存）。

## 在 ZCode 里怎么用

重启 ZCode 后直接说，例如：

> 用 cc-code-review MCP 对 C:\path\to\repo 的未提交改动跑一轮 code review（effort 用 max），然后根据 findings 修复，修完再复核一遍。

## 测试 / 维护

```bash
npm install
npm test                                         # shell-guard 单测（67 条，免费）+ 审计修复单测（158 条，免费）+ stdio 握手/环境检查
npm run init                                     # 环境自检 + 按本机写入 ZCode 注册（免费）
node scripts/validation-test.mjs                # 全部输入校验路径（免费，不发 API 请求）
node scripts/cross-cases.mjs                    # 10 个 MECE 用例（44 项检查；含桩 claude 的免费异步生命周期；C9 付费需 CC_LOOP_PAID=1）
node scripts/e2e-test.mjs <repoPath> [json]     # 真实 review（计费）
node scripts/followup-e2e.mjs <repoPath> <sessionId> # 真实 followup（计费）
node scripts/cancel-test.mjs <repoPath>         # 取消后进程树是否被立刻杀掉（计费，几美分）
```

`validation-test.mjs` 覆盖：相对 `repoPath` 拒绝、恶意 `pr` 拒绝、多行 `outputLanguage` 拒绝、空仓库拒绝、非 git 目录拒绝、`maxBudgetUsd=0` 被 schema 接受、`baseRef` 以 `-` 开头拒绝、`focus` 含控制字符/超长拒绝、guard 未生效时两个工具都 fail-closed 拒跑、以及 `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` 的显式解锁。全部在付费调用之前返回——唯一例外是"clean repo 通过 preflight"这条（它会真的发起一次有预算上限的付费 run），默认跳过，设 `CC_REVIEW_ALLOW_PAID_PROBE=1` 才执行。

`shell-guard-test.mjs` 覆盖：链式/重定向/替换命令必须拦、`git log --format="%h; %s"` 这类引号内分隔符必须放行、引号不配对 fail-closed、hook 进程的 stdin→deny 契约、Edit/Write/Read 的仓库边界与 `.git/`/密钥路径拦截、仓库内 junction/软链接逃逸（realpath 边界），以及一次真实 5-subagent review 的 17 条命令回放（确认被拦的命令不会被误报成"逃逸"）。

`audit-fixes-test.mjs` 覆盖三轮独立审计的每条修复：deny 列表覆盖面与"同一规则同时出现在 allow/deny 里变成死规则"的冲突、**allow 规则被 deny 规则前缀遮蔽**（`Bash(git remote -v)` vs `Bash(git remote:*)`，真实 review 发现的）、`postToPR` 授权不是死代码、版本比较（含预发布号）、git hardening 的 `-c` 参数、`repoRunsGitPrograms` 的精确性（fsmonitor 布尔不误伤、LFS 全局驱动不误伤、`[include]` 链与 `.gitattributes`↔config 交叉核对都查得出）、hook 的 `git --output=` 规则、提示词里 caller 数据只能是数据，以及一次真实 review 的命令回放（allowlist 与 deny 两侧都要放行）。

**改 `src/shell-guard.js` 的正则前必须跑 `npm test`**：那行正则的注释和模块 docstring 说明了它为什么必须包含 `|` 与 `&`（前缀匹配绕权），单看代码很容易误以为在降低误报率。

**已实测通过的回归项**（Windows / npm 全局安装 / CC Switch 本地网关，无账号登录）：manual 模式下完整 review（中文报告、按 ≥80 规则把自标 BUG 评成 CRITICAL/MAJOR、低分项正确降级到 Notes）、`scope=branch` + `baseRef`（`git log main..HEAD` / `git diff main...HEAD`，`permission_denials=0`、guard 拦下 0 条）、fix 模式落盘且**未 commit**、`.git/` 未动、followup 用返回的 `session_id` 续上同一会话。更早一轮还验证过：带恶意 `.claude/settings.json` 的仓库不再执行仓库控制的 hook、取消后 2 秒内进程树清零。

- 运行日志：`%TEMP%\cc-code-review\run-*.log`（保留 20 份；guard 临时文件与 git 沙箱 HOME 同目录，进程退出时清理，陈旧残留由下一次运行自动清扫）。
- 从 v1.5.0 及更早版本升级（旧名 claude-review-mcp）：旧日志目录 `%TEMP%\claude-review-mcp` 不会被新版本触碰或删除，如含敏感引用请手动删除。
- 卸载：删除 ZCode 配置里的 `cc-code-review` 条目；移除 skill 删 `~/.claude/skills/code-review`。

## 授权与致谢

- 本项目以 [MIT](LICENSE) 协议开源。
- 内置的 code-review skill（`assets/skills/code-review/SKILL.md`）改编自 Anthropic 官方的 code-review 插件管线（5 路并行评审 + 置信度过滤），在此基础上适配了 headless 调用与只读边界。
- 感谢 Claude Code 团队与 CC Switch / claude-code-router 等网关项目，让"无账号登录也能跑 review"成为可能。
- 安全模型经过多轮独立交叉审计（Windows / macOS / 认证网关 / 安装形态 / 回归五个视角），详见上文与 [SECURITY.md](SECURITY.md)。发现漏洞请走私有通告，不要开公开 Issue。
