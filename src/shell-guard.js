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
 *     permission engine cannot drift), or be a pipe sink (head/tail/cat/grep/sort/…);
 *   - `cd` is allowed only as the first segment and only when it resolves to
 *     the reviewed repository root, where every Bash call already starts;
 *   - redirection, command substitution (including bare $VAR), and unbalanced
 *     quotes stay refused;
 *   - find/rg write or execute flags and git's --output writers stay refused
 *     on the segment that carries them.
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
import crypto from "node:crypto";

/** Tools that only read their stdin: allowed after a pipe, never as command 1.
 *  No sed: its script language writes (w/W), executes (e) and reads (r) files in
 *  forms no parser caught in audit (a sed "execute" command ran on this machine).
 *  head/tail cover the line-range need; the rest goes through Read.
 *
 *  This set is the single source for the sink list: ALLOWED_HINT is rendered
 *  from it and the set is exported so tests can assert the hook's surface.
 *  Adding/removing a sink here is the only edit needed in this module — but
 *  the human-facing copies (assets/skills/code-review/SKILL.md, README) are
 *  separate documents and must be updated by whoever owns them. */
export const PIPE_SINKS = new Set(["head", "tail", "cat", "wc", "uniq", "cut", "tr", "grep", "sort"]);

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
      // Reviewer subagents explore with these; refusing them burned turns in a
      // real max run (36 denials across the fleet). `git branch` also writes
      // (-d/-D/-m/-f/…), so it is a prefix rule with a flag guard.
      { words: ["ls-tree"] },
      {
        words: ["branch"],
        // `git branch <name>` CREATES a branch (a write with no flag to match),
        // so this prefix is only safe when it carries flags and nothing else.
        requireFlagsOnly: true,
        // -u is the short form of --set-upstream-to: it rewrites .git/config,
        // so it belongs here even when its value is glued on (-uorigin/main).
        denyFlags: ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-t", "-u", "--delete", "--move", "--copy",
          "--force", "--track", "--edit-description", "--set-upstream", "--set-upstream-to", "--unset-upstream-to", "--unset-upstream"],
      },
    ],
  },
  { prog: "find", prefixes: [{ words: [] }] },
  { prog: "rg", prefixes: [{ words: [] }] },
  // Read-only explorers. Both carry the same in-repo path check as find/rg, and
  // neither can write — `ls` lists, `grep` prints matches.
  { prog: "ls", prefixes: [{ words: [] }] },
  { prog: "grep", prefixes: [{ words: [] }] },
  // `echo` reads nothing and writes nothing: it only prints its arguments, so
  // it is the one harmless separator a reviewer reaches for in a compound call
  // (`git show HEAD && echo "=====" && git log`). Refusing it burned a turn in a
  // real run and protected nothing.
  { prog: "echo", prefixes: [{ words: [] }] },
  {
    prog: "gh",
    prefixes: [
      { words: ["pr", "view"] }, { words: ["pr", "diff"] }, { words: ["pr", "list"] },
      { words: ["pr", "checks"] }, { words: ["repo", "view"] },
      // postToPR=true instructs the reviewer to post the summary and grants
      // Bash(gh pr comment:*) through postPROnlyTools(). The hook is subtract-only,
      // so it must not refuse the very command that grant authorises — but the rule
      // must stay OUT of the default permission render, or every review could post.
      { words: ["pr", "comment"], postOnly: true },
    ],
  },
];

/**
 * A stable hash of every table that decides a verdict.
 *
 * An stdio server keeps the policy it loaded at startup while the hook is spawned
 * fresh from disk on every Bash call. After an upgrade without a restart the two
 * disagree — the server believes one policy, the hook enforces another — and the
 * self-test used to pass anyway because its probes are structural. The hook
 * exposes this fingerprint (CC_REVIEW_GUARD_INFO=1) so the self-test can compare
 * the two and refuse to run on a mismatch, which is what README/SECURITY promise.
 */
