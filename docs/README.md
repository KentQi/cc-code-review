---
title: cc-code-review 文档索引
version: v1.18.7
created: 2026-10-30
status: final
---

# 文档索引

本仓库文档统一在 `/docs/`，按阶段分目录。当前只有 `04-test/`（审计与测试证据），其余阶段目录按需创建。

## 命名偏离说明

规则 §四.2 的形态是 `NN-类型-主题-vX.Y.md`（两段版本号），本目录使用 `vX.Y.Z`（三段）。这是**有意的**：semver 的补丁位表达不了两段式，而这些文档必须能区分 1.18.6 与 1.18.7 的修复证据。R3 的宽松模式（frontmatter 含 title + status）已满足。

## 04-test/ — 审计与测试证据

| # | 文档 | 内容 |
|---|---|---|
| 01 | [01-audit-cc-code-review-v1.18.0.md](04-test/01-audit-cc-code-review-v1.18.0.md) | 首轮五专家审计汇总（9 P0 / 12 P1 / 46 P2 / 46 P3） |
| 02–06 | [02-security](04-test/02-audit-security-v1.18.0.md) · [03-protocol](04-test/03-audit-protocol-v1.18.0.md) · [04-runtime](04-test/04-audit-runtime-v1.18.0.md) · [05-prompt](04-test/05-audit-prompt-v1.18.0.md) · [06-quality](04-test/06-audit-quality-v1.18.0.md) | 首轮各视角专家报告 |
| 07 | [07-audit-lead-empirical-v1.18.0.md](04-test/07-audit-lead-empirical-v1.18.0.md) | Lead 实证记录（首轮） |
| 08 | [08-audit-atomic-v1.18.2.md](04-test/08-audit-atomic-v1.18.2.md) | 第二轮原子级审计（10 P0 / 10 P1） |
| 09 | [09-audit-pr1-4-v1.18.4.md](04-test/09-audit-pr1-4-v1.18.4.md) | 第三轮：PR #1–#4 审计 + 复核记录 |
| 10 | [10-audit-pr5-6-v1.18.6.md](04-test/10-audit-pr5-6-v1.18.6.md) | 第四轮：PR #5/#6 最终审计（1 P1 / 6 P2 / 5 P3） |
| 11–17 | [11-fix-round1](04-test/11-fix-round1-v1.18.1.md) … [17-fix-round7](04-test/17-fix-round7-v1.18.7.md) | 七轮修复报告（逐条修复 + before/after 证据） |
| 18 | [18-triage-p2-p3-v1.18.4.md](04-test/18-triage-p2-p3-v1.18.4.md) | P2/P3 存量 triage（98 修 / 5 接受 / 1 不成立） |
| 19 | [19-audit-final-v1.18.7.md](04-test/19-audit-final-v1.18.7.md) | 最终审计报告（七轮汇总 + 残余） |

## 旧路径映射（`audit/` → `docs/04-test/`）

历史报告与 PR 正文里出现的 `audit/<name>.md` 指向下表的新位置；`audit/README.md` 是指针。

| 旧路径 | 新路径 |
|---|---|
| `audit/AUDIT-REPORT.md` | `docs/04-test/01-audit-cc-code-review-v1.18.0.md` |
| `audit/01-security.md` … `audit/05-quality.md` | `docs/04-test/02-…` … `06-…` |
| `audit/00-lead-empirical.md` | `docs/04-test/07-audit-lead-empirical-v1.18.0.md` |
| `audit/2026-10-29-atomic-audit.md` | `docs/04-test/08-audit-atomic-v1.18.2.md` |
| `audit/2026-10-30-pr1-4-audit.md` | `docs/04-test/09-audit-pr1-4-v1.18.4.md` |
| `audit/2026-10-30-pr5-6-final-audit.md` | `docs/04-test/10-audit-pr5-6-v1.18.6.md` |
| `audit/FIXES.md` | `docs/04-test/11-fix-round1-v1.18.1.md` |
| `audit/FIXES-round2.md` … `FIXES-round7.md` | `docs/04-test/12-…` … `17-…` |
| `audit/TRIAGE.md` | `docs/04-test/18-triage-p2-p3-v1.18.4.md` |
| `audit/FINAL-AUDIT-REPORT.md` | `docs/04-test/19-audit-final-v1.18.7.md` |
