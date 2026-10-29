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

/**
 * In-repo paths that are execution configuration rather than source: writing them
 * survives the run and fires later (a git hook on the next commit, a project
 * .claude/settings.json hook on the next session, direnv on the next cd, a CI
 * workflow on the next push). fix mode is allowed to change source; it is not
 * allowed to plant something that runs. Case-insensitive because macOS/Windows
 * resolve .GIT to .git and the path check must not depend on the caller's spelling.
 *
 * .gitattributes/.gitconfig are here because they can name a diff/filter driver
 * that git then executes (see repoRunsGitPrograms in src/claude.js).
 */
const PROTECTED_WRITE = [
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.envrc(\.|$)/i,
  /(^|\/)\.github\/workflows(\/|$)/i,
  /(^|\/)\.vscode(\/|$)/i,
  /(^|\/)\.idea(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)\.gitmodules$/i,
  /(^|\/)\.gitattributes$/i,
  /(^|\/)\.gitconfig$/i,
];

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

  // The Bash policy is scoped to the repository (cd targets, find/rg/sink path
  // arguments). Without the root there is nothing to scope to, so fail closed —
  // the same rule the write/read tools already follow.
  const repoRoot = process.env.CLAUDE_REVIEW_REPO_ROOT;
  if (!repoRoot) {
    deny("Bash blocked: no repository root was provided to the guard, so file reads cannot be scoped (fail closed)");
    return;
  }

  try {
    const verdict = guard(payload?.tool_input?.command, { repoRoot });
    if (!verdict.ok) deny(verdict.reason);
  } catch (err) {
    deny(`shell guard failed (${err?.message || err}); refusing to run Bash`);
    return;
  }
  process.exit(0);
});