export function policyFingerprint() {
  const canon = JSON.stringify({
    policy: BASH_POLICY,
    pipes: [...PIPE_SINKS],
    flags: FLAG_KINDS,
    deny: OUTRIGHT_DENY,
    findWrite: [...FIND_WRITE_FLAGS],
    segments: MAX_SEGMENTS,
  });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** The permission-engine rules for BASH_POLICY, e.g. "Bash(git status:*)". */
export function bashAllowRules() {
  const rules = [];
  for (const { prog, prefixes } of BASH_POLICY) {
    for (const p of prefixes) {
      // postOnly rules exist for the hook (which only subtracts) and are granted
      // to the model separately, by postPROnlyTools() when the caller asked to post.
      if (p.postOnly) continue;
      const head = [prog, ...p.words].join(" ");
      rules.push(p.exact ? `Bash(${head})` : `Bash(${head}:*)`);
    }
  }
  return rules;
}

const MAX_SEGMENTS = 8;

const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

/**
 * Does cmd[i] start an expansion bash performs BEFORE the command runs?
 * Covers command substitution (`...`, $(...), ${...}) and a bare $NAME /
 * positional / special parameter. A bare variable is the concrete credential
 * leak this models: `echo $ANTHROPIC_API_KEY` reaches the guard as that text
 * but runs as `echo <the key>`. Single quotes are literal (callers skip
 * them); double quotes expand, so they are checked too.
 */
function startsExpansion(cmd, i) {
  if (cmd[i] === "`") return true;
  if (cmd[i] !== "$") return false;
  const next = cmd[i + 1] || "";
  return next === "(" || next === "{" || /[A-Za-z0-9_@*#?$!-]/.test(next);
}

/**
 * Split a shell command into simple-command segments without running anything.
 * Quote-aware: `git log --format="%h; %s"` is ONE segment. Reports the first
 * construct that makes the command unsafe regardless of the policy.
 *
 * @returns {{segs: {words: string[]}[], ops: string[], unsafe: null|"redirection"|"substitution"|"unbalanced"|"ansi-quoting"}}
 */
function parseCommand(cmd) {
  const segs = [];
  const ops = [];
  let words = [];
  let quoted = [];        // parallel to words: was any part of this word quote-protected?
  let word = "";
  let wordQuoted = false;
  let inWord = false;
  let quote = null;
  let unsafe = null;

  const endWord = () => {
    if (inWord) { words.push(word); quoted.push(wordQuoted); word = ""; inWord = false; wordQuoted = false; }
  };
  const endSeg = (op) => {
    endWord();
    if (words.length) { segs.push({ words, quoted }); words = []; quoted = []; }
    if (op) ops.push(op);
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote !== null) wordQuoted = true; // any character that arrives inside quotes is literal
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        // Inside double quotes POSIX only removes the backslash before these
        // four characters — and before a newline, which it deletes entirely
        // (line continuation). That matters on Windows: "C:\Users\x" keeps its
        // backslashes, so `cd` can be resolved for real.
        const next = cmd[i + 1];
        if (next === "\n") { i++; continue; }
        if (next === '"' || next === "\\" || next === "$" || next === "`") { word += next; i++; continue; }
        word += c;
        continue;
      }
      if (c === '"') { quote = null; continue; }
      // Double quotes still expand $VAR / $(...) / `...`: quoting changes word
      // splitting, not substitution, so the same check applies here.
      if (startsExpansion(cmd, i)) unsafe = unsafe || "substitution";
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; wordQuoted = true; continue; }
    if (c === "$" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      // ANSI-C quoting ($'...') and locale quoting ($"...") are expanded by bash
      // BEFORE the command runs: $'-exec' is the argv word -exec. The parser only
      // models plain quotes, so every token-exact deny table below would be blind
      // to the flag hidden inside. Refuse the construct outright — a review has no
      // legitimate use for either form.
      unsafe = unsafe || "ansi-quoting";
      word += c;
      inWord = true;
      continue;
    }
    if (c === "\\") {
      // Outside quotes bash deletes the backslash and keeps the next character
      // literal: \-exec becomes -exec, \--output= becomes --output=. The old
      // code kept the backslash for path-ish characters (Windows paths), which
      // made the parser's token differ from bash's argv and hid every flag behind
      // an escape. The argv view is what executes, so it is what must be judged;
      // quoted Windows paths keep their backslashes through the double-quote rule
      // above, which is how the model writes them.
      const next = cmd[i + 1];
      if (next === "\n") { i++; continue; }          // line continuation: both gone
      if (next !== undefined) { word += next; i++; inWord = true; wordQuoted = true; }
      continue;
    }
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
    if (startsExpansion(cmd, i)) unsafe = unsafe || "substitution";
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
      return { rule, prefix: p };
    }
  }
  return null;
}

