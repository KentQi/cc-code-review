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
  cleanupGuardSettings, activeSubagentFiles, settingsParseProblem, peekSettingsEnv, markGuardSettingsInFlight,
  analyseCommand, shellGuardNote, shellChainingNote,
  probeGateway, gatewayTarget, authEnvResidue, modelEnvOverrides, gitPreflight,
  buildClaudeEnv, repoRunsGitPrograms, gitSpawnOpts, GIT_HARDENING_ARGS,
  buildModelProvenance, resultFacts,
} from "./claude.js";
import {
  buildReviewPrompt, buildFallbackPrompt, buildFollowupPrompt, buildNativeCommand, buildNativeAppendix,
  reviewAllowedTools, reviewDisallowedTools, fixAllowedTools, fixDisallowedTools, postPROnlyTools,
  deriveReviewLevel, validateBaseRef,
} from "./prompt.js";

/**
 * Our scopes, expressed as the native command's [target] argument.
 * - pr        → the PR number/URL (also when scope=auto was given a pr, which
 *   the tool documents as "auto: PR if pr given")
 * - branch    → the base branch (the built-in diffs <base>...HEAD)
 * - last-commit → HEAD~1
 * - working-dir / auto without pr → no target (the built-in includes
 *   uncommitted changes and infers the upstream range by itself)
 */
function nativeTarget({ scope, pr, baseRef }) {
  if (pr && (scope === "pr" || scope === "auto")) return String(pr);
  if (scope === "branch") return baseRef || undefined;
  if (scope === "last-commit") return "HEAD~1";
  return undefined;
}
import { skillStatus, skillSync, installBundledSkill, userSkillDir } from "./skill.js";
import { SERVER_VERSION, codeDrift } from "./version.js";

const execFileAsync = promisify(execFile);
const log = (...a) => console.error("[cc-code-review]", ...a);

const ENV = {
  // clamp to the same ranges the zod schema enforces, otherwise an out-of-range
  // env default makes every call that omits the param fail with '-32602 ... at
  // timeoutMinutes' naming no env var
  timeoutMinutes: Math.min(60, Math.max(1, Math.round(positive(process.env.CLAUDE_REVIEW_TIMEOUT_MIN, 30)))),
  // 0 = no spend cap (the default): a cap stops the parent before it synthesizes,
  // and with incremental subagent capture a 429/token exhaustion no longer wastes
  // the finished work. Set CLAUDE_REVIEW_MAX_BUDGET_USD to re-arm a cap.
  maxBudgetUsd: Math.min(50, nonNegative(process.env.CLAUDE_REVIEW_MAX_BUDGET_USD, 0)),
  model: process.env.CLAUDE_REVIEW_MODEL || undefined,
  autoInstallSkill: process.env.CLAUDE_REVIEW_AUTO_INSTALL_SKILL === "1",
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
  // A finished job is either "done" (a successful result) or "failed" (the tool
  // result was an error); every other state is still in flight and addressable.
  const finished = [...reviewJobs.values()]
    .filter((j) => j.state === "done" || j.state === "failed")
    // Evict in COMPLETION order. The Map's insertion order is START order, so a
    // long review that started first and finished last was the first entry
    // deleted the moment it settled — a client polling it got "unknown jobId"
    // right after it completed (audit P2-4). settledAt is stamped by
    // settleReviewJob; finishedAt is the older field kept for compatibility.
    .sort((a, b) => (a.settledAt ?? a.finishedAt ?? 0) - (b.settledAt ?? b.finishedAt ?? 0));
  for (const j of finished.slice(0, Math.max(0, finished.length - JOB_KEEP))) reviewJobs.delete(j.id);
}
/**
 * Record a finished background job. `state` is the first thing a listing/polling
 * client sees, so an error result must not settle as "done": reading "done" for
 * a review that produced no report is the same "no findings vs no output"
 * confusion the empty-report handling in executeRun exists to prevent.
 */
function settleReviewJob(job, result) {
  job.result = result;
  job.state = result?.isError === true ? "failed" : "done";
  job.finishedAt = Date.now();
  // Completion time, used by pruneReviewJobs to evict the oldest FINISHED job
  // instead of the oldest STARTED one.
  job.settledAt = job.finishedAt;
}
/**
 * Add the polled jobId to a finished async result. It used to be dropped once
 * the job settled, so a client polling several jobs had no machine-readable way
 * to tie a report back to the job it asked about (audit P-03). Additive only:
 * every existing field keeps its value and meaning.
 */
function withJobId(result, jobId) {
  if (!result || typeof result !== "object") return result;
  const sc = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
  return { ...result, structuredContent: { ...sc, jobId } };
}
function logsDir() {
  // 0700 so review logs (they quote repo code) stay private from other local users on macOS/Linux.
  // Overridable because Windows has no POSIX mode bits: CLAUDE_REVIEW_LOG_DIR lets a user point
  // the logs at a directory their own ACLs protect (see README "已知残留风险（Windows）").
  const base = process.env.CLAUDE_REVIEW_LOG_DIR?.trim() || path.join(os.tmpdir(), "cc-code-review");
  const dir = path.resolve(base);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mode: only applies when the directory is CREATED. On Linux /tmp is shared,
    // so a pre-existing /tmp/cc-code-review (or a symlink to an attacker-owned
    // directory) would otherwise receive the run logs and the guard settings file
    // — the latter is read by claude at spawn time, i.e. it is a hook-injection
    // point. Refuse links, require our own uid, and force 0700.
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) throw new Error("refusing a symlinked log directory");
    if (!st.isDirectory()) throw new Error("not a directory");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error("owned by uid " + st.uid + ", not " + process.getuid());
    }
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  } catch (e) {
    // Sync runs (waitForResult=true) used to let a raw ENOTDIR/EACCES/ENOSPC
    // escape the tool handler as an opaque internal error. Name the directory
    // and mark the error so both run paths can turn it into an actionable tool
    // result before any paid work starts (audit P2-12).
    const err = new Error(`log directory ${dir} could not be created (${e?.code || e?.message || e})`);
    err.code = "CCR_LOG_DIR_UNWRITABLE";
    err.logDir = dir;
    throw err;
  }
  return dir;
}

