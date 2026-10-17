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
  guardState, guardSelfTest, gatewayTarget, probeGateway,
} from "../src/claude.js";
import { skillStatus, installBundledSkill } from "../src/skill.js";

const execFileAsync = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PKG_ROOT, "src", "index.js");

const say = (s = "") => console.log(s);
const ok = (label) => say(`  ✓ ${label}`);
const bad = (label) => say(`  ✗ ${label}`);
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
    const { stdout } = await execFileAsync(name, args, { timeout: 15000, windowsHide: true });
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
  // Gateway auth comes from the effective env (settings.json env block or the
  // host env). Carry the BASE_URL + tokens into the server's env so the MCP
  // works regardless of how ZCode itself was launched. Direct-OAuth / API-key
  // users need nothing here.
  const merged = { ...JSON.parse(JSON.stringify(process.env)) };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (merged[k]) envBlock[k] = merged[k];
  }
  const probe = await probeGateway();
  ok(`gateway: ${t.url}${probe.skipped ? " (probe skipped)" : probe.ok ? " — reachable" : ` — NOT reachable (${probe.reason})`}`);
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
try {
  config = JSON.parse(fs.readFileSync(zcodeConfigPath, "utf8"));
} catch { /* missing or unparsable: start fresh (we only create it if missing) */
  const raw = fs.existsSync(zcodeConfigPath) ? fs.readFileSync(zcodeConfigPath, "utf8") : null;
  if (raw && raw.trim()) {
    bad(`cannot parse ${zcodeConfigPath} — fix it manually, then re-run; nothing was written`);
    process.exit(1);
  }
}
config.mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
config.mcp.servers = config.mcp.servers && typeof config.mcp.servers === "object" ? config.mcp.servers : {};

const prev = config.mcp.servers["cc-code-review"];
if (prev && prev.command === entry.command && JSON.stringify(prev.args) === JSON.stringify(entry.args)
    && JSON.stringify(prev.env || {}) === JSON.stringify(entry.env || {})) {
  ok("already registered with the correct paths for this machine — nothing to change");
} else {
  // Preserve unknown extra fields (enabled / timeoutMs / cwd) on an existing entry.
  config.mcp.servers["cc-code-review"] = { ...(prev && typeof prev === "object" ? prev : {}), ...entry };
  const dir = path.dirname(zcodeConfigPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(zcodeConfigPath, JSON.stringify(config, null, 2) + "\n");
  ok(prev ? `updated existing entry (was: ${prev.command} ${(prev.args || [])[0] ?? ""})` : "created new entry");
}
say(`  ${JSON.stringify({ "cc-code-review": config.mcp.servers["cc-code-review"] }, null, 2).split("\n").slice(1, -1).join("\n")}`);
say("");

say(failures === 0
  ? `self-check passed — restart ZCode (or reconnect the MCP) and the tools mcp__cc-code-review__* become available`
  : `self-check found ${failures} problem${failures > 1 ? "s" : ""} (see above) — registration was written anyway; fix them and re-run npm run init`);
process.exit(failures === 0 ? 0 : 2);
