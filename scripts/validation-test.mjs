#!/usr/bin/env node
/**
 * Free validation-path tests (no Claude credits): every case below must fail
 * BEFORE any paid run starts. Exercises claude_code_review / claude_review_env
 * through the real MCP stdio interface.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { connectServer } from "./lib/mcp-client.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
// The stub CLI keeps the skill round-trip below free and host-independent.
const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-claude.mjs");

// Shared stdio client (audit Q20): JSON-RPC framing / timeout / pending map.
const srv = connectServer({
  args: [serverPath],
  timeoutMs: 60_000,
  clientInfo: { name: "validation-test", version: "0.0.1" },
});
await srv.initialize();

const call = (name, args) => srv.call(name, args);
const textOf = (r) => r.result?.content?.[0]?.text ?? "";
const results = [];
const check = (label, cond, detail = "") => {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : ` — ${detail}`}`);
};

// a throwaway empty git repo (initialized, no commits, no changes)
const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "empty-repo-"));
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "ignore" });

// a repo with one commit but nothing to review (clean tree)
const cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clean-repo-"));
fs.writeFileSync(path.join(cleanRepo, "a.txt"), "hello\n");
for (const cmd of [["init"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-m", "x"]]) {
  try { execFileSync("git", cmd, { cwd: cleanRepo, stdio: "ignore" }); } catch { /* ignore */ }
}

// 1. relative repoPath must be refused
let r = await call("claude_code_review", { repoPath: "some/relative/path", scope: "last-commit" });
check("relative repoPath refused", r.result?.isError === true && /must be an absolute path/i.test(textOf(r)), textOf(r).slice(0, 160));

// 2. pr injection string refused
r = await call("claude_code_review", { repoPath: cleanRepo, pr: '1"; rm -rf / #' });
check("malicious pr refused", r.result?.isError === true && /pr must be a PR number/i.test(textOf(r)), textOf(r).slice(0, 160));

// 3. outputLanguage injection refused. Keep the payload SHORT (< 20 chars): the
// 20-char cap is checked first, and the long version of this string would be
// refused for length instead of proving the single-line rule.
r = await call("claude_code_review", { repoPath: cleanRepo, outputLanguage: "English\nx" });
check("multi-line outputLanguage refused", r.result?.isError === true && /single line/i.test(textOf(r)), textOf(r).slice(0, 160));

// 3b. baseRef that would be parsed as a git option refused (`--output=<file>` writes a file)
r = await call("claude_code_review", { repoPath: cleanRepo, scope: "branch", baseRef: "--output=/tmp/pwn" });
check("baseRef starting with '-' refused", r.result?.isError === true && /must not start with "-"/i.test(textOf(r)), textOf(r).slice(0, 200));

// 3b2. ".." / "..." are REVISION RANGE operators, not refs. The prompt appends
// its own "..HEAD"/"...HEAD", so baseRef="main..x" rendered
// `git log --oneline main..x..HEAD` and the review silently examined a
// materially different diff. Only the leading-"-" branch of validateBaseRef was
// tested; deleting the ".." check left the whole gate green (audit P2-14).
r = await call("claude_code_review", { repoPath: cleanRepo, scope: "branch", baseRef: "main..x" });
check("baseRef with '..' (a revision range) refused",
  r.result?.isError === true && /single ref, not a revision range/i.test(textOf(r)), textOf(r).slice(0, 220));
r = await call("claude_code_review", { repoPath: cleanRepo, scope: "branch", baseRef: "main...x" });
check("baseRef with '...' (a revision range) refused",
  r.result?.isError === true && /single ref, not a revision range/i.test(textOf(r)), textOf(r).slice(0, 220));

