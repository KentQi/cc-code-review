#!/usr/bin/env node
/**
 * Opt-in REAL end-to-end smoke: one review through the actual Claude Code CLI
 * (no stub), against a throwaway repo with three planted bugs.
 *
 * Costs real credits. Kept deliberately cheap: effort=low, reviewLevel=low
 * (2-3 finders), a tiny diff, and a wall-clock timeout. No spend cap by
 * default — a cap stops the parent before it synthesizes, which is exactly the
 * failure this suite is meant to observe; pass --cap=<usd> to add one.
 *
 * Usage:  node scripts/paid-smoke.mjs [--cap=2]
 * Exit 0 only when a real report came back AND at least one subagent report
 * was captured (incrementally, with a durable JSONL).
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = { cap: null };
for (const a of process.argv.slice(2)) {
  const m = /^--cap=(.+)$/.exec(a);
  if (m) plan.cap = Number(m[1]);
}

/* ---------- a throwaway repo with three planted bugs ---------- */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paid-smoke-"));
const write = (rel, body) => {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
write("package.json", JSON.stringify({ name: "smoke-target", version: "1.0.0" }, null, 2) + "\n");
write("src/db.js", [
  "const rows = [];",
  "exports.query = (sql) => rows.filter(() => true).map(() => ({ sql }));",
  "",
].join("\n"));
write("src/auth.js", [
  "const DB = require(\"./db\");",
  "",
  "// Looks up a user by name.",
  "function findUser(username) {",
  "  // BUG 1: user input concatenated straight into SQL",
  "  return DB.query(\"SELECT * FROM users WHERE name = '\" + username + \"'\");",
  "}",
  "",
  "// Reads and parses a JSON config file.",
  "function loadConfig(path) {",
  "  try {",
  "    return JSON.parse(require(\"fs\").readFileSync(path, \"utf8\"));",
  "  } catch (e) {",
  "    // BUG 2: error swallowed — every caller gets undefined and cannot tell",
  "  }",
  "}",
  "",
  "// Pages through items.",
  "function page(items, n, size) {",
  "  // BUG 3: off-by-one — the last item of every page is dropped",
  "  return items.slice(n * size, n * size + size - 1);",
  "}",
  "",
  "module.exports = { findUser, loadConfig, page };",
  "",
].join("\n"));
write("src/retry.js", [
  "async function retry(fn, times) {",
  "  let last;",
  "  for (let i = 0; i < times; i++) {",
  "    try { return await fn(); } catch (e) { last = e; }",
  "  }",
  "  throw last;",
  "}",
  "module.exports = { retry };",
  "",
].join("\n"));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "s@s" };
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add auth/config/paging helpers"], { env: gitEnv });
console.log("fixture repo:", repo);

/* ---------- stdio client ---------- */
function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });
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
  const req = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
    pending.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  const ready = (async () => {
    await req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paid-smoke", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  return { call: (name, args) => req("tools/call", { name, arguments: args }), ready, kill: () => child.kill() };
}
const textOf = (r) => r?.result?.content?.[0]?.text ?? "";

/* ---------- one real review ---------- */
const s = startServer();
await s.ready;
const t0 = Date.now();
console.log("launching review (effort=low, reviewLevel=low, timeout 8m)…");
const args = { repoPath: repo, scope: "last-commit", effort: "low", reviewLevel: "low", timeoutMinutes: 8, waitForResult: false };
if (Number.isFinite(plan.cap) && plan.cap > 0) args.maxBudgetUsd = plan.cap;
const started = await s.call("claude_code_review", args);
const jobId = started.result?.structuredContent?.jobId;
if (!jobId) {
  console.log("FAIL  no jobId:", textOf(started).slice(0, 500));
  s.kill();
  process.exit(1);
}
console.log(`jobId ${jobId} in ${Date.now() - t0}ms`);

let final = null;
let sawIncremental = false;
let lastSeen = 0;
for (let i = 0; i < 60 && !final; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  const p = await s.call("claude_review_status", { jobId });
  const sc = p.result?.structuredContent || {};
  const seen = (sc.subagentsSoFar || []).length;
  if (sc.status !== "running") { final = p.result; break; }
  if (seen > lastSeen) {
    lastSeen = seen;
    if (seen > 0) sawIncremental = true;
    console.log(`  ${sc.elapsedSec}s — ${seen} subagent report(s) visible while running`);
  }
}

const sc = final?.structuredContent || {};
const text = final?.content?.[0]?.text || "";
const subs = sc.subagents || [];
const jsonl = sc.subagentsFile;
let lines = 0;
try { lines = fs.readFileSync(jsonl, "utf8").trim().split(String.fromCharCode(10)).length; } catch { /* none */ }

const hasReport = /Review Summary|Findings|结论|发现|summary/i.test(text);
const ok = final && final.isError !== true && hasReport && subs.length >= 1;
console.log("\n===== result =====");
console.log("status      :", sc.status, final?.isError === true ? "(isError)" : "");
console.log("elapsed     :", sc.elapsedSec ?? "?", "s");
console.log("subagents   :", subs.length, "| incremental-visible:", sawIncremental);
console.log("jsonl       :", jsonl || "(none)", "lines:", lines);
console.log("spend       :", sc.costUsd ?? sc.totalCostUsd ?? (sc.usage && JSON.stringify(sc.usage).slice(0, 120)) ?? "?", "turns:", sc.numTurns ?? "?");
console.log("reviewLevel :", sc.reviewLevel, "| ultracode:", sc.ultracode);
if (subs.length) {
  console.log("\n--- subagent reports ---");
  for (const one of subs) console.log(`- [${one.status || "?"}${one.partial ? ", partial" : ""}] ${one.description || one.subagentType}: ${String(one.report || "").replace(/\s+/g, " ").slice(0, 160)}`);
}
console.log("\n--- report head ---");
console.log(text.slice(0, 2500));

console.log(`\n${ok ? "PAID SMOKE PASSED" : "PAID SMOKE FAILED"}`);
console.log("logs stay in %TEMP%/cc-code-review/ for inspection; fixture repo:", repo);
s.kill();
process.exit(ok ? 0 : 1);
