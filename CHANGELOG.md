# Changelog

## 1.13.1 — 2026-10-28

Verification round on the 1.13.0 work: every finding from the multi-expert audit was re-checked against the code and the ones that were real are fixed here, with a regression test each.

- **[H] An interrupted run no longer throws away the reports it already paid for.** The cancel / timeout / no-result paths returned a bare `err()`, so the incremental subagent records and the JSONL path (the whole point of 1.13.0) were unreachable exactly when they mattered most. They now go through one `interruptedResult()`: the finished reports render in the text, and `subagents` / `subagentsSpawned` / `subagentsFile` / `modelProvenance` are in structuredContent with `status: cancelled | timed_out | no_result`. New C19 cancels a run mid-fleet and asserts the reports survive.
- **[H] The launch-ack detector is anchored, and a misread ack can no longer suppress a real report.** `parseAgentLaunchAck` now requires the real CLI shape (anchored first line, `agentId:`, "working in the background", `output_file:` on a line of its own) and only accepts a transcript under `<tmp>/claude*/…/tasks/*.output` — a repo-planted "ack" could otherwise choose a file for the server to read. `recoverReportFromTranscript` has the same hard gate. For older ack shapes, `looksLikeLaunchAck` (anchored, no path) merely marks the text as "not a report", and a `task_notification` is authoritative for its dispatch: it corrects a record that an ack created instead of being dropped. New C18 covers the correction (including the extra correction line in the JSONL journal).
- **[M] The `find`/`rg` write+execute hole is closed (present since 1.6.0).** `Bash(find:*)` and `Bash(rg:*)` were granted as prefix rules, so the allowlist itself permitted `find . -delete`, `find . -exec …`, `find -fprintf`, `rg --pre <program>`. The PreToolUse hook now refuses those forms (the deny globs are added too, but the hook is the deterministic control), a plain `find`/`rg` read still passes, and these denials are reported as "unsafe write/execute form" rather than "shell-chained". Note: the first attempt silently did nothing because a heredoc had eaten the backslash in `split(/\s+/)`, which is how the same corruption was also found in the 429 banner regex (`/\b429\b/` contained two raw 0x08 bytes and could never match) — both fixed, plus a repo-wide sweep for the same damage.
- **[M] The partial-reports JSONL is written like every other log**: via the resolved logs dir (not a second ad-hoc temp path), mode `0600`, and included in both retention pruning and the stale-temp sweep.
- **[M] A stopped notification with an empty summary recovers from the transcript** instead of recording an empty report.
- **[M] Documentation drift**: the env tables now show `CLAUDE_REVIEW_TIMEOUT_MIN=30` and `CLAUDE_REVIEW_MAX_BUDGET_USD=0`, the "5 reviewer subagents" copy is gone from both READMEs, `package.json`, the bundled `SKILL.md` and a code comment, and the env-override wording says plainly that the env var sets the default while an explicit argument wins.
- **[L] Smaller ones**: a warning when `maxBudgetUsd > 0` but the installed CLI has no `--max-budget-usd`; describes for the followup's `timeoutMinutes` / `maxBudgetUsd`; `partial` is set only when something was actually recovered.
- **[L] Test honesty**: C5 no longer reports a green check when its worktree fixture could not be created (it skips, visibly); C16 now proves durability mid-run (the JSONL already holds exactly the reports the poll shows while the run is still going, and the poll names the file) instead of only counting lines at the end.
- Suites: shell-guard 90 (+23: every dangerous find/rg form, plain reads, hook-process denials, note wording), audit-fixes 241 (+7: ack shape, path gate, loose detector, non-transcript refusal), validate 16, cross-cases 105/105 (new C18 ack precedence, new C19 cancel retention).

## 1.13.0 — 2026-10-28

No spend cap at any level, and no work lost to a 429. The native skill only reports after the WHOLE reviewer fleet finishes, and a rate limit / token exhaustion (429) can stop it first — which used to throw away every token already spent on the subagents that did finish.

