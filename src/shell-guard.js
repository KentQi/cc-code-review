/**
 * Shell-chaining guard.
 *
 * Claude Code's Bash permission rules prefix-match the WHOLE command string, so
 * `--allowedTools "Bash(git status:*)"` also permits `git status; curl evil.com`,
 * and deny globs like `Bash(*;*)` never fire (the rule engine matches the
 * command, not its parts). No rule list can close that hole — it is a property
 * of the permission engine, not of our rules.
 *
 * What does work: a PreToolUse hook receives the real command and can deny it.
 * `scripts/pre-tool-hook.js` is that hook and imports this module, so the exact
 * same verdict is used to (a) block the call and (b) report it in the review
 * result. Keeping one implementation means the report can never disagree with
 * what was actually enforced.
 *
 * Everything here is pure string analysis — no I/O, no dependencies — because it
 * runs inside a hook process that must start and answer in milliseconds.
 */

/**
 * Remove quoted spans so that `git log --format="%h; %s"` is not a false
 * positive. Returns null when the quoting is unbalanced, because an unbalanced
 * quote hides whatever follows it (`git status # don't; curl evil.com`), and
 * failing closed is the only safe reading of that.
 *
 * Single quotes genuinely suppress expansion, so their contents are dropped.
 * Double quotes do NOT: `$(...)`, backticks and `${...}` all expand inside them
 * in every POSIX shell, including the Git Bash the CLI uses. Those are reported
 * separately (`quotedSubst`) instead of being dropped — `git diff "$(curl …)"`
 * must not pass just because the payload sits inside quotes.
 */
