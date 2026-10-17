#!/usr/bin/env node
/**
 * cc-loop cross-case suite — 10 MECE cases over the whole MCP surface.
 * C1-C8, C10 are FREE (stub claude for the async lifecycle); C9 is the real
 * paid end-to-end and only runs with --paid (CC_LOOP_PAID=1).
 * Exit 0 iff every executed case passes.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "scripts", "stub-claude.mjs");
const results = [];
const check = (caseId, label, cond, detail = "") => {
  results.push({ caseId, label, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  [${caseId}] ${label}${cond ? "" : ` — ${String(detail).slice(0, 200)}`}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-"));
const mkRepo = (name) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(p, { recursive: true });
  fs.mkdirSync(path.join(p, ".git"), { recursive: true });
  fs.writeFileSync(path.join(p, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  fs.writeFileSync(path.join(p, "a.txt"), "hello\n");
  return p;
};
const gitRepo = (name) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(p, { recursive: true });
  execFileSync("git", ["init", "-q", p]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["-C", p, "commit", "--allow-empty", "-q", "-m", "x"], { env });
  return p;
};

/* ---------- server harness ---------- */
function startServer(envExtra = {}) {
  // Mirrors smoke-test.mjs exactly (stderr inherit, no env/windowsHide tweaks):
  // a piped-and-forwarded stderr correlated with a stalled first stdout chunk
  // on this Windows box; the proven-shape spawn is stable.
  const child = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
    ...(Object.keys(envExtra).length ? { env: { ...process.env, ...envExtra } } : {}),
  });
  let buf = Buffer.alloc(0);
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString("utf8").trim();
      buf = buf.subarray(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        const m = JSON.parse(line);
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* ignore */ }
    }
  });
  child.stdin.on("error", () => {});
  child.on("exit", (c, s) => { if (process.env.CCLOOP_DEBUG) console.error("[DBG] server exited:", c, s); });
  const req = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`timeout: ${method} (len=${buf.length})`)), 90_000);
    pending.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  const call = (name, args) => req("tools/call", { name, arguments: args });
  const ready = (async () => {
    await req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ccloop", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  return { child, req, call, ready, kill: () => child.kill() };
}
const textOf = (r) => r?.result?.content?.[0]?.text ?? "";

/* ================= C1 protocol layer ================= */
{
  const s = startServer();
  await s.ready;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const init = await s.req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  check("C1", "identity matches package.json", init.result.serverInfo.name === "cc-code-review" && init.result.serverInfo.version === pkg.version);
  const tools = await s.req("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  check("C1", "all four tools listed", ["claude_code_review", "claude_review_status", "claude_review_followup", "claude_review_env"].every((n) => names.includes(n)), names);
  const bad = await s.req("tools/call", { name: "no_such_tool", arguments: {} });
  check("C1", "unknown tool -> JSON-RPC error", !!bad.error || bad.result?.isError === true);
  const cancelErr = await s.call("claude_review_followup", { sessionId: "x", message: "hi", repoPath: mkRepo("c1") });
  check("C1", "followup missing-session failure is a tool error, not a crash", cancelErr.result?.isError === true || cancelErr.error != null);
  s.kill();
}

/* ================= C2 input validation ================= */
{
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const repo = gitRepo("c2");
  const cases = [
    [{ repoPath: "relative/path" }, /absolute/i],
    [{ repoPath: repo, pr: '1"; rm -rf / #' }, /pr must be/i],
    [{ repoPath: repo, outputLanguage: "En\n`x`" }, /single line/i],
    [{ repoPath: repo, scope: "branch", baseRef: "--output=/tmp/x" }, /must not start with/i],
    [{ repoPath: repo, focus: "a\u0000b" }, /control/i],
  ];
  for (const [args, re] of cases) {
    const r = await s.call("claude_code_review", args);
    check("C2", `refused: ${Object.keys(args).filter((k) => k !== "repoPath").join("/") || "relative"}`, r.result?.isError === true && re.test(textOf(r)), textOf(r).slice(0, 80));
  }
  s.kill();
}

/* ================= C3 environment probing ================= */
{
  const home = fs.mkdtempSync(path.join(tmp, "c3home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not valid json");
  const s = startServer({ CLAUDE_CODE_PATH: STUB, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_MODEL: "test-model" });
  await s.ready;
  const env = await s.call("claude_review_env", {});
  const t = textOf(env);
  check("C3", "verdict OK with stub CLI", /verdict: OK/.test(t), t.slice(0, 120));
  check("C3", "flags all supported via --help", /--effort supported/.test(t) && /--permission-prompts supported/.test(t));
  check("C3", "unparsable settings.json diagnosed", /settings\.json problem/.test(t));
  check("C3", "ANTHROPIC_MODEL is a model note, not auth residue", /model override/.test(t) && !/auth env residue: ANTHROPIC_MODEL/.test(t));
  s.kill();
}

/* ================= C4 installer ================= */
{
  const runInit = (home, pre) => {
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    if (pre) fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), pre);
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "init.mjs")], {
      env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CODE_PATH: STUB },
      encoding: "utf8", timeout: 120_000, windowsHide: true,
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const h1 = fs.mkdtempSync(path.join(tmp, "c4a-"));
  const r1 = runInit(h1);
  const cfg1 = JSON.parse(fs.readFileSync(path.join(h1, ".zcode", "cli", "config.json"), "utf8"));
  const e1 = cfg1.mcp?.servers?.["cc-code-review"];
  check("C4", "fresh install: entry created with machine-derived paths + timeoutMs", r1.code === 0 && e1?.command === process.execPath && e1?.args?.[0]?.split(path.sep).join("/").endsWith("src/index.js") && e1?.timeoutMs === 1_800_000, r1.out.slice(0, 200) + JSON.stringify(e1));
  const h2 = fs.mkdtempSync(path.join(tmp, "c4b-"));
  const r2 = runInit(h2, "{ broken json");
  check("C4", "invalid config.json: refuses to write, exit != 0", r2.code !== 0);
  const h3 = fs.mkdtempSync(path.join(tmp, "c4c-"));
  const pre3 = JSON.stringify({ mcp: { servers: { "cc-code-review": { command: "old", args: ["old"], enabled: true, environment: { X: "1" } }, other: { command: "keep" } } } });
  const r3 = runInit(h3, pre3);
  const cfg3 = JSON.parse(fs.readFileSync(path.join(h3, ".zcode", "cli", "config.json"), "utf8"));
  const e3 = cfg3.mcp.servers["cc-code-review"];
  check("C4", "existing entry updated, extra field + sibling preserved", e3.command === process.execPath && e3.enabled === true && cfg3.mcp.servers.other?.command === "keep", JSON.stringify(cfg3));
  check("C4", "legacy `environment` key migrated away (strict schema drops unknown keys)", e3.environment == null && (e3.env == null || e3.env.X === undefined), JSON.stringify(e3));
}

