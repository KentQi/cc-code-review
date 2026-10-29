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

// Every suite below is REQUIRED: a suite that vanishes is a failure, never a
// skip (see the missing-suite branch). p0-regression was optional only while the
// security fixes it locks were unmerged; it has shipped since 1.18.1, so
// deleting it must turn the gate red — it is the only regression cover for the
// ANSI-C / glued-short-option / repo-supplied git driver / execution-config P0s
// (audit P1-4).
// pack-test is REQUIRED too (audit Q15): it packs the real tarball and runs the
// extracted copy. Without it, narrowing package.json#files could drop
// scripts/pre-tool-hook.js or assets/skills/... and every checkout test would
// stay green while users could not run a single review.
const SUITES = [
  { name: "shell-guard", script: "scripts/shell-guard-test.mjs" },
  { name: "audit-fixes", script: "scripts/audit-fixes-test.mjs" },
  { name: "p0-regression", script: "scripts/p0-regression-test.mjs" },
  { name: "smoke", script: "scripts/smoke-test.mjs" },
  { name: "validation", script: "scripts/validation-test.mjs" },
  { name: "pack", script: "scripts/pack-test.mjs" },
  { name: "cross-cases", script: "scripts/cross-cases.mjs" },
];

// Paid / real-CLI suites: deliberately NOT run here — they spend Claude credits.
// Listing them keeps this gate honest about what it does NOT cover and makes the
// opt-in scripts discoverable; each is reachable through its own npm script.
// cancel-test's process check is platform-aware (tasklist on Windows, ps +
// resolveClaudeCli() elsewhere), so it is mechanically runnable on macOS/Linux;
// it stays here because a REAL run costs credits (audit P2-5).
const PAID_SUITES = [
  { name: "e2e (real)", script: "scripts/e2e-test.mjs", npm: "test:e2e:real", why: "real Claude review, billed" },
  { name: "followup-e2e", script: "scripts/followup-e2e.mjs", npm: "test:followup", why: "real Claude followup, billed" },
  { name: "cancel-test", script: "scripts/cancel-test.mjs", npm: "test:cancel", why: "real run + cancel, billed; cross-platform process check" },
  { name: "paid-smoke", script: "scripts/paid-smoke.mjs", npm: "test:paid", why: "real CLI smoke, billed (~$0.5)" },
];

const results = [];
const startedAt = Date.now();

for (const suite of SUITES) {
  const scriptPath = path.join(ROOT, suite.script);
  if (!fs.existsSync(scriptPath)) {
    // A suite that vanished is a failure, not a skip: the gate would otherwise
    // go green by deleting the thing that was supposed to protect it.
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

console.log("\n=== summary ===");
for (const r of results) {
  const exit = r.exit === null || r.exit === undefined ? "-" : r.exit;
  const note = r.detail ? `  (${r.detail})` : "";
  console.log(`${r.status}  ${r.name.padEnd(16)} exit ${exit}  (${(r.ms / 1000).toFixed(1)}s)${note}`);
}
console.log(`\nTOTAL: ${passed} passed, ${failed} failed  [${((Date.now() - startedAt) / 1000).toFixed(1)}s]`);
console.log(`${PAID_SUITES.length} paid suite(s) NOT run (opt-in; see below)`);

console.log("\n=== paid suites (NOT run by npm test) ===");
for (const s of PAID_SUITES) {
  console.log(`SKIP  ${s.name.padEnd(16)} ${s.script} — ${s.why}; run: npm run ${s.npm}`);
}
process.exit(failed === 0 ? 0 : 1);
