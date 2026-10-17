#!/usr/bin/env node
// Stub "claude" CLI for free lifecycle tests of the async job model (C8/C10).
// Behaves like the surface cc-code-review touches: --version, --help (flags),
// and a -p headless run that sleeps, emits a valid stream-json result, exits 0.
// Writes a pidfile next to itself so tests can verify the process tree was killed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log([
    "Usage: claude [options]",
    "  -p, --print",
    "  --effort <level>",
    "  --max-budget-usd <n>",
    "  --permission-mode <mode>",
    "  --permission-prompts <policy>",
    "  --output-format <fmt>  (json, stream-json)",
    "  --verbose",
  ].join("\n"));
  process.exit(0);
}

// headless review: drain stdin, sleep, emit result
try { fs.writeFileSync(self + ".pid", String(process.pid)); } catch { /* best effort */ }
process.stdin.resume();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);
const result = {
  type: "result", subtype: "success", is_error: false,
  result: "STUB-REPORT: stub review completed (deterministic marker STUB-REPORT-OK)",
  session_id: "stub-session-0001", num_turns: 3, total_cost_usd: 0.01,
  duration_ms: 4000, permission_denials: [], subagent_stats: { spawned: 5 },
};
if (args.includes("stream-json")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: result.session_id }));
}
console.log(JSON.stringify(result));
try { fs.rmSync(self + ".pid", { force: true }); } catch { /* best effort */ }
process.exit(0);
