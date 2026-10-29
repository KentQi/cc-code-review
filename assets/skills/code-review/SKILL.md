---
name: code-review
description: Comprehensive code review pipeline with the same three-phase fleet claude's own /code-review uses — parallel finder subagents (8 at medium/high, 10 at max), one verifier per surviving candidate, a sweep finder — then 0-100 confidence scoring, keeps only findings >= 80, outputs a structured markdown report. Use when asked to review code changes, a pull request, a branch, or the working tree. Adapted from Anthropic's official code-review plugin.
---

# Code Review

Run the Anthropic official code-review pipeline: establish the diff → gather
conventions → a diff-sized fleet of parallel reviewer subagents → confidence
scoring → filter → final report.

## Review target

The caller tells you WHAT to review — a GitHub PR, a branch range, the working
tree, or the last commit. If nothing specific is given, detect in this order:
(1) uncommitted changes, (2) commits on the current branch ahead of the default
branch, (3) the last commit.

## Procedure

1. **Make a todo list** of these steps first.

2. **Establish the diff**
   - PR: `gh pr view <N> --json state,title,body` and `gh pr diff <N>`
   - Branch range: `git merge-base <base> HEAD`, then `git diff <base>...HEAD`
   - Working tree: `git status --porcelain`, `git diff`, `git diff --cached`,
     plus the full content of new untracked files
   - Last commit: `git show --stat HEAD`, `git show HEAD`

   Record the changed-file list and per-file hunks.

3. **Gather conventions**: find the CLAUDE.md / AGENTS.md files (repo root and
   the directories of changed files) that govern the changed code.

