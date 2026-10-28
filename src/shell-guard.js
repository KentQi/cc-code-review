/**
 * Shell guard — segment-level policy for the reviewer's Bash calls.
 *
 * Why this exists at all: Claude Code's Bash permission rules prefix-match the
 * WHOLE command string, so `--allowedTools "Bash(git status:*)"` also permits
 * `git status; curl evil.com`, and deny globs like `Bash(*;*)` never fire (the
 * rule engine matches the command, not its parts). No rule list can close that
 * hole — it is a property of the permission engine, not of our rules.
 *
 * What the engine CAN express is the gate: the first command of the string must
 * match an allowlist rule, otherwise the call never runs. What it cannot
 * express is "every command in this string is allowed". That is this module's
 * job, and the reason it does not simply reject chaining:
 *
 *   Denying all compound commands looked safe but pushed the reviewer into
 *   wasted turns. `cd <repo> && git show HEAD` is what models naturally write,
 *   and each rejection burned a turn without reducing risk — the same two
 *   commands run one-per-call are allowed. What actually matters is whether
 *   EACH SEGMENT is a permitted, read-only command with no redirection and no
 *   substitution. That is what this module now decides:
 *
 *   - every segment must match BASH_POLICY (the same list reviewAllowedTools()
 *     renders as Bash(...) rules — one source of truth, so the hook and the
 *     permission engine cannot drift), or be a pipe sink (head/tail/sed -n/…);
 *   - `cd` is allowed only as the first segment and only when it resolves to
 *     the reviewed repository root, where every Bash call already starts;
 *   - redirection, command substitution and unbalanced quotes stay refused;
 *   - find/rg write or execute flags, git's --output writers and sed -i stay
 *     refused on the segment that carries them.
 *
 * Verified against claude 2.1.311's own code: a PreToolUse hook may return
 * "deny" or "ask", but an "allow" is stripped by the CLI's output sanitizer
 * (`permissionDecision==="deny"||==="ask"?…:void 0`). So the hook can only
 * subtract; it can never grant. `Bash(cd:*)` is therefore in the allowlist to
 * let the shape through the engine's gate, while this module enforces what the
 * gate cannot.
 *
 * Everything below is pure string analysis apart from resolving `cd` against
 * the real filesystem (realpath), which is needed to know where it would land.
 */
import fs from "node:fs";
import path from "node:path";

/** Tools that only read their stdin: allowed after a pipe, never as command 1. */
const PIPE_SINKS = new Set(["head", "tail", "cat", "wc", "uniq", "cut", "tr", "grep", "sort", "sed"]);

/**
 * The Bash surface of a review. `exact` entries must match word-for-word (the
 * CLI rule for them has no `:*`), the rest are prefix matches. This is the
 * single source of truth: reviewAllowedTools() renders these as Bash(...) rules.
 */
export const BASH_POLICY = [
  {
    prog: "git",
    prefixes: [
      { words: ["status"] }, { words: ["diff"] }, { words: ["show"] }, { words: ["log"] },
      { words: ["blame"] }, { words: ["rev-parse"] }, { words: ["ls-files"] },
      { words: ["branch", "-a"], exact: true },
      { words: ["branch", "--show-current"], exact: true },
      { words: ["branch", "-vv"], exact: true },
      { words: ["remote", "-v"], exact: true },
      { words: ["remote", "get-url"] }, { words: ["remote", "show"] },
      { words: ["stash", "list"] }, { words: ["stash", "show"] },
    ],
  },
  { prog: "find", prefixes: [{ words: [] }] },
  { prog: "rg", prefixes: [{ words: [] }] },
  {
    prog: "gh",
    prefixes: [
      { words: ["pr", "view"] }, { words: ["pr", "diff"] }, { words: ["pr", "list"] },
      { words: ["pr", "checks"] }, { words: ["repo", "view"] },
    ],
  },
];

/** The permission-engine rules for BASH_POLICY, e.g. "Bash(git status:*)". */
export function bashAllowRules() {
  const rules = [];
  for (const { prog, prefixes } of BASH_POLICY) {
    for (const p of prefixes) {
      const head = [prog, ...p.words].join(" ");
      rules.push(p.exact ? `Bash(${head})` : `Bash(${head}:*)`);
    }
  }
  return rules;
}

const MAX_SEGMENTS = 8;

const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

/**
 * Split a shell command into simple-command segments without running anything.
 * Quote-aware: `git log --format="%h; %s"` is ONE segment. Reports the first
 * construct that makes the command unsafe regardless of the policy.
 *
 * @returns {{segs: {words: string[]}[], ops: string[], unsafe: null|"redirection"|"substitution"|"unbalanced"}}
 */
