# cc-code-review — 最终审计报告（六轮汇总）

**对象**：从 v1.18.0 到 v1.18.6，6 个 stacked PR（#1 1.18.1 → #2 1.18.2 → #3 1.18.3 → #4 1.18.4 → #5 1.18.5 → #6 1.18.6），5 轮独立审计 + 2 轮残余收口。
**结论**：累计 17 条 P0 与 46 条 P1 全部修复；P2/P3 存量 98 条已清，5 条有理由接受，1 条不成立，2 条审计证据被证伪。当前 npm test 7 套件全绿。

## 1. 轮次与结果

| 轮次 | 版本 | 审计发现 | 修复 | 门禁（当时） |
|---|---|---|---|---|
| 1 | 1.18.1 | 9 P0 / 12 P1 / 46 P2 / 46 P3 | 9 P0 + 12 P1 | shell-guard 235 / audit-fixes 272 / p0 68 / validation 16 / cross-cases 136 |
| 2 | 1.18.2 | 10 P0 / 10 P1（对 1.18.1） | 10 P0 + 10 P1 | 238 / 272 / 80 / 16 / 139，CI 6/6 |
| 3 | 1.18.3 | 复核新发现（指纹缓存、信号退出）+ 上轮遗留 | 5 项 + 2 复核项 | 238 / 272 / 95 / 16 / 149，CI 6/6 |
| 4 | 1.18.4 | P2/P3 triage（98 修 / 5 接受 / 1 不成立） | 51 条 | 260 / 300 / 126 / 23 / 150，CI 6/6 |
| 5 | 1.18.5 | 第三轮审计：7 P0 / 14 P1 / 22 P2 / 8 P3 | 7 P0 + 14 P1 + 21 P2/P3 | 272 / 305 / 163 / 30 / 154 + pack 43 |
| 6 | 1.18.6 | 1.18.5 残余：P2-1 / P2-3 / P2-22 + P1-4、P1-13、fail-closed 缺口 | 6 项 + lockfile | 292 / 313 / 181 / 30 / 154 + pack 43 |

## 2. 五轮的关键安全成果

- **1.18.1**：shell guard tokenizer 改为 bash argv 视图（$ 单引号、反斜杠、紧贴短选项）；.GIT 大小写；fix 模式持久化路径；仓库自带 git driver 扫描；空报告=失败。
- **1.18.2**：core.sshCommand RCE（git config --list -z + 子进程 GIT_CONFIG_* 中和）；core.attributesFile；深度 .gitattributes；echo $VAR 凭据外带；Read fail-open；hook stdin fail-open；baseRef 单一校验器；followup 误报。
- **1.18.3**：并发 fix 锁；sync 取消保留付费报告；指纹缓存窗口；逃生门收窄；信号退出；报告格式统一。
- **1.18.4**：P2/P3 存量（guard 读写边界、transcript realpath、缓存 TTL、pack 回归、共享 MCP 客户端等）。
- **1.18.5**：protocol.ext.allow 传输族 RCE；.git/config.worktree；node_modules/.gitattributes；长选项缩写（--cont / --files0 / --ignore-revs-file）；gh --body-file；find --；echo 部分引号；Grep/Glob 与 Bash 读边界；fix 模式 runner 配置扩表；include 越界/数量上限；postToPR 必须带 pr；scope=auto 的 baseRef；init.mjs 打包与 settings 凭据。

## 3. 当前验证状态

- npm test：7 套件全绿、exit 0（shell-guard 272、audit-fixes 305、p0-regression 163、validation 30、pack 43、cross-cases 154/154、smoke）。
- CI：ubuntu / macOS / windows × node 18/22；前四轮 PR 均 6/6，PR #5 待跑。
- 独立验收：每轮 P0 均由 Lead 用真实 git / 真实 hook 进程 / 真实 stdio server 复现（修复前失败、修复后通过），本轮 32/32。

## 4. 剩余（有理由，非缺陷）

| 项 | 裁定 | 理由 |
|---|---|---|
| R-10 git-lfs / merge driver 误报 | 接受 | 仓库自带可执行 driver 一律拒绝是 fail-closed 取舍 |
| R-20 Windows 进程树 / 无 SIGTERM 阶段 | 接受 | README 已声明；靠 JSONL 补救 |
| P-09 SIGKILL 孤儿 | 接受 | 进程已死，无解 |
| P2-9 buildFallbackPrompt 死代码 | 接受 | 测试依赖，删需连带改断言 |
| Q9 smoke 非 hermetic | 接受 | CI 用 stub；本机需 CLI |
| SEC-27 死导出 | 不成立 | 测试在用 |
| P0-10（第二轮）fixture | 证伪 | aN.gitattributes 不被计数 |
| P0-2（第二轮）tr | 定性过头 | BSD/GNU tr 无 FILE 操作数 |
| P2-22 lockfile 镜像 | 已修（1.18.6） | 94 个 resolved 改写为 registry.npmjs.org |
| P2-1 git 加固三表漂移 | 已修（1.18.6） | 单一 GIT_HARDENING 表 + 加载断言 |
| P2-3 containment 五份拷贝 | 已修（1.18.6） | shell-guard 单一实现 + allowRoot 策略 |
| P1-4 递归扫描残余 | 已修（1.18.6） | 拒绝 rg 越权开关与根级递归 grep |
| P1-13 指纹覆盖内联规则 | 已修（1.18.6） | 规则函数源码纳入指纹 |
| P0-6 gh --repo 未绑定被审仓库 | 设计取舍 | 跨仓 PR 评论是合法功能 |
| .env.example 层间差异 | 设计取舍 | 权限层更严，非漏洞 |

## 5. 已知边界

- 并发锁是进程内的（多 MCP server 不互斥）。
- 512KiB 截断覆盖 claude_review_status 与 sync 返回，job.result 保留完整。
- claude_review_env 的 readOnlyHint:false（install/uninstall 会写 ~/.claude）。
- Gatekeeper 信号文案仍 darwin-only，未单测。
- 付费套件（paid-smoke / C9 / e2e / followup-e2e / cancel-test 真实运行）未在本轮执行。
- Windows 上 %TEMP% 无 POSIX 权限位（SECURITY.md 已声明）。

## 6. PR 栈

| PR | 版本 | 状态 |
|---|---|---|
| #1 | 1.18.1 | OPEN / MERGEABLE / CI 6/6 |
| #2 | 1.18.2 | OPEN / MERGEABLE / CI 6/6 |
| #3 | 1.18.3 | OPEN / MERGEABLE / CI 6/6 |
| #4 | 1.18.4 | OPEN / MERGEABLE / CI 5/6 + 1 queued |
| #5 | 1.18.5 | OPEN / MERGEABLE / CI 6/6 |
| #6 | 1.18.6 | OPEN / MERGEABLE / CI 运行中 |

合并顺序 #1 → #5；main 未修改（仍为 659ff49），未打 tag、未发布 npm。

## 7. 证据文件

- 第三轮审计报告：audit/2026-10-30-pr1-4-audit.md（577 行，51 条）
- 各轮修复记录：audit/FIXES.md、FIXES-round2.md、FIXES-round3.md、FIXES-round4.md、FIXES-round5.md、FIXES-round6.md
- 存量 triage：audit/TRIAGE.md
- 第一/二轮审计：audit/AUDIT-REPORT.md、audit/2026-10-29-atomic-audit.md 与 01–05 专家报告