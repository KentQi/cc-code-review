import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
  if (!refresh && cachedCli && !cachedCli.error) {
    if (cliPathStillThere(cachedCli)) return cachedCli;
    cachedCli = undefined;
  }
  prefetchNpmGlobalRoot(); // non-blocking: the value is only needed on the fallback path
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

function hasShebang(p) {
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x23 && buf[1] === 0x21; // "#!"
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
  return isExecutableFile(p) || hasShebang(p) ? "exec" : "no";
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
let npmRootInflight;

function queryNpmGlobalRootAsync() {
  // Memoised INCLUDING the terminal failure (`null`): without this, every
  // resolveClaudeCli() on an npm-less machine re-spawned `npm root -g` and
  // waited out its 10s timeout in the background — the exact behaviour the
  // `break` below was meant to prevent.
  if (npmRootCache !== undefined) return Promise.resolve(npmRootCache);
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
        if (root && fs.existsSync(root)) { npmRootCache = root; return root; }
      } catch { /* try the next candidate */ }
      break; // npm-cli.js exists but could not be run: no point retrying every call
    }
    npmRootCache = null;
    return null;
  })().finally(() => { npmRootInflight = undefined; });
  return npmRootInflight;
}

/** Fire-and-forget: start the npm root query so a later call finds it cached. */
function prefetchNpmGlobalRoot() {
  void queryNpmGlobalRootAsync().catch(() => {});
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
  await npmRootInflight.catch(() => { /* probe failure = null, already memoised */ });
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

function claudeConfigDir() {
  const home = os.homedir();
  const expand = (p) => (p.startsWith("~/") || p.startsWith("~\\") ? path.join(home, p.slice(2)) : p);
  // CLAUDE_CONFIG_DIR can come from the process env or from the user settings' env block
  if (process.env.CLAUDE_CONFIG_DIR) return expand(process.env.CLAUDE_CONFIG_DIR);
  try {
    const f = path.join(home, ".claude", "settings.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j?.env?.CLAUDE_CONFIG_DIR) return expand(j.env.CLAUDE_CONFIG_DIR);
  } catch { /* no user settings */ }
  return path.join(home, ".claude");
}

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

function isLoopbackHost(h) {
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
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

// Node's default SIGTERM handling exits WITHOUT firing "exit" — on unix a detached
// claude would survive the server and keep burning credits. Handle signals explicitly.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    for (const c of liveChildren) { try { killTree(c); } catch { /* best effort */ }
    }
    process.exit(0);
  });
}
process.on("exit", () => {
  for (const c of liveChildren) { try { killTree(c); } catch { /* best effort */ }
  }
  cleanupGuardSettings();
  // Our throwaway git HOME (built lazily in gitSpawnOpts) — sync removal in an
  // exit handler is safe and stops one temp dir leaking per server process.
  if (gitEmptyHome && gitEmptyHome !== os.tmpdir()) {
    try { fs.rmSync(gitEmptyHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Parse the final `{"type":"result",...}` JSON object from claude stdout. */
export function parseResultJson(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && obj.type === "result") return obj;
    } catch { /* partial/banner line, keep scanning */ }
  }
  return null;
}

function execTarget(cli) {
  return cli.kind === "node-script"
    ? { cmd: process.execPath, baseArgs: [cli.path] }
    : { cmd: cli.path, baseArgs: [] };
}

const versionCache = new Map();
const versionInflight = new Map();
const helpCache = new Map();
const helpInflight = new Map();

/** `claude --version` (async so the MCP event loop is never blocked). Cached, in-flight deduped. */
export async function claudeVersion(cli) {
  if (versionCache.has(cli.path)) return versionCache.get(cli.path);
  if (versionInflight.has(cli.path)) return versionInflight.get(cli.path);
  const { cmd, baseArgs } = execTarget(cli);
  const p = (async () => {
    const { stdout } = await execFileAsync(cmd, [...baseArgs, "--version"], {
      timeout: 30000, windowsHide: true, env: buildClaudeEnv(),
    });
    const v = (stdout || "").trim();
    versionCache.set(cli.path, v);
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
  if (helpCache.has(cli.path)) return helpCache.get(cli.path);
  if (helpInflight.has(cli.path)) return helpInflight.get(cli.path);
  const { cmd, baseArgs } = execTarget(cli);
  const p = (async () => {
    const { stdout } = await execFileAsync(cmd, [...baseArgs, "--help"], {
      timeout: 30000, windowsHide: true, env: buildClaudeEnv(), maxBuffer: 8 * 1024 * 1024,
    });
    helpCache.set(cli.path, stdout || "");
    return helpCache.get(cli.path);
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
  try { fs.rmSync(file, { force: true }); } catch { /* temp dir cleanup is best effort */ }
}

// Every guard settings file this process wrote. runClaude removes its own file
// when the run settles, but guardState()/guardSelfTest() and the early-return
// paths in the tool handlers create files nobody removed — one leak per env
// check per process. cleanupGuardSettings() is called by the env tool and on
// process exit so nothing survives the server.
const guardSettingsFiles = new Set();
export function cleanupGuardSettings() {
  for (const f of guardSettingsFiles) removeGuardSettings(f);
  guardSettingsFiles.clear();
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
  sweptTempArtifacts = true;
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= cutoff) continue;
      if (/^guard-settings-.*\.json$/.test(name) && st.isFile()) fs.rmSync(p, { force: true });
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
    return writeGuardSettings() ? { state: "on", reason: st.reason } : { state: "failed", reason: "could not write the guard settings file" };
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
 * command that must NOT be. One ~50ms spawn each, run once per process.
 */
let guardSelfTestCache;
export async function guardSelfTest({ refresh = false } = {}) {
  if (!refresh && guardSelfTestCache !== undefined) return guardSelfTestCache;
  const st = shellGuardStatus();
  if (!st.enabled) {
    guardSelfTestCache = { ok: false, reason: st.reason };
    return guardSelfTestCache;
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
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ decision: null, error: String(e?.message || e) }));
    child.on("close", (code) => {
      let decision = null;
      try { decision = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || "{}"); } catch { /* no output = allow */ }
      resolve({ decision, code, stderr: err.slice(0, 300) });
    });
    child.stdin.on("error", () => { /* EPIPE: hook died before reading; close handler reports it */ });
    child.stdin.end(JSON.stringify(payload));
  });
  const decisionOf = (r) => r?.decision?.hookSpecificOutput?.permissionDecision;

  const bad = await probe({ tool_name: "Bash", tool_input: { command: "git status; echo PWNED" } });
  if (decisionOf(bad) !== "deny") {
    guardSelfTestCache = {
      ok: false,
      reason: `the hook did not deny a chained command (exit ${bad.code ?? "?"}${bad.error ? `, spawn error ${bad.error}` : ""})`,
    };
    return guardSelfTestCache;
  }
  const good = await probe({ tool_name: "Bash", tool_input: { command: "git status" } });
  if (decisionOf(good) === "deny") {
    guardSelfTestCache = {
      ok: false,
      reason: `the hook denied a clean command (${good.decision?.hookSpecificOutput?.permissionDecisionReason || "no reason"})`,
    };
    return guardSelfTestCache;
  }
  // Same deny probe, but through the shell-rendered command line — the path the
  // CLI actually takes. On Windows this is `cmd /d /s /c` on the quoted string,
  // on unix `/bin/sh -c`; if quoting cannot survive it, the guard is not real.
  const shelled = await probe({ tool_name: "Bash", tool_input: { command: "git status; echo PWNED" } }, "shell");
  if (decisionOf(shelled) !== "deny") {
    guardSelfTestCache = {
      ok: false,
      reason: `the hook command does not survive shell rendering (${shelled.error ? `spawn error ${shelled.error}` : `exit ${shelled.code ?? "?"}, no deny decision`}) — ` +
        `check guardHookCommand() quoting for node at ${process.execPath} and the hook at ${HOOK_SCRIPT}`,
    };
    return guardSelfTestCache;
  }
  guardSelfTestCache = { ok: true, reason: "verified: chained commands are denied (direct and via the shell-rendered command), clean ones allowed" };
  return guardSelfTestCache;
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
export function writeGuardSettings() {
  if (!shellGuardStatus().enabled) return null;
  try {
    const dir = path.join(os.tmpdir(), "cc-code-review");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepTempArtifacts(dir);
    const file = path.join(dir, `guard-settings-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read",
          hooks: [{ type: "command", command: guardHookCommand(), onFailure: "block" }],
        }],
      },
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
  allowedTools = [],
  disallowedTools = [],
  model,
  maxTurns = 80, // note: --max-turns is accepted by the CLI but not in --help (undocumented)
  maxBudgetUsd,
  resumeSessionId,
  effort,
  flags = { effort: false, budget: false },
  guardSettings,
  timeoutMs = 20 * 60 * 1000,
  signal,
}) {
  return new Promise((resolve) => {
    // A signal already aborted before we even spawn: never start a paid run.
    if (signal?.aborted) {
      removeGuardSettings(guardSettings);
      resolve({ ok: false, json: null, stdout: "", stderr: "", timedOut: false, cancelled: true, exitCode: null, durationMs: 0 });
      return;
    }

    const { cmd, baseArgs } = execTarget(cli);
    const args = [...baseArgs, "-p", "--max-turns", String(maxTurns)];
    // stream-json is the only output that shows which tools actually ran. It
    // costs nothing extra and lets us report shell-chained commands that the
    // permission rules could not block, instead of hoping none happened.
    if (flags.streamJson) args.push("--output-format", "stream-json", "--verbose");
    else args.push("--output-format", "json");
    if (effort && flags.effort) args.push("--effort", effort);
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
      removeGuardSettings(guardSettings);
      resolve({ ok: false, json: null, stdout: "", stderr: String(err?.message || err), timedOut: false, cancelled: false, exitCode: null, durationMs: 0, spawnError: String(err?.message || err) });
      return;
    }
    liveChildren.add(child);

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

    // stream-json puts the `result` event LAST, so a raw buffer truncated at
    // MAX_STREAM_BYTES would lose exactly the line we need. Parse each line as
    // it arrives instead, and keep the Bash commands for the shell-chaining
    // report (subagent calls never reach the parent's stream — the PreToolUse
    // hook is what actually stops those).
    let resultEvent = null;
    const bashCommands = [];
    let soPartial = Buffer.alloc(0);
    const ingest = (line) => {
      if (!line.startsWith("{")) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj?.type === "result") { resultEvent = obj; return; }
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
          bashCommands.push(block.input.command);
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
      soPartial = buf;
    });
    child.stderr.on("data", (d) => {
      if (seBytes >= MAX_STREAM_BYTES) { stderrTruncated = true; return; }
      const room = MAX_STREAM_BYTES - seBytes;
      seChunks.push(d.length > room ? d.subarray(0, room) : d);
      seBytes += Math.min(d.length, room);
      if (d.length > room) stderrTruncated = true;
    });

    const timer = setTimeout(() => {
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
      signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
      removeGuardSettings(guardSettings);
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
      resolve({
        ok: !wasCancelled && !timedOut && code === 0 && !!json,
        json,
        stdout,
        stderr,
        bashCommands,
        timedOut,
        cancelled: wasCancelled,
        exitCode: code,
        durationMs: Date.now() - started,
      });
    }

    child.on("error", (err) => {
      seChunks.push(Buffer.from(`\n[spawn error] ${err?.message || err}`));
      finish(-1);
    });
    child.on("close", (code, signalName) => finish(code, signalName));

    child.stdin.on("error", () => { /* EPIPE if claude dies early; close handler reports it */ });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
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
function gitSpawnOpts(cwd, extraEnv = {}) {
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
 * Does the repository's own git config / attributes try to run a program?
 *
 * `-c` overrides neutralise the keys we know about, but `.gitattributes` can name
 * an arbitrary filter driver (`*.foo diff=evil`), and `diff.evil.command` then
 * executes. That surface cannot be closed with `-c`, so it is refused instead.
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
 */
const CONFIG_CMD_PATTERNS = [
  /\btextconv\s*=/i,
  /\bexternal\s*=/i,
  /\bdiffFilter\s*=/i,
  /\bdriver\s*=/i,
  /\bhooksPath\s*=/i,
  /\bcommand\s*=/i,
  /\bprocess\s*=/i,
  /\bfilter\s*\.[\w.-]+\s*\.\s*(clean|smudge|process)\s*=/i,
  /\b(clean|smudge)\s*=/i,
];
// `core.fsmonitor` is a command only when it is not a boolean (`true` uses git's
// built-in monitor and is harmless — and is neutralised by -c anyway).
const FSMONITOR_CMD = /\bfsmonitor\s*=\s*(.+)/i;
// `[include] path = ...` pulls in another config file — but only when the path is
// chosen by the repo. `~/...` is the user's own config.
const INCLUDE_PATH = /^\s*path\s*=\s*(.+?)\s*$/i;
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

/** `.git/config` plus anything it `[include]s` (a repo-relative include can escape the repo). */
function repoConfigFiles(repoPath) {
  const out = [];
  const seen = new Set();
  const gitDir = path.join(repoPath, ".git");
  const walk = (file, label, depth) => {
    if (depth > 3 || seen.has(file)) return;
    seen.add(file);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    out.push({ file, label, text });
    const base = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gim)) {
      const raw = m[1].trim().replace(/^["']|["']$/g, "");
      if (!raw || raw.startsWith("~/")) continue; // ~ is the user's own config, not repo-controlled
      walk(path.isAbsolute(raw) ? raw : path.resolve(base, raw), `${label} -> include`, depth + 1);
    }
  };
  try {
    const st = fs.statSync(gitDir);
    walk(st.isDirectory() ? path.join(gitDir, "config") : gitDir, ".git/config", 0);
  } catch { /* no .git: nothing repo-controlled to scan */ }
  return out;
}

/** Attribute files that can name a driver: root, .git/info, and one directory deep. */
function repoAttributeFiles(repoPath) {
  const rels = [".gitattributes", path.join(".git", "info", "attributes")];
  try {
    for (const e of fs.readdirSync(repoPath, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") rels.push(path.join(e.name, ".gitattributes"));
    }
  } catch { /* unreadable dir: the top-level scans still ran */ }
  const out = [];
  for (const rel of rels) {
    const file = path.join(repoPath, rel);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    out.push({ file, label: rel, text });
  }
  return out;
}

export function repoRunsGitPrograms(repoPath) {
  const hits = [];
  const configs = repoConfigFiles(repoPath);
  // driver names the repo's own config defines (a section header alone is inert;
  // it only matters together with a .gitattributes reference)
  const definedDrivers = new Set();
  for (const { label, text } of configs) {
    const line = text.split(/\r?\n/).find(isCmdLine);
    if (line) hits.push(`${label}: ${line.trim().slice(0, 120)}`);
    for (const m of text.matchAll(/^\s*\[\s*(?:diff|filter)\s+"([^"]+)"\s*\]\s*$/gim)) {
      definedDrivers.add(m[1].toLowerCase());
    }
  }
  for (const { label, text } of repoAttributeFiles(repoPath)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /\b(?:diff|filter)\s*=\s*([\w.-]+)/i.exec(line);
      if (m && definedDrivers.has(m[1].toLowerCase())) {
        hits.push(`${label}: ${line.trim().slice(0, 120)} (driver "${m[1]}" is defined in .git/config)`);
        break;
      }
    }
  }
  return hits;
}

/** Cheap async git preflight: does the repo have commits / uncommitted work? */
export async function gitPreflight(repoPath) {
  const run = (args) => execFileAsync("git", [...GIT_HARDENING_ARGS, ...args], gitSpawnOpts(repoPath))
    .then((r) => ({ ok: true, out: r.stdout }))
    .catch((e) => ({ ok: false, err: e }));
  const head = await run(["rev-parse", "--verify", "HEAD"]);
  if (head.ok) return { hasCommits: true, dirty: null };
  const status = await run(["status", "--porcelain"]);
  const dirty = status.ok && status.out.trim().length > 0;
  return { hasCommits: false, dirty, gitError: !head.ok && !status.ok ? head.err : null };
}
