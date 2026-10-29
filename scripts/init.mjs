#!/usr/bin/env node
/**
 * Environment-aware installer / self-check for cc-code-review.
 *
 * No hardcoded OS paths anywhere: everything is derived from the machine this
 * runs on — process.execPath for node, this file's location for the package,
 * live probing for claude/git/gh, and ~/.claude/settings.json (or the host env)
 * for gateway credentials. Writes the ZCode registration with THOSE values.
 *
 * What it does:
 *  1. Self-check: claude CLI resolution + version + flag floors, shell guard,
 *     skill status, git/gh, gateway reachability (all free, no API calls).
 *  2. Registration: writes ~/.zcode/cli/config.json → mcp.servers.cc-code-review
 *     with absolute, OS-correct paths. Existing entries are updated in place;
 *     unrelated servers and unknown extra fields are preserved.
 *
 * Usage: npm run init   (inside the checked-out / installed package)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveClaudeCliSettled, claudeVersion, claudeSemver, versionAtLeast,
  PERMISSION_MODE_MANUAL_MIN, PERMISSION_PROMPTS_MIN, supportsFlag,
  guardState, guardSelfTest, gatewayTarget, probeGateway, buildClaudeEnv,
  peekSettingsEnv,
} from "../src/claude.js";
import { skillStatus, installBundledSkill } from "../src/skill.js";

const execFileAsync = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PKG_ROOT, "src", "index.js");

const say = (s = "") => console.log(s);
const ok = (label) => say(`  ✓ ${label}`);
const bad = (label) => say(`  ✗ ${label}`);

/**
 * The registration entry carries the gateway credential (ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_API_KEY) in its env block, and this script prints the entry as the
 * last thing the user sees — which then lands in terminal scrollback, CI logs and
 * pasted issue reports. Print the shape, never the secret.
 */
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
function redactEnvValue(key, value) {
  const s = String(value ?? "");
  if (SECRET_KEY.test(key)) return s.length < 12 ? "… (hidden)" : `${s.slice(0, 4)}… (hidden, len ${s.length})`;
  if (/BASE_URL|_URL$/i.test(key)) {
    try { return `${new URL(s).origin} (userinfo/path/query hidden)`; } catch { return "… (hidden)"; }
  }
  return s;
}
function redactEntry(entry) {
  if (!entry || typeof entry !== "object" || !entry.env || typeof entry.env !== "object") return entry;
  const env = {};
  for (const [k, v] of Object.entries(entry.env)) env[k] = redactEnvValue(k, v);
  return { ...entry, env };
}
let failures = 0;

/* ---------------- 1. self-check ---------------- */
say("cc-code-review — environment self-check");
say(`  platform: ${os.platform()} (${os.arch()}), node ${process.version} @ ${process.execPath}`);
say("");

say("claude cli:");
const cli = await resolveClaudeCliSettled();
let cliOk = false;
if (!cli) {
  bad("NOT FOUND — install Claude Code (https://code.claude.com/docs/en/setup) or set CLAUDE_CODE_PATH, then re-run npm run init");
  failures++;
} else if (cli.error) {
  bad(`MISCONFIGURED — ${cli.error}`);
  failures++;
} else {
  ok(`${cli.path} [source: ${cli.source}]`);
  try {
    const version = await claudeVersion(cli);
    const semver = await claudeSemver(cli);
    ok(`version ${version}`);
    const effort = await supportsFlag(cli, "--effort");
    const budget = await supportsFlag(cli, "--max-budget-usd");
    ok(`flags: --effort ${effort ? "yes" : "no (keyword fallback)"}, --max-budget-usd ${budget ? "yes" : "no (skipped)"}`);
    if (semver) {
      const m = versionAtLeast(semver, PERMISSION_MODE_MANUAL_MIN);
      const p = versionAtLeast(semver, PERMISSION_PROMPTS_MIN);
      ok(`hardening floors: manual-mode ${m ? "ok" : `TOO OLD (< ${PERMISSION_MODE_MANUAL_MIN})`}, permission-prompts ${p ? "ok" : `TOO OLD (< ${PERMISSION_PROMPTS_MIN})`}`);
    } else {
      say("  ! version unreadable — flags will be help-text probed at run time");
    }
    cliOk = true;
  } catch (e) {
    bad(`version query failed: ${e?.message || e}`);
    failures++;
  }
}
say("");

say("shell guard:");
const guard = guardState();
if (guard.state === "on") {
  const self = await guardSelfTest();
  if (self.ok) ok(`installed — ${self.reason}`);
  else { bad(`NOT WORKING — ${self.reason}`); failures++; }
} else {
  bad(`${guard.state} — ${guard.reason}`);
  failures++;
}
say("");

