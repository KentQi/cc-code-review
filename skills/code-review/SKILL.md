---
name: code-review
description: Three-phase code review fleet — parallel finder subagents, one verifier per surviving candidate, one sweep finder — then 0-100 confidence scoring that keeps findings at or above 75 and prints a structured markdown report. Use when asked to review code changes, a pull request, a branch, or the working tree. A portable Agent Skill that runs in any harness supporting Agent Skills and is embedded by the cc-code-review MCP server for its fleet pipeline. Adapted from Anthropic's official code-review plugin.
license: MIT
compatibility: Needs git; PR scopes need the GitHub CLI (gh) authenticated. Subagent fan-out is optional — without a subagent/task tool the phases run sequentially. The cc-code-review MCP server adds its own shell allowlist and fleet numbers; other harnesses use their native tool permissions.
metadata:
  version: "1.19.0"
  homepage: "https://github.com/KentQi/cc-code-review"
---

# Code Review

Run the three-phase review fleet Anthropic's official code-review playbook uses:
establish the diff → gather conventions → a diff-sized fleet of parallel finder
subagents → one-vote verification → confidence scoring → filter → final report.

This file is a portable **Agent Skill** (Agent Skills format). The cc-code-review
MCP server embeds the same body in its fleet prompt, so the pipeline is identical
whether a harness loads this skill or the MCP server runs it inline.

## Review target

The caller tells you WHAT to review — a GitHub PR, a branch range, the working
tree, or the last commit. In auto mode take the FIRST one that applies, in this
order: (1) the GitHub pull request the caller named (if none was named, skip
this step — do not guess one), (2) commits on the current branch ahead of the
default branch, (3) uncommitted changes, (4) the last commit. If both a PR and
local changes exist, review the PR and say what you did about the local changes.

## Procedure

1. **Plan the steps** (use your harness's plan/todo tool when it has one).

2. **Establish the diff**
   - PR: `gh pr view <selector> --json state,title,body` and `gh pr diff <selector>`
     — use the selector EXACTLY as the caller named it. `owner/repo#N` or a PR
     URL pins the repository; a bare number is resolved against the reviewed
     repo's own remote, which can be a different repository, so never reduce a
     full selector to a bare number.
   - Branch range: `git log --oneline <base>..HEAD`, then `git diff <base>...HEAD`
     (the two-dot/dot-dot forms express the same base as `git merge-base`
     without needing that command)
   - Working tree: `git status --porcelain`, `git diff`, `git diff --cached`,
     plus the full content of new untracked files
   - Last commit: `git show --stat HEAD`, `git show HEAD`

   Record the changed-file list and per-file hunks.

3. **Gather conventions**: find the CLAUDE.md / AGENTS.md files (repo root and
   the directories of changed files) that govern the changed code; README and
   CONTRIBUTING rules apply when they state review-relevant conventions.

4. **Reviewer fleet — the same three-phase structure claude's own
   /code-review playbook uses.** When the run prompt carries a
   `Reviewer fleet (level …)` line (the cc-code-review MCP server adds one),
   that line states this run's exact numbers — the finder count, candidates per
   finder and the findings cap. Use it verbatim instead of assuming a fleet
   size; low is a single careful diff pass with no subagents.

   Standalone (no such line): use the five briefs as five finders, one verifier
   per surviving candidate, and one sweep; cap the report only when the caller
   asks for a cap.

   The finder slots are filled from the 5 briefs below: five finders run one brief
   each; when more finders are requested, the extra ones split briefs #1, #2 and
   #3 across file groups (at the heaviest level every brief runs twice). Never
   invent a new angle.

   Then, at every level with a fleet:
   - **Phase 1 — find.** Dispatch the finders together in ONE message/batch when
     your harness has a subagent/task tool (they then run in parallel); without
     fan-out, work through the briefs yourself in order. Each finder returns
     candidates as `{file, line, summary, failure_scenario}`.
   - **Phase 2 — verify (1 vote).** Dedup candidates that point at the same
     line/mechanism, keep at most the candidate cap the prompt states (drop the
     least severe first), then run
     **one verifier subagent per surviving candidate** (send each batch of
     verifiers in ONE message/batch as well): it gets the diff, the file and the
     claim, and answers CONFIRMED / PLAUSIBLE / REFUTED with the evidence. Keep
     CONFIRMED and PLAUSIBLE — score CONFIRMED 85-100, PLAUSIBLE 75-84 (the 75
     anchor), REFUTED 0 (dropped).
   - **Phase 3 — sweep.** One more finder, a fresh reviewer that sees the
     verified list, looks ONLY for gaps it does not already contain.

   That is `finders + one-verifier-per-candidate + 1 sweep` subagents, so the
   total legitimately exceeds the findings cap. **If your harness has no
   subagent/task tool, do every angle and every verification yourself,
   sequentially — never skip an angle for lack of fan-out.** Give each subagent
   the diff (or the exact commands to obtain it) plus its brief.

   **Subagent briefing.** A subagent starts fresh: it does not see this file or
   your conversation. Every subagent prompt must carry its brief, the diff (or
   the exact read-only commands that produce it), and a shell contract. When the
   run prompt supplies an explicit contract (the cc-code-review MCP server
   does), copy it verbatim — a subagent that guesses at its shell burns turns on
   calls the guard refuses. Otherwise give this default read-only briefing,
   adapting tool names to your harness:

   > Your working directory is already the repository root. Every shell call
   > runs there, so never prefix a command with `cd`, `git -C`, or an absolute
   > path. Stay read-only: git status/diff/show/log/blame/rev-parse/ls-files,
   > git branch -a|--show-current|-vv, git remote -v|get-url|show, git stash
   > list|show, find, rg, ls, grep, and gh pr view|diff|list|checks / gh repo
   > view. Commands may be combined with `&&`, `;` or `|` as long as EVERY part
   > is one of those read-only commands (after a pipe: head, tail, cat, wc,
   > uniq, cut, tr, grep, sort). No redirection (`>`, `>>`, `<`), no
   > `$(...)`/backticks/`${...}`/bare `$VAR`, no `&`, and no ANSI-C quoting
   > (`$'...'`). Reads must stay inside the repository: search from `.`. For
   > file contents and line ranges prefer your harness's file-read/search tools
   > (they are confined to the repository as well); secret files (.env, keys,
   > credentials) are refused.

   In a cc-code-review MCP run the shell guard enforces exactly these rules and
   additionally refuses `echo` expansion/globs, `sed`, and every write form; a
   denied call costs the run a turn, so stay inside the list above.

   Every subagent returns ONLY a JSON list of candidate issues — the same shape
   claude's own playbook uses:
   `{"file": "src/auth.js", "line": 12, "summary": "one sentence", "failure_scenario": "the concrete scenario in which the code misbehaves", "category": "bug|conventions|historical|prev-pr|code-comment"}`.

   - **#1 Conventions** — audit the changes against the CLAUDE.md / AGENTS.md
     files found in step 3. Those files guide code *writing*, so not every
     instruction applies to review. `summary` must quote the exact instruction.
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
     documented invariants). `summary` quotes the comment and explains the
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

   For convention findings, double-check the CLAUDE.md / AGENTS.md actually calls
   out that issue specifically.

