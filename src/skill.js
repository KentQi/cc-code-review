import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Marks the skill directory as installed by this server (so it can be safely
// refreshed). The server was renamed after the first release, so the previous
// marker names are still recognised — without that, every existing install
// would be reclassified as "user-managed" and silently stop being updated.
const MARKER = "installed-by-cc-code-review";
const LEGACY_MARKERS = ["installed-by-claude-review-mcp"];

export function userSkillDir() {
  return path.join(os.homedir(), ".claude", "skills", "code-review");
}

export function bundledSkillFile() {
  return fileURLToPath(new URL("../assets/skills/code-review/SKILL.md", import.meta.url));
}

/**
 * @param {string} [dir] override for tests
 * @returns {"missing" | "bundled" | "user"}
 *  - missing: nothing installed
 *  - bundled: installed by this MCP server (marker file present, safe to overwrite)
 *  - user:    pre-existing user-managed skill (never touched)
 */
export function skillStatus(dir = userSkillDir()) {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  return [MARKER, ...LEGACY_MARKERS].some((m) => fs.existsSync(path.join(dir, m))) ? "bundled" : "user";
}

/**
 * Is the installed copy the one this build ships?
 *
 * This matters more than it looks: the skill file IS the review pipeline. A copy
 * frozen at an older release told the model to dispatch exactly five reviewers
 * long after the bundled pipeline sized its fleet from the diff — the review then
 * looked correct while silently running the old procedure.
 *
 * @returns {{status: string, upToDate: boolean, installedBytes: number|null, bundledBytes: number|null}}
 */
export function skillSync(dir = userSkillDir()) {
  const status = skillStatus(dir);
  let installedBytes = null;
  let bundledBytes = null;
  let upToDate = false;
  try { bundledBytes = fs.readFileSync(bundledSkillFile()).length; } catch { /* bundled missing: cannot compare */ }
  if (status !== "missing") {
    try {
      const installed = fs.readFileSync(path.join(dir, "SKILL.md"));
      installedBytes = installed.length;
      upToDate = bundledBytes !== null && installed.equals(fs.readFileSync(bundledSkillFile()));
    } catch { /* unreadable: treated as out of date */ }
  }
  return { status, upToDate, installedBytes, bundledBytes };
}

/**
 * Install (or refresh) the bundled skill. Never overwrites a user-managed skill.
 * A managed copy is refreshed whenever its content differs from the bundled
 * file — that is the only way a pipeline fix reaches an existing install.
 *
 * @param {string} [dir] override for tests
 * @returns {{installed: boolean, changed?: boolean, dir?: string, from?: string, reason?: string}}
 */
export function installBundledSkill(dir = userSkillDir()) {
  const status = skillStatus(dir);
  if (status === "user") {
    return { installed: false, reason: `user-managed code-review skill already exists at ${dir}; keeping it untouched` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "SKILL.md");
    const bundled = fs.readFileSync(bundledSkillFile());
    let changed = true;
    try {
      changed = !fs.readFileSync(dest).equals(bundled);
    } catch { /* not there yet */ }
    if (changed) fs.writeFileSync(dest, bundled);
    fs.writeFileSync(path.join(dir, MARKER), new Date().toISOString() + "\n");
    // Drop markers from earlier server names so the directory carries exactly one.
    for (const legacy of LEGACY_MARKERS) {
      try { fs.rmSync(path.join(dir, legacy), { force: true }); } catch { /* best effort */ }
    }
    return { installed: true, changed, dir, from: bundledSkillFile() };
  } catch (e) {
    // locked dir / AV / read-only home: degrade to the inline fallback prompt
    // instead of an opaque SDK-level throw out of the tool handler
    return { installed: false, reason: `skill install failed (${e?.message || e})` };
  }
}

export function uninstallBundledSkill(dir = userSkillDir()) {
  if (skillStatus(dir) !== "bundled") {
    return { uninstalled: false, reason: "no bundled skill installed (or it is user-managed)" };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { uninstalled: true, dir };
}