// 3c. focus is caller DATA: control characters / absurd length refused before it reaches the prompt
r = await call("claude_code_review", { repoPath: cleanRepo, focus: "look at this\u0000\u0001 carefully" });
check("focus with control characters refused", r.result?.isError === true && /control characters/i.test(textOf(r)), textOf(r).slice(0, 200));
r = await call("claude_code_review", { repoPath: cleanRepo, focus: "x".repeat(5000) });
check("oversized focus refused", r.result?.isError === true && /<= 2000 chars/i.test(textOf(r)), textOf(r).slice(0, 200));

// 3d. Both prompt-injection surfaces are refused BEFORE any run (P2-7 / P3-1):
//     a newline lets caller data restructure the prompt, and outputLanguage is
//     a language NAME, not a sentence. Each assertion names the message so a
//     refusal for the WRONG reason (e.g. the repo path) cannot pass.
r = await call("claude_code_review", { repoPath: cleanRepo, focus: "a\nb" });
check("focus with a newline refused",
  r.result?.isError === true && /focus must not contain control characters/.test(textOf(r)) && !/repoPath/.test(textOf(r)),
  textOf(r).slice(0, 200));
r = await call("claude_code_review", { repoPath: cleanRepo, outputLanguage: "a".repeat(21) });
check("outputLanguage over 20 chars refused",
  r.result?.isError === true && /outputLanguage must be a short language name/.test(textOf(r)) && /20/.test(textOf(r)),
  textOf(r).slice(0, 200));
r = await call("claude_code_review", { repoPath: cleanRepo, outputLanguage: "English." });
check("outputLanguage with sentence punctuation refused",
  r.result?.isError === true && /outputLanguage must be a language name/.test(textOf(r)) && !/repoPath/.test(textOf(r)),
  textOf(r).slice(0, 200));
// 3e. The PR value becomes the native command target; a leading "-" would turn
//     it into a claude/git flag (P3-3).
r = await call("claude_code_review", { repoPath: cleanRepo, pr: "-owner/repo#1" });
check("pr with a leading dash refused",
  r.result?.isError === true && /^pr must be/.test(textOf(r)) && !/repoPath/.test(textOf(r)),
  textOf(r).slice(0, 200));

// 4. empty repo (no commits, no changes) refused before any run
r = await call("claude_code_review", { repoPath: emptyRepo, scope: "auto" });
check("empty repo refused", r.result?.isError === true && /no commits and no uncommitted changes/i.test(textOf(r)), textOf(r).slice(0, 200));

// 5. clean repo (commit exists, nothing changed) must NOT be refused by preflight.
//    This check ACTUALLY STARTS a paid claude run (bounded by maxBudgetUsd), so it
//    is opt-in: set CC_REVIEW_ALLOW_PAID_PROBE=1. The suite header promises "no
//    Claude credits", and on a credentialed machine this was the one check that
//    broke that promise. Skipped by default; note the skip so the count stays honest.
if (process.env.CC_REVIEW_ALLOW_PAID_PROBE === "1") {
  r = await call("claude_code_review", { repoPath: cleanRepo, scope: "auto", maxBudgetUsd: 0.02, timeoutMinutes: 2, waitForResult: true });
  check("clean repo passes preflight (only later failure possible)", !/no commits and no uncommitted changes|not a version-controlled|must be an absolute/i.test(textOf(r)), textOf(r).slice(0, 200));
} else {
  console.log("skip  clean repo passes preflight (starts a paid run; set CC_REVIEW_ALLOW_PAID_PROBE=1 to include)");
}

// 5b. a plain directory that is not a repo at all is refused before any paid run
const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-dir-"));
fs.writeFileSync(path.join(plainDir, "a.txt"), "hello\n");
r = await call("claude_code_review", { repoPath: plainDir, scope: "auto" });
check("non-repo directory refused", r.result?.isError === true && /not a version-controlled repository/i.test(textOf(r)), textOf(r).slice(0, 200));

