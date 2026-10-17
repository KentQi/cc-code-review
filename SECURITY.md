# Security Policy / 安全策略

This MCP intentionally runs a **repo under review as an adversarial environment**: the reviewed repository must not be able to execute code, exfiltrate credentials, or escape the write boundary — even when its files contain prompt injection that talks the reviewer model into trying.

## Supported versions

Only the latest tagged release receives security fixes.

## Reporting a vulnerability

请**不要**用公开 Issue 报告安全漏洞。使用 GitHub 的 [Private vulnerability reporting](https://github.com/KentQi/cc-code-review/security/advisories/new)（私有安全通告），或通过仓库主页的联系方式联系维护者。

请附上：复现步骤（最好是一个最小仓库）、影响的平台（Windows/macOS）、涉及的防线（allowlist / deny 列表 / PreToolUse hook / git 预检）。

## Known limitations (by design, documented in README)

- `--settings` 注入的 hook 会替换本次子进程的整个 `hooks` 键——用户自己 settings.json 里的 hooks 在 review 期间不生效（CLI 行为，README 有 ⚠ 说明）。
- Bash 权限规则的整条命令前缀匹配意味着"放行第一条命令"的规则等于放行任意命令；防线是 PreToolUse hook + manual 模式 allowlist，而不是 deny glob。
- Windows 上 `%TEMP%` 目录没有 POSIX 权限位，0700/0600 是尽力而为；需要强隔离请设 `CLAUDE_REVIEW_LOG_DIR`。
- 日志文件引用被审代码，保留最近 20 份，位于 `%TEMP%/cc-code-review/`。

完整模型见 README「安全模型」一节；每条防线的契约都由 `npm test` 里的回归测试锁定。
