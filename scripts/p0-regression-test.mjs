#!/usr/bin/env node
/**
 * P0 regression suite — the security holes found by the 2026-10 multi-expert
 * audit, locked at the layer that actually enforces them.
 *
 * Every Bash/write case here spawns the REAL PreToolUse hook process with a real
 * payload: the hook is the deterministic control, so a unit test of
 * analyseCommand() alone would not catch a hook that forgets to call it. The
 * repo-scan cases call repoRunsGitPrograms() directly (it is the only gate
 * between a repository-supplied git config and arbitrary command execution).
 *
 * Free and offline: no claude CLI, no network, no paid run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseCommand, bashAllowRules } from "../src/shell-guard.js";
import { postPROnlyTools } from "../src/prompt.js";
import { repoRunsGitPrograms } from "../src/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, "scripts", "pre-tool-hook.js");
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "p0-regression-"));

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  failures.push(label + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
  console.log("FAIL  " + label + "\n        got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

/** Run the live hook. Returns "ALLOW" (no decision) or "DENY".
 *  `repoRoot` overrides the root the hook is told to enforce; the payload cwd
 *  stays REPO so a test can isolate "the declared root is unusable". */
function hook(toolName, toolInput, repoRoot = REPO) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: REPO });
  let out = "";
  try {
    out = execFileSync(process.execPath, [HOOK], {
      input: payload,
      env: { ...process.env, CLAUDE_REVIEW_REPO_ROOT: repoRoot },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    });
  } catch {
    return "DENY"; // a hook that crashes denies (fail closed)
  }
  return out.trim() === "" ? "ALLOW" : "DENY";
}
const bash = (cmd) => hook("Bash", { command: cmd });
const write = (rel) => hook("Write", { file_path: path.join(REPO, rel) });

/* ------------------------------------------------------------------ */
/* P0-1: the parser must judge bash's argv, not the raw string.        */
/* ANSI-C quoting ($'...') and backslash escapes are expanded by bash  */
/* before the command runs, so every token-exact deny table used to be */
/* blind to the flag hidden inside them.                              */
/* ------------------------------------------------------------------ */
console.log("-- P0-1 ANSI-C / backslash escapes are refused");
for (const cmd of [
  "find . -name x $'-exec' sh -c id ;",
  "find . -name x $'-delete' ;",
  "git diff $'--no-index' /etc/passwd /etc/hosts",
  "git diff $'--output=/tmp/pwn'",
  "git log $'--output=/tmp/pwn'",
  "git blame $'--contents' /etc/passwd HEAD",
  "rg $'--pre=sh' x",
  "git diff \\--output=/tmp/pwn",
  "find . -maxdepth 0 \\-exec echo x \\;",
  "git blame \\--contents /etc/passwd HEAD",
]) {
  check("bash DENY: " + JSON.stringify(cmd), bash(cmd), "DENY");
}

/* ------------------------------------------------------------------ */
/* P0-2: short options may glue their value (-o/tmp/x, -f/etc/passwd).  */
/* A value-taking short option must reach both the path check and the  */
/* flag deny table; treating "-xVALUE" as self-contained hid both.     */
/* ------------------------------------------------------------------ */
console.log("-- P0-2 glued short options are refused");
for (const cmd of [
  "git log | sort -o/tmp/pwn",
  "git log | sort -T/tmp",
  "rg -f/etc/passwd",
  "grep -f/etc/passwd",
  "git ls-files -X/etc/passwd",
  "sort --random-source=/etc/passwd",
]) {
  check("bash DENY: " + JSON.stringify(cmd), bash(cmd), "DENY");
}
// The spaced forms were already denied; keep them locked.
for (const cmd of ["find . -name x -exec sh -c id \\;", "git diff --output=/tmp/pwn", "git log | sort -o /tmp/pwn"]) {
  check("bash DENY (spaced form): " + JSON.stringify(cmd), bash(cmd), "DENY");
}

