#!/usr/bin/env node
/**
 * Packaging regression (audit Q15). Free and offline: `npm pack` on a local
 * checkout never touches the registry.
 *
 * Why this exists: the runtime needs exactly two things outside src/ —
 *   scripts/pre-tool-hook.js   (src/claude.js resolves it as ../scripts/...)
 *   assets/skills/code-review/SKILL.md  (src/skill.js reads it)
 * — and nothing in the test suite noticed if a future `files` edit / .npmignore
 * dropped them. The failure mode is silent and total: guardState() reports
 * "hook script missing" and every review refuses to run on the USER's machine,
 * while every checkout test stays green.
 *
 * It also locks the inverse: the published tarball must NOT ship the test,
 * paid, or audit material (~190KB of scripts/ plus audit/).
 *
 * Three layers, so a green here means something:
 *   1. package.json#files is exactly the reviewed list (no silent widening).
 *   2. `npm pack --dry-run --json` contains every runtime file and none of the
 *      test/audit files.
 *   3. The real tarball is packed to a temp dir, extracted, and BOTH the hook
 *      fingerprint probe and an MCP initialize/tools-list handshake run against
 *      the extracted copy — a tarball that is present-but-broken still fails.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectServer } from "./lib/mcp-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else {
    failures.push(label);
    console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
};
const truthy = (label, cond) => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}`); }
};

/** The reviewed files allow-list. Order matters for review, not for npm. */
const EXPECTED_FILES = [
  "src",
  "scripts/pre-tool-hook.js",
  "assets",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
];
const REQUIRED_IN_TARBALL = [
  "package.json",
  "src/index.js",
  "src/claude.js",
  "src/prompt.js",
  "src/shell-guard.js",
  "src/skill.js",
  "src/version.js",
  "scripts/pre-tool-hook.js",
  "assets/skills/code-review/SKILL.md",
  "README.md",
  "LICENSE",
];
// Test / paid / audit material that must never reach a user's node_modules.
const FORBIDDEN_IN_TARBALL = [
  "scripts/audit-fixes-test.mjs",
  "scripts/cross-cases.mjs",
  "scripts/shell-guard-test.mjs",
  "scripts/p0-regression-test.mjs",
  "scripts/validation-test.mjs",
  "scripts/smoke-test.mjs",
  "scripts/pack-test.mjs",
  "scripts/stub-claude.mjs",
  "scripts/init.mjs",
  "scripts/paid-smoke.mjs",
  "scripts/e2e-test.mjs",
  "scripts/lib/mcp-client.mjs",
  "audit/TRIAGE.md",
];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/* ---- 1. the manifest contract ---- */
check("package.json files is the reviewed narrow list", pkg.files, EXPECTED_FILES);
truthy("package.json still points at src/index.js", pkg.main === "src/index.js", pkg.main);
truthy("the bin still points at src/index.js", pkg.bin?.["cc-code-review"] === "src/index.js", JSON.stringify(pkg.bin));

/* ---- 2. npm's own file list (dry run) ---- */
const packJson = (args, opts = {}) =>
  JSON.parse(execFileSync(NPM, ["pack", "--json", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    ...opts,
  }));

let dry;
try {
  dry = packJson(["--dry-run"]);
} catch (e) {
  check("npm pack --dry-run --json succeeds", false, true);
  console.error(String(e?.stdout || "").slice(-2000));
  console.error(String(e?.stderr || "").slice(-2000));
  console.log(`\nPACK TEST FAILED (${failures.length} failed, ${pass} passed)`);
  process.exit(1);
}
const dryFiles = (dry[0]?.files || []).map((f) => f.path).sort();
const drySet = new Set(dryFiles);
for (const f of REQUIRED_IN_TARBALL) check(`tarball contains ${f}`, drySet.has(f), true);
for (const f of FORBIDDEN_IN_TARBALL) check(`tarball excludes ${f}`, drySet.has(f), false);
check("tarball contains no node_modules entry", dryFiles.some((f) => f.startsWith("node_modules/")), false);
check("every tarball path is a regular packaged file", dryFiles.every((f) => !f.startsWith("/") && !f.includes("..")), true);
// The whole point of narrowing files: a published package is a runtime artifact,
// not the repository. 15 runtime files is the ceiling that catches a re-widened
// files field even if the forbidden list above is not updated.
truthy(`tarball is lean (${dryFiles.length} files)`, dryFiles.length <= 20, `${dryFiles.length} files`);
const unpackedBytes = dry[0]?.unpackedSize ?? 0;
// The docs (README/CHANGELOG) are ~160KB of the total; scripts/ used to add
// another ~190KB. A re-widened files field crosses this ceiling immediately.
truthy(`tarball unpacked size is runtime-sized (${Math.round(unpackedBytes / 1024)}KB)`, unpackedBytes < 700 * 1024);

