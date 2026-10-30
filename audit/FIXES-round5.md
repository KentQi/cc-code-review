---
title: 修复报告（第五轮）
version: v1.18.5
created: 2026-10-30
status: final
---

# 修复报告（第五轮）— v1.18.5

**基线**：v1.18.4（PR #1–#4 的第三轮审计：7 P0 / 14 P1 / 22 P2 / 8 P3）
**结果**：v1.18.5（`npm test` 7 套件全绿：shell-guard 272 / audit-fixes 305 / p0-regression 163 / validation 30 / pack 43 / cross-cases 154 / smoke）
**PR**：[#5](https://github.com/KentQi/cc-code-review/pull/5)（stacked on [#4](https://github.com/KentQi/cc-code-review/pull/4)）
**CI**：ubuntu/macos/windows × node 18/22 **6/6 全绿**（run [40927081609](https://github.com/KentQi/cc-code-review/actions/runs/40927081609)）
**方式**：5 个 subagent 并行（claude.js / shell-guard+hook / index.js / prompt+skill / scripts+package），Lead 做跨文件补丁、独立复现与验收。

## 7 条 P0（全部已修，Lead 独立复现过每一条）

| # | 问题 | 修复 | 验收 |
|---|---|---|---|
| P0-1 | `protocol.ext.allow` 不在子进程 git 环境 → 仓库 `ext::` 远程在评审期间执行任意命令 | 子进程 env 加 `protocol.ext.allow=never`/`protocol.file.allow=never`；扫描器拒绝 `protocol.*.allow`/`url.*.insteadOf`/`remote.*.vcs` | 修复前 `ext::touch` marker 落地；修复后不落地、git 报 transport not allowed |
| P0-2 | 主工作树 `.git/config.worktree` 从不扫描 → textconv RCE | 主工作树也读 `config.worktree` | 修复前 refusals=0，修复后 >0 |
| P0-3 | `.gitattributes` 遍历跳过 `node_modules/` → textconv RCE | `git ls-files -z` 枚举全部 tracked/untracked `.gitattributes`（含 node_modules） | 修复前 0，修复后 refusal |
| P0-4 | `git blame --cont` 缩写绕过 `--contents` deny → 读宿主任意文件 | deny 表改无歧义前缀匹配；补 `--ignore-revs-file`/`--mailmap-file` 等 | `--cont`/`--contents`/`--ignore-revs-file` 全 DENY |
| P0-5 | `sort --files0=` 缩写读任意文件 | 同上 | DENY |
| P0-6 | `gh pr comment --body-file/-F` 读宿主机密文件并 POST | gh 文件参数走仓内校验、`--repo` 形状校验 | `/etc/passwd` DENY、仓内文件 ALLOW |
| P0-7 | `git blame --ignore-revs-file` 读并回显宿主文件 | 加入 deny 表 + 前缀匹配 | DENY |

## 14 条 P1（全部已修）

- **P1-1** 越界 `[include]` 静默跳过 → 改为 refusal；include 按 section 解析（避免 submodule `path` 误报）。
- **P1-2** `find -- <path>` → 按路径校验。
- **P1-3** fix 模式持久化拒绝扩表（`.husky/**`、`.github/actions/**`、`.gitlab-ci.yml`、`Jenkinsfile`、`Makefile`、`.pre-commit-config.yaml`、`.devcontainer/**`、`.cargo/config`、`.circleci/**`、`.npmrc`；package.json 内容级判断）。
- **P1-4** 读边界覆盖 Bash（`rg`/`grep`/`git show` 引用密钥路径即拒）+ SECRET_READ 扩表。
- **P1-5** hook matcher 改 catch-all，`Grep`/`Glob` 的 `path` 受仓内与密钥约束。
- **P1-6** `scope=auto`（默认）不再丢弃 `baseRef`（prompt 与 native 命令同时修）。
- **P1-7** 同步路径先 settle 再盖章 → 失败 job 不再永远 `running`。
- **P1-8** `scripts/init.mjs` 重新随包发布（`npm run init` 在安装态可用），pack-test 真实执行解包后的 init。
- **P1-9** init 的 env 块合并 `~/.claude/settings.json` 的网关凭据（settings-only 场景可用）。
- **P1-10** `postToPR` 必须带 `pr`（预检拒绝），提示词不再要求模型猜 PR 号。
- **P1-11** `scope=pr` 保留完整 selector（`owner/repo#N`/URL），不再退化成裸数字。
- **P1-12** include 文件数上限 200（1200 个 include 从 13s 冻结降到 ~11ms 并 refusal）。
- **P1-13** 策略指纹覆盖 hook 的 `PROTECTED_WRITE`/`SECRET_READ`（移入 shell-guard 并纳入哈希）。
- **P1-14** `echo` 引号按字符判定（`echo "prefix"*`、`echo ~"/".ssh/*` DENY；字面量仍 ALLOW）。

## P2/P3（本轮修掉的部分）

- P2-2 hook 与 prompt 的写/读保护表统一来源；P2-3/P2-4 死代码与注释；P2-5 同步返回也受 512KiB 上限（含 followup reply）；P2-6 running 轮询的 subagent 报告截断；P2-7 NO_PROXY 补齐全部 loopback；P2-8 恒真断言改 SKIP；P2-9 smoke 在 MISCONFIGURED 时失败；P2-10 三个付费脚本迁移共享 MCP 客户端；P2-11 followup-e2e 改同步契约；P2-12 `rg --files`/`find -newer` 断言；P2-13 真负向指纹用例；P2-14 `baseRef` 范围拒绝断言；P2-15 progress timer 泄漏；P2-16 uninstallSkill 测试；P2-17 env 工具 readOnlyHint=false；P2-18 报告契约从 SKILL.md 提取；P2-19 FLEET_NUMBERS 单一来源；P2-20 付费 preflight 去重；P2-21 subagents fallback 目录加固。
- P3：exit drain（P3-1）、流截断诊断（P3-2）、ack+正文保留（P3-3）、async/partial false 保留（P3-4）、settledAt 单排序键（P3-5）、空报告判定去重（P3-6）、classifyDenials 缓存（P3-7）、hook guardUrl 去重（P3-8）。

## 未修 / 接受

- **P2-22**（lockfile 94/95 tarball 指向 registry.npmmirror.com）：未硬改（需要联网重新生成）。修复命令：`npm install --package-lock-only --registry=https://registry.npmjs.org`，再 `npm ci --dry-run`。
- 审计 §6 记录的被证伪/平台受限结论不修（`submodule.path`、`--mailmap-file`、`find -files0-from` 的 BSD 限制）。

## 验证

- 独立验收（Lead 自写）：`/tmp/verify-round5.mjs` **32/32**——缩写选项、`gh --body-file`、`find --`、`echo` 引号、`ext::` 环境中和、`config.worktree`、`node_modules` attributes、越界 include、hook 的 Grep/Glob/密钥/runner 配置。
- 各 subagent 另有 before/after 自测：claude.js 10/30→30/30、index.js 9/30→30/30 与 4/10→10/10、prompt 25/96→96/96、scripts 逐项变异验证。
- `npm test` 7 套件全绿（本机 + 克隆）。
## 残余（本轮明确不修，需另立条目）

- **P1-4 残余**：`grep -rn "" .` / `rg --hidden --no-ignore` 仍放行——文本级检查无法判定“是否读了密钥”，要闭需拒绝整类递归/隐藏扫描，代价明显，建议单独评审。
- **P0-6 残余**：`gh --repo` 只做形状校验，未绑定到被审仓库（需要 remote/调用方信息）。
- **package.json** 的 Edit 未被内容级拦截（权限引擎按文件名；hook 的 Write 内容检查已覆盖 install 钩子）。
- **`.env.example` 写策略**：权限层 `**/.env.*` 拒绝，hook 允许模板——保守方向不一致（权限层更严）。
- **P1-13 部分**：指纹覆盖 `PROTECTED_WRITE`/`SECRET_READ` 两张表，但内联 `segmentProblem`/`dotGlobProblem`/`isInsideRepo` 的代码逻辑仍未纳入哈希。

- **扫描器的 git 失败路径**：仓库把 `.git/config` 写成不可解析（如非法转义）时，扫描器只记 note 并继续（git 命令随后也会失败，评审无产出）。fail-closed 化需要把“bad config”也当 refusal，本轮未改。
