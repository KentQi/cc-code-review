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
    "  --settings <file>",
    "  --verbose",
  ].join("\n"));
  process.exit(0);
}

// STUB_ECHO_SETTINGS=<file>: copy the --settings JSON to that path so a test
// can assert what the MCP actually handed claude (e.g. the ultracode key).
// STUB_ECHO_ARGS=<file>: write the argv JSON so a test can assert what the MCP
// actually passed (default effort, derived budget, ...).
if (process.env.STUB_ECHO_ARGS) {
  try { fs.writeFileSync(process.env.STUB_ECHO_ARGS, JSON.stringify(args)); } catch { /* best effort */ }
}

// STUB_EMIT_WORKFLOW=1: emit one Workflow tool_use, as ultracode runs do.
if (process.env.STUB_ECHO_SETTINGS) {
  const i = args.indexOf("--settings");
  let content = null;
  if (i >= 0 && args[i + 1]) { try { content = fs.readFileSync(args[i + 1], "utf8"); } catch { /* missing */ } }
  try { fs.writeFileSync(process.env.STUB_ECHO_SETTINGS, content ?? "null"); } catch { /* best effort */ }
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
// The result event carries claude's own accounting: modelUsage (per-model
// totals across main loop + subagents), subagent_stats (spawned/completed/
// failed/killed/started_in_background/by_type), usage. STUB_RESULT_SUBTYPE
// lets a test simulate a budget-stopped run (is_error) that still produced
// subagent reports — the shape that must not lose them.
const subagentModelEnv = process.env.STUB_SUBAGENT_MODEL || "MiniMax-M3.1-Flash";
const stop = process.env.STUB_RESULT_SUBTYPE === "error_max_budget_usd";
const result = {
  type: "result", subtype: stop ? "error_max_budget_usd" : "success", is_error: stop,
  result: stop
    ? "Budget limit reached ($15.00 of $15); stopping background agents."
    : "STUB-REPORT: stub review completed (deterministic marker STUB-REPORT-OK)",
  session_id: "stub-session-0001", num_turns: 3, total_cost_usd: 15.01,
  duration_ms: 4000, permission_denials: [],
  subagent_stats: {
    spawned: 5, requested: { background: 0, foreground: 0, unset: 5 },
    started_in_background: 5, by_type: { "general-purpose": 5 }, max_depth: 1,
    spawned_by_subagents: 0, completed: 4, failed: 0,
    killed: { parent: 0, user: 0, system: 1 },
  },
  modelUsage: {
    "stub-main-model": { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    [subagentModelEnv]: { inputTokens: 5000, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  },
  usage: { input_tokens: 6000, output_tokens: 1100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};
if (args.includes("stream-json")) {
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: "system", subtype: "init", session_id: result.session_id });
  if (process.env.STUB_EMIT_WORKFLOW === "1") {
    // Ultracode runs open with a Workflow dispatch (native orchestration).
    say({
      type: "assistant",
      message: { role: "assistant", model: "stub-main-model", content: [{ type: "tool_use", id: "stub-workflow-1", name: "Workflow", input: { script: "export const meta = { name: 'stub-review' };" } }] },
    });
  }
  // A claude 2.1.x headless run forwards subagent activity to the parent
  // stream, and the skill dispatches ALL FIVE reviewers in ONE message so they
  // run in parallel — so this emits one assistant event with five Agent
  // tool_use blocks, one user event with five tool_results, and the reports.
  //
  // Two delivery shapes occur in the real CLI, both exercised here:
  //  - async background agents (the 2.1.x default for general-purpose): the
  //    tool_result is only "Async agent launched successfully…" naming an
  //    output_file, and the report arrives in a system/task_notification keyed
  //    by the same tool_use id;
  //  - synchronous dispatches: the tool_result itself carries the report.
  // Reviewers #1-#3 are async (one "stopped"), #4-#5 sync. With
  // STUB_LOST_AGENT_OUTPUT_FILE set, reviewer #1 NEVER notifies (killed by a
  // 429 mid-flight): only its launch ack's output_file survives, so the MCP
  // must recover its work from that transcript. STUB_SUBAGENT_DELAY_MS spaces
  // the events out so a mid-run poll observes the fleet filling incrementally.
  const subagentModel = process.env.STUB_SUBAGENT_MODEL || "MiniMax-M3.1-Flash";
  const lostOutputFile = process.env.STUB_LOST_AGENT_OUTPUT_FILE || null;
  const delayMs = Number(process.env.STUB_SUBAGENT_DELAY_MS || 0);
  const NL = String.fromCharCode(10);
  // Agents whose launch ack is shaped so NEITHER detector recognises it: it must
  // not become the final report — the later task_notification is authoritative.
  const misreadAckIds = new Set((process.env.STUB_ACK_MISREAD_IDS || "").split(",").filter(Boolean).map(Number));
  const wait = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null;
  const ids = [1, 2, 3, 4, 5].map((i) => "stub-tool-agent-" + i);
  say({
    type: "assistant",
    message: {
      role: "assistant", model: "stub-main-model",
      content: ids.map((toolId, i) => ({
        type: "tool_use", id: toolId, name: "Agent",
        input: { description: "STUB reviewer #" + (i + 1), subagent_type: "general-purpose", prompt: "review this" },
      })),
    },
  });
  if (lostOutputFile) {
    // The lost agent's transcript: a subagent JSONL whose last assistant text
    // is the work a 429 would otherwise have thrown away.
    const transcript = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: subagentModel, content: [{ type: "text", text: "STUB-SUBAGENT-1: starting" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: subagentModel, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/index.js" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: subagentModel, content: [{ type: "text", text: "STUB-SUBAGENT-REPORT-1: partial findings recovered from the transcript before the 429 hit" }] } }),
    ].join(NL) + NL;
    try { fs.writeFileSync(lostOutputFile, transcript); } catch { /* best effort */ }
  }
  for (let i = 1; i <= 5; i++) {
    const lost = lostOutputFile && i === 1;
    say({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: ids[i - 1],
          // The real ack is a multi-line CLI block; the MCP's detector is
          // anchored on that shape (a one-line paraphrase must not count).
          content: i <= 3
            ? misreadAckIds.has(i)
              ? "Background agent " + i + " dispatched; the report will follow."
              : [
                "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it...)",
                "agentId: stub-agent-" + i + " (internal ID - do not mention to user.)",
                "The agent is working in the background. You will be notified automatically when it completes.",
                ...(lost ? ["output_file: " + lostOutputFile] : []),
                "Do NOT Read or tail this file via the shell tool.",
              ].join(NL)
            : "STUB-SUBAGENT-REPORT-" + i + ": findings from reviewer " + i,
        }],
      },
    });
    say({
      type: "assistant",
      message: { role: "assistant", model: subagentModel, content: [{ type: "text", text: "STUB-SUBAGENT-" + i + ": working" }] },
      agent_id: "stub-agent-" + i, parent_tool_use_id: ids[i - 1], subagent_type: "general-purpose",
    });
    if (i <= 3 && !lost) {
      say({
        type: "system", subtype: "task_notification", task_id: "stub-agent-" + i,
        tool_use_id: ids[i - 1], status: i === 3 ? "stopped" : "completed",
        summary: "STUB-SUBAGENT-REPORT-" + i + ": async findings from reviewer " + i + (i === 3 ? " (budget stopped)" : ""),
      });
    }
    await wait(delayMs);
  }
  process.stderr.write('[claude-code:unrecognized_model] {"model":"' + subagentModel + '","query_source":"agent:builtin:general-purpose"}' + String.fromCharCode(10));
}
console.log(JSON.stringify(result));
try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }
process.exit(0);
