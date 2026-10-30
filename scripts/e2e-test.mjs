#!/usr/bin/env node
/**
 * E2E test: calls claude_code_review through the MCP stdio interface on the
 * repo given as argv[2]. Prints the returned report. Uses real Claude credits.
 * argv[3] (optional): JSON object merged into the tool arguments
 *   e.g. '{"fix":true,"effort":"low"}'
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connectServer } from "./lib/mcp-client.mjs";

const repoPath = process.argv[2];
if (!repoPath) { console.error("usage: node e2e-test.mjs <repoPath> [extraArgsJson]"); process.exit(1); }
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
// Shared stdio client (audit Q20/P2-10): the local copy this file used to carry
// had drifted — 15 min request timeout vs the suite default, a truthy id test
// that dropped a falsy id, and a pending map that never settled when the server
// died, so a crashed server hung the script until the timeout. The 15 min
// budget is a property of THIS suite (a real review), not of the client.
const srv = connectServer({
  args: [serverPath],
  timeoutMs: 15 * 60_000,
  clientInfo: { name: "e2e-test", version: "0.0.1" },
});
await srv.initialize();

const started = Date.now();
const res = await srv.call("claude_code_review", {
  repoPath, waitForResult: true,
  scope: "working-dir",
  outputLanguage: "中文",
  timeoutMinutes: 12,
  maxBudgetUsd: 4,
  maxTurns: 60,
  ...extra,
});

const text = res.result?.content?.[0]?.text ?? JSON.stringify(res, null, 2);
console.log(`\n===== claude_code_review result (${Math.round((Date.now() - started) / 1000)}s) =====\n`);
console.log(text);
const failed = res.result?.isError || !!res.error;
srv.close();
console.log(`\nE2E ${failed ? "FAILED (isError)" : "OK"}`);
process.exit(failed ? 1 : 0);
