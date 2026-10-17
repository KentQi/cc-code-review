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
 * @returns {"missing" | "bundled" | "user"}
 *  - missing: nothing installed
 *  - bundled: installed by this MCP server (marker file present, safe to overwrite)
 *  - user:    pre-existing user-managed skill (never touched)
 */
export function skillStatus() {
  const dir = userSkillDir();
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  return [MARKER, ...LEGACY_MARKERS].some((m) => fs.existsSync(path.join(dir, m))) ? "bundled" : "user";
}

/** Install (or refresh) the bundled skill. Never overwrites a user-managed skill. */
export function installBundledSkill() {
  const status = skillStatus();
  if (status === "user") {
    return { installed: false, reason: `user-managed code-review skill already exists at ${userSkillDir()}; keeping it untouched` };
  }
  const dir = userSkillDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(bundledSkillFile(), path.join(dir, "SKILL.md"));
  fs.writeFileSync(path.join(dir, MARKER), new Date().toISOString() + "\n");
  // Drop markers from earlier server names so the directory carries exactly one.
  for (const legacy of LEGACY_MARKERS) {
    try { fs.rmSync(path.join(dir, legacy), { force: true }); } catch { /* best effort */ }
  }
  return { installed: true, dir, from: bundledSkillFile() };
}

export function uninstallBundledSkill() {
  if (skillStatus() !== "bundled") {
    return { uninstalled: false, reason: "no bundled skill installed (or it is user-managed)" };
  }
  fs.rmSync(userSkillDir(), { recursive: true, force: true });
  return { uninstalled: true, dir: userSkillDir() };
}