/* ---- 3. pack for real, extract, and run the extracted copy ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pack-"));
try {
  let tarball;
  try {
    const packed = packJson(["--pack-destination", tmp]);
    tarball = path.join(tmp, packed[0]?.filename ?? "");
  } catch (e) {
    console.error(String(e?.stdout || "").slice(-2000));
    console.error(String(e?.stderr || "").slice(-2000));
    check("npm pack --pack-destination succeeds", false, true);
    tarball = null;
  }
  if (tarball) {
    truthy("the packed tarball exists", fs.existsSync(tarball), tarball);
    const extractDir = path.join(tmp, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { timeout: 60_000, windowsHide: true });
    } catch (e) {
      check("tarball extracts with tar", false, true);
      console.error(String(e?.stderr || e?.message || e));
    }
    const appDir = path.join(extractDir, "package");
    truthy("the extracted package has the entry file", fs.existsSync(path.join(appDir, "src", "index.js")));
    truthy("the extracted package has the hook", fs.existsSync(path.join(appDir, "scripts", "pre-tool-hook.js")));
    truthy("the extracted package has the bundled skill", fs.existsSync(path.join(appDir, "assets", "skills", "code-review", "SKILL.md")));

    // 3a. The guard hook must load its policy from the packaged src/ — the exact
    // relative path (../src/shell-guard.js) that a different layout would break.
    try {
      const out = execFileSync(process.execPath, [path.join(appDir, "scripts", "pre-tool-hook.js")], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, CC_REVIEW_GUARD_INFO: "1" },
      });
      const info = JSON.parse(String(out).trim().split("\n").pop());
      truthy("the packaged hook loads the packaged shell-guard", typeof info.fingerprint === "string" && info.fingerprint.length >= 8, info.fingerprint || info.error);
    } catch (e) {
      check("the packaged hook loads the packaged shell-guard", false, true);
      console.error(String(e?.stderr || e?.message || e).slice(-1000));
    }

    // 3b. The packaged server must complete the MCP handshake and list its tools.
    // Dependencies are not part of the tarball (npm installs them on the user's
    // machine); link the checkout's node_modules instead of installing anything.
    try {
      fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(appDir, "node_modules"), "junction");
    } catch (e) {
      check("the extracted package can link the checkout's dependencies", false, true);
      console.error(String(e?.message || e));
    }
    const srv = connectServer({
      args: [path.join(appDir, "src", "index.js")],
      stdio: ["pipe", "pipe", "ignore"],
      timeoutMs: 45_000,
      clientInfo: { name: "pack-test", version: "0.0.1" },
      requireJsonObjectPrefix: true,
    });
    try {
      const init = await srv.initialize();
      const list = await srv.request("tools/list", {});
      const names = (list.result?.tools || []).map((t) => t.name);
      check("the packaged server lists all four tools", names.slice().sort(),
        ["claude_code_review", "claude_review_env", "claude_review_followup", "claude_review_status"]);
      check("the packaged server reports the package.json version", init.result?.serverInfo?.version, pkg.version);
    } catch (e) {
      check("the packaged server completes the MCP handshake", false, true);
      console.error(String(e?.message || e).slice(-1000));
    } finally {
      srv.close();
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
