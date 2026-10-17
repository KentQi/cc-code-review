#!/usr/bin/env node
/**
 * Smoke test: spawn the MCP server over stdio, do the JSON-RPC handshake,
 * list tools, and call claude_review_env (free — no Claude API usage).
 * Exits 0 when everything checks out.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

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
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.error("unparseable line:", line.slice(0, 200));
    }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const fail = (m) => { console.error(`FAIL: ${m}`); child.kill(); process.exit(1); };

// 1. initialize — pin the identity: a rename regression (server keeps an old
// name/version) must fail here, not ship.
const pkg = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
const init = await request("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.1" },
});
if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
if (!init.result?.serverInfo?.name) fail("initialize result missing serverInfo");
if (init.result.serverInfo.name !== "cc-code-review") {
  fail(`initialize serverInfo.name is "${init.result.serverInfo.name}", expected "cc-code-review"`);
}
if (init.result.serverInfo.version !== pkg.version) {
  fail(`initialize serverInfo.version is "${init.result.serverInfo.version}", expected package.json's "${pkg.version}"`);
}
console.log("ok: initialize ->", init.result.serverInfo.name, init.result.serverInfo.version);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// 2. tools/list
const tools = await request("tools/list", {});
const names = (tools.result?.tools || []).map((t) => t.name);
for (const expected of ["claude_code_review", "claude_review_followup", "claude_review_env"]) {
  if (!names.includes(expected)) fail(`tools/list missing ${expected}; got: ${names.join(", ")}`);
}
console.log("ok: tools/list ->", names.join(", "));

// 3. tools/call claude_review_env (free)
const env = await request("tools/call", { name: "claude_review_env", arguments: {} });
if (env.error) fail(`claude_review_env error: ${JSON.stringify(env.error)}`);
const text = env.result?.content?.[0]?.text || "";
console.log("ok: claude_review_env ->");
console.log(text.split("\n").map((l) => "    " + l).join("\n"));
if (/NOT FOUND/.test(text)) fail("Claude Code CLI not resolved — fix resolution before shipping");

child.kill();
console.log("\nSMOKE TEST PASSED");
process.exit(0);
