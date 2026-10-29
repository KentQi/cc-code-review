#!/usr/bin/env node
/**
 * Followup e2e: continues a previous review session through the MCP stdio
 * interface. argv: <repoPath> <sessionId>. Uses real Claude credits.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connectServer } from "./lib/mcp-client.mjs";

const [, , repoPath, sessionId] = process.argv;
if (!repoPath || !sessionId) { console.error("usage: node followup-e2e.mjs <repoPath> <sessionId>"); process.exit(1); }

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
// Shared stdio client (audit Q20/P2-10). The 10 min budget is this suite's (a
// real followup turn), so it is passed here instead of living in a second copy
// of the client that had drifted from the other paid suites.
const srv = connectServer({
  args: [serverPath],
  timeoutMs: 10 * 60_000,
  clientInfo: { name: "followup-e2e", version: "0.0.1" },
});
await srv.initialize();

// waitForResult:true is REQUIRED here (audit P2-11). claude_review_followup
// defaults to async: without the flag it acknowledges with a jobId and this
// script printed "FOLLOWUP E2E OK" the moment the preflight passed — the reply
// was never fetched, so a followup that returned nothing at all still passed.
const res = await srv.call("claude_review_followup", {
  sessionId, repoPath, waitForResult: true,
  message: "用一句话复述你报告里最严重的那条 finding（含文件与行号）。", outputLanguage: "中文", timeoutMinutes: 8,
});

const text = res.result?.content?.[0]?.text ?? JSON.stringify(res, null, 2);
console.log(`\n===== claude_review_followup result =====\n`);
console.log(text);
// A synchronous followup must come back with a REPLY, not an ack: assert the
// call did not fail, the content is non-empty, AND the payload is not the async
// acknowledgment. The ack check is what makes a future removal of
// waitForResult:true visible — the ack is non-empty text too, so "non-empty"
// alone would still print OK while the reply was never fetched (audit P2-11).
const body = String(text || "").trim();
const empty = body.length === 0;
const asyncAck = /^Followup started in the background/i.test(body)
  || res.result?.structuredContent?.status === "running";
const failed = res.result?.isError || !!res.error;
srv.close();
console.log(`\nFOLLOWUP E2E ${failed ? "FAILED (isError)" : empty ? "FAILED (empty reply)" : asyncAck ? "FAILED (async ack: waitForResult was not honoured)" : "OK"}`);
process.exit(failed || empty || asyncAck ? 1 : 0);
