// Figmate on Cloudflare Workers: HTTP -> Durable Object -> Figma plugin -> back.
//
//   GET  /               setup instructions page for teammates
//   GET  /api            machine-readable service info (endpoint listing)
// The same contract as bridge.py in multi-user mode, plus a self-serve
// authorization flow:
//
//   POST /exec           Bearer token -> the user's Slot -> their plugin
//   GET  /status         Bearer token -> {plugin_connected, pending, user}
//   WS   /plugin?token=X the plugin's authenticated connection (Slot)
//   WS   /plugin         no token yet: pairing mode (Lobby) — the plugin gets
//                        a short code and shows an Authorize button
//   GET  /authorize      the page that button opens; asks name + invite code
//   POST /api/authorize  mints a token and pushes it into the waiting plugin
//
// One Slot Durable Object per token (the token itself is the object name, so
// no registry is needed); one Lobby object holds all not-yet-authorized
// plugin sockets. Both use the WebSocket hibernation API so idle plugins
// don't burn duration.

import { SETUP_PAGE } from "./setup-page.js";

// Shared with the local daemon (local/figmate-local.js) so both answer with
// the same hints.
import ERROR_HINTS from "../../shared/error-hints.json";

function findHint(errorText) {
  if (!errorText) return null;
  const low = String(errorText).toLowerCase();
  for (const [needle, hint] of ERROR_HINTS) {
    if (low.includes(needle.toLowerCase())) return hint;
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function bearerToken(request, url) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return url.searchParams.get("token") || "";
}

const OPEN = 1; // WebSocket.READY_STATE_OPEN

// How long a live plugin may take to answer a ping. It replies from ui.html
// without touching code.js, so this bounds a round trip, not any real work.
const PROBE_MS = 1000;

// Race marker: the socket stopped answering while a request was in flight.
const DEAD = Symbol("plugin socket unresponsive");

// From this plugin version on, the pong is produced by code.js rather than by
// ui.html, so answering the probe proves the sandbox is alive. Older plugins
// answer from the UI frame, which a closed plugin can outlive — for those the
// probe cannot tell a ghost from a working bridge, and a failed exec is the
// only evidence available.
const DEEP_PING_VERSION = "3.1";

// Fallback gate for builds that predate the capability list. From this plugin
// version on, code.js acknowledges every exec before it starts
// working. That ack is the only liveness signal that survives a busy sandbox:
// the ping is answered from code.js too, and Figma's plugin sandbox is
// single-threaded, so a probe sent while an exec is running cannot be answered
// until the exec finishes. Racing that probe against the exec used to kill the
// socket of any call that held the sandbox for more than PROBE_MS — while the
// code ran to completion and committed its edits, so the caller saw a 503 for
// work that had actually been applied.
const ACK_VERSION = "3.2";

// How long the plugin may take to acknowledge an exec. The UI frame confirms
// delivery ("recv") and code.js confirms the sandbox started ("ack"); either
// settles it, so this bounds a round trip plus one message-queue hop.
const ACK_MS = 5000;

// Per-socket state that has to survive hibernation, so it rides on the socket
// rather than on the (evictable) Durable Object instance.
function attrs(ws) {
  try { return ws.deserializeAttachment() || {}; } catch { return {}; }
}

// What a socket can do. Builds from 1.1.* announce their features by name;
// older ones only sent a protocol number, so fall back to comparing that.
function hasCap(ws, cap, minVersion) {
  const a = attrs(ws);
  if (Array.isArray(a.caps)) return a.caps.includes(cap);
  return atLeast(a.version, minVersion);
}

function attach(ws, patch) {
  try { ws.serializeAttachment({ ...attrs(ws), ...patch }); } catch {}
}

// Numeric per segment: "3.10" is newer than "3.9", which a string compare of
// the whole version would get backwards.
function atLeast(version, minimum) {
  const a = String(version || "0").split(".").map(Number);
  const b = String(minimum).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && request.method === "GET") {
      return new Response(SETUP_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api") {
      return json({
        service: "figmate-worker",
        version: "3.0",
        endpoints: {
          "GET /": "setup instructions page for teammates",
          "POST /exec": "{code, timeout?} -> {ok, result, value, logs, elapsed_ms}",
          "GET /status": "{plugin_connected, pending, user}",
          "WS /plugin": "Figma plugin connects here (?token=..., or without one to pair)",
          "GET /authorize": "authorization page for new teammates",
        },
      });
    }

    if (path === "/authorize" && request.method === "GET") {
      return new Response(authorizePage(url.searchParams.get("code") || "", url.searchParams.get("invite") || ""), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/authorize" && request.method === "POST") {
      return authorize(request, env, url);
    }

    if (path === "/plugin") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ ok: false, error: "expected a websocket upgrade" }, 426);
      }
      const token = url.searchParams.get("token") || "";
      if (!token) {
        return env.LOBBY.get(env.LOBBY.idFromName("lobby"))
          .fetch(new Request("https://do/connect", request));
      }
      return env.SLOT.get(env.SLOT.idFromName(token))
        .fetch(new Request("https://do/plugin", request));
    }

    if (path === "/exec" || path === "/status") {
      const token = bearerToken(request, url);
      if (!token) {
        return json({
          ok: false,
          error: "missing or invalid token",
          hint: "pass Authorization: Bearer <token> (CLI: FIGMATE_TOKEN)",
        }, 401);
      }
      return env.SLOT.get(env.SLOT.idFromName(token))
        .fetch(new Request("https://do" + path, request));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

async function authorize(request, env, url) {
  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!env.INVITE_CODE) {
    return json({ ok: false, error: "server misconfigured: INVITE_CODE secret is not set" }, 500);
  }
  if (!body.invite || body.invite !== env.INVITE_CODE) {
    return json({ ok: false, error: "wrong invite code" }, 403);
  }
  const name = String(body.name || "").trim();
  if (!name || name.length > 64) {
    return json({ ok: false, error: "enter your name (up to 64 chars)" }, 400);
  }

  const token = generateToken();
  const slot = env.SLOT.get(env.SLOT.idFromName(token));
  const provisioned = await slot.fetch("https://do/provision", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!provisioned.ok) {
    return json({ ok: false, error: "could not provision the slot" }, 500);
  }

  // If a plugin is waiting with this pairing code, hand the token straight to it.
  let delivered = false;
  const code = String(body.code || "").replace(/\s+/g, "");
  if (code) {
    const lobby = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
    const r = await lobby.fetch("https://do/deliver", {
      method: "POST",
      body: JSON.stringify({ code, token, name }),
    });
    delivered = r.ok;
  }

  return json({ ok: true, name, token, delivered, server: url.origin });
}

