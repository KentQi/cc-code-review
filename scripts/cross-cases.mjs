#!/usr/bin/env node
/**
 * cc-loop cross-case suite — 21 MECE cases over the whole MCP surface.
 * C1-C8 and C10-C22 are FREE (stub claude for the async lifecycle and the reviewer-report/provenance e2e); C9 is the real
 * paid end-to-end and only runs with --paid (CC_LOOP_PAID=1).
 * Exit 0 iff every executed case passes.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectServer } from "./lib/mcp-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "scripts", "stub-claude.mjs");
const results = [];
const check = (caseId, label, cond, detail = "") => {
  results.push({ caseId, label, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  [${caseId}] ${label}${cond ? "" : ` — ${String(detail).slice(0, 200)}`}`);
};
// A skipped check is not a pass: it is reported and counted separately, so a
// fixture that stops working can never look green.
const skip = (caseId, label) => {
  results.push({ caseId, label, ok: true, skipped: true });
  console.log(`SKIP  [${caseId}] ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-"));
// P1-5: this tree holds real installer output — C4 runs init.mjs, which copies
// ANTHROPIC_* credentials into ~/.zcode/cli/config.json. It is a throwaway
// HOME, but leaving it behind parks those credentials in $TMPDIR. Remove the
// whole tree on every exit path: `exit` covers the normal summary and
// process.exit(), the monitor covers an uncaught throw (Node does NOT emit
// `exit` for those), and the signals cover an interrupted run.
const cleanupTmp = () => {
  // Retries matter on Windows: a child that s.kill() only signalled may still
  // hold a handle in the tree when this runs, and one EPERM would leave the
  // whole installer HOME (with its credentials) behind.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
};
process.on("exit", cleanupTmp);
process.on("uncaughtExceptionMonitor", cleanupTmp);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanupTmp(); process.exit(128 + (sig === "SIGINT" ? 2 : 15)); });
}
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
// A repo whose HEAD has a parent: the native /code-review command targets a BASE
// ref (`HEAD~1`), so a root-commit repo cannot use it for scope=last-commit.
const gitRepo2 = (name) => {
  const p = gitRepo(name);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["-C", p, "commit", "--allow-empty", "-q", "-m", "y"], { env });
  return p;
};

/* ---------- server harness ---------- */
// The stdio client lives in scripts/lib/mcp-client.mjs (audit Q20). The wrapper
// keeps this suite's historical surface ({ child, req, call, ready, kill }) so
// every case below is untouched: stderr is inherited, no env is passed when the
// case did not ask for an override, and stdout lines that do not start with "{"
// are ignored (the host may print banners before the JSON-RPC stream).
function startServer(envExtra = {}) {
  const srv = connectServer({
    args: [path.join(ROOT, "src", "index.js")],
    stdio: ["pipe", "pipe", "inherit"],
    ...(Object.keys(envExtra).length ? { env: { ...process.env, ...envExtra } } : {}),
    timeoutMs: 90_000,
    clientInfo: { name: "ccloop", version: "0" },
    requireJsonObjectPrefix: true,
  });
  srv.child.on("exit", (c, s) => { if (process.env.CCLOOP_DEBUG) console.error("[DBG] server exited:", c, s); });
  const req = srv.request;
  const call = (name, args) => srv.call(name, args);
  const ready = srv.initialize();
  return { child: srv.child, req, call, ready, kill: () => srv.close() };
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
  check("C1", "followup handled without crash (async jobId or clear error)", !!cancelErr.result?.structuredContent?.jobId || cancelErr.result?.isError === true || cancelErr.error != null, textOf(cancelErr).slice(0, 120));
  {
    // Re-cover the followup job lifecycle: the bogus-session job must SETTLE
    // (with the stub CLI it succeeds; with real claude it errors — either way
    // it must not hang in "running" forever).
    const jid = cancelErr.result?.structuredContent?.jobId;
    if (jid) {
      let settled = null;
      for (let i = 0; i < 12 && !settled; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const p = await s.call("claude_review_status", { jobId: jid });
        if (p.result?.structuredContent?.status !== "running") settled = p;
      }
      check("C1", "followup job settles (not stuck running)", !!settled && (settled.result?.isError === true || /reply|STUB|result/i.test(textOf(settled))), settled ? textOf(settled).slice(0, 120) : "never settled");
    }
  }
  s.kill();
}

/* ================= C2 input validation ================= */
{
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const repo = gitRepo("c2");
  const cases = [
    [{ repoPath: "relative/path" }, /absolute/i],
    [{ repoPath: "~kent/foo" }, /~user form/i],
    [{ repoPath: repo, pr: '1"; rm -rf / #' }, /pr must be/i],
    [{ repoPath: repo, outputLanguage: "En\n`x`" }, /single line/i],
    [{ repoPath: repo, scope: "branch", baseRef: "--output=/tmp/x" }, /must not start with/i],
    [{ repoPath: repo, focus: "a\u0000b" }, /control/i],
    [{ repoPath: repo, model: "--evil" }, /model must be a plain model id/i],
  ];
  for (const [args, re] of cases) {
    const r = await s.call("claude_code_review", args);
    check("C2", `refused: ${Object.keys(args).filter((k) => k !== "repoPath").join("/") || "relative"}`, r.result?.isError === true && re.test(textOf(r)), textOf(r).slice(0, 80));
  }
  // followup: sessionId and model land in claude's argv (--resume / --model),
  // so a leading "-" must be refused before the paid preflight; the repo
  // preflight (isRepo + git) must match the full review's.
  const nonRepo = fs.mkdtempSync(path.join(tmp, "c2nonrepo-"));
  const fuCases = [
    [{ sessionId: "--resume-evil", message: "hi", repoPath: repo }, /sessionId must be a plain session token/],
    [{ sessionId: "abc123", message: "hi", repoPath: repo, model: "--evil" }, /model must be a plain model id/],
    [{ sessionId: "abc123", message: "hi", repoPath: nonRepo }, /not a version-controlled repository/],
  ];
  for (const [args, re] of fuCases) {
    const r = await s.call("claude_review_followup", args);
    check("C2", `followup refused: ${Object.keys(args).filter((k) => !["message", "repoPath"].includes(k)).join("/")}`, r.result?.isError === true && re.test(textOf(r)), textOf(r).slice(0, 80));
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

/* --- P1-7: a malformed HOST ANTHROPIC_BASE_URL must not crash the env tool --- */
{
  // A host environment can carry a half-typed gateway URL while settings.json
  // holds the real one (CC Switch / claude-code-router rewrite both). The env
  // tool compared process.env's raw base URL with new URL() unguarded, so the
  // whole diagnostic threw an internal error once any auth residue existed
  // (audit P1-7). A throwaway HOME keeps the developer's own ~/.claude out of it.
  const home = fs.mkdtempSync(path.join(tmp, "c3url-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" } }));
  const s = startServer({
    CLAUDE_CODE_PATH: STUB, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_BASE_URL: "http://[::1",           // malformed on purpose
    ANTHROPIC_API_KEY: "sk-ant-c3-url-not-real", // forces the residue branch
  });
  await s.ready;
  const r = await s.call("claude_review_env", {});
  const t = textOf(r);
  check("C3", "malformed host ANTHROPIC_BASE_URL yields a verdict, not an internal error (P1-7)",
    r.result?.isError !== true && !r.error && /verdict:/.test(t) && /not a parseable URL/.test(t),
    (r.error ? JSON.stringify(r.error) : t.slice(0, 240)));
  s.kill();
}