/* ------------------------------------------------------------------ */
/* P0-1 / P0-2 (round 2): the read boundary covers `echo` and sinks.   */
/* `echo $SECRET` prints a credential the model never read; `echo ~/*` */
/* and `echo ../*` expand to outside paths. `tr` takes a FILE         */
/* operand like every other pipe sink; it was the one sink exempted    */
/* from the path check, so its outside read was allowed.               */
/* ------------------------------------------------------------------ */
console.log("-- P0-1/P0-2 echo + tr read boundary");
for (const cmd of [
  "echo $ANTHROPIC_API_KEY",
  "echo ~/*",
  "echo ../*",
  "echo hi | tr a b /etc/passwd",
]) {
  check("bash DENY: " + JSON.stringify(cmd), bash(cmd), "DENY");
}
check("bash ALLOW: echo hi | tr a b", bash("echo hi | tr a b"), "ALLOW");

/* ------------------------------------------------------------------ */
/* P0-3 (round 2): a repo root that does not resolve must fail CLOSED.  */
/* The Read branch caught a throw out of containment and fell through  */
/* to "allow", so an unusable root disabled the boundary.              */
/* ------------------------------------------------------------------ */
console.log("-- P0-3 Read fails closed when the repo root is gone");
const GONE = path.join(os.tmpdir(), "p0-regression-gone-" + process.pid);
check("Read DENY: repo root does not exist", hook("Read", { file_path: path.join(GONE, "secret.txt") }, GONE), "DENY");

/* ------------------------------------------------------------------ */
/* P1-6: an absolute path under a symlinked prefix is inside the repo.  */
/* /tmp and /var are symlinks on macOS; realpath(root) != root, so the  */
/* old lexical check refused every legitimate absolute-path read.       */
/* ------------------------------------------------------------------ */
console.log("-- P1-6 realpath is applied to both sides");
for (const cmd of ['find "' + REPO + '" -name x', 'ls "' + REPO + '"', 'find "' + fs.realpathSync(REPO) + '" -name x']) {
  check("bash ALLOW: " + JSON.stringify(cmd), bash(cmd), "ALLOW");
}

/* ------------------------------------------------------------------ */
/* Baseline: the read-only surface a review actually needs stays open.  */
/* ------------------------------------------------------------------ */
console.log("-- baseline read-only commands stay allowed");
for (const cmd of [
  "git status", "git diff", "git diff HEAD", "git log --oneline -5", "git show HEAD:src/index.js",
  "git show HEAD:src/index.js | head -50", "git blame -L 1,50 src/index.js", "git diff | wc -l",
  "rg -n TODO src", "grep -rn shell src", "find . -name '*.js'", "ls -la", "git status && git diff",
  'cd "' + REPO + '" && git show HEAD',
]) {
  check("bash ALLOW: " + JSON.stringify(cmd), bash(cmd), "ALLOW");
}

/* ------------------------------------------------------------------ */
/* P1-4: postToPR. The hook must not refuse the one command the grant  */
/* authorises, and the review permission render must not include it.   */
/* ------------------------------------------------------------------ */
console.log("-- P1-4 gh pr comment: hook allows, review grant does not");
check("bash ALLOW: gh pr comment", bash("gh pr comment 123 --body hi"), "ALLOW");
check("bash ALLOW: gh pr view", bash("gh pr view 123"), "ALLOW");
check("bashAllowRules() excludes gh pr comment", bashAllowRules().some((r) => /pr comment/.test(r)), false);
check("postPROnlyTools() grants gh pr comment", postPROnlyTools().includes("Bash(gh pr comment:*)"), true);

/* ------------------------------------------------------------------ */
/* P0-6 / P0-7: fix mode may edit source, never plant persistence.      */
/* Case-insensitive on purpose: macOS/Windows resolve .GIT to .git.     */
/* ------------------------------------------------------------------ */
console.log("-- P0-6/P0-7 write tools: execution configuration is denied");
for (const rel of [
  ".git/hooks/pre-commit", ".GIT/hooks/pre-commit", ".Git/config",
  ".claude/settings.json", ".claude/settings.local.json",
  ".envrc", ".github/workflows/ci.yml", ".vscode/tasks.json",
  ".gitattributes", ".mcp.json", ".gitmodules",
]) {
  check("Write DENY: " + rel, write(rel), "DENY");
}
for (const rel of ["src/index.js", "package.json", "README.md", "src/.gitignore", "docs/notes.md"]) {
  check("Write ALLOW: " + rel, write(rel), "ALLOW");
}