/**
 * Flags that consume the next token, per program, and what that token is:
 *   "pattern" — a regex/script, not a filesystem path
 *   "path"    — a filesystem path (must stay inside the repo)
 *   "skip"    — a value that is neither (a glob, a count, an encoding…)
 * Any flag not listed here is treated as self-contained (`-x`, `--foo=bar`).
 * This table exists so a pattern like `rg '/api/v1'` is not mistaken for a path
 * while `rg -f /home/u/patterns` still is one.
 */
const FLAG_KINDS = {
  rg: {
    "-e": "pattern", "--regexp": "pattern",
    "-f": "path", "--file": "path", "--ignore-file": "path",
    "-g": "skip", "--glob": "skip", "-t": "skip", "--type": "skip", "-T": "skip", "--type-not": "skip",
    "-m": "skip", "--max-count": "skip", "-A": "skip", "-B": "skip", "-C": "skip",
    "--context": "skip", "--after-context": "skip", "--before-context": "skip",
    "-j": "skip", "--threads": "skip", "--color": "skip", "--colors": "skip",
    "--encoding": "skip", "--engine": "skip", "--sort": "skip", "--sortr": "skip",
    "--type-add": "skip", "--type-clear": "skip", "--max-columns": "skip", "--max-filesize": "skip",
    "-E": "skip", "--dfa-size-limit": "skip", "--regex-size-limit": "skip",
    "-r": "skip", "--replace": "skip", "--path-separator": "skip", "--max-depth": "skip",
    "--pre": "skip", "--pre-glob": "skip",
  },
  grep: {
    "-e": "pattern", "--regexp": "pattern",
    "-f": "path", "--file": "path",
    "-m": "skip", "--max-count": "skip", "-A": "skip", "-B": "skip", "-C": "skip",
    "--context": "skip", "--after-context": "skip", "--before-context": "skip",
    "-d": "skip", "--directories": "skip", "-D": "skip", "--devices": "skip",
    "--include": "skip", "--exclude": "skip", "--exclude-dir": "skip",
    "--label": "skip", "--binary-files": "skip", "--color": "skip", "--colour": "skip",
    "--group-separator": "skip", "--initial-tab": "skip",
  },
  // find's expression starts at the first flag, so a file-reference
  // predicate such as -newer never reached the leading-path loop. The
  // expression pass in pathArgs checks these through this table (audit P2-2).
  find: {
    "-newer": "path", "-anewer": "path", "-cnewer": "path", "-samefile": "path",
  },
  // tr is the only pipe sink whose operands were never path-checked (audit
  // P0-2). Its -d/-s/-c families take a character SET, not a file, so that
  // value is skipped; every other operand falls through to the positional
  // path check below.
  tr: {
    "-d": "skip", "--delete": "skip",
    "-s": "skip", "--squeeze-repeats": "skip",
    "-c": "skip", "-C": "skip", "--complement": "skip",
  },
  // echo reads nothing, but bash expands globs and ~ before it runs (audit
  // P0-1), so every positional is checked against the repository like a read.
  echo: {},
  cat: {},
  ls: { "--block-size": "skip", "-I": "skip", "--ignore": "skip", "--time-style": "skip", "--format": "skip", "-w": "skip", "--width": "skip", "--color": "skip", "--quoting-style": "skip", "--sort": "skip" },
  head: { "-n": "skip", "--lines": "skip", "-c": "skip", "--bytes": "skip" },
  tail: {
    "-n": "skip", "--lines": "skip", "-c": "skip", "--bytes": "skip",
    "-s": "skip", "--sleep-interval": "skip", "--pid": "skip",
  },
  sort: {
    "-k": "skip", "--key": "skip", "-t": "skip", "--field-separator": "skip",
    "-S": "skip", "--buffer-size": "skip", "-T": "skip", "--temporary-directory": "skip",
    "--random-source": "skip", "--batch-size": "skip", "--compress-program": "skip",
    "--files0-from": "skip",
  },
  uniq: {
    "-f": "skip", "--skip-fields": "skip", "-s": "skip", "--skip-chars": "skip",
    "-w": "skip", "--check-chars": "skip",
  },
  cut: {
    "-d": "skip", "--delimiter": "skip", "-f": "skip", "--fields": "skip",
    "-b": "skip", "--bytes": "skip", "-c": "skip", "--characters": "skip",
    "--output-delimiter": "skip",
  },
  wc: { "--files0-from": "skip" },
};

