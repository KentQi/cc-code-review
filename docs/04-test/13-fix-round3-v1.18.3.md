---
title: 修复报告（第三轮）
version: v1.18.3
created: 2026-10-29
status: final
---

# 修复报告（第三轮）— v1.18.3

**基线**：v1.18.2（两轮审计的 P0/P1 已清，剩余项见 `FIXES-round2.md` §残余）
**结果**：v1.18.3（`npm test` 绿：shell-guard 238 / audit-fixes 272 / p0-regression 95 / validation 16 / cross-cases 149 / smoke）
**PR**：[#3](https://github.com/KentQi/cc-code-review/pull/3)（stacked on [#2](https://github.com/KentQi/cc-code-review/pull/2)）
**CI**：ubuntu/macos/windows × node 18/22 **6/6 全绿**（run [40877684013](https://github.com/KentQi/cc-code-review/actions/runs/40877684013)）
**方式**：4 个 subagent 并行（index.js / claude.js / prompt.js+SKILL.md / scripts），Lead 做文档、集成与独立验收。

---

## 本轮修复

| 项 | 问题 | 修复 | 验收 |
|---|---|---|---|
| P1-16 | 同一仓库并发 fix 评审互相覆盖工作区 | 模块级 `activeFixRepos`（按 resolve 后的 repoPath），输入校验后、任何 await 前加锁；settle / sync finally / handler finally 三处释放；只读评审不受限 | Lead 探针：第二个并发 fix 请求 isError + "already running" ✅ |
| P1-8 | sync `waitForResult` 取消后已付费报告不可达 | review 与 followup 都**先建 job 再分支**；sync 取消后 job 仍可 `claude_review_status`（无参列表按仓库定位）取回 | Lead 探针：sync 评审后 job 列表可见 ✅ |
| P2-14 | 指纹比对被 5 分钟 TTL 缓存，升级后窗口内不拒绝 | `guardSelfTest(codeDrift().stale ? { refresh: true } : {})` | subagent 用整包副本 + 篡改 hook 实测：修复前放行、修复后拒绝 ✅ |
| SEC-14 | `ALLOW_UNGUARDED=1` 对 guard 安装失败也生效 | 只对显式关闭（`SHELL_GUARD=0`）生效；failed 永远拒绝并给出修法 | subagent 自测 D1-D5（failed+env 拒绝 / off+env 放行 / off 无 env 拒绝）✅ |
| P2-4 | 大结果无上限 | `claude_review_status` 对 text 与 SC.report 做 512KiB UTF-8 安全截断 + 指针 + `truncated:true`；job.result 不变（重复 poll 不叠加） | subagent 700KB 报告实测 <600KB、幂等 ✅ |
| P2-1 | 两套报告格式并存 | 以随包 SKILL.md 为唯一事实源重写 `REPORT_FORMAT`；native appendix / fallback 复用；fleet 只带一份；补 no-findings 分支 | Lead 探针：4 条输出路径 + SKILL.md 一致 ✅ |
| P2-5 | `cancel-test` 仅 Windows 可用 | POSIX 用 `ps -axo pid=,command=` 匹配解析到的 CLI 路径；win32 保留 tasklist | subagent：修复前 FAILED(started=false) → 修复后 PASSED ✅ |
| P2-7 | 信号/非零退出但有 result 时仍报 success | `run.signal` 暴露；review/followup 均识别 abnormal exit → `isError:true` + `status:"completed_with_error"` + 保留报告 + banner 说明信号/退出码 | D 的 C23 + Lead 独立复核 ✅ |
| scanner | `pager.<cmd>` / `core.askPass` / `sequence.editor` 未覆盖；UNC 值可能卡 21s | 三个键纳入（live → refusal，dead → note，pager 布尔放行）；UNC 在任何 fs 探测前 refusal | Lead 探针：三键 live→refusal、dead→note、UNC<1.5s ✅ |

## 新增回归

- `scripts/p0-regression-test.mjs` 95 条（原 95，含策略指纹接线与 guard 目录符号链接加固）
- `scripts/cross-cases.mjs` **139 → 149**：C23 信号退出、C24–C26 并发锁 / sync job / 相关生命周期
- `scripts/audit-fixes-test.mjs` 的报告契约断言改为 canonical 标题（`## Code Review Summary` + `## Findings (N)`）

## 独立验收（Lead，不采信 subagent 结论）

`/tmp/verify-round3.mjs` **19/19**：扫描器三键（live/dead/UNC）、四条输出路径的报告格式、sync 评审注册 job、并发 fix 被拒。

## 仍未完成（诚实清单）

- **P2-9** `buildFallbackPrompt` 死代码 + `index.js` 未使用 import：故意保留（audit-fixes 在测它）。
- **锁的作用域**：进程内 Set；多 MCP server/跨进程不互斥（同 async job 注册表）。
- **P2-4 覆盖范围**：只截断 `claude_review_status` 的 text/SC.report；sync 直返与 followup 的 `SC.reply` 未截断。
- **scanner 残余**：`core.editor` 未拒；`pager.<cmd>` 无法被单个 `-c core.pager=cat` 压过、`sequence.editor` 未进 `GIT_CONFIG_*` 覆盖；`repoPath` 本身位于 UNC share 时的其它同步探测未改。
- **P2-7 信号路径**：已由 C23 覆盖；Gatekeeper 专属文案仍是 darwin-only、未单独断言。
- 两轮审计的 ~80 条 P2/P3 仍未逐条处理（清单见 `01`–`05` 与 `2026-10-29-atomic-audit.md §4`）。

## 复核反馈的落实

- 审计复核指出 `FIXES-round2.md` 的 "`echo "[1] done"` 会被拒" **不成立**——已删除并注明实测结果（加引号全部放行，仅未加引号被拒）。
- 审计复核发现的 **P2-14**（指纹缓存 5 分钟窗口）已修，并进入本轮 CHANGELOG。
- 审计复核确认 sed 死代码已删干净（仅剩注释）——上一轮报告中的该条已更正。
