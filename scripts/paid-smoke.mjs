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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectServer } from "./lib/mcp-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = { cap: null };
for (const a of process.argv.slice(2)) {
  const m = /^--cap=(.+)$/.exec(a);
  if (m) plan.cap = Number(m[1]);
}

/* ---------- a throwaway repo with three planted bugs ---------- */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paid-smoke-"));
// The reviewed files are staged here and copied in AFTER the base commit, so the
// commit under review is not a root commit (the native command targets HEAD~1).
const staged = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paid-smoke-src-"));
const write = (rel, body) => {
  const p = path.join(staged, rel);
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
// Base commit FIRST (docs only), then the reviewed files: "last-commit" needs a
// parent, and the native command targets a BASE ref (HEAD~1), which does not
// exist in a root-commit repository.
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs", "README.md"), "base" + String.fromCharCode(10));
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitEnv });
for (const rel of ["package.json", "src/db.js", "src/auth.js", "src/retry.js"]) {
  const from = path.join(staged, rel);
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.cpSync(from, path.join(repo, rel));
}
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add auth/config/paging helpers"], { env: gitEnv });
console.log("fixture repo:", repo);

/* ---------- stdio client (shared; this suite budgets 120s per request) ---------- */
const srv = connectServer({
  args: [path.join(ROOT, "src", "index.js")],
  stdio: ["pipe", "pipe", "inherit"],
  timeoutMs: 120_000,
  clientInfo: { name: "paid-smoke", version: "0" },
  requireJsonObjectPrefix: true,
});
await srv.initialize();
const textOf = (r) => r?.result?.content?.[0]?.text ?? "";

/* ---------- one real review ---------- */
const s = { call: (name, args) => srv.call(name, args), close: () => srv.close() };
const t0 = Date.now();
console.log("launching review (effort=low, reviewLevel=low, timeout 8m)…");
const args = { repoPath: repo, scope: "last-commit", effort: "low", reviewLevel: "low", timeoutMinutes: 8, waitForResult: false };
if (Number.isFinite(plan.cap) && plan.cap > 0) args.maxBudgetUsd = plan.cap;
const started = await s.call("claude_code_review", args);
const jobId = started.result?.structuredContent?.jobId;
if (!jobId) {
  console.log("FAIL  no jobId:", textOf(started).slice(0, 500));
  srv.close();
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

// The native pipeline answers in claude's own terse format (file:line findings),
// the fleet pipeline in our headings — accept either.
const FILE_LINE = /[A-Za-z0-9_./\\-]+\.(js|ts|jsx|tsx|py|go|java|rb|cs|rs|php|c|h|cpp):[0-9]+/;
const hasReport = /Review Summary|Findings|结论|发现|summary/i.test(text) || FILE_LINE.test(text);
// The native pipeline is single-context by design (0 subagents); the fleet
// pipeline must show at least one captured reviewer report.
const nativeRun = /native/i.test(String(sc.pipeline || ""));
const ok = final && final.isError !== true && hasReport && (nativeRun || subs.length >= 1);
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
srv.close();
process.exit(ok ? 0 : 1);