/** Flags whose very existence is a read outside the tree. */
const OUTRIGHT_DENY = {
  git: {
    "--no-index": "`git diff --no-index` reads arbitrary paths outside the repository",
    "--contents": "`git blame --contents` reads an arbitrary file outside the repository",
    "-X": "`git ls-files -X` reads a path list from an arbitrary file outside the repository",
    "--exclude-from": "`git ls-files --exclude-from` reads a path list from an arbitrary file outside the repository",
  },
  wc: {
    "--files0-from": "`wc --files0-from` follows a list of paths that may point outside the repository",
  },
  sort: {
    "--files0-from": "`sort --files0-from` follows a list of paths that may point outside the repository",
    "--random-source": "`sort --random-source` reads an arbitrary file outside the repository",
  },

  rg: {
    "--pre": "`rg --pre` runs an arbitrary program",
    "--pre-glob": "`rg --pre-glob` runs an arbitrary program",
  },
};

/**
 * The tokens of one segment that name filesystem paths.
 * Program-specific because `rg FOO`'s first positional is a pattern, and
 * `find`'s leading paths are followed by an expression whose predicates may
 * themselves name files (-newer, -samefile).
 */
function pathArgs(words) {
  const prog = words[0];
  const rest = words.slice(1);
  if (prog === "find") {
    // find [options] [paths...] [expression] — the leading tokens are the
    // start paths; once the expression begins, only file-reference predicates
    // name files (-newer FILE, -samefile FILE). Both forms must be checked:
    // the old loop stopped at the first flag, so `find . -newer /etc/passwd`
    // never reached the path check (audit P2-2).
    const out = [];
    let i = 0;
    for (; i < rest.length; i++) {
      const t = rest[i];
      if (t === "-H" || t === "-L" || t === "-P") continue;
      if (t === "-D" || t === "-O") { i++; continue; } // their value
      if (t.startsWith("-") || t === "(" || t === "!" || t === "\\(") break;
      out.push({ value: t });
    }
    const kinds = FLAG_KINDS.find;
    for (; i < rest.length; i++) {
      const t = rest[i];
      // -newerXY references a file unless Y is `t` (then the value is a date
      // string, not a path).
      if (kinds[t] !== "path" && !/^-newer[aBcm][aBcm]$/.test(t)) continue;
      const v = rest[i + 1];
      if (typeof v === "string") { out.push({ value: v }); i++; }
    }
    return out;
  }
  // Programs whose arguments are never filesystem paths. git/gh report paths
  // from the repository itself; every other program (echo and tr included)
  // goes through FLAG_KINDS so its operands get the in-repo path check.
  if (prog === "git" || prog === "gh" || prog === "echo") return [];
  const kinds = FLAG_KINDS[prog];
  if (!kinds) return [];
  const out = [];
  let patternSeen = false;
  let positional = 0;
  // `rg --files [path]` lists files: there is no pattern argument, so every
  // positional is a path. Without this the first positional was skipped as "the
  // pattern" and `rg --files /etc` enumerated an outside directory.
  const noPattern = prog === "rg" && rest.some((t) => t === "--files");
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") {
      for (let j = i + 1; j < rest.length; j++) out.push({ value: rest[j] });
      break;
    }
    if (t.startsWith("-") && t !== "-") {
      const eq = t.indexOf("=");
      let name = eq >= 0 ? t.slice(0, eq) : t;
      let inline = eq >= 0 ? t.slice(eq + 1) : null;
      // Short options may carry their value glued on (-f/etc/passwd, -o/tmp/x).
      // The old code treated any "-xVALUE" as a self-contained flag, so the value
      // never reached the path check and the flag never reached the deny table —
      // an escape hatch for every program with a value-taking short option.
      if (eq < 0 && !name.startsWith("--") && name.length > 2) {
        const short = name.slice(0, 2);
        if (kinds[short]) { name = short; inline = t.slice(2); }
      }
      const kind = kinds[name];
      if (kind === "path") {
        const v = inline !== null ? inline : rest[++i];
        if (typeof v === "string") out.push({ value: v });
        if (name === "-f" || name === "--file") patternSeen = true;
        continue;
      }
      if (kind === "pattern") {
        if (inline === null) i++;
        patternSeen = true;
        continue;
      }
      if (kind === "skip") {
        if (inline === null) i++;
        continue;
      }
      continue; // self-contained flag
    }
    positional++;
    // The first positional of rg/grep is a pattern, not a path.
    const takesPattern = (prog === "rg" || prog === "grep") && positional === 1 && !patternSeen && !noPattern;
    if (takesPattern) continue;
    out.push({ value: t });
  }
  return out;
}