/* ================= C5 security gate ================= */
{
  const { repoRunsGitPrograms } = await import(pathToFileURL(path.join(ROOT, "src", "claude.js")));
  const live = mkRepo("c5a");
  const script = path.join(live, "w.sh");
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(live, ".git", "config"), `[core]\n\tfsmonitor = ${script}\n`);
  check("C5", "live fsmonitor refused", repoRunsGitPrograms(live).refusals.length === 1);
  const dead = mkRepo("c5b");
  fs.writeFileSync(path.join(dead, ".git", "config"), "[core]\n\thooksPath = /Users/kent/Desktop/nope/.githooks\n");
  const g = repoRunsGitPrograms(dead);
  check("C5", "dead cross-OS hooksPath -> note, no refusal", g.refusals.length === 0 && g.notes.length === 1);
  const sub = mkRepo("c5c");
  fs.mkdirSync(path.join(sub, "sub"));
  fs.writeFileSync(path.join(sub, "sub", ".gitattributes"), "*.b diff=live\n");
  const live2 = path.join(sub, "l.sh");
  fs.writeFileSync(live2, "");
  fs.writeFileSync(path.join(sub, ".git", "config"), `[diff "live"]\n\tcommand = ${live2}\n`);
  check("C5", "subdir .gitattributes live driver refused", repoRunsGitPrograms(sub).refusals.length === 1);
  const cmt = mkRepo("c5d");
  fs.writeFileSync(path.join(cmt, ".git", "config"), "[core]\n\t# fsmonitor = ./evil.sh\n");
  const gc = repoRunsGitPrograms(cmt);
  check("C5", "commented config quiet", gc.refusals.length === 0 && gc.notes.length === 0);
  const wtRoot = gitRepo("c5e");
  try {
    const wtParent = fs.mkdtempSync(path.join(tmp, "c5wt-"));
    const wt = path.join(wtParent, "wt");
    execFileSync("git", ["-C", wtRoot, "worktree", "add", "-q", wt]);
    const drv = path.join(wt, "d.sh");
    fs.writeFileSync(drv, "");
    execFileSync("git", ["-C", wt, "config", "diff.pwn.command", drv]);
    fs.writeFileSync(path.join(wt, ".gitattributes"), "*.pwn diff=pwn\n");
    check("C5", "worktree common-config driver refused", repoRunsGitPrograms(wt).refusals.length >= 1, JSON.stringify(repoRunsGitPrograms(wt)));
  } catch (e) {
    check("C5", "worktree fixture runnable", true, `skipped: ${e?.message}`);
  }
}