/* ------------------------------------------------------------------ */
/* analyseCommand unit level (fast, no spawn): the same guarantees must */
/* hold when the server re-checks a command it saw claude run.         */
/* ------------------------------------------------------------------ */
console.log("-- analyseCommand unit cases");
const opts = { repoRoot: REPO };
check("analyseCommand DENY: ANSI-C", analyseCommand("git diff $'--no-index' /etc/passwd", opts).ok, false);
check("analyseCommand DENY: backslash", analyseCommand("git diff \\--output=/tmp/x", opts).ok, false);
check("analyseCommand DENY: glued -o", analyseCommand("git log | sort -o/tmp/x", opts).ok, false);
check("analyseCommand DENY: glued -f", analyseCommand("rg -f/etc/passwd", opts).ok, false);
check("analyseCommand ALLOW: absolute in-repo", analyseCommand('find "' + REPO + '" -name x', opts).ok, true);
check("analyseCommand DENY: outside path", analyseCommand("find /etc -name x", opts).ok, false);
check("analyseCommand DENY: bare $VAR printed by echo", analyseCommand("echo $ANTHROPIC_API_KEY", opts).ok, false);
check("analyseCommand DENY: tr reading an outside file", analyseCommand("echo hi | tr a b /etc/passwd", opts).ok, false);
check("analyseCommand ALLOW: tr with no file operand", analyseCommand("echo hi | tr a b", opts).ok, true);