let cachedRoot = null;
/** Realpath of the reviewed root, cached for the hook process. */
function repoRealpath(root) {
  const key = path.resolve(root);
  if (cachedRoot && cachedRoot.key === key) return cachedRoot.value;
  let value = null;
  try { value = fs.realpathSync(key); } catch { value = null; }
  cachedRoot = { key, value };
  return value;
}

/**
 * Is `token` inside the reviewed repository? Lexical containment is not enough:
 * a repo may contain `link -> C:\Users\victim\.ssh`, which is "inside" lexically
 * and elsewhere on disk — so the deepest existing ancestor is realpathed, the
 * same rule the write/read scoping uses.
 */
export function isInsideRepo(root, token) {
  if (typeof token !== "string" || !token) return true;
  if (token.startsWith("~")) return false;           // shell expands to $HOME
  if (token.includes("$")) return false;             // cannot be resolved statically
  // Brace expansion turns one lexically-safe token into several paths
  // ({..,/etc}, {~/x,y}) — the shell resolves them before the command runs.
  if (token.includes("{") || token.includes("}")) return false;
  const realRoot = repoRealpath(root);
  if (!realRoot) return false;
  // An absolute token must be resolved against itself, not against the root: a
  // repo reached through a symlinked prefix (macOS /tmp and /var are symlinks)
  // has a real root of /private/var/..., while the model writes the path it was
  // given. path.resolve(realRoot, "/var/...") keeps the absolute path, so the
  // lexical check below saw "outside" and refused every legitimate read. The
  // realpath pass at the end is the authority for both forms.
  const absolute = path.isAbsolute(token);
  const target = absolute ? path.resolve(token) : path.resolve(realRoot, token);
  if (!absolute) {
    const rel = path.relative(realRoot, target);
    if (!rel) return true;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  }
  // Resolve links for the part that exists.
  let probe = target;
  for (;;) {
    let real;
    try {
      real = fs.realpathSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
      continue;
    }
    const tail = path.relative(probe, target);
    const full = tail ? path.join(real, tail) : real;
    const r = path.relative(realRoot, full);
    return !r || (!r.startsWith("..") && !path.isAbsolute(r));
  }
}

