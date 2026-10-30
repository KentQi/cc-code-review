# Contributing / 贡献指南

欢迎 Issue 和 PR。这个项目的大部分复杂度在**安全边界**上，改代码前请先读 README 的「安全模型」一节。

## 本地开发

```bash
npm install
npm test                # 全部免费套件统一汇总（约 2 分钟）：shell-guard 235 + 审计修复 272
                        # + P0 回归 68 + validation 16 + stdio 冒烟 + cross-cases 136；任一失败即非零退出
node scripts/p0-regression-test.mjs  # 只跑 2026-10 审计的 P0 形态（68 条，真实 hook 进程，约 2s）
node scripts/validation-test.mjs     # 只跑输入校验路径（16 条，免费，不发 API 请求）
```

- `npm test` 里的 smoke 测试会真实 spawn MCP server 并调用 `claude_review_env`，所以需要本机能解析到 claude；CI 用 `CLAUDE_CODE_PATH=scripts/stub-claude.mjs` 指向桩，因此 CI 只验证 stdio 握手/工具面/env 形状，真实 CLI 行为由本机 `npm test` 覆盖。其余套件免费且离线。
- `scripts/e2e-test.mjs` / `followup-e2e.mjs` / `cancel-test.mjs` 会发起**真实付费**的 review，请勿在 CI 或他人机器上随手运行。
- `validation-test.mjs` 默认全免费；唯一会付费的检查默认跳过，设 `CC_REVIEW_ALLOW_PAID_PROBE=1` 才执行。

## 改这些地方之前

- **`src/shell-guard.js` 的链式命令正则**：那行正则为什么必须包含 `|` 与 `&`（Claude Code 的 Bash 权限规则是整条命令前缀匹配，堵不住绕权），注释和模块 docstring 里有完整论证。**改之前先跑 `npm test`**，shell-guard-test.mjs 里的 60+ 条契约（含一次真实 5-subagent review 的命令回放）就是为它写的。
- **`src/prompt.js` 的 allow/deny 列表**：deny 优先于 allow，且规则是前缀匹配——一条"图省事"的整类 deny 规则会静默杀掉 allow 里的读命令（真实 review 里发生过，`audit-fixes-test.mjs` 的 "no allow rule is prefix-shadowed by a deny rule" 就是那次加的）。加规则时两个套件都要过。
- **deny glob 拦不住的东西**：`Bash(*;*)` 这类 glob 不会命中（规则匹配的是命令本身，不是它的组成部分），`git diff HEAD --output=x` 这种中段带旗标的写文件也拦不住——这些归 hook 管，别往 deny 列表里加死规则。
- **新增依赖**：目前运行时依赖只有 `@modelcontextprotocol/sdk` 和 `zod`，倾向保持零增。

## PR 约定

- 一个 PR 一件事；跨平台行为（Windows/macOS）变化请在描述里说明在哪个平台实测过、怎么测的。
- 涉及安全边界的改动请顺带更新 README「安全模型」对应小节，并补回归测试。
- 提交信息用英文或中文均可，祈使句开头。
