# 修复报告 — cc-code-review v1.18.1

**基线**：v1.18.0（`npm test` 红：shell-guard 230/3，无 CI）
**结果**：v1.18.1（`npm test` 绿：6 套件全过，含 cross-cases 136/136）
**PR**：https://github.com/KentQi/cc-code-review/pull/1（分支 `fix/1.18.1-security-audit`，2 个 commit，未合并，待维护者审计）
**CI**：ubuntu/macos/windows × node 18/22 **6/6 全绿**（run [40835332449](https://github.com/KentQi/cc-code-review/actions/runs/40835332449)）——同时证实 P0 回归套件在 Windows/Linux 上也通过。
**上游基线事实**：1.18.0 的 main 上 CI 六个 job **全红**（macOS 3 红 / Ubuntu 2 红 / Windows 1 红），与本审计 L1/L3 的失败完全一致；`cross-cases` 的 C10 还依赖宿主机 claude（自称 stub 却没设），本次一并修掉。
**原则**：每个 P0 先复现、再修、再用**真实 hook 进程 / 真实 bash / 真实 git** 回归锁定；不改测试意图去迁就实现。

---

## 1. P0 修复状态（9/9 已修）

| 编号 | 问题 | 修复 | 回归证据 |
|---|---|---|---|
| P0-1 | tokenizer 把原始串当 argv：`$'...'`、`\-exec` 穿透全部 deny 表 → RCE/任意读写 | `src/shell-guard.js` `parseCommand` 改为产出 **bash argv 视图**；`$'`/`$"` 直接判 unsafe 并给出专属文案；反斜杠按 bash 语义去转义 | `p0-regression` 10 条 hook 进程级用例；原攻击脚本 `probe9` 全部 DENY |
| P0-2 | `-o/tmp/x`、`-f/etc/passwd` 紧贴短选项绕过 → 任意路径写 | `pathArgs` 拆解 `-xVALUE`；`sort` 增加紧贴 `-o/-T` 结构拒绝；`outrightDeny` 认紧贴短选项 | 6 条用例（含 `git ls-files -X`、`sort --random-source`） |
| P0-3 | 仓库提交的 `.gitattributes -> /dev/stdin` 同步读 → 冻结 server | `src/claude.js` 新增 `readRepoFile()`：lstat 只收普通文件、realpath 限制在所属树内、1 MiB 上限（超限计 refusal） | 实测 4s HUNG → **0ms 返回**；FIFO / 超限 / 仓外 include 各有用例 |
| P0-4 | 深度≥2 的 `.gitattributes` 不扫描 → textconv RCE | 递归扫描（depth 16 / 4000 文件），**触达上限即 fail-closed 拒绝**（不再"扫大部分"） | 深度 2 / 深度 20 / 2000 文件上限 各有用例 |
| P0-5 | 同行 section header `[diff "evil"] textconv = cmd` 不登记驱动 → RCE | `sectionsOf` 支持 header 同行首个 key；另支持点号形式 `[diff.evil]` | 同行 + 点号两种形态各 1 条；原 RCE fixture 现在 `refusals≥1` |
| P0-6 | `.GIT`/`.Git` 写入绕过（1.18.0 声称已修，实际未修） | hook 按 case-insensitive + 分隔符归一判定；`prompt.js` deny glob 补齐全部大小写形态 | 3 种拼写均 DENY；写入确认落在真实 `.git/hooks/` 的复现已失效 |
| P0-7 | fix 模式可写 `.claude/settings.json`/`.envrc`/CI workflow → 持久化执行 | hook 新增 `PROTECTED_WRITE` 列表；`prompt.js` deny glob 同步（两层） | 11 条 DENY + 5 条源码 ALLOW 对照 |
| P0-8 | `.GIT` + textconv 组合链 → 持久化 RCE | 由 P0-5/6/7 三处共同闭合；`.gitattributes` 本身也纳入 deny | 链条各环节均有独立用例 |
| P0-9 | 空报告按 `isError:false` + `status:"success"` 返回 | review **与 followup**、sync **与 async** 四条路径统一：空产出 → `isError:true` + `status:"empty_report"` + 可操作 banner + log/partial 路径；job 状态 `failed` | protocol-fixer harness 61/0（修复前 45/16） |

---

## 2. P1 修复状态（12/17 已修，5 条明确留待下轮）

| 编号 | 问题 | 状态 |
|---|---|---|
| P1-1 | 凭据明文进 review 报告（env vs settings 对比） | ✅ 前缀+长度脱敏；URL 只留 origin |
| P1-2 | `init.mjs` token 打到 stdout、配置 0644 | ✅ 输出脱敏（实测泄漏计数 0）；文件 0600、目录 0700 |
| P1-3 | guard 设置写失败静默 fail-open | ✅ 写失败 → 拒绝运行（不再"无 hook 却宣称有"） |
| P1-4 | `postToPR` 死功能（hook 拦掉唯一被授权的命令） | ✅ policy 增加 `gh pr comment`（postOnly，仅 hook 放行；权限层仍只在 `postToPR=true` 时授予） |
| P1-5 | `baseRef` 空格 → argv flag 注入 | ✅ 单 token + git 安全字符集；黑盒实测 `main --fix` 被拒 |
| P1-6 | realpath 只解析一侧 → 符号链接前缀下合法读取被误杀 | ✅ 两侧解析；原失败用例未改即转绿 |
| P1-7 | `rg --files <path>` 把路径当 pattern → 读边界失效 | ✅ `--files` 模式下位置参数全部按路径校验 |
| P1-8 | sync `waitForResult` 取消后已付费报告不可达 | ⬜ 留待下轮（需要 job 注册与 signal 生命周期重构） |
| P1-9 | 已完成的 run 被判超时、报告丢弃、后代残留 | ✅ 监听 `exit` + 立即收尸；实测 21.5s/timedOut → **136ms/ok** |
| P1-10 | `scope=pr` 不要求 `pr` → "pull request undefined" | ✅ **已在 1.18.2 修复**（预检拒绝；prompt 侧补防御性文案） |
| P1-11 | fix 模式提示词同时含 "read-only" 与 "FIX MODE" | ✅ 文案按 `fix` 分支 |
| P1-12 | `npm test` 红 + `&&` 吞套件 | ✅ 聚合 runner（6 套件、失败不中断、任一失败非零）；2 条 Windows-only 用例改平台感知；validation-test 去 `C:/` 硬编码。**更正**：审计时说的"无 CI"是本地快照缺 `.github/` 造成的假象——上游本来就有 ci.yml，本次只是把 p0-regression 加进去 |
| P1-13 | `claude_review_env`/failureBanner/gateway 警告打印完整 BASE_URL | ✅ 统一 origin-only 脱敏 |
| P1-14 | async 最终结果缺 jobId | ✅ additive 补上 |
| P1-15 | 默认 async 与 `instructions` 不一致 | ⬜ 留待下轮（协议层语义调整） |
| P1-16 | 同 repo/session 无并发锁 | ⬜ 留待下轮 |
| P1-17 | 4 个 headline 能力无回归保护 | ✅ cross-cases（含 429 抢救/增量报告/取消/异步 job）已纳入默认 `npm test` |

---

## 3. 新增的回归防线

- `scripts/p0-regression-test.mjs`（**68 条**）：全部 P0 形态，**每条 Bash/Write 用例都 spawn 真实 hook 进程**（不是 mock analyseCommand），另含 4 条 `repoRunsGitPrograms` 的 RCE fixture 与 1 条"符号链接不得阻塞扫描器"的子进程超时断言。
- `scripts/run-tests.mjs`：6 套件统一汇总；**缺失必需套件=FAIL**（防止删文件变绿），单个失败不中断后续。
- `.github/workflows/ci.yml`：ubuntu/macos/windows × node 20/22/24；`npm ci && npm test`。
- 计数：shell-guard **235**、audit-fixes **272**、p0-regression **68**、validation **16**、cross-cases **136/136**、smoke PASS。

---

## 4. 改动文件清单

| 文件 | 性质 |
|---|---|
| `src/shell-guard.js` | tokenizer argv 视图、ANSI-C 拒绝、紧贴短选项、realpath 双侧、rg --files、sort 结构拒绝、postOnly 策略、提示文案 |
| `src/claude.js` | `readRepoFile`、递归 attributes、同行/点号 section、扫描截断 fail-closed、`exit` 事件与收尸 |
| `src/index.js` | 空报告四条路径、凭据/URL 脱敏、baseRef 校验、guard 写失败拒绝、job 状态 failed、jobId |
| `src/prompt.js` | 持久化路径 deny glob、fix 模式文案 |
| `scripts/pre-tool-hook.js` | `.GIT` 大小写归一、`PROTECTED_WRITE` |
| `scripts/init.mjs` | token/URL 脱敏、0600/0700 |
| `scripts/p0-regression-test.mjs` | **新增** P0 回归套件 |
| `scripts/run-tests.mjs` | **新增** 聚合 runner |
| `scripts/shell-guard-test.mjs` / `scripts/validation-test.mjs` | 平台可移植性、弱断言修正 |
| `.github/workflows/ci.yml` | **新增** CI |
| `package.json` / `src/version.js` / `CHANGELOG.md` / `README.md` / `CONTRIBUTING.md` / `assets/skills/code-review/SKILL.md` | 1.18.1 版本、测试门禁与文档同步 |

---

## 5. 未修项与残余风险（诚实清单）

**P1 留待下轮（1.18.2 之后的实际状态）**：
- **P1-8**（sync 取消丢报告）：仍开放。结构性问题——客户端已取消时响应被 SDK 丢弃，而 sync 路径不建 job，无路可取回。
- **P1-15**（instructions 与 async 不一致）：仍开放。`src/index.js:628-632` 的 instructions 仍描述同步流程，而默认已是 async 返回 jobId。
- **P1-16**（无并发锁）：仍开放。同一仓库并发两个 fix 模式评审会互相覆盖工作区。

**已在 1.18.2 修复**：P1-10（scope=pr 缺 pr，预检拒绝）。

**P2/P3 未动**：审计报告的 ~45 条 P2 与 ~45 条 P3 基本保持原状，其中建议优先处理：
1. `repoRunsGitPrograms` 仍以"驱动被 attributes 引用才拒绝"为策略——虽然扫描截断已 fail-closed，但更稳的做法是 `[diff|filter]` 段的命令行一律拒绝，或改用 `git config --list -z` / `git check-attr`（见 audit/03-runtime.md R-2/R-3 建议）。
2. Windows 上"父进程已退出 + 后代持 pipe"目前会等 deadline 才 settle（报告不丢，只是延迟）；建议补 post-exit grace 或 Job Object。
3. `scripts/init.mjs` 的 gateway 探测仍会在不可达时打印原因（已脱敏 URL，但错误文本可能含主机信息，属可接受）。
4. 递归 `.gitattributes` 扫描是同步的（普通仓 20–130ms，超大 monorepo 可能到秒级），长期应改异步/缓存。

**验证边界**：本机为 macOS，Windows/Linux 分支与 GitHub hosted runner 均未真实验证；CI 的 `npm test` 用 `CLAUDE_CODE_PATH=scripts/stub-claude.mjs`，只验证 stdio/工具面/env 形状，真实 CLI 行为由本机 `npm test` 覆盖。付费套件（paid-smoke/cross-cases 的 C9/e2e/followup-e2e/cancel-test）全程未运行。