/** A segment may only read inside the reviewed repository. */
function pathProblem(words, repoRoot) {
  if (!repoRoot) return null; // standalone use: the hook always supplies it
  for (const { value } of pathArgs(words)) {
    if (isInsideRepo(repoRoot, value)) continue;
    return `blocked: \`${words[0]}\` may only read inside the reviewed repository — \`${value}\` resolves outside it. ` +
      "Scope the command to the repo (run it with `.` or a repo-relative path, or use the Grep/Glob tools).";
  }
  return null;
}

/** Flags that are a read outside the tree no matter what they point at. */
function outrightDeny(words) {
  const table = OUTRIGHT_DENY[words[0]];
  if (!table) return null;
  for (const w of words) {
    let name = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
    let why = table[name];
    // Glued short option (-X/etc/passwd): the value never becomes a separate
    // token, so the table has to see the two-character form.
    if (!why && /^-[^-]./.test(w)) { name = w.slice(0, 2); why = table[name]; }
    if (why) return `blocked: ${why}. Review mode is read-only and scoped to the repository.`;
  }
  return null;
}

/**
 * Everything a permitted segment must still not do: write/execute flags, reads
 * that escape the repository, and the one sink form that writes (uniq's second
 * positional). Applied to both policy commands and pipe sinks.
 * @returns {string | null}
 */
