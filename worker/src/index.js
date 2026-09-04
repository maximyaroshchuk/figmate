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

const ERROR_HINTS = [
  ["fills and strokes variable bindings must be set on paints directly",
   "use h.bF(node, idx, varId) to bind a fill paint to a variable"],
  ["strokes variable bindings must be set on paints directly",
   "use h.bS(node, idx, varId) to bind a stroke paint to a variable"],
  ["Cannot assign to read only property",
   "node.fills/strokes is frozen — copy via JSON.parse(JSON.stringify(...)) before mutating, or use h.bF()/h.bS()"],
  ["permission not specified in manifest",
   "manifest.json missing a permission — edit plugin/manifest.json, then re-import the plugin in Figma"],
  ["unloaded font",
   "use h.setText(node, text) or h.withFonts(root, fn) — they autoload fonts. Or manually: await figma.loadFontAsync(node.fontName)"],
  ["font has not been loaded",
   "use h.setText(node, text) or h.withFonts(root, fn) — they autoload fonts"],
  ["Cannot find font",
   "fontName may be missing or mixed — check node.fontName before loading"],
  ["appendChild",
   "create node, then parent.appendChild(node) BEFORE setting layoutMode/resize/itemSpacing/padding"],
  ["Unable to find a variant",
   "no variant matches those property values — check available: const v = await h.variantsOf(instance); return v.groups"],
  ["Invalid property name",
   "check available variants: const v = await h.variantsOf(instance); return v.groups"],
  ["Invalid value",
   "check variant values: const v = await h.variantsOf(instance); return v.groups"],
  ["setProperties",
   "if 'Unable to find variant' — check available values via h.variantsOf(instance)"],
  ["not a function",
   "API may be deprecated or renamed — check figma.* available methods, or use Async variants"],
];

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
    this.pongWaiter = null;
  }

  livePlugin() {
    return this.ctx.getWebSockets("plugin").find((s) => s.readyState === OPEN) || null;
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
        plugin_connected: this.livePlugin() !== null,
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

    const old = this.livePlugin();
    if (old && (await this.incumbentAnswers(old))) {
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
    return new Response(null, { status: 101, webSocket: client });
  }

  // A laptop that slept keeps its socket "open"; asking directly distinguishes
  // a live plugin from a half-open socket in about a second, so a reconnecting
  // plugin takes the slot immediately while a genuine second instance is
  // still turned away.
  incumbentAnswers(ws, timeoutMs = 1000) {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { return false; }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pongWaiter = null;
        resolve(false);
      }, timeoutMs);
      this.pongWaiter = () => {
        clearTimeout(timer);
        this.pongWaiter = null;
        resolve(true);
      };
    });
  }

  failPending(reason) {
    for (const [rid, entry] of this.pending) {
      entry.resolve({ id: rid, type: "error", text: reason });
    }
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

    const result = await Promise.race([
      answered,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutSec * 1000)),
    ]);
    this.pending.delete(rid);

    if (result === null) {
      return json({ ok: false, error: `timeout after ${timeoutSec}s` }, 504);
    }

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
      if (this.pongWaiter) this.pongWaiter();
      return;
    }
    if (m.type === "hello") return;

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
