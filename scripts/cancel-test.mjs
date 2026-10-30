#!/usr/bin/env node
/**
 * Cancellation test: starts a real review, cancels it mid-flight via the MCP
 * notifications/cancelled mechanism, and verifies the child process tree is
 * killed promptly (so the run stops billing).
 *
 * NOTE on expected behavior: the MCP SDK deliberately DROPS the response for a
 * cancelled request (protocol.js: `if (abortController.signal.aborted) return;`
 * in both the success and error paths) — that is spec-correct, since the client
 * already knows it cancelled. So the assertion here is "no claude process
 * survives the cancel", not "the call returns an error". A response that DOES
 * arrive is only acceptable if it reports cancellation.
 *
 * Costs a few cents of Claude credits (the run is killed early), so it is NOT
 * part of `npm test` (see PAID_SUITES in run-tests.mjs). For a free dry run of
 * the same cancellation path, point it at any long-running stand-in:
 *   CLAUDE_CODE_PATH=scripts/stub-claude.mjs node scripts/cancel-test.mjs <repo>
 *
 * Platform note (audit P2-5): the process probe used to be Windows-only
 * (`tasklist /fi imagename eq claude.exe`), so on macOS/Linux it always counted
 * zero processes and the test failed before exercising the cancel path. The
 * probe now branches: Windows keeps tasklist; POSIX reads `ps -axo pid=,command=`
 * and counts only processes whose command line contains the claude CLI path that
 * resolveClaudeCli() picked for this run (plus its realpath), so an unrelated
 * claude session on the machine is not mistaken for ours.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeCli } from "../src/claude.js";
import { connectServer } from "./lib/mcp-client.mjs";

const repoPath = process.argv[2];
if (!repoPath) { console.error("usage: node cancel-test.mjs <repoPath>"); process.exit(2); }

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

// The server resolves the CLI itself; resolve it here the same way so the
// process probe looks for the exact executable this run will spawn. Without a
// usable CLI there is nothing to cancel — refuse loudly (exit 2 = not run,
// distinct from 1 = failed) instead of reporting a false failure.
const cli = resolveClaudeCli();
if (!cli || cli.error) {
  console.error(`SKIP: no usable claude CLI (${cli?.error || "not found"}) — set CLAUDE_CODE_PATH or install Claude Code.`);
  process.exit(2);
}
console.log(`claude cli: ${cli.path} [${cli.kind}; ${cli.source}]`);

/**
 * Count the claude processes belonging to THIS machine's install. Each platform
 * has its own truth source; both return a number so the caller can compare
 * before/during/after. Failures return 0 (best effort: the test then reports
 * started=false rather than crashing on a missing system tool).
 */
const processProbe = (() => {
  if (process.platform === "win32") {
    return {
      label: "claude.exe",
      count: () => {
        try {
          const out = execFileSync("tasklist", ["/fi", "imagename eq claude.exe", "/nh"], { encoding: "utf8", windowsHide: true });
          return out.split(/\r?\n/).filter((l) => /claude\.exe/i.test(l)).length;
        } catch { return 0; }
      },
    };
  }
  // POSIX: a node-script CLI runs as "node <cli.js>", a native install as the
  // binary path; both keep the resolved path in argv. realpath covers a
  // symlinked install (e.g. /usr/local/bin/claude -> .../versions/.../claude).
  const paths = new Set([path.resolve(cli.path)]);
  try { paths.add(fs.realpathSync(cli.path)); } catch { /* path is not a symlink / already gone */ }
  const needles = [...paths].filter(Boolean);
  // The invoking shell may carry CLAUDE_CODE_PATH on its own command line
  // (`CLAUDE_CODE_PATH=... node cancel-test.mjs`), which would otherwise be
  // counted as a pre-existing process and inflate the baseline. Exclude this
  // process and its ancestors: only the server's claude children are of interest.
  const ancestors = (() => {
    const pids = new Set([process.pid]);
    let pid = process.pid;
    for (let i = 0; i < 16; i++) {
      let ppid;
      try { ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim()); } catch { break; }
      if (!ppid || ppid <= 1 || pids.has(ppid)) break;
      pids.add(ppid);
      pid = ppid;
    }
    return pids;
  })();
  // Version/help probes spawn the same CLI path during server startup, so path
  // alone is not proof that the REVIEW started. Every review invocation carries
  // "-p" and "--output-format" (claude.js runClaude), neither of which a
  // --version/--help probe has. Without this filter the test could cancel
  // during the prewarm, see "started", and pass without ever exercising the
  // real run's kill path.
  const isReviewInvocation = (command) => /(?:^|\s)-p(?:\s|$)/.test(command) && command.includes("--output-format");
  return {
    label: needles.join(" | "),
    count: () => {
      try {
        const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 15_000 });
        return out.split(/\r?\n/).filter((line) => {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m || ancestors.has(Number(m[1]))) return false;
          return needles.some((n) => m[2].includes(n)) && isReviewInvocation(m[2]);
        }).length;
      } catch { return 0; }
    },
  };
})();
const claudeProcs = () => processProbe.count();

