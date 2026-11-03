#!/usr/bin/env node
/**
 * Agent Plugins v1.0.0 conformance (free, offline).
 *
 * The repository doubles as a portable Agent Plugin:
 *   plugin.json                     closed manifest, Agent Plugins 1.0.0
 *   mcp.json                        closed MCP config, same $schema version
 *   skills/code-review/SKILL.md     Agent Skills format (frontmatter + body)
 *
 * Why this exists: those three files are the only portable surface for
 * non-Claude-Code harnesses. A manifest typo is FATAL (clients reject the whole
 * plugin), and an invalid SKILL.md silently drops the skill while the MCP server
 * keeps working — neither failure is visible to any other suite, because every
 * other suite exercises the Claude Code path. The checks mirror the normative
 * rules (section numbers cite the Agent Plugins 1.0.0 specification) instead of
 * fetching the remote schemas, so this stays free and offline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

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
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(readText(rel));
const relInsideRoot = (p) => {
  const resolved = path.resolve(ROOT, p);
  const rootReal = fs.realpathSync(ROOT);
  let real;
  try { real = fs.realpathSync(resolved); } catch { real = resolved; }
  return real === rootReal || real.startsWith(rootReal + path.sep);
};

/** Minimal YAML frontmatter reader for the Agent Skills fields (no dependency). */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const unquote = (v) => {
    const t = v.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
    return t;
  };
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (value.trim() === "") {
      const map = {};
      for (let j = i + 1; j < lines.length; j++) {
        const sub = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[j]);
        if (!sub) break;
        map[sub[1]] = unquote(sub[2]);
        i = j;
      }
      out[key] = map;
    } else if (/^[>|][+-]?$/.test(value.trim())) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!/^\s+/.test(lines[j])) break;
        parts.push(lines[j].trim());
        i = j;
      }
      out[key] = parts.join(" ");
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

/* ---- 1. plugin.json: closed manifest (spec §5.2, §5.3, §5.5) ---- */
const pkg = readJson("package.json");
let plugin = null;
try {
  plugin = readJson("plugin.json");
  check("plugin.json parses as JSON", true, true);
} catch (e) {
  check("plugin.json parses as JSON", String(e?.message || e), "no error");
}
truthy("plugin.json is a top-level object", isPlainObject(plugin));
if (isPlainObject(plugin)) {
  check("plugin.json $schema is the Agent Plugins 1.0.0 identifier", plugin.$schema, PLUGIN_SCHEMA);
  const ALLOWED = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
  check("plugin.json has no unknown top-level fields", Object.keys(plugin).filter((k) => !ALLOWED.includes(k)), []);
  truthy("plugin.json name is a string", typeof plugin.name === "string");
  check("plugin.json name uses the allowed character set and has no -- or ..",
    typeof plugin.name === "string" && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(plugin.name) && !plugin.name.includes("--") && !plugin.name.includes(".."), true);
  truthy("plugin.json name is 1-64 characters", typeof plugin.name === "string" && plugin.name.length >= 1 && plugin.name.length <= 64);
  check("plugin.json name matches package.json name", plugin.name, pkg.name);
  check("plugin.json version matches package.json version", plugin.version, pkg.version);
  truthy("plugin.json version looks like SemVer", typeof plugin.version === "string" && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(plugin.version));
  check("plugin.json license matches package.json license", plugin.license, pkg.license);
  truthy("plugin.json description is a string", typeof plugin.description === "string");
  if (plugin.author !== undefined) {
    truthy("plugin.json author is an object with only name/email/url strings", isPlainObject(plugin.author) && Object.entries(plugin.author).every(([k, v]) => ["name", "email", "url"].includes(k) && typeof v === "string"));
  }
  if (plugin.keywords !== undefined) truthy("plugin.json keywords is an array of strings", Array.isArray(plugin.keywords) && plugin.keywords.every((k) => typeof k === "string"));
  if (plugin.extensions !== undefined) truthy("plugin.json extensions is an object", isPlainObject(plugin.extensions));
}

