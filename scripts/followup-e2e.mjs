#!/usr/bin/env node
/**
 * Followup e2e: continues a previous review session through the MCP stdio
 * interface. argv: <repoPath> <sessionId>. Uses real Claude credits.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [, , repoPath, sessionId] = process.argv;
if (!repoPath || !sessionId) { console.error("usage: node followup-e2e.mjs <repoPath> <sessionId>"); process.exit(1); }

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map();
let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
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
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10 * 60_000);
  pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  send({ jsonrpc: "2.0", id, method, params });
});

await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "followup-e2e", version: "0.0.1" } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const res = await request("tools/call", {
  name: "claude_review_followup",
  arguments: { sessionId, repoPath, message: "用一句话复述你报告里最严重的那条 finding（含文件与行号）。", outputLanguage: "中文", timeoutMinutes: 8 },
});

const text = res.result?.content?.[0]?.text ?? JSON.stringify(res, null, 2);
console.log(`\n===== claude_review_followup result =====\n`);
console.log(text);
const failed = res.result?.isError || !!res.error;
child.kill();
console.log(`\nFOLLOWUP E2E ${failed ? "FAILED (isError)" : "OK"}`);
process.exit(failed ? 1 : 0);