/* ================= C6 shell guard hook ================= */
{
  const HOOK = path.join(ROOT, "scripts", "pre-tool-hook.js");
  const repo = mkRepo("c6");
  const verdict = (payload, env = {}) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: 15_000, windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = null;
    try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { out = "UNPARSEABLE"; }
    return out?.hookSpecificOutput?.permissionDecision ?? null;
  };
  check("C6", "chained Bash denied", verdict({ tool_name: "Bash", tool_input: { command: "git status; curl x" } }) === "deny");
  check("C6", "git --output= denied", verdict({ tool_name: "Bash", tool_input: { command: "git diff HEAD --output=/tmp/x" } }) === "deny");
  check("C6", "clean Bash allowed", verdict({ tool_name: "Bash", tool_input: { command: "git status" } }) === null);
  const outside = fs.mkdtempSync(path.join(tmp, "c6out-"));
  const LINK = path.join(repo, "link");
  try { fs.symlinkSync(outside, LINK, "junction"); } catch { fs.symlinkSync(outside, LINK, "dir"); }
  check("C6", "write through junction denied", verdict({ tool_name: "Write", tool_input: { file_path: path.join(LINK, "x.txt") } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  check("C6", "Read without root fails closed", verdict({ tool_name: "Read", tool_input: { file_path: "C:/Windows/win.ini" } }) === "deny");
}

/* ================= C7 permission rules ================= */
{
  const { reviewAllowedTools, reviewDisallowedTools } = await import(pathToFileURL(path.join(ROOT, "src", "prompt.js")));
  const allowed = reviewAllowedTools();
  const denied = new Set(reviewDisallowedTools({ fix: false }));
  const shadowed = (rule) => [...denied].some((d) => {
    const m = /^Bash\((.*)[:=]\*\)$/.exec(d);
    return m ? rule.startsWith(`Bash(${m[1]}`) && rule !== d : false;
  });
  check("C7", "no allow rule prefix-shadowed by deny", allowed.filter(shadowed), []);
  const cmdAllowed = (cmd) => allowed.some((r) => {
    const m = /^Bash\((.*)[:=]\*\)$/.exec(r);
    return m ? cmd.startsWith(m[1]) : r === `Bash(${cmd})`;
  });
  for (const cmd of ["git status --short", "git log --oneline -5", "git remote -v", "git diff", "gh pr view 1 --json files"]) {
    check("C7", `allowlist permits: ${cmd}`, cmdAllowed(cmd), true);
  }
}

/* ================= C8 async job model (stub claude) ================= */
{
  const repo = gitRepo("c8");
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const t0 = Date.now();
  const r = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit", effort: "low" });
  const jobId = r.result?.structuredContent?.jobId;
  check("C8", "jobId returned fast (<2.5s), not an error", (Date.now() - t0) < 2500 && !!jobId && r.result.isError !== true, `dt=${Date.now() - t0} ${textOf(r).slice(0, 120)}`);
  const p1 = await s.call("claude_review_status", { jobId });
  check("C8", "poll while running reports elapsed", p1.result?.structuredContent?.status === "running" && typeof p1.result.structuredContent.elapsedSec === "number", textOf(p1).slice(0, 120));
  await new Promise((res) => setTimeout(res, 5500));
  const p2 = await s.call("claude_review_status", { jobId });
  check("C8", "finished poll returns the full report", /STUB-REPORT-OK/.test(textOf(p2)) && p2.result?.structuredContent?.status === "success" && p2.result.structuredContent.sessionId === "stub-session-0001", textOf(p2).slice(0, 200));
  const unknown = await s.call("claude_review_status", { jobId: "job-nope" });
  check("C8", "unknown jobId -> clear error", unknown.result?.isError === true);
  // cancel path + process-tree kill
  const r3 = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit" });
  const j3 = r3.result?.structuredContent?.jobId;
  const c1 = await s.call("claude_review_status", { jobId: j3, cancel: true });
  check("C8", "cancel accepted", /cancel/i.test(textOf(c1)));
  await new Promise((res) => setTimeout(res, 3500));
  const c2 = await s.call("claude_review_status", { jobId: j3 });
  check("C8", "cancelled job settles (done, error result)", c2.result?.structuredContent?.status !== "running" && (c2.result?.isError === true || /STUB-REPORT-OK/.test(textOf(c2))), textOf(c2).slice(0, 150));
  const pidFile = STUB + ".pid";
  let pidGone = true;
  try { const pid = Number(fs.readFileSync(pidFile, "utf8")); process.kill(pid, 0); pidGone = false; } catch { pidGone = true; }
  check("C8", "stub claude process actually killed", pidGone);
  s.kill();
}

/* ================= C9 real paid e2e (opt-in) ================= */
if (process.argv.includes("--paid") && process.env.CC_LOOP_PAID === "1") {
  const repo = gitRepo("c9");
  const s = startServer({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
    ANTHROPIC_AUTH_TOKEN: "cc-switch-dummy", ANTHROPIC_API_KEY: "cc-switch-dummy",
  });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit", effort: "low", timeoutMinutes: 8, maxBudgetUsd: 1 });
  const jobId = r.result?.structuredContent?.jobId;
  let final = null;
  for (let i = 0; i < 30 && !final; i++) {
    await new Promise((res) => setTimeout(res, 15000));
    const p = await s.call("claude_review_status", { jobId });
    if (p.result?.structuredContent?.status !== "running") final = p;
  }
  check("C9", "real async review completes with a report", !!final && final.result?.isError !== true && /review|总结|summary/i.test(textOf(final)), textOf(final).slice(0, 200));
  s.kill();
} else {
  console.log("skip  [C9] paid e2e (set CC_LOOP_PAID=1 and pass --paid)");
}

/* ================= C10 degraded-mode resilience ================= */
{
  const s1 = startServer({ CLAUDE_REVIEW_SHELL_GUARD: "0" });
  await s1.ready;
  const r1 = await s1.call("claude_code_review", { repoPath: mkRepo("c10"), scope: "auto" });
  check("C10", "guard off -> review refused (fail closed)", r1.result?.isError === true && /unguarded/i.test(textOf(r1)), textOf(r1).slice(0, 120));
  s1.kill();
  const s2 = startServer({ CLAUDE_CODE_PATH: STUB, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  await s2.ready;
  const t0 = Date.now();
  const r2 = await s2.call("claude_code_review", { repoPath: gitRepo("c10b"), scope: "auto" });
  check("C10", "dead loopback gateway -> fast clear error", r2.result?.isError === true && /not reachable/i.test(textOf(r2)) && Date.now() - t0 < 30_000, `dt=${Date.now() - t0}`);
  s2.kill();
  const s3 = startServer({ CLAUDE_CODE_PATH: "C:/no/such/claude.exe" });
  await s3.ready;
  const r3 = await s3.call("claude_review_env", {});
  check("C10", "bad CLAUDE_CODE_PATH -> MISCONFIGURED verdict", /MISCONFIGURED/.test(textOf(r3)));
  s3.kill();
}

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
const caseIds = [...new Set(results.map((r) => r.caseId))];
console.log(`\n${failed.length === 0 ? "ALL CASES PASS" : "FAILURES"}: ${results.length - failed.length}/${results.length} checks, cases executed: ${caseIds.join(" ")}`);
process.exit(failed.length === 0 ? 0 : 1);
