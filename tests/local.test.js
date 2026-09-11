// Black-box checks for the local daemon: a fake plugin connects over the
// hand-written WebSocket server, and the HTTP contract is compared against the
// worker's:
//
//     node tests/local.test.js
//
// The high-value targets are the frame codec (a real spec response runs past
// the 64 KB extended-length boundary) and the error envelope — the hint table
// is shared with the worker, so a drift there breaks both.
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const DAEMON = path.join(__dirname, "..", "local", "figmate-local.js");

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await wait(50);
  }
}

function startDaemon(port) {
  const child = spawn(process.execPath, [DAEMON, "--port", String(port), "--quiet"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write("[daemon] " + chunk));
  return child;
}

async function post(base, body) {
  const response = await fetch(base + "/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer ignored-by-the-daemon" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

// A stand-in for plugin/ui.html: answers every exec with whatever the test
// queued up next.
function fakePlugin(base) {
  const socket = new WebSocket(base.replace(/^http/, "ws") + "/plugin");
  const plugin = {
    socket,
    received: [],
    reply: null, // (message) => array of frames to send back
    open: new Promise((resolve) => socket.addEventListener("open", resolve, { once: true })),
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    plugin.received.push(message);
    if (message.type !== "exec" || !plugin.reply) return;
    for (const frame of plugin.reply(message)) socket.send(JSON.stringify(frame));
  });
  return plugin;
}

function rawGet(port, host, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET " + target + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

async function main() {
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const daemon = startDaemon(port);

  const up = await waitFor(async () => {
    try {
      const response = await fetch(base + "/status");
      return response.ok;
    } catch (err) {
      return false;
    }
  });
  if (!up) {
    console.log("  FAIL daemon never came up");
    daemon.kill("SIGKILL");
    process.exit(1);
  }

  console.log("no plugin connected");
  {
    const status = await (await fetch(base + "/status")).json();
    check("status reports an empty slot", status.plugin_connected === false && status.user === "local", status);

    const { status: code, json } = await post(base, { code: "return 1;" });
    check("exec answers 503", code === 503, code);
    check("503 explains what to open", /plugin not connected/.test(json.error), json);
  }

  console.log("plugin connected");
  const plugin = fakePlugin(base);
  await plugin.open;
  await waitFor(async () => (await (await fetch(base + "/status")).json()).plugin_connected);
  check("status flips to connected", true);

  {
    plugin.reply = (message) => [
      { id: message.id, type: "log", text: "first" },
      { id: message.id, type: "log", text: "second" },
      { id: message.id, type: "result", text: "spec here", value: { w: 42 } },
    ];
    const { status, json } = await post(base, { code: "return h.spec(n);" });
    check("exec answers 200", status === 200, status);
    check("envelope carries result and value", json.ok === true && json.result === "spec here" && json.value.w === 42, json);
    check("logs arrive in order", JSON.stringify(json.logs) === '["first","second"]', json.logs);
    check("elapsed_ms is reported", typeof json.elapsed_ms === "number", json.elapsed_ms);
    check("the plugin got the code", plugin.received.some((m) => m.type === "exec" && m.code === "return h.spec(n);"));
  }

  {
    // 300 KB crosses the extended-length boundary in both directions.
    const big = "x".repeat(300 * 1024);
    plugin.reply = (message) => [{ id: message.id, type: "result", text: big }];
    const { json } = await post(base, { code: "return big;".padEnd(200 * 1024, " ") });
    check("a 300 KB answer survives the frame codec", json.ok === true && json.result.length === big.length,
      json.ok ? json.result.length : json);
  }

  {
    plugin.reply = (message) => [{
      id: message.id,
      type: "error",
      text: "in set_fills: fills and strokes variable bindings must be set on paints directly",
      stack: "at <anonymous>",
    }];
    const { status, json } = await post(base, { code: "boom();" });
    check("errors answer 500", status === 500, status);
    check("the shared hint table is applied", /h\.bF\(/.test(json.hint || ""), json.hint);
    check("the stack is passed through", json.stack === "at <anonymous>", json.stack);
  }

  {
    plugin.reply = () => []; // silence
    const { status, json } = await post(base, { code: "await forever();", timeout: 1 });
    check("a silent plugin times out with 504", status === 504 && /timeout after 1s/.test(json.error), json);
  }

  {
    const { status, json } = await post(base, { code: "   " });
    check("empty code is rejected with 400", status === 400 && /empty 'code'/.test(json.error), json);
  }

  console.log("plugin reconnects");
  {
    const second = fakePlugin(base);
    await second.open;
    await wait(150);
    second.reply = (message) => [{ id: message.id, type: "result", text: "from the new window" }];
    const { json } = await post(base, { code: "return 1;" });
    check("the newest connection owns the slot", json.result === "from the new window", json);
    second.socket.close();
  }

  plugin.socket.close();
  await waitFor(async () => (await (await fetch(base + "/status")).json()).plugin_connected === false);
  check("status reports the slot free again", true);

  {
    // fetch() refuses to set Host, so ask over a raw socket the way a
    // DNS-rebinding page would.
    const raw = await rawGet(port, "evil.example.com", "/status");
    check("a foreign Host header is refused", / 403 /.test(raw.split("\r\n")[0] + " "), raw.split("\r\n")[0]);
  }

  daemon.kill("SIGTERM");
  console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
