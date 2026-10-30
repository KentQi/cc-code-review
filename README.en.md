# cc-code-review

[![CI](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml/badge.svg)](https://github.com/KentQi/cc-code-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

English | [简体中文](README.md)

An MCP server that wraps **Claude Code's code-review capability** so ZCode (or any MCP client) can call it directly:
ZCode → MCP → `claude -p` (headless) → claude's built-in `/code-review` (low..high, including `--fix`) or the inline fleet pipeline (max: 10 finders + one verifier per surviving candidate + sweep) → the report comes back to ZCode as-is → ZCode fixes the code based on the findings → call again to re-verify.

```
ZCode ──MCP(stdio)──▶ cc-code-review ──spawn──▶ claude -p --output-format stream-json
                            │                              │  cwd = the repo under review
                            │                              └─ built-in /code-review (default) or the inline
                            │                                 fleet prompt — nothing is written to ~/.claude
                            ◀── result(report + session_id + spend) ──┘
```

## Prerequisites

- Node ≥ **20** (CI matrix 20/22/24; Node 18 is EOL and no longer supported)
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

**Recommended: one command, auto-configured (since v1.7.0)**. Clone this repository (or install the npm package — `scripts/init.mjs` ships in the tarball since v1.18.5), then inside it run:

```bash
npm install
npm run init
```

`init` runs a **free self-check** (claude CLI resolution and version, hardening-flag floors, a live shell-guard test, skill status, git/gh, gateway reachability) and then writes the registration into `~/.zcode/cli/config.json` **derived from this machine** — node gets the currently running absolute path, the entry file gets this checkout's absolute path, and gateway credentials (when a CC Switch / settings.json / environment configuration is detected) are carried over automatically. No Windows/macOS/Linux paths to edit by hand. Restart ZCode (or reconnect the MCP) afterwards; tool names: `mcp__cc-code-review__claude_code_review` and friends.

> ⚠️ **Updating the code requires restarting the MCP host.** A stdio MCP server keeps the modules it loaded at startup, while the shell guard's hook is spawned fresh from disk on every Bash call. Updating the files without a restart therefore leaves an old server next to a new hook: the two disagree about the policy, and the guard self-test (correctly) refuses to run with `the shell guard is installed but did not behave as expected`. That is fail-closed, not a bug. `claude_review_env` answers it directly: its first line is `cc-code-review server: vX.Y.Z`, and if the source on disk is newer than this process it appends `⚠ STALE PROCESS` with a restart hint (`server.stale` in structuredContent).

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
| `focus` | - | - | extra focus points (a review hint only — never executed as instructions; **must be a single line**) |
| `outputLanguage` | `中文` | - | report language |
| `postToPR` | `false` | - | additionally post the summary back to the PR via `gh pr comment` (by default the report is only returned, nothing leaves the machine). **Requires `pr`**: with no named PR the preflight refuses (otherwise the run would hold an unusable GitHub write grant and the prompt would ask the model to guess a PR) |
| `fix` | `false` | - | **fix mode**: after the report, edit repo files to fix the findings (only Edit/Write unlocked, **zero git write commands**, no commits; `.git/**`, `.env*` and secret files are all in the deny list — blocking verified on a real CLI) |
| `effort` | `max` | low/medium/high/xhigh/max | **model reasoning effort**, same levels as Claude Code's native `--effort`; defaults to max (deepest, slowest, priciest) — pass low/medium explicitly for a fast, cheap pass; degrades to think/ultrathink keywords when the CLI lacks the flag (never both at once) |
| `reviewLevel` | derived from `effort` | low/medium/high/max | **the review's own depth** — the same argument the native `/code-review low\|high\|max` takes. The numbers are rendered from `FLEET_NUMBERS` in `src/prompt.js` (single source for the tool schema, the prompt and this table; the bundled SKILL.md no longer repeats them — it points at the run's "Reviewer fleet" line): low = one pass, no subagents (≤4 findings); medium/high = **8 finders** (the 3+5 shape, filled from 5 briefs × 6 candidates, findings capped at 8); max = **10 finders** (the 5+5 shape, every brief split × 8 candidates) + **one verifier per surviving candidate** (CONFIRMED/PLAUSIBLE/REFUTED) + **1 sweep finder**, findings capped at 15; at most 20 candidates reach verification. A max run therefore exceeds 15 agents structurally (measured: 17), not by a hard-coded number |
| `ultracode` | `false` | - | **Ultracode mode**: writes `ultracode: true` into the `--settings` file, enabling claude's standing dynamic-workflow orchestration (every substantive step via the Workflow tool, multi-agent, token cost no object). Orthogonal to effort; older CLIs ignore the key (`workflow_runs` in the result shows whether it took effect) |
| `model` | - | - | model override (`--model` passthrough) |
| `maxTurns` | `80` | 4–200 | agentic turn cap |
| `timeoutMinutes` | `30` | 1–60 | hard timeout — with no spend cap this is the master guard; when it fires, the finished subagent reports are still returned |
| `maxBudgetUsd` | `0` (no cap) | 0–50 | API spend cap (`--max-budget-usd`). **The default 0 sets NO cap at any effort level**: a cap stops the parent before it synthesizes, while every finished subagent report is already captured incrementally and a 429-killed agent is recovered from its output_file transcript — a cap only throws away paid work. `timeoutMinutes` and `maxTurns` are the guards. Set a number to opt into a hard stop; env `CLAUDE_REVIEW_MAX_BUDGET_USD` changes the default only — an explicit argument wins |
| `pipeline` | `auto` | auto / native / fleet / skill | review engine. **auto**: claude's built-in `/code-review` for low..high (needs no file on disk; fix rides its own --fix flag); max (including effort=xhigh), scope=last-commit with no parent, and a shadowing skill use the fleet (reasons below). **native** forces the built-in; **fleet** forces the inline fleet; **skill** is the legacy mode — the only one that writes to `~/.claude` |
| `installSkillIfMissing` | `false` | - | only meaningful with `pipeline=skill`: install the bundled skill when MISSING (default false — a missing skill degrades to the inline fleet pipeline; a managed existing copy is refreshed before use; a copy carrying this MCP's marker is refreshed before use (local edits to it are overwritten); a copy without the marker is never written or removed, and uninstall removes only this MCP's files) |