// 6. maxBudgetUsd=0 must be accepted by the schema (0 = disable cap). Verified
//    for free: a nonexistent absolute path fails the existence check, so any
//    zod complaint about the budget would be the only possible error. The path
//    is built from this host's tmpdir — "C:/..." is absolute only on Windows,
//    so the old form tripped the "must be absolute" preflight on POSIX and
//    never reached the existence check this case is about. The pid keeps the
//    path collision-free while still guaranteeing it does not exist.
const missingRepo = path.join(os.tmpdir(), "no-such-repo-" + process.pid);
r = await call("claude_code_review", { repoPath: missingRepo, maxBudgetUsd: 0 });
check("maxBudgetUsd=0 accepted (not a zod error)", r.result?.isError === true && /does not exist/i.test(textOf(r)), textOf(r).slice(0, 200));
r = await call("claude_review_followup", { sessionId: "00000000-0000-0000-0000-000000000000", message: "hi", repoPath: missingRepo, maxBudgetUsd: 0 });
check("followup maxBudgetUsd=0 accepted", r.result?.isError === true && /does not exist/i.test(textOf(r)), textOf(r).slice(0, 200));

// 7. env tool exposes a machine-readable verdict
r = await call("claude_review_env", {});
check("env tool verdict line present", /^verdict: (OK|NOT_FOUND|MISCONFIGURED)/m.test(textOf(r)), textOf(r).slice(0, 120));
check("env tool reports git+gh", /git: ok/.test(textOf(r)) && /gh: ok/.test(textOf(r)), textOf(r).slice(0, 120));

// 8. followup also refuses a relative repoPath
r = await call("claude_review_followup", { sessionId: "00000000-0000-0000-0000-000000000000", message: "hi", repoPath: "rel/path" });
check("followup refuses relative repoPath", r.result?.isError === true && /must be an absolute path/i.test(textOf(r)), textOf(r).slice(0, 160));

// 8b. cancel=true without a jobId used to be silently ignored and returned the
//     job list, so a caller that dropped the jobId believed it cancelled
//     something (P-11). It must be an error that says what is missing.
r = await call("claude_review_status", { cancel: true });
check("cancel without a jobId refused",
  r.result?.isError === true && /cancel requires a jobId/.test(textOf(r)), textOf(r).slice(0, 200));

// 8c. Inbound message size is bounded before anything reaches the prompt (P-16).
//     The bound is 100000 chars; 100001 must be refused with the field name.
r = await call("claude_review_followup", {
  sessionId: "00000000-0000-0000-0000-000000000000",
  message: "x".repeat(100_001),
  repoPath: cleanRepo,
});
check("followup message over 100000 chars refused",
  r.result?.isError === true && /at most 100000 character\(s\) at message/.test(textOf(r)),
  textOf(r).slice(0, 200));
// ...and the boundary itself is accepted by the schema (it fails later, on the
// bogus repo, not on the message): proves the check is a MAX, not "message bad".
r = await call("claude_review_followup", {
  sessionId: "00000000-0000-0000-0000-000000000000",
  message: "x".repeat(100_000),
  repoPath: missingRepo,
});
check("followup message at the 100000-char boundary is accepted",
  r.result?.isError === true && /does not exist/.test(textOf(r)) && !/at most/.test(textOf(r)),
  textOf(r).slice(0, 200));

srv.close();

/* ---- 9. the shell guard must be fail-closed (separate server, env overridden) ---- */
// A review with a disarmed PreToolUse hook would let a repo-controlled or
// prompt-injected command chain run with the review's own permissions, so the
// server refuses instead. The guard gate runs before the repo checks, which is
// what makes this checkable for free (bogus repoPath, no paid run).
// A second server with an overridden env (same shared client).
const withServer = async (env, fn) => {
  const c = connectServer({
    args: [serverPath],
    env: { ...process.env, ...env },
    timeoutMs: 60_000,
    clientInfo: { name: "guard-test", version: "0.0.1" },
  });
  await c.initialize();
  try {
    await fn((name, args) => c.call(name, args));
  } finally {
    c.close();
  }
};

