# Figmate local daemon

The team worker is one way to run Figmate; this is the other. Everything stays
on your laptop: no server, no token, no authorization page, nothing to install.

```bash
node local/figmate-local.js
```

That is the whole setup. The daemon listens on `127.0.0.1:8787`, waits for the
plugin, and speaks the same HTTP contract as the worker.

## Point the two sides at it

**Figma** — open the plugin (`Plugins → Figmate Bridge`), press the gear, then
**Use local daemon**. The bar turns green. Port 8787 is already in
`plugin/manifest.json`, so nothing has to be re-imported.

**Claude Code** — in `~/.claude/settings.json` (or your project's
`.claude/settings.local.json`):

```json
{ "env": { "FIGMATE_SERVER": "http://127.0.0.1:8787" } }
```

`FIGMATE_TOKEN` is not needed — the daemon ignores whatever is sent.

## What it serves

```
POST /exec      {"code": "...", "timeout": 60} -> {ok, result, value, logs, elapsed_ms}
GET  /status    -> {plugin_connected, pending, user, mode}
WS   /plugin    the plugin's connection
GET  /          this, in short
```

Same responses as the worker, including the error `hint` table — it is shared
from `shared/error-hints.json`, so both halves stay in step.

## Flags

```
--port 8787        another port also has to be added to plugin/manifest.json
                   allowedDomains, and the plugin re-imported in Figma
--host 127.0.0.1   loopback only by design; requests that address the daemon
                   by any other name are refused
--quiet            no per-request lines
```

## When something looks wrong

- `503 plugin not connected` — the plugin window is closed. Open the file in
  Figma and press <kbd>⌥⌘P</kbd>.
- `curl: (7) Failed to connect` — the daemon is not running; start it again.
- `port 8787 is busy` — a daemon is already up. Check with
  `curl -s http://127.0.0.1:8787/status`.
- The plugin bar stays yellow — its server field still points at the worker;
  press the gear and **Use local daemon**.

## Tests

```bash
node tests/local.test.js
```

A fake plugin connects over the daemon's WebSocket and the HTTP contract is
checked end to end: the envelope, the log stream, the shared hints, 503 with no
plugin, a 504 timeout, a 300 KB answer (the frame codec's extended-length
path), reconnects, and the loopback guard.