- **No cost cap by default.** `maxBudgetUsd` now defaults to `0` — `--max-budget-usd` is not passed at any effort level. The old derived defaults (and the flat $5 before them) stopped the parent before it synthesized; with incremental capture a cap only discards paid work. `timeoutMinutes` (default 30) and `maxTurns` are the guards. An explicit `maxBudgetUsd` is still honoured, and `CLAUDE_REVIEW_MAX_BUDGET_USD` still overrides.
- **Incremental capture — one subagent done, one durable record.** Every finished reviewer subagent is appended, the moment it lands, to `%TEMP%/cc-code-review/subagents-*.jsonl` (one JSON line per subagent, in completion order) and pushed into the job, so `claude_review_status(jobId)` reports `subagentsSoFar` (and lists them in its text) while the run continues. The final result (success OR error) carries the same set, plus the file path (`subagentsFile` / `partial_reports_file`).
- **429 recovery from the agent's own transcript.** An async agent killed mid-flight never sends its `task_notification`; only the launch acknowledgement's `output_file` survives. On settle, the MCP reads the TAIL of that JSONL transcript and recovers the last assistant text as a partial report (`partial: true`, `recovery: "output_file"`, rendered as `partial (output_file)`). Pure helpers: `parseAgentLaunchAck`, `recoverReportFromTranscript`.
- **429-aware failure banner.** A rate-limit/quota failure now says explicitly that nothing paid for is lost: the finished reports come with the error and the killed one is recovered from its transcript.
- Suites: shell-guard 67, audit-fixes 234 (+5: ack parsing + transcript recovery), validate 16, cross-cases 93/93 — C15 now locks "no spend cap by default / explicit cap honoured", C16 locks the incremental path (poll-visible growth + one JSONL line per finished subagent), C17 locks the 429 recovery (an agent with a launch-ack transcript and no notification is reported as `partial (output_file)`).

## 1.12.0 — 2026-10-28

- **`effort` now defaults to `max`** — the deepest review is the default experience (the previous `high` default under-delivered for a tool whose whole point is thoroughness). Pass `low`/`medium` explicitly when you want a fast, cheap pass.
- **An omitted `maxBudgetUsd` follows the effort**: low $3 / medium $5 / high $10 / xhigh $20 / max $25 (env `CLAUDE_REVIEW_MAX_BUDGET_USD` still overrides). Without this, the new max default met the old flat $5 cap and most real runs were stopped by `error_max_budget_usd` before the parent synthesized — exactly the failure mode the 1.11.0 audit round hit. The derived default always stays within the schema's 0–50 range.
- `reviewLevel` continues to derive from effort, so a default call now runs at review level max: a diff-sized finder fleet (2–8+) plus verification agents, i.e. 10–15+ subagents on a large diff.
- The tool description and both READMEs no longer advertise a fixed five subagents; the cost guidance now reflects the max default ($3–25 typical, $0.3–3 at low).
- Suites: shell-guard 67, audit-fixes 236 (+7: budget defaults), validate 16, cross-cases 83/83 — new C15 locks that a default call really passes `--effort max` and `--max-budget-usd 25` to the CLI (the stub echoes its argv).

## 1.11.1 — 2026-10-28