6. **Filter** — keep only findings with score >= 75. With step 4's mapping this
   keeps exactly the CONFIRMED and PLAUSIBLE findings: the threshold and the
   phase-2 rule select the same set. Apply the false-positive
   filter at steps 4 and 5; drop findings that are:
   - pre-existing issues not introduced by these changes
   - something that looks like a bug but is not
   - pedantic nitpicks a senior engineer would not raise
   - anything a linter / typechecker / compiler / CI would catch
   - generic quality issues (tests, docs, security hardening) unless required
     by CLAUDE.md / AGENTS.md
   - convention issues explicitly silenced in code (lint-ignore comments)
   - behavior changes that are likely intentional
   - real issues on lines the changes did not modify

7. **Final report** — print as your FINAL message (this is the deliverable).
   Do NOT post anything to GitHub unless the caller explicitly named a PR to post
   it to. If posting was requested but no PR was named, report that a PR is
   required instead of guessing one.
   Keep the H2 headings exactly as written below, in English, regardless of the
   report language; translate only the body text.

   ```markdown
   ## Code Review Summary
   <verdict: approve | request-changes | comment> — <2-4 sentences>

   ## Findings (N)
   Ordered critical -> nit. For each finding:
   ### [SEVERITY] short title — `path/to/file.ext:12-18`
   - **What / Why**: what is wrong and why it matters
   - **Fix**: concrete suggested fix
   - **Evidence**: quote from the diff / CLAUDE.md / history
   (severity: critical | major | minor | nit)

   ## Notes
   <questions for the author; sub-threshold observations — optional>
   ```

   If no finding survives the filter, write `## Findings (0)` followed by:
   "No issues found. Checked for bugs and CLAUDE.md compliance."

## Rules

- Do NOT build, typecheck, or lint — CI handles that. This is a review pass.
- Use `gh` (not web fetching) for anything on GitHub.
- Every finding must cite `file:line`.
- Keep the final report tight; no filler.

## Fix mode (only when the caller explicitly asks)

If the caller asks you to fix the findings as well — and your harness grants
write tools (the cc-code-review MCP server's fix mode does):

1. First produce the full review report exactly as above.
2. Then apply fixes directly to the repository files: one minimal diff per
   finding, following repo conventions, no unrelated refactoring, no
   reformatting. Never run `git commit` — leave changes in the working tree.
3. Findings that need a business decision (rounding policy, API contract,
   ...) stay unfixed; note them under Notes instead.
4. Append a final `## Fixes Applied` section: for each fix, the file, what
   changed, and which finding it addresses.

In a harness that gives you no write tools, do not pretend to fix: describe the
exact patch (file:line plus the code) and say it needs a fix-capable run.

## Harness notes

- **cc-code-review MCP server** (fleet / skill pipelines): the run prompt states
  the exact fleet numbers, the report language, the shell contract and the fix
  boundary. Follow those lines over any default in this file.
- **Claude Code**: fan-out uses the Agent tool (background/async mode); file
  tools are Read / Grep / Glob / Edit / Write; a todo tool is available.
- **Other Agent Skills harnesses** (ZCode, Cursor, Codex-style clients, custom
  agents): map "Agent tool" to your subagent/task/parallel dispatcher, "Read /
  Grep / Glob" to your file-read/search tools, and "todo tool" to your planner.
  Use whatever fan-out you have; do not invent a tool you do not have.
- **No fan-out**: running the five briefs and the verifications yourself,
  sequentially, is a conformant run — never skip an angle for lack of fan-out.
- **Read-only**: outside fix mode this skill never writes; report only.