const waitForMoreThan = async (baseline, limitMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (claudeProcs() > baseline) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  return -1;
};
const waitGone = async (baseline, limitMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (claudeProcs() <= baseline) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  return -1;
};

// Baseline BEFORE the server starts: its startup version/help probes spawn the
// CLI briefly, and counting them as "pre-existing" would hide the real review
// process (during would never exceed before).
const before = claudeProcs();
console.log(`[${process.platform}] ${processProbe.label} before: ${before} (pre-existing processes are excluded from the assertion)`);

// Shared stdio client (audit Q20): framing/timeout/pending-map live in
// scripts/lib/mcp-client.mjs. startRequest() is used instead of request()
// because a cancelled request's response is legitimately dropped by the SDK —
// the promise must resolve null, not reject.
const srv = connectServer({
  args: [serverPath],
  timeoutMs: 60_000,
  clientInfo: { name: "cancel-test", version: "0.0.1" },
});
await srv.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cancel-test", version: "0.0.1" } });
srv.notify("notifications/initialized");

// A response may legitimately never arrive (SDK drops it for cancelled requests),
// so this promise is only informational — the real assertions are on processes.
const { id: callId, response: callPromise } = srv.startRequest("tools/call", {
  name: "claude_code_review",
  arguments: { repoPath, waitForResult: true, scope: "auto", effort: "high", timeoutMinutes: 10, maxBudgetUsd: 5, maxTurns: 100 },
}, { timeoutMs: 90_000 });

// wait until THIS review's claude process is actually alive (count grew past baseline)
const startedMs = await waitForMoreThan(before, 40_000);
const during = claudeProcs();
console.log(`${processProbe.label} during review: ${during}`);
const started = startedMs >= 0;
console.log("sending notifications/cancelled ...");
srv.notify("notifications/cancelled", { requestId: callId, reason: "cancel-test" });

const killMs = await waitGone(before, 30_000);
console.log(`processes back to baseline ${killMs >= 0 ? `after ${Math.round(killMs / 1000)}s` : "STILL RUNNING after 30s"}`);

// The SDK drops the response for a cancelled request, so waiting out the full
// 90s call timeout here only delays the verdict (it never arrives). Give a
// response a short grace period — a cancellation error, when one is delivered,
// arrives within a couple of seconds — then report and exit.
let graceTimer;
const res = await Promise.race([
  callPromise,
  new Promise((resolve) => { graceTimer = setTimeout(() => resolve(null), 10_000); }),
]);
clearTimeout(graceTimer);
const callSettled = res != null;
const text = res?.result?.content?.[0]?.text ?? "";
if (res) console.log(`response arrived (isError=${!!res.result?.isError}): ${text.slice(0, 200)}`);
else console.log("no response arrived (expected: the SDK drops responses for cancelled requests)");

srv.close();
const killedFast = killMs >= 0 && killMs < 30_000;
// A run that never showed up cannot prove cancellation. A response is acceptable
// only when it is an error or explicitly mentions cancellation.
const ok = started && killedFast && (!res || res.result?.isError === true || /cancel/i.test(text));
console.log(`\nCANCEL TEST ${ok ? "PASSED" : "FAILED"} (platform=${process.platform}, started=${started} after ${startedMs >= 0 ? Math.round(startedMs / 1000) : "-"}s, killedFast=${killedFast}, response=${callSettled && res ? "yes" : "none"})`);
process.exit(ok ? 0 : 1);