Fixes from the atomic audit of the 1.11.0 requirement set (the MCP auditing itself at effort=max / reviewLevel=max; the diff-sized fleet worked as designed — 12 reviewer subagents dispatched and all 12 reports captured before the run's own $30 budget cap; 4 of 12 reviewers reported before the cap, every finding verified against HEAD before fixing):

- **[M] A failed review's TEXT now carries the run metadata.** `ultracode` / `review_level` / `workflow_runs` (plus status, cost, turns, subagent counts) lived only in `runResultText`, which the error path never called — a budget-capped or max-turns run showed none of the knobs it used to a text-only caller, even though structuredContent had them. The error path now renders the same metadata block (new shared `runMetaLines`).
- **[M] guardState's probe settings file no longer leaks.** `guardState()` writes a settings file to prove the temp dir is writable; that probe survived until the 2h sweep — one ~600B file per agentic run for the life of the server, plus two dead paths per run in the in-memory Set. The probe is now removed before returning, and `removeGuardSettings` prunes the Set (previously only `cleanupGuardSettings` did).
- **[M] The e2e suite now runs in CI.** `scripts/cross-cases.mjs` (80 checks: async job lifecycle, reviewer reports incl. async task_notification, model provenance, error path, ultracode/Workflow, guard-file leaks) was in neither `npm test` nor `.github/workflows/ci.yml` — all of it was local-only. Added `npm run test:e2e` and a hermetic CI step (stub claude, no network, no spend; the paid C9 stays opt-in).
- **[L] READMEs no longer advertise a fixed five.** The top blurbs still said "5 parallel reviewer subagents" 80 lines above the parameter table documenting the diff-sized fleet; both now describe the fleet (2–8+ by diff size).
- Suites: shell-guard 67, audit-fixes 229 (+3: guardState probe), validate 16, cross-cases 80/80 (C13 now asserts the error-path metadata lines). Local atomic checklist of R1–R14: 25/25.

## 1.11.0 — 2026-10-28

Workflow-level pass: the MCP now exposes the same three knobs a native Claude Code review has, and the bundled skill sizes its reviewer fleet the way the native pipeline does. Established by reading claude 2.1.311's own code for `/code-review` (the built-in command, alias `/review`) and the Ultracode/Workflow machinery:

- **Three separate variables, now all reachable through this MCP.**
  1. `effort` — the CLI's reasoning effort (`--effort low..max`), unchanged.
  2. `ultracode` (new) — claude's standing dynamic-workflow orchestration. Setting `ultracode: true` makes the MCP write the `ultracode` settings key into the `--settings` file it already passes, so the CLI injects its "use the Workflow tool on every substantive task" mode. Orthogonal to effort (any level), exactly as the CLI's own `applied` schema documents. The allowlist gains the native `Workflow` tool — without it, ultracode (and any request for a workflow) was silently denied under `--permission-mode manual` and collapsed to a single inline pass.
  3. `reviewLevel` (new) — the review's own depth level, the same argument `/code-review low|medium|high|max` takes. It sizes the finder fleet from the diff instead of a fixed number: about `max(2, min(8, ceil(diff_lines/150)))` reviewers (level floors/caps: low 2-3, medium 3-5, high 4-8, max 5-8), and a max-level review legitimately fans out **10-15+ agents** once verification is included. Defaults to a mapping of `effort` (max→max, xhigh/high→high, medium→medium, low→low). The bundled skill now says this explicitly ("five is the default set, not a cap").
- Why this matters: the native review is not "5 subagents, one pass". Its finder count is diff-derived, and max/ultracode runs add verification phases and workflow orchestration — which is what the "many rounds / 10-15+ concurrent agents" behaviour actually is.
- Reporting: `ultracode` / `review_level` / `workflow_runs` in structuredContent and metadata; `workflowRuns` counts native Workflow dispatches from the stream (direct evidence the orchestration began).
- Suites: shell-guard 67, audit-fixes 226 (+18: fleet rule/level mapping/Workflow allowlist/ultracode settings), validate 16, cross-cases 78/78 free (new C14 proves ultracode reaches the CLI via --settings with the guard hooks intact and that Workflow dispatches are counted).

## 1.10.2 — 2026-10-28

Completeness pass against a full reverse-engineering of the installed claude CLI (2.1.311, Bun single-file executable; the embedded JS bundle extracted module-by-module and analyzed with the REA MCP — application graph: 11k edges, 15k defines, 3.8k calls, evidence exported). The CLI's own protocol docs and schemas, recovered from the bundle, name exactly what a run produces; the MCP was dropping several of those facts:

- **A failed run used to throw the subagent reports away.** `error_max_budget_usd` (five max-effort async subagents can exhaust the cap before the parent synthesizes) returned only the banner — the reports that DID arrive were lost, exactly what happened to this round's own audit. The error path now returns the same `subagents[]`, `modelProvenance`, accounting and a `## Reviewer subagent reports` section as a successful run.
- **`modelUsage` is surfaced.** The result event carries per-model totals for every call through the query pipeline (main loop, Task subagents, sidechains, internal calls) — the authoritative list of models that actually billed. It now appears in structuredContent and as `models_billed` in the metadata, and feeds the substitution check (a foreign billed model is proof even when stream tags were missing/truncated).
- **`subagent_stats` is surfaced.** spawned/completed/failed/`killed{parent,user,system}` (system = the budget halt), `started_in_background`, `by_type`, `max_depth`. The metadata gains a `subagents_completed` line, so a budget-killed reviewer is visible instead of inferred.
- Also surfaced when present: `usage` token totals, `safety_stops`, `terminal_reason`; same on `claude_review_followup` (modelUsage + billed provenance).
- RE notes that shaped this: the Agent tool answers to both `Agent` and `Task`; the SDK spawn API always sets `run_in_background: true`; async completions arrive as `system/task_notification` (status completed/failed/stopped, summary carries the report); `--setting-sources user` is what loads the model-remapping env (already warned about since 1.10.0). Platform limits recorded honestly: REA's Wakaru-based source recovery needs a Linux x64 binary and its native PE analysis needs Ghidra/IDA, so the bundle was carved directly and read at code level, with REA used for artifact inspection, the application graph and evidence export.
- Suites: shell-guard 67, audit-fixes 208 (+9: resultFacts, billed provenance), validate 16, cross-cases 73/73 free + paid C9. New C13 locks that a failed run keeps its reports, provenance and accounting.

## 1.10.1 — 2026-10-28

Fixes from the post-1.10.0 audit round (the MCP reviewing itself with real parallel reviewer subagents — this time they actually ran as async background agents, which is what exposed both headline bugs). The audit run itself was cut by its $15 budget cap after the subagents finished their reports; the findings below are from those reports, each verified against HEAD before fixing:

- **[H] Five parallel dispatches collapsed to one.** The skill dispatches all five reviewers in ONE message so they run in parallel; `streamEventFacts` stored `agentDispatch`/`agentResult`/`bashCommand` as single values, so only the LAST block of each kind survived — 1.10.0 surfaced 1 of 5 reports, and multiple Bash calls in one event undercounted `bashCalls`. The extraction now returns lists; tests cover the one-message-five-blocks shape (the stub emits it too).
- **[H] Async background agents: the report is not the tool_result.** On claude 2.1.x a `general-purpose` Agent dispatch runs asynchronously — the tool_result is "Async agent launched successfully…", and the real report arrives later as `system/task_notification` keyed by the same tool call id (`summary`, `status`). 1.10.0 would have shown the launch ack as the report. Both delivery paths are now extracted, notification preferred, and the status is kept: an agent stopped by the budget renders as `(async, stopped)` with an explicit "no report — status stopped" line instead of silently missing.
- **[M] Guard settings file: two leaks closed.** (a) The in-flight mark was released when `spawn()` returned, but claude reads `--settings` during its own startup — a concurrent env check could delete the file in that window and the run would execute unguarded while claiming hardening. The mark now stays until the child exits (finish() is the only unmark point). (b) 1.9.2 moved the mark into `prepareRunHardening`, so every pre-run refusal (not a repo, git preflight failure, gateway down, gh missing, hostile git config) returned without releasing it — `cleanupGuardSettings()` skips in-flight entries, so the file survived until the 2h sweep. All 12 pre-run refusal sites now release the mark and file before returning.
- **[M] sessionId validation trimmed a different string than the one used.** `validateSessionId` returns the trimmed id, but the followup passed the raw parameter to `--resume`; a whitespace-padded id passed validation yet reached argv intact and died as an opaque "no parseable result". The handler now uses the validated value.
- **[M] `claude_review_env` reported a cached guard verdict.** The 1.9.2 changelog said `{refresh:true}` (what the env tool uses) forces a re-probe; the call site never passed it, so the diagnostic could vouch for a hook replaced up to 5 minutes earlier. It now forces the re-probe.
- **[M] init.mjs crashed on a broken config.** The 1.8.3 changelog claimed EISDIR / unreadable `~/.zcode/cli/config.json` exit cleanly — neither did: a config.json directory crashed with an uncaught EISDIR on write, and a locked file re-threw inside the recovery read. Both now exit 1 with the path and the reason; write failures (read-only/locked) are named too. Helper probes (git/gh) now run with `buildClaudeEnv()` — a GUI/service-launched init no longer misreports a sparse PATH.
- **[L] Packaging/copy drift.** `package.json` `files` ships `README.en.md` (published README links to it); `package-lock.json` version synced to the release (was 1.8.3); the cross-cases docstring says 12 cases (C11/C12 added).
- Suites: shell-guard 67, audit-fixes 199 (+7: multi-block facts, task_notification, init EISDIR), validate 16, cross-cases 65/65 including the paid C9 real e2e. New C12 locks that a pre-run refusal leaves no guard settings file behind.
- Operational note: five real max-effort async subagents can exhaust a $5-15 `maxBudgetUsd` before the parent synthesizes; the run then ends with `error_max_budget_usd` (hint included) and the subagent reports that did finish are still returned. Raise the cap for max-effort whole-repo audits.

## 1.10.0 — 2026-10-28

"Why can't this MCP reproduce the complete output of the same prompt in Claude Code?" — root-caused by reverse-engineering the installed claude CLI (2.1.311, a Bun single-file executable; bundle carved out of the binary and read directly, with the REA MCP driving the target inspection) and diffing six real run logs in `%TEMP%/cc-code-review/`. Two independent causes, both fixed here:

- **The reviewer subagents' reports never reached the caller.** claude 2.1+ forwards subagent activity to the parent stream-json (the `Agent` dispatch tool_use, the subagent's own messages tagged with `agent_id`, and the `tool_result` carrying its final report) — the old parser assumed the opposite ("subagent calls never reach the parent's stream", true of pre-2.1 CLIs) and threw it away. The MCP returned only the parent's synthesis, so the caller saw one summary where Claude Code shows five experts working. The result now carries every dispatched subagent's report: a `## Reviewer subagent reports` section in the text (each capped at 4000 chars, full stream in the log file) and `subagents[]` in structuredContent.
- **The run silently swapped models.** `~/.claude/settings.json`'s env block — written by CC Switch when switching providers — pins `CLAUDE_CODE_SUBAGENT_MODEL=MiniMax-M3.1-Flash` and remaps every `ANTHROPIC_DEFAULT_*_MODEL_NAME` to the same; `--setting-sources user` loads exactly that file. The CLI's own resolution chain (tool > agent frontmatter > env > inherit, verified in the binary) therefore runs all five "expert reviewers" on the substituted model, and claude logs `[claude-code:unrecognized_model] {"model":"MiniMax-M3.1-Flash","query_source":"agent:builtin:general-purpose"}` on stderr for every one. Observed across the run logs: main sessions on step-5-preview / MiniMax-M3 / MiniMax-M3.1-Flash depending on the gateway's current provider. The result now reports **model provenance** (requested vs effective, main + subagents, `modelProvenance` in structuredContent, `effective_model` in the metadata) and a prominent `⚠ MODEL SUBSTITUTION` warning when they differ — the same reports are not comparable to a direct Claude Code session, and the caller is told instead of left to diff two different models' outputs. The same rewrites, plus a process-env `ANTHROPIC_BASE_URL` silently overridden by the settings file (claude applies the settings env over the process env), are also warned about before the run starts.

