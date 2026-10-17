# Changelog

## 1.7.0 — 2026-10-17

- **`npm run init` — environment-aware installer/self-check.** No OS-specific paths anywhere in setup: node, the package location, claude/git/gh, and gateway credentials are all derived from the machine it runs on, and the ZCode registration is written with those values (existing entries updated in place, unknown fields preserved). Runs the free self-check first (CLI + flag floors + live shell-guard test + skill + git/gh + gateway probe).
- **Repo git-config gate is now liveness-aware.** A repository copied from another machine routinely carries the original machine's absolute paths (`core.hooksPath = /Users/kent/...` on Windows — a real incident that blocked a review); a path that provably does not exist on this machine cannot execute anything, so it now becomes a note in the report instead of a refusal. `core.hooksPath` is a note even when live: git hooks fire only on mutating operations the review allowlist never grants, and the server's own git calls neutralize the key via `-c`. fsmonitor/textconv/external/filter drivers still refuse when live (they fire on read commands) and note when dead. Dead `[include]` targets note (git silently ignores them). `repoRunsGitPrograms()` now returns `{refusals, notes}`; locked by 14 deterministic tests (live fixtures create real files, so behavior is OS-independent).

## 1.6.0 — 2026-10-16

Renamed to **cc-code-review** (was `claude-review-mcp` / `claude-code-review-mcp`). Tool names (`claude_code_review` etc.) and the `CLAUDE_REVIEW_*` environment variables are unchanged, so existing callers keep working; only the MCP server key changes.

First public open-source release. Includes fixes from a five-expert cross-audit (Windows / macOS / auth-gateway / install-forms / rename-regression):

- **[H] TDZ crash**: `runClaude()`'s signal-hint block used `wasCancelled` 19 lines before its declaration — on macOS/Linux every client cancellation or Gatekeeper SIGKILL threw an uncaught exception and killed the whole MCP server. Declaration moved above the block.
- **[M] junction/symlink write escape**: the PreToolUse hook's write containment was purely lexical (`path.relative`), so a directory junction inside the repo (`repo/link -> ~/.ssh`) let fix-mode writes land outside the repo (verified live). Containment is now realpath-based on both sides, with 4 regression tests.
- **[M] `CLAUDE_CODE_PATH` accepted zero-byte WindowsApps execution aliases** in the env-override path (verified live); `classifySpawnTarget` now rejects them like the PATH scan already did.
- **[M] guard-settings temp-file leak**: every `claude_review_env` call and several early-return paths leaked a `guard-settings-*.json`. Files are now tracked and cleaned per process, stale artifacts (>2h) swept by the next server, and the throwaway git HOME is removed on exit.
- **[M] `--permission-mode` was passed blindly when `claude --version` was unreadable** (wrapper banners); falls back to the same help-text probe `--permission-prompts` uses.
- **[M] guard self-test now exercises the shell-rendered hook command** (`guardHookCommand()` through a shell), not just the argv form Claude Code's quoting could silently break.
- **[M] auth diagnostics corrected**: the `CLAUDE_CODE_EFFORT_LEVEL` warning claimed the env var overrides `--effort` (this MCP strips it from the child env — the real override surface is settings.json, now warned about instead); `ANTHROPIC_MODEL` & friends no longer misreported as credential residue; an env-only-configured gateway is no longer told to "clear ANTHROPIC_BASE_URL"; an unparsable `~/.claude/settings.json` gets its own diagnostic.
- Failure hints split: missing OAuth login vs rejected key (401/403) vs unreadable OS credential store (launchd/service-hosted MCP daemons) now get distinct, actionable hints; SIGILL hint mentions the Apple-Silicon/Rosetta case.
- Gateway provenance note now also fires when CC Switch **changes** the endpoint URL mid-run (provider switch), not only when it disappears.
- Windows: repoPath without a drive letter (`/tmp/repo`) is rejected instead of silently resolving against the server's drive; npm-global fallback also probes `bin/claude` on unix; npm-root probe memoises terminal failures; startup prewarm awaits the in-flight npm probe (first-call NOT_FOUND race on custom prefixes).
- Smoke test pins the server identity (`cc-code-review` + package.json version); `validation-test`'s one paid probe is now opt-in (`CC_REVIEW_ALLOW_PAID_PROBE=1`).

## 1.5.0

- Fail-closed posture: guard state `failed` refuses runs unless `CLAUDE_REVIEW_ALLOW_UNGUARDED=1`; version floors gate `--permission-mode manual` (>= 2.1.200) and `--permission-prompts none` (>= 2.1.259) per flag; repo-as-code-execution-surface gate (repo-controlled git config / `.gitattributes` drivers that execute programs refuse the run — precise enough to leave LFS and boolean `core.fsmonitor` alone); write-surface convergence (Edit/Write/NotebookEdit/Read hooked and scoped to the reviewed repo); `guardSelfTest()` proves the hook actually fires; `CLAUDE_REVIEW_LOG_DIR` for Windows ACL isolation.

## 1.4.0

- PreToolUse shell guard (`scripts/pre-tool-hook.js`, shared logic in `src/shell-guard.js`): deterministically blocks shell-chained/substituted Bash commands and git `--output=`/`--output-directory=` writes — the surfaces the prefix-matching permission engine cannot express. Injected per run via `--settings` (overlays, does not replace user settings except the `hooks` key). Metadata adds `bashCalls` / `shellGuardBlocked` with an honest distinction between guard blocks (normal) and other denials (degradation).

## 1.3.0

- Process boundary: `--setting-sources user` (a hostile repo's `.claude/settings.json` is no longer loaded — it executes repo-controlled SessionStart hooks and can hijack `ANTHROPIC_*`); `--permission-mode manual` + `--permission-prompts none` make the allowlist a hard boundary; input validation for every caller-supplied string before any paid call; observability metadata (`permission_denials`, `reviewer_subagents_spawned`); fix-mode verifies the working tree actually changed; cancellation kills the whole process tree.

## 1.0.0

- Initial MCP wrapper around Claude Code headless code review: `auto`/`pr`/`branch`/`working-dir`/`last-commit` scopes, `effort` low→max with thinking-keyword fallback, fix mode (edit-only, no git writes), `--resume` followups, `claude_review_env` self-check, bundled skill install that never overwrites a user-managed skill, CC Switch / OAuth / API-key auth support.
