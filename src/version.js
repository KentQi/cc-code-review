/**
 * Server version + a self-check for the one upgrade hazard an MCP server has.
 *
 * An stdio server keeps the modules it loaded at startup, while the guard hook
 * is spawned fresh from disk on every Bash call. Upgrading without restarting
 * the host therefore leaves the two versions disagreeing: the server's policy
 * lives in memory, the hook's comes from the new file, and the guard self-test
 * (correctly) refuses to run because they no longer agree. The failure is safe
 * but confusing, so this module makes "am I running the latest?" answerable
 * from inside the tool: compare the newest source mtime with the process start.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "1.15.1";

/**
 * @param {number} [now] injectable clock (tests)
 * @returns {{stale: boolean, startedAt?: string, newestSourceAt?: string|null, file?: string|null}}
 */
export function codeDrift(now = Date.now()) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = ["index.js", "claude.js", "shell-guard.js", "version.js"].map((f) => path.join(here, f));
    files.push(path.join(here, "..", "scripts", "pre-tool-hook.js"));
    const started = now - process.uptime() * 1000;
    let newest = 0;
    let newestFile = null;
    for (const f of files) {
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m > newest) { newest = m; newestFile = f; }
      } catch { /* a missing file is not a drift signal */ }
    }
    return {
      stale: newest > started + 2000,
      startedAt: new Date(started).toISOString(),
      newestSourceAt: newest ? new Date(newest).toISOString() : null,
      file: newestFile,
    };
  } catch {
    return { stale: false };
  }
}
