#!/usr/bin/env node
/**
 * Smoke test: spawn the MCP server over stdio, do the JSON-RPC handshake,
 * list tools, and call claude_review_env (free — no Claude API usage).
 * Exits 0 when everything checks out.
 *
 * The stdio client lives in scripts/lib/mcp-client.mjs (audit Q20): this file
 * used to carry its own copy, and the copies had already drifted.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectServer } from "./lib/mcp-client.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srv = connectServer({
  args: [path.join(ROOT, "src", "index.js")],
  timeoutMs: 30_000,
  clientInfo: { name: "smoke-test", version: "0.0.1" },
  // The server's stdout is a JSON-RPC channel; anything else is a bug worth
  // reporting here. (cross-cases passes requireJsonObjectPrefix instead, because
  // it also has to tolerate host banners.)
  onUnparseable: (line) => console.error("unparseable line:", line.slice(0, 200)),
});
const fail = (m) => { console.error(`FAIL: ${m}`); srv.close(); process.exit(1); };

// 1. initialize — pin the identity: a rename regression (server keeps an old
// name/version) must fail here, not ship.
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const init = await srv.request("initialize", {
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
srv.notify("notifications/initialized");

// 2. tools/list
const tools = await srv.request("tools/list", {});
const names = (tools.result?.tools || []).map((t) => t.name);
for (const expected of ["claude_code_review", "claude_review_status", "claude_review_followup", "claude_review_env"]) {
  if (!names.includes(expected)) fail(`tools/list missing ${expected}; got: ${names.join(", ")}`);
}
console.log("ok: tools/list ->", names.join(", "));

// 3. tools/call claude_review_env (free)
const env = await srv.call("claude_review_env", {});
if (env.error) fail(`claude_review_env error: ${JSON.stringify(env.error)}`);
const text = env.result?.content?.[0]?.text || "";
console.log("ok: claude_review_env ->");
console.log(text.split("\n").map((l) => "    " + l).join("\n"));
if (/NOT FOUND/.test(text)) fail("Claude Code CLI not resolved — fix resolution before shipping");

srv.close();
console.log("\nSMOKE TEST PASSED");
process.exit(0);