say("helpers:");
for (const [name, args] of [["git", ["--version"]], ["gh", ["--version"]]]) {
  try {
    // buildClaudeEnv(): a GUI/service-launched init inherits a sparse PATH;
    // the review itself always probes with this env (src/index.js env tool).
    const { stdout } = await execFileAsync(name, args, { timeout: 15000, windowsHide: true, env: buildClaudeEnv() });
    ok(`${name}: ${String(stdout).trim().split(/\r?\n/)[0]}`);
  } catch {
    bad(`${name}: NOT available — ${name === "git" ? "git-based scopes will fail" : "PR scopes will fail (local scopes still work)"}`);
  }
}
say("");

say("code-review skill:");
const st = skillStatus();
if (st === "missing") {
  const r = installBundledSkill();
  ok(r.installed ? `installed -> ${r.dir}` : `skipped — ${r.reason}`);
} else if (st === "bundled") {
  ok(`already installed (managed by this MCP) at ~/.claude/skills/code-review`);
} else {
  say("  ! user-managed skill present — it will be used as-is (never overwritten)");
}
say("");

/* ---------------- 2. registration ---------------- */
say("ZCode registration (~/.zcode/cli/config.json):");
const zcodeConfigPath = path.join(os.homedir(), ".zcode", "cli", "config.json");

const envBlock = {};
const t = gatewayTarget();
if (t) {
  // Gateway auth comes from the EFFECTIVE env — the same rule claude itself (and
  // this server's own gatewayTarget()) applies: the settings.json env block wins
  // over the inherited process env. Reading only process.env here meant that a
  // machine configured entirely through ~/.claude/settings.json (CC Switch's
  // normal shape) got `✓ gateway: …` printed and an env block with NO base URL
  // and NO token — so the registered server failed auth or talked to the wrong
  // endpoint on every review (audit P1-9). peekSettingsEnv() is mergedAuthEnv()'s
  // exported half; keep the two in step.
  const merged = { ...process.env, ...peekSettingsEnv() };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (merged[k]) envBlock[k] = merged[k];
  }
  const probe = await probeGateway();
  ok(`gateway: ${redactEnvValue("ANTHROPIC_BASE_URL", t.url)}${probe.skipped ? " (probe skipped)" : probe.ok ? " — reachable" : ` — NOT reachable (${probe.reason})`}`);
}

const entry = {
  command: process.execPath,          // THIS machine's node, absolute, any OS
  args: [SERVER],                     // THIS checkout's entry file, absolute
  // Many clients default to a ~30s tool-call timeout; claude_review_followup
  // and waitForResult=true runs need far more. Async-mode reviews don't, but a
  // generous timeout hurts nothing.
  timeoutMs: 1_800_000,
  ...(Object.keys(envBlock).length ? { env: envBlock } : {}),
};

let config = {};
let sawParseProblem = false;
try {
  config = JSON.parse(fs.readFileSync(zcodeConfigPath, "utf8"));
} catch (e) {
  sawParseProblem = true;
  // Two shapes must exit cleanly instead of crashing later (CHANGELOG 1.8.3
  // claimed this and it was never true):
  //  - config.json is a DIRECTORY: readFileSync throws EISDIR, and the write
  //    below would throw EISDIR too — say so here.
  //  - config.json exists but is unreadable (EACCES / locked): the recovery
  //    read must not throw out of this catch.
  let isFile = false;
  try { isFile = fs.statSync(zcodeConfigPath).isFile(); } catch { /* missing: fine */ }
  if (!isFile && fs.existsSync(zcodeConfigPath)) {
    bad(`${zcodeConfigPath} is not a regular file (is it a directory?) — fix it manually, then re-run; nothing was written`);
    process.exit(1);
  }
  let raw = null;
  if (isFile) {
    try { raw = fs.readFileSync(zcodeConfigPath, "utf8"); } catch (readErr) {
      bad(`cannot read ${zcodeConfigPath} (${readErr?.message || readErr}) — fix its permissions, then re-run; nothing was written`);
      process.exit(1);
    }
  }
  if (raw && raw.trim()) {
    bad(`cannot parse ${zcodeConfigPath} (${e?.message || e}) — fix it manually, then re-run; nothing was written`);
    process.exit(1);
  }
  config = {};
}
// A top-level JSON value that is not an object (null/123/true/"str"/[]) cannot
// carry servers; treat it like an unparsable file rather than crashing.
if (sawParseProblem || typeof config !== "object" || config === null || Array.isArray(config)) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    bad(`${zcodeConfigPath} is not a JSON object — fix it manually, then re-run; nothing was written`);
    process.exit(1);
  }
}
config.mcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp) ? config.mcp : {};
config.mcp.servers = config.mcp.servers && typeof config.mcp.servers === "object" && !Array.isArray(config.mcp.servers) ? config.mcp.servers : {};

