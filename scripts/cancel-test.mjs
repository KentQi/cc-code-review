#!/usr/bin/env node
/**
 * Cancellation test: starts a real review, cancels it mid-flight via the MCP
 * notifications/cancelled mechanism, and verifies the child process tree is
 * killed promptly (so the run stops billing).
 *
 * NOTE on expected behavior: the MCP SDK deliberately DROPS the response for a
 * cancelled request (protocol.js: `if (abortController.signal.aborted) return;`
 * in both the success and error paths) — that is spec-correct, since the client
 * already knows it cancelled. So the assertion here is "no claude.exe survives
 * the cancel", not "the call returns an error". A response that DOES arrive is
 * only acceptable if it reports cancellation.
 * Costs a few cents of Claude credits (the run is killed early).
 */
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoPath = process.argv[2];
if (!repoPath) { console.error("usage: node cancel-test.mjs <repoPath>"); process.exit(1); }

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map();
let buf = Buffer.alloc(0);
let sawResponse = null;
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  let idx;
  while ((idx = buf.indexOf(0x0a)) >= 0) {
    const line = buf.subarray(0, idx).toString("utf8").trim();
    buf = buf.subarray(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { sawResponse = msg; pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* ignore */ }
  }
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
  pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  send({ jsonrpc: "2.0", id, method, params });
});

const claudeProcs = () => {
  try {
    const out = execSync('tasklist /fi "imagename eq claude.exe" /nh', { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).filter((l) => /claude\.exe/i.test(l)).length;
  } catch { return 0; }
};
const waitGone = async (limitMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (claudeProcs() === 0) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  return -1;
};

await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cancel-test", version: "0.0.1" } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const before = claudeProcs();
console.log(`claude.exe before: ${before}`);

const callId = nextId++;
// A response may legitimately never arrive (SDK drops it for cancelled requests),
// so this promise is only informational — the real assertions are on processes.
const callPromise = new Promise((resolve) => {
  pending.set(callId, resolve);
  setTimeout(() => resolve(null), 90_000);
});
send({
  jsonrpc: "2.0", id: callId, method: "tools/call",
  params: {
    name: "claude_code_review",
    arguments: { repoPath, scope: "auto", effort: "high", timeoutMinutes: 10, maxBudgetUsd: 5, maxTurns: 100 },
  },
});

// wait until the review process is actually alive
let during = 0;
for (let i = 0; i < 40 && during === 0; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  during = claudeProcs();
}
console.log(`claude.exe during review: ${during}`);
const started = during > 0;
console.log("sending notifications/cancelled ...");
const cancelAt = Date.now();
send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: callId, reason: "cancel-test" } });

const killMs = await waitGone(30_000);
console.log(`claude.exe gone ${killMs >= 0 ? `after ${Math.round(killMs / 1000)}s` : "STILL RUNNING after 30s"}`);

const res = await callPromise;
const text = res?.result?.content?.[0]?.text ?? "";
if (res) console.log(`response arrived (isError=${!!res.result?.isError}): ${text.slice(0, 200)}`);
else console.log("no response arrived (expected: the SDK drops responses for cancelled requests)");

child.kill();
const killedFast = killMs >= 0 && killMs < 30_000;
const ok = started && killedFast && (!res || res.result?.isError === true || /cancel/i.test(text));
console.log(`\nCANCEL TEST ${ok ? "PASSED" : "FAILED"} (started=${started}, killedFast=${killedFast}, response=${res ? "yes" : "none"})`);
process.exit(ok ? 0 : 1);
