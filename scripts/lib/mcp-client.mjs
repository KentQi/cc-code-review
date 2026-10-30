#!/usr/bin/env node
/**
 * Minimal stdio MCP client shared by the test suites (audit Q20).
 *
 * Before this module, six scripts each carried their own ~30-line copy of the
 * same JSON-RPC client, and the copies had already drifted: cross-cases filtered
 * stdout lines that do not start with "{" while smoke/validation logged them,
 * and the request timeouts ranged from 30s to 15min. One copy means a framing
 * fix (multi-byte characters split across chunks, a response that arrives after
 * the server exits, a timeout that must not leak its timer) lands everywhere.
 *
 * Deliberately NOT the SDK's StdioClientTransport: these suites must keep
 * working with the checkout's own package.json resolution rules and must stay
 * dependency-free (a suite that cannot even start is not a gate). The SDK client
 * remains the right choice for the product.
 *
 * Contract:
 *   const srv = connectServer({ args: [serverPath], env, timeoutMs: 60_000 });
 *   await srv.initialize();                 // initialize + notifications/initialized
 *   const res = await srv.call("tool_name", { ... });   // tools/call
 *   const raw = await srv.request("tools/list", {});    // any JSON-RPC request
 *   const { id, response } = srv.startRequest("tools/call", params, { timeoutMs: 90_000 });
 *   srv.notify("notifications/cancelled", { requestId: id, reason: "..." });
 *   srv.close();
 *
 * Behavioural notes:
 *  - stdout is framed on "\n" and decoded per line, so a multi-byte character
 *    split across two chunks is still decoded correctly (the old copies all did
 *    this; the comment in smoke-test explains why).
 *  - A request that times out resolves its internal promise with null and
 *    REJECTS the awaited request() with a timeout error. startRequest() exposes
 *    the raw promise (null, never a rejection) because the MCP SDK legitimately
 *    drops the response for a cancelled request — cancel-test relies on that.
 *  - close() kills the child and settles every pending request with null, so a
 *    suite cannot hang on a server that died mid-call.
 */
import { spawn } from "node:child_process";

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/**
 * @param {object} opts
 * @param {string} [opts.command] executable (default: this node)
 * @param {string[]} opts.args argv for the server (usually [serverEntry])
 * @param {NodeJS.ProcessEnv} [opts.env] full env; omit to inherit
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs] default per-request timeout (60s)
 * @param {{name:string,version:string}} [opts.clientInfo]
 * @param {string} [opts.protocolVersion]
 * @param {boolean} [opts.requireJsonObjectPrefix] ignore non-JSON stdout lines
 *        instead of reporting them (cross-cases logs from the server's own
 *        stderr are inherited, but some hosts print startup banners on stdout)
 * @param {(line:string, err:Error)=>void} [opts.onUnparseable] called for each
 *        non-JSON stdout line; defaults to silence
 * @param {("pipe"|"inherit"|"ignore")[]} [opts.stdio] default pipe/pipe/inherit
 */
export function connectServer({
  command = process.execPath,
  args,
  env,
  cwd,
  timeoutMs = 60_000,
  clientInfo = { name: "mcp-client", version: "0.0.1" },
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  requireJsonObjectPrefix = false,
  onUnparseable,
  stdio = ["pipe", "pipe", "inherit"],
} = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError("connectServer needs args (the MCP server entry file)");
  }
  const child = spawn(command, args, {
    stdio,
    ...(cwd ? { cwd } : {}),
    // Omit env entirely when not given: passing process.env explicitly would
    // also work, but inheriting is what the old copies did and it keeps the
    // child's environment byte-identical.
    ...(env ? { env } : {}),
  });

  let buf = Buffer.alloc(0);
  let nextId = 0;
  let closed = false;
  /** id -> { resolve: (msg|null) => void, timer } */
  const pending = new Map();

  const settle = (id, msg) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  };
  const settleAll = () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  };

  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]); // decode once per line boundary: multi-byte chars may straddle chunks
    let idx;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      if (requireJsonObjectPrefix && !line.startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id != null) settle(msg.id, msg);
      } catch (err) {
        if (onUnparseable) onUnparseable(line, err);
      }
    }
  });
  child.stdin.on("error", () => { /* server went away; the pending timers decide */ });
  child.on("exit", () => { closed = true; settleAll(); });

  const post = (obj) => {
    if (closed) throw new Error("MCP client is closed");
    child.stdin.write(JSON.stringify(obj) + "\n");
  };

  const notify = (method, params) => {
    post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  };

  /**
   * Send a request and expose its raw response promise. The promise resolves to
   * the JSON-RPC message, or null on timeout / close — never rejects.
   */
  const startRequest = (method, params, opts = {}) => {
    const id = ++nextId;
    const waitMs = opts.timeoutMs ?? timeoutMs;
    const response = new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, null), waitMs);
      // Do not keep the event loop alive just for a request timer: a suite that
      // already has its answer must be able to exit even with a stray 90s timer.
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, timer });
    });
    post({ jsonrpc: "2.0", id, method, params });
    return { id, response };
  };

  /** Await one JSON-RPC response; throws on timeout or a closed connection. */
  const request = async (method, params, opts = {}) => {
    const { response } = startRequest(method, params, opts);
    const msg = await response;
    if (msg === null) throw new Error(`timeout waiting for ${method} (server closed or no reply)`);
    return msg;
  };

  /** MCP initialize + notifications/initialized. */
  const initialize = async (extra = {}) => {
    const res = await request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo,
      ...extra,
    });
    notify("notifications/initialized");
    return res;
  };

  const close = () => {
    closed = true;
    settleAll();
    try { child.kill(); } catch { /* already gone */ }
  };

  return {
    child,
    /** raw id -> pending map size (diagnostics only) */
    get pendingCount() { return pending.size; },
    send: post,
    notify,
    startRequest,
    request,
    call: (name, callArgs, opts) => request("tools/call", { name, arguments: callArgs }, opts),
    initialize,
    close,
  };
}

export default connectServer;
