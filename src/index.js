#!/usr/bin/env node
/**
 * cc-code-review
 *
 * MCP server that wraps Claude Code's headless mode (`claude -p`) so any MCP
 * client (ZCode, Claude Desktop, ...) can run Claude Code's code-review skill
 * and get the findings back as the tool result.
 *
 * Tools:
 *   - claude_code_review      run a full review (PR / branch / working-dir / last-commit)
 *   - claude_review_followup  continue the conversation of a previous review (--resume)
 *   - claude_review_env       check the Claude Code CLI + skill + gateway, optionally install the bundled skill
 *
 * All logging goes to stderr (stdout is the MCP stdio channel — keep it clean).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  resolveClaudeCli, resolveClaudeCliSettled, runClaude, claudeVersion, claudeSemver, versionAtLeast,
  PERMISSION_MODE_MANUAL_MIN, PERMISSION_PROMPTS_MIN,
  supportsFlag, supportsStreamJson, supportsPermissionPrompts,
  writeGuardSettings, guardState, guardSelfTest, hookScriptPath, removeGuardSettings,
  cleanupGuardSettings, settingsParseProblem, peekSettingsEnv, markGuardSettingsInFlight,
  analyseCommand, gitWriteFlagReason, shellGuardNote, shellChainingNote,
  probeGateway, gatewayTarget, authEnvResidue, modelEnvOverrides, gitPreflight,
  buildClaudeEnv, repoRunsGitPrograms,
} from "./claude.js";
import {
  buildReviewPrompt, buildFallbackPrompt, buildFollowupPrompt,
  reviewAllowedTools, reviewDisallowedTools, fixAllowedTools, fixDisallowedTools, postPROnlyTools,
} from "./prompt.js";
import { skillStatus, installBundledSkill, userSkillDir } from "./skill.js";

const execFileAsync = promisify(execFile);
const log = (...a) => console.error("[cc-code-review]", ...a);

const ENV = {
  // clamp to the same ranges the zod schema enforces, otherwise an out-of-range
  // env default makes every call that omits the param fail with '-32602 ... at
  // timeoutMinutes' naming no env var
  timeoutMinutes: Math.min(60, Math.max(1, Math.round(positive(process.env.CLAUDE_REVIEW_TIMEOUT_MIN, 20)))),
  maxBudgetUsd: Math.min(50, nonNegative(process.env.CLAUDE_REVIEW_MAX_BUDGET_USD, 5)),
  model: process.env.CLAUDE_REVIEW_MODEL || undefined,
  autoInstallSkill: process.env.CLAUDE_REVIEW_AUTO_INSTALL_SKILL !== "0",
};

function positive(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 0 is meaningful for the budget cap ("disabled"), so it must not fall back to the default. */
function nonNegative(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

const LOG_KEEP = 20;
// Background review jobs (async mode). Results are kept in-memory for the life
// of the server process — a restart clears them, which the status tool says.
const reviewJobs = new Map();
const JOB_KEEP = 10;
function pruneReviewJobs() {
  const finished = [...reviewJobs.values()].filter((j) => j.state === "done");
  for (const j of finished.slice(0, Math.max(0, finished.length - JOB_KEEP))) reviewJobs.delete(j.id);
}
function logsDir() {
  // 0700 so review logs (they quote repo code) stay private from other local users on macOS/Linux.
  // Overridable because Windows has no POSIX mode bits: CLAUDE_REVIEW_LOG_DIR lets a user point
  // the logs at a directory their own ACLs protect (see README "已知残留风险（Windows）").
  const base = process.env.CLAUDE_REVIEW_LOG_DIR?.trim() || path.join(os.tmpdir(), "cc-code-review");
  const dir = path.resolve(base);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeLogFile(stdout, stderr) {
  try {
    const dir = logsDir();
    const file = path.join(dir, `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
    fs.writeFileSync(file, `# claude stdout\n${stdout}\n\n# claude stderr (tail)\n${stderr.slice(-8000)}\n`, { mode: 0o600 });
    // retention: keep the newest LOG_KEEP logs
    try {
      const olds = fs.readdirSync(dir).filter((f) => f.startsWith("run-")).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { f } of olds.slice(LOG_KEEP)) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* best effort */ }
    return file;
  } catch (e) {
    return { error: `log write failed (${e?.message || e})` };
  }
}

function isRepo(p) {
  try {
    return fs.statSync(p).isDirectory() && (
      fs.existsSync(path.join(p, ".git")) ||
      fs.existsSync(path.join(p, ".hg")) ||
      fs.existsSync(path.join(p, ".svn"))
    );
  } catch {
    return false;
  }
}

/**
 * Relative repoPath values resolve against the MCP server's own cwd (wherever
 * the host spawned it), which is almost never the caller's workspace — and a
 * review is a paid run. Refuse instead of guessing.
 * NOTE: the absoluteness check must run on the *input*, before path.resolve()
 * silently makes any relative string absolute.
 */
function requireAbsoluteRepoPath(p) {
  if (!p) return { ok: false, error: "repoPath is required." };
  const expanded = (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))
    ? path.join(os.homedir(), p.slice(2))
    : p;
  // path.isAbsolute("/tmp/repo") is true on win32, where it would silently
  // resolve against the server's own drive — not the path the caller typed.
  if (process.platform === "win32" && /^[\\/]/.test(expanded) && !/^\\\\/.test(expanded)) {
    return {
      ok: false,
      error:
        `repoPath "${p}" has no Windows drive letter (C:\\... or \\\\server\\share\\...). ` +
        `On Windows it would resolve against this server's own drive, not the path you typed — pass the full drive-letter path.`,
    };
  }
  // NTFS allows names ending in space/dot but Win32 path APIs (incl. spawn)
  // fail ENOENT on them — refuse up front instead of dying at first git call
  if (process.platform === "win32" && /(^|[\\/])[^\\/]*[ .]([\\/]|$)/.test(expanded)) {
    return { ok: false, error: `repoPath has a path component ending with a space or dot, which Win32 cannot spawn (${expanded}). Rename that directory, then retry.` };
  }
  if (!path.isAbsolute(expanded)) {
    return {
      ok: false,
      error:
        `repoPath must be an absolute path (got "${p}"). It would otherwise resolve against the MCP server's own ` +
        `working directory, not yours, so a relative path could review the wrong repository and spend credits on it. ` +
        `Pass the full path (e.g. C:\\Users\\you\\project) or use the ~/ prefix.`,
    };
  }
  return { ok: true, path: path.resolve(expanded) };
}

/** Accepts "123", "#123", "owner/repo#123", or a github.com PR URL. */
function validatePr(pr) {
  if (!pr) return { ok: true, pr: undefined };
  const s = String(pr).trim();
  if (/^#?\d{1,10}$/.test(s)) return { ok: true, pr: s.replace(/^#/, "") };
  if (/^[\w.-]+\/[\w.-]+#\d{1,10}$/.test(s)) return { ok: true, pr: s };
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,10}(\/.*)?$/.test(s)) return { ok: true, pr: s };
  return {
    ok: false,
    error: `pr must be a PR number ("123"), "owner/repo#123", or a GitHub PR URL — got ${JSON.stringify(pr)}. ` +
      `The value is interpolated into the reviewer prompt, so arbitrary strings are rejected.`,
  };
}

/** outputLanguage is a language name; keep it to one short line so it cannot smuggle instructions. */
function validateLanguage(lang) {
  const s = String(lang || "").trim();
  if (!s) return { ok: false, error: "outputLanguage must not be empty" };
  if (s.length > 40) return { ok: false, error: "outputLanguage must be a short language name (<= 40 chars)" };
  if (/[\r\n`]/.test(s)) return { ok: false, error: "outputLanguage must be a single line without backticks" };
  return { ok: true, lang: s };
}

/**
 * baseRef is interpolated into the reviewer prompt AND echoed back into the
 * suggested `git merge-base <ref> HEAD` commands. A leading "-" would turn the
 * ref into a git option (`git merge-base --output=... HEAD` writes a file), so
 * the shape is enforced here instead of trusting sanitizeBaseRef downstream.
 */
function validateBaseRef(ref) {
  if (!ref) return { ok: true, ref: undefined };
  const s = String(ref).trim();
  if (!s) return { ok: true, ref: undefined };
  if (s.length > 200) return { ok: false, error: "baseRef must be a short ref name (<= 200 chars)" };
  if (/[\r\n`"'\\$;&|<>(){}]/.test(s)) {
    return { ok: false, error: `baseRef must be a plain branch/tag name — got ${JSON.stringify(ref)}.` };
  }
  if (s.startsWith("-")) {
    return {
      ok: false,
      error:
        `baseRef must not start with "-" (got ${JSON.stringify(ref)}): it would be parsed as a git option ` +
        `(e.g. git merge-base --output=<file> HEAD writes a file) instead of as a ref. Pass the plain name, e.g. "main".`,
    };
  }
  return { ok: true, ref: s };
}

/**
 * `focus` is caller-supplied text that lands in the reviewer prompt. It is data,
 * never instructions: cap it, and refuse control characters / NUL so it cannot
 * restructure the prompt it is being interpolated into.
 */
function validateFocus(focus) {
  if (focus == null || focus === "") return { ok: true, focus: undefined };
  const s = String(focus);
  if (s.trim() === "") return { ok: true, focus: undefined };
  if (s.length > 2000) return { ok: false, error: "focus must be <= 2000 chars" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) {
    return { ok: false, error: "focus must not contain control characters" };
  }
  return { ok: true, focus: s };
}

/** Shape shared by the text result of review / followup runs. */
function runResultText(report, meta) {
  const lines = [
    report || "(claude returned an empty report)",
    "",
    "---",
    `_run metadata_`,
    `- status: ${meta.status}`,
    ...(meta.warning ? [`- warning: ${meta.warning}`] : []),
    ...(meta.sessionId ? [`- session_id: ${meta.sessionId} (use claude_review_followup to continue this review)`] : []),
    ...(typeof meta.costUsd === "number" ? [`- cost_usd: ${meta.costUsd.toFixed(4)}`] : []),
    ...(meta.numTurns != null ? [`- turns: ${meta.numTurns}`] : []),
    ...(meta.durationMs != null ? [`- wall_time_s: ${Math.round(meta.durationMs / 1000)}`] : []),
    ...(meta.skillMode ? [`- pipeline: ${meta.skillMode}`] : []),
    ...(meta.subagentsSpawned != null ? [`- reviewer_subagents_spawned: ${meta.subagentsSpawned}${meta.subagentsSpawned === 0 ? " (0 — the reviewer worked inline; normal for small diffs, but check permission_denials if the report looks thin)" : ""}`] : []),
    ...(meta.permissionDenials ? [`- permission_denials: ${meta.permissionDenials}`] : []),
    ...(typeof meta.logFile === "string" ? [`- full_log: ${meta.logFile}`] : []),
    ...(meta.logFile?.error ? [`- full_log: ${meta.logFile.error}`] : []),
  ];
  return lines.join("\n");
}

function logNoteOf(logFile) {
  return typeof logFile === "string" ? `\n\n- full log: ${logFile}` : `\n\n- full log: ${logFile?.error || "unavailable"}`;
}

/** `git status --porcelain` output (or null when git/unavailable). */
async function gitStatusSnapshot(repoPath) {
  try {
    // env: buildClaudeEnv() — on a GUI-launched macOS host the inherited PATH is
    // launchd's sparse one and `git` is not on it, which made fix-mode
    // verification silently report "nothing changed".
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoPath, timeout: 20000, windowsHide: true, env: buildClaudeEnv(),
    });
    return stdout;
  } catch {
    return null;
  }
}

