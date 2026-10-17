#!/usr/bin/env node
/**
 * E2E test: calls claude_code_review through the MCP stdio interface on the
 * repo given as argv[2]. Prints the returned report. Uses real Claude credits.
 * argv[3] (optional): JSON object merged into the tool arguments
 *   e.g. '{"fix":true,"effort":"low"}'
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoPath = process.argv[2];
if (!repoPath) { console.error("usage: node e2e-test.mjs <repoPath> [extraArgsJson]"); process.exit(1); }
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map();
let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]); // decode once per line boundary: multi-byte chars may straddle chunks
  let idx;
  while ((idx = buf.indexOf(0x0a)) >= 0) {
    const line = buf.subarray(0, idx).toString("utf8").trim();
    buf = buf.subarray(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* ignore */ }
  }
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15 * 60_000);
  pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  send({ jsonrpc: "2.0", id, method, params });
});

await request("initialize", {
  protocolVersion: "2025-03-26", capabilities: {},
  clientInfo: { name: "e2e-test", version: "0.0.1" },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const started = Date.now();
const res = await request("tools/call", {
  name: "claude_code_review",
  arguments: {
    repoPath,
    scope: "working-dir",
    outputLanguage: "中文",
    timeoutMinutes: 12,
    maxBudgetUsd: 4,
    maxTurns: 60,
    ...extra,
  },
});

const text = res.result?.content?.[0]?.text ?? JSON.stringify(res, null, 2);
console.log(`\n===== claude_code_review result (${Math.round((Date.now() - started) / 1000)}s) =====\n`);
console.log(text);
const failed = res.result?.isError || !!res.error;
child.kill();
console.log(`\nE2E ${failed ? "FAILED (isError)" : "OK"}`);
process.exit(failed ? 1 : 0);
