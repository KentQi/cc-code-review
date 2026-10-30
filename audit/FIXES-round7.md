---
title: 修复报告（第七轮）— 复核 4 项 + PR #5/#6 审计 12 项
version: v1.18.7
created: 2026-10-30
status: final
---

# 修复报告（第七轮）— v1.18.7

**基线**：v1.18.6（复核记录二：R-1/R-2/R-3/N-1；PR #5/#6 最终审计：1 P1 / 6 P2 / 5 P3）
**PR**：[#7](https://github.com/KentQi/cc-code-review/pull/7)（stacked on [#6](https://github.com/KentQi/cc-code-review/pull/6)）
**CI**：ubuntu/macos/windows × node 20/22/24 **18/18 全绿**（两个 workflow run：push + pull_request）
**结果**：v1.18.7（`npm test` 7 套件全绿：shell-guard 320 / audit-fixes 318 / p0-regression 238 / validation 30 / pack 52 / cross-cases 154 / smoke）

## 复核的 4 项

| # | 问题 | 修复 | 验收 |
|---|---|---|---|
| R-1 | `find -D` / `-O` 被当成带值选项，跳过的 token 正是搜索路径 → `find -D /etc`、`find -O /etc` 枚举宿主目录 | 只吞 debugopts（字母/逗号）或 level（数字）值，其它 token 走路径校验 | shell-guard 断言 6 DENY + 4 ALLOW |
| R-2 | `PROTECTED_WRITE` 只保护 hook 与 shell-guard；改 `src/index.js`/`src/claude.js`/`src/prompt.js`/`src/skill.js` 同样能卸防 | 保护整条 guard/spawn 管线：`src/*.js`、hook、`scripts/init.mjs`、`scripts/lib/**`、`assets/skills/**`；普通源码与 docs 仍可写 | p0 8 条 DENY + 3 条 ALLOW；跨层一致性断言 |
| R-3 | engines `>=18.19` vs CI 矩阵 `[20,22,24]` vs README 徽章不一致 | 统一为 Node ≥20：engines、CI 矩阵（提交 `.github/workflows/ci.yml`）、两份 README 徽章；pack-test 断言三者一致 | pack-test 4 条 R-3 断言 |
| N-1 | hook 对无法解析/无 tool_name 的 payload fail-open（`exit(0)`） | 解析失败/空 stdin/非对象/缺 tool_name → DENY；解析成功但非 hook 负责的工具仍放行（由 allowlist 管） | shell-guard 9 条 payload 断言 |

## PR #5/#6 审计的 12 项

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| P1 | P1 | `find --files0-from` / `--files0` 双横线拼写绕过 deny 表（单横线表项不走缩写匹配） | 表项同时列 `-files0-from` 与 `--files0-from`；`denyReasonIn()` 对单横线长名匹配两种拼写 + 缩写 |
| P2-1 | P2 | 「ONE table」声明失真：hook 从未 import prompt 的 glob 表，且三份清单已漂移 | 注释改为如实描述两层；补 `.pre-commit-config.yml`；新增 21 条路径的跨层一致性断言（hook DENY ⇒ 权限 glob 覆盖） |
| P2-3.1 | P2 | `tilde` 数组可由 `unquoted` 推导 | 删除第三条平行数组与参数，改用 `unquoted.startsWith("~")` |
| P2-3.2 | P2 | `ensureOwnedPrivateDir()` 是新增副本，`writeGuardSettings` 仍保留内联实现 | 内联块删除，改调 helper |
| P2-3.3 | P2 | `GIT_HARDENING` 的 `env`/`args` 永远相同 | 合并为单个 `harden` 字段；加载期断言改为 `scan ⇒ harden`；env/args 视图仍逐字节相等 |
| P2-3.4 | P2 | `launchAckBody()` 复制 `looksLikeLaunchAck()` 的整段形状检查 | 抽出共享 `ackShape()` |
| P2-3.5 | P2 | hook 每次调用做两次包含性判定（`repoRelative` + `isInsideRepo` 重算同一 rel） | 单次 `repoRelative` + `insideFromRel()` 谓词 |
| P3-6.1 | P3 | `GIT_HARDENING` 是死导出 | audit-fixes 直接 import 并断言三视图一致（4 条） |
| P3-6.2 | P3 | `reportContractSource()` 是死导出 | 契约降级时在 run warnings 里显式告警 |
| P3-6.3 | P3 | README 测试计数过期（238/95） | 更新为 320 / 238 / 318 |
| P3-6.4 | P3 | README.en.md 缺 1.18.5/1.18.6 安全边界 | 补英文 1.18.5 / 1.18.6 / 1.18.7 三节 |
| P3-6.5 | P3 | README 说 baseRef 非法字符「会被忽略」，代码是硬拒 | 文案改为「评审前拒绝」 |
| P3-6.6 | P3 | 5 份新审计文档缺 frontmatter | 补齐 YAML frontmatter（title/version/created/status） |
| P3-6.7 | P3 | `.env.example` 在权限层与 hook 层不一致且未文档化 | 代码注释说明这是有意的 over-block，并由 p0 断言锁定 |

## 验证

- 独立探针（Lead）：find 两种拼写 / -D/-O 矩阵、R-2 保护矩阵、N-1 9 种 payload、跨层 21 路径、engines/矩阵/徽章一致性。
- `npm test` 7/7、exit 0（本机 + 克隆各一次）。
- CI：三平台 × node 20/22/24（矩阵与 engines 对齐）。