let ghPreflightCache;
/**
 * Is the GitHub CLI usable (installed AND authenticated)?
 *
 * A PR scope or postToPR without gh fails minutes into the run, after the
 * reviewer has already spent turns — check it here instead. Cached per process
 * (a login change needs an MCP restart, which is fine for a preflight).
 */
async function ghPreflight() {
  if (ghPreflightCache !== undefined) return ghPreflightCache;
  const run = async (args) => {
    try {
      const { stdout } = await execFileAsync("gh", args, { timeout: 15000, windowsHide: true, env: buildClaudeEnv() });
      return { ok: true, stdout: String(stdout) };
    } catch (e) {
      return { ok: false, code: e?.code, stderr: String(e?.stderr || "") };
    }
  };
  const ver = await run(["--version"]);
  if (!ver.ok) {
    ghPreflightCache = { ok: false, reason: `gh --version failed (${ver.code || "not found"})` };
    return ghPreflightCache;
  }
  const auth = await run(["auth", "status"]);
  if (!auth.ok) {
    ghPreflightCache = { ok: false, reason: "gh is installed but not authenticated — run `gh auth login`" };
    return ghPreflightCache;
  }
  ghPreflightCache = { ok: true, reason: ver.stdout.trim().split(/\r?\n/)[0] };
  return ghPreflightCache;
}

function stderrTail(stderr, n = 2500) {
  const s = (stderr || "").trim();
  return s ? `\n\n--- claude stderr (tail) ---\n${s.slice(-n)}` : "";
}