/* ---- 2. mcp.json: closed MCP configuration (spec §7.2.1) ---- */
let mcp = null;
try {
  mcp = readJson("mcp.json");
  check("mcp.json parses as JSON", true, true);
} catch (e) {
  check("mcp.json parses as JSON", String(e?.message || e), "no error");
}
truthy("mcp.json is a top-level object", isPlainObject(mcp));
if (isPlainObject(mcp)) {
  check("mcp.json has exactly $schema and mcpServers", Object.keys(mcp).sort(), ["$schema", "mcpServers"]);
  check("mcp.json $schema is the Agent Plugins 1.0.0 identifier", mcp.$schema, MCP_SCHEMA);
  if (isPlainObject(plugin)) {
    check("mcp.json targets the same Agent Plugins version as plugin.json",
      typeof plugin.$schema === "string" && typeof mcp.$schema === "string" && plugin.$schema.replace("plugin.schema.json", "") === mcp.$schema.replace("mcp.schema.json", ""), true);
  }
  truthy("mcp.json mcpServers is an object", isPlainObject(mcp.mcpServers));
  const servers = isPlainObject(mcp.mcpServers) ? Object.entries(mcp.mcpServers) : [];
  truthy("mcp.json declares at least one server", servers.length >= 1);
  for (const [name, server] of servers) {
    const where = `mcp.json server "${name}"`;
    truthy(`${where} is an object`, isPlainObject(server));
    if (!isPlainObject(server)) continue;
    const type = server.type;
    truthy(`${where} declares a known transport`, type === "stdio" || type === "streamable-http" || type === "sse");
    if (type === "stdio") {
      const ALLOWED_STDIO = ["type", "command", "args", "env", "cwd"];
      check(`${where} has no unknown stdio fields`, Object.keys(server).filter((k) => !ALLOWED_STDIO.includes(k)), []);
      truthy(`${where} command is a single executable token (bare name or ./path)`,
        typeof server.command === "string" && !/\s/.test(server.command) && (/^[A-Za-z0-9._+-]+$/.test(server.command) || server.command.startsWith("./")));
      if (typeof server.command === "string" && server.command.startsWith("./")) truthy(`${where} command stays inside the plugin root`, relInsideRoot(server.command));
      if (server.args !== undefined) truthy(`${where} args is an array of strings`, Array.isArray(server.args) && server.args.every((a) => typeof a === "string"));
      if (server.env !== undefined) {
        truthy(`${where} env is an object of strings`, isPlainObject(server.env) && Object.values(server.env).every((v) => typeof v === "string"));
        check(`${where} env does not set the reserved PLUGIN_ROOT/PLUGIN_DATA`,
          isPlainObject(server.env) ? Object.keys(server.env).filter((k) => k === "PLUGIN_ROOT" || k === "PLUGIN_DATA") : [], []);
      }
      if (server.cwd !== undefined) {
        const cwd = server.cwd;
        const valid = typeof cwd === "string" && (
          cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/") ||
          cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/") ||
          cwd.startsWith("./")
        );
        truthy(`${where} cwd uses an allowed form`, valid);
        if (typeof cwd === "string" && cwd.startsWith("./")) truthy(`${where} cwd stays inside the plugin root`, relInsideRoot(cwd));
      }
    } else {
      truthy(`${where} url is an absolute http(s) URL`, typeof server.url === "string" && /^https?:\/\//.test(server.url));
      if (server.headers !== undefined) truthy(`${where} headers is an object of strings`, isPlainObject(server.headers) && Object.values(server.headers).every((v) => typeof v === "string"));
    }
  }
}

/* ---- 3. skills/: fixed discovery location (spec §6.1, §7.1) + Agent Skills format ---- */
const skillsDir = path.join(ROOT, "skills");
truthy("skills/ exists and is a directory", fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory());
let discovered = [];
if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
  discovered = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, file: path.join(skillsDir, d.name, "SKILL.md") }))
    .filter((s) => fs.existsSync(s.file) && fs.statSync(s.file).isFile());
  truthy("skills/ contains at least one discoverable skill", discovered.length >= 1);
  check("the code-review skill is discoverable", discovered.map((s) => s.dir).includes("code-review"), true);
  for (const skill of discovered) {
    const where = `skills/${skill.dir}`;
    const text = fs.readFileSync(skill.file, "utf8");
    const fm = parseFrontmatter(text);
    truthy(`${where}/SKILL.md has YAML frontmatter`, fm !== null);
    if (!fm) continue;
    const ALLOWED_FM = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
    check(`${where} frontmatter has no unknown fields`, Object.keys(fm).filter((k) => !ALLOWED_FM.includes(k)), []);
    check(`${where} name matches the directory name`, fm.name, skill.dir);
    truthy(`${where} name is 1-64 lowercase alphanumerics/hyphens without -- or edge hyphens`,
      typeof fm.name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name) && fm.name.length <= 64);
    truthy(`${where} description is 1-1024 characters`, typeof fm.description === "string" && fm.description.length >= 1 && fm.description.length <= 1024);
    if (fm.compatibility !== undefined) truthy(`${where} compatibility is 1-500 characters`, typeof fm.compatibility === "string" && fm.compatibility.length >= 1 && fm.compatibility.length <= 500);
    if (fm.metadata !== undefined) truthy(`${where} metadata is a string-to-string map`, isPlainObject(fm.metadata) && Object.values(fm.metadata).every((v) => typeof v === "string"));
    // A YAML plain scalar cannot contain ": " — a real parser reads it as a
    // nested mapping and rejects the whole file, which silently drops the skill.
    // Quote the value or use a block scalar instead (this caught the first draft
    // of the 1.19.0 description, which the naive reader above accepted).
    const fmLines = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [])[1]?.split(/\r?\n/) || [];
    const ambiguous = fmLines
      .filter((l) => /^[A-Za-z0-9_-]+:\s+\S/.test(l))
      .filter((l) => {
        const value = l.replace(/^[A-Za-z0-9_-]+:\s*/, "").trim();
        if (/^(".*"|'.*')$/.test(value)) return false;
        if (/^[>|][+-]?$/.test(value)) return false;
        return value.includes(": ");
      });
    check(`${where} frontmatter values have no ambiguous ": " (YAML plain-scalar rule)`, ambiguous, []);
    const body = text.slice(text.indexOf("---", 4) + 3).trim();
    truthy(`${where} body is non-empty`, body.length > 0);
    truthy(`${where} body stays under 500 lines`, body.split(/\r?\n/).length < 500);
    truthy(`${where} body is read-only guidance (mentions the report contract)`, body.includes("## Code Review Summary") && body.includes("## Findings (N)"));
    truthy(`${where} resolves inside the plugin root`, relInsideRoot(path.relative(ROOT, skill.file)));
  }
}

/* ---- 4. the package ships the portable surface (npm files) ---- */
check("package.json files ships plugin.json", (pkg.files || []).includes("plugin.json"), true);
check("package.json files ships mcp.json", (pkg.files || []).includes("mcp.json"), true);
check("package.json files ships skills/", (pkg.files || []).includes("skills"), true);

/* ---- summary ---- */
console.log("");
if (failures.length === 0) {
  console.log(`ALL PASS: ${pass} passed, 0 failed`);
  process.exit(0);
}
for (const f of failures) console.log(`  - ${f}`);
console.log(`FAILURES: ${pass} passed, ${failures.length} failed`);
process.exit(1);
