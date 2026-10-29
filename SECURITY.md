# Security Policy / 安全策略

This MCP intentionally runs a **repo under review as an adversarial environment**: the reviewed repository must not be able to execute code, exfiltrate credentials, or escape the write boundary — even when its files contain prompt injection that talks the reviewer model into trying.

## Supported versions

Only the latest tagged release receives security fixes.

## Reporting a vulnerability

请**不要**用公开 Issue 报告安全漏洞。使用 GitHub 的 [Private vulnerability reporting](https://github.com/KentQi/cc-code-review/security/advisories/new)（私有安全通告），或通过仓库主页的联系方式联系维护者。

请附上：复现步骤（最好是一个最小仓库）、影响的平台（Windows/macOS）、涉及的防线（allowlist / deny 列表 / PreToolUse hook 分段守卫 / git 预检）。

## The model (short form; README「安全模型」一节 is the authority)

- **权限边界**：`--permission-mode manual` + allowlist（`Bash(...)` 前缀规则是引擎闸：整串命令的第一个命令必须命中规则）。
- **分段守卫**：PreToolUse hook 对每条 Bash 命令**逐段求值**——每段必须是策略内的只读命令（或管道 sink），`cd` 只允许落到被审仓库根，重定向（含 `2>/dev/null`）、`$()`/反引号/`${}`、后台 `&` 一律拒绝；`find -delete/-exec/…`、`rg --pre`、`sort -o/-T/--compress-program`、`git branch <name>`（建分支）等写/执行形态按段直接拦截。
- **读取范围**：`find`/`rg`/sink 的路径参数限定在仓库内（realpath，覆盖 `~`、`$VAR`、`..`、花括号扩展、仓库内软链接/junction 逃逸）；git pathspec 不做路径校验（git 自身限定在树内），但其逃逸口（`--no-index`、`blame --contents`、`--output=` 写形态）直接拒绝。
- **失效即拒跑**：hook 未生效/自检失败/脚本缺失时两个工具都拒绝发起 review；hook 拿不到仓库根时对 Bash 直接 fail-closed。
- **修码边界（fix 模式）**：Edit/Write 只许写进仓库（realpath 边界 + junction 逃逸拦截），`.git/`（含 Windows 大小写变体）、`.env*`、密钥/凭证文件被 deny 规则封死；运行前后 `git status` 对比，工作区无变化报 `FIX MODE VERIFICATION FAILED`。
- **进程边界**：`--settings` 注入的 hook 替换本次子进程的整个 `hooks` 键——用户自己 settings.json 里的 hooks 在 review 期间不生效（CLI 行为，README 有 ⚠ 说明）。

## Known limitations (by design, documented in README)

- Windows 上 `%TEMP%` 目录没有 POSIX 权限位，0700/0600 是尽力而为；需要强隔离请设 `CLAUDE_REVIEW_LOG_DIR`。
- 运行日志（含被审代码引用）与增量子代理报告 `subagents-*.jsonl`（0600）位于 `%TEMP%/cc-code-review/`，保留最近 20 份运行日志；journal 文件至少存活到对应 job 结果可读。
- 网关并发上限可能导致高并发的子代理失败（由网关决定）；已完成的报告仍逐条捕获。

完整模型见 README「安全模型」一节；每条防线的契约都由 `npm test` 里的回归测试锁定。