// Same host-relative rule as check 6: an absolute path that is guaranteed not
// to exist, so the guard-gate assertions below are not decided by a platform
// path-parse accident.
const bogusRepo = path.join(os.tmpdir(), "no-such-repo-for-guard-test-" + process.pid);
await withServer({ CLAUDE_REVIEW_SHELL_GUARD: "0" }, async (call2) => {
  const rr = await call2("claude_code_review", { repoPath: bogusRepo, scope: "last-commit" });
  const t2 = rr.result?.content?.[0]?.text ?? "";
  check("guard off: review refused (fail closed)", rr.result?.isError === true && /Refusing to run unguarded/i.test(t2), t2.slice(0, 200));
  const rf = await call2("claude_review_followup", { sessionId: "00000000-0000-0000-0000-000000000000", message: "hi", repoPath: bogusRepo });
  const tf = rf.result?.content?.[0]?.text ?? "";
  check("guard off: followup refused too", rf.result?.isError === true && /Refusing to run unguarded/i.test(tf), tf.slice(0, 200));
});
await withServer({ CLAUDE_REVIEW_SHELL_GUARD: "0", CLAUDE_REVIEW_ALLOW_UNGUARDED: "1" }, async (call2) => {
  // The override must let the call through to the NEXT check (the repo path),
  // which proves the guard gate is what refused it above.
  const rr = await call2("claude_code_review", { repoPath: bogusRepo, scope: "last-commit" });
  const t2 = rr.result?.content?.[0]?.text ?? "";
  check("CLAUDE_REVIEW_ALLOW_UNGUARDED=1 overrides the refusal",
    rr.result?.isError === true && /does not exist/i.test(t2) && !/Refusing to run unguarded/i.test(t2), t2.slice(0, 200));
});

/* ---- 9b. installSkill -> uninstallSkill round trip (audit P2-16) ---- */
// uninstallSkill=true is how a user un-shadows claude's built-in /code-review:
// it must delete ONLY the files this server wrote (SKILL.md + the marker) and
// keep whatever the user added there. It had ZERO coverage — the previous
// round's crash (a missing import, one call away) was found by reading, not by
// a test. A throwaway skill dir keeps ~/.claude untouched.
{
  const skillDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-rt-")), "code-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "notes.md"), "user note\n");
  await withServer({ CLAUDE_CODE_PATH: STUB, CLAUDE_REVIEW_SKILL_DIR: skillDir }, async (call2) => {
    const installed = await call2("claude_review_env", { installSkill: true });
    const it = textOf(installed);
    check("installSkill installs the bundled skill (SKILL.md + ownership marker)",
      fs.existsSync(path.join(skillDir, "SKILL.md"))
      && fs.existsSync(path.join(skillDir, "installed-by-cc-code-review"))
      && /installSkill: installed/.test(it), it.slice(-200));
    let bundledBytes = 0;
    try { bundledBytes = fs.statSync(path.join(skillDir, "SKILL.md")).size; } catch { /* asserted below */ }
    check("installSkill wrote the real bundled pipeline", bundledBytes > 1000, String(bundledBytes));
    const un = await call2("claude_review_env", { uninstallSkill: true });
    const ut = textOf(un);
    check("uninstallSkill removes the two files this server wrote",
      !fs.existsSync(path.join(skillDir, "SKILL.md"))
      && !fs.existsSync(path.join(skillDir, "installed-by-cc-code-review")), ut.slice(-200));
    check("uninstallSkill keeps the user's own file and the directory",
      fs.existsSync(path.join(skillDir, "notes.md")) && fs.existsSync(skillDir), ut.slice(-200));
    check("uninstallSkill reports the removal", /uninstallSkill: removed/.test(ut), ut.slice(-200));
  });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${failed.length === 0 ? "ALL VALIDATION TESTS PASSED" : `${failed.length} FAILED`} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