// ─── Lobby: not-yet-authorized plugin sockets, keyed by pairing code ────────

export class Lobby {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const code = this.freshCode();
      // The code lives in the socket's tag, so it survives hibernation.
      this.ctx.acceptWebSocket(server, ["code:" + code]);
      server.send(JSON.stringify({ type: "pair", code }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/deliver") {
      const { code, token, name } = await request.json();
      const ws = this.ctx.getWebSockets("code:" + code).find((s) => s.readyState === OPEN);
      if (!ws) {
        return json({ ok: false, error: "unknown or expired code — is the plugin still open?" }, 404);
      }
      ws.send(JSON.stringify({ type: "token", token, name }));
      ws.close(1000, "paired");
      return json({ ok: true });
    }

    return json({ ok: false, error: "not found" }, 404);
  }

  freshCode() {
    for (let i = 0; i < 50; i++) {
      const n = new Uint32Array(1);
      crypto.getRandomValues(n);
      const code = String(100000 + (n[0] % 900000));
      if (this.ctx.getWebSockets("code:" + code).length === 0) return code;
    }
    throw new Error("could not find a free pairing code");
  }

  webSocketMessage() {
    // Pairing sockets only listen; hello/pong from the plugin needs no answer.
  }

  webSocketClose() {}
  webSocketError() {}
}

// ─── Slot: one user's plugin connection and their in-flight requests ────────