4. **Reviewer fleet — the same three-phase structure claude's own
   /code-review playbook uses.** The level sets the fleet, not the diff:
   - **low**: one careful diff pass, no subagents, at most 4 findings.
   - **medium / high**: 8 finder subagents (3+5 angles × 6 candidates).
   - **max / xhigh**: 10 finder subagents (5+5 angles × 8 candidates).

   Then, at every level with a fleet:
   - **Phase 1 — find.** Dispatch the finders in ONE message (they run in
     parallel). The briefs below are the default set; on a large diff split a
     brief across files rather than inventing new angles. Each finder returns
     candidates as `{file, line, summary, failure_scenario}`.
   - **Phase 2 — verify (1 vote).** Dedup candidates that point at the same
     line/mechanism, then run **one verifier subagent per surviving candidate**
     (send each batch of verifiers in ONE message as well):
     it gets the diff, the file and the claim, and answers CONFIRMED /
     PLAUSIBLE / REFUTED with the evidence. Keep CONFIRMED and PLAUSIBLE.
   - **Phase 3 — sweep.** One more finder, as a fresh reviewer that sees the
     verified list, looks ONLY for gaps it does not already contain.

   That is `finders + one-verifier-per-candidate + 1 sweep` subagents, so a
   max-level review legitimately exceeds 15 in total. If the Agent tool is not
   available, do every angle and every verification yourself, sequentially —
   never skip an angle for lack of fan-out. Give each subagent the diff (or the
   exact commands to obtain it) plus its brief.

   **Include this execution contract verbatim in EVERY subagent prompt** — a
   subagent does not see this file, and a subagent that guesses at its shell
   burns turns on calls the guard refuses:

   > Your working directory is already the repository root. Every Bash call runs
   > there, so never prefix a command with `cd`, `git -C`, or an absolute path.
   > Allowed Bash programs: git status/diff/show/log/blame/rev-parse/ls-files,
   > git branch -a|--show-current|-vv, git remote -v|get-url|show, git stash
   > list|show, find, rg, and gh pr view|diff|list|checks / gh repo view.
   > Commands may be combined with `&&`, `;` or `|` as long as EVERY part is one
   > of those read-only commands (after a pipe: head, tail, cat, wc, uniq, cut,
   > tr, grep, sort, sed -n; `echo` is allowed anywhere). No redirection (`>`,
   > `>>`, `<`), no `$(...)` or backticks, no `&`. Reads must stay inside the
   > repository: `rg`/`find` with an outside path (`~`, `..`, an absolute path
   > elsewhere) is refused, so search from `.`. For file contents prefer the
   > Read/Grep/Glob tools.

   Every subagent returns ONLY a JSON list of issues:
   `{"file": "...", "line_range": "12-18", "reason": "...", "category": "..."}`.

   - **#1 Conventions** — audit the changes against the CLAUDE.md / AGENTS.md
     files found in step 3. Those files guide code *writing*, so not every
     instruction applies to review. `reason` must quote the exact instruction.
     category: `conventions`
   - **#2 Bug scan** — shallow scan of the diff itself. Focus on LARGE bugs;
     avoid small issues and nitpicks; do not read context beyond the changes;
     ignore likely false positives. category: `bug`
   - **#3 Git history** — `git log -p --follow <file>` and `git blame` on the
     changed lines; identify bugs in light of that history (e.g. the change
     reverts a deliberately-introduced fix). category: `historical`
   - **#4 Previous PRs** (GitHub repos only) — `gh pr list --state all
     --search "<file>"`; check the comments on those PRs for feedback that
     also applies to the current changes. If `gh` is unavailable or the repo
     is not on GitHub, skip gracefully. category: `prev-pr`
   - **#5 In-code comments** — read the changed files; changes must comply
     with guidance in nearby code comments (TODO / HACK / NOTE / WARNING /
     documented invariants). `reason` quotes the comment and explains the
     violation. category: `code-comment`

5. **Confidence scoring** — each surviving candidate already carries its
   verifier's vote (CONFIRMED / PLAUSIBLE / REFUTED) and the evidence it used;
   turn that into the 0-100 score below (REFUTED = 0):

   ```
   0   : False positive that doesn't survive light scrutiny, or pre-existing.
   25  : Might be real, might be FP. If stylistic, not explicitly in CLAUDE.md.
   50  : Verified real but may be a nitpick or rare.
   75  : Real, important, will be hit in practice OR directly mentioned in the
         relevant CLAUDE.md.
   100: Absolutely certain. Evidence directly confirms it.
   ```

   For convention findings, double-check the CLAUDE.md actually calls out that
   issue specifically.

6. **Filter** — keep only findings with score >= 80. Apply the false-positive
   filter at steps 4 and 5; drop findings that are:
   - pre-existing issues not introduced by these changes
   - something that looks like a bug but is not
   - pedantic nitpicks a senior engineer would not raise
   - anything a linter / typechecker / compiler / CI would catch
   - generic quality issues (tests, docs, security hardening) unless required
     by CLAUDE.md
   - convention issues explicitly silenced in code (lint-ignore comments)
   - behavior changes that are likely intentional
   - real issues on lines the changes did not modify

7. **Final report** — print as your FINAL message (this is the deliverable).
   Do NOT post anything to GitHub unless the caller explicitly asked:

   ```markdown
   ## Code Review Summary
   <verdict: approve | request-changes | comment> — <2-4 sentences>

   ## Findings (N)
   Ordered critical -> minor. For each:
   ### [SEVERITY] short title — `path/to/file.ext:12-18`
   - **What / Why**: ...
   - **Fix**: concrete suggested fix
   - **Evidence**: quote from the diff / CLAUDE.md / history
   (severity: critical | major | minor | nit)

   ## Notes
   <questions for the author; sub-threshold observations — optional>
   ```

   If no findings survive the filter: "No issues found. Checked for bugs and
   CLAUDE.md compliance."

## Rules

- Do NOT build, typecheck, or lint — CI handles that. This is a review pass.
- Use `gh` (not WebFetch) for anything on GitHub.
- Every finding must cite `file:line`.
- Keep the final report tight; no filler.

## Fix mode (only when the caller explicitly asks)

If the caller asks you to fix the findings as well:

1. First produce the full review report exactly as above.
2. Then apply fixes directly to the repository files: one minimal diff per
   finding, following repo conventions, no unrelated refactoring, no
   reformatting. Never run `git commit` — leave changes in the working tree.
3. Findings that need a business decision (rounding policy, API contract,
   ...) stay unfixed; note them under Notes instead.
4. Append a final `## Fixes Applied` section: for each fix, the file, what
   changed, and which finding it addresses.
