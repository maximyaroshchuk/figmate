#!/usr/bin/env node
// Figmate local daemon: HTTP -> WebSocket -> the Figma plugin -> back.
//
//   node local/figmate-local.js            # http://127.0.0.1:8787
//   node local/figmate-local.js --port 9000
//
// Same contract as the Cloudflare Worker, minus the multi-user half: no
// tokens, no pairing, one anonymous plugin slot, loopback only. Nothing to
// install — Node's standard library covers HTTP, and the WebSocket server
// below is the ~120 lines of RFC 6455 the plugin actually uses.
//
//   POST /exec      {"code": "...", "timeout": 60} -> {ok, result, value, logs, elapsed_ms}
//   GET  /status    -> {plugin_connected, pending, user, mode}
//   WS   /plugin    the plugin's connection (a token, if sent, is ignored)

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

const ERROR_HINTS = require(path.join(__dirname, "..", "shared", "error-hints.json"));

const VERSION = "1.0";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY = 8 * 1024 * 1024;      // an /exec body is code, never megabytes
const MAX_MESSAGE = 16 * 1024 * 1024;  // a spec of a huge subtree can be ~1 MB
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function findHint(errorText) {
  if (!errorText) return null;
  const low = String(errorText).toLowerCase();
  for (const [needle, hint] of ERROR_HINTS) {
    if (low.includes(needle.toLowerCase())) return hint;
  }
  return null;
}

function parseArgs(argv) {
  const options = { port: Number(process.env.FIGMATE_PORT) || DEFAULT_PORT, host: DEFAULT_HOST, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      console.error("unknown argument: " + arg);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    console.error("--port expects a number between 1 and 65535");
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log([
    "figmate local daemon " + VERSION,
    "",
    "  node local/figmate-local.js [--port 8787] [--host 127.0.0.1] [--quiet]",
    "",
    "Keep the default port unless you also add the new one to",
    "plugin/manifest.json allowedDomains and re-import the plugin in Figma.",
  ].join("\n"));
  process.exit(0);
}

function log(...parts) {
  if (!options.quiet) console.log("[figmate]", ...parts);
}

// ── the single plugin connection ─────────────────────────────────────────────
// One developer, one Figma, one slot. A second connection is treated as the
// same plugin reconnecting (Figma reopened, laptop woke up): it takes the slot
// and the previous socket is dropped.
let plugin = null;
const pending = new Map(); // request id -> {resolve, logs, t0}

function failPending(reason) {
  for (const [rid, entry] of pending) entry.resolve({ id: rid, type: "error", text: reason });
  pending.clear();
}

function onPluginMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch (err) { return; }
  if (message.type === "hello" || message.type === "pong") return;

  const entry = pending.get(message.id);
  if (!entry) return; // a late reply to a request that already timed out

  if (message.type === "log") entry.logs.push(message.text || "");
  else if (message.type === "result" || message.type === "error") entry.resolve(message);
}

// ── WebSocket server (RFC 6455, the text-frame subset) ───────────────────────
function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode, never fragmented on the way out
  return Buffer.concat([header, payload]);
}