function err(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * claude headless reports auth/network/permission failures as
 * `subtype:"success"` + `is_error:true` (or a specific `subtype`), with the
 * human message in `result`. Turn those into an unmistakable failure banner
 * with actionable hints instead of a fake "report".
 */
function failureBanner(j, run) {
  const resultText = typeof j.result === "string" ? j.result : "";
  const blob = `${resultText}\n${run.stderr.slice(-1500)}`;
  const hints = [];
  // Three distinct credential failures get three distinct fixes:
  //  - OAuth login missing          -> run `claude` once interactively
  //  - key/token rejected (401/403) -> the configured key is bad for that endpoint (CC Switch provider config / ANTHROPIC_API_KEY)
  //  - OS credential store unreadable (launchd/service-hosted MCP daemons) -> keychain, not login state
  if (/not logged in|run \/login|please login|oauth/i.test(blob)) {
    hints.push("Claude Code has no usable credentials: run `claude` once in a terminal and complete the login (headless mode cannot do the interactive login), then retry. If you use CC Switch, start the gateway and pick a provider there first.");
  }
  if (/invalid.?api.?key|authentication error|api error[.:,]?\s*(?:\w+\s+)*?\b401\b|\b401\b.*(?:unauthorized|authentication)|\b403\b.*(?:forbidden|permission)/i.test(blob)) {
    hints.push("The endpoint rejected the credential (401/403 / invalid API key): check the provider key in CC Switch (or your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) — this is a bad/expired key for the configured endpoint, not a missing login.");
  }
  if (/keychain|user interaction is not allowed|errsec|securityd/i.test(blob)) {
    hints.push("The host process cannot read the OS credential store (macOS Keychain / Windows Credential Manager) — common when the MCP host runs as a launchd agent or Windows service, which has no user session to unlock it. Run claude interactively once, host ZCode from a normal user session, or switch to ANTHROPIC_API_KEY / a gateway so no keychain access is needed.");
  }
  if (/ECONNREFUSED|connection refused|fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|api_error/i.test(blob)) {
    const t = gatewayTarget();
    hints.push(`The API endpoint is unreachable${t ? ` (ANTHROPIC_BASE_URL=${t.url})` : ""} — if you use CC Switch / claude-code-router / a local gateway, make sure it is running and healthy.`);
  }
  if (j.subtype === "error_max_budget_usd" || /max.?budget|budget.*(exceed|reached|limit)/i.test(blob)) {
    hints.push("The run hit the --max-budget-usd cap: retry with a larger maxBudgetUsd, or 0 to disable the cap. (Third-party gateways report usage differently, so the cap can trigger early there.)");
  }
  if (j.subtype === "error_max_turns" || /max.?turns/i.test(blob)) {
    hints.push(`The run hit the --max-turns cap (${j.num_turns ?? "?"} turns used): retry with a larger maxTurns, or narrow the scope (e.g. last-commit instead of auto) so the reviewer needs fewer steps.`);
  }
  if (/permission|not allowed|haven'?t granted|denied|manual mode|allowlist/i.test(blob)) {
    hints.push("A tool call was denied by the permission allowlist (this MCP runs claude with `--permission-mode manual`: only the review allowlist is permitted). This usually means the review pipeline needed a tool outside that allowlist — check the full log for which tool was blocked.");
  }
  return [
    "⚠️ REVIEW FAILED — Claude did not complete the review. Original message from claude:",
    "",
    resultText || "(no message)",
    ...(j.subtype ? [`(subtype: ${j.subtype})`] : []),
    ...(hints.length ? ["", "Hints:"].concat(hints.map((h) => `- ${h}`)) : []),
  ].join("\n");
}

const SERVER_VERSION = "1.9.1";
const server = new McpServer(
  { name: "cc-code-review", version: SERVER_VERSION },
  {
    instructions:
      "Run Claude Code's code-review skill on a repository and get structured findings back. " +
      "Typical flow: claude_code_review(repoPath, scope) -> fix code in ZCode -> claude_code_review again, " +
      "or claude_review_followup(sessionId) to ask the reviewer something.",
  }
);

/* ------------------------------------------------------------------ */
/* Shared pre-run hardening gate                                       */
/* ------------------------------------------------------------------ */

/**
 * Verify the shell guard and resolve the permission-mode flags for one run.
 *
 * Two independent things can silently disarm a review:
 *  1. the PreToolUse guard is off, unwritable, or installed-but-not-firing. It is
 *     the only mechanism that blocks shell-chained Bash commands and writes
 *     outside the repo, so a run without it is refused unless the operator sets
 *     CLAUDE_REVIEW_ALLOW_UNGUARDED=1;
 *  2. `--permission-mode manual` (>= 2.1.200) and `--permission-prompts none`
 *     (>= 2.1.259) are newer-CLI options — passing either to an older claude
 *     makes it exit with "unknown option", which the caller sees as an opaque
 *     "no parseable result JSON".
 *
 * Returns {ok:false, error} to abort, or the resolved flags plus any note that
 * belongs in the report.
 */
async function prepareRunHardening(cli) {
  const allowUnguarded = process.env.CLAUDE_REVIEW_ALLOW_UNGUARDED === "1";
  const guard = guardState();
  const notes = [];

  if (guard.state !== "on") {
    if (!allowUnguarded) {
      cleanupGuardSettings(); // guardState() wrote a probe file; nobody will remove it now
      return {
        ok: false,
        error: guard.state === "off"
          ? `Refusing to run unguarded: the PreToolUse shell guard is switched off (${guard.reason}). ` +
            `It is the only thing that blocks shell-chained Bash commands and writes outside the reviewed repo. ` +
            `Unset CLAUDE_REVIEW_SHELL_GUARD (or set it to 1), or set CLAUDE_REVIEW_ALLOW_UNGUARDED=1 to accept the risk.`
          : `Refusing to run unguarded: the PreToolUse shell guard could not be installed (${guard.reason}). ` +
            `Check that ${hookScriptPath()} exists and that node can spawn it, or set ` +
            `CLAUDE_REVIEW_ALLOW_UNGUARDED=1 to run anyway at your own risk.`,
      };
    }
    notes.push(
      `⚠ shell guard ${guard.state === "off" ? "is OFF" : "FAILED to install"} (${guard.reason}) — the run proceeds only because ` +
      `CLAUDE_REVIEW_ALLOW_UNGUARDED=1 is set. Chained Bash commands and out-of-repo writes are NOT blocked.`
    );
    log(`guard ${guard.state} but CLAUDE_REVIEW_ALLOW_UNGUARDED=1 — proceeding unguarded:`, guard.reason);
  } else {
    // Installed is not the same as working: prove it denies before trusting it.
    const selfTest = await guardSelfTest();
    if (!selfTest.ok && !allowUnguarded) {
      cleanupGuardSettings(); // probe files from guardState()+guardSelfTest(); nobody will remove them now
      return {
        ok: false,
        error:
          `Refusing to run unguarded: the shell guard is installed but did not behave as expected (${selfTest.reason}). ` +
          `A guard that does not fire is worse than none, because it looks like protection. Set ` +
          `CLAUDE_REVIEW_ALLOW_UNGUARDED=1 to run anyway at your own risk.`,
      };
    }
    if (!selfTest.ok) {
      notes.push(`⚠ shell guard self-test failed (${selfTest.reason}) — proceeding only because CLAUDE_REVIEW_ALLOW_UNGUARDED=1 is set.`);
      log("guard self-test failed but CLAUDE_REVIEW_ALLOW_UNGUARDED=1 — proceeding:", selfTest.reason);
    }
  }
  const guardSettings = writeGuardSettings();
  markGuardSettingsInFlight(guardSettings, true); // held until the claude spawn returns

  let semver = null;
  try { semver = await claudeSemver(cli); } catch { /* unreadable version: fall through to help-text probing */ }
  let permissionPrompts = false;
  try { permissionPrompts = await supportsPermissionPrompts(cli); } catch { /* treat as unsupported */ }
  let permissionMode = true;
  if (!semver) {
    // Version unreadable (wrapper printing a banner, --version failing): the
    // floor check below cannot run, so fall back to the same help-text probe
    // --permission-prompts uses. Passing --permission-mode blindly to an older
    // CLI dies with "unknown option" — the exact opaque failure the floors
    // exist to prevent.
    try { permissionMode = await supportsFlag(cli, "--permission-mode"); } catch { permissionMode = false; }
    if (!permissionMode) notes.push(`⚠ could not read claude's version and its help does not document --permission-mode, so the flag is skipped (run falls back to claude's default permission behaviour).`);
  } else if (versionAtLeast(semver, PERMISSION_MODE_MANUAL_MIN) === false) {
    permissionMode = false;
    permissionPrompts = false;
    notes.push(
      `⚠ claude ${semver} is older than ${PERMISSION_MODE_MANUAL_MIN}, so --permission-mode manual is not passed: the run falls back to ` +
      `claude's default permission behaviour instead of the fail-closed allowlist. Upgrade claude for the hardened mode.`
    );
  } else if (versionAtLeast(semver, PERMISSION_PROMPTS_MIN) === false) {
    permissionPrompts = false;
    notes.push(`⚠ claude ${semver} is older than ${PERMISSION_PROMPTS_MIN}, so --permission-prompts none is skipped (manual mode still applies).`);
  }

  const hardening = {
    permissionMode: permissionMode ? "manual" : "cli-default (version floor not met)",
    permissionPrompts: permissionPrompts ? "none" : "not passed",
    settingSources: "user",
    shellGuard: guard.state === "on" ? "PreToolUse hook" : "off",
    gitHardening: ["core.fsmonitor=", "diff.external=", "credential.helper=", "core.hooksPath=", "GIT_CONFIG_NOSYSTEM=1"],
  };
  return { ok: true, guard, guardSettings, permissionMode, permissionPrompts, hardening, note: notes.length ? notes.join("\n\n") + "\n\n" : "" };
}

/* ------------------------------------------------------------------ */
/* Tool 1: claude_review_env                                          */
/* ------------------------------------------------------------------ */

server.tool(
  "claude_review_env",
  "Check the Claude Code CLI installation, the code-review skill, the auth/gateway setup, and helper tools (git/gh). " +
  "Set installSkill=true to (re)install the bundled code-review skill into ~/.claude/skills/code-review " +
  "(never overwrites a user-managed skill there).",
  { installSkill: z.boolean().default(false) },
  async ({ installSkill }) => {
    const lines = ["claude cli:"];
    const cli = resolveClaudeCli();
    let cliState = "NOT_FOUND";
    if (!cli) {
      lines.push("  NOT FOUND — install Claude Code (https://code.claude.com/docs/en/setup) or set CLAUDE_CODE_PATH to the claude executable / cli.js.");
    } else if (cli.error) {
      cliState = "MISCONFIGURED";
      lines.push(`  MISCONFIGURED — ${cli.error}`);
    } else {
      let version = "(version query failed)";
      let semver = null;
      try { version = (await claudeVersion(cli)) || version; semver = await claudeSemver(cli); } catch { /* keep default */ }
      lines.push(`  ok: ${cli.path}`, `  [source: ${cli.source}]`, `  version: ${version}`);
      lines.push(`  flags: --effort ${(await supportsFlag(cli, "--effort")) ? "supported" : "NOT supported (falls back to thinking keywords)"}, --max-budget-usd ${(await supportsFlag(cli, "--max-budget-usd")) ? "supported" : "NOT supported (skipped)"}, --permission-prompts ${(await supportsPermissionPrompts(cli)) ? "supported" : "NOT supported (manual mode only)"}, stream-json ${(await supportsStreamJson(cli)) ? "supported" : "NOT supported (tool-call reporting degrades)"}`);
      // Version floors: these two flags are what make the run fail-closed, and an
      // unknown option on an older CLI kills the run with an opaque error.
      const manualOk = semver ? versionAtLeast(semver, PERMISSION_MODE_MANUAL_MIN) : null;
      const promptsOk = semver ? versionAtLeast(semver, PERMISSION_PROMPTS_MIN) : null;
      lines.push(`  version floors: --permission-mode manual needs >= ${PERMISSION_MODE_MANUAL_MIN} (${manualOk === null ? "unknown version" : manualOk ? "ok" : "TOO OLD — hardened mode is skipped"}), --permission-prompts none needs >= ${PERMISSION_PROMPTS_MIN} (${promptsOk === null ? "unknown version" : promptsOk ? "ok" : "TOO OLD — skipped"})`);
      const guard = guardState();
      if (guard.state === "on") {
        const self = await guardSelfTest();
        lines.push(`  shell guard (PreToolUse hook blocking chained/substituted Bash commands): installed — ${self.ok ? "verified working (denies a chained command, allows a clean one)" : `NOT WORKING — ${self.reason}`}`);
      } else {
        lines.push(`  shell guard (PreToolUse hook blocking chained/substituted Bash commands): ${guard.state === "off" ? "OFF" : "FAILED"} — ${guard.reason}`);
      }
      // guardState()/guardSelfTest() wrote a guard settings file just to probe;
      // nothing else will remove it in this code path, so clean up now.
      cleanupGuardSettings();
      cliState = "OK";
    }

    lines.push("code-review skill (~/.claude/skills/code-review): " + describeSkill(skillStatus()));

    const t = gatewayTarget();
    if (t) {
      const gw = await probeGateway();
      lines.push(`gateway (ANTHROPIC_BASE_URL): ${t.url}` + (gw.skipped ? " (probe skipped)" : gw.ok ? " — reachable ✓" : ` — NOT reachable (${gw.reason}) ✗`));
    } else {
      lines.push("gateway: none configured (direct Anthropic / OAuth login)");
    }
    const residue = authEnvResidue();
    const modelOverrides = modelEnvOverrides();
    if (residue.length) {
      // Only a *configured* gateway makes residue a conflict: with no gateway,
      // ANTHROPIC_API_KEY in the host env is exactly what a direct login looks like.
      // And when the gateway itself IS configured via the host env (the env-only
      // injection path), ANTHROPIC_BASE_URL is not residue — it is the config.
      const baseIsGateway = t && process.env.ANTHROPIC_BASE_URL && t.url.href === new URL(process.env.ANTHROPIC_BASE_URL).href;
      const realResidue = baseIsGateway ? residue.filter((k) => k !== "ANTHROPIC_BASE_URL") : residue;
      if (baseIsGateway) {
        lines.push(`note: the gateway is configured via the host environment (ANTHROPIC_BASE_URL=${t.url}), not ~/.claude/settings.json — this works as-is.`);
      }
      if (realResidue.length) {
        if (t) {
          // settings.json env beats process env inside claude, so an unmanaged
          // var can never override a key settings.json also sets — it only
          // matters for keys settings does NOT manage (like the note above).
          lines.push(`⚠ auth env residue: ${realResidue.join(", ")} set in the host environment but not managed by ~/.claude/settings.json — for keys settings.json also sets, settings wins; these unmanaged ones are used as-is alongside the configured gateway (${t.url}).`);
        } else {
          lines.push(`note: auth env residue: ${realResidue.join(", ")} (no gateway configured, so these are used as-is for a direct login).`);
        }
      }
    }
    if (modelOverrides.length) {
      lines.push(`note: model override(s) in the host env: ${modelOverrides.join(", ")} — they select the model but are not credentials, so they are reported separately from auth residue.`);
    }
    const settingsProblem = settingsParseProblem();
    if (settingsProblem) {
      lines.push(`⚠ settings.json problem: ${settingsProblem}.`);
    }
    if (process.env.CLAUDE_CODE_EFFORT_LEVEL) {
      // This MCP DELETES the var from the child env (buildClaudeEnv), so the
      // caller's --effort always wins — the old text claimed the opposite.
      // The real override risk is the settings.json env block, which claude
      // applies itself and we cannot strip.
      const s = peekSettingsEnv();
      if (s?.CLAUDE_CODE_EFFORT_LEVEL != null) {
        lines.push(`⚠ CLAUDE_CODE_EFFORT_LEVEL=${s.CLAUDE_CODE_EFFORT_LEVEL} is set in ~/.claude/settings.json's env block: claude applies it over the --effort flag, so the review's effort parameter is ignored. Remove it there (CC Switch configs often add it) to let this MCP control effort.`);
      } else {
        lines.push(`note: CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} is set in the host environment; this MCP strips it for the claude child, so the caller's --effort parameter stays in charge.`);
      }
    }

    // helper tools the review pipeline shells out to
    for (const [name, args] of [["git", ["--version"]], ["gh", ["--version"]]]) {
      try {
        // env: buildClaudeEnv() — a GUI-launched host inherits a sparse PATH.
        const { stdout } = await execFileAsync(name, args, { timeout: 15000, windowsHide: true, env: buildClaudeEnv() });
        lines.push(`${name}: ok (${String(stdout).trim().split(/\r?\n/)[0]})`);
      } catch (e) {
        lines.push(`${name}: NOT available (${e?.code || e?.message || e}) — ${name === "git" ? "every git-based scope will fail" : "PR scopes (scope=pr, PR comments) will fail; local scopes still work"}`);
      }
    }

    if (installSkill) {
      const r = installBundledSkill();
      lines.push(r.installed ? `installSkill: installed -> ${r.dir}` : `installSkill: skipped — ${r.reason}`);
    }
    lines.unshift(`verdict: ${cliState}`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { verdict: cliState, cli: cli && !cli.error ? { path: cli.path, source: cli.source } : null } };
  }
);

function describeSkill(status) {
  if (status === "missing") return "missing (will be auto-installed on the first claude_code_review call; or call this tool with installSkill=true)";
  if (status === "bundled") return `installed (bundled, managed by this MCP) at ${userSkillDir()}`;
  return `user-managed skill present at ${userSkillDir()} — it will be used as-is`;
}

/* ------------------------------------------------------------------ */
/* Tool 2: claude_code_review                                         */
/* ------------------------------------------------------------------ */

server.tool(
  "claude_code_review",
  "Run Claude Code's code-review skill (5 parallel reviewer subagents, 0-100 confidence scoring, keeps findings >=80) " +
  "on a repository and return the markdown report. Costs Claude API credits; a run typically takes 2-15 minutes. " +
  "Afterwards, fix the code and re-run to verify, or use claude_review_followup with the returned session_id.",
  {
    repoPath: z.string().describe("Absolute path to the git repository to review (the review runs with cwd=repoPath; ~/ prefix allowed)"),
    scope: z.enum(["auto", "pr", "branch", "working-dir", "last-commit"]).default("auto")
      .describe("auto: PR if pr given / branch ahead of default / working-dir changes / last commit"),
    pr: z.string().optional().describe('GitHub PR number or URL, e.g. "123" or "owner/repo#123" (for scope=pr, or as first choice in auto)'),
    baseRef: z.string().optional().describe("Base branch/tag for scope=branch (default: auto-detect the default branch)"),
    focus: z.string().optional().describe("Extra review focus or instructions, e.g. '重点看并发安全'"),
    outputLanguage: z.string().default("中文").describe('Language for the report, e.g. "中文" or "English"'),
    postToPR: z.boolean().default(false).describe("Also post the summary comment to the GitHub PR via gh (default false — report only)"),
    fix: z.boolean().default(false)
      .describe("Fix mode: after the report, Claude Code edits the repo files to fix the confirmed findings (Edit only, no git commands, no commit; .git and secret paths are deny-listed). Adds a '## Fixes Applied' section."),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high")
      .describe("Review effort / reasoning level, same scale as Claude Code (--effort): low..max. max/xhigh = exhaustive deep review, slower and pricier."),
    model: z.string().optional().describe("Claude model override (passed as --model)"),
    maxTurns: z.number().int().min(4).max(200).default(80).describe("Agentic turn cap for the review session"),
    timeoutMinutes: z.number().int().min(1).max(60).default(ENV.timeoutMinutes).describe("Hard wall-clock timeout for the run"),
    maxBudgetUsd: z.number().min(0).max(50).optional()
      .describe(`API spend cap for this run via --max-budget-usd (default ${ENV.maxBudgetUsd}); 0 disables. On third-party gateways this depends on usage data the gateway returns.`),
    installSkillIfMissing: z.boolean().default(ENV.autoInstallSkill)
      .describe("Auto-install the bundled code-review skill into ~/.claude/skills when missing (default true)"),
    waitForResult: z.boolean().default(false)
      .describe("Block until the review finishes and return the report synchronously (2-15 min). Default false: returns a jobId at once — poll claude_review_status(jobId). Only set true if your MCP client has no ~30s tool-call timeout."),
  },
  async (args, extra) => {
    const {
      scope, baseRef, focus, postToPR, fix, effort,
      model, maxTurns, timeoutMinutes, installSkillIfMissing,
    } = args;
    const maxBudgetUsd = args.maxBudgetUsd ?? ENV.maxBudgetUsd;

    const prCheck = validatePr(args.pr);
    if (!prCheck.ok) return err(prCheck.error);
    const langCheck = validateLanguage(args.outputLanguage);
    if (!langCheck.ok) return err(langCheck.error);
    const baseRefCheck = validateBaseRef(baseRef);
    if (!baseRefCheck.ok) return err(baseRefCheck.error);
    const focusCheck = validateFocus(focus);
    if (!focusCheck.ok) return err(focusCheck.error);
    const { pr } = prCheck;
    const outputLanguage = langCheck.lang;

    const repoCheck = requireAbsoluteRepoPath(args.repoPath);
    if (!repoCheck.ok) return err(repoCheck.error);
    const repoPath = repoCheck.path;

    const cli = resolveClaudeCli();
    if (!cli) {
      return err("Claude Code CLI not found. Install it (https://code.claude.com/docs/en/setup), or set CLAUDE_CODE_PATH to the claude executable / cli.js, then retry. claude_review_env shows what was probed.");
    }
    if (cli.error) return err(cli.error);

    // --- shell guard + permission-mode version floors (H4, D1) ---------------
    // Checked before anything repo-specific: a disarmed guard is the one failure
    // that must never be discovered three minutes and a few dollars into a run.
    // Shared with claude_review_followup — both runs are agentic in the same repo.
    const hard = await prepareRunHardening(cli);
    if (!hard.ok) return err(hard.error);
    const { guard, guardSettings, permissionMode, permissionPrompts, hardening } = hard;
    const guardSetupNote = hard.note;
    // Guarded from here until runClaude's spawn returns: a concurrent
    // claude_review_env must not delete this file before claude has read it.
    markGuardSettingsInFlight(guardSettings, true);

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return err(`repoPath does not exist or is not a directory: ${repoPath}`);
    }
    // Every documented scope (auto/pr/branch/working-dir/last-commit) is
    // git-based, so a non-repo directory can only produce a doomed paid run.
    if (!isRepo(repoPath)) {
      return err(
        `${repoPath} is not a version-controlled repository (no .git/.hg/.svn found). ` +
        `Every review scope reads git history, so there is nothing to review here. ` +
        `Point repoPath at the repository root, or run \`git init\` and commit first.`
      );
    }
    let repoWarning = "";

    // Preflight git so an empty repo / missing git fails here, not 3 minutes
    // and a few dollars into the run.
    const pre = await gitPreflight(repoPath);
    if (pre.gitError) {
      // Not a warning: every scope reads git, so the run would burn credits and
      // fail. Say exactly what git said so the cause is actionable.
      const e = pre.gitError;
      const detail = [e.code, e.message].filter(Boolean).join(": ") || String(e);
      return err(
        `git failed in ${repoPath} (${detail}). Every review scope reads git history, so the review cannot run. ` +
        `If the repo lives on a network drive or in a sandbox, check that git can access it (ownership/safe.directory, permissions).`
      );
    } else if (!pre.hasCommits) {
      if (pre.dirty) {
        repoWarning += `⚠ note: the repository has no commits yet, so history-based scopes (branch/pr/last-commit) have nothing to diff — the reviewer can only look at uncommitted files.\n\n`;
      } else {
        return err(`Nothing to review: ${repoPath} has no commits and no uncommitted changes. Make a commit (or leave changes in the working tree) first.`);
      }
    }

    // Fail fast when a loopback gateway (CC Switch & friends) is down: claude
    // would otherwise retry silently for minutes and surface as a timeout.
    const gw = await probeGateway();
    const gwBefore = gatewayTarget(); // for the mid-run "gateway disappeared" check
    if (gw && gw.ok === false) {
      return err(`Local gateway not reachable: ${gw.host} (${gw.reason}). If you use CC Switch / claude-code-router / a local proxy, start it first, then retry.`);
    }

    // Skill: use user-managed > bundled(auto-install) > embedded fallback prompt.
    let skillMode;
    const status = skillStatus();
    if (status === "user") {
      skillMode = "code-review skill (user-managed)";
    } else if (status === "bundled") {
      skillMode = "code-review skill (bundled)";
    } else if (installSkillIfMissing) {
      const r = installBundledSkill();
      skillMode = r.installed ? "code-review skill (bundled, auto-installed this run)" : `fallback inline pipeline (${r.reason})`;
    } else {
      skillMode = "fallback inline pipeline (skill missing, auto-install disabled)";
    }
    const useSkill = skillMode.startsWith("code-review skill");

    // Only inject thinking keywords when the CLI lacks --effort (never both).
    const [effortFlagSupported, budgetFlagSupported, streamJsonSupported] = await Promise.all([
      supportsFlag(cli, "--effort"), supportsFlag(cli, "--max-budget-usd"),
      supportsStreamJson(cli),
    ]);

    // --- shell guard + permission-mode version floors (H4, D1) ---------------
    // (already resolved above, before the repo checks)

    const prompt = useSkill
      ? buildReviewPrompt({ scope, pr, baseRef: baseRefCheck.ref, focus: focusCheck.focus, outputLanguage, postToPR, fix, effort, useEffortFlag: effortFlagSupported, cwd: repoPath })
      : buildFallbackPrompt({ scope, pr, baseRef: baseRefCheck.ref, focus: focusCheck.focus, outputLanguage, fix, effort, useEffortFlag: effortFlagSupported, cwd: repoPath });

    const allowedTools = [...reviewAllowedTools(), ...(fix ? fixAllowedTools() : []), ...(postToPR ? postPROnlyTools() : [])];
    // fix mode MUST keep Edit/Write available: deny beats allow, so the review
    // deny list may only include them when fix is off. postToPR must be passed
    // through too, otherwise `Bash(gh pr comment:*)` stays in the deny list and
    // (deny beats allow) the PR-comment feature is dead code.
    const disallowedTools = [...reviewDisallowedTools({ fix, postToPR }), ...(fix ? fixDisallowedTools() : [])];

    // gh preflight (D6): a PR scope or postToPR without a usable gh fails deep
    // inside the run, after the model has already spent turns.
    if (scope === "pr" || postToPR) {
      const ghOk = await ghPreflight();
      if (!ghOk.ok) {
        return err(
          `gh is required for ${scope === "pr" ? "scope=pr" : "postToPR"} but is not usable (${ghOk.reason}). ` +
          `Install the GitHub CLI (https://cli.github.com), run \`gh auth login\`, then retry — or use a local scope (working-dir / last-commit) instead.`
        );
      }
    }

    // Repo-controlled git config that runs programs cannot be neutralised with
    // -c overrides (an arbitrary .gitattributes filter driver), so refuse it.
    // Dead config — a path carried over from another OS that does not exist on
    // this machine — cannot execute and is only noted in the report.
    const gitPrograms = repoRunsGitPrograms(repoPath);
    if (gitPrograms.refusals.length) {
      return err(
        `Refusing to review ${repoPath}: its own git configuration executes programs, which would run on the first git command the reviewer makes:\n` +
        gitPrograms.refusals.slice(0, 5).map((h) => `- ${h}`).join("\n") +
        `\nRemove the offending entries (.git/config / .gitattributes), or review a copy of the repository. ` +
        `(cc-code-review server v${SERVER_VERSION}; dead cross-machine paths are normally only a note — if you expected this to pass, the host may be running an older server process: restart ZCode / reconnect the MCP.)`
      );
    }
    const gitProgramNotes = gitPrograms.notes.length
      ? `note: stale/cross-machine git config in the repo (harmless on this machine, kept as a note):\n` +
        gitPrograms.notes.slice(0, 5).map((h) => `- ${h}`).join("\n") + "\n\n"
      : "";

    // Snapshot the working tree so a fix run can be verified against disk
    // instead of trusting the reviewer's own claim that it applied the fixes.
    const before = fix ? await gitStatusSnapshot(repoPath) : null;

    log(`review start: repo=${repoPath} scope=${scope}${pr ? ` pr=${pr}` : ""} pipeline=${skillMode} effort=${effort}${effortFlagSupported ? "" : "(keyword)"} fix=${fix}`);

    // A real review runs 2-15 minutes, and many MCP clients (ZCode included) cut
    // tool calls at ~30s — a synchronous contract can never complete there, and
    // callers end up re-implementing the invocation by hand. Default is therefore
    // ASYNC: this call returns a jobId right after the free preflight above, and
    // the report is fetched with claude_review_status(jobId). waitForResult=true
    // restores the synchronous contract for clients with long (or no) timeouts.
    const startedAt = Date.now();
    const jobAbort = new AbortController();
    const executeRun = async (signal, progressToken) => {
    // Best-effort progress notifications while the review runs.
    const token = progressToken ?? null;
    const progressTimer = token == null ? null : setInterval(() => {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      extra?.sendNotification?.({
        method: "notifications/progress",
        params: { progressToken: token, progress: mins, total: timeoutMinutes, message: `claude review in progress (${mins}min elapsed)` },
      }).catch(() => {});
    }, 60_000);

    const run = await runClaude({
      cli,
      repoPath,
      prompt,
      allowedTools,
      disallowedTools,
      model: model || ENV.model,
      maxTurns,
      maxBudgetUsd,
      effort,
      flags: {
        effort: effortFlagSupported,
        budget: budgetFlagSupported,
        settingSources: true,
        permissionMode,
        permissionPrompts,
        streamJson: streamJsonSupported,
      },
      guardSettings,
      timeoutMs: timeoutMinutes * 60_000,
      signal,
    });
    if (progressTimer) clearInterval(progressTimer);

    const logFile = writeLogFile(run.stdout, run.stderr);
    const j = run.json;
    const logNote = logNoteOf(logFile);

    if (run.cancelled) {
      return err(`review cancelled by the client after ${Math.round(run.durationMs / 1000)}s${logNote}${stderrTail(run.stderr)}`);
    }
    if (run.timedOut) {
      return err(
        `review timed out after ${timeoutMinutes} minutes. Retry with a larger timeoutMinutes, a narrower scope, or higher maxTurns.` +
        ` If you use CC Switch / a local gateway, also check it is still healthy (claude retries a dead endpoint silently).${logNote}${stderrTail(run.stderr)}`
      );
    }
    if (!j) {
      return err(
        `claude exited (code ${run.exitCode}) without a parseable result JSON. ` +
        `Check 'claude' works in a terminal from that repo (login, gateway, proxy).${logNote}${stderrTail(run.stderr)}`
      );
    }

    const looksLikeApiError = /^API Error/i.test(String(j.result || ""));
    const ok = j.subtype === "success" && j.is_error !== true && !looksLikeApiError;
    const status2 = ok ? "success" : (j.subtype && j.subtype !== "success" ? j.subtype : "claude reported an error");

    // Under `--permission-mode manual` a missing allowlist entry shows up here
    // instead of aborting the run — surface it, or a silently degraded review
    // (e.g. the 5 reviewer subagents never ran) would look like a clean result.
    const denials = Array.isArray(j.permission_denials) ? j.permission_denials : [];
    const deniedCommands = denials.map((d) => d?.tool_input?.command).filter((c) => typeof c === "string");
    // A denial the guard produced is the guard doing its job, not a degraded
    // review: the reviewer combined steps (or asked git to write a file) and can
    // retry differently. Keeping the two apart is what stops the warning from
    // crying wolf. The predicate is the same one the hook applies, so "reported
    // as blocked" and "actually blocked" cannot disagree.
    const guardWouldBlock = (cmd) => !analyseCommand(cmd).ok || gitWriteFlagReason(cmd) !== null;
    const guardBlocked = deniedCommands.filter(guardWouldBlock);
    const realDenials = denials.filter((d) => {
      const cmd = d?.tool_input?.command;
      return typeof cmd !== "string" || !guardWouldBlock(cmd);
    });
    const denialNote = realDenials.length
      ? `⚠ ${realDenials.length} tool call(s) were denied by the permission allowlist (this MCP runs claude with --permission-mode manual) — the review may be incomplete: ` +
        [...new Set(realDenials.map((d) => d?.tool_name || d?.tool || JSON.stringify(d)))].slice(0, 10).join(", ")
      : "";
    const guardNote = shellGuardNote(deniedCommands, deniedCommands) || "";

    // Fix mode: verify the fixes actually reached disk. A reviewer can describe
    // perfect edits and still write nothing (its Edit/Write calls denied, or it
    // simply ran out of turns) — the working tree is the only honest evidence.
    let fixNote = "";
    if (fix && ok && before !== null) {
      const after = await gitStatusSnapshot(repoPath);
      if (after !== null && after === before) {
        fixNote =
          "⚠ FIX MODE VERIFICATION FAILED — the working tree is unchanged after the run, so no fix was actually written to disk. " +
          "The reviewer may have only described the fixes (its edit calls denied, or it ran out of turns). Check the full log, then re-run with fix=true and a higher maxTurns.";
      } else if (after !== null) {
        const changed = after.split(/\r?\n/).filter(Boolean).length;
        fixNote = `fix verification: ${changed} file(s) modified in the working tree (no commit was made — review the diff, then commit yourself).`;
      }
    }

    // Backstop reporting: chained commands that actually RAN. The hook is what
    // blocks them, so this should stay empty; when it is not, the run escaped
    // the guard and the repo has to be treated as hostile.
    const chainNote = shellChainingNote(run.bashCommands, deniedCommands) || "";

    // CC Switch rewrites ~/.claude/settings.json when the user switches provider.
    // If the gateway this run was configured with vanished OR CHANGED mid-run,
    // the report's provenance is unclear — say so instead of presenting it as
    // authoritative. A provider switch rewrites the URL rather than unsetting
    // it, so comparing identity alone misses the common case.
    const gwAfter = gatewayTarget();
    const gwChanged = gwBefore && gwAfter && gwBefore.url.href !== gwAfter.url.href;
    const gwNote = (gwBefore && !gwAfter)
      ? `⚠ the gateway configuration disappeared during the run (ANTHROPIC_BASE_URL was ${gwBefore.url} when the run started and is not set any more) — CC Switch may have switched providers mid-review.`
      : (gwChanged
        ? `⚠ the gateway endpoint changed during the run (${gwBefore.url} → ${gwAfter.url}) — CC Switch likely switched providers mid-review, so the report may mix two models.`
        : "");

    const warnings = [guardSetupNote, repoWarning.trim(), gitProgramNotes.trim(), denialNote, guardNote, chainNote, fixNote, gwNote].filter(Boolean).join("\n\n");

    const meta = {
      status: status2,
      sessionId: j.session_id,
      costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
      numTurns: j.num_turns,
      durationMs: j.duration_ms ?? run.durationMs,
      skillMode,
      logFile,
      warning: warnings || undefined,
      subagentsSpawned: j.subagent_stats?.spawned ?? undefined,
      permissionDenials: realDenials.length,
      shellGuardBlocked: guardBlocked.length,
      bashCalls: Array.isArray(run.bashCommands) ? run.bashCommands.length : undefined,
      shellGuard: guard.state === "on"
        ? "PreToolUse hook (blocks chained/substituted Bash commands)"
        : `OFF — ${guard.reason}`,
    };
    log(`review done: ${meta.status} cost=${meta.costUsd} turns=${meta.numTurns} subagents=${meta.subagentsSpawned} denials=${meta.permissionDenials} guardBlocked=${meta.shellGuardBlocked} bashCalls=${meta.bashCalls} guard=${guard.state}`);

    if (!ok) {
      return {
        isError: true,
        content: [{ type: "text", text: gitProgramNotes + failureBanner(j, run) + stderrTail(run.stderr) + logNote }],
        structuredContent: {
          status: status2, sessionId: j.session_id, costUsd: meta.costUsd,
          numTurns: j.num_turns, durationMs: meta.durationMs, pipeline: skillMode, effort, fix, logFile,
          hardening,
          error: String(j.result || ""),
          permissionDenials: meta.permissionDenials,
        },
      };
    }

    return {
      content: [{ type: "text", text: (warnings ? warnings + "\n\n" : "") + runResultText(j.result, meta) }],
      structuredContent: {
        status: "success", sessionId: j.session_id, costUsd: meta.costUsd,
        numTurns: j.num_turns, durationMs: meta.durationMs, pipeline: skillMode, effort, fix, logFile,
        hardening,
        report: j.result,
        subagentsSpawned: meta.subagentsSpawned,
        permissionDenials: meta.permissionDenials,
      },
    };
    }; // end executeRun

    if (args.waitForResult) return executeRun(extra?.signal, extra?._meta?.progressToken);

    // Async mode: hand back a jobId at once; the run continues in the background
    // (the server outlives this request) and its result waits in the job registry.
    const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId, repoPath, scope: scope + (pr ? ` pr=${pr}` : ""), fix, effort,
      startedAt, state: "running", result: null, abort: jobAbort,
    };
    reviewJobs.set(jobId, job);
    // The client cancelling THIS initial call must not orphan the background
    // run: tie its signal to the job's abort as well.
    if (extra?.signal) {
      // the client may have cancelled while preflight ran: an already-aborted
      // signal never fires listeners, and the SDK drops our response — the run
      // would bill with no jobId ever reaching the caller
      if (extra.signal.aborted) jobAbort.abort();
      else extra.signal.addEventListener("abort", () => jobAbort.abort(), { once: true });
    }
    void executeRun(jobAbort.signal, undefined)
      .then((result) => { job.result = result; job.state = "done"; job.finishedAt = Date.now(); })
      .catch((e) => { job.result = err(`review job crashed: ${e?.message || e}`); job.state = "done"; job.finishedAt = Date.now(); })
      .finally(() => pruneReviewJobs());
    return {
      content: [{
        type: "text",
        text:
          `Review started in the background (all free preflight checks passed — guard verified, gateway reachable, skill ready).\n` +
          `jobId: ${jobId}\n` +
          `A real review takes 2-15 minutes. Poll it with the claude_review_status tool: pass {"jobId": "${jobId}"} — while running it reports elapsed time, when finished it returns the full report (same shape a synchronous call would). ` +
          `Pass {"jobId": "${jobId}", "cancel": true} to abort and stop billing. (This async default exists because MCP clients commonly cut tool calls at ~30s; use waitForResult=true only if your client has no such timeout.)`,
      }],
      structuredContent: { jobId, status: "running", repoPath, scope, effort, fix, startedAt },
    };
  }
);

