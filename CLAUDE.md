# Figmate — Claude Code instructions

Figmate lets an agent read and edit Figma documents over plain HTTP. Requests go
to a Cloudflare Worker (`FIGMATE_SERVER`); the worker relays them over WebSocket
to the Figmate Bridge plugin running inside the user's Figma Desktop, where the
code executes against the real document.

## Talking to the server

Everything is one endpoint — POST `/exec` with a JS body:

```bash
curl -s -X POST "$FIGMATE_SERVER/exec" \
  -H "Authorization: Bearer $FIGMATE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"code":"return figma.currentPage.name"}'

curl -s "$FIGMATE_SERVER/status" -H "Authorization: Bearer $FIGMATE_TOKEN"
# {"plugin_connected": true, "pending": 0, "user": "..."}
```

- The code runs as an `async` function body: `return` becomes the `result`
  field, `await` works everywhere, `print(...)` collects log lines.
- Add `"timeout": 120` next to `"code"` for long operations.
- Errors come back as `{ok:false, error, hint?, stack, logs}` — when the worker
  recognizes a common mistake it adds a `hint`; follow it first.
- A `401` means the token is missing or wrong; `503 plugin not connected` means
  the user has to run the plugin in Figma (⌥⌘P — Run last plugin).

## The `h.*` helpers (available in every exec)

| Helper | What |
|---|---|
| `await h.spec(node, {maxDepth})` | Implementation-ready spec of a subtree: measured paddings/gaps (auto-layout or not), colors with variable/style names, fonts, component variants |
| `h.dumpTree(node, {maxDepth, showSize, showText, showLayout})` | Quick indented tree overview |
| `h.sel()` | Current selection as `{id,name,type,w,h}` |
| `await h.resolve(idOrAlias)` | Node by id; aliases `page` and `sel` |
| `h.findByName(root, name)` / `h.findAllByName(root, name)` | Descendants by exact name |
| `await h.setText(node, text)` | Set TEXT characters; loads all fonts, mixed-font nodes included |
| `await h.withFonts(root, asyncFn)` | Preload every font in a subtree, then run the callback |
| `h.frame(parent, {layout, w, h, spacing, padding, align, fill, radius, name})` | Frame with auto-layout applied in the order Figma requires |
| `h.cloneNext(node, {direction, gap, name})` | Clone and place adjacent |
| `await h.variant(instance, props)` | Switch variant properties |
| `await h.variantsOf(target)` | Variants of an INSTANCE, COMPONENT, or COMPONENT_SET |
| `await h.bF(node, idx, varOrId)` / `h.bS` / `h.bN` | Bind fill / stroke / numeric prop to a variable |
| `h.hex("#1a2b3c")` / `h.solid("#1a2b3c", opacity?)` | Hex → Figma color / ready paint list |
| `await h.node(id)` / `h.var_(idOrKey)` / `h.importComp(key)` / `h.importVar(key)` | Thin async accessors |

Prefer helpers over hand-rolled equivalents — they encode the API's traps
(frozen `node.fills`, font loading, auto-layout property order).

## Reading a design

1. Overview: `h.dumpTree(node, {maxDepth: 4, showLayout: true})`.
2. Before implementing any UI: `await h.spec(node)` — paddings and gaps come
   pre-computed (measured ones marked `~`, background layers `(bg)`), colors
   carry variable names, instances show their component and variant values.
3. Responses are capped near 1 MB. On "result too large", lower `maxDepth` or
   request the child ids the message lists as separate spec calls.
4. Don't screenshot to verify — read the data back instead:
   `return (await h.node("...")).width`.

## Editing rules

- Lookups are async under dynamic-page access: `await h.node(id)`,
  `await instance.getMainComponentAsync()`, `await figma.importComponentByKeyAsync(key)`.
- Auto-layout order matters: appendChild → `layoutMode` → `resize` → sizing
  modes → spacing/padding. `h.frame()` does it correctly — use it.
- `node.fills`/`node.strokes` are frozen arrays — copy before mutating, or use
  `h.bF`/`h.bS`/`h.solid`.
- For big builds, split into: (1) structure with hardcoded colors and named
  nodes; (2) walk by name and bind variables via `h.bF`/`h.bS`/`h.bN`. Verify
  each step by reading values back.

## When something looks wrong

- `plugin not connected` (503) — the plugin window is closed; ask the user to
  run it again (⌥⌘P).
- Timeout (504) — likely an infinite loop or an await that never resolves; the
  user closes and re-runs the plugin.
- `Slot busy` in the plugin bar — the same file is open in another Figma window
  holding the slot.
- A weird `undefined` result — the script forgot `return`.
- Manifest permission errors — edit `plugin/manifest.json`, then the plugin
  must be re-imported in Figma (remove + Import plugin from manifest), not just
  re-run.

## Repo layout

- `plugin/` — the Figma dev plugin: `code.js` (main thread: exec runner and the
  `h.*` helpers), `ui.html` (WebSocket to the worker, pairing/settings UI),
  `manifest.json`.
- `worker/` — Cloudflare Worker: `/exec`, `/status`, WS `/plugin`, the
  self-serve authorize flow, and the teammate setup page at `/`.
  Deploy: `cd worker && npx wrangler deploy`. The `INVITE_CODE` secret is a
  dashboard variable and survives deploys.
- `tests/helpers.test.js` — pure-logic checks for the helpers
  (`node tests/helpers.test.js`).
- `tests/test_worker.py` — black-box worker protocol tests.
- The committed `ui.html` keeps `INVITE_CODE` empty on purpose — the invite is
  injected only into the zip that gets distributed to teammates.
