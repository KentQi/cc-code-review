#!/usr/bin/env node
/**
 * Test runner: run every free suite, then report one honest summary.
 *
 * `npm test` used to be `a && b && c`: the first red suite silently skipped every
 * suite after it, so while shell-guard was red on POSIX the 272-check audit
 * suite and the smoke test never ran at all (audit P1-12). A gate that hides two
 * thirds of itself is worse than no gate, so every suite runs even when an
 * earlier one fails, and only the final tally decides the exit code.
 *
 * Free and offline: no Claude credits, no network. The paid paths
 * (`npm run test:paid`, `cross-cases.mjs --paid`) are intentionally excluded;
 * cross-cases' C9 is opt-in behind --paid + CC_LOOP_PAID=1 and skips itself.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Optional suites are skipped when absent instead of failing: p0-regression
// ships together with the security fixes it locks, and `npm test` being red on
// a branch that has not merged them yet would teach people to ignore the gate.
const SUITES = [
  { name: "shell-guard", script: "scripts/shell-guard-test.mjs" },
  { name: "audit-fixes", script: "scripts/audit-fixes-test.mjs" },
  { name: "p0-regression", script: "scripts/p0-regression-test.mjs", optional: true },
  { name: "smoke", script: "scripts/smoke-test.mjs" },
  { name: "validation", script: "scripts/validation-test.mjs" },
  { name: "cross-cases", script: "scripts/cross-cases.mjs" },
];

const results = [];
const startedAt = Date.now();

for (const suite of SUITES) {
  const scriptPath = path.join(ROOT, suite.script);
  if (!fs.existsSync(scriptPath)) {
    if (suite.optional) {
      console.log(`SKIP  ${suite.script} (not present yet — optional suite, skipped)`);
      results.push({ ...suite, status: "SKIP", reason: "not present" });
      continue;
    }
    // A required suite that vanished is a failure, not a skip: the gate would
    // otherwise go green by deleting the thing that was supposed to protect it.
    console.log(`FAIL  ${suite.script} (missing)`);
    results.push({ ...suite, status: "FAIL", reason: "missing", ms: 0 });
    continue;
  }

  console.log(`\n=== ${suite.script} ===`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  const ms = Date.now() - t0;
  // status is null when the child died from a signal or could not be spawned:
  // a suite that did not run to completion is a failure, never a skip.
  const ok = res.status === 0 && !res.error;
  const detail = res.error
    ? `spawn error: ${res.error.message}`
    : res.status === null
      ? `killed by ${res.signal ?? "a signal"}`
      : null;
  results.push({ ...suite, status: ok ? "PASS" : "FAIL", exit: res.status, ms, detail });
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const skipped = results.filter((r) => r.status === "SKIP").length;

console.log("\n=== summary ===");
for (const r of results) {
  if (r.status === "SKIP") {
    console.log(`SKIP  ${r.name.padEnd(16)} exit -   (${r.reason})`);
    continue;
  }
  const exit = r.exit === null || r.exit === undefined ? "-" : r.exit;
  const note = r.detail ? `  (${r.detail})` : "";
  console.log(`${r.status}  ${r.name.padEnd(16)} exit ${exit}  (${(r.ms / 1000).toFixed(1)}s)${note}`);
}
console.log(`\nTOTAL: ${passed} passed, ${failed} failed, ${skipped} skipped  [${((Date.now() - startedAt) / 1000).toFixed(1)}s]`);
process.exit(failed === 0 ? 0 : 1);