function writeLogFile(stdout, stderr, protectedFiles = []) {
  try {
    const dir = logsDir();
    const file = path.join(dir, `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
    // stderr can run to megabytes (a gateway error loop). Keep the HEAD (the
    // first failure — usually the root cause) AND the TAIL (the last state):
    // a tail-only log buries the ECONNREFUSED that explains everything.
    const STDERR_HEAD = 8000, STDERR_TAIL = 16000;
    const stderrPart = stderr.length > STDERR_HEAD + STDERR_TAIL
      ? `${stderr.slice(0, STDERR_HEAD)}\n... [stderr truncated in this log: ${stderr.length - STDERR_HEAD - STDERR_TAIL} chars omitted] ...\n${stderr.slice(-STDERR_TAIL)}`
      : stderr;
    fs.writeFileSync(file, `# claude stdout\n${stdout}\n\n# claude stderr\n${stderrPart}\n`, { mode: 0o600 });
    // retention: keep the newest LOG_KEEP logs
    try {
      // A subagent journal is the durable copy of reports the caller can still
      // read (partial_reports_file); the 20-file retention must skip it even
      // when its mtime falls outside the newest 20. Two protections are needed:
      //  - activeSubagentFiles: a run still in flight;
      //  - protectedFiles: this run's own journal. claude.js drops the active
      //    mark when the run settles, and this function runs right after, so
      //    without it the just-finished run's result would name a file this
      //    retention deletes one statement earlier (audit P1-2).
      const keep = new Set([...activeSubagentFiles, ...protectedFiles].filter(Boolean).map((p) => path.resolve(p)));
      const all = fs.readdirSync(dir).filter((f) =>
        f.startsWith("run-") ||
        (f.startsWith("subagents-") && f.endsWith(".jsonl") && !keep.has(path.resolve(dir, f)))
      );
      const olds = all.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
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
  // `~user/...` is a shell expansion this server cannot (and must not guess
  // another user's home to) perform — name it instead of falling through to
  // the generic "must be absolute" error.
  if (p.startsWith("~") && expanded === p) {
    return {
      ok: false,
      error:
        `repoPath "${p}" uses the ~user form, which is not supported — pass an absolute path, ` +
        `or ~/ to mean your own home directory.`,
    };
  }
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

/** Accepts "123", "#123", "owner/repo#123", or a plain github.com PR URL.
 *  The URL form must END at the number: the value becomes the native
 *  command's target argument, and claude parses its own flags anywhere in
 *  that string, so a trailing "/ low --fix" would reconfigure the review. */
function validatePr(pr) {
  if (!pr) return { ok: true, pr: undefined };
  const s = String(pr).trim();
  if (/^#?\d{1,10}$/.test(s)) return { ok: true, pr: s.replace(/^#/, "") };
  if (/^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,10}$/.test(s)) return { ok: true, pr: s };
  if (/^https?:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/\d{1,10}$/.test(s)) return { ok: true, pr: s };
  return {
    ok: false,
    error: `pr must be a PR number ("123"), "owner/repo#123", or a plain GitHub PR URL ending at the number — got ${JSON.stringify(pr)}. ` +
      `Trailing text is rejected because the value becomes the /code-review command's target argument and the command parses its own flags anywhere in it.`,
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

// baseRef is validated by prompt.js's validateBaseRef — the SAME function the
// prompt builder uses to decide it can spell the ref. Keeping one rule is what
// stops a value the preflight accepts from being silently dropped from the
// reviewer prompt (audit P0-5): the two validators used to disagree on "^",
// "~" and "@", so a fleet review of "HEAD~1" reviewed the default-branch diff.

/**
 * sessionId goes straight into argv as `--resume <sessionId>` (claude.js). A
 * leading "-" would be parsed as another claude flag instead of the value, so
 * the shape is enforced here — the same rule, for the same reason, that
 * validateBaseRef applies to refs echoed into git commands. Real session ids
 * are UUIDs / hex / sess_-style tokens; the charset below covers all of them.
 */
function validateSessionId(id) {
  const s = String(id ?? "").trim();
  if (!s) return { ok: false, error: "sessionId is required (pass the session_id returned by a previous claude_code_review run)." };
  if (s.length > 128) return { ok: false, error: "sessionId must be <= 128 chars" };
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s.startsWith("-")) {
    return {
      ok: false,
      error:
        `sessionId must be a plain session token (letters, digits, ".", "_", "-"; no leading "-") — got ${JSON.stringify(id)}. ` +
        `It is passed to claude as --resume <sessionId>, so a leading "-" would be parsed as a claude option.`,
    };
  }
  return { ok: true, sessionId: s };
}

/**
 * `model` goes straight into argv as `--model <model>` — same leading-"-"
 * argv-injection rule as sessionId, plus a charset that covers real model ids
 * (claude-sonnet-4-5, us.anthropic.claude-*, openrouter-style org/model).
 */
function validateModel(model) {
  if (model == null || model === "") return { ok: true, model: undefined };
  const s = String(model).trim();
  if (!s) return { ok: true, model: undefined };
  if (s.length > 80) return { ok: false, error: "model must be <= 80 chars" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/.test(s)) {
    return {
      ok: false,
      error:
        `model must be a plain model id (letters, digits, ".", "_", "-", "/", ":", "@", "+"; no leading "-") — got ${JSON.stringify(model)}. ` +
        `It is passed to claude as --model <model>, so a leading "-" would be parsed as a claude option.`,
    };
  }
  return { ok: true, model: s };
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
function runMetaLines(meta) {
  const lines = [
    `- status: ${meta.status}`,
    ...(meta.warning ? [`- warning: ${meta.warning}`] : []),
    ...(meta.sessionId ? [`- session_id: ${meta.sessionId} (use claude_review_followup to continue this review)`] : []),
    ...(typeof meta.costUsd === "number" ? [`- cost_usd: ${meta.costUsd.toFixed(4)}`] : []),
    ...(meta.numTurns != null ? [`- turns: ${meta.numTurns}`] : []),
    ...(meta.durationMs != null ? [`- wall_time_s: ${Math.round(meta.durationMs / 1000)}`] : []),
    ...(meta.skillMode ? [`- pipeline: ${meta.skillMode}`] : []),
    ...(meta.subagentsSpawned != null ? [`- reviewer_subagents_spawned: ${meta.subagentsSpawned}${meta.subagentsSpawned === 0 ? " (0 — the reviewer worked inline; normal for small diffs, but check permission_denials if the report looks thin)" : ""}`] : []),
    ...(meta.effectiveModel ? [`- effective_model: ${meta.effectiveModel}`] : []),
    ...(meta.modelsBilled ? [`- models_billed: ${meta.modelsBilled}`] : []),
    ...(meta.ultracode ? [`- ultracode: on (standing dynamic-workflow orchestration via the native Workflow tool)`] : []),
    ...(meta.workflowRuns ? [`- workflow_runs: ${meta.workflowRuns} (native Workflow orchestration dispatches)`] : []),
    ...(meta.reviewLevel ? [`- review_level: ${meta.reviewLevel} (reviewer-fleet depth: low..max)`] : []),
    ...(typeof meta.subagentsFile === "string" ? [`- partial_reports_file: ${meta.subagentsFile} (one JSONL line per finished subagent, written as each lands)`] : []),
    ...(meta.subagentStats?.completed != null ? [`- subagents_completed: ${meta.subagentStats.completed}/${meta.subagentStats.spawned ?? "?"}${meta.subagentStats.failed ? `, failed: ${meta.subagentStats.failed}` : ""}${meta.subagentStats.killed?.system ? `, stopped by budget/system: ${meta.subagentStats.killed.system}` : ""}`] : []),
    ...(meta.permissionDenials ? [`- permission_denials: ${meta.permissionDenials}`] : []),
    ...(typeof meta.logFile === "string" ? [`- full_log: ${meta.logFile}`] : []),
    ...(meta.logFile?.error ? [`- full_log: ${meta.logFile.error}`] : []),
  ];
  return lines;
}

function runResultText(report, meta) {
  const lines = [
    report || "(claude returned an empty report)",
    "",
    "---",
    `_run metadata_`,
    ...runMetaLines(meta),
  ];
  return lines.join("\n");
}

/**
 * The reviewer subagents' own reports, appended after the synthesis. A direct
 * Claude Code session shows all five experts working; the MCP used to hand
 * back only the parent's summary, which is why its output could not reproduce
 * the interactive run. Each report is capped in the text channel (the full
 * stream stays in the log file); structuredContent carries the same reports.
 */
function subagentReportsText(reports, cap = 4000) {
  if (!Array.isArray(reports) || !reports.length) return "";
  const blocks = reports.map((r, i) => {
    const kind = [r.subagentType || null, r.async ? "async" : null, r.status || null, r.partial ? `partial (${r.recovery || "recovered"})` : null].filter(Boolean).join(", ");
    const head = `### ${i + 1}. ${r.description || r.subagentType || "reviewer subagent"}${kind ? ` (${kind})` : ""}`;
    const body = (r.report || "").trim() ||
      (r.status && r.status !== "completed"
        ? `_(no report — the subagent ended with status "${r.status}" (e.g. a budget/turn cap stopped it); see the full log)_`
        : "_(no report captured — see the full log)_");
    const shown = body.length > cap ? `${body.slice(0, cap)}\n…(truncated at ${cap} chars — full text in the log file)` : body;
    return `${head}\n\n${shown}`;
  });
  return `## Reviewer subagent reports (${reports.length} dispatched)\n\n${blocks.join("\n\n")}`;
}

/**
 * Split one run's `permission_denials` into the two things a denial can mean.
 *
 * A denial the guard produced is the guard doing its job, not a degraded
 * review: the reviewer combined steps (or asked git to write a file) and can
 * retry differently. Everything else is a real allowlist gap that may have
 * degraded the run and must be reported. Shared by claude_code_review and
 * claude_review_followup: the followup used to pass an EMPTY denied set to the
 * chaining reporter, so every command the guard correctly blocked was reported
 * as "RAN WITHOUT BEING BLOCKED ... treat this repository as hostile", while a
 * real denial in a followup was never reported at all (audit P0-7).
 */
function classifyDenials(json, repoPath) {
  const denials = Array.isArray(json?.permission_denials) ? json.permission_denials : [];
  const deniedCommands = denials.map((d) => d?.tool_input?.command).filter((c) => typeof c === "string");
  // The predicate is the same one the hook applies, so "reported as blocked"
  // and "actually blocked" cannot disagree.
  const guardWouldBlock = (cmd) => !analyseCommand(cmd, { repoRoot: repoPath }).ok;
  const guardBlocked = deniedCommands.filter(guardWouldBlock);
  const realDenials = denials.filter((d) => {
    const cmd = d?.tool_input?.command;
    return typeof cmd !== "string" || !guardWouldBlock(cmd);
  });
  const denialNote = realDenials.length
    ? `⚠ ${realDenials.length} tool call(s) were denied by the permission allowlist (this MCP runs claude with --permission-mode manual) — the review may be incomplete: ` +
      [...new Set(realDenials.map((d) => d?.tool_name || d?.tool || JSON.stringify(d)))].slice(0, 10).join(", ")
    : "";
  // Same options as the hook: `cd <repoRoot>` is allowed, so it must not be
  // reported as a guard block here either.
  const guardNote = shellGuardNote(deniedCommands, deniedCommands, { repoRoot: repoPath }) || "";
  return { deniedCommands, guardBlocked, realDenials, denialNote, guardNote };
}

function logNoteOf(logFile) {
  return typeof logFile === "string" ? `\n\n- full log: ${logFile}` : `\n\n- full log: ${logFile?.error || "unavailable"}`;
}

/** `git status --porcelain` output (or null when git/unavailable). */
async function gitStatusSnapshot(repoPath) {
  try {
    // Same hardening as every other git spawn: the -c overrides beat the repo's
    // own config (fsmonitor / hooksPath / editor / credential helpers ...) and
    // the empty HOME + GIT_CONFIG_NOSYSTEM cut the user's global config, so
    // fix-mode verification cannot be the one git call that still executes
    // repo-controlled programs. buildClaudeEnv() (inside gitSpawnOpts) also
    // keeps the macOS-launchd sparse-PATH fix — without it `git` itself was not
    // found and verification silently reported "nothing changed".
    const { stdout } = await execFileAsync("git", [...GIT_HARDENING_ARGS, "status", "--porcelain"], gitSpawnOpts(repoPath));
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

/** The reviewer-fleet view shared by every result shape (success/error/interrupted). */
function subagentsView(agentReports) {
  return (agentReports || []).map((r) => ({
    description: r.description, subagentType: r.subagentType || undefined,
    async: r.async || undefined, status: r.status || undefined,
    partial: r.partial || undefined, recovery: r.recovery || undefined,
    report: (r.report || "").length > 8000 ? `${r.report.slice(0, 8000)}…(truncated)` : (r.report || ""),
  }));
}

/**
 * An interrupted run (client cancel / timeout / no result event) still produced
 * paid work: runClaude always returns the incremental subagent records and the
 * durable JSONL path. err() used to drop both, so cancelling a 12-agent audit
 * made every finished report unreachable through the API.
 */
function interruptedResult(text, run, requestedModel) {
  const reportsSection = subagentReportsText(run.agentReports);
  const provenance = buildModelProvenance({
    requestedModel,
    mainModels: run.mainModels,
    subagentModels: run.subagentModels,
    unrecognized: run.unrecognizedModels,
  });
  const fileNote = typeof run.subagentsFile === "string"
    ? `_partial reports file: ${run.subagentsFile} (one JSONL line per finished subagent)_`
    : "";
  const note = [provenance.note, reportsSection, fileNote].filter(Boolean).join("\n\n");
  return {
    isError: true,
    content: [{ type: "text", text: text + (note ? `\n\n${note}` : "") }],
    structuredContent: {
      status: run.cancelled ? "cancelled" : run.timedOut ? "timed_out" : "no_result",
      subagents: subagentsView(run.agentReports),
      subagentsSpawned: run.agentReports?.length || undefined,
      subagentsFile: run.subagentsFile,
      modelProvenance: {
        requested: provenance.requested, main: provenance.main,
        subagents: provenance.subagents, billed: provenance.billed,
        substituted: provenance.substituted,
      },
    },
  };
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
  // A rate limit / token exhaustion (429) is the one failure that can waste real spend:
  // the subagents that already finished are captured incrementally and are
  // returned with this error, and any agent still in flight is recovered from
  // its output_file transcript — so say so, and say what survived.
  if (/\b429\b|rate.?limit|overloaded|too many requests|insufficient|quota|credit balance/i.test(blob)) {
    hints.push("The API returned a rate limit / quota exhaustion (429) — the account ran out of tokens or hit a limit mid-run. Nothing already paid for is lost: every reviewer subagent that finished is included with this error (see the subagent reports below), and an agent killed mid-flight is recovered from its output_file transcript. Wait for the quota/limit to reset (or switch providers) and re-run; the diff-sized fleet means the re-run repeats only the unfinished work.");
  }
  if (/ECONNREFUSED|connection refused|fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|api_error/i.test(blob)) {
    const t = gatewayTarget();
    hints.push(`The API endpoint is unreachable${t ? ` (ANTHROPIC_BASE_URL=${gatewayDisplay(t)})` : ""} — if you use CC Switch / claude-code-router / a local gateway, make sure it is running and healthy.`);
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

/**
 * A run that exits "successfully" with no result text is a failed run, not a
 * clean one. That distinction is the product promise: callers filter findings,
 * so "no output" must never read as "no findings". Shared by the review and the
 * followup path (kind="reply"); the banner also names what survived (log file,
 * subagent reports) instead of burying paid-for work.
 */
function emptyReportBanner(j, kind = "review") {
  const isReply = kind === "reply";
  return [
    `⚠️ ${isReply ? "FOLLOWUP" : "REVIEW"} FAILED — the reviewer produced no ${isReply ? "reply" : "report"}.`,
    "",
    `claude's result was empty: no ${isReply ? "answer" : "findings"} and no summary, so there is nothing this run can vouch for. ` +
      `Treat it as a FAILED ${isReply ? "followup" : "review"} (not a clean one) and retry.`,
    ...(j.subtype && j.subtype !== "success" ? [`(subtype: ${j.subtype})`] : []),
    "",
    "Hints:",
    "- Check the full log (below): an empty result usually means a gateway/wrapper returned no text, or this CLI does not advertise --output-format stream-json, so a forked slash command's answer could not be recovered from the event stream.",
    "- Reviewer subagent reports that did arrive are still included below (and in partial_reports_file when present) — only the parent's summary is missing.",
    "- Re-run; claude_review_env shows which CLI/auth setup was resolved if the same wrapper keeps returning nothing.",
  ].join("\n");
}

const server = new McpServer(
  { name: "cc-code-review", version: SERVER_VERSION },
  {
    instructions:
      "Run Claude Code's code-review skill on a repository and get structured findings back. " +
      // The default is async (a real review takes 2-15 min, longer than most clients
      // hold a tool call), so the flow the model follows MUST include the poll step —
      // the previous text described a synchronous call and models never polled.
      "Typical flow: claude_code_review(repoPath, scope) returns a jobId immediately -> " +
      "poll claude_review_status(jobId) until it returns the report -> fix the code -> run claude_code_review again to verify, " +
      "or claude_review_followup(sessionId, message) to ask the reviewer something. " +
      "Pass waitForResult=true only when the client can hold the call for the whole review.",
  }
);

/* ------------------------------------------------------------------ */
/* Shared pre-run hardening gate                                       */
/* ------------------------------------------------------------------ */

/**
 * Credential-safe rendering of an env value for a diagnostic line.
 *
 * The note this feeds is returned to the MCP client and quoted into the report
 * (and into meta.warning, which the model reads) — a full AUTH_TOKEN/API_KEY
 * there is a live credential leak with a very long reach: chat transcript, logs,
 * screenshots. A 6-char prefix still says which key/provider it is, and the
 * length disambiguates two values that share a prefix. Very short values show
 * no prefix at all: half of a short secret is still too much of it.
 */
function maskCredentialValue(v) {
  const s = String(v ?? "");
  // A 6-char prefix of a 12-char secret is exactly half of it — the old
  // boundary leaked half of every short-to-medium credential. Show at most 4
  // characters (the same maximum scripts/init.mjs uses), and hide anything
  // under 16 completely: length alone still disambiguates two similar values.
  return s.length < 16 ? `… (len ${s.length})` : `${s.slice(0, 4)}… (len ${s.length})`;
}

/**
 * URL rendering for the same diagnostic: the origin names the endpoint the run
 * would bill against, while userinfo / path / query / fragment are the parts a
 * URL can carry a credential in — so they are dropped. An unparseable value is
 * treated as a credential, because a malformed URL is often a pasted token.
 */
function redactBaseUrlValue(v) {
  const s = String(v ?? "");
  try {
    const u = new URL(s);
    const hidden = [];
    if (u.username || u.password) hidden.push("userinfo");
    if (u.pathname && u.pathname !== "/") hidden.push("path");
    if (u.search) hidden.push("query");
    if (u.hash) hidden.push("fragment");
    return u.origin + (hidden.length ? ` (${hidden.join("/")} hidden)` : "");
  } catch {
    return maskCredentialValue(s);
  }
}

/** One value → its safe form for its own key (origin for BASE_URL, mask otherwise). */
function redactSettingValue(key, v) {
  return key === "ANTHROPIC_BASE_URL" ? redactBaseUrlValue(v) : maskCredentialValue(v);
}

/**
 * Display form of a resolved gateway target. Every place that reports the
 * configured ANTHROPIC_BASE_URL (env tool, failure hints, gateway-changed
 * warnings) must go through here: those strings are returned to the MCP client
 * and end up in the report, and a URL can carry userinfo/query credentials.
 */
function gatewayDisplay(target) {
  return target ? redactBaseUrlValue(String(target.url)) : "(not configured)";
}

/**
 * Verify the shell guard and resolve the permission-mode flags for one run.
 *
 * Two independent things can silently disarm a review:
 *  1. the PreToolUse guard is off, unwritable, or installed-but-not-firing. It is
 *     the only mechanism that polices every segment of a Bash command and the
 *     only one that scopes writes to the repo, so a run without it is refused
 *     unless the operator sets CLAUDE_REVIEW_ALLOW_UNGUARDED=1;
 *  2. `--permission-mode manual` (>= 2.1.200) and `--permission-prompts none`
 *     (>= 2.1.259) are newer-CLI options — passing either to an older claude
 *     makes it exit with "unknown option", which the caller sees as an opaque
 *     "no parseable result JSON".
 *
 * Returns {ok:false, error} to abort, or the resolved flags plus any note that
 * belongs in the report.
 */
async function prepareRunHardening(cli, { ultracode = false } = {}) {
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
            `It is the only thing that polices every segment of a Bash command and the only thing that keeps writes inside the reviewed repo. ` +
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
          `A guard that does not fire is worse than none, because it looks like protection. ` +
          // The most common cause, and the least obvious one: this process keeps
          // the code it loaded at startup while the hook script is spawned fresh
          // from disk on every call — so an upgrade makes the two disagree.
          `If cc-code-review was just updated, restart the MCP host (or ZCode): the running server still executes the previous version while the hook file on disk is the new one. ` +
          `Otherwise check ${hookScriptPath()} is intact and that node can spawn it, or set ` +
          `CLAUDE_REVIEW_ALLOW_UNGUARDED=1 to run anyway at your own risk (the hook is still installed in that case — enforcement stays on; only this self-check is skipped).`,
      };
    }
    if (!selfTest.ok) {
      notes.push(`⚠ shell guard self-test failed (${selfTest.reason}) — proceeding only because CLAUDE_REVIEW_ALLOW_UNGUARDED=1 is set.`);
      log("guard self-test failed but CLAUDE_REVIEW_ALLOW_UNGUARDED=1 — proceeding:", selfTest.reason);
    }
  }
  // ultracode is claude's standing dynamic-workflow orchestration setting (the
  // `ultracode` settings key). It rides the same --settings file as the guard
  // hooks; older CLIs strip the unknown key, so requesting it there degrades to
  // a normal run — workflowRuns in the result shows whether it took effect.
  const guardSettings = writeGuardSettings(ultracode ? { ultracode: true } : {});
  // writeGuardSettings() returns null both when the guard is deliberately off and
  // when the file could not be written. Reaching here means guardState() said "on",
  // so a null is a write failure (full disk, unwritable temp dir, a cleaner racing
  // the directory) — and running on would silently drop the ONLY per-segment
  // enforcement while the result still advertises "PreToolUse hook". Refuse instead.
  if (guard.state === "on" && !guardSettings) {
    cleanupGuardSettings();
    return {
      ok: false,
      error:
        "Refusing to run unguarded: the PreToolUse hook settings file could not be written (the guard is installed, but this run could not pass it to claude). " +
        "Check that " + path.join(os.tmpdir(), "cc-code-review") + " is writable and has free space, then retry. " +
        "Set CLAUDE_REVIEW_ALLOW_UNGUARDED=1 only if you accept a run with no per-command guard.",
    };
  }
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

  // Pre-run model-substitution warning. `--setting-sources user` is what keeps
  // the reviewed repo from hijacking the run, but it also loads the user's own
  // settings.json env block — and a provider switcher (CC Switch & friends)
  // rewrites the model names THERE: CLAUDE_CODE_SUBAGENT_MODEL pins every
  // reviewer subagent, ANTHROPIC_DEFAULT_*_MODEL_NAME remaps the main model
  // families. The run then bills under the substituted model and the report is
  // no longer comparable to a direct Claude Code session. Say so up front —
  // the post-run provenance note (buildModelProvenance) is the confirmation.
  {
    const s = peekSettingsEnv();
    const remaps = Object.entries(s || {}).filter(([k]) =>
      k === "CLAUDE_CODE_SUBAGENT_MODEL" || /^ANTHROPIC_DEFAULT_[A-Z]+_MODEL(_NAME)?$/.test(k));
    if (remaps.length) {
      notes.push(
        `⚠ ~/.claude/settings.json env remaps the review's models: ` +
        remaps.map(([k, v]) => `${k}=${v}`).join(", ") +
        `. The reviewer subagents (and possibly the main session) will run on that model instead of the requested Claude model — ` +
        `switch the provider back or unset those keys for a Claude-native review.`
      );
    }
    // claude applies the settings.json env block over the process environment,
    // so a caller-side ANTHROPIC_BASE_URL (or *_API_KEY) can be silently
    // overridden — the run then bills against whichever gateway the settings
    // file names, not the one the caller configured.
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      const fromProcess = process.env[key];
      const fromSettings = s?.[key];
      if (fromProcess && fromSettings && fromProcess !== fromSettings) {
        // Report the KEY and the fact of the mismatch only: this note is returned
        // to the MCP client and quoted into the report, so printing either value
        // verbatim handed the caller a live credential (and logged it).
        notes.push(
          `⚠ ${key} differs between this server's environment (${redactSettingValue(key, fromProcess)}) and ` +
          `~/.claude/settings.json (${redactSettingValue(key, fromSettings)}) — claude applies the settings value, so the run uses ` +
          `the settings ${key === "ANTHROPIC_BASE_URL" ? "endpoint" : "credential"}, not the one in this server's environment. ` +
          `Align the two (or unset one) if that is not what you configured. (Values are masked here: this note travels to the MCP client and must never carry a credential.)`
        );
      }
    }
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
  { installSkill: z.boolean().default(false), uninstallSkill: z.boolean().default(false) },
  async ({ installSkill, uninstallSkill }) => {
    const drift = codeDrift();
    const lines = [`cc-code-review server: v${SERVER_VERSION}${drift.stale ? " — ⚠ STALE PROCESS" : ""}`];
    if (drift.stale) {
      lines.push(
        `  ⚠ the source on disk is newer than this process (${path.basename(String(drift.file))} changed ${drift.newestSourceAt}; ` +
        `this process started ${drift.startedAt}) — it is still running the previous version. Restart the MCP host (or ZCode) to apply it. ` +
        `The guard hook is spawned from disk on every call, so until then the server and the hook disagree (the guard self-test refuses to run).`,
      );
    }
    lines.push("claude cli:");
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
        // This is the diagnostic a user consults after replacing node / the
        // hook script, so it must not trust a cached verdict: the 5-minute TTL
        // cache is for the hot path (prepareRunHardening), and refresh:true
        // forces a fresh probe here — the contract 1.9.2's CHANGELOG promised.
        const self = await guardSelfTest({ refresh: true });
        lines.push(`  shell guard (PreToolUse hook: read-only Bash policy, in-repo paths): installed — ${self.ok ? "verified working (denies an unsafe command, allows a clean one)" : `NOT WORKING — ${self.reason}`}`);
      } else {
        lines.push(`  shell guard (PreToolUse hook: read-only Bash policy, in-repo paths): ${guard.state === "off" ? "OFF" : "FAILED"} — ${guard.reason}`);
      }
      // guardState()/guardSelfTest() wrote a guard settings file just to probe;
      // nothing else will remove it in this code path, so clean up now.
      cleanupGuardSettings();
      cliState = "OK";
    }

    lines.push(describePipelineAvailability());
    lines.push("code-review skill: " + describeSkill(skillSync()));

    const t = gatewayTarget();
    if (t) {
      const gw = await probeGateway();
      lines.push(`gateway (ANTHROPIC_BASE_URL): ${gatewayDisplay(t)}` + (gw.skipped ? " (probe skipped)" : gw.ok ? " — reachable ✓" : ` — NOT reachable (${gw.reason}) ✗`));
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
      // gatewayTarget() is settings-aware and already ignored an unparseable
      // URL, but process.env is the RAW host value: comparing it with new URL()
      // unguarded made a malformed host ANTHROPIC_BASE_URL throw a TypeError out
      // of the whole env diagnostic when settings.json held a valid gateway
      // (audit P1-7). Treat it as "not the gateway" and say so.
      let hostBaseUrl = null;
      let hostBaseUnparseable = false;
      if (process.env.ANTHROPIC_BASE_URL) {
        try { hostBaseUrl = new URL(process.env.ANTHROPIC_BASE_URL).href; }
        catch { hostBaseUnparseable = true; }
      }
      const baseIsGateway = !!(t && hostBaseUrl && t.url.href === hostBaseUrl);
      const realResidue = baseIsGateway ? residue.filter((k) => k !== "ANTHROPIC_BASE_URL") : residue;
      if (hostBaseUnparseable) {
        lines.push(
          `⚠ ANTHROPIC_BASE_URL in this server's environment is not a parseable URL, so it was ignored for the gateway check ` +
          `(the value from ~/.claude/settings.json, if any, still applies). Fix or unset it in the host environment.`
        );
      }
      if (baseIsGateway) {
        lines.push(`note: the gateway is configured via the host environment (ANTHROPIC_BASE_URL=${gatewayDisplay(t)}), not ~/.claude/settings.json — this works as-is.`);
      }
      if (realResidue.length) {
        if (t) {
          // settings.json env beats process env inside claude, so an unmanaged
          // var can never override a key settings.json also sets — it only
          // matters for keys settings does NOT manage (like the note above).
          lines.push(`⚠ auth env residue: ${realResidue.join(", ")} set in the host environment but not managed by ~/.claude/settings.json — for keys settings.json also sets, settings wins; these unmanaged ones are used as-is alongside the configured gateway (${gatewayDisplay(t)}).`);
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
    if (uninstallSkill) {
      const r = uninstallBundledSkill();
      lines.push(r.uninstalled
        ? `uninstallSkill: removed ${r.dir} — claude's built-in /code-review command is no longer shadowed`
        : `uninstallSkill: skipped — ${r.reason}`);
    }
    lines.unshift(`verdict: ${cliState}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        verdict: cliState,
        server: { version: SERVER_VERSION, stale: !!drift.stale, newestSourceAt: drift.newestSourceAt ?? null },
        cli: cli && !cli.error ? { path: cli.path, source: cli.source } : null,
      },
    };
  }
);

function describeSkill(sync) {
  const { status } = sync;
  if (status === "missing") return "missing (will be auto-installed on the first claude_code_review call; or call this tool with installSkill=true)";
  if (status === "bundled") {
    if (sync.upToDate) return `installed (bundled, managed by this MCP) at ${userSkillDir()} — up to date`;
    return `installed (bundled, managed by this MCP) at ${userSkillDir()} — ⚠ OUTDATED: ` +
      `${sync.installedBytes ?? "?"} bytes on disk vs ${sync.bundledBytes ?? "?"} in this build. ` +
      "It is refreshed automatically before the next review, or call this tool with installSkill=true now — " +
      "a stale copy keeps running the old pipeline (e.g. a fixed five reviewers after the fleet became diff-sized).";
  }
  return `user-managed skill present at ${userSkillDir()} — it will be used as-is (never refreshed by this MCP)`;
}

/** The line that explains the native/skill interaction in claude_review_env. */
function describePipelineAvailability() {
  const shadow = skillStatus() !== "missing";
  if (!shadow) {
    return "review pipeline: native — claude's built-in /code-review command is used for levels low..xhigh; the fleet pipeline (carried in the prompt, nothing installed) is used for max and fix mode";
  }
  return `review pipeline: fleet — a skill named \`code-review\` at ${userSkillDir()} shadows claude's built-in /code-review command, so the native pipeline is unavailable ` +
    "(remove it with uninstallSkill=true if this MCP installed it)";
}

/* ------------------------------------------------------------------ */
/* Tool 2: claude_code_review                                         */
/* ------------------------------------------------------------------ */

server.tool(
  "claude_code_review",
  "Run Claude Code's code-review skill (a diff-sized fleet of parallel reviewer subagents, 0-100 confidence scoring, keeps findings >=75). " +
  "Every finished reviewer subagent's report is captured the moment it lands — appended to a durable JSONL file and visible via claude_review_status while the run continues — and an agent killed mid-flight (e.g. a 429) is recovered from its output_file transcript, so a rate limit never wastes the work already paid for. " +
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
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("max")
      .describe("Review effort / reasoning level, same scale as Claude Code (--effort): low..max. Default max = exhaustive deep review (slower and pricier). Omit for the deepest default; pass low/medium for a fast, cheap pass."),
    reviewLevel: z.enum(["low", "medium", "high", "max"]).optional()
      .describe("The REVIEW's own depth level — the same argument claude's native /code-review command takes. The fleet structure mirrors the native playbooks verbatim: low = one pass, no subagents (<=4 findings); medium/high = 8 finder subagents (3+5 angles x 6 candidates); max = 10 finder subagents (5+5 angles x 8 candidates) + one verifier per surviving candidate + 1 sweep finder, findings capped at 15 — so max exceeds 15 subagents structurally. Defaults to a mapping of effort (max/xhigh->max, high->high, medium->medium, low->low). Separate knob from the CLI reasoning effort and from ultracode."),
    ultracode: z.boolean().default(false)
      .describe("Enable claude's Ultracode mode for this run (the `ultracode` settings key): standing dynamic-workflow orchestration — every substantive step goes through the native Workflow tool, multi-agent and token-cost-no-object. Orthogonal to effort (any effort level). Requires a claude CLI that supports the key; older builds ignore it (see workflowRuns in the result)."),
    model: z.string().optional().describe("Claude model override (passed as --model)"),
    maxTurns: z.number().int().min(4).max(200).default(80).describe("Agentic turn cap for the review session"),
    timeoutMinutes: z.number().int().min(1).max(60).default(ENV.timeoutMinutes).describe("Hard wall-clock timeout for the run — with no spend cap by default this is the guard; every finished subagent report is kept even when it fires"),
    maxBudgetUsd: z.number().min(0).max(50).optional()
      .describe(`API spend cap via --max-budget-usd. DEFAULT 0 = NO CAP at any effort level: a cap stops the parent before it synthesizes, and every finished subagent report is already captured incrementally (and recovered from output_file), so a 429/token exhaustion no longer wastes it. The wall-clock timeout (timeoutMinutes) is the guard. Set a number only if you want a hard spend stop; env CLAUDE_REVIEW_MAX_BUDGET_USD sets the DEFAULT for this argument (an explicit value here always wins). On third-party gateways this depends on usage data the gateway returns.`),
    pipeline: z.enum(["auto", "native", "fleet", "skill"]).default("auto")
      .describe(
        "Which review engine runs. auto (default): claude's built-in /code-review command for levels low..xhigh — it needs no file on disk; fix runs ride its own --fix flag. " +
        "Only max uses the MCP's own fleet pipeline, because the built-in hands max to subagents whose exploration commands the locked-down permission mode denies. " +
        "native: force the built-in command (refused when a same-named skill in the Claude config dir shadows it). fleet: force the fleet pipeline (its instructions travel in the prompt; nothing is installed). " +
        "skill: legacy — use/optionally install the bundled skill (the only mode that may write to disk).",
      ),
    installSkillIfMissing: z.boolean().default(ENV.autoInstallSkill)
      .describe("Only meaningful with pipeline=skill: when the bundled skill is MISSING, install it into the Claude config dir (default false — a missing skill degrades to the inline fleet pipeline instead; a MANAGED existing copy is refreshed whenever it is about to be used; a user-managed copy is never touched). env CLAUDE_REVIEW_AUTO_INSTALL_SKILL=1 sets the default"),
    waitForResult: z.boolean().default(false)
      .describe("Block until the review finishes and return the report synchronously (2-15 min). Default false: returns a jobId at once — poll claude_review_status(jobId). Only set true if your MCP client has no ~30s tool-call timeout."),
  },
  async (args, extra) => {
    const {
      scope, baseRef, focus, postToPR, fix, effort, ultracode, reviewLevel,
      model, maxTurns, timeoutMinutes, installSkillIfMissing, pipeline: pipelineArg,
    } = args;
    const maxBudgetUsd = args.maxBudgetUsd ?? ENV.maxBudgetUsd;

    const prCheck = validatePr(args.pr);
    if (!prCheck.ok) return err(prCheck.error);
    // scope=pr without a pr used to reach the reviewer as the literal
    // "pull request undefined" (fleet prompt) or as a native command with no
    // target (which silently reviews claude's inferred default). Both paths
    // review something other than what the caller asked for, and the report
    // looks normal — so fail closed before anything paid starts (audit P0-6).
    if (scope === "pr" && !prCheck.pr) {
      return err(
        `scope=pr requires a pr — pass the PR number ("123"), "owner/repo#123", or a GitHub PR URL. ` +
        `Without it the fleet prompt would name "pull request undefined" and the native /code-review command would silently ` +
        `fall back to claude's inferred default target, so the review would cover a different diff than the one you asked for.`
      );
    }
    const langCheck = validateLanguage(args.outputLanguage);
    if (!langCheck.ok) return err(langCheck.error);
    const baseRefCheck = validateBaseRef(baseRef);
    if (!baseRefCheck.ok) return err(baseRefCheck.error);
    const focusCheck = validateFocus(focus);
    if (!focusCheck.ok) return err(focusCheck.error);
    const modelCheck = validateModel(model);
    if (!modelCheck.ok) return err(modelCheck.error);
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
    const hard = await prepareRunHardening(cli, { ultracode });
    if (!hard.ok) return err(hard.error);
    const { guard, guardSettings, permissionMode, permissionPrompts, hardening } = hard;
    const guardSetupNote = hard.note;
    // Any refusal between here and runClaude must release the guard file:
    // prepareRunHardening marked it in-flight and only runClaude (or this
    // helper) clears the mark — a leaked mark keeps the file undeletable
    // until the 2h sweep (cleanupGuardSettings skips in-flight entries).
    const preflightFail = (msg) => {
      markGuardSettingsInFlight(guardSettings, false);
      removeGuardSettings(guardSettings);
      return err(msg);
    };
    // (prepareRunHardening already marked guardSettings in-flight for BOTH
    // agentic tools — one marking site, no second call needed here.)

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return preflightFail(`repoPath does not exist or is not a directory: ${repoPath}`);
    }
    // Every documented scope (auto/pr/branch/working-dir/last-commit) is
    // git-based, so a non-repo directory can only produce a doomed paid run.
    if (!isRepo(repoPath)) {
      return preflightFail(
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
      return preflightFail(
        `git failed in ${repoPath} (${detail}). Every review scope reads git history, so the review cannot run. ` +
        `If the repo lives on a network drive or in a sandbox, check that git can access it (ownership/safe.directory, permissions).`
      );
    } else if (!pre.hasCommits) {
      if (pre.dirty) {
        repoWarning += `⚠ note: the repository has no commits yet, so history-based scopes (branch/pr/last-commit) have nothing to diff — the reviewer can only look at uncommitted files.\n\n`;
      } else {
        return preflightFail(`Nothing to review: ${repoPath} has no commits and no uncommitted changes. Make a commit (or leave changes in the working tree) first.`);
      }
    }

    // Fail fast when a loopback gateway (CC Switch & friends) is down: claude
    // would otherwise retry silently for minutes and surface as a timeout.
    const gw = await probeGateway();
    const gwBefore = gatewayTarget(); // for the mid-run "gateway disappeared" check
    if (gw && gw.ok === false) {
      return preflightFail(`Local gateway not reachable: ${gw.host} (${gw.reason}). If you use CC Switch / claude-code-router / a local proxy, start it first, then retry.`);
    }

    // The review's own depth level (third knob): defaults to a mapping of the
    // CLI effort; it sizes the reviewer fleet from the diff.
    const effectiveReviewLevel = reviewLevel || deriveReviewLevel(effort);

    // --- which pipeline runs -------------------------------------------------
    // claude ships its own /code-review command, so a review never has to write
    // anything into ~/.claude. Measured on 2.1.311: the built-in is
    // single-context at low..xhigh — including fix runs, which ride its own
    // `--fix` flag — and switches to subagents at max, whose compound
    // exploration commands the CLI's manual permission mode denies outright, so
    // max uses the fleet pipeline (whose instructions travel in the prompt).
    // Both paths install nothing.
    let pipeline = pipelineArg || "auto";
    let pipelineNote = "";
    // A skill named `code-review` in ~/.claude/skills SHADOWS claude's built-in
    // command of the same name (verified: the run opens with a Skill tool call
    // instead of the built-in pipeline). An earlier version of this MCP
    // installed exactly that, so the native path must check — promising "native"
    // while a local skill answers is the silent-substitution bug this project
    // exists to prevent.
    const shadow = skillStatus() !== "missing";
    if (pipeline === "auto") {
      if (effectiveReviewLevel === "max") {
        pipeline = "fleet";
        pipelineNote = "auto chose the fleet pipeline: at max the native /code-review command hands off to subagents whose exploration commands the locked-down permission mode denies";
      }
      else if (scope === "last-commit" && pre.hasParent === false) {
        pipeline = "fleet";
        pipelineNote = "auto chose the fleet pipeline: HEAD has no parent commit (or no commits at all), and the native command targets a BASE ref (`HEAD~1` does not exist here)";
      }
      else if (shadow) {
        pipeline = "fleet";
        pipelineNote = "auto chose the fleet pipeline: a code-review skill exists at ~/.claude/skills and would shadow claude's built-in /code-review command (remove it — claude_review_env with uninstallSkill=true — to use the native pipeline)";
      } else pipeline = "native";
      // fix rides the built-in command's own --fix flag (verified in the
      // binary: the usage line is `[levels] [--fix] [--comment] [<target>]`),
      // so it no longer forces the fleet at low..xhigh.
      if (fix && pipeline === "native") {
        pipelineNote = (pipelineNote ? pipelineNote + " " : "") + "fix mode rides the native command's --fix flag";
      }
    }
    if (pipeline === "native" && shadow) {
      // preflightFail, not err: prepareRunHardening already marked this run's
      // guard settings in-flight, and only runClaude (or this helper) releases
      // it. A plain err() leaked the settings file AND its in-flight mark until
      // process exit, while the file still advertised "PreToolUse protection"
      // for a run that never happened (audit P1-10).
      return preflightFail(
        `pipeline=native cannot be honoured: a skill named \`code-review\` exists at ${userSkillDir()} and shadows claude's built-in /code-review command, so the run would execute that skill instead. ` +
        `Remove it (claude_review_env with uninstallSkill=true, when this MCP installed it) or choose pipeline=fleet.`,
      );
    }
    // pipeline=skill is the one mode that may install: it is explicitly chosen.
    // (installSkillIfMissing only gates the missing case; a managed copy is
    // refreshed because it is about to be used.)

    // --- skill handling (only for pipeline=skill) ----------------------------
    // Nothing is installed for native or fleet: the native command is built in,
    // and the fleet pipeline travels in the prompt. A legacy skill copy is
    // refreshed only when it is actually about to be used.
    let skillMode = "";
    let skillRefreshNote = "";
    let useSkill = false;
    if (pipeline === "skill") {
      const status = skillStatus();
      if (status === "user") {
        skillMode = "code-review skill (user-managed)";
        useSkill = true;
      } else if (status === "bundled") {
        skillMode = "code-review skill (bundled)";
        useSkill = true;
        const before = skillSync();
        if (!before.upToDate) {
          const r = installBundledSkill();
          if (r.installed && r.changed) {
            skillRefreshNote =
              `the installed code-review skill was out of date (${before.installedBytes ?? "?"} bytes vs ${before.bundledBytes ?? "?"} in this build) and has been refreshed for this run`;
          }
        }
      } else {
        // Audit: installSkillIfMissing gates the MISSING case — with it false
        // (the default) and the skill absent, the fleet pipeline runs instead of
        // writing ~/.claude. A managed copy is refreshed because it is about to
        // be used; a user-managed copy is never touched.
        if (!installSkillIfMissing) {
          pipeline = "fleet";
          pipelineNote = (pipelineNote ? pipelineNote + " " : "") + "pipeline=skill requested but installSkillIfMissing=false and no skill is installed — running the inline fleet pipeline instead (nothing was installed)";
          skillMode = "fleet pipeline (inline, nothing installed)";
        } else {
          const r = installBundledSkill();
          skillMode = r.installed ? "code-review skill (bundled, installed for this run)" : `fleet pipeline (skill install failed: ${r.reason})`;
          useSkill = r.installed;
          if (!useSkill) pipeline = "fleet";
        }
      }
    }
    if (pipeline === "fleet" && useSkill === false) {
      skillMode = skillMode || "fleet pipeline (inline, nothing installed)";
    }

    // Only inject thinking keywords when the CLI lacks --effort (never both).
    const [effortFlagSupported, budgetFlagSupported, streamJsonSupported] = await Promise.all([
      supportsFlag(cli, "--effort"), supportsFlag(cli, "--max-budget-usd"),
      supportsStreamJson(cli),
    ]);

    // --- shell guard + permission-mode version floors (H4, D1) ---------------
    // (already resolved above, before the repo checks)

    let prompt;
    let appendSystemPrompt;
    if (pipeline === "native") {
      prompt = buildNativeCommand({ reviewLevel: effectiveReviewLevel, target: nativeTarget({ scope, pr, baseRef: baseRefCheck.ref }), fix });
      appendSystemPrompt = buildNativeAppendix({ outputLanguage, focus: focusCheck.focus, postToPR, cwd: repoPath, fix });
      skillMode = "native /code-review (built into claude; nothing installed)";
    } else {
      prompt = buildReviewPrompt({
        scope, pr, baseRef: baseRefCheck.ref, focus: focusCheck.focus, outputLanguage, postToPR, fix,
        effort, reviewLevel: effectiveReviewLevel, useEffortFlag: effortFlagSupported, cwd: repoPath,
        useSkill,
      });
    }

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
        return preflightFail(
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
      return preflightFail(
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
    // Filled in async mode only; the incremental onSubagentReport callback
    // feeds it so a polling client sees the fleet complete live.
    let liveJob = null;
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
    // logsDir() is a synchronous fs call: a bad CLAUDE_REVIEW_LOG_DIR used to
    // throw straight out of the tool handler on the waitForResult path instead
    // of producing a readable error (audit P2-12). Fail before the paid run.
    let subagentsDir;
    try { subagentsDir = logsDir(); }
    catch (e) {
      return preflightFail(
        `Could not prepare this review's log directory: ${e?.message || e}. ` +
        `Set CLAUDE_REVIEW_LOG_DIR to a writable directory (or fix its permissions) and retry — the review was not started.`
      );
    }

    const run = await runClaude({
      cli,
      repoPath,
      prompt,
      promptViaArgv: pipeline === "native",
      appendSystemPrompt,
      allowedTools,
      disallowedTools,
      model: modelCheck.model || ENV.model,
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
      subagentsDir,
      timeoutMs: timeoutMinutes * 60_000,
      signal,
      // One subagent finished -> one record, right now: appended to the job so a
      // polling client sees the fleet fill up (and keeps it after a 429/halt),
      // and appended to the run's JSONL file by runClaude itself.
      onSubagentReport: (rec, file) => {
        if (!liveJob) return;
        liveJob.subagents = [...(liveJob.subagents ?? []), rec];
        if (typeof file === "string") liveJob.subagentsFile = file;
      },
    });
    if (progressTimer) clearInterval(progressTimer);

    const logFile = writeLogFile(run.stdout, run.stderr, [run.subagentsFile]);
    const j = run.json;
    const logNote = logNoteOf(logFile);

    if (run.cancelled) {
      return interruptedResult(`review cancelled by the client after ${Math.round(run.durationMs / 1000)}s${logNote}${stderrTail(run.stderr)}`, run, modelCheck.model || ENV.model || null);
    }
    if (run.timedOut) {
      return interruptedResult(
        `review timed out after ${timeoutMinutes} minutes. Retry with a larger timeoutMinutes, a narrower scope, or higher maxTurns.` +
        ` If you use CC Switch / a local gateway, also check it is still healthy (claude retries a dead endpoint silently).${logNote}${stderrTail(run.stderr)}`,
        run, modelCheck.model || ENV.model || null
      );
    }
    if (!j) {
      return interruptedResult(
        `claude exited (code ${run.exitCode}) without a parseable result JSON. ` +
        `Check 'claude' works in a terminal from that repo (login, gateway, proxy).${logNote}${stderrTail(run.stderr)}`,
        run, modelCheck.model || ENV.model || null
      );
    }

    const looksLikeApiError = /^API Error/i.test(String(j.result || ""));
    const reportText = String(j.result ?? "");
    // An empty result is not "no findings": it means the reviewer produced
    // nothing (a gateway/wrapper that returned no text, a CLI without
    // stream-json whose forked-command answer cannot be recovered from the event
    // stream, or a turn cap hit before writing). Returning that as success is
    // how a caller concludes "clean review" from a run that never reviewed anything.
    const emptyReport = reportText.trim().length === 0;
    const ok = j.subtype === "success" && j.is_error !== true && !looksLikeApiError && !emptyReport;
    // A non-success subtype is the more specific diagnosis (budget/turn cap);
    // "empty_report" is used only when claude itself claimed success.
    const status2 = ok ? "success"
      : (j.subtype && j.subtype !== "success" ? j.subtype : (emptyReport ? "empty_report" : "claude reported an error"));

    // Under `--permission-mode manual` a missing allowlist entry shows up here
    // instead of aborting the run — surface it, or a silently degraded review
    // (e.g. the reviewer subagents never ran) would look like a clean result.
    // The classifier is shared with claude_review_followup so both paths split
    // "the guard blocked it" from "the allowlist is missing something" the same
    // way (audit P0-7).
    const { deniedCommands, guardBlocked, realDenials, denialNote, guardNote } = classifyDenials(j, repoPath);

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
    const chainNote = shellChainingNote(run.bashCommands, deniedCommands, { repoRoot: repoPath }) || "";

    // Model provenance: the report is only comparable to a direct Claude Code
    // session if it actually ran on the requested Claude model. A gateway
    // (CC Switch & friends) or ~/.claude/settings.json env
    // (CLAUDE_CODE_SUBAGENT_MODEL / ANTHROPIC_DEFAULT_*_MODEL_NAME) rewrites
    // the model per request — the CLI itself logs
    // [claude-code:unrecognized_model] on stderr when it does. Without this
    // note the caller diffs two reports produced by two different models.
    const requestedModel = modelCheck.model || ENV.model || null;
    const facts = resultFacts(j);
    const provenance = buildModelProvenance({
      requestedModel,
      mainModels: run.mainModels,
      subagentModels: run.subagentModels,
      unrecognized: run.unrecognizedModels,
      billedModels: Object.keys(facts.modelUsage || {}),
    });
    const provenanceNote = provenance.note;

    // CC Switch rewrites ~/.claude/settings.json when the user switches provider.
    // If the gateway this run was configured with vanished OR CHANGED mid-run,
    // the report's provenance is unclear — say so instead of presenting it as
    // authoritative. A provider switch rewrites the URL rather than unsetting
    // it, so comparing identity alone misses the common case.
    const gwAfter = gatewayTarget();
    const gwChanged = gwBefore && gwAfter && gwBefore.url.href !== gwAfter.url.href;
    const gwNote = (gwBefore && !gwAfter)
      ? `⚠ the gateway configuration disappeared during the run (ANTHROPIC_BASE_URL was ${gatewayDisplay(gwBefore)} when the run started and is not set any more) — CC Switch may have switched providers mid-review.`
      : (gwChanged
        ? `⚠ the gateway endpoint changed during the run (${gatewayDisplay(gwBefore)} → ${gatewayDisplay(gwAfter)}) — CC Switch likely switched providers mid-review, so the report may mix two models.`
        : "");

    // An explicit spend cap the installed CLI cannot honour is silently dropped
    // otherwise: the user would believe spend is capped when it is not.
    const budgetUnsupportedNote = typeof maxBudgetUsd === "number" && maxBudgetUsd > 0 && !budgetFlagSupported
      ? `⚠ maxBudgetUsd=${maxBudgetUsd} was requested but this claude CLI does not advertise --max-budget-usd, so NO spend cap is enforced for this run. Upgrade claude or rely on timeoutMinutes/maxTurns.`
      : "";
    const warnings = [guardSetupNote, repoWarning.trim(), gitProgramNotes.trim(), denialNote, guardNote, chainNote, fixNote, gwNote, provenanceNote, budgetUnsupportedNote, skillRefreshNote, pipelineNote].filter(Boolean).join("\n\n");

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
      subagentStats: facts.subagentStats,
      effectiveModel: provenance.main.length ? provenance.main.join(", ") : undefined,
      modelsBilled: provenance.billed.length ? provenance.billed.join(", ") : undefined,
      ultracode: ultracode || undefined,
      reviewLevel: effectiveReviewLevel,
      workflowRuns: run.workflowDispatches?.length || undefined,
      subagentsFile: run.subagentsFile,
      permissionDenials: realDenials.length,
      shellGuardBlocked: guardBlocked.length,
      bashCalls: Array.isArray(run.bashCommands) ? run.bashCommands.length : undefined,
      shellGuard: guard.state === "on"
        ? "PreToolUse hook (blocks chained/substituted Bash commands)"
        : `OFF — ${guard.reason}`,
    };
    log(`review done: ${meta.status} cost=${meta.costUsd} turns=${meta.numTurns} subagents=${meta.subagentsSpawned} denials=${meta.permissionDenials} guardBlocked=${meta.shellGuardBlocked} bashCalls=${meta.bashCalls} guard=${guard.state} model=${meta.effectiveModel || "?"}${provenance.substituted ? " SUBSTITUTED" : ""}`);

    if (!ok) {
      // A failed run still produced work worth returning: a budget cap stops
      // the parent AFTER the subagents finished, and the reports that did
      // arrive must not be thrown away with the error banner.
      const errReports = subagentReportsText(run.agentReports);
      // Same metadata block as a successful run (status/level/ultracode/
      // workflow_runs/cost/...), so a caller that only reads the text of a
      // failed review still sees the knobs this run used.
      const errMeta = ["_run metadata_", ...runMetaLines(meta)].join("\n");
      const errNote = [provenanceNote, errReports, errMeta].filter(Boolean).join("\n\n");
      // An empty result has its own causes and next steps; the generic
      // "did not complete" banner would print "(no message)" and bury them.
      const errBanner = status2 === "empty_report" ? emptyReportBanner(j) : failureBanner(j, run);
      return {
        isError: true,
        content: [{ type: "text", text: gitProgramNotes + errBanner + stderrTail(run.stderr) + logNote + (errNote ? `\n\n${errNote}` : "") }],
        structuredContent: {
          status: status2, sessionId: j.session_id, costUsd: meta.costUsd,
          numTurns: j.num_turns, durationMs: meta.durationMs, pipeline: skillMode, pipelineMode: pipeline, effort, fix, logFile,
          hardening,
          error: status2 === "empty_report"
            ? "empty report: claude's result was empty, so the reviewer produced no report (this is a failed review, not a clean one)"
            : String(j.result || ""),
          subagents: subagentsView(run.agentReports),
          subagentsSpawned: meta.subagentsSpawned,
          ultracode: ultracode || undefined,
          reviewLevel: effectiveReviewLevel,
          workflowRuns: run.workflowDispatches?.length || undefined,
          modelProvenance: {
            requested: provenance.requested, main: provenance.main,
            subagents: provenance.subagents, billed: provenance.billed,
            substituted: provenance.substituted,
          },
          subagentsFile: run.subagentsFile,
        modelUsage: facts.modelUsage,
          subagentStats: facts.subagentStats,
          usage: facts.usage,
          safetyStops: facts.safetyStops,
          terminalReason: facts.terminalReason,
          permissionDenials: meta.permissionDenials,
        },
      };
    }

    const reportsSection = subagentReportsText(run.agentReports);
    return {
      content: [{ type: "text", text: (warnings ? warnings + "\n\n" : "") + runResultText(j.result, meta) + (reportsSection ? `\n\n${reportsSection}` : "") }],
      structuredContent: {
        status: "success", sessionId: j.session_id, costUsd: meta.costUsd,
        numTurns: j.num_turns, durationMs: meta.durationMs, pipeline: skillMode, pipelineMode: pipeline, effort, fix, logFile,
        hardening,
        report: j.result,
        subagents: subagentsView(run.agentReports),
        subagentsSpawned: meta.subagentsSpawned,
          ultracode: ultracode || undefined,
          reviewLevel: effectiveReviewLevel,
          workflowRuns: run.workflowDispatches?.length || undefined,
        modelProvenance: {
          requested: provenance.requested,
          main: provenance.main,
          subagents: provenance.subagents,
          billed: provenance.billed,
          substituted: provenance.substituted,
        },
        subagentsFile: run.subagentsFile,
        modelUsage: facts.modelUsage,
        subagentStats: facts.subagentStats,
        usage: facts.usage,
        safetyStops: facts.safetyStops,
        terminalReason: facts.terminalReason,
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
      startedAt, state: "running", result: null, abort: jobAbort, subagents: [],
    };
    liveJob = job;
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
      .then((result) => settleReviewJob(job, result))
      .catch((e) => settleReviewJob(job, err(`review job crashed: ${e?.message || e}`)))
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
      // Reviewer subagents that already finished: the native skill does not
      // report until the whole fleet is done, but a 429 / halt / cancel can
      // stop it before then — so the finished work is visible (and durable)
      // while the run continues.
      const sofar = (job.subagents ?? []).map((r) => ({
        description: r.description, subagentType: r.subagentType || undefined,
        status: r.status, async: r.async || undefined, partial: r.partial || undefined,
        report: r.report,
      }));
      const lines = [
        `still running: ${secs}s elapsed (${job.scope}, ${job.repoPath}). Reviews typically take 2-15 minutes — poll again in a minute or two. Cancel with {"jobId": "${jobId}", "cancel": true}.`,
      ];
      if (sofar.length) {
        lines.push(`${sofar.length} reviewer subagent report(s) already finished (the run continues):`);
        for (const r of sofar) {
          lines.push(`- ${r.description || r.subagentType || "subagent"}${r.status ? ` [${r.status}${r.partial ? ", partial (recovered from output_file)" : ""}]` : ""}: ${(r.report || "").replace(/\s+/g, " ").slice(0, 300)}`);
        }
      }
      if (typeof job.subagentsFile === "string") {
        lines.push(`partial reports file (one JSONL line per finished subagent, written as each lands): ${job.subagentsFile}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { jobId, status: "running", elapsedSec: secs, subagentsSoFar: sofar, subagentsFile: job.subagentsFile },
      };
    }
    if (cancel) return { content: [{ type: "text", text: `job ${jobId} already finished — nothing to cancel.` }] };
    // Stamp the jobId onto the settled result (audit P-03): the final shape used
    // to lose it, so a multi-job client could not tell which job it was reading.
    return withJobId(job.result, jobId);
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
    timeoutMinutes: z.number().int().min(1).max(60).default(Math.min(10, ENV.timeoutMinutes))
      .describe("Hard wall-clock timeout for this followup turn, in minutes (default 10 — a followup is a Q&A turn, not a full review)."),
    maxBudgetUsd: z.number().min(0).max(50).optional()
      .describe("API spend cap via --max-budget-usd. Default 0 = NO CAP (same policy as claude_code_review); the timeoutMinutes guard applies. A followup has no subagent fleet, so its typical spend is small."),
    waitForResult: z.boolean().default(false)
      .describe("Block synchronously for the reply. Default false: returns a jobId at once (poll claude_review_status) — use that with clients that cut tool calls at ~30s."),
  },
  async (args, extra) => {
    const { sessionId, message, model, timeoutMinutes } = args;
    const maxBudgetUsd = args.maxBudgetUsd ?? ENV.maxBudgetUsd;

    const langCheck = validateLanguage(args.outputLanguage);
    if (!langCheck.ok) return err(langCheck.error);
    const outputLanguage = langCheck.lang;

    // Cheap input validation before the paid preflight: sessionId and model both
    // land in claude's argv (--resume / --model), so a leading "-" must be
    // refused here — the same rule validateBaseRef applies to refs echoed into
    // git commands.
    const sessionCheck = validateSessionId(sessionId);
    if (!sessionCheck.ok) return err(sessionCheck.error);
    const modelCheck = validateModel(model);
    if (!modelCheck.ok) return err(modelCheck.error);

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
    // Any refusal between here and runClaude must release the guard file:
    // prepareRunHardening marked it in-flight and only runClaude (or this
    // helper) clears the mark — a leaked mark keeps the file undeletable
    // until the 2h sweep (cleanupGuardSettings skips in-flight entries).
    const preflightFail = (msg) => {
      markGuardSettingsInFlight(guardSettings, false);
      removeGuardSettings(guardSettings);
      return err(msg);
    };

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return preflightFail(`repoPath does not exist or is not a directory: ${repoPath}`);
    }

    // The followup child runs the same allowlisted git reads from cwd=repoPath,
    // so it gets the same repo preflight as a full review: a directory that is
    // no longer a repository (moved, or .git removed since the original run)
    // would otherwise spawn a paid run that fails late, and a broken git
    // surfaces as a timeout instead of git's own error.
    if (!isRepo(repoPath)) {
      return preflightFail(
        `${repoPath} is not a version-controlled repository (no .git/.hg/.svn found). ` +
        `The followup resumes a review session inside that repository, so it cannot run here — ` +
        `point repoPath at the repository the original review ran in.`
      );
    }
    const pre = await gitPreflight(repoPath);
    if (pre.gitError) {
      const e = pre.gitError;
      const detail = [e.code, e.message].filter(Boolean).join(": ") || String(e);
      return preflightFail(
        `git failed in ${repoPath} (${detail}). The followup cannot run there — ` +
        `check that git can access the repo (ownership/safe.directory, permissions), then retry.`
      );
    }

    // Same repo-controlled git-config gate as a full review: the followup child
    // runs the same allowlisted git reads from cwd=repoPath, so a live
    // core.fsmonitor / driver would execute here too. (Dead cross-machine
    // config only notes, matching the review path.)
    const gitPrograms = repoRunsGitPrograms(repoPath);
    if (gitPrograms.refusals.length) {
      return preflightFail(
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
      return preflightFail(`Local gateway not reachable: ${gw.host} (${gw.reason}). Start CC Switch / your local gateway, then retry.`);
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
    // The followup grants Agent/Task, so subagents can run here — capture their
    // reports exactly like the review tool does (audit F2: they used to be
    // dropped, although the JSONL was already on disk).
    const followReports = [];
    let followSubagentsFile = null;
    // Same sync-fs guard as the review path: a bad CLAUDE_REVIEW_LOG_DIR must
    // become an actionable tool error before the paid followup starts, not an
    // opaque internal exception (audit P2-12).
    let subagentsDir;
    try { subagentsDir = logsDir(); }
    catch (e) {
      return preflightFail(
        `Could not prepare this followup's log directory: ${e?.message || e}. ` +
        `Set CLAUDE_REVIEW_LOG_DIR to a writable directory (or fix its permissions) and retry — the followup was not started.`
      );
    }
    const run = await runClaude({
      cli,
      repoPath,
      prompt: buildFollowupPrompt(message, outputLanguage),
      allowedTools: reviewAllowedTools(),
      disallowedTools: reviewDisallowedTools({ fix: false }),
      model: modelCheck.model || ENV.model,
      maxTurns: 30,
      maxBudgetUsd,
      resumeSessionId: sessionCheck.sessionId,
      flags: {
        effort: false,
        budget: budgetFlagSupported,
        settingSources: true,
        permissionMode,
        permissionPrompts,
        streamJson: streamJsonSupported,
      },
      guardSettings,
      subagentsDir,
      onSubagentReport: (rec, file) => {
        followReports.push(rec);
        if (typeof file === "string") followSubagentsFile = file;
      },
      timeoutMs: timeoutMinutes * 60_000,
      signal,
    });
    if (progressTimer) clearInterval(progressTimer);

    const logFile = writeLogFile(run.stdout, run.stderr, [followSubagentsFile]);
    const logNote = logNoteOf(logFile);
    // Audit F2: the same "never lose paid-for work" contract as the review tool
    // — any interruption or failure still carries the finished subagent reports.
    const followNote = [
      subagentReportsText(followReports),
      typeof followSubagentsFile === "string"
        ? `_partial reports file: ${followSubagentsFile} (one JSONL line per finished subagent)_`
        : "",
    ].filter(Boolean).join("\n\n");
    const carried = followNote ? `\n\n${followNote}` : "";
    const j = run.json;

    if (run.cancelled) return err(`followup cancelled by the client.${logNote}${carried}`);
    if (run.timedOut) return err(`followup timed out after ${timeoutMinutes} minutes.${logNote}${stderrTail(run.stderr)}${carried}`);
    if (!j) return err(`claude exited (code ${run.exitCode}) without a parseable result (bad session_id? gateway down?).${logNote}${stderrTail(run.stderr)}${carried}`);

    const looksLikeApiError = /^API Error/i.test(String(j.result || ""));
    const replyText = String(j.result ?? "");
    // Same rule as a review: an empty reply is a failed turn, not a clean
    // answer. A caller that trusts status/isError would otherwise read "the
    // reviewer said nothing" as "there is nothing to say".
    const emptyReply = replyText.trim().length === 0;
    const ok = j.subtype === "success" && j.is_error !== true && !looksLikeApiError && !emptyReply;
    const status2 = ok ? "success"
      : (j.subtype && j.subtype !== "success" ? j.subtype : (emptyReply ? "empty_report" : "claude reported an error"));
    // Same denial split as a full review (audit P0-7). The chaining reporter
    // needs the set of commands that were actually DENIED: passing an empty set
    // turned every command the guard correctly blocked into "RAN WITHOUT BEING
    // BLOCKED ... treat this repository as hostile", while a real allowlist gap
    // in a followup was never reported at all.
    const { deniedCommands, guardBlocked, realDenials, denialNote, guardNote } = classifyDenials(j, repoPath);
    if (!ok) {
      // The same empty-result treatment as a review (same status value, same
      // actionable hints); logNote/carried keep the paid-for subagent reports
      // reachable even when the parent turn produced nothing.
      const errBanner = status2 === "empty_report" ? emptyReportBanner(j, "reply") : failureBanner(j, run);
      return {
        isError: true,
        content: [{ type: "text", text: errBanner + stderrTail(run.stderr) + logNote + carried }],
        structuredContent: {
          status: status2, sessionId: j.session_id ?? sessionId, reply: replyText,
          ...(status2 === "empty_report"
            ? { error: "empty reply: claude's result was empty, so the reviewer produced no reply (this is a failed followup, not an empty answer)" }
            : {}),
          subagents: subagentsView(followReports),
          subagentsSpawned: followReports.length || undefined,
          subagentsFile: followSubagentsFile || undefined,
          permissionDenials: realDenials.length,
          shellGuardBlocked: guardBlocked.length,
        },
      };
    }
    // Backstop reporting: same classifier and same denied set as the review
    // path, so the same input produces the same note (audit P0-7).
    const chainNote = shellChainingNote(run.bashCommands, deniedCommands, { repoRoot: repoPath }) || "";
    const warningNote = [denialNote, guardNote, chainNote].filter(Boolean).join("\n\n");
    // Same model-provenance check as a full review: a followup that silently
    // answers on a substituted model is not the session the caller thinks it is.
    const followFacts = resultFacts(j);
    const provenance = buildModelProvenance({
      requestedModel: modelCheck.model || ENV.model || null,
      mainModels: run.mainModels,
      subagentModels: run.subagentModels,
      unrecognized: run.unrecognizedModels,
      billedModels: Object.keys(followFacts.modelUsage || {}),
    });
    return {
      content: [{ type: "text", text: gitProgramNotes + runResultText(j.result, {
        status: status2,
        sessionId: j.session_id ?? sessionId,
        costUsd: j.total_cost_usd, numTurns: j.num_turns, durationMs: j.duration_ms, logFile,
        warning: provenance.note || undefined,
        effectiveModel: provenance.main.length ? provenance.main.join(", ") : undefined,
      }) + (warningNote ? `\n\n${warningNote}` : "") + (provenance.note ? `\n\n${provenance.note}` : "") }],
      structuredContent: {
        status: status2, sessionId: j.session_id ?? sessionId,
        costUsd: j.total_cost_usd, numTurns: j.num_turns, durationMs: j.duration_ms, reply: j.result,
        hardening,
        permissionDenials: realDenials.length,
        shellGuardBlocked: guardBlocked.length,
        modelProvenance: {
          requested: provenance.requested,
          main: provenance.main,
          subagents: provenance.subagents,
          billed: provenance.billed,
          substituted: provenance.substituted,
        },
        modelUsage: followFacts.modelUsage,
        usage: followFacts.usage,
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
      .then((result) => settleReviewJob(job, result))
      .catch((e) => settleReviewJob(job, err(`followup job crashed: ${e?.message || e}`)))
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
