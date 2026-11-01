---
title: 修复报告（第九轮）— codeDrift 时间断言与文档一致性
version: v1.18.9
created: 2026-11-01
status: final
---

# 修复报告（第九轮）— v1.18.9

本版**无功能变更**：只修一条依赖 checkout 年龄的测试断言，并把 1.18.8 之后的文档 / 版本 / 标签状态收敛一致。

## 问题：codeDrift 断言依赖 checkout 年龄

`scripts/audit-fixes-test.mjs` 用墙钟偏移断言「进程比源码旧」：

```js
codeDrift(now - 86_400_000).stale === true
```

该断言只在 checkout 的源文件比「一天前」更新时成立。源文件最后修改于 2026-10-30 的工作区，到 2026-11-01 时 `now - 1 天` 已晚于所有源文件 mtime，`codeDrift()` 正确返回 `stale: false`，套件却报红（317/318）。CI 每次 fresh checkout 会给文件打当前 mtime，所以从未暴露。

## 修复：注入 epoch 时钟

`codeDrift(0)`：模拟的进程启动时间早于任何可信的源文件 mtime，断言语义不变（进程比源码旧 ⇒ stale），且与 checkout 年龄无关。仅 1 个断言 + 1 条注释，无生产代码改动。

## 文档与发布线一致性

- `docs/README.md`：补上缺失的第 20 篇（第八轮报告）条目；frontmatter 版本从 v1.18.7 更新为 v1.18.9；新增本篇（21）条目。
- `CHANGELOG.md`：新增 1.18.9 条目，记录本版内容与「无功能变更」。
- README.md / README.en.md / CONTRIBUTING.md：套件计数刷新为实际值（shell-guard 327、audit-fixes 318、p0-regression 256、validation 31、pack 52、cross-cases 156/156；cross-cases 共 27 个用例、默认免费跑 26 个，C9 付费）。
- `v1.18.8` 标签保持不动（仍指发布提交 `7cbbfca`）；`v1.18.9` 标记本次 docs/test-only 发布，使 `main` 与最新 tag 对齐。

## 验证

- 各套件实测：shell-guard 327、audit-fixes 318、p0-regression 256、validation 31、pack 52、cross-cases 156/156、smoke PASS。
- `npm test` → 7/7 passed, 0 failed。
- 版本一致性由 `pack-test.mjs` 断言（package.json ↔ package-lock.json ↔ 打包后 serverInfo）。
- 测试修复经 PR #9 合入：CI 18/18 success（Node 20/22/24 × ubuntu/macos/windows）；合并后 main CI 成功。