Also in this round:

- Verified-false on the way: `--permission-mode manual` is NOT being skipped (the init event reports `permissionMode: "default"` because the CLI maps `manual` → `default` — they are the same mode, an alias, not a downgrade); `Task`/`Agent` dispatch IS permitted under the manual allowlist in headless runs (the Oct 19 log's inline-only review was the substituted model's behaviour, not a permission denial); subagent text/thinking does reach the stream without `--forward-subagent-text` on 2.1.311.
- cross-cases C11 (new): end-to-end proof on the extended stub claude — five Agent dispatches with reports and an `unrecognized_model` stderr line must surface in both the text and structuredContent. C10's dead-gateway case now isolates `CLAUDE_CONFIG_DIR` (the real settings.json env was overriding the test's `ANTHROPIC_BASE_URL` — the same precedence this release warns about, caught by the suite itself).
- Suites: shell-guard 67, audit-fixes 192 (+27: streamEventFacts, parseUnrecognizedModels, buildModelProvenance), validate 16, cross-cases 60/60.

## 1.9.2 — 2026-10-18

Fixes verified from another max-effort self-audit (the MCP reviewing its own whole repo — root-commit..HEAD — through the code-review skill; 13 findings reported, 11 verified TRUE and fixed, 1 verified FALSE, 1 documentation-level):

