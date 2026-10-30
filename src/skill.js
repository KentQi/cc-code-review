import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Ownership markers.
 *
 * The marker is the ONLY ownership signal this server has: a directory is a
 * managed copy when it carries one of these files, and user-managed otherwise.
 * Content cannot be the signal — a SKILL.md that differs from the bundled file
 * is either an old release or a user edit, and treating every difference as a
 * user edit would freeze exactly the stale pipelines this mechanism exists to
 * replace (audit P2-9). So the promise is narrower than the old comment's
 * "never overwrites a user-managed skill", and precise:
 *
 *   - marker present -> managed copy: refreshed whenever it differs from the
 *     bundled file (a local edit to that copy is lost on the next install);
 *     uninstall removes only the files this server wrote
 *   - marker absent  -> user-managed: never written, never removed
 *
 * The server was renamed after the first release, so the previous marker name
 * is still recognised — without that, every existing install would be
 * reclassified as "user-managed" and silently stop being updated.
 */
const MARKER = "installed-by-cc-code-review";
const LEGACY_MARKERS = ["installed-by-claude-review-mcp"];

/**
 * The Claude config root: CLAUDE_CONFIG_DIR from the process env, else the
 * `env` block of ~/.claude/settings.json (CC Switch rewrites it; always read
 * fresh), else ~/.claude.
 *
 * "~/" is expanded and a relative value is resolved against cwd: a relative
 * CLAUDE_CONFIG_DIR would otherwise place the skill in a directory claude
 * never reads, and the shadow check would look somewhere else than the
 * installer (audit P2-9).
 *
 * Single source of truth for this rule: claude.js carried a second copy for
 * the subprocess env, and the two had to agree exactly or the shadow check
 * went blind (audit F7/P3-10) — it should import this one.
 */
export function claudeConfigDir() {
  const home = os.homedir();
  const expand = (p) => (p.startsWith("~/") || p.startsWith("~\\") ? path.join(home, p.slice(2)) : p);
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(expand(process.env.CLAUDE_CONFIG_DIR));
  try {
    const f = path.join(home, ".claude", "settings.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j?.env?.CLAUDE_CONFIG_DIR) return path.resolve(expand(j.env.CLAUDE_CONFIG_DIR));
  } catch { /* no user settings */ }
  return path.join(home, ".claude");
}

/**
 * Where a `code-review` skill would live: <claudeConfigDir()>/skills/code-review,
 * with CLAUDE_REVIEW_SKILL_DIR as the test override (the same two sources
 * claude.js resolves for the child — audit F7).
 */
export function userSkillDir() {
  if (process.env.CLAUDE_REVIEW_SKILL_DIR) return path.resolve(process.env.CLAUDE_REVIEW_SKILL_DIR);
  return path.join(claudeConfigDir(), "skills", "code-review");
}

export function bundledSkillFile() {
  return fileURLToPath(new URL("../assets/skills/code-review/SKILL.md", import.meta.url));
}

/**
 * @param {string} [dir] override for tests
 * @returns {"missing" | "bundled" | "user"}
 *  - missing: no SKILL.md in the directory
 *  - bundled: this server's marker is present -> a managed copy, safe to
 *             refresh (and to remove on uninstall)
 *  - user:    a SKILL.md without our marker -> user-managed, never touched
 * A managed copy that the user edited is still "bundled": the marker, not the
 * content, decides (see the header comment).
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
  let bundled = null;
  try {
    bundled = fs.readFileSync(bundledSkillFile());
    bundledBytes = bundled.length;
  } catch { /* bundled missing: cannot compare */ }
  if (status !== "missing") {
    try {
      const installed = fs.readFileSync(path.join(dir, "SKILL.md"));
      installedBytes = installed.length;
      upToDate = bundled !== null && installed.equals(bundled);
    } catch { /* unreadable: treated as out of date */ }
  }
  return { status, upToDate, installedBytes, bundledBytes };
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 *
 * The skill file IS the pipeline, so a crash mid-write must never leave a
 * truncated SKILL.md behind (a half-written file still classifies as
 * "bundled"). rename(2) is atomic within a directory, and a temp file in the
 * same directory keeps it on one filesystem (audit P3-10).
 */
function writeAtomic(dest, data) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Install (or refresh) the bundled skill.
 *
 * A directory WITHOUT this server's marker is user-managed and is never
 * written (returns installed:false with a reason). A directory WITH the marker
 * is a managed copy and is refreshed whenever its content differs from the
 * bundled file — that is the only way a pipeline fix reaches an existing
 * install.
 *
 * Idempotent: an up-to-date copy is not rewritten and its marker keeps its
 * original timestamp (the marker records ownership, not the served content;
 * rewriting it on every call made a no-op install write to disk).
 *
 * @param {string} [dir] override for tests
 * @returns {{installed: boolean, changed?: boolean, dir?: string, from?: string, reason?: string}}
 */
export function installBundledSkill(dir = userSkillDir()) {
  const status = skillStatus(dir);
  if (status === "user") {
    return { installed: false, reason: `a skill without this server's marker already exists at ${dir}; it is user-managed and is never written` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "SKILL.md");
    const bundled = fs.readFileSync(bundledSkillFile());
    let changed = true;
    try {
      changed = !fs.readFileSync(dest).equals(bundled);
    } catch { /* not there yet */ }
    if (changed) writeAtomic(dest, bundled);
    const markerPath = path.join(dir, MARKER);
    // Write the marker when the copy changed OR when only a legacy marker is
    // there (an install from the old name), never merely because we ran.
    if (changed || !fs.existsSync(markerPath)) writeAtomic(markerPath, new Date().toISOString() + "\n");
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

/**
 * Remove a copy this server installed.
 *
 * Only the files this server wrote are removed (SKILL.md and the markers); the
 * directory may hold the user's own additions (references/, notes.md) and the
 * old recursive delete destroyed them (audit P2-9). Removing SKILL.md is what
 * un-shadows claude's built-in /code-review command, so the functional effect
 * is unchanged. The directory is removed only if that leaves it empty.
 */
export function uninstallBundledSkill(dir = userSkillDir()) {
  if (skillStatus(dir) !== "bundled") {
    return { uninstalled: false, reason: "no skill installed by this server (a user-managed skill is never removed)" };
  }
  const removed = [];
  for (const name of ["SKILL.md", MARKER, ...LEGACY_MARKERS]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { force: true }); removed.push(name); } catch { /* best effort */ }
  }
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty / already gone */ }
  return { uninstalled: true, dir, removed };
}
