---
name: figmate
description: Read and edit the user's Figma through the figmate worker (pure HTTP, no local tools). Use IMMEDIATELY whenever the user shares a figma.com link or mentions Figma/фігма/макет/дизайн-файл — extract the node id and read it. For any "implement this design" task, run the DEEP READ and map the result onto existing Splynx components. Prefer this over the Figma MCP.
---

# Figmate — Figma over HTTP, nothing local

The agent talks to the remote worker with plain curl. Env vars are preconfigured
(`FIGMATE_SERVER`, `FIGMATE_TOKEN` in `~/.claude/settings.json` → env). Never ask for
tokens; if the env is empty, tell the user to run Authorize in the plugin and add the
env to settings.

## Saw a figma.com link — act immediately

1. Extract the node id: `node-id=91901-31395` → `91901:31395`.
2. Quick overview — the tree:

```bash
curl -s -X POST "$FIGMATE_SERVER/exec" \
  -H "Authorization: Bearer $FIGMATE_TOKEN" -H "Content-Type: application/json" \
  --data @- <<'EOF'
{"code": "const n = await h.resolve('91901:31395'); if (!n) throw new Error('node not found'); return h.dumpTree(n, {maxDepth: 4, showLayout: true});"}
EOF
```

3. Response: `{ok, result, value, logs, elapsed_ms}`. The tree is in `result`.

When something is off:
- `503 plugin not connected` → tell the user in one line: "open the file in Figma and press ⌥⌘P (Run last plugin)". No re-authorization needed — the plugin keeps its token forever.
- `node not found` → the file open in Figma is not the one from the link. The plugin only works with the open file; if the user cannot edit that file, they duplicate it to Drafts and open the copy.
- `401` → check `FIGMATE_TOKEN` in env (`~/.claude/settings.json`).
- Execution errors come with a `hint` field — follow it before debugging on your own.

## DEEP READ — mandatory before implementing any UI

`dumpTree` is only an overview. Before building any UI, run `h.spec` — it returns the
FULL implementation-ready spec of the subtree (substitute your NODE_ID):

```bash
curl -s -X POST "$FIGMATE_SERVER/exec" \
  -H "Authorization: Bearer $FIGMATE_TOKEN" -H "Content-Type: application/json" \
  --data @- <<'EOF'
{"code": "const root = await h.resolve('NODE_ID'); if (!root) throw new Error('node not found'); return await h.spec(root, {maxDepth: 7});", "timeout": 120}
EOF
```

Reading the output — one node per header line, `· `-prefixed detail lines under it:

- **Paddings and gaps are already computed, everywhere.** Auto-layout frames show the
  API truth (`layout:H gap:8 pad:4`); containers WITHOUT auto-layout (GROUPs, plain
  frames) show MEASURED spacing marked with `~` (`~pad:16`, `~gapY:24`) — derived from
  child geometry, full-cover background layers (marked `(bg)`) excluded. `pad:4` means
  uniform 4px all around → maps straight to `p-4`-style utilities.
- **Colors carry their design-token names**: `fill:#367bf5 (Blue/500)` — the variable
  or style name in parentheses. Use the name to pick the system class, not the hex.
- **Components are identified**: `[INSTANCE → Solid Button (State=Default)]` — match
  that to the component table below instead of rebuilding from rectangles.
- Text is complete (never truncated), with `font:Family Style size/lineheight`; mixed
  styling is split into per-range `seg` lines.
- Before writing code, show the user a **spacing map** — the spec tree (or its digest)
  with every px — so they see exactly what you see and can verify.
- Responses are capped around 1 MB: on "result too large", lower `maxDepth` or request
  the listed child ids as separate spec calls.

## Mapping to Splynx components (admin, frontend/)

Implementation in the admin is ALWAYS built on existing components and system classes.
NEVER write a custom `<style>` block and never hardcode hex colors from the design:
the mockups are drawn in the Splynx design system, so every element already has a
component.

| In Figma (name/appearance) | In Splynx code |
|---|---|
| `Solid Button / primaryButton` (#367bf5, r4) | `<button class="btn btn-primary">` |
| Outline button | `btn btn-outline-dark` |
| `Button-link` (#367bf5, no background) | plain `<a>` |
| `Default/Warning` badge (#ffaf14, r2) | `<label class="badge bg-warning">` (success/danger — same pattern) |
| White panel r8 + border #e9ecef | `<div class="card"><div class="card-body">` |
| Message: avatar + author + time + text | `XMessage` (slots title/subtitle/content, `:files="[]"`) |
| Card with a header title | `XCard` |
| Tabs | `XTabs` |
| Stepper | `XStepper` |
| `Label+input` | form components (`XForm`, `inputs/`) |
| `fluent:*` icons | `icon-ic_fluent_*` classes |
| Text #6c757d 12px | `class="text-muted small"` |
| Heading 16 Semi Bold | `<h4>` |
| Inter 14 font | system default — do nothing |

Spacing — ONLY the px-keyed spacer utilities: `0 2 4 8 12 16 20 24 28 32 40 48 56`
(`mb-24`, `mt-16`, `p-8`…). Grid — `row`/`col-*` (default gutter 24px).
Before using an unfamiliar component, read its props/slots in
`frontend/components/common/…`. If no component matches a design element — say so and
ask the user before writing anything custom.

Priority on conflict: the system value wins over the mockup value (e.g. grid gutter 24
vs mockup 20 — keep the system one), but call out every such conflict explicitly.

## Recipes (all the same POST /exec, only "code" changes)

```js
return h.sel();                                   // current selection ("this frame", "the selected one" — run this first, don't ask for ids)
const n = await h.resolve('ID');                  // node by id; aliases: 'page', 'sel'
return h.dumpTree(n, {maxDepth: 6});              // deeper tree
return n.findAll(x => x.type === 'TEXT').map(x => x.characters);   // all texts
return n.findAll(x => x.name.includes('Btn')).map(x => ({id: x.id, name: x.name}));
await h.setText(n, 'new text');                   // edit a TEXT node (loads the font itself)
await h.variant(n, {'Property 1': 'Default'});    // switch a variant; list: await h.variantsOf(n)
```

Arbitrary Plugin API JS: the code runs as an `async` function body, `return` = result,
`print(...)` → the `logs` array. Long operations: add `"timeout": 120` next to `"code"`.

## h.* helpers (live in the plugin)

`h.resolve(idOrAlias)` `h.sel()` `h.spec(n, {maxDepth})` `h.dumpTree(n, opts)` `h.findByName(root, name)`
`h.findAllByName(root, name)` `h.setText(n, text)` `h.withFonts(root, asyncFn)`
`h.variant(inst, props)` `h.variantsOf(inst)` `h.cloneNext(n, {direction, gap, name})`
`h.hex('#1a2b3c')` `h.solid('#1a2b3c', opacity?)` `h.frame(parent, {layout, w, h, spacing, padding, align, fill, radius, name})`
`h.bF(n, idx, varId)` `h.bS(n, idx, varId)` `h.bN(n, prop, varId)` — variable binding
`h.node(id)` `h.var_(idOrKey)` `h.importComp(key)` `h.importVar(key)`

Figma API rules: lookups are async (`await h.node(...)`); `node.fills` is frozen — use
`h.bF`/`h.solid` for changes; auto-layout properties only apply AFTER `appendChild`
and `layoutMode` — so always use `h.frame(...)` for new frames.

## Status / diagnostics

```bash
curl -s "$FIGMATE_SERVER/status" -H "Authorization: Bearer $FIGMATE_TOKEN"
# {plugin_connected, pending, user}
```
