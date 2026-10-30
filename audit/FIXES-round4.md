---
title: 修复报告（第四轮）
version: v1.18.4
created: 2026-10-30
status: final
---

# 修复报告（第四轮）— v1.18.4

**基线**：v1.18.3（`audit/TRIAGE.md` 里 13 条 🟢 + 37 条 🟡 + 1 条部分）
**结果**：v1.18.4（`npm test` 7 套件全绿）
**PR**：[#4](https://github.com/KentQi/cc-code-review/pull/4)（stacked on [#3](https://github.com/KentQi/cc-code-review/pull/3)）
**CI**：ubuntu/macos/windows × node 18/22 —— 5/6 已通过（含两个 Windows job，修复了 init.mjs 0600 断言的 NTFS 平台差异），最后一个 macOS-22 在 GitHub runner 队列中
**方式**：5 个 subagent 并行（claude.js / shell-guard+hook / index.js / prompt.js+skill.js / scripts+package），Lead 做跨文件补丁、文档、集成与独立验收。

---

## 修了什么（TRIAGE 的 51 条）

| 域 | 条目 | 关键点 |
|---|---|---|
| claude.js（13） | SEC-09、R-7、R-8、R-9、R-11、R-12、R-13、R-14、R-15、R-16、R-17、R-19、R-21 | loopback 归一化；transcript realpath（macOS 恢复生效）；npm/version 缓存 TTL；删死代码与内存泄漏；pretty-printed JSON；ack 判定收紧；信号退出码 143/130/129 |
| guard+hook（5） | P2-11、SEC-15、SEC-23、SEC-24、SEC-25 | `git branch -u<ref>` 拒绝；自审 guard 文件写保护；review 读密钥文件拒绝（模板放行）；非字符串 command 拒绝；NotebookEdit 的 notebook_path |
| index.js（15） | P2-7、P3-1、P3-3、P-03、P-05、P-06、P-11、P-12、P-13、P-14、P-16、P-17、P-18、P-19、P-20 | focus 单行；outputLanguage ≤20 无句末标点；PR 前导 `-`；job 三字段统一；20s 预检软预算；settled CLI 探测；cancel 无 jobId 报错；SDK onclose 先跑；title/annotations + registerTool；retention 文案；100k 消息上限；TOCTOU；jobId 文案；env isError 契约；32MB 结果预算 |
| prompt+skill（12） | P2-2、P2-3、P2-8、P2-9、P2-10、P2-12、P2-13、P3-2、P3-4、P3-7、P3-9、P3-10 | 5 briefs + 3/5 拆分；CONFIRMED/PLAUSIBLE 分数映射；刷新失败降级 fleet；skill 所有权语义与 uninstall 只删自己的文件；诊断文案；auto 顺序；候选上限 20 + inline 收敛；不回显被拒输入；followup 诚实文案；xhigh 语义；死导出；原子安装 |
| scripts/package（6） | SEC-16、Q7、Q18、Q15、Q20、Q12 之外 | init 原子写；自证式断言改调产品函数；5 组弱断言补强；pack-test（38 checks）+ files 收窄（30 files/789KB → 15/551KB）；共享 MCP 客户端迁移 4 套 |

**跨文件补丁（Lead 直接打）**：index.js 缺 `uninstallBundledSkill` import（`uninstallSkill=true` 必崩，测试从未覆盖）；P2-8 else 分支；P2-10 两处文案；reviewLevel/pipeline schema 文案；uninstall 文案；prompt.js 的 SEC-15 deny globs；claude.js 与 skill.js 的 `claudeConfigDir` 去重；SKILL.md 的 4 段 patch；README 的中英双语数字/语义同步；stdin EOF → transport.onclose（C 发现的断连不杀缺口）。

## 验证

- `npm test` **exit 0**：shell-guard 260、audit-fixes 300、p0-regression 126、validation 23、pack 38、cross-cases 150/150、smoke PASS（7 套件）。
- 独立验收：`/tmp/verify-round4.mjs`（Lead 自己写，不采信 subagent 结论）覆盖 guard 5 项、loopback、focus/language/pr/cancel/100k、title/annotations、env isError。
- 每个 subagent 另有 before/after 自测：`/tmp/v1184/`（claude.js 33 FAIL→0）、`/tmp/ccr-1184/verify.mjs`（14/47→47/47）、`/tmp/cc-review-fix-selftest.mjs`（11/25→28/28）、`/tmp/cc-p2p3-selftest.mjs`（23 FAIL→58/58）、`/tmp/sec16-test.mjs`、`/tmp/q18-mutation.mjs` 等。

## 行为变化（需在 CHANGELOG 告知用户）

1. `focus` 必须单行；`outputLanguage` ≤20 字且禁句末标点；`followup` 消息 ≤100000 字。
2. async 首包有 20s 预检软预算（超时降级并告警）；`waitForResult=true` 不受影响。
3. 结果被 32MB 预算淘汰后轮询返回 `isError` + `status:"evicted"`；JOB_KEEP=10 不变。
4. 信号退出码改为 143/130/129。
5. 策略表变化 → 未重启的 MCP host 会触发 stale-policy 拒绝，需重启。
6. `files` 收窄：发布包不再包含测试脚本（`npm test`/`npm run init` 仅限源码 checkout）。

## 仍未完成（1.18.4 之后）

- ⚪ 接受不修：R-10（git-lfs/merge.driver 显式拒绝是取舍）、R-20（Windows 进程树限制）、P-09（SIGKILL 孤儿）、P2-9（buildFallbackPrompt 死代码，测试依赖）、Q9（smoke 非 hermetic）。
- ❌ 不成立：SEC-27（死导出有测试在用）。
- 已知边界：并发锁是进程内的；512KiB 截断只覆盖 status；`env` 的 readOnlyHint 在 installSkill=true 时语义不精确；Gatekeeper 信号文案仍 darwin-only 未单测。
- 付费套件（paid-smoke / C9 / e2e / followup-e2e / cancel-test 真实运行）未跑。