/* ------------------------------------------------------------------ */
/* Tool 2b: claude_review_status — poll/fetch/cancel a background job  */
/* ------------------------------------------------------------------ */

server.tool(
  "claude_review_status",
  "Poll a background review started by claude_code_review (which returns fast with a jobId because real reviews take 2-15 minutes). " +
  "With jobId: returns elapsed time while running, or the full report/result when finished. With cancel=true: aborts the run and stops billing. " +
  "Without jobId: lists the recent jobs of this server process.",
  {
    jobId: z.string().optional().describe("The jobId returned by claude_code_review"),
    cancel: z.boolean().default(false).describe("Abort the running job (kills the claude process tree, stops billing)"),
  },
  async ({ jobId, cancel }) => {
    if (!jobId) {
      if (!reviewJobs.size) {
        return { content: [{ type: "text", text: "no review jobs in this server process yet — start one with claude_code_review (it returns a jobId immediately)" }] };
      }
      const lines = [...reviewJobs.values()].map((j) =>
        `${j.id}  ${j.state}${j.state === "running" ? ` (${Math.round((Date.now() - j.startedAt) / 1000)}s elapsed)` : ""}  ${j.scope}  ${j.repoPath}${j.fix ? "  [fix]" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const job = reviewJobs.get(jobId);
    if (!job) {
      return err(`unknown jobId "${jobId}" — jobs live in the server process that created them (older ones are pruned once 10 newer jobs finished; a host restart clears them all). List current jobs by calling this tool without jobId.`);
    }
    if (job.state === "running") {
      if (cancel) {
        job.abort.abort();
        return { content: [{ type: "text", text: `cancellation requested for ${jobId} — the claude process tree is being killed; poll again in a few seconds for the final state (billing stops within ~2s of the kill).` }] };
      }
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      return {
        content: [{ type: "text", text: `still running: ${secs}s elapsed (${job.scope}, ${job.repoPath}). Reviews typically take 2-15 minutes — poll again in a minute or two. Cancel with {"jobId": "${jobId}", "cancel": true}.` }],
        structuredContent: { jobId, status: "running", elapsedSec: secs },
      };
    }
    if (cancel) return { content: [{ type: "text", text: `job ${jobId} already finished — nothing to cancel.` }] };
    return job.result;
  }
);

/* ------------------------------------------------------------------ */
/* Tool 3: claude_review_followup                                     */
/* ------------------------------------------------------------------ */

server.tool(
  "claude_review_followup",
  "Continue the conversation of a previous claude_code_review run (same reviewer context, e.g. " +
  "'为什么第 2 条是问题？' or 're-check after my fix'). Pass the session_id returned by claude_code_review. " +
  "Async by default (returns a jobId; poll claude_review_status) — waitForResult=true blocks synchronously.",
  {
    sessionId: z.string().describe("session_id returned by a previous claude_code_review / claude_review_followup call"),
    message: z.string().describe("Question or instruction for the reviewer"),
    repoPath: z.string().describe("Absolute path of the repo the original review ran in (~/ prefix allowed)"),
    outputLanguage: z.string().default("中文"),
    model: z.string().optional(),
    timeoutMinutes: z.number().int().min(1).max(60).default(Math.min(10, ENV.timeoutMinutes)),
    maxBudgetUsd: z.number().min(0).max(50).optional(),
    waitForResult: z.boolean().default(false)
      .describe("Block synchronously for the reply. Default false: returns a jobId at once (poll claude_review_status) — use that with clients that cut tool calls at ~30s."),
  },
  async (args, extra) => {
    const { sessionId, message, model, timeoutMinutes } = args;
    const maxBudgetUsd = args.maxBudgetUsd ?? ENV.maxBudgetUsd;

    const langCheck = validateLanguage(args.outputLanguage);
    if (!langCheck.ok) return err(langCheck.error);
    const outputLanguage = langCheck.lang;

    const repoCheck = requireAbsoluteRepoPath(args.repoPath);
    if (!repoCheck.ok) return err(repoCheck.error);
    const repoPath = repoCheck.path;

    const cli = resolveClaudeCli();
    if (!cli) return err("Claude Code CLI not found (set CLAUDE_CODE_PATH or see claude_review_env).");
    if (cli.error) return err(cli.error);

    // Same fail-closed guard gate as a full review, and in the same order: a
    // disarmed guard is reported before anything repo-specific.
    const hard = await prepareRunHardening(cli);
    if (!hard.ok) return err(hard.error);
    const { guardSettings, permissionMode, permissionPrompts, hardening } = hard;

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return err(`repoPath does not exist or is not a directory: ${repoPath}`);
    }

    // Same repo-controlled git-config gate as a full review: the followup child
    // runs the same allowlisted git reads from cwd=repoPath, so a live
    // core.fsmonitor / driver would execute here too. (Dead cross-machine
    // config only notes, matching the review path.)
    const gitPrograms = repoRunsGitPrograms(repoPath);
    if (gitPrograms.refusals.length) {
      return err(
        `Refusing to run the followup in ${repoPath}: its own git configuration executes programs, which would run on the first git command the reviewer makes:\n` +
        gitPrograms.refusals.slice(0, 5).map((h) => `- ${h}`).join("\n") +
        `\nRemove the offending entries (.git/config / .gitattributes), or review a copy of the repository. (cc-code-review server v${SERVER_VERSION})`
      );
    }
    const gitProgramNotes = gitPrograms.notes.length
      ? `note: stale/cross-machine git config in the repo (harmless on this machine):\n` +
        gitPrograms.notes.slice(0, 5).map((h) => `- ${h}`).join("\n") + "\n\n"
      : "";

    const gw = await probeGateway();
    if (gw && gw.ok === false) {
      return err(`Local gateway not reachable: ${gw.host} (${gw.reason}). Start CC Switch / your local gateway, then retry.`);
    }

    log(`followup start: session=${sessionId}`);
    // A followup is an agentic run in the same repo, so it gets the same
    // permission model, shell guard and stream parsing as a full review.
    const [budgetFlagSupported, streamJsonSupported] = await Promise.all([
      supportsFlag(cli, "--max-budget-usd"), supportsStreamJson(cli),
    ]);
    const startedAt = Date.now();
    const jobAbort = new AbortController();
    const executeFollowup = async (signal, progressToken) => {
    // Best-effort progress notifications while the followup runs (mirrors the
    // review path so clients that render progress treat both tools alike).
    const token = progressToken ?? null;
    const progressTimer = token == null ? null : setInterval(() => {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      extra?.sendNotification?.({
        method: "notifications/progress",
        params: { progressToken: token, progress: mins, total: timeoutMinutes, message: `claude followup in progress (${mins}min elapsed)` },
      }).catch(() => {});
    }, 60_000);
    const run = await runClaude({
      cli,
      repoPath,
      prompt: buildFollowupPrompt(message, outputLanguage),
      allowedTools: reviewAllowedTools(),
      disallowedTools: reviewDisallowedTools({ fix: false }),
      model: model || ENV.model,
      maxTurns: 30,
      maxBudgetUsd,
      resumeSessionId: sessionId,
      flags: {
        effort: false,
        budget: budgetFlagSupported,
        settingSources: true,
        permissionMode,
        permissionPrompts,
        streamJson: streamJsonSupported,
      },
      guardSettings,
      timeoutMs: timeoutMinutes * 60_000,
      signal,
    });
    if (progressTimer) clearInterval(progressTimer);

    const logFile = writeLogFile(run.stdout, run.stderr);
    const logNote = logNoteOf(logFile);
    const j = run.json;

    if (run.cancelled) return err(`followup cancelled by the client.${logNote}`);
    if (run.timedOut) return err(`followup timed out after ${timeoutMinutes} minutes.${logNote}${stderrTail(run.stderr)}`);
    if (!j) return err(`claude exited (code ${run.exitCode}) without a parseable result (bad session_id? gateway down?).${logNote}${stderrTail(run.stderr)}`);

    const looksLikeApiError = /^API Error/i.test(String(j.result || ""));
    const ok = j.subtype === "success" && j.is_error !== true && !looksLikeApiError;
    const status2 = ok ? "success" : (j.subtype && j.subtype !== "success" ? j.subtype : "claude reported an error");
    if (!ok) {
      return {
        isError: true,
        content: [{ type: "text", text: failureBanner(j, run) + stderrTail(run.stderr) + logNote }],
        structuredContent: { status: status2, sessionId: j.session_id ?? sessionId, reply: String(j.result || "") },
      };
    }
    const chainNote = shellChainingNote(run.bashCommands);
    return {
      content: [{ type: "text", text: gitProgramNotes + runResultText(j.result, {
        status: status2,
        sessionId: j.session_id ?? sessionId,
        costUsd: j.total_cost_usd, numTurns: j.num_turns, durationMs: j.duration_ms, logFile,
      }) + (chainNote ? `\n\n${chainNote}` : "") }],
      structuredContent: {
        status: status2, sessionId: j.session_id ?? sessionId,
        costUsd: j.total_cost_usd, numTurns: j.num_turns, durationMs: j.duration_ms, reply: j.result,
        hardening,
        bashCalls: Array.isArray(run.bashCommands) ? run.bashCommands.length : undefined,
      },
    };
    }; // end executeFollowup

    if (args.waitForResult) return executeFollowup(extra?.signal, extra?._meta?.progressToken);

    const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId, repoPath, scope: `followup session=${String(sessionId).slice(0, 8)}`, fix: false, effort: "-",
      startedAt, state: "running", result: null, abort: jobAbort,
    };
    reviewJobs.set(jobId, job);
    if (extra?.signal) {
      if (extra.signal.aborted) jobAbort.abort();
      else extra.signal.addEventListener("abort", () => jobAbort.abort(), { once: true });
    }
    void executeFollowup(jobAbort.signal)
      .then((result) => { job.result = result; job.state = "done"; job.finishedAt = Date.now(); })
      .catch((e) => { job.result = err(`followup job crashed: ${e?.message || e}`); job.state = "done"; job.finishedAt = Date.now(); })
      .finally(() => pruneReviewJobs());
    return {
      content: [{
        type: "text",
        text:
          `Followup started in the background (free preflight passed).\njobId: ${jobId}\n` +
          `Poll claude_review_status with {"jobId": "${jobId}"} for the reply; {"jobId": "${jobId}", "cancel": true} aborts it. ` +
          `(waitForResult=true would have blocked synchronously — use the async form with clients that cut tool calls.)`,
      }],
      structuredContent: { jobId, status: "running", repoPath, sessionId, startedAt },
    };
  }
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready — tools: claude_code_review (async), claude_review_status, claude_review_followup (async), claude_review_env");

// Client went away (stdio closed): stop any in-flight review instead of letting
// it run to its timeout and keep billing. claude.js registers an "exit" handler
// that kills the whole child tree synchronously before the process goes down.
transport.onclose = () => {
  log("transport closed — shutting down (in-flight reviews are killed)");
  process.exit(0);
};

// Startup prewarm (background, non-blocking): resolve the CLI and fetch its
// --version/--help once so the first tool call doesn't pay for cold spawns.
// Deliberately AFTER connect: CLI resolution may kick off an async npm query
// (a cold npm cache can take seconds) and must never delay the MCP handshake.
// Failures are harmless — the call path re-runs these on demand.
void (async () => {
  try {
    // Settled variant: if the CLI is only reachable via the async npm-root probe
    // (custom prefix, not on a GUI host's sparse PATH), wait the probe out here
    // so the very first tool call already resolves instead of NOT_FOUND.
    const cli = await resolveClaudeCliSettled();
    if (!cli || cli.error) return;
    await Promise.all([
      claudeVersion(cli).catch(() => {}),
      supportsFlag(cli, "--effort").catch(() => {}),
      supportsFlag(cli, "--max-budget-usd").catch(() => {}),
    ]);
    log(`prewarm done: ${cli.path}`);
  } catch (e) {
    log("prewarm skipped:", e?.message || e);
  }
})();