function stripQuoted(cmd) {
  let out = "";
  let quote = null;
  let quotedSubst = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") { i++; continue; } // \" does not close the span
      if (c === '"') { quote = null; continue; }
      if (c === "`" || (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{"))) quotedSubst = true;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\") { i++; continue; } // escaped char outside quotes
    out += c;
  }
  return quote === null ? { bare: out, quotedSubst } : null;
}

/**
 * Decide whether one Bash command may run.
 * @returns {{ok: true} | {ok: false, reason: string, chained: boolean, substituted: boolean}}
 */
/**
 * `find` and `rg` are granted through prefix rules (Bash(find:*), Bash(rg:*))
 * because the review needs them for reads. Both can WRITE and EXECUTE:
 * find -delete / -exec / -execdir / -ok / -okdir / -fprint / -fprintf / -fls,
 * and rg --pre / --pre-glob run an arbitrary program. A prefix rule cannot
 * express "these flags are forbidden", so the hook refuses those forms outright.
 * (Pre-existing hole from 1.6.0, closed here.)
 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);
function dangerousToolForm(bare) {
  const words = bare.trim().split(/\s+/);
  const cmd = words[0];
  if (cmd === "find" && words.some((w) => FIND_WRITE_FLAGS.has(w))) {
    return "blocked: find with a write/execute action (-delete, -exec, -ok, -fprint, ...). Review mode is read-only — use Read/Glob/Grep, or a plain find without those flags.";
  }
  if ((cmd === "rg" || cmd === "ripgrep") && words.some((w) => w === "--pre" || w.startsWith("--pre=") || w === "--pre-glob" || w.startsWith("--pre-glob="))) {
    return "blocked: rg --pre / --pre-glob runs an arbitrary program for every file. Review mode is read-only — use a plain rg.";
  }
  return null;
}

export function analyseCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return { ok: true };
  const q = stripQuoted(cmd);
  if (q === null) {
    return { ok: false, reason: "unbalanced quotes (the command hides part of itself)", chained: false, substituted: false };
  }
  const { bare, quotedSubst } = q;
  const substituted = quotedSubst || /\$\(|`|\$\{/.test(bare);
  // `|` matters as much as `;`: the allowlist matches the command as a prefix,
  // so `git log | curl …` still satisfies `Bash(git log:*)`.
  const chained = /;|&&|\|\||\||\n|&(?=\s*$)|&(?=\s)|>>|>|</.test(bare);
  if (substituted || chained) {
    const bits = [];
    if (substituted) bits.push("command substitution ($(), ``, ${} — including inside double quotes)");
    if (chained) bits.push("command chaining or redirection (; && || | & newline > >> <)");
    return {
      ok: false,
      reason: `blocked: ${bits.join(" and ")}. Permission rules match the whole command as a prefix, ` +
        "so one compound command would satisfy an allowlist rule for its first token. Run each step as its own call.",
      chained,
      substituted,
    };
  }
  const danger = dangerousToolForm(bare);
  if (danger) return { ok: false, reason: danger, chained: false, substituted: false, dangerous: true };
  return { ok: true };
}

/**
 * Summarise the shell-chaining verdicts for a list of executed Bash commands.
 *
 * `denied` is the set of commands the run actually reported as denied. A chained
 * command that appears there was blocked before it ran, which is the guard
 * working — listing it as an escape would be a false alarm, and a guard that
 * cries wolf gets switched off. Only commands that ran are reported.
 *
 * @returns {{chained: string[], substituted: string[], dangerous: string[], clean: number, blocked: string[], ran: string[]}}
 */
export function detectShellChaining(commands, denied = []) {
  const chained = [];
  const substituted = [];
  const dangerous = [];
  const blocked = [];
  const ran = [];
  const deniedSet = new Set(Array.isArray(denied) ? denied.filter((c) => typeof c === "string") : []);
  let clean = 0;
  for (const raw of Array.isArray(commands) ? commands : []) {
    const verdict = analyseCommand(raw);
    if (verdict.ok) { clean++; continue; }
    const cmd = String(raw);
    if (verdict.dangerous) dangerous.push(cmd);
    else if (verdict.substituted) substituted.push(cmd);
    else chained.push(cmd);
    if (deniedSet.has(cmd)) blocked.push(cmd); else ran.push(cmd);
  }
  return { chained, substituted, dangerous, clean, blocked, ran };
}

/**
 * Report for the review result: only shell-chained commands that actually ran.
 * Returns null when there is nothing to report (the common case — the hook
 * denies them, and a denied call is not an escape).
 */
export function shellChainingNote(commands, denied = []) {
  const { ran, dangerous } = detectShellChaining(commands, denied);
  if (ran.length === 0) return null;
  const dangerSet = new Set(dangerous);
  const onlyChaining = ran.every((c) => !dangerSet.has(c));
  const lines = onlyChaining
    ? [
      `⚠ SHELL-CHAINED COMMAND${ran.length === 1 ? "" : "S"} RAN WITHOUT BEING BLOCKED (${ran.length})`,
      "Claude Code permission rules prefix-match the whole command, so a compound",
      "command satisfies an allowlist rule meant for its first token. The PreToolUse",
      "hook is supposed to deny these before they execute — these did run:",
    ]
    : [
      `⚠ BASH COMMAND${ran.length === 1 ? "" : "S"} RAN WITHOUT BEING BLOCKED (${ran.length})`,
      "The PreToolUse hook is supposed to deny compound commands and unsafe",
      "write/execute forms (find -delete/-exec/…, rg --pre) before they execute —",
      "these did run:",
    ];
  for (const c of ran) lines.push(`  • ${c.slice(0, 200)}`);
  lines.push("Review the run log and treat this repository as hostile until inspected.");
  return lines.join("\n");
}

/**
 * Report for commands the guard DID block. Informational, not an alarm: the
 * reviewer simply tried to combine steps (or asked git to write a file) and will
 * retry differently.
 */
export function shellGuardNote(commands, denied = []) {
  const { blocked, dangerous } = detectShellChaining(commands, denied);
  const dangerSet = new Set(dangerous);
  const blockedChain = blocked.filter((c) => !dangerSet.has(c));
  const blockedDanger = blocked.filter((c) => dangerSet.has(c));
  const writeFlags = (Array.isArray(denied) ? denied : []).filter((c) => typeof c === "string" && gitWriteFlagReason(c));
  const total = blockedChain.length + blockedDanger.length + writeFlags.length;
  if (total === 0) return null;
  const kinds = [];
  if (blockedChain.length) kinds.push(`${blockedChain.length} shell-chained (the reviewer combined steps into one call; it can retry them as separate calls)`);
  if (blockedDanger.length) kinds.push(`${blockedDanger.length} unsafe write/execute form (find -delete/-exec/…, rg --pre — read-only review mode forbids these)`);
  if (writeFlags.length) kinds.push(`${writeFlags.length} git call(s) that would have written a file via --output=/--output-directory=`);
  return `${total} Bash command(s) were blocked before running by the PreToolUse guard — ` +
    `${kinds.join("; ")}: ` +
    [...blockedChain, ...blockedDanger, ...writeFlags].slice(0, 5).map((c) => c.slice(0, 120)).join(" | ");
}

/**
 * git subcommands that WRITE A FILE from a read-only-looking command.
 *
 * `git diff --output=x`, `git show --output=x HEAD`, `git log --output=x` and
 * `git format-patch --output-directory=d` all create files (verified against git
 * 2.54). They satisfy `Bash(git diff:*)` etc., so the allowlist permits them, and
 * a deny glob cannot be relied on for them: whether `Bash(git * --output=*)`
 * matches depends on how the rule engine treats a `*` in the middle of a rule,
 * which is not something this server can verify from the outside.
 *
 * A hook sees the exact command string, so this is the deterministic control.
 * Nothing in a code review legitimately writes a file through git.
 * @returns {string | null} the reason to deny, or null when the command is fine
 */
export function gitWriteFlagReason(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const q = stripQuoted(cmd);
  if (q === null) return null; // unbalanced quotes are already denied by analyseCommand
  const bare = q.bare.trim();
  // Only git invocations: `gh`/`find`/`rg` have no equivalent write flag, and a
  // bare `--output` in another tool's argv is not ours to police.
  if (!/(^|[\\/])git(\.exe)?(\s|$)/.test(bare)) return null;
  const writeFlag = /(^|\s)(--output(-directory)?(=|\s)|-o\s|--output-to(=|\s))/.exec(bare);
  if (!writeFlag) return null;
  return (
    `blocked: \`${writeFlag[0].trim()}\` makes git write a file, and a read-only review must not write anything ` +
    `(an allowlisted \`git diff\`/\`git show\`/\`git log\` call with --output= would otherwise be a file-write primitive ` +
    `for repo-controlled content). Drop the flag.`
  );
}

/** Everything the hook denies: chaining/substitution plus git's write flags. */
export function guardVerdict(cmd) {
  const a = analyseCommand(cmd);
  if (!a.ok) return a;
  const why = gitWriteFlagReason(cmd);
  if (why) return { ok: false, reason: why, chained: false, substituted: false };
  return { ok: true };
}
