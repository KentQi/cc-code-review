# 修复报告（第二轮）— v1.18.2

**基线**：v1.18.1（`npm test` 绿但审计发现 10 P0 / 10 P1）
**结果**：v1.18.2（`npm test` 绿：shell-guard 238 / audit-fixes 272 / p0-regression 80 / validation 16 / cross-cases 139 / smoke）
**PR**：[#2](https://github.com/KentQi/cc-code-review/pull/2)（stacked on [#1](https://github.com/KentQi/cc-code-review/pull/1)，未合并）
**CI**：ubuntu/macos/windows × node 18/22 **6/6 全绿**（run [40845762840](https://github.com/KentQi/cc-code-review/actions/runs/40845762840)）
**方式**：4 个 subagent 并行（写域完全不重叠：claude.js / shell-guard.js+hook / index.js+prompt.js / scripts+assets+package.json），Lead 负责协调、独立验收、文档与 git。

---

## P0（10/10 已修）

| 编号 | 问题 | 修复 | 独立验收 |
|---|---|---|---|
| P0-8 | core.sshCommand 扫描漏检 → 白名单内 git remote show 执行仓库命令 | git config --list -z 规范化键 + 显式拒绝执行类键 + 子进程 GIT_CONFIG_* 中和 | Lead 探针 refusals>0 ✅ |
| P0-9 | core.attributesFile 从不扫描 → textconv RCE | 作为第三个 attributes 源纳入扫描；仓外/非常规 → refusal | ✅ |
| P0-10 | MAX_ATTR_FILES 命中不置位 truncated | 置位并触发 refusal | ✅（有效 fixture：每目录一个真 .gitattributes） |
| P0-1 | echo $VAR / echo 通配符 → 凭据外带 | 裸 $VAR 判 substitution；echo 操作数路径校验 + 禁通配符与波浪号 | ✅ hook 进程级 |
| P0-2 | tr 操作数不校验 | tr 操作数按路径校验（注：tr 无 FILE 操作数，属纵深防御） | ✅ |
| P0-3 | hook Read 分支 fail-open | 与 Write 一致：catch→deny、rel===null→deny | ✅ |
| P0-4 | hook stdin 错误 exit(0)=放行 | 输出 deny + exit 1 | 代码路径 + 自测（status 1/deny） |
| P0-5 | baseRef 两套校验器，HEAD~1 被静默丢弃 | 单一导出校验器；预检接受即使用 | ✅ prompt 含 HEAD~1、无 ignored |
| P0-6 | scope=pr 无 pr → pull request undefined | 预检拒绝 + prompt 防御性文案 | ✅ 无 undefined、工具级 isError |
| P0-7 | followup 误报 RAN WITHOUT BEING BLOCKED | followup 复用 review 的 denial 分类 | ✅ before/after harness |

## P1（10/10 已修）

P1-1 阈值 80→75（SKILL.md + prompt.js + 工具描述）；P1-2 活跃 journal 真正保护（两条清扫）；P1-3 C7 恒真断言修正；P1-4 p0-regression 改回必需；P1-5 测试不再落真实凭据 + tmp 清理；P1-6 日志/guard 目录拒绝符号链接与异属主、强制 0700；P1-7 new URL 包 try/catch；P1-8 hono 改直接依赖；P1-9 claude→claude 模型降级可检测；P1-10 native+shadow 走 preflightFail。

## 附加

- **策略指纹**：hook 暴露 CC_REVIEW_GUARD_INFO=1 的策略哈希，预检自检比对 → "stale process 会拒绝运行"这条文档承诺第一次成真（审计表 #7）。
- P2 顺手修：P2-1 codeDrift 名单补 prompt.js/skill.js；P2-2 find 的 -newer 等取文件值的 flag；P2-3 脱敏阈值；P2-4 job 按完成顺序淘汰；P2-5 付费套件显式 script + SKIP 说明；P2-6 MAX_SEGMENTS 回归；P2-8 PIPE_SINKS 单一来源；P2-10 段落分隔符；P2-11 sed 死代码删除；P2-12 logsDir 错误可识别。

## 复核后的追加修复（auditor 发现）

审计复核发现 P0-1 的修复引入了过拒：`echo 'price: $5'`（单引号内的字面 `$`）被拒。根因是 tokenizer 剥掉引号后丢失了"该 token 是否被引号保护"的信息。已修：

- `parseCommand` 为每个 word 记录 `quoted` 标志（引号内字符、引号开启、反斜杠转义）；
- `echo` 不再做路径校验（它只打印字面量，不读文件），改为**只拒绝未加引号的**通配符与 `~`；
- 回归新增 11 条（`echo 'price: $5'` / `echo '$HOME'` / `echo '*'` / `echo "====="` 必须 ALLOW；`echo $HOME` / `echo *` / `echo ~/*` 必须 DENY），p0-regression 80 → **95**（另含策略指纹接线、guard 目录符号链接加固 4 条）。

## 对审计报告的三条更正

1. P0-2 定性过头：BSD/GNU tr 均无 FILE 操作数（"extra operand" 报错），不构成任意读；修复保留为纵深防御。
2. P0-10 的复现 fixture 无效：aN.gitattributes 不被 git 读、也不被扫描器计数，从未撞到上限；真实布局是"每目录一个 .gitattributes"，回归用例已用真实命名。
3. P0-1 的 echo /etc/passwd 不读文件（打印字面量）；真正的泄漏是通配符展开与 $VAR。

## 残余风险（1.18.3 后的实际状态）

> **已由 1.18.3 关闭**：sync 取消丢报告（P1-8）、并发锁（P1-16）、报告格式双份（P2-1）、大结果无上限（P2-4）、信号退出误判（P2-7）、cancel-test 跨平台（P2-5）。以下保留的是 1.18.3 之后仍未做的项。


- 新增 refusal 面：仓库本地 credential.helper / core.pager / core.gitProxy 会被拒（fail-closed 取舍）。
- ~~echo 的方括号规则 quote-blind（echo "[1] done" 会被拒）~~ **该条不成立，已删除**：quote-aware 修复后 `echo "[1] done"`、`echo "[1]"`、`echo "a*b"` 实测全部放行，只有未加引号的 `echo [1]` / `echo a*b` 被拒（判据 `!quoted[i+1] && ...`）。
- 评审子进程的 GIT_CONFIG_* 中和会压过用户自己的 sshCommand/credential.helper/diff.external（仅评审进程内，属 fail-safe）。
- 未修：上轮遗留 sync 取消丢报告、并发锁、instructions 口径；P2 其余项。
- 验证边界：本机 macOS；Windows/Linux 由 CI 矩阵验证；付费套件未运行。
