---
title: 修复报告（第八轮）— 1.18.7 的 R-2 范围回归
version: v1.18.8
created: 2026-10-30
status: final
---

# 修复报告（第八轮）— v1.18.8

**问题**：1.18.7 为关闭 R-2 加入了 `^src\/[^/]+\.js$` 与 glob `**/src/*.js`，但保护是按**路径形状**而不是**身份**划的。hook 与服务端始终从**包安装目录**加载（`src/claude.js` 的 `SRC_DIR`/`HOOK_SCRIPT`），被审仓库里的同名文件根本不会被读取——因此普通仓库的 `src/app.js` 被误拒，而 fix mode 的全部意义就是编辑被审仓库的文件。

**修复**：

- `src/shell-guard.js` 新增 `isSelfReview(repoRoot)`（比较包根与被审仓库根的**文件系统身份** dev+ino），管线规则拆到 `SELF_REVIEW_PIPELINE`，`PROTECTED_WRITE` 只保留与仓库无关的类别（CI/hook 配置、密钥、`.git`）。
  - 后续加固（同一轮内）：最初实现比较 realpath 字符串，但同一棵树的 bind mount / 备用挂载路径会被判成外部仓库，从那条路径写入仍可卸防；改为 `statSync` 的 dev+ino 后覆盖该场景。同时拒绝空/相对 root（`path.resolve("")` 会按 cwd 解析，若服务端从包根启动会误判自审）。
- hook 仅在 `isSelfReview(CLAUDE_REVIEW_REPO_ROOT)` 时追加 `SELF_REVIEW_PIPELINE`；自审时若表缺失则 fail-closed。
- 权限层同步：`FIX_SELF_REVIEW_GLOBS` 单独导出，`fixDisallowedTools({ selfReview })` 决定是否渲染；`src/index.js` 传入 `isSelfReview(repoPath)`。
- 指纹覆盖两张表（策略身份包含"自审时哪些文件不可写"）。

**验证**：

- 独立探针 14/14：普通仓库 `src/app.js`/`src/index.js`/`scripts/pre-tool-hook.js`/`assets/skills/x.md` 全部 ALLOW，`.env`/`.husky` 仍 DENY；自审时 `src/index.js`/`src/claude.js`/`scripts/pre-tool-hook.js`/`scripts/lib/**`/`assets/skills/**` 全部 DENY，`src/features/new.js` ALLOW；glob 层 generic 不含 `src/*.js`、self-review 含。
- 套件：shell-guard 327（+7：isSelfReview / 表分离 / 空与相对 root / 指向包根的符号链接）、audit-fixes 318、p0-regression 256（+18：foreign ALLOW + self-review DENY + 跨层双 scope）、validation 31、pack 52、cross-cases 156/156、smoke PASS。
- `npm test` 7/7（本机 + 克隆）。