Returns (async by default: a jobId (<1s) plus the preflight verdict, with the report fetched via claude_review_status(jobId); with waitForResult: true the synchronous form below applies): a markdown report (`## Code Review Summary` / `## Findings (N)` / `## Notes`, the same contract as the bundled SKILL.md) + each reviewer subagent's own report (`## Reviewer subagent reports`, sized from the diff) + metadata (`session_id`, spend, turns, log path, model provenance). Auth/gateway failures from claude come back as a prominent `⚠️ REVIEW FAILED` banner with actionable hints — never disguised as a "report".

### 2. `claude_review_status` — poll / fetch / cancel a background review (free)

`claude_code_review` is **async by default**: after a fast preflight (20s soft budget on the probes) it returns a jobId — real reviews take 2-15 minutes and most MCP clients cut tool calls at ~30s. This tool: with jobId, poll (reports elapsed time) or fetch the finished report; with jobId + cancel=true, abort and stop billing; without arguments, list this process's jobs. Clients that want the synchronous contract pass waitForResult: true to claude_code_review.

### 3. `claude_review_followup` — follow-up questions / re-review

Continue the conversation using the `session_id` returned by the previous run (`claude --resume`).

### 4. `claude_review_env` — environment self-check (free; **not a read-only tool**)

CLI resolution result and its source, version, `--effort`/`--max-budget-usd` support, skill status, gateway reachability (loopback TCP preflight), leftover auth-variable warnings, `git`/`gh` availability, `CLAUDE_CODE_EFFORT_LEVEL` override warnings. The first line is a machine-readable `verdict: OK|NOT_FOUND|MISCONFIGURED`. `installSkill: true` manually (re)installs the skill.

## Review pipeline: claude's built-in `/code-review` by default, nothing written to disk

Claude Code 2.1.x **ships** a `code-review` skill (`/code-review [level] [target]`). This MCP calls it directly and no longer installs anything into `~/.claude`.

| level | Default engine | Why (measured on 2.1.311) |
|---|---|---|
| low / medium / high | **built-in `/code-review`** | single-context, angle-by-angle reading, finishes in ~10s, zero installs; fix mode rides the command's own `--fix` flag (verified in the binary) |
| xhigh (mapped to max) | **this MCP's fleet** | the same fleet pipeline as max (xhigh only maps reviewLevel to max) |
| max | **inline fleet pipeline** | the built-in max spawns subagents whose `cd X && ls && git config …` exploration is denied wholesale by manual mode (measured: 100 denials, no convergence in 5 minutes); the fleet prompt keeps them inside the read-only surface |
| `last-commit` on a root commit | inline fleet pipeline | the built-in's target is a BASE ref (`HEAD~1`); a root commit has no parent |

