#!/usr/bin/env node
// Stub "claude" CLI for free lifecycle tests of the async job model (C8/C10).
// Behaves like the surface cc-code-review touches: --version, --help (flags),
// and a -p headless run that sleeps, emits a valid stream-json result, exits 0.
// Writes a pidfile next to itself so tests can verify the process tree was killed.
import fs from "node:fs";
import os from "node:os";
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
// in the OS temp dir, not the package dir — "npm pack" ships scripts/ wholesale.
// STUB_PID_FILE lets the test harness give each run its own path, so parallel
// CI jobs sharing one tmpdir cannot read (or delete) each other's pid.
const pidFile = process.env.STUB_PID_FILE?.trim() || path.join(os.tmpdir(), "stub-claude-test.pid");
try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* best effort */ }
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
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: "system", subtype: "init", session_id: result.session_id });
  // A claude 2.1.x headless run forwards subagent activity to the parent
  // stream: the Agent dispatch, that subagent's own messages (tagged with
  // agent_id + the model it actually ran on) and the tool_result carrying its
  // final report. Emit five of them, plus the stderr line the real CLI writes
  // when a gateway/settings rewrite substituted the model — the shapes the
  // report's provenance + reviewer-report extraction must survive.
  const subagentModel = process.env.STUB_SUBAGENT_MODEL || "MiniMax-M3.1-Flash";
  for (let i = 1; i <= 5; i++) {
    const toolId = `stub-tool-agent-${i}`;
    say({
      type: "assistant",
      message: { role: "assistant", model: "stub-main-model", content: [{ type: "tool_use", id: toolId, name: "Agent", input: { description: `STUB reviewer #${i}`, subagent_type: "general-purpose", prompt: "review this" } }] },
    });
    say({
      type: "assistant",
      message: { role: "assistant", model: subagentModel, content: [{ type: "text", text: `STUB-SUBAGENT-${i}: working` }] },
      agent_id: `stub-agent-${i}`, parent_tool_use_id: toolId, subagent_type: "general-purpose",
    });
    say({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `STUB-SUBAGENT-REPORT-${i}: findings from reviewer ${i}` }] },
    });
  }
  process.stderr.write(`[claude-code:unrecognized_model] {"model":"${subagentModel}","query_source":"agent:builtin:general-purpose"}\n`);
}
console.log(JSON.stringify(result));
try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }
process.exit(0);