/* ================= C4 installer ================= */
{
  // init.mjs copies the effective ANTHROPIC_* credentials into the config it
  // writes (init.mjs:149-152). This suite runs against a throwaway HOME, so
  // inheriting the host env would park a LIVE token in $TMPDIR (audit P1-5).
  // Strip the real values and pass a recognizable test token instead; cleanup
  // removes the tree, and the first check proves only the test value was used.
  const TEST_TOKEN = `sk-ant-test-${process.pid}-${Date.now()}`;
  const hostAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const hostApiKey = process.env.ANTHROPIC_API_KEY;
  const authFreeEnv = () => {
    const env = { ...process.env };
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) delete env[k];
    return env;
  };
  const runInit = (home, pre, extraEnv = {}) => {
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    if (pre) fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), pre);
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "init.mjs")], {
      env: {
        ...authFreeEnv(), USERPROFILE: home, HOME: home, CLAUDE_CODE_PATH: STUB,
        // A non-loopback fake gateway makes init exercise the credential-carry
        // branch without a TCP probe; the token is the suite's, never the host's.
        ANTHROPIC_BASE_URL: "https://gateway.invalid",
        ANTHROPIC_AUTH_TOKEN: TEST_TOKEN,
        ...extraEnv,
      },
      encoding: "utf8", timeout: 120_000, windowsHide: true,
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const h1 = fs.mkdtempSync(path.join(tmp, "c4a-"));
  const r1 = runInit(h1);
  const cfg1 = JSON.parse(fs.readFileSync(path.join(h1, ".zcode", "cli", "config.json"), "utf8"));
  const e1 = cfg1.mcp?.servers?.["cc-code-review"];
  check("C4", "fresh install: entry created with machine-derived paths + timeoutMs", r1.code === 0 && e1?.command === process.execPath && e1?.args?.[0]?.split(path.sep).join("/").endsWith("src/index.js") && e1?.timeoutMs === 1_800_000, r1.out.slice(0, 200) + JSON.stringify(e1));
  check("C4", "fresh install carries the test credential, never the host's",
    e1?.env?.ANTHROPIC_AUTH_TOKEN === TEST_TOKEN
    && (!hostAuthToken || e1.env.ANTHROPIC_AUTH_TOKEN !== hostAuthToken)
    && (!hostApiKey || e1.env.ANTHROPIC_API_KEY !== hostApiKey),
    JSON.stringify(e1?.env || null));
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
  // re-init with a gateway in play: derived env keys are stamped, but keys the
  // user added by hand must survive (they used to be silently dropped).
  const h4 = fs.mkdtempSync(path.join(tmp, "c4d-"));
  const pre4 = JSON.stringify({ mcp: { servers: { "cc-code-review": {
    command: "old", args: ["old"], timeoutMs: 60000,
    env: { HTTP_PROXY: "http://proxy:8080", DISABLE_TELEMETRY: "1", ANTHROPIC_API_KEY: "user-key" },
  } } } });
  const r4 = runInit(h4, pre4, { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "gw-token" });
  const e4 = JSON.parse(fs.readFileSync(path.join(h4, ".zcode", "cli", "config.json"), "utf8")).mcp.servers["cc-code-review"];
  check("C4", "re-init keeps user-added env keys; derived gateway keys win; timeout preserved",
    r4.code === 0 && e4?.env?.HTTP_PROXY === "http://proxy:8080" && e4?.env?.DISABLE_TELEMETRY === "1"
    && e4?.env?.ANTHROPIC_BASE_URL === "http://127.0.0.1:15721" && e4?.env?.ANTHROPIC_AUTH_TOKEN === "gw-token"
    && e4?.env?.ANTHROPIC_API_KEY === "user-key" && e4?.timeoutMs === 60000,
    JSON.stringify(e4));
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
    // Honest skip: a green check that asserted nothing is worse than a visible
    // skip, because it hides a fixture that silently stopped exercising the path.
    skip("C5", `worktree fixture unavailable (${String(e?.message).slice(0, 120)})`);
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
  check("C6", "chained Bash with an unlisted program denied", verdict({ tool_name: "Bash", tool_input: { command: "git status; curl x" } }) === "deny");
  check("C6", "git --output= denied", verdict({ tool_name: "Bash", tool_input: { command: "git diff HEAD --output=/tmp/x" } }) === "deny");
  check("C6", "clean Bash allowed",
    verdict({ tool_name: "Bash", tool_input: { command: "git status" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === null);
  // Segment-level policy: a chain of permitted reads runs, a `cd` that lands on
  // the reviewed root is a no-op, and everything else still stops.
  check("C6", "a chain of permitted reads is allowed",
    verdict({ tool_name: "Bash", tool_input: { command: "git status && git diff --stat" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === null);
  check("C6", "cd to the reviewed root + git show is allowed",
    verdict({ tool_name: "Bash", tool_input: { command: `cd "${repo}" && git show HEAD` } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === null);
  check("C6", "a pipe into a read-only sink is allowed",
    verdict({ tool_name: "Bash", tool_input: { command: "git show HEAD:a.txt | head -5" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === null);
  check("C6", "cd outside the reviewed root is denied",
    verdict({ tool_name: "Bash", tool_input: { command: "cd / && git status" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  check("C6", "a permitted chain with one bad segment is denied",
    verdict({ tool_name: "Bash", tool_input: { command: "git status && cat /etc/passwd" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  // Path scoping: a read inside the repo passes, the same read outside is refused.
  check("C6", "rg inside the repo allowed",
    verdict({ tool_name: "Bash", tool_input: { command: "rg -n x ." } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === null);
  check("C6", "rg outside the repo denied",
    verdict({ tool_name: "Bash", tool_input: { command: "rg -n x ~/.ssh" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  check("C6", "find outside the repo denied",
    verdict({ tool_name: "Bash", tool_input: { command: "find / -name id_rsa" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  check("C6", "sink reading an outside file denied",
    verdict({ tool_name: "Bash", tool_input: { command: "git show HEAD:a.txt | cat /etc/passwd" } }, { CLAUDE_REVIEW_REPO_ROOT: repo }) === "deny");
  check("C6", "Bash without a repo root fails closed",
    verdict({ tool_name: "Bash", tool_input: { command: "git status" } }) === "deny");
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
  // The predicate must BE the check: passing the array as `cond` made this
  // assertion true for any input, even a shadowed allow rule (audit P1-3).
  const shadowedRules = allowed.filter(shadowed);
  check("C7", "no allow rule prefix-shadowed by deny", shadowedRules.length === 0, JSON.stringify(shadowedRules));
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
  // Per-run pidfile path (the stub honours STUB_PID_FILE): parallel CI jobs
  // sharing one tmpdir must not read — or delete — each other's stub pid.
  const pidFile = path.join(tmp, `stub-claude-c8-${process.pid}-${Date.now()}.pid`);
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_PID_FILE: pidFile });
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
  // cancel path + process-tree kill. The stub writes its pid to the per-run
  // STUB_PID_FILE; wait for it to APPEAR first — reading a missing file used to
  // pass vacuously.
  fs.rmSync(pidFile, { force: true });
  const r3 = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit" });
  const j3 = r3.result?.structuredContent?.jobId;
  let stubPid = null;
  for (let i = 0; i < 20 && stubPid === null; i++) {
    await new Promise((res) => setTimeout(res, 250));
    try { stubPid = Number(fs.readFileSync(pidFile, "utf8")); } catch { /* not yet */ }
  }
  check("C8", "stub claude reached its pidfile (no vacuous pass)", Number.isInteger(stubPid) && stubPid > 0, `pid=${stubPid}`);
  const c1 = await s.call("claude_review_status", { jobId: j3, cancel: true });
  check("C8", "cancel accepted", /cancel/i.test(textOf(c1)));
  await new Promise((res) => setTimeout(res, 3500));
  const c2 = await s.call("claude_review_status", { jobId: j3 });
  check("C8", "cancelled job settles (done, error result)", c2.result?.structuredContent?.status !== "running" && (c2.result?.isError === true || /STUB-REPORT-OK/.test(textOf(c2))), textOf(c2).slice(0, 150));
  let pidGone = false;
  if (Number.isInteger(stubPid)) {
    try { process.kill(stubPid, 0); pidGone = false; } catch { pidGone = true; }
  }
  check("C8", "stub claude process actually killed", pidGone && Number.isInteger(stubPid));
  fs.rmSync(pidFile, { force: true });
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
  // The stub is not optional here: without a resolvable CLI the run refuses with
  // "Claude Code CLI not found" BEFORE the guard check, so the assertion would
  // pass on a dev machine (which has claude) and fail on a clean CI runner. This
  // suite is hermetic by contract — pin the CLI for every server it starts.
  const s1 = startServer({ CLAUDE_REVIEW_SHELL_GUARD: "0", CLAUDE_CODE_PATH: STUB });
  await s1.ready;
  const r1 = await s1.call("claude_code_review", { repoPath: mkRepo("c10"), scope: "auto" });
  check("C10", "guard off -> review refused (fail closed)", r1.result?.isError === true && /unguarded/i.test(textOf(r1)), textOf(r1).slice(0, 120));
  s1.kill();
  const s2 = startServer({ CLAUDE_CODE_PATH: STUB, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CONFIG_DIR: path.join(tmp, "c10-empty-config") });
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

/* ================= C11 reviewer reports + model provenance (stub) ================= */
{
  // The stub emits what a claude 2.1.x headless run really emits: five Agent
  // dispatches, each subagent's own messages (tagged with the model it ran on)
  // and its final report, plus the [claude-code:unrecognized_model] stderr
  // line a gateway/settings rewrite produces. The MCP must surface both the
  // reports (the "complete output" gap vs interactive Claude Code) and the
  // model substitution (why that output is not comparable).
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c11"), scope: "last-commit", waitForResult: true });
  const text = textOf(r);
  const sc = r.result?.structuredContent || {};
  check("C11", "reviewer subagent reports are surfaced in the text", /## Reviewer subagent reports \(5 dispatched\)/.test(text), text.slice(0, 200));
  for (let i = 1; i <= 5; i++) {
    check("C11", `subagent report #${i} reaches the caller`, text.includes(`STUB-SUBAGENT-REPORT-${i}`), text.slice(0, 200));
  }
  check("C11", "structuredContent carries the subagent reports",
    Array.isArray(sc.subagents) && sc.subagents.length === 5 && sc.subagents.every((a) => /STUB-SUBAGENT-REPORT-\d/.test(a.report || "")),
    JSON.stringify(sc.subagents || []).slice(0, 200));
  check("C11", "async subagent completion is marked (and its status kept)",
    sc.subagents?.[0]?.async === true && sc.subagents?.[0]?.status === "completed" && sc.subagents?.[2]?.status === "stopped",
    JSON.stringify((sc.subagents || []).map((a) => [a.async, a.status])));
  check("C11", "a stopped subagent is visible in the text, not silent",
    /async, stopped/.test(text), text.slice(0, 300));
  check("C11", "model substitution is flagged in the text", /MODEL SUBSTITUTION/.test(text) && /MiniMax-M3\.1-Flash/.test(text), text.slice(0, 300));
  check("C11", "structuredContent records the provenance",
    sc.modelProvenance?.substituted === true && sc.modelProvenance.subagents.includes("MiniMax-M3.1-Flash"),
    JSON.stringify(sc.modelProvenance || {}));
  check("C11", "effective model appears in the metadata", /effective_model:/.test(text), text.slice(0, 300));
  // The result event's own accounting (claude 2.1.x): modelUsage is the
  // authoritative per-model list, subagent_stats the spawn outcome counts.
  check("C11", "modelUsage is surfaced",
    !!sc.modelUsage && Object.keys(sc.modelUsage).length >= 2 && Object.keys(sc.modelUsage).includes("MiniMax-M3.1-Flash"),
    JSON.stringify(sc.modelUsage || {}).slice(0, 200));
  check("C11", "subagent stats are surfaced",
    sc.subagentStats?.completed === 4 && sc.subagentStats?.killed?.system === 1 && sc.subagentStats?.started_in_background === 5,
    JSON.stringify(sc.subagentStats || {}).slice(0, 200));
  check("C11", "billed models reach the provenance", Array.isArray(sc.modelProvenance?.billed) && sc.modelProvenance.billed.includes("MiniMax-M3.1-Flash"),
    JSON.stringify(sc.modelProvenance || {}).slice(0, 200));
  s.kill();
}

/* ================= C13 a failed run keeps the subagent reports ================= */
{
  // A budget cap stops the parent AFTER the subagents finished. The error
  // result must still carry the reports, the provenance and the accounting —
  // the audit that found this lost four completed reports to the old error path.
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_RESULT_SUBTYPE: "error_max_budget_usd" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c13"), scope: "last-commit", waitForResult: true });
  const text = textOf(r);
  const sc = r.result?.structuredContent || {};
  check("C13", "the run is reported as an error", r.result?.isError === true && /REVIEW FAILED/.test(text), text.slice(0, 160));
  check("C13", "the failure banner names the budget cap", /max-budget-usd|budget/i.test(text), text.slice(0, 300));
  check("C13", "subagent reports survive the error path", /## Reviewer subagent reports \(5 dispatched\)/.test(text) && [1, 2, 3, 4, 5].every((i) => text.includes(`STUB-SUBAGENT-REPORT-${i}`)), text.slice(0, 300));
  check("C13", "structuredContent keeps the reports on error",
    Array.isArray(sc.subagents) && sc.subagents.length === 5 && sc.subagents.every((a) => /STUB-SUBAGENT-REPORT-\d/.test(a.report || "")),
    JSON.stringify(sc.subagents || []).slice(0, 200));
  check("C13", "provenance survives the error path", sc.modelProvenance?.substituted === true, JSON.stringify(sc.modelProvenance || {}).slice(0, 200));
  check("C13", "accounting survives the error path", !!sc.modelUsage && sc.subagentStats?.completed === 4, JSON.stringify({ modelUsage: sc.modelUsage, stats: sc.subagentStats }).slice(0, 300));
  check("C13", "the error-path TEXT carries the run metadata lines", /- review_level: max/.test(text) && /- ultracode:/.test(text) === false && /_run metadata_/.test(text), text.slice(0, 400));
  s.kill();
}

/* ================= C14 ultracode reaches the CLI, workflow runs are counted ================= */
{
  // Ultracode is claude's native standing dynamic-workflow orchestration,
  // enabled per session through the `ultracode` settings key. The MCP passes it
  // in the same --settings file as the guard hooks, and a Workflow dispatch in
  // the stream is the direct evidence the orchestration actually ran.
  const echo = path.join(tmp, `stub-settings-c14-${process.pid}.json`);
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_ECHO_SETTINGS: echo, STUB_EMIT_WORKFLOW: "1" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c14"), scope: "last-commit", ultracode: true, waitForResult: true });
  const sc = r.result?.structuredContent || {};
  const text = textOf(r);
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(echo, "utf8")); } catch { /* missing */ }
  check("C14", "ultracode is passed to the CLI via --settings", settings?.ultracode === true, JSON.stringify(settings || null).slice(0, 200));
  check("C14", "the guard hooks ride in the same settings file", Array.isArray(settings?.hooks?.PreToolUse), JSON.stringify(settings || null).slice(0, 200));
  check("C14", "structuredContent reports ultracode", sc.ultracode === true, JSON.stringify(sc).slice(0, 200));
  check("C14", "workflow dispatches are counted", sc.workflowRuns === 1, `workflowRuns=${sc.workflowRuns}`);
  check("C14", "the metadata marks ultracode and workflow runs", /ultracode: on/.test(text) && /workflow_runs: 1/.test(text), text.slice(0, 300));
  // review_level defaults from effort (high here) and reaches the metadata.
  check("C14", "review_level defaults from effort (now max) and is reported", sc.reviewLevel === "max" && /- review_level: max/.test(text), text.slice(0, 400));
  s.kill();
}

/* ================= C12 pre-run refusals do not leak the guard file ================= */
{
  // prepareRunHardening marks the guard settings file in-flight before the
  // repo/gateway/gh preflight. Every refusal in that window used to return
  // without releasing the mark, so cleanupGuardSettings() skipped the file and
  // it survived for the life of the process (audit finding, fixed in 1.10.1).
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const dir = path.join(os.tmpdir(), "cc-code-review");
  const ours = () => {
    try { return fs.readdirSync(dir).filter((f) => f.startsWith(`guard-settings-${s.child.pid}-`)); } catch { return []; }
  };
  const before = ours().length;
  // mkRepo() is a plain directory, not a git repo -> refusal AFTER the guard
  // file was written (exactly the leaking window).
  const r = await s.call("claude_code_review", { repoPath: mkRepo("c12"), scope: "auto" });
  check("C12", "refusal happens after the guard file was written", r.result?.isError === true && /git failed|version-controlled|Nothing to review/.test(textOf(r)), textOf(r).slice(0, 160));
  await s.call("claude_review_env", {}); // runs cleanupGuardSettings()
  const after = ours().length;
  check("C12", "a pre-run refusal does not leak the guard settings file", after <= before, `before=${before} after=${after} [${ours().join(",")}]`);
  s.kill();
}

/* ================= C15 defaults: effort=max, NO spend cap ================= */
{
  // effort defaults to max (deepest review) and no spend cap is set at any
  // level: a cap stopped the parent before it synthesized, and with incremental
  // capture a 429 no longer wastes the finished work. The wall-clock timeout is
  // the guard. The stub echoes its argv so this is exact.
  const echoArgs = path.join(tmp, `stub-argv-c15-${process.pid}.json`);
  const echoArgs2 = path.join(tmp, `stub-argv-c15b-${process.pid}.json`);
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_ECHO_ARGS: echoArgs });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c15"), scope: "last-commit", waitForResult: true });
  let argv = [];
  try { argv = JSON.parse(fs.readFileSync(echoArgs, "utf8")); } catch { /* missing */ }
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  check("C15", "effort defaults to max and is passed as --effort", flag("--effort"), "max");
  check("C15", "no spend cap is passed by default (--max-budget-usd absent)", !argv.includes("--max-budget-usd"), JSON.stringify(argv.slice(0, 12)));
  check("C15", "an explicit cap is still honoured", await (async () => {
    const s2 = startServer({ CLAUDE_CODE_PATH: STUB, STUB_ECHO_ARGS: echoArgs2 });
    await s2.ready;
    await s2.call("claude_code_review", { repoPath: gitRepo("c15b"), scope: "last-commit", maxBudgetUsd: 12, waitForResult: true });
    let a2 = [];
    try { a2 = JSON.parse(fs.readFileSync(echoArgs2, "utf8")); } catch { /* missing */ }
    const i = a2.indexOf("--max-budget-usd");
    s2.kill();
    return i >= 0 ? a2[i + 1] : undefined;
  })(), "12");
  const sc = r.result?.structuredContent || {};
  check("C15", "the result reports the max review level", sc.reviewLevel === "max", JSON.stringify(sc.reviewLevel));
  s.kill();
}

/* ================= C16 subagent reports land incrementally ================= */
{
  // The native skill does not report until the WHOLE fleet finishes; a 429 /
  // halt / cancel can stop it before then. Each finished subagent must be
  // visible while the run continues (job polling) and durable on disk (JSONL).
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_SUBAGENT_DELAY_MS: "2500" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c16"), scope: "last-commit" });
  const jobId = r.result?.structuredContent?.jobId;
  const p1 = await s.call("claude_review_status", { jobId });
  const early = p1.result?.structuredContent?.subagentsSoFar ?? [];
  check("C16", "a running job still reports elapsed time", p1.result?.structuredContent?.status === "running" && typeof p1.result.structuredContent.elapsedSec === "number", textOf(p1).slice(0, 120));
  await new Promise((res) => setTimeout(res, 6000));
  const p2 = await s.call("claude_review_status", { jobId });
  const mid = p2.result?.structuredContent?.subagentsSoFar ?? [];
  const midRunning = p2.result?.structuredContent?.status === "running";
  check("C16", "finished subagents are visible while the run continues", mid.length > early.length && mid.length >= 1, `early=${early.length} mid=${mid.length}`);
  check("C16", "the running-poll text lists them", textOf(p2).includes("reviewer subagent report(s) already finished"), textOf(p2).slice(0, 200));
  // Durability, not just visibility: the JSONL must already hold exactly the
  // reports the poll shows while the run is still going. The old check only
  // counted lines at the end, which a single write at shutdown would also pass.
  const midFile = p2.result?.structuredContent?.subagentsFile;
  let midLines = -1;
  try { midLines = fs.readFileSync(midFile, "utf8").trim().split(String.fromCharCode(10)).length; } catch { /* missing */ }
  check("C16", "the JSONL file already holds the finished reports mid-run",
    midRunning && typeof midFile === "string" && midLines === mid.length && midLines >= 1,
    `running=${midRunning} file=${midFile} lines=${midLines} visible=${mid.length}`);
  check("C16", "the running poll names the JSONL path in its text",
    textOf(p2).includes("partial reports file"), textOf(p2).slice(0, 300));
  await new Promise((res) => setTimeout(res, 5000));
  const p3 = await s.call("claude_review_status", { jobId });
  const late = p3.result?.structuredContent?.subagentsSoFar ?? [];
  check("C16", "the visible set only grows", late.length >= mid.length, `mid=${mid.length} late=${late.length}`);
  let final = null;
  for (let i = 0; i < 25 && !final; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const p = await s.call("claude_review_status", { jobId });
    if (p.result?.structuredContent?.status !== "running") final = p.result;
  }
  check("C16", "the final result carries all five reports", (final?.structuredContent?.subagents || []).length === 5, JSON.stringify((final?.structuredContent?.subagents || []).length));
  const file = final?.structuredContent?.subagentsFile;
  let lines = 0;
  try { lines = fs.readFileSync(file, "utf8").trim().split(String.fromCharCode(10)).length; } catch { /* missing */ }
  check("C16", "each finished subagent was appended to the JSONL file as it landed", typeof file === "string" && lines === 5, `file=${file} lines=${lines}`);
  s.kill();
}

/* ================= C17 an agent killed mid-flight is recovered from its transcript ================= */
{
  // A 429 can kill a subagent after it did its work but before its
  // task_notification: only the launch ack's output_file survives. The report
  // must be recovered from that transcript instead of the tokens being wasted.
  // The recovery path is gated to the CLI's own transcript area
  // (<tmp>/claude*/…/tasks/*.output) — the fixture has to live there too.
  fs.mkdirSync(path.join(tmp, "claude", "c17", "tasks"), { recursive: true });
  const transcript = path.join(tmp, "claude", "c17", "tasks", `lost-agent-c17-${process.pid}.output`);
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_LOST_AGENT_OUTPUT_FILE: transcript });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c17"), scope: "last-commit", waitForResult: true });
  const sc = r.result?.structuredContent || {};
  const first = (sc.subagents || []).find((a) => a.recovery === "output_file") || {};
  check("C17", "the killed agent is still reported", (sc.subagents || []).length === 5, JSON.stringify((sc.subagents || []).length));
  check("C17", "its work is recovered from the output_file transcript",
    first.partial === true && first.recovery === "output_file" && /partial findings recovered from the transcript/.test(first.report || ""),
    JSON.stringify(first).slice(0, 200));
  check("C17", "the text marks it as recovered", textOf(r).includes("partial (output_file)"), textOf(r).slice(0, 300));
  s.kill();
}

/* ================= C18 a misread launch ack never outranks the notification ================= */
{
  // Older CLI shapes can return an async launch ack that neither detector
  // recognises. Filing that text as the report would suppress the real report
  // that arrives moments later in the task_notification — the notification is
  // authoritative for its dispatch, so the record must be corrected.
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_ACK_MISREAD_IDS: "2" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c18"), scope: "last-commit", waitForResult: true });
  const sc = r.result?.structuredContent || {};
  const subs = sc.subagents || [];
  const second = subs.find((a) => /#2\b/.test(a.description || "")) || {};
  check("C18", "the ack text is not the final report", !/dispatched; the report will follow/.test(String(second.report || "")), JSON.stringify(second).slice(0, 200));
  check("C18", "the task_notification's report wins", /STUB-SUBAGENT-REPORT-2/.test(String(second.report || "")), JSON.stringify(second).slice(0, 200));
  check("C18", "the fleet size is unchanged by the correction", subs.length === 5, JSON.stringify(subs.length));
  let lines = 0;
  try { lines = fs.readFileSync(sc.subagentsFile, "utf8").trim().split(String.fromCharCode(10)).length; } catch { /* missing */ }
  check("C18", "the correction is appended to the JSONL journal", lines === 6, `lines=${lines} file=${sc.subagentsFile}`);
  s.kill();
}

/* ================= C19 a cancelled run keeps the finished reports ================= */
{
  // Cancelling used to return a bare error: every report the fleet had already
  // produced became unreachable, although the tokens were paid for. The
  // interrupted path must carry the incremental records and the JSONL path.
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_SUBAGENT_DELAY_MS: "1500" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c19"), scope: "last-commit" });
  const jobId = r.result?.structuredContent?.jobId;
  let seen = 0;
  for (let i = 0; i < 25 && seen === 0; i++) {
    await new Promise((res) => setTimeout(res, 400));
    const p = await s.call("claude_review_status", { jobId });
    seen = (p.result?.structuredContent?.subagentsSoFar || []).length;
  }
  const c = await s.call("claude_review_status", { jobId, cancel: true });
  check("C19", "cancel accepted after the fleet started", /cancel/i.test(textOf(c)));
  let final = null;
  for (let i = 0; i < 25 && !final; i++) {
    await new Promise((res) => setTimeout(res, 400));
    const p = await s.call("claude_review_status", { jobId });
    if (p.result?.structuredContent?.status !== "running") final = p.result;
  }
  const sc = final?.structuredContent || {};
  check("C19", "at least one subagent finished before the cancel", seen >= 1, `seen=${seen}`);
  check("C19", "the cancelled result is an error flagged cancelled", final?.isError === true && sc.status === "cancelled", JSON.stringify(sc.status));
  check("C19", "the finished reports survive the cancel", (sc.subagents || []).length >= 1, JSON.stringify((sc.subagents || []).length));
  check("C19", "the result names the partial-reports JSONL", typeof sc.subagentsFile === "string", JSON.stringify(sc.subagentsFile));
  // `final` is already the tool result (p.result), so read its content directly.
  const finalText = final?.content?.[0]?.text || "";
  check("C19", "the text still shows the reports", /## Reviewer subagent reports/.test(finalText), finalText.slice(0, 200));
  s.kill();
}

/* ================= C21 pipeline selection: native by default, nothing installed ================= */
{
  // The user-visible contract: a review never has to write into ~/.claude.
  //   auto + low..xhigh -> claude's built-in /code-review command
  //   auto + max        -> the fleet pipeline, carried in the prompt
  //   explicit          -> either, plus legacy "skill"
  const promptOf = (name) => path.join(tmp, `prompt-${name}-${process.pid}.txt`);

  // Point the skill lookup at a throwaway dir so the result does not depend on
  // whatever is installed in the developer's own ~/.claude.
  const emptySkills = path.join(tmp, "c21-skills-empty");
  fs.mkdirSync(emptySkills, { recursive: true });
  const shadowSkills = path.join(tmp, "c21-skills-shadow");
  fs.mkdirSync(shadowSkills, { recursive: true });
  fs.writeFileSync(path.join(shadowSkills, "SKILL.md"), "---\nname: code-review\n---\nold\n");
  fs.writeFileSync(path.join(shadowSkills, "installed-by-cc-code-review"), "t\n");

  const runCase = async (extra, env = {}, repoFactory = gitRepo2) => {
    const file = promptOf("case" + Math.random().toString(36).slice(2, 7));
    const argsFile = promptOf("argv" + Math.random().toString(36).slice(2, 7));
    const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_ECHO_PROMPT: file, STUB_ECHO_ARGS: argsFile, CLAUDE_REVIEW_SKILL_DIR: emptySkills, ...env });
    await s.ready;
    const r = await s.call("claude_code_review", { repoPath: repoFactory("c21" + Math.random().toString(36).slice(2, 6)), scope: "last-commit", waitForResult: true, ...extra });
    let prompt = ""; let argv = [];
    try { prompt = fs.readFileSync(file, "utf8"); } catch { /* missing */ }
    try { argv = JSON.parse(fs.readFileSync(argsFile, "utf8")); } catch { /* missing */ }
    const sc = r.result?.structuredContent || {};
    s.kill();
    return { prompt, argv, pipeline: sc.pipeline || sc.skillMode || "", text: textOf(r) };
  };

  const native = await runCase({ effort: "low" });
  check("C21", "auto + low runs the built-in /code-review", /^\/code-review low/.test(native.prompt), native.prompt.slice(0, 80));
  check("C21", "the native run reports the pipeline", /native/.test(native.pipeline), native.pipeline);
  // 1.16.0's "slash commands travel in argv" claim needs a locking assertion:
  // the command must appear in argv right after -p (promptViaArgv), stdin must
  // not carry it.
  const pIdx = native.argv.indexOf("-p");
  check("C21", "the native command is passed in argv (after -p)",
    pIdx >= 0 && native.argv[pIdx + 1] === native.prompt.trim(), JSON.stringify(native.argv.slice(0, 4)));

  const nativeTarget = await runCase({ effort: "medium", reviewLevel: "high" });
  check("C21", "the native command carries the review level", /^\/code-review high/.test(nativeTarget.prompt), nativeTarget.prompt.slice(0, 80));

  const maxAuto = await runCase({ effort: "max" });
  check("C21", "auto + max uses the fleet pipeline, not the native command", !/^\/code-review\b/.test(maxAuto.prompt), maxAuto.prompt.slice(0, 80));
  check("C21", "the fleet prompt carries the pipeline inline (no skill needed)", /## Pipeline \(bundled with this MCP/.test(maxAuto.prompt), maxAuto.prompt.slice(0, 120));
  check("C21", "the fleet prompt carries the native three-phase structure",
    /PHASE 1 .*dispatch ALL 10 finder subagents in ONE message/.test(maxAuto.prompt) && /ONE verifier subagent per surviving candidate/.test(maxAuto.prompt),
    maxAuto.prompt.slice(0, 160));
  check("C21", "the fleet prompt does not ask for the skill tool", !/Use the `code-review` skill/.test(maxAuto.prompt));

  const forcedNative = await runCase({ effort: "max", pipeline: "native" });
  check("C21", "pipeline=native overrides the auto rule", /^\/code-review max/.test(forcedNative.prompt), forcedNative.prompt.slice(0, 80));

  const forcedFleet = await runCase({ effort: "low", pipeline: "fleet" });
  check("C21", "pipeline=fleet overrides the auto rule", !/^\/code-review\b/.test(forcedFleet.prompt) && /## Pipeline \(bundled/.test(forcedFleet.prompt), forcedFleet.prompt.slice(0, 80));

  // Fix rides the built-in command's own --fix flag (verified in the binary).
  const fixAuto = await runCase({ effort: "low", fix: true });
  check("C21", "fix mode rides the native command's --fix flag",
    /^\/code-review low HEAD~1 --fix$/.test(fixAuto.prompt.trim()), fixAuto.prompt.slice(0, 140));
  check("C21", "the native fix run does not forbid edits in the appendix", !/Do not modify any file/.test(fixAuto.prompt), fixAuto.prompt.slice(0, 140));

  // A same-named skill shadows the built-in command, so auto must not claim
  // "native" while the skill would answer — and pipeline=native must refuse.
  const shadowed = await runCase({ effort: "low" }, { CLAUDE_REVIEW_SKILL_DIR: shadowSkills });
  check("C21", "a shadowing skill switches auto to the fleet pipeline", !/^\/code-review\b/.test(shadowed.prompt), shadowed.prompt.slice(0, 80));
  check("C21", "the result explains the shadow", /shadow/i.test(shadowed.text), shadowed.text.slice(0, 200));
  const forced = await runCase({ effort: "low", pipeline: "native" }, { CLAUDE_REVIEW_SKILL_DIR: shadowSkills });
  check("C21", "pipeline=native refuses to run behind a shadowing skill", /cannot be honoured/i.test(forced.text), forced.text.slice(0, 200));

  // scope=auto with a pr must forward the pr as the native target (audit: the
  // tool advertises "auto: PR if pr given" — the old code silently dropped it).
  const autoPr = await runCase({ effort: "medium", pr: "123", scope: "auto" });
  check("C21", "scope=auto forwards pr as the native target", /^\/code-review medium 123/.test(autoPr.prompt.trim()), autoPr.prompt.slice(0, 100));

  // Root-commit repo (single empty commit): no HEAD~1 exists — fleet, not native.
  const rootCommit = await runCase({ effort: "medium" }, {}, gitRepo);
  check("C21", "root-commit last-commit switches auto to the fleet pipeline", !/^\/code-review\b/.test(rootCommit.prompt), rootCommit.prompt.slice(0, 90));
  check("C21", "the result explains the missing parent commit", /no parent commit/i.test(rootCommit.text), rootCommit.text.slice(0, 220));
}

/* ================= C20 a Monitor task is not a reviewer subagent ================= */
{
  // Observed live (paid smoke, 2.1.311): the CLI runs a `Monitor` background
  // task alongside the fleet and emits a task_notification for it. Recorded as
  // a reviewer it looked like a sixth subagent whose "report" was
  // `Monitor "…" stream ended` — while claude's own subagent_stats said 2.
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_EMIT_MONITOR: "1" });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c20"), scope: "last-commit", waitForResult: true });
  const subs = r.result?.structuredContent?.subagents || [];
  check("C20", "the Monitor task is not counted as a reviewer", subs.length === 5, JSON.stringify(subs.length));
  check("C20", "no reviewer report is the Monitor notice",
    subs.every((a) => !/stream ended/.test(String(a.report || ""))), JSON.stringify(subs.map((a) => a.description)));
  check("C20", "every reviewer record is a real dispatch",
    subs.every((a) => a.subagentType === "general-purpose"), JSON.stringify(subs.map((a) => a.subagentType)));
  s.kill();
}

/* ================= C22 CLI dies without a result ================= */
{
  // P2-7: the shipped stub always exits 0, so claude.js's "non-zero exit and no
  // result JSON" branch (and the failure banner built from it) had no coverage.
  // A disposable CLI in this run's tmp tree keeps the stub untouched and dies
  // exactly where a real CLI does (auth failure, crash, killed wrapper).
  const crashCli = path.join(tmp, `crash-claude-${process.pid}.mjs`);
  fs.writeFileSync(crashCli, [
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }',
    'if (args.includes("--help")) { console.log("Usage: claude [options]"); process.exit(0); }',
    'console.error("simulated claude crash");',
    'process.exit(7);',
  ].join("\n") + "\n");
  const s = startServer({ CLAUDE_CODE_PATH: crashCli });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c22"), scope: "last-commit", waitForResult: true });
  const t = textOf(r);
  check("C22", "a non-zero CLI exit is a failed review", r.result?.isError === true, t.slice(0, 200));
  check("C22", "the failure names the exit code and the missing result",
    /exited \(code 7\)/.test(t) && /without a parseable result/i.test(t), t.slice(0, 300));
  s.kill();
}

/* ================= C23 a CLI killed by a signal after reporting ================= */
{
  // P2-7: the shipped stub always exits 0, so the crash/signal branches in
  // claude.js had no coverage. This disposable CLI (same pattern as C22) emits a
  // valid stream-json result and then SIGTERMs itself: the process did not finish
  // cleanly, and a wrapper/Gatekeeper/AV kill can truncate a run after a partial
  // report. Presenting that as a successful review is how a caller concludes
  // "clean" from a run that never completed. Assertions stay platform-generic —
  // the darwin Gatekeeper wording is environment-specific and must not be pinned.
  const sigCli = path.join(tmp, `signal-claude-${process.pid}.mjs`);
  fs.writeFileSync(sigCli, [
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }',
    // String.fromCharCode(10), not "\\n": this line is itself inside a JS string,
    // and a single \\n would be turned into a REAL newline in the generated CLI,
    // making it a syntax error that exits before printing anything (a fake pass).
    'if (args.includes("--help")) { console.log(["Usage: claude [options]","  -p, --print","  --effort <level>","  --max-budget-usd <n>","  --permission-mode <mode>","  --permission-prompts <policy>","  --output-format <fmt>  (json, stream-json)","  --settings <file>","  --verbose"].join(String.fromCharCode(10))); process.exit(0); }',
    'process.stdin.resume();',
    'setTimeout(() => {',
    '  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "C23-STUB-REPORT", session_id: "signal-stub", num_turns: 1, total_cost_usd: 0, duration_ms: 10, permission_denials: [] }));',
    // Long enough that the parent has certainly read and parsed the result line:
    // this test is about the SIGNAL being honored, not about a stdout race.
    '  setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000);',
    '}, 300);',
  ].join("\n") + "\n");
  const s = startServer({ CLAUDE_CODE_PATH: sigCli });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c23"), scope: "last-commit", waitForResult: true });
  const t = textOf(r);
  check("C23", "a run killed by a signal is a failed review, not a clean report", r.result?.isError === true, t.slice(0, 300));
  check("C23", "the failure names the signal/exit (no Gatekeeper-specific wording)",
    /(SIGTERM|SIGKILL|killed by|signal|exited \(code)/i.test(t), t.slice(0, 300));
  // Proves the CLI really emitted a valid result BEFORE dying: without this a
  // broken fixture (e.g. a syntax error) would also "fail the review" and the
  // case would pass while testing nothing (the failure mode this round hit).
  check("C23", "the valid report is preserved alongside the failure",
    /C23-STUB-REPORT/.test(t), t.slice(0, 300));
  s.kill();
}

/* ================= C24 an unwritable log directory is a tool error ================= */
{
  // P2-12: logsDir() is a synchronous fs call. On the waitForResult path a bad
  // CLAUDE_REVIEW_LOG_DIR used to escape the tool handler as a raw ENOTDIR /
  // EACCES, before any paid work. A regular file is the portable way to make
  // mkdirSync fail on Windows, macOS and Linux without depending on mode bits.
  const bad = path.join(tmp, `c24-logdir-file-${process.pid}`);
  fs.writeFileSync(bad, "not a directory");
  const s = startServer({ CLAUDE_CODE_PATH: STUB, CLAUDE_REVIEW_LOG_DIR: bad });
  await s.ready;
  const r = await s.call("claude_code_review", { repoPath: gitRepo("c24"), scope: "last-commit", waitForResult: true });
  const t = textOf(r);
  check("C24", "bad CLAUDE_REVIEW_LOG_DIR is an actionable tool error (P2-12)",
    r.result?.isError === true && /Could not prepare this review's log directory/.test(t) && /CLAUDE_REVIEW_LOG_DIR/.test(t),
    t.slice(0, 320));
  s.kill();
}

/* ================= C25 one fix-mode review per repository ================= */
{
  // P1-16: fix mode EDITS the working tree, so two concurrent fix runs on the
  // same repository overwrite each other and each run's "tree changed"
  // verification races the other's edits. The lock is per repoPath; read-only
  // reviews stay allowed (the refusal text says so).
  const repo = gitRepo("c25");
  const s = startServer({ CLAUDE_CODE_PATH: STUB });
  await s.ready;
  const first = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit", fix: true });
  const second = await s.call("claude_code_review", { repoPath: repo, scope: "last-commit", fix: true });
  check("C25", "the first fix run is accepted and returns a jobId",
    !!first.result?.structuredContent?.jobId, textOf(first).slice(0, 200));
  check("C25", "a second concurrent fix run on the same repo is refused",
    second.result?.isError === true && /already running/i.test(textOf(second)), textOf(second).slice(0, 240));
  const jid = first.result?.structuredContent?.jobId;
  if (jid) await s.call("claude_review_status", { jobId: jid, cancel: true });
  s.kill();
}

/* ================= C26 a cancelled sync run is still pollable ================= */
{
  // P1-8: a waitForResult=true call used to create no job. When the client
  // cancelled it, the SDK dropped the response — and every reviewer report the
  // run had already paid for became unreachable. The job must exist in both
  // modes, so the interrupted result can be fetched by jobId after the cancel.
  const s = startServer({ CLAUDE_CODE_PATH: STUB, STUB_SUBAGENT_DELAY_MS: "1500" });
  await s.ready;
  const repo = gitRepo("c26");
  // A STRING request id cannot collide with the harness's numeric ids, letting
  // this file send the cancel notification itself while polling from the same
  // connection (the sync response is expected to be dropped).
  const requestId = "p1-8-sync-cancel";
  s.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: requestId, method: "tools/call",
    params: { name: "claude_code_review", arguments: { repoPath: repo, scope: "last-commit", waitForResult: true } },
  }) + "\n");
  let jobId = "";
  let sawReport = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const list = await s.call("claude_review_status", {});
    const m = /(job-[a-z0-9-]+)/.exec(textOf(list));
    if (!m) continue;
    jobId = m[1];
    const p = await s.call("claude_review_status", { jobId });
    if ((p.result?.structuredContent?.subagentsSoFar || []).length > 0) { sawReport = true; break; }
    if (p.result?.structuredContent?.status !== "running") break;
  }
  check("C26", "a waitForResult run is registered as a job (P1-8)", !!jobId, "no job visible in claude_review_status");
  check("C26", "at least one reviewer report landed before the cancel", sawReport, "none before the cancel");
  s.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "c26" },
  }) + "\n");
  let final = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const p = await s.call("claude_review_status", { jobId });
    if (p.result?.structuredContent?.status !== "running") { final = p.result; break; }
  }
  const sc = final?.structuredContent || {};
  check("C26", "after the cancel the job reports the cancellation",
    final?.isError === true && sc.status === "cancelled", JSON.stringify({ isError: final?.isError, status: sc.status }));
  check("C26", "the reports produced before the cancel survive (P1-8)",
    (sc.subagents || []).length >= 1 && /## Reviewer subagent reports/.test(final?.content?.[0]?.text || ""),
    JSON.stringify({ subagents: (sc.subagents || []).length }));
  s.kill();
}

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const passed = results.filter((r) => r.ok && !r.skipped);
const caseIds = [...new Set(results.map((r) => r.caseId))];
const skipNote = skipped.length ? `, ${skipped.length} SKIPPED` : "";
console.log(`\n${failed.length === 0 ? "ALL CASES PASS" : "FAILURES"}: ${passed.length}/${results.length - skipped.length} checks${skipNote}, cases executed: ${caseIds.join(" ")}`);
process.exit(failed.length === 0 ? 0 : 1);