- **Inline fleet = no files**: the body of `assets/skills/code-review/SKILL.md` is appended to the prompt (`## Pipeline (bundled with this MCP)`); the cost is ~8KB of extra input per fleet review.
- **`pipeline` argument**: `auto` (default) / `native` / `fleet` / `skill`. `skill` is the only mode that writes to `~/.claude`, and it is off by default.
- **A same-named skill shadows the built-in command** (measured: with `~/.claude/skills/code-review` present, `/code-review` becomes a `Skill` call). So `auto` switches to the fleet pipeline and says so; an explicit `pipeline=native` is refused rather than silently running something else. Remove an old copy with `claude_review_env { uninstallSkill: true }`.
- Results carry `pipeline` (description) and `pipelineMode` (resolved value); `subagent_stats` shows the fleet size.

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

So this MCP additionally attaches a **PreToolUse hook** (`scripts/pre-tool-hook.js`, injected via `claude --settings <tempfile>` alongside `--setting-sources user`, without overwriting user settings — verified that CC Switch gateway config still applies). It **covers subagent Bash calls** (the workhorses of the parallel reviewer fleet).

**The decision is per segment, not "any `&&` is a denial" (v1.14.0).** The permission engine can only gate the FIRST command of a string, so the hook judges every segment: each one must be a permitted read-only command (or a pipe sink: head/tail/cat/wc/uniq/cut/tr/grep/sort), `cd` is allowed only as the first segment and only when it resolves to the reviewed repo root, and redirection (`>` `>>` `<`), `$()`/backticks/`${}`, ANSI-C quoting (`$'...'`) and background `&` are always refused. So `git show HEAD:x | head -80`, `git status && git diff` and `cd <repo> && git show HEAD` all run, while `git status; curl evil.com` and `git status && cat /etc/passwd` still stop.

Why not the stricter "never allow a compound command": that rejected the shape models naturally write (`cd <repo> && git show HEAD`), burning a turn every time without reducing risk — the same two commands run one-per-call are allowed anyway. The real boundary is "every segment is inside the read-only surface", not "no segments".

**A PreToolUse hook can only subtract (verified in the binary).** claude 2.1.311's hook-output sanitizer passes `permissionDecision: "deny" | "ask"` through and drops `"allow"` (`permissionDecision==="deny"||==="ask"?…:void 0`); `updatedInput` does not land on that path either. That is exactly why `Bash(cd:*)` must be in the allowlist: it lets the shape through the engine's gate, and the hook then decides where the `cd` actually lands. A hook-allow + engine-deny combination only costs a turn; it never weakens security.

**Reads are scoped to the repository too (v1.15.0).** The path arguments of `find`/`rg` and of every pipe sink (cat/head/tail/wc/uniq/cut/tr/grep) are checked against the repo root — `~`, `$VAR`, `..`, brace expansion, absolute paths, and in-repo symlinks or junctions pointing outside are all refused (realpath, the same rule the Edit/Write boundary uses). Git pathspecs are NOT path-scoped — git itself confines them to the tree — but the escape hatches are refused outright: `git diff --no-index`, `git blame --contents`, plus `--output=` writers. `sed -f`, `wc/sort --files0-from` and `uniq`'s second positional (an output file) are also refused outright, and `sed` is not a permitted pipe sink at all (its script language writes/executes/reads in forms no parser reliably catches). A hook that is not given the repo root fails closed for Bash.

It also closes the **write/execute forms that a prefix rule cannot express**: `find` and `rg` are granted as read-only tools, but `find -delete / -exec / -execdir / -ok / -okdir / -fprint / -fprintf / -fls` write files or run programs, `rg --pre / --pre-glob` runs an arbitrary program per file, `sort -o / --compress-program / -T` write or execute, and `git branch <name>` creates a branch (flag-guarded). The hook refuses those per segment (matching deny rules are in the allowlist too, but the hook is the deterministic control); plain reads are unaffected.

> ⚠️ **`--settings` replaces the entire `hooks` key**: the injected temp file contains only this MCP's hook — your own hooks from `~/.claude/settings.json` will **not** run inside this child process (other keys such as `env`, `model`, `permissions` are unaffected). This is CLI behavior, not an omission — if you rely on your own hooks during reviews, you currently need a different approach.