function segmentProblem(words, repoRoot, quoted = []) {
  const prog = words[0];

  const outright = outrightDeny(words);
  if (outright) return outright;

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
  if (prog === "echo") {
    // Bash performs tilde and pathname expansion BEFORE echo runs: `echo ~/*`
    // prints the home listing and `echo ../*` the parent listing, so the
    // operand the guard sees is not the one that executes. A review only
    // needs literal text; refuse the expansion instead of checking a pattern
    // that no longer describes the output (audit P0-1).
    // Only UNQUOTED operands expand: `echo *` lists the cwd, but `echo "*"` prints
    // a star and `echo 'price: $5'` prints text. The tokenizer records which words
    // were quote-protected, so the legitimate literal form is not refused.
    const expands = words.slice(1).find((w, i) => !quoted[i + 1] && (w.startsWith("~") || /[?*\[\]]/.test(w)));
    if (expands) {
      return `blocked: \`echo ${expands}\` is expanded by the shell before echo runs (a glob or ~ enumerates files the review must not list). Echo literal text without wildcards or ~; use the Read/Grep/Glob tools for file contents.`;
    }
  }
  if (prog === "sort") {
    // -oFILE / -TFILE (value glued to the short option) are the same write and
    // temp-dir escapes as their spaced forms; match the tight spelling too or the
    // only file-write primitive left in the policy stays open.
    const bad = words.find((w) =>
      w === "-o" || w === "-T" || w.startsWith("--output") || w.startsWith("--compress-program") ||
      w.startsWith("--temporary-directory") || /^-[A-Za-z]*[oT]./.test(w));
    if (bad) {
      return "blocked: sort -o/--compress-program/--temporary-directory write files or run a program outside the reviewed repository. Review mode is read-only.";
    }
  }
  if (prog === "uniq" && pathArgs(words).length >= 2) {
    return "blocked: `uniq` takes an output file as its second argument. Review mode is read-only — pipe it and let the result go to stdout.";
  }

  const scope = pathProblem(words, repoRoot);
  if (scope) return scope;

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
  "git remote -v|get-url|show, git stash list|show, find, rg, ls, grep, echo, " +
  "gh pr view|diff|list|checks, gh repo view — " +
  // Rendered from PIPE_SINKS, so the model-facing hint and the enforced sink
  // set cannot drift apart (audit P2-8).
  "and after a pipe: " + [...PIPE_SINKS].join(", ") + ". " +
  "For file contents use the Read/Grep/Glob tools instead of cat/head/tail; sed is not a permitted sink.";

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
  if (parsed.unsafe === "ansi-quoting") {
    return {
      ok: false, kind: "substituted",
      reason: "blocked: ANSI-C / locale quoting ($'...' or $\"...\"). Bash expands it before the command runs, so a flag hidden inside " + "(e.g. $\"-exec\") never reaches the allowlist checks. Write the flag plainly, or use the Read/Grep/Glob tools.",
      chained: false, substituted: true,
    };
  }
  if (parsed.unsafe === "substitution") {
    return {
      ok: false, kind: "substituted",
      reason: "blocked: variable or command substitution ($VAR, $(), ``, ${} — including inside double quotes). " +
        "Bash expands it before any permission check, so it would read host values (credentials, paths) or run a " +
        "nested command the allowlist never saw. Review mode is read-only and scoped to the repository — write a " +
        "literal value, or use the Read/Grep tools.",
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

    const match = matchPolicy(words);
    if (match) {
      // A prefix rule can be read-only in most forms and a write in a few
      // (`git branch`): the per-prefix flag guard is what makes the prefix safe.
      // A bare positional after `git branch` creates a branch: every remaining
      // token must be a flag.
      //
      // Denied flags come first: `git branch -u origin/main` also carries a
      // non-flag operand, so the flags-only check below would refuse it for the
      // wrong reason. A short option may glue its value on
      // (-uorigin/main, -torigin/main); without the attached-form match the
      // flag never reached this table and `git branch -u<ref>` rewrote
      // .git/config in read-only mode (audit P2-11).
      const banned = (match.prefix.denyFlags || []).find((flag) =>
        words.some((w) =>
          w === flag ||
          w.startsWith(flag + "=") ||
          (/^-[^-]$/.test(flag) && w.length > flag.length && w.startsWith(flag))));
      if (banned) {
        return {
          ok: false, kind: "dangerous",
          reason: "blocked: `" + [words[0], ...match.prefix.words, banned].join(" ") +
            "` writes (it changes branches or refs). Review mode is read-only — list branches instead (`git branch -a`).",
          chained, substituted: false, dangerous: true,
        };
      }
      if (match.prefix.requireFlagsOnly) {
        const operand = words.slice(match.prefix.words.length + 1).find((w) => !w.startsWith("-"));
        if (operand) {
          return {
            ok: false, kind: "dangerous",
            reason: "blocked: `" + [words[0], ...match.prefix.words, operand].join(" ") +
              "` creates a branch (a write). Review mode is read-only — list branches instead (`git branch -a`).",
            chained, substituted: false, dangerous: true,
          };
        }
      }
      const why = segmentProblem(words, opts.repoRoot, segs[i].quoted);
      if (why) return { ok: false, kind: "dangerous", reason: why, chained, substituted: false, dangerous: true };
      continue;
    }

    // A pipe sink consumes stdin only; it is never a valid first command.
    if (i > 0 && ops[i - 1] === "|" && PIPE_SINKS.has(words[0])) {
      const why = segmentProblem(words, opts.repoRoot, segs[i].quoted);
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
export function detectShellChaining(commands, denied = [], opts = {}) {
  const chained = [];
  const substituted = [];
  const dangerous = [];
  const unlisted = [];
  const blocked = [];
  const ran = [];
  const deniedSet = new Set(Array.isArray(denied) ? denied.filter((c) => typeof c === "string") : []);
  let clean = 0;
  for (const raw of Array.isArray(commands) ? commands : []) {
    const verdict = analyseCommand(raw, opts);
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
export function shellChainingNote(commands, denied = [], opts = {}) {
  const { ran } = detectShellChaining(commands, denied, opts);
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
export function shellGuardNote(commands, denied = [], opts = {}) {
  const { blocked, dangerous, unlisted, substituted } = detectShellChaining(commands, denied, opts);
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