export class Slot {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();  // rid -> {resolve, logs, t0}
    this.pongWaiters = new Set();
    this.ackWaiters = new Map();  // rid -> resolve
  }

  // readyState alone cannot tell a live plugin from a half-open socket: when
  // Figma is killed, the laptop sleeps or a VPN drops the link without a FIN,
  // the socket stays OPEN here indefinitely. Everything that needs a plugin —
  // not just a rival connection — has to ask.
  livePlugin() {
    return this.ctx.getWebSockets("plugin").find((s) => s.readyState === OPEN) || null;
  }

  // The same question as livePlugin(), answered honestly, at the cost of one
  // round trip.
  async livePluginChecked(timeoutMs = PROBE_MS) {
    const ws = this.livePlugin();
    if (!ws) return null;
    if (await this.answersPing(ws, timeoutMs)) return ws;
    this.dropUnresponsive(ws);
    return null;
  }

  // A socket that will not answer is never coming back. Close it, so the slot
  // is free for the next plugin instead of swallowing requests until they
  // time out one by one.
  dropUnresponsive(ws) {
    this.failPending("plugin socket went unresponsive");
    try { ws.close(1011, "unresponsive"); } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/provision") {
      const { name } = await request.json();
      await this.ctx.storage.put("name", name);
      return json({ ok: true });
    }

    const name = await this.ctx.storage.get("name");

    if (url.pathname === "/plugin") {
      return this.connectPlugin(request, name);
    }

    if (!name) {
      // A token that was never provisioned — same answer as a wrong one.
      return json({
        ok: false,
        error: "missing or invalid token",
        hint: "pass Authorization: Bearer <token> (CLI: FIGMATE_TOKEN)",
      }, 401);
    }

    if (url.pathname === "/status") {
      return json({
        plugin_connected: (await this.livePluginChecked()) !== null,
        pending: this.pending.size,
        user: name,
      });
    }

    if (url.pathname === "/exec") {
      return this.exec(request, name);
    }

    return json({ ok: false, error: "not found" }, 404);
  }

  async connectPlugin(request, name) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (!name) {
      server.accept();
      server.send(JSON.stringify({ type: "error", text: "invalid token" }));
      server.close(4401, "invalid token");
      return new Response(null, { status: 101, webSocket: client });
    }

    // A plugin that already failed to answer an exec has lost the benefit of
    // the doubt: on an old build its pong proves nothing, and a fresh instance
    // asking for the slot is better evidence than a probe. Without this a ghost
    // holds the slot for good and the real plugin only ever sees "Slot busy".
    const old = this.livePlugin();
    if (old && !attrs(old).sandboxSilent && (await this.answersPing(old))) {
      // Someone is really there — a second Figma window, or the plugin open in
      // both the stable and Beta apps. Only one may own the slot.
      server.accept();
      server.send(JSON.stringify({ type: "error", text: "another plugin instance is already connected" }));
      server.close(1008, "already connected");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (old) {
      this.failPending("plugin reconnected mid-request");
      try { old.close(1012, "superseded"); } catch {}
    }

    this.ctx.acceptWebSocket(server, ["plugin"]);

    // Cloudflare drops a WebSocket that has been idle for a couple of minutes,
    // which is what made a plugin left open in Figma fall into "Reconnecting…"
    // on its own. The plugin sends a keepalive; answering it from the runtime
    // keeps the link warm without waking this object for every beat.
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(
        JSON.stringify({ type: "keepalive" }),
        JSON.stringify({ type: "keepalive-ack" }),
      ));
    } catch {}

    return new Response(null, { status: 101, webSocket: client });
  }

  // A laptop that slept keeps its socket "open"; asking directly distinguishes
  // a live plugin from a half-open socket in about a second, so a reconnecting
  // plugin takes the slot immediately while a genuine second instance is
  // still turned away.
  //
  // The plugin answers "ping" in ui.html, before anything reaches code.js, so a
  // pong means "the bridge is alive", never "your last exec finished" — a long
  // or hung exec still pongs, and is left alone to run out its own timeout.
  //
  // Waiters are a Set: /status, /exec and a rival connection can probe at once,
  // and a single pong has to settle all of them (one field would drop the rest
  // and they would report a live plugin dead).
  answersPing(ws, timeoutMs = PROBE_MS) {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { return Promise.resolve(false); }
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.pongWaiters.delete(waiter);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.pongWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.pongWaiters.add(waiter);
    });
  }

  // Resolves true when the plugin acknowledges this exec, false if it stays
  // silent past ACK_MS. Unlike answersPing this asks about one request, so a
  // sandbox that is merely busy with earlier work cannot answer by accident.
  waitAck(rid, timeoutMs = ACK_MS) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(rid);
        resolve(false);
      }, timeoutMs);
      this.ackWaiters.set(rid, () => {
        clearTimeout(timer);
        this.ackWaiters.delete(rid);
        resolve(true);
      });
    });
  }

  failPending(reason) {
    for (const [rid, entry] of this.pending) {
      entry.resolve({ id: rid, type: "error", text: reason });
    }
    this.ackWaiters.clear();
  }

  async exec(request, name) {
    const ws = this.livePlugin();
    if (!ws) {
      return json({
        ok: false,
        error: `plugin not connected — open Figmate Bridge in Figma (user: ${name})`,
      }, 503);
    }

    let body;
    try { body = await request.json(); } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const code = body.code;
    if (typeof code !== "string" || !code.trim()) {
      return json({ ok: false, error: "missing or empty 'code'" }, 400);
    }

    const timeoutSec = Math.min(Number(body.timeout) || 60, 300);
    const rid = crypto.randomUUID();
    const t0 = Date.now();
    const logs = [];
    const answered = new Promise((resolve) => {
      this.pending.set(rid, { resolve, logs, t0 });
    });

    try {
      ws.send(JSON.stringify({ id: rid, type: "exec", code }));
    } catch (e) {
      this.pending.delete(rid);
      return json({ ok: false, error: `send to plugin failed: ${e}` }, 500);
    }

    // Liveness while the request is in flight. An ack-capable plugin answers
    // before it starts working, so silence past ACK_MS really is a dead socket
    // and the 503 is honest. An older plugin has no such signal — its ping is
    // served by the same single-threaded sandbox that is busy running this very
    // exec, so probing it would only report long calls as dead. For those, wait
    // the request out: a genuinely dead socket costs one timeout, which is far
    // cheaper than failing every heavy build that in fact succeeded.
    const ackable = hasCap(ws, "ack", ACK_VERSION);
    const wentSilent = ackable
      ? this.waitAck(rid).then((acked) => (acked ? new Promise(() => {}) : DEAD))
      : new Promise(() => {});

    const result = await Promise.race([
      answered,
      wentSilent,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutSec * 1000)),
    ]);
    this.pending.delete(rid);
    this.ackWaiters.delete(rid);

    if (result === DEAD) {
      this.dropUnresponsive(ws);
      return json({
        ok: false,
        error: `plugin not connected — open Figmate Bridge in Figma (user: ${name})`,
        hint: "the previous connection died without closing; the slot is free now, re-run the plugin (⌥⌘P)",
      }, 503);
    }

    if (result === null) {
      // Never close the socket on a timeout: slow code and a dead sandbox look
      // identical from here, and a long-running exec would be killed with it.
      //
      // On a plugin new enough to pong from code.js the probe already tells the
      // two apart, so a timeout means nothing but slow code and the socket
      // keeps its standing. On an older build the pong proves only that the UI
      // frame is running, so a timeout is the only evidence a ghost ever
      // leaves — mark it, and connectPlugin stops defending it against the next
      // instance.
      const deep = hasCap(ws, "deep-ping", DEEP_PING_VERSION);
      if (!deep) attach(ws, { sandboxSilent: true });
      return json({
        ok: false,
        error: `timeout after ${timeoutSec}s`,
        hint: deep
          ? null
          : "if this repeats, the plugin's UI may have outlived its sandbox — re-run the plugin (⌥⌘P); it will now take the slot back",
      }, 504);
    }

    attach(ws, { sandboxSilent: false });
    const elapsed = Date.now() - t0;
    if (result.type === "error") {
      const errorText = result.text || "unknown error";
      return json({
        ok: false,
        error: errorText,
        hint: findHint(errorText),
        stack: result.stack || null,
        logs,
        elapsed_ms: elapsed,
      }, 500);
    }

    return json({
      ok: true,
      result: result.text || "",
      value: result.value === undefined ? null : result.value,
      logs,
      elapsed_ms: elapsed,
    });
  }

  webSocketMessage(ws, message) {
    let m;
    try { m = JSON.parse(message); } catch { return; }

    if (m.type === "pong") {
      for (const waiter of [...this.pongWaiters]) waiter();
      return;
    }
    if (m.type === "hello") {
      attach(ws, {
        version: String(m.version || "3.0"),
        caps: Array.isArray(m.caps) ? m.caps.map(String) : null,
      });
      return;
    }
    if (m.type === "ack" || m.type === "recv") {
      const waiter = this.ackWaiters.get(m.id);
      if (waiter) waiter();
      return;
    }

    const entry = this.pending.get(m.id);
    if (!entry) return; // late reply for a request that already timed out

    if (m.type === "log") {
      entry.logs.push(m.text || "");
    } else if (m.type === "result" || m.type === "error") {
      entry.resolve(m);
    }
  }

  webSocketClose(ws) {
    // If another live plugin socket remains, this one was superseded and the
    // in-flight requests belong to its replacement — leave them alone.
    const others = this.ctx.getWebSockets("plugin")
      .filter((s) => s !== ws && s.readyState === OPEN);
    if (others.length === 0) {
      this.failPending("plugin disconnected mid-request");
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}

// ─── the authorization page ─────────────────────────────────────────────────

function authorizePage(code, invite) {
  const prefill = String(code).replace(/[^0-9]/g, "").slice(0, 6);
  const invitePrefill = String(invite || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figmate — authorize</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #1e1e1e;
    color: #eee;
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: #2c2c2c;
    border-radius: 12px;
    padding: 28px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; font-size: 13px; opacity: .65; }
  label { display: block; font-size: 12px; opacity: .7; margin: 14px 0 4px; }
  input {
    width: 100%;
    padding: 9px 10px;
    border-radius: 6px;
    border: 1px solid #555;
    background: #1e1e1e;
    color: #eee;
    font-size: 14px;
    font-family: inherit;
  }
  input:focus { outline: none; border-color: #EB5757; }
  button {
    margin-top: 20px;
    width: 100%;
    padding: 10px;
    border: 0;
    border-radius: 6px;
    background: #EB5757;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover { background: #D64545; }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: #ff7a7a; font-size: 13px; margin-top: 12px; min-height: 1em; }
  .done h1 { color: #0fa958; }
  pre {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre;
  }
  .copy {
    margin-top: 8px;
    background: #444;
  }
  .copy:hover { background: #555; }
  .note { font-size: 12px; opacity: .65; margin-top: 14px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card" id="form_view">
    <h1>Figmate</h1>
    <p class="sub">Authorize your Figma plugin and CLI</p>
    <label>Your name</label>
    <input id="name" placeholder="e.g. maxim" spellcheck="false" autofocus>
    <div${invitePrefill ? ' style="display:none"' : ""}>
      <label>Invite code — ask the admin</label>
      <input id="invite" type="password" value="${invitePrefill}" spellcheck="false">
    </div>
    <label>Code shown in the plugin (skip if the plugin isn't open)</label>
    <input id="code" inputmode="numeric" placeholder="483921" value="${prefill}" spellcheck="false">
    <button id="go">Authorize</button>
    <div class="error" id="error"></div>
  </div>

  <div class="card done" id="done_view" style="display:none">
    <h1 id="done_title">Done</h1>
    <p class="sub" id="done_sub"></p>
    <label>Claude Code setup — paste into splynx/.claude/settings.local.json</label>
    <pre id="snippet"></pre>
    <button class="copy" id="copy">Copy</button>
    <p class="note" id="done_note"></p>
  </div>

<script>
const el = (id) => document.getElementById(id);

el("go").onclick = async () => {
  el("error").textContent = "";
  el("go").disabled = true;
  let resp, body;
  try {
    resp = await fetch("/api/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: el("name").value,
        invite: el("invite").value,
        code: el("code").value,
      }),
    });
    body = await resp.json();
  } catch (e) {
    el("error").textContent = "request failed: " + e.message;
    el("go").disabled = false;
    return;
  }
  if (!body.ok) {
    el("error").textContent = body.error || "authorization failed";
    el("go").disabled = false;
    return;
  }

  el("form_view").style.display = "none";
  el("done_view").style.display = "";
  el("done_title").textContent = body.delivered ? "Plugin connected" : "Token created";
  el("done_sub").textContent = "Welcome, " + body.name + "!";
  el("snippet").textContent = JSON.stringify(
    { env: { FIGMATE_SERVER: body.server, FIGMATE_TOKEN: body.token } },
    null,
    2,
  );
  el("done_note").textContent = body.delivered
    ? "The plugin saved the token and is reconnecting — the bar in Figma turns green in a moment."
    : "The plugin didn't get the token automatically (no matching code). Open the plugin in Figma, " +
      "click the gear and paste the token from the snippet above into the Token field.";
};

el("copy").onclick = () => {
  navigator.clipboard.writeText(el("snippet").textContent).then(() => {
    el("copy").textContent = "Copied!";
    setTimeout(() => { el("copy").textContent = "Copy"; }, 1500);
  });
};
</script>
</body>
</html>`;
}