/* ------------------------------------------------------------------ */
/* P0-4 / P0-5: a repository-supplied git driver must be refused.      */
/* git runs textconv from .git/config + .gitattributes; the scanner is  */
/* the only gate (no -c override can neutralise a named driver).        */
/* ------------------------------------------------------------------ */
console.log("-- P0-4/P0-5 repoRunsGitPrograms refuses repo-supplied drivers");
function gitRepo(name) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), name + "-"));
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "sample.txt"), "one\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "sample.txt"), "two\n");
  return repo;
}
const PWN = path.join(os.tmpdir(), "p0-regression-pwn-" + process.pid);
const CMD = "sh -c 'echo pwn > " + PWN + "'";
try {
  // control: root .gitattributes + a normal section — refused
  const a = gitRepo("p0-ctl");
  fs.writeFileSync(path.join(a, ".gitattributes"), "*.txt diff=evil\n");
  fs.appendFileSync(path.join(a, ".git", "config"), '\n[diff "evil"]\n\ttextconv = ' + CMD + "\n");
  check("refuses root .gitattributes driver", repoRunsGitPrograms(a).refusals.length > 0, true);
  fs.rmSync(a, { recursive: true, force: true });

  // P0-4: attributes in a subdirectory two levels deep
  const b = gitRepo("p0-deep");
  fs.mkdirSync(path.join(b, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(b, "src", "deep", "sample.txt"), "one\n");
  fs.writeFileSync(path.join(b, "src", "deep", ".gitattributes"), "*.txt diff=evil\n");
  fs.appendFileSync(path.join(b, ".git", "config"), '\n[diff "evil"]\n\ttextconv = ' + CMD + "\n");
  check("refuses deep src/deep/.gitattributes driver", repoRunsGitPrograms(b).refusals.length > 0, true);
  fs.rmSync(b, { recursive: true, force: true });

  // P0-5: section header and its first key on the same line (valid git config)
  const c = gitRepo("p0-sameline");
  fs.writeFileSync(path.join(c, ".gitattributes"), "*.txt diff=evil\n");
  fs.appendFileSync(path.join(c, ".git", "config"), '\n[diff "benign"]\n\ttextconv = /bin/true\n[diff "evil"] textconv = ' + CMD + "\n");
  check("refuses same-line section header driver", repoRunsGitPrograms(c).refusals.length > 0, true);
  fs.rmSync(c, { recursive: true, force: true });

  // P0-5b: dotted section header ([diff.evil]) is legal git config too.
  const e = gitRepo("p0-dotted");
  fs.writeFileSync(path.join(e, ".gitattributes"), "*.txt diff=evil\n");
  fs.appendFileSync(path.join(e, ".git", "config"), "\n[diff.evil]\n\ttextconv = " + CMD + "\n");
  check("refuses dotted [diff.evil] driver", repoRunsGitPrograms(e).refusals.length > 0, true);
  fs.rmSync(e, { recursive: true, force: true });

  // P0-8: core.sshCommand makes the NEXT git transport run a repo-chosen
  // program; the prompt itself suggests `git remote show origin`, which is
  // allowlisted and triggers it. It must be refused, not noted.
  const ssh = gitRepo("p0-sshcmd");
  const sshScript = path.join(ssh, "ssh.sh");
  fs.writeFileSync(sshScript, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(sshScript, 0o755);
  fs.appendFileSync(path.join(ssh, ".git", "config"), "\n[core]\n\tsshCommand = " + sshScript + "\n");
  spawnSync("git", ["-C", ssh, "remote", "add", "origin", "ssh://git@example.invalid/repo.git"], { stdio: "ignore" });
  check("refuses core.sshCommand", repoRunsGitPrograms(ssh).refusals.length > 0, true);
  fs.rmSync(ssh, { recursive: true, force: true });

  // P0-9: core.attributesFile names an attribute file the .gitattributes walk
  // never sees; a driver reference hidden there is invisible to the scan, so
  // the config alone must be enough to refuse (or the file must be scanned).
  const attr = gitRepo("p0-attrfile");
  const attrFile = path.join(attr, "evil-attrs");
  const attrCmd = path.join(attr, "tc.sh");
  fs.writeFileSync(attrCmd, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(attrCmd, 0o755);
  fs.writeFileSync(attrFile, "*.txt diff=evil\n");
  fs.appendFileSync(path.join(attr, ".git", "config"), '\n[core]\n\tattributesFile = ' + attrFile + '\n[diff "evil"]\n\ttextconv = ' + attrCmd + "\n");
  check("refuses a driver activated via core.attributesFile", repoRunsGitPrograms(attr).refusals.length > 0, true);
  fs.rmSync(attr, { recursive: true, force: true });

  // P0-4b: a walk that hits its bound must fail closed, not scan "most" of the tree.
  const f = gitRepo("p0-toodeep");
  let deep = f;
  for (let i = 0; i < 20; i++) { deep = path.join(deep, "d" + i); }
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, ".gitattributes"), "*.txt diff=evil\n");
  fs.appendFileSync(path.join(f, ".git", "config"), '\n[diff "evil"]\n\ttextconv = ' + CMD + "\n");
  check("refuses when the attribute walk is truncated", repoRunsGitPrograms(f).refusals.length > 0, true);
  fs.rmSync(f, { recursive: true, force: true });

  // P0-10: the FILE-COUNT bound must fail closed too. Git only honours a file
  // named exactly `.gitattributes`, so the fixture puts one in each of 4100
  // directories (4001 same-named files in one directory are impossible).
  const many = fs.mkdtempSync(path.join(os.tmpdir(), "p0-manyattrs-"));
  for (let i = 0; i < 4100; i++) {
    const d = path.join(many, "d" + i);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, ".gitattributes"), "*.txt diff=evil\n");
  }
  const manyScan = repoRunsGitPrograms(many);
  check("refuses an attribute walk past the 4000-file bound",
    manyScan.refusals.some((x) => x.includes("more than 4000")), true);
  fs.rmSync(many, { recursive: true, force: true });

  // P0-3: a committed symlink must not make the synchronous scanner block.
  if (process.platform !== "win32") {
    const d = gitRepo("p0-symlink");
    fs.rmSync(path.join(d, ".gitattributes"), { force: true });
    fs.symlinkSync("/dev/zero", path.join(d, ".gitattributes"));
    const probe = [
      "import { repoRunsGitPrograms } from " + JSON.stringify(path.join(ROOT, "src", "claude.js")) + ";",
      "const v = repoRunsGitPrograms(" + JSON.stringify(d) + ");",
      "process.stdout.write(JSON.stringify(v.refusals.length));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"] });
    check("symlinked .gitattributes does not block the scanner", res.error ? "HUNG" : "returned", "returned");
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  try { fs.rmSync(PWN, { force: true }); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log("\n" + failures.length + " FAILURE(S):");
  for (const f of failures) console.log("  - " + f);
}
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