const prev = config.mcp.servers["cc-code-review"];
const prevObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : null;
// Migration: `environment` is a legacy key ZCode's strict schema silently drops
// (CLI parsing tolerates it; the desktop path expects `env`) — carrying it
// forward forever looks configured while doing nothing.
if (prevObj && prevObj.environment != null) delete prevObj.environment;
// Preserve a user-customized timeout; only stamp the default when absent.
const timeoutMs = prevObj?.timeoutMs ?? entry.timeoutMs;
// env: the derived keys (gateway BASE_URL/tokens) must win, but keys the user
// added by hand (HTTP_PROXY, DISABLE_TELEMETRY, their own ANTHROPIC_*) are NOT
// derived here — dropping them on every re-init silently broke working setups.
// Merge: user keys outside the derived set survive, derived keys overwrite.
//
// SEC-16 verified contract (locked by the audit-fixes suite's init case):
//   prevEnv = { HTTP_PROXY, MY_KEY, ANTHROPIC_AUTH_TOKEN: "old" }
//   derivedEnv = { ANTHROPIC_AUTH_TOKEN: "new", ANTHROPIC_BASE_URL }
//   mergedEnv = { HTTP_PROXY, MY_KEY, ANTHROPIC_AUTH_TOKEN: "new", ANTHROPIC_BASE_URL }
// — unknown keys keep their VALUES (not just their names), and a same-named
// derived key always wins because it is spread last. Do not "clean up" prevEnv
// by filtering it against a known-key list: that is exactly what dropped
// HTTP_PROXY in 1.6.x.
const prevEnv = prevObj?.env && typeof prevObj.env === "object" && !Array.isArray(prevObj.env) ? prevObj.env : {};
const derivedEnv = entry.env && typeof entry.env === "object" ? entry.env : {};
const mergedEnv = { ...prevEnv, ...derivedEnv };
const finalEntry = { ...(prevObj || {}), ...entry, timeoutMs, ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) };
if (prevObj && prevObj.command === entry.command && JSON.stringify(prevObj.args) === JSON.stringify(entry.args)
    && JSON.stringify(prevObj.env || {}) === JSON.stringify(mergedEnv) && prevObj.timeoutMs === timeoutMs) {
  ok("already registered with the correct paths for this machine — nothing to change");
} else {
  config.mcp.servers["cc-code-review"] = finalEntry;
  const dir = path.dirname(zcodeConfigPath);
  // The file carries the gateway credential in mcp.servers[].env, so it must not
  // be world-readable: 0600 for the file, 0700 for its directory (the default
  // umask would leave a token in a 0644 file).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* pre-existing dir we do not own */ }
  // SEC-16: write atomically — same-directory temp file + fsync + rename.
  //
  // The old code did writeFileSync(configPath), which truncates the live file
  // before writing a single byte. ZCode (and every other MCP host) re-reads this
  // file while the server runs, so a crash / ENOSPC / full disk between the
  // truncate and the last byte leaves an unparsable config.json — and a parse
  // failure in that file takes out every server it lists, not just this one.
  // A rename on the same filesystem is atomic: readers see either the complete
  // old file or the complete new one, never a partial one. The temp name is
  // unique per process so two concurrent installers cannot clobber each other,
  // and it is cleaned up on every failure path below.
  const tmpPath = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    // mode 0600 at creation (this file holds a token even before the chmod).
    const fd = fs.openSync(tmpPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n");
      // fsync before the rename: rename publishes the directory entry, so the
      // bytes must already be on disk or a power loss can publish an empty file.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* best effort; mode was set at open */ }
    fs.renameSync(tmpPath, zcodeConfigPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* never created / already gone */ }
    bad(`cannot write ${zcodeConfigPath} (${e?.message || e}) — the file may be read-only or locked; nothing was written`);
    process.exit(1);
  }
  ok(prevObj ? `updated existing entry (was: ${prevObj.command} ${(prevObj.args || [])[0] ?? ""})` : "created new entry");
}
say(`  ${JSON.stringify({ "cc-code-review": redactEntry(config.mcp.servers["cc-code-review"]) }, null, 2).split("\n").slice(1, -1).join("\n")}`);
say("");

say(failures === 0
  ? `self-check passed — restart ZCode (or reconnect the MCP) and the tools mcp__cc-code-review__* become available`
  : `self-check found ${failures} problem${failures > 1 ? "s" : ""} (see above) — registration was written anyway; fix them and re-run npm run init`);
process.exit(failures === 0 ? 0 : 2);