function acceptSocket(socket, key) {
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "", "",
  ].join("\r\n"));

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);

  const connection = {
    socket,
    alive: true,
    send(text) {
      if (!this.alive) return false;
      try {
        socket.write(frame(0x1, Buffer.from(text, "utf8")));
        return true;
      } catch (err) {
        return false;
      }
    },
    close(code, reason) {
      if (!this.alive) return;
      this.alive = false;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason || ""));
      payload.writeUInt16BE(code, 0);
      if (reason) payload.write(reason, 2);
      try { socket.write(frame(0x8, payload)); } catch (err) {}
      socket.end();
    },
  };

  let buffer = Buffer.alloc(0);
  let fragments = [];

  const fail = (code, reason) => {
    log("plugin dropped:", reason);
    connection.close(code, reason);
  };

  const deliver = (payload) => {
    onPluginMessage(payload.toString("utf8"));
  };

  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const wide = buffer.readBigUInt64BE(offset);
        offset += 8;
        if (wide > BigInt(MAX_MESSAGE)) return fail(1009, "frame too large");
        length = Number(wide);
      }
      if (masked && buffer.length < offset + 4) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) return fail(1000, "plugin closed the socket");
      if (opcode === 0x9) {
        try { socket.write(frame(0xA, payload)); } catch (err) {}
        continue;
      }
      if (opcode === 0xA) continue;

      // Figma's client splits large sends across frames, so a message is
      // whatever arrives between a non-FIN opener and its FIN continuation.
      if (opcode === 0x0) {
        if (!fragments.length) return fail(1002, "continuation without a start frame");
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = [];
          deliver(whole);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) deliver(payload);
        else fragments = [payload];
        continue;
      }
      return fail(1002, "unsupported opcode " + opcode);
    }
  });

  const gone = () => {
    connection.alive = false;
    if (plugin === connection) {
      plugin = null;
      failPending("plugin disconnected");
      log("plugin gone — reopen Figmate Bridge in Figma (⌥⌘P)");
    }
  };
  socket.on("close", gone);
  socket.on("error", gone);

  return connection;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function send(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

// A page in a browser can reach a loopback port, so answer only requests that
// address the daemon by its own name — the same guard the old bridge used.
function hostAllowed(hostHeader) {
  const host = String(hostHeader || "").toLowerCase();
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function exec(request, response) {
  if (!plugin || !plugin.alive) {
    return send(response, 503, {
      ok: false,
      error: "plugin not connected — open Figmate Bridge in Figma (⌥⌘P)",
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (err) {
    return send(response, 400, { ok: false, error: "invalid JSON body" });
  }

  const code = body.code;
  if (typeof code !== "string" || !code.trim()) {
    return send(response, 400, { ok: false, error: "missing or empty 'code'" });
  }

  const timeoutSec = Math.min(Number(body.timeout) || 60, 300);
  const rid = crypto.randomUUID();
  const started = Date.now();
  const logs = [];
  const answered = new Promise((resolve) => pending.set(rid, { resolve, logs, t0: started }));

  log("exec", rid.slice(0, 8), code.length + "b");
  if (!plugin.send(JSON.stringify({ id: rid, type: "exec", code }))) {
    pending.delete(rid);
    return send(response, 500, { ok: false, error: "send to plugin failed" });
  }

  let timer;
  const result = await Promise.race([
    answered,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutSec * 1000); }),
  ]);
  clearTimeout(timer);
  pending.delete(rid);

  const elapsed = Date.now() - started;

  if (result === null) {
    log("exec", rid.slice(0, 8), "timeout after " + timeoutSec + "s");
    return send(response, 504, { ok: false, error: "timeout after " + timeoutSec + "s" });
  }

  if (result.type === "error") {
    const errorText = result.text || "unknown error";
    log("exec", rid.slice(0, 8), "error in " + elapsed + "ms:", errorText);
    return send(response, 500, {
      ok: false,
      error: errorText,
      hint: findHint(errorText),
      stack: result.stack || null,
      logs,
      elapsed_ms: elapsed,
    });
  }

  log("exec", rid.slice(0, 8), "ok in " + elapsed + "ms");
  return send(response, 200, {
    ok: true,
    result: result.text || "",
    value: result.value === undefined ? null : result.value,
    logs,
    elapsed_ms: elapsed,
  });
}

const server = http.createServer((request, response) => {
  if (!hostAllowed(request.headers.host)) {
    return send(response, 403, { ok: false, error: "loopback only — address the daemon as localhost" });
  }

  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    const body = [
      "figmate local daemon " + VERSION,
      "",
      "  POST /exec     {\"code\": \"...\"}",
      "  GET  /status",
      "  WS   /plugin   (the Figma plugin connects here)",
      "",
      "Figma:       plugin window -> gear -> Use local daemon",
      "Claude Code: export FIGMATE_SERVER=http://" + options.host + ":" + options.port,
      "",
    ].join("\n");
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end(body);
  }

  if (request.method === "GET" && url.pathname === "/status") {
    return send(response, 200, {
      plugin_connected: Boolean(plugin && plugin.alive),
      pending: pending.size,
      user: "local",
      mode: "local",
      version: VERSION,
    });
  }

  if (url.pathname === "/exec") {
    if (request.method !== "POST") return send(response, 405, { ok: false, error: "use POST" });
    return exec(request, response);
  }

  return send(response, 404, { ok: false, error: "not found" });
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://localhost");
  const key = request.headers["sec-websocket-key"];
  const wantsWebsocket = String(request.headers.upgrade || "").toLowerCase() === "websocket";

  if (url.pathname !== "/plugin" || !wantsWebsocket || !key || !hostAllowed(request.headers.host)) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }

  const previous = plugin;
  const connection = acceptSocket(socket, key);
  plugin = connection;

  if (previous && previous.alive) {
    // The plugin reconnected while the old socket still looked open: its
    // in-flight requests belong to a window that is gone.
    failPending("plugin reconnected mid-request");
    previous.close(1012, "superseded");
  }
  log("plugin connected");
});

server.on("clientError", (err, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("[figmate] port " + options.port + " is busy — a daemon may already be running.");
    console.error("[figmate] check it: curl -s http://" + DEFAULT_HOST + ":" + options.port + "/status");
  } else {
    console.error("[figmate] " + err.message);
  }
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  const base = "http://" + options.host + ":" + options.port;
  log("local daemon " + VERSION + " on " + base);
  log("Figma:       plugin window → gear → Use local daemon");
  log("Claude Code: export FIGMATE_SERVER=" + base);
  log("waiting for the plugin…");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    failPending("daemon stopped");
    if (plugin) plugin.close(1001, "daemon stopped");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200);
  });
}

