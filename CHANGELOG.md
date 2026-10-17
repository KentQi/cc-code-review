# Changelog

## 1.9.0 — 2026-10-18

- **claude_review_followup is async too** — the last M from the audits: it was the only remaining synchronous agentic call, cut off by ~30s client tool timeouts. Same job pattern as claude_code_review: jobId at once, poll/fetch/cancel via claude_review_status, waitForResult=true restores the sync contract, client-cancel of the initial call aborts the job.

## 1.8.4 — 2026-10-18

- npm overrides pin @hono/node-server to 1.19.9 (within the SDK declared range). The lockfile had resolved 2.1.5 whose engines require Node >=20, so npm install under engine-strict failed on the declared Node >=18.19 floor. We only use StdioServerTransport; the sole hono importer (streamableHttp) is never loaded. Missed in the 1.8.3 batch — closes the last M from the fourth audit.

## 1.8.3 — 2026-10-18

Fixes from a fourth multi-expert audit (reliability / universality / usability; 5 independent auditors, no H findings):

- cancel-before-listener race: a client cancelling the async call DURING preflight never fired the abort (already-aborted signals do not fire listeners) — the run billed with no jobId reaching the caller; now checked up front.
- guard files are marked in-flight the moment prepareRunHardening writes them (an awaited version-probe window previously let a concurrent env call delete them; followup never marked at all).
- git status porcelain over 1MB broke fix verification silently and made gitPreflight misdiagnose no-commit repos — maxBuffer raised to 64MB; a failed status now surfaces its own error.
- skill install IO failure (locked dir / read-only home) escaped as an opaque SDK error; now degrades to the documented inline fallback.
- guardSelfTest probes could hang forever on a wedged hook; 15s kill timer added.
- stream-json partial-line buffer capped (a corrupt multi-MB line caused O(n^2) memory).
- CLAUDE_REVIEW_TIMEOUT_MIN / MAX_BUDGET_USD env defaults outside the zod ranges made every call fail -32602 naming no env var; now clamped.
- Windows: repoPath whose directory name ends in space/dot (legal NTFS, unspawnable) is refused with a clear message.
- POSIX: CLAUDE_CODE_PATH without the exec bit is no longer accepted on shebang evidence alone (was an opaque EACCES at spawn).
- init: EISDIR / unreadable config.json now exits cleanly (the 1.8.2 claim for this case was premature); stub pidfile moved to the OS temp dir so npm pack no longer ships it; cross-cases C8 no longer passes vacuously (waits for the pidfile, then proves the kill).
- Docs truth pass: counts 67/158, tool-1 Returns documents the async default, the 4th tool added to the stable-name list, cross-cases documented in both READMEs; jobId expiry text names pruning, not only restarts.
- Known limitation (two auditors, not fixed): claude_review_followup is still synchronous-only — clients with ~30s tool timeouts will cut it; keep follow-ups short.


## 1.8.2 — 2026-10-17

Loop-tested with a 10-case MECE suite (scripts/cross-cases.mjs, free via a stub claude + one paid e2e) plus two more independent audits; all findings fixed:

- **[H] submodule relative gitdir**: repoConfigFiles resolved gitdir paths against the server cwd — a submodule gitdir config (relative form) was never scanned. Now resolved against the superproject.
- **[M] pre-spawn guard-file race**: a concurrent claude_review_env could delete a pending run guard settings file between write and spawn — the review then ran unguarded while the report claimed hardening. Guard files are now marked in-flight until claude has spawned.
- **[M] client-cancel orphan**: cancelling the initial async claude_code_review call now also aborts the background job (was recoverable only via the job list).
- **[M] init**: legacy environment key migrated away; user-custom timeoutMs preserved (was clobbered to 1800000); the nothing-to-change fast path also compares timeoutMs; non-object config.json (null/number/array) and EISDIR now fail cleanly instead of crashing.
- New: scripts/cross-cases.mjs (10 MECE cases, 44 checks) + scripts/stub-claude.mjs; cc-loop state under .cc-loop/ (untracked).

## 1.8.1 — 2026-10-17

Security fixes from an independent cross-audit of the v1.7.0 liveness gate — four FALSE-DOWNGRADE holes, each letting a repo-chosen program execute under the reviewer's first read-only git command while the gate reported only a note:

- **H1** paths with spaces were truncated to the first token before the liveness probe (`C:...dir with spacewatch.exe` → `C:...dir` → "dead"). Now every space-boundary prefix is probed, quote-stripped both raw and separator-swapped.
- **H2** the .gitattributes cross-check stopped at the first `diff=/filter=` match per file — a live driver listed after a dead one passed silently. All references on all lines are now evaluated.
- **H3** the one-directory-deep .gitattributes scan had an inverted condition — NO real subdirectory was ever scanned. Fixed.
- **H4** git worktrees/submodules: `.git` is a FILE (`gitdir: ...`) and the pointer file was scanned as config text, so the real config (per-worktree AND the common config named by `commondir`) was never checked. Both are now followed.
- **M1** dead-UNC existsSync probes stalled ~21s each in the request path — UNC values are now always treated as live (refuse, safe direction). **M2** commented config lines no longer refuse. **M3** drive-relative paths probe against the repo's drive, not the server cwd's.
- 6 new regression tests lock H1-H4 + M2 (the worktree test builds a real `git worktree`). Suite: 67 + 158 + smoke.

## 1.8.0 — 2026-10-17

- **Async review jobs (the big one).** Real reviews take 2-15 minutes, but MCP clients commonly cut tool calls at ~30s — in a real-world test the calling agent had to re-implement the invocation by hand to work around it. `claude_code_review` now returns a **jobId in under a second** (after the full free preflight: validation, hardening gate, git preflight, gateway probe — synchronous errors still return synchronously), runs the review in the background, and the report is fetched with the new **`claude_review_status`** tool (poll while running, full result when done, `cancel: true` aborts and stops billing, no-arg lists jobs). `waitForResult: true` restores the synchronous contract. Verified with a real paid run: 297ms to jobId, 195s to report. `npm run init` now also writes `timeoutMs: 1800000` into the registration.
- The repo-gate refusal message now stamps the server version, so "stale server process" incidents (a v1.6.0 refusing what v1.7.0 allows) are diagnosable.


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