function parseCommand(cmd) {
  const segs = [];
  const ops = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  let unsafe = null;

  const endWord = () => {
    if (inWord) { words.push(word); word = ""; inWord = false; }
  };
  const endSeg = (op) => {
    endWord();
    if (words.length) { segs.push({ words }); words = []; }
    if (op) ops.push(op);
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        // Inside double quotes POSIX only removes the backslash before these
        // four characters. That matters on Windows: "C:\Users\x" keeps its
        // backslashes, so `cd` can be resolved for real.
        const next = cmd[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") { word += next; i++; continue; }
        word += c;
        continue;
      }
      if (c === '"') { quote = null; continue; }
      if (c === "`" || (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{"))) unsafe = unsafe || "substitution";
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\") { if (i + 1 < cmd.length) { word += cmd[++i]; inWord = true; } continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "\n" || c === ";") { endSeg(";"); continue; }
    if (c === "&") {
      if (cmd[i + 1] === "&") { i++; endSeg("&&"); } else endSeg("&");
      continue;
    }
    if (c === "|") {
      if (cmd[i + 1] === "|") { i++; endSeg("||"); } else endSeg("|");
      continue;
    }
    if (c === ">" || c === "<") { unsafe = unsafe || "redirection"; continue; }
    if (c === "`" || (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{"))) unsafe = unsafe || "substitution";
    word += c;
    inWord = true;
  }
  if (quote !== null) return { segs: [], ops: [], unsafe: "unbalanced" };
  endSeg(null);
  return { segs, ops, unsafe };
}

/** Does this segment match one of BASH_POLICY's rules for its program? */
function matchPolicy(words) {
  const prog = words[0];
  for (const rule of BASH_POLICY) {
    if (rule.prog !== prog) continue;
    for (const p of rule.prefixes) {
      if (p.words.length > words.length - 1) continue;
      if (!p.words.every((w, i) => words[i + 1] === w)) continue;
      if (p.exact && words.length !== p.words.length + 1) continue;
      return rule;
    }
  }
  return null;
}

/** Write/execute flags that a permitted program must still not carry. */
function segmentProblem(words) {
  const prog = words[0];
  if (prog === "find" && words.some((w) => FIND_WRITE_FLAGS.has(w))) {
    return "blocked: find with a write/execute action (-delete, -exec, -ok, -fprint, ...). Review mode is read-only — use Read/Glob/Grep, or a plain find without those flags.";
  }
  if (prog === "rg" && words.some((w) => w === "--pre" || w.startsWith("--pre=") || w === "--pre-glob" || w.startsWith("--pre-glob="))) {
    return "blocked: rg --pre / --pre-glob runs an arbitrary program for every file. Review mode is read-only — use a plain rg.";
  }
  if (prog === "git") {
    const write = gitWriteFlagIn(words);
    if (write) {
      return `blocked: \`${write}\` makes git write a file, and a read-only review must not write anything (an allowlisted \`git diff\`/\`git show\`/\`git log\` call with --output= would otherwise be a file-write primitive for repo-controlled content). Drop the flag.`;
    }
  }
  return null;
}

/** A pipe sink may only ever consume stdin; a few of them can still write. */
function sinkProblem(words) {
  const prog = words[0];
  if (prog === "sort" && words.some((w) => w === "-o" || w.startsWith("--output"))) {
    return "blocked: `sort -o` writes a file. Review mode is read-only — drop the flag.";
  }
  if (prog === "sed") {
    if (words.some((w) => w === "-i" || w.startsWith("-i.") || w.startsWith("--in-place"))) {
      return "blocked: `sed -i` rewrites files in place. Review mode is read-only — drop -i.";
    }
    // sed scripts can write (w / W), execute (e) or read (r) files. Select by
    // line range and print: that is the only form a review needs.
    const script = words.slice(1).filter((w) => !w.startsWith("-")).join(" ");
    if (/(^|[\s;{}0-9,])[wWe]\s/.test(script) || /\$[wWe]/.test(script)) {
      return "blocked: this sed script uses a w/W/e command, which writes a file or runs a program. Use a line-range print (`sed -n '1,120p'`).";
    }
  }
  return null;
}

/**
 * `cd` is a no-op in a review: every Bash call already starts in the repo root.
 * It is allowed only when it resolves there, and only as the first segment —
 * anything else is a mistake worth refusing rather than silently obeying.
 * @returns {string | null}
 */
function cdProblem(words, repoRoot) {
  if (words[0] !== "cd") return null;
  if (words.length !== 2) return "blocked: `cd` must name exactly the reviewed repository root. Every Bash call already starts there, so the simplest fix is to drop `cd` entirely.";
  if (!repoRoot) return "blocked: `cd` is only allowed to the reviewed repository root, and the guard was not told which directory that is. Drop `cd` — every Bash call already starts there.";
  const target = words[1];
  let want, got;
  try {
    want = fs.realpathSync(path.resolve(repoRoot));
  } catch {
    return "blocked: cannot resolve the reviewed repository root; `cd` is refused (drop it — every Bash call already starts there).";
  }
  try {
    // Relative targets resolve against the repo root, which is the cwd.
    got = fs.realpathSync(path.resolve(want, target));
  } catch {
    return `blocked: \`cd ${target}\` does not resolve to an existing directory inside the reviewed repository` +
      (target.includes("\\") ? "" : " (an unquoted Windows path loses its backslashes in the shell — quote it or use forward slashes)") +
      ". Drop `cd` — every Bash call already starts at the repository root.";
  }
  const same = process.platform === "win32" ? got.toLowerCase() === want.toLowerCase() : got === want;
  if (!same) {
    return `blocked: \`cd ${target}\` leaves the reviewed repository. Every Bash call already starts at the repository root (${want}), so drop \`cd\` and use paths relative to it.`;
  }
  return null;
}

function gitWriteFlagIn(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^--output(-directory)?=/.test(w) || /^--output-to=/.test(w)) return w.split("=")[0] + "=";
    if (w === "--output" || w === "--output-directory" || w === "--output-to") return `${w} `;
    if (w === "-o") return "-o ";
  }
  return null;
}

const ALLOWED_HINT =
  "Allowed commands: git status|diff|show|log|blame|rev-parse|ls-files, git branch -a|--show-current|-vv, " +
  "git remote -v|get-url|show, git stash list|show, find, rg, gh pr view|diff|list|checks, gh repo view — " +
  "and after a pipe: head, tail, cat, wc, uniq, cut, tr, grep, sort, sed -n. " +
  "For file contents use the Read/Grep/Glob tools instead of cat/head/tail.";

/**
 * Decide whether one Bash command may run.
 * @param {string} cmd
 * @param {{repoRoot?: string}} [opts]
 * @returns {{ok: true, chained?: boolean} | {ok: false, reason: string, kind: string, chained: boolean, substituted: boolean, dangerous?: boolean}}
 */
export function analyseCommand(cmd, opts = {}) {
  if (typeof cmd !== "string" || !cmd.trim()) return { ok: true };
  const parsed = parseCommand(cmd);
  if (parsed.unsafe === "unbalanced") {
    return { ok: false, kind: "quote", reason: "blocked: unbalanced quotes (the command hides part of itself).", chained: false, substituted: false };
  }
  if (parsed.unsafe === "redirection") {
    return {
      ok: false, kind: "redirection",
      reason: "blocked: redirection (< > >>). A redirect is a file read/write primitive that bypasses the allowlist — " +
        "read with the Read/Grep tools and let the command write to stdout.",
      chained: false, substituted: false,
    };
  }
  if (parsed.unsafe === "substitution") {
    return {
      ok: false, kind: "substituted",
      reason: "blocked: command substitution ($(), ``, ${} — including inside double quotes). The substitution runs " +
        "before any permission check, so it would execute a command the allowlist never saw.",
      chained: false, substituted: true,
    };
  }
  const { segs, ops } = parsed;
  if (!segs.length) return { ok: true };
  const chained = segs.length > 1;
  if (ops.includes("&")) {
    return {
      ok: false, kind: "chained",
      reason: "blocked: background execution (&). The review needs the command's output before the next step, and a background job would return an empty result.",
      chained, substituted: false,
    };
  }
  if (segs.length > MAX_SEGMENTS) {
    return { ok: false, kind: "chained", reason: `blocked: ${segs.length} commands in one call (limit ${MAX_SEGMENTS}). Split the work into a few calls.`, chained: true, substituted: false };
  }

  for (let i = 0; i < segs.length; i++) {
    const { words } = segs[i];
    const label = words.join(" ").slice(0, 140);

    const cdWhy = cdProblem(words, opts.repoRoot);
    if (cdWhy) return { ok: false, kind: "cd", reason: cdWhy, chained, substituted: false };
    if (words[0] === "cd") {
      if (i !== 0) {
        return { ok: false, kind: "cd", reason: "blocked: `cd` is only allowed as the first command of a call. Drop it — every Bash call already starts at the repository root.", chained, substituted: false };
      }
      if (ops[i] === "|") {
        return { ok: false, kind: "cd", reason: "blocked: `cd` cannot be piped. Drop it — every Bash call already starts at the repository root.", chained, substituted: false };
      }
      continue;
    }

    if (matchPolicy(words)) {
      const why = segmentProblem(words);
      if (why) return { ok: false, kind: "dangerous", reason: why, chained, substituted: false, dangerous: true };
      continue;
    }

    // A pipe sink consumes stdin only; it is never a valid first command.
    if (i > 0 && ops[i - 1] === "|" && PIPE_SINKS.has(words[0])) {
      const why = sinkProblem(words);
      if (why) return { ok: false, kind: "dangerous", reason: why, chained, substituted: false, dangerous: true };
      continue;
    }

    return {
      ok: false, kind: "unlisted",
      reason: `blocked: \`${label}\` is not part of the review's Bash surface. ${ALLOWED_HINT}`,
      chained, substituted: false,
    };
  }

  return { ok: true, chained };
}

/**
 * Summarise the guard verdicts for a list of executed Bash commands.
 *
 * `denied` is the set of commands the run actually reported as denied. A
 * command that appears there was blocked before it ran, which is the guard
 * working — listing it as an escape would be a false alarm, and a guard that
 * cries wolf gets switched off. Only commands that ran are reported.
 *
 * @returns {{chained: string[], substituted: string[], dangerous: string[], unlisted: string[], clean: number, blocked: string[], ran: string[]}}
 */
export function detectShellChaining(commands, denied = []) {
  const chained = [];
  const substituted = [];
  const dangerous = [];
  const unlisted = [];
  const blocked = [];
  const ran = [];
  const deniedSet = new Set(Array.isArray(denied) ? denied.filter((c) => typeof c === "string") : []);
  let clean = 0;
  for (const raw of Array.isArray(commands) ? commands : []) {
    const verdict = analyseCommand(raw);
    if (verdict.ok) { clean++; continue; }
    const cmd = String(raw);
    if (verdict.dangerous) dangerous.push(cmd);
    else if (verdict.kind === "substituted") substituted.push(cmd);
    else if (verdict.kind === "unlisted") unlisted.push(cmd);
    else chained.push(cmd);
    if (deniedSet.has(cmd)) blocked.push(cmd); else ran.push(cmd);
  }
  return { chained, substituted, dangerous, unlisted, clean, blocked, ran };
}

/**
 * Report for the review result: only commands that should have been blocked but
 * actually ran. Returns null when there is nothing to report (the common case —
 * the hook denies them, and a denied call is not an escape).
 */
export function shellChainingNote(commands, denied = []) {
  const { ran } = detectShellChaining(commands, denied);
  if (ran.length === 0) return null;
  const lines = [
    `⚠ ${ran.length === 1 ? "BASH COMMAND" : "BASH COMMANDS"} RAN WITHOUT BEING BLOCKED (${ran.length})`,
    "Every segment of a Bash call is supposed to match the review's read-only policy before it runs.",
    "The PreToolUse hook should have denied these — they did run:",
  ];
  for (const c of ran) lines.push(`  • ${c.slice(0, 200)}`);
  lines.push("Review the run log and treat this repository as hostile until inspected.");
  return lines.join("\n");
}

/**
 * Report for commands the guard DID block. Informational, not an alarm: the
 * reviewer asked for something outside the surface and can retry differently.
 */
export function shellGuardNote(commands, denied = []) {
  const { blocked, dangerous, unlisted, substituted } = detectShellChaining(commands, denied);
  const total = blocked.length;
  if (total === 0) return null;
  const dangerSet = new Set(dangerous);
  const unlistedSet = new Set(unlisted);
  const subSet = new Set(substituted);
  const kinds = [];
  const count = (set) => blocked.filter((c) => set.has(c)).length;
  const nUnlisted = count(unlistedSet);
  const nDanger = count(dangerSet);
  const nSub = count(subSet);
  const nOther = total - nUnlisted - nDanger - nSub;
  if (nUnlisted) kinds.push(`${nUnlisted} call(s) used a program or flag outside the review's read-only surface (the reviewer can retry with an allowed command or the Read/Grep tools)`);
  if (nDanger) kinds.push(`${nDanger} call(s) used a write/execute form (find -delete/-exec, rg --pre, sed -i, sort -o, git --output=…), which review mode forbids`);
  if (nSub) kinds.push(`${nSub} call(s) used command substitution, which would run a command the allowlist never saw`);
  if (nOther) kinds.push(`${nOther} call(s) were malformed or over the segment limit`);
  return `${total} Bash command(s) were blocked before running by the PreToolUse guard — ` +
    `${kinds.join("; ")}: ` +
    blocked.slice(0, 5).map((c) => c.slice(0, 120)).join(" | ");
}

/**
 * Why a git command would write a file, or null. Exported for the report paths
 * that classify a denial after the fact.
 */
export function gitWriteFlagReason(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const parsed = parseCommand(cmd);
  if (parsed.unsafe) return null;
  for (const { words } of parsed.segs) {
    if (words[0] !== "git") continue;
    const flag = gitWriteFlagIn(words);
    if (flag) {
      return `blocked: \`${flag.trim()}\` makes git write a file, and a read-only review must not write anything. Drop the flag.`;
    }
  }
  return null;
}

/** Everything the hook denies. */
export function guardVerdict(cmd, opts = {}) {
  return analyseCommand(cmd, opts);
}
