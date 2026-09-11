# Figmate

Drive Figma from Claude Code (or any HTTP client). A small dev plugin inside
Figma Desktop keeps a WebSocket open to a bridge; you POST Figma Plugin API code
to the bridge and get the result back: read a design's full spec, rename layers,
swap variants, bind tokens, build frames — without clicking through the editor.

The bridge comes in two flavours, same HTTP contract either way.

**A local daemon** — one command, nothing to install, nothing to authorize:

```
agent / CLI ──http://127.0.0.1:8787──▶ local daemon ──ws──▶ plugin in YOUR Figma
                                       (node local/figmate-local.js)
```

**A team worker on Cloudflare** — one address for everyone, a personal token
each, and requests sent with a token reach only the Figma of the person who
owns it:

```
agent / CLI ──HTTPS + personal token──▶ Cloudflare Worker ──wss──▶ plugin in YOUR Figma
                                        (Durable Object
                                         per token)
```

## Local setup (one developer)

```bash
node local/figmate-local.js        # 127.0.0.1:8787, no token, no dependencies
```

In Figma: `Plugins → Figmate Bridge → ⚙ → Use local daemon`. In Claude Code:
`FIGMATE_SERVER=http://127.0.0.1:8787` (no `FIGMATE_TOKEN` needed). Details and
troubleshooting: [`local/README.md`](local/README.md).

## Team setup (a shared worker)

Open the worker's root page — it is the setup guide:

```
https://figmate.<account>.workers.dev/
```

Short version: download the plugin zip, import `plugin/manifest.json` in Figma
Desktop, run **Figmate Bridge**, press **Authorize** — the page opens with
everything pre-filled, you type your name, and the plugin turns green. The same
page hands you the `FIGMATE_SERVER` / `FIGMATE_TOKEN` env block for Claude Code.

## Team server (admin, once)

```bash
cd worker
npx wrangler login
npx wrangler secret put INVITE_CODE    # the one shared team secret
npx wrangler deploy                    # prints https://figmate.<account>.workers.dev
```

The free Cloudflare tier is enough: Durable Objects run on the SQLite backend
and plugin sockets use the hibernation API, so idle connections cost nothing.

To distribute the plugin, build the zip with the invite baked in (the committed
source keeps it empty):

```bash
./build-plugin.sh <invite-code>        # produces figmate-plugin.zip
```

## Using from an agent

`CLAUDE.md` in this repo teaches Claude Code the whole workflow. The core of it:

```bash
curl -s -X POST "$FIGMATE_SERVER/exec" \
  -H "Authorization: Bearer $FIGMATE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"code":"const n = await h.resolve(\"sel\"); return await h.spec(n);"}'
```

`h.spec` returns an implementation-ready description of a subtree — measured
paddings and gaps, colors with design-token names, fonts, component variants —
the thing you want in front of a model before it writes UI code.

## Tests

```bash
node tests/helpers.test.js                                # plugin helpers
node tests/local.test.js                                  # local daemon, end to end

# Worker e2e (black-box over HTTP/WS against a live wrangler dev):
cd worker && echo 'INVITE_CODE=dev-invite' > .dev.vars && npx wrangler dev --port 8799 &
FIGMATE_WORKER_URL=http://localhost:8799 python3 -m pytest tests/test_worker.py -q
```

## Security notes

- `/exec` runs arbitrary JS in the connected user's Figma file — treat tokens
  like passwords.
- The invite code is a shared team secret: it lives in the worker secret and in
  the distributed plugin zip, never in this repository.

## Credits

The idea of driving Figma through a dev plugin comes from
[figmosha2](https://github.com/denysosadchyi/figmosha2) by Denys Osadchyi —
Figmate started as its fork and has since been rewritten from scratch around a
Cloudflare Worker with self-serve team auth.

## License

MIT — see [LICENSE](LICENSE).