**There is exactly one policy**: `src/shell-guard.js` exports `BASH_POLICY`, `prompt.js` renders the `Bash(...)` rules from it, and the hook judges segments against the same table — so "the hook allowed it" and "the engine allowed it" cannot drift. The contract is locked by `scripts/shell-guard-test.mjs` (320 checks) and `scripts/p0-regression-test.mjs` (238 checks: every P0 form from the 2026-10 audits — ANSI-C quoting / backslash escapes / glued short options, `.GIT` case variants, fix-mode persistence paths, repo-supplied git drivers, symlink freeze, config.worktree, node_modules attributes, the hook's fail-closed payload shapes) — **run `npm test` before changing the policy**. Turn it off with `CLAUDE_REVIEW_SHELL_GUARD=0` (the whole thing then fails closed and refuses to run — see "Fail closed when a defense layer is missing").
**v1.18.5 boundaries (7 P0 / 14 P1 from the third audit)**

- **Git long-option abbreviations no longer bypass the deny tables**: `git`/`sort`/`wc`/`rg` accept unambiguous prefixes, so the tables match by prefix now (`--cont` = `--contents`, `--files0` = `--files0-from`) and the missing file-reading options are denied.
- **`gh pr comment --body-file/-F`** is scoped to the repository (postToPR included): a host credential file can no longer be POSTed to GitHub.
- **`echo` quoting is judged per character**: only an unquoted glob/`~` is refused (`echo "prefix"*`, `echo ~"/".ssh/*` DENY); literal forms (`echo '*'`, `echo 'price: $5'`) still work.
- **Repository config is enumerated by git itself**: the main worktree's `.git/config.worktree`, every `.gitattributes` `git ls-files` reports (including inside `node_modules/`), out-of-tree `[include]` targets and repositories with more than 200 includes are refused; `protocol.ext/file.allow`, `url.*.insteadOf` and `remote.*.vcs` are rejected by the scanner and neutralised in the child env.
- **The read boundary covers Grep/Glob and Bash**: the hook matcher is catch-all, `Grep`/`Glob` `path` is confined to the repo and checked against the secret list, and a Bash command that references `.env`/`id_rsa`/`.ssh/`/`credentials`/`.npmrc`/`.git-credentials` is refused (previously only the `Read` tool was protected).
- **fix mode refuses the runner/CI/hook configuration files** (`.husky/**`, `.github/actions/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `Makefile`, `justfile`/`Taskfile`, `.pre-commit-config.yaml`, `.devcontainer/**`, `.cargo/config(.toml)`, `.circleci/**`, `.npmrc`); `package.json` only when the written content adds an install hook.
- **The policy fingerprint covers the hook's two tables** (`PROTECTED_WRITE`/`SECRET_READ` moved into `shell-guard.js` and hashed), so a hook-only policy change trips the stale-policy check.

**v1.18.6 structure and residuals**

- **One git-hardening table**: the child env, the server's own `-c` list and the scanner's keys are generated from `GIT_HARDENING`, and a load-time assertion refuses to start if a key protected for the server/scanner is not also pinned in the child env.
- **One containment implementation**: `realpathNearest`/`repoRelative`/`isInsideRepo(..., {allowRoot})` live in `src/shell-guard.js` and are shared by the hook, the guard and the repository-metadata reader.
- **Recursive-scan read boundary**: `rg --hidden/--no-ignore/-u/--unrestricted` and recursive `grep -r/-R` rooted at the repository are refused (they read ignored secrets); scoped searches (`rg -n x src`) stay allowed.
- **Fail-closed scanner**: an unparseable `.git/config` or an attribute enumeration that cannot run (corrupt index) refuses the review instead of noting it.
- **`package.json` Edit/MultiEdit** are checked for install hooks too (the result file is reconstructed, so a two-step rename cannot smuggle one in).
- **The fingerprint covers the inline rule code**, so a rule-only upgrade also trips the stale-policy check.
- **Lockfile**: the 94 tarball URLs move from `registry.npmmirror.com` to `registry.npmjs.org` (same paths and integrity hashes).

**v1.18.7 boundaries (re-check + final audit)**

- **`find` long options match both spellings**: GNU find's historical single-dash long options (`-files0-from`) and the double-dash form (`--files0-from`, `--files0`) are all denied, including abbreviations.
- **`find -D` / `-O`**: only a debugopts value (letters/commas) or a level (digits) is consumed; any other following token is a start path and is checked (`find -D /etc` and `find -O /etc` used to enumerate a host directory).
- **Self-review protects the whole guard/spawn pipeline**: `src/*.js`, `scripts/pre-tool-hook.js`, `scripts/init.mjs`, `scripts/lib/**` and `assets/skills/**` can no longer be written in fix mode — editing `src/index.js` or `src/claude.js` would disarm every later run just like editing the hook.
- **The hook fails closed on a payload it cannot judge**: malformed JSON, an empty stdin, a non-object or a missing `tool_name` now denies (it used to exit 0); a parsed payload naming a tool the hook does not police still passes, because those are governed by the server allowlist.
- **Node >= 20**: the declared runtime floor, the CI matrix (20/22/24) and the README badge agree; a pack-test assertion keeps them in step.
- **`postToPR` requires a fully-qualified PR selector**: a bare number (`pr: "123"`) is resolved by `gh` against the reviewed repository's own remote, and that repository is untrusted content — so its `origin` would decide where the comment is published. `owner/repo#N` or a PR URL pins the target; reading a PR by bare number stays allowed (the documented `scope=pr` behaviour).
- **Self-review protection is identity-scoped, not path-shaped** (v1.18.8): `src/*.js`, `scripts/init.mjs`, `scripts/lib/**` and `assets/skills/**` are write-denied only when the reviewed tree IS this package (the hook and server always load from the package install directory, so a foreign repository's copy has no effect on the running guard). Fix mode can edit `src/*.js` in ordinary projects again; a self-review still requires a manual edit for those files.


Redirection (including `2>/dev/null`) stays fully refused: it is the read/write primitive that bypasses the allowlist, and allowing it would require proving every destination harmless. Let the command write to stdout instead.

The hook has a second deterministic rule: **git's `--output=` / `--output-directory=` turns "read-only" commands into file writers** (`git diff/show/log --output=<file>` and `git format-patch --output-directory=` all write to disk — verified; `--output-to=` is not a real flag). Deny globs are powerless here — Bash rules prefix-match the whole command, so `Bash(git diff --output=*)` cannot catch `git diff HEAD --output=x`, and the semantics of a mid-rule `*` cannot be verified from outside the CLI — so the hook judges this one directly. Non-git `--output` flags (grep, `find -print`, …) are unaffected.

**Write-surface confinement (the hook's other half, v1.5.0)**

Edit / Write / NotebookEdit / Read are hooked too and bounded by `CLAUDE_REVIEW_REPO_ROOT`: the target path must resolve inside the repo under review; `.git/**`, `.env*`, `id_rsa*`/`*.pem`/`*.key` and other secret paths are always denied; without a `repoRoot` (the hook config did not apply) everything fails closed instead of passing through. The boundary check goes through **realpath** (both sides resolved to their on-disk real paths), so in-repo directory junctions/symlinks (`repo/link -> ~/.ssh` — lexically inside, physically outside) are blocked as well (locked by regression tests); writes to not-yet-existing targets are anchored on their nearest existing ancestor.

**The repo as a code-execution surface (added v1.5.0; liveness-aware since v1.7.0)**

git executes the **repository's own** configuration: `core.fsmonitor`, `diff.<driver>.command`, `.gitattributes` filter/textconv drivers, `core.hooksPath`, `[include] path = ../x` (which can point outside the repo). `-c` overrides can only neutralize known keys, and driver names are arbitrary. So every run first scans `.git/config` (including the include chain) and every `.gitattributes`: **discovering repo-controlled program execution refuses the run outright** rather than reviewing a compromised tree.

The scan is precise and does not punish normal repos: a `.gitattributes` saying `*.png filter=lfs` with the driver defined in the user's **global** config (the common git-lfs install) does **not** trigger a refusal; `core.fsmonitor = true` (a boolean, already neutralized by `-c`) does **not** either. Since v1.7.0 it further distinguishes **live** from **dead** config:

- **Dead paths downgrade to a note**: a repository copied wholesale from another machine routinely carries the original machine's absolute paths (e.g. `core.hooksPath = /Users/kent/Desktop/...` seen on Windows). A path that does not exist on this machine cannot execute anything — it becomes a note in the report instead of blocking the review (locked by regression tests).
- **`core.hooksPath` is a note even when live**: git hooks fire only on **mutating** operations (commit/merge/rebase/...), none of which the review allowlist ever grants, and this server's own git calls always neutralize the key via `-c core.hooksPath=`. fsmonitor/textconv/external/filter drivers are different — they fire on **read** commands like `git status`/`git diff` — so a live one still refuses and a dead one proceeds with a note.

**Fail closed when a defense layer is missing**

When the hook is not installed, when `guardSelfTest()` fails (the hook must really deny a chained command and really allow a clean one), or when the guard state is `failed`, both tools **refuse to start a review** and say which layer is missing — because manual mode's allowlist alone cannot stop the prefix-match bypass. `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` unlocks **only** a guard you deliberately switched off (`CLAUDE_REVIEW_SHELL_GUARD=0`); an installation/self-test failure is never bypassable (a run in that state would advertise a guard while no command is policed). For a completely unguarded run, set `CLAUDE_REVIEW_SHELL_GUARD=0` explicitly.

**Version floors (added v1.5.0)**

`--permission-mode manual` needs CLI ≥ 2.1.200; `--permission-prompts none` needs ≥ 2.1.259. Passing an unknown flag to an older claude ends the whole run with one cryptic error, so each flag is gated by a `claude --version` read before the run (the version comparison is safe for pre-releases like `2.1.301-beta.1`); below the floor the flag is skipped and the result says so. `claude_review_env` prints both floors and the current CLI version.

**Input validation (added v1.3.0 — all before any paid call)**

| Input | Rule | Reason |
|---|---|---|
| `repoPath` | must be absolute (`~/` is expanded) | a relative path resolves against the MCP server's own cwd — it could review the wrong repo and spend money |
| `repoPath` | must be a git/hg/svn repo | every scope reads git history; a non-repo buys one guaranteed-to-fail paid call |
| empty repo | no commits and no uncommitted changes → refused | nothing to review |
| `pr` | only `123` / `#123` / `owner/repo#123` / a GitHub PR URL | the value is interpolated into the review prompt |
| `outputLanguage` | single line, ≤20 chars, no backticks, no sentence punctuation | prevents smuggling instructions; language names are short (Chinese / English / English (US)) |
| `baseRef` | plain ref chars; no leading `-` | interpolated into git commands; a leading `-` becomes a git flag (`git merge-base --output=<file>` writes files), so it is rejected rather than "ignored" |
| `focus` | single line, ≤2000 chars, no control characters | same |

**Cancellation semantics**: the MCP SDK **deliberately drops the response to a cancelled request** (per protocol — the client already knows it cancelled). So you will not see a "cancelled" return value, but the child process tree is taskkilled within ~2 seconds of cancellation and billing stops immediately; the same applies when the client closes stdio while a review runs.

**Observability (added v1.3.0)**: the result metadata carries `permission_denials` and `reviewer_subagents_spawned`. Under manual mode, a missing allowlist entry does not abort the run — it silently degrades the review (e.g. the reviewer subagents never start), and these two fields make that degradation visible. Fix mode also compares `git status` before and after; an unchanged working tree is reported as `FIX MODE VERIFICATION FAILED` — a reviewer that "described" a fix without writing it is not misjudged as success.

Since v1.4.0 the metadata also carries `bashCalls` (Bash calls made this run) and `shellGuardBlocked` (commands blocked by the hook), and distinguishes two denial kinds: a guard block is the **hook working as intended** (the model should retry with a permitted command — not a review degradation); only other denials report "the review may be incomplete". If you ever see `⚠ BASH COMMAND(S) RAN WITHOUT BEING BLOCKED`, a command really executed past the hook — only then treat the repository as a hostile environment.

Since v1.10.0 the result also carries **each reviewer subagent's own report** (a `## Reviewer subagent reports` section plus `subagents[]` in structuredContent). Before that only the parent's synthesis came back while the subagent reports lived in the log file alone — which is exactly why the same prompt showed a fleet of experts working in Claude Code but only one summary through this MCP. v1.10.0 also adds **model provenance**: claude 2.1+ forwards subagent events (including the model each actually ran on) to the parent stream, so the MCP compares requested vs effective model and reports `⚠ MODEL SUBSTITUTION` when a rewrite is detected — a CC Switch-style gateway, or `CLAUDE_CODE_SUBAGENT_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL_NAME` in `~/.claude/settings.json`'s env block (claude itself logs `[claude-code:unrecognized_model]` on stderr in that case). The note says plainly that such an output is **not comparable** to the same prompt run directly in Claude Code. The same rewrites — plus a process-env `ANTHROPIC_BASE_URL` silently overridden by the settings file — are also warned about before the run starts.

- Run logs (which quote the code under review) go to `%TEMP%/cc-code-review/`, dir 0700, files 0600, keeping the newest 20; the incremental `subagents-*.jsonl` reports share that directory, the 0600 mode, and the same retention/sweep. Guard temp files and the throwaway git HOME live in the same directory — cleaned on process exit, stale leftovers swept by the next run.
- The CLI ships a built-in safe-command whitelist (`ls`, `cat`, `echo` and other read-only tools) that passes even outside `--allowedTools`. **That is why `echo` must be narrowed in the hook**: it accepts literal text only — `$VAR` expansion and **unquoted** globs/`~`/out-of-repo paths are refused, while quoted literals (`echo 'price: $5'`, `echo '*'`) still work (otherwise an injected reviewer could write `echo $ANTHROPIC_API_KEY` into the report). Verified that `node -e`, `python -c`, `rm`, `git push`, `git commit`, `curl` and Write tool calls are **all denied** — so this is not a privilege hole, but "only the whitelist passes" should be read as "whitelist + this batch of built-in read-only commands".
- The model can split a hook-blocked compound command into several allowed calls — the hook blocks "many steps in one command", not "many things in one turn". The real capability boundary is still manual mode's allowlist; the hook guarantees each step is individually auditable.
- Known residual risk: fix-mode edits to other files in the repo, prompt-injection-induced "plausible-looking" edits — fix mode leaves changes uncommitted in the working tree, so review them with `git diff` as you would a PR before adopting them.
- Known residual risk (Windows): the 0700/0600 dir/file modes are best-effort — NTFS has no POSIX mode bits, so other local users can theoretically read `%TEMP%\cc-code-review\run-*.log` (which quotes the code under review). For stricter isolation, set `CLAUDE_REVIEW_LOG_DIR` to a directory your own ACLs protect, or accept the risk (equivalent to none for most single-user desktops).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CODE_PATH` | auto-detect | claude executable / cli.js (shell shims rejected) |
| `CLAUDE_REVIEW_TIMEOUT_MIN` | `30` | default timeout (minutes); changes the default only — an explicit `timeoutMinutes` wins |
| `CLAUDE_REVIEW_MAX_BUDGET_USD` | `0` | default spend cap, `0` = no cap; changes the default only — an explicit `maxBudgetUsd` wins |
| `CLAUDE_REVIEW_MODEL` | - | default model |
| `CLAUDE_REVIEW_AUTO_INSTALL_SKILL` | off | set `1` to make `installSkillIfMissing` default to true (only meaningful with pipeline=skill; even then nothing is installed unless the skill is missing) |
| `CLAUDE_CONFIG_DIR` | ~/.claude | root for skill install/lookup (read from the process env and ~/.claude/settings.json env block, matching the claude child) |
| `CLAUDE_REVIEW_SKILL_DIR` | - | test override: the skill directory, takes precedence over the above |
| `CLAUDE_REVIEW_SHELL_GUARD` | `1` | `0` disables the PreToolUse Bash segment guard (troubleshooting only, not recommended; setting it alone unlocks nothing — the tools also refuse to run) |
| `CLAUDE_REVIEW_ALLOW_UNGUARDED` | - | set `1` to allow runs when the guard was deliberately switched off. **No effect on installation/self-test failures** (those always refuse). Refuses by default |
| `CLAUDE_REVIEW_LOG_DIR` | `%TEMP%/cc-code-review` | run-log directory (logs quote the code under review; Windows has no POSIX mode bits — point it at a directory your own ACLs protect) |

Tip: if the host environment has leftover `ANTHROPIC_API_KEY` and friends that `settings.json` does not manage, they may conflict with CC Switch (`claude_review_env` warns about this); gateway users can add `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"` to `~/.claude/settings.json` to reduce non-essential traffic.

## Cost & duration

- Every real review consumes Claude credits (through your subscription/gateway). With the default effort=max the fleet is 10 finders + one verifier per surviving candidate + 1 sweep (measured: 17 subagents, $5.7, ~23 min; concurrency is bounded by your gateway — of 17 concurrent agents, 5 failed on a MiniMax gateway); explicit `effort: "low"` uses the built-in single pass at roughly $0.1–3. The default is **no spend cap** (`maxBudgetUsd: 0`); `timeoutMinutes` is the guard.
- **Incremental capture**: each reviewer subagent's report is appended to `%TEMP%/cc-code-review/subagents-*.jsonl` (one line per subagent) the moment it lands, and is visible via `claude_review_status` while the run continues — the native skill only reports after the whole fleet finishes, but a 429 / timeout / cancel can interrupt it; finished reports come back with the error.
- **429 recovery**: an agent killed by a rate limit / quota exhaustion is salvaged from the `output_file` transcript named in its launch acknowledgement (marked `partial (output_file)`), so tokens already spent are not wasted.
- `claude_review_env` and version/flag probes are free (results are cached).

## Using it from ZCode

Restart ZCode and just say, for example:

> Use the cc-code-review MCP to run a code review of the uncommitted changes in C:\path\to\repo (effort max), then fix the findings, then re-review to confirm.

## Testing / maintenance

```bash
npm install
npm test                                         # every free suite, one summary (shell-guard 238 + audit-fix 272 + P0 regression 95 + validation 16 + smoke + cross-cases 149); non-zero if any fails
npm run init                                     # environment self-check + writes the ZCode registration for THIS machine (free)
node scripts/validation-test.mjs                # every input-validation path (free, no API calls)
node scripts/cross-cases.mjs                    # 21 MECE cases (136 checks; ultracode/workflow + fleet scaling, cancel-keeps-finished-reports, misread-ack-corrected-by-notification e2e; free stub-claude async lifecycle + reviewer-report/model-provenance e2e; C9 paid needs CC_LOOP_PAID=1)
node scripts/paid-smoke.mjs [--cap=2]           # REAL CLI end-to-end smoke: throwaway repo with three planted bugs, effort/reviewLevel=low, no spend cap by default (billed, ~$0.5 observed)
node scripts/e2e-test.mjs <repoPath> [json]     # real review (billed)
node scripts/followup-e2e.mjs <repoPath> <sessionId> # real followup (billed)
node scripts/cancel-test.mjs <repoPath>         # is the process tree killed right after cancel (billed, a few cents)
```

`validation-test.mjs` covers: relative `repoPath` refused, malicious `pr` (including a leading `-`) refused, `outputLanguage` over 20 chars / sentence punctuation / multi-line refused, `focus` with a newline or tab refused, an oversized followup message (>100000 chars) refused, `claude_review_status` cancel without a jobId refused, empty repo refused, non-git directory refused, `maxBudgetUsd=0` accepted by the schema, `baseRef` starting with `-` refused, `focus` with control characters / oversized refused, both tools fail-closed when the guard is off, and the explicit `CLAUDE_REVIEW_ALLOW_UNGUARDED=1` unlock. Everything returns before any paid call — the one exception is the "clean repo passes preflight" check, which really starts a budget-capped paid run and is therefore **skipped by default**; set `CC_REVIEW_ALLOW_PAID_PROBE=1` to include it.

`shell-guard-test.mjs` covers: chained/redirected/substituted commands must be blocked, `find -delete/-exec/-fprintf` and `rg --pre` must be blocked while plain `find`/`rg` reads must pass, quoted separators like `git log --format="%h; %s"` must pass, unbalanced quotes fail closed, the hook process's stdin→deny contract, the repo boundary and `.git/`/secret-path interception for Edit/Write/Read, in-repo junction/symlink escapes (realpath containment), and a real review's 17-command replay (confirming blocked commands are not misreported as escapes).

`audit-fixes-test.mjs` covers every fix from the independent audit rounds: deny-list coverage and the "same rule in both lists is dead code" conflict, **allow rules prefix-shadowed by deny rules** (`Bash(git remote -v)` vs `Bash(git remote:*)` — found in a real review), `postToPR` grants not being dead code, version comparison (including pre-releases), git hardening `-c` args, `repoRunsGitPrograms` precision (fsmonitor booleans and global LFS drivers do not false-positive; `[include]` chains and `.gitattributes`↔config cross-checks do catch real drivers), the hook's `git --output=` rule, caller data staying data inside prompts, and a real review's command replay (both the allowlist and the deny side must pass).

**Run `npm test` before touching the regex in `src/shell-guard.js`**: the comment on that regex and the module docstring explain why it must include `|` and `&` (the prefix-match bypass) — reading only the code makes it look like false-positive tuning.

**Verified regressions** (Windows / npm global install / CC Switch local gateway, no account login): a full review under manual mode (Chinese report, self-planted bugs scored CRITICAL/MAJOR per the ≥80 rule of that run (now ≥75), low-confidence items correctly demoted to Notes), `scope=branch` + `baseRef` (`git log main..HEAD` / `git diff main...HEAD`, `permission_denials=0`, guard blocked 0), fix mode writes files and does **not** commit, `.git/` untouched, followup resumes the same session via the returned `session_id`. Earlier rounds also verified: a repo carrying a malicious `.claude/settings.json` no longer executes repo-controlled hooks, and the process tree is zeroed within 2 seconds of cancellation.

- Run logs: `%TEMP%\cc-code-review\run-*.log` (newest 20 kept)
- Upgrading from v1.5.0 or earlier (old name claude-review-mcp): the old log directory `%TEMP%\claude-review-mcp` is never touched or deleted by the new version; delete it manually if it contains sensitive references.
- Uninstall: delete the `cc-code-review` entry from the ZCode config; delete `~/.claude/skills/code-review` to remove the skill.

## License & acknowledgments

- This project is open source under the [MIT](LICENSE) license.
- The bundled code-review skill (`assets/skills/code-review/SKILL.md`) is adapted from Anthropic's official code-review plugin pipeline (8/10 parallel finders driven by 5 briefs + confidence filtering), further adapted here for headless invocation and the read-only boundary.
- Thanks to the Claude Code team and to the CC Switch / claude-code-router gateway projects for making "reviews without an account login" possible.
- The security model has been through multiple rounds of independent cross-audits (Windows / macOS / auth-gateway / install-forms / regression perspectives) — see above and [SECURITY.md](SECURITY.md). Please report vulnerabilities via private advisories, not public issues.