- **[H] the review's own `git status` bypassed git hardening** — gitStatusSnapshot spawned plain `git status --porcelain`, so a repo's `core.fsmonitor` / external diff driver could execute there while every other git call was hardened with `-c` + gitSpawnOpts. Now the only unhardened git spawn site in the codebase is gone (both git call sites go through the same helpers).
- **[H] sessionId / model reached the CLI unvalidated** — a sessionId like `--resume-evil` or a model like `--evil` was interpolated into argv; both are now validated (plain-id charset, length, no leading `-`) on review and followup, before any paid call.
- **[H] followup had no repo/VCS gate** — resuming a session in a non-repo directory produced a doomed paid call; followup now runs the same isRepo check and git preflight as review, with clear errors. ghPreflight is deliberately NOT added: the followup schema carries no scope, and refusing unconditionally would block local-scope followups on machines without gh — a resumed PR-scoped conversation instead surfaces gh's error to the model.
- **[H] repoPath `~user` form silently expanded to nothing** — `~kent/foo` passed through as a relative path; now refused with a message naming the supported `~/` form.
- **[M] pre-spawn abort leaked the guard file** — a client cancelling during preflight left guard settings marked in-flight; an already-aborted signal is now re-checked right before spawn, and the guard settings are removed.
- **[M] guardSelfTest had no cache TTL** — every env probe re-ran the full self-test; results are cached for 5 minutes with `{refresh:true}` (what claude_review_env uses) still forcing a re-probe.
- **[M] huge stderr could still be truncated at the head** — log files kept the first 8000 chars only; now head + tail (last 16000) with an explicit omission marker.
- **[M] include-chain depth capped at 3** — a repo chaining four+ `[include]` levels could hide a driver beyond the scan; the walk now goes 5 deep with cycle protection.
- **[M] init clobbered user env keys and ignored timeoutMs** — the env merge could drop user-added keys on re-registration; now a union with derived gateway keys winning, and the nothing-to-change fast path compares the merged env.
- **[L] stub pidfile could land in the package dir** — moved to the OS temp dir via STUB_PID_FILE, and cross-cases C8 now passes an explicit per-run pidfile (no more vacuous pass).
- [L, verified FALSE] the audit claimed `\\?\`-prefixed paths escape the Windows path handling — Node's path.isAbsolute accepts them and they pass through untouched; no change.
- [L] audit note M2: the redundant second markGuardSettingsInFlight in claude_code_review removed — prepareRunHardening already marks for both tools, so the extra call was reading noise.
- [Docs] both READMEs now state that redirects (`>`, `<`, `2>/dev/null`) are denied by design like chaining, and the zh README's stale check counts (63/158/44) were corrected to the real 67/165/50.
- Suite: 67 + 165 + smoke, validate 16, cross-cases 50/50 (6 new checks: gitSpawnOpts shape, include depth 4, self-test agreement, ~user form, followup sessionId/model/non-repo gates, init env union).
- Audit-quality caveat: this round's reviewer worked inline (TaskCreate=5, TaskUpdate=8, Task/Agent calls = 0) instead of dispatching the 5 parallel subagents — `reviewer_subagents_spawned: 0` is visible in the run metadata, exactly the degradation the field exists to expose.

## 1.9.1 — 2026-10-18

Fixes verified from a max-effort self-audit (the MCP reviewing its own repo through the code-review skill; 2 H reported, 1 verified false, 1 fixed):

- **[H, verified TRUE] followup skipped the repo git-config gate** — the followup child runs the same allowlisted git reads, so a live core.fsmonitor/driver would execute on it too; it now runs the same refusals/notes gate as claude_code_review (notes included in both result shapes).
- [H, verified FALSE] the audit claimed followup never marks its guard file in-flight — the 1.8.3 fix marks inside prepareRunHardening, which both tools call; no change needed.
- **[M, fixed]** waitForResult followups now emit progress notifications (60s cadence, same as review).
- [L, fixed] cross-cases C1 re-covers the followup job lifecycle (must settle, not hang running).
- Note for client maintainers: since 1.9.0 claude_review_followup is async by default — the synchronous reply shape only applies with waitForResult=true.

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
