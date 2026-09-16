"""End-to-end tests for the Cloudflare Worker, driven by a fake plugin.

These need a running worker, so they skip themselves unless FIGMATE_WORKER_URL
is set. Run locally:

    cd worker && echo 'INVITE_CODE=dev-invite' > .dev.vars && npx wrangler dev &
    FIGMATE_WORKER_URL=http://localhost:8787 FIGMATE_INVITE=dev-invite \
        ../venv/bin/python -m pytest tests/test_worker.py -q
"""

import asyncio
import json
import os

import aiohttp
import pytest

WORKER = os.environ.get("FIGMATE_WORKER_URL", "").rstrip("/")
INVITE = os.environ.get("FIGMATE_INVITE", "dev-invite")

pytestmark = pytest.mark.skipif(
    not WORKER, reason="FIGMATE_WORKER_URL not set — start `npx wrangler dev` and export it")


def run(coro):
    return asyncio.run(coro)


def ws_url(token=None):
    base = WORKER.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/plugin" + (f"?token={token}" if token else "")


class FakePlugin:
    """Plays plugin/ui.html: pairs or connects, echoes exec, answers pings."""

    def __init__(self, session, *, token=None, reply=None, pong=True,
                 version="3.1", caps=None, ack=True, work=0.0):
        self.session = session
        self.token = token
        self.pong = pong          # False plays a socket whose far end is gone
        self.version = version    # "3.0" answers pings from the UI frame
        self.caps = caps          # None plays a build that predates the list
        self.ack = ack            # False plays a sandbox that never got the job
        # Seconds the "sandbox" is busy. Figma's is single-threaded, so during
        # that window pings go unanswered however alive the plugin is.
        self.work = work
        self.busy = False
        self.reply = reply or (lambda code: {"text": "ok", "value": 42})
        self.ws = None
        self._task = None
        self.seen_codes = []
        self.received = asyncio.Queue()   # pair / token / error messages

    async def __aenter__(self):
        self.ws = await self.session.ws_connect(ws_url(self.token), heartbeat=None)
        hello = {"type": "hello", "version": self.version}
        if self.caps is not None:
            hello["caps"] = self.caps
        await self.ws.send_str(json.dumps(hello))
        self._task = asyncio.create_task(self._pump())
        return self

    async def __aexit__(self, *exc):
        if self._task:
            self._task.cancel()
        if self.ws and not self.ws.closed:
            await self.ws.close()

    async def expect(self, mtype, timeout=10):
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            m = await asyncio.wait_for(self.received.get(), timeout=remaining)
            if m.get("type") == mtype:
                return m

    async def _pump(self):
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            mtype = m.get("type")
            if mtype == "ping":
                if self.pong and not self.busy:
                    await self.ws.send_str(json.dumps({"type": "pong"}))
            elif mtype == "exec":
                self.seen_codes.append(m["code"])
                if self.ack and self.caps and "ack" in self.caps:
                    await self.ws.send_str(json.dumps({"type": "ack", "id": m["id"]}))
                if self.work:
                    self.busy = True
                    await asyncio.sleep(self.work)
                    self.busy = False
                out = self.reply(m["code"])
                await self.ws.send_str(json.dumps(
                    {"type": out.pop("type", "result"), "id": m["id"], **out}))
            else:
                await self.received.put(m)


async def register(session, name):
    async with session.post(f"{WORKER}/api/authorize",
                            json={"invite": INVITE, "name": name}) as r:
        body = await r.json()
        assert r.status == 200 and body["ok"], body
        return body["token"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_root_answers():
    async def go():
        async with aiohttp.ClientSession() as s:
            # "/" is the human setup page; the machine-readable listing is /api.
            async with s.get(f"{WORKER}/") as r:
                assert r.status == 200
                assert "text/html" in r.headers.get("Content-Type", "")
            async with s.get(f"{WORKER}/api") as r:
                assert r.status == 200
                assert (await r.json())["service"] == "figmate-worker"
    run(go())


def test_exec_and_status_require_token():
    async def go():
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{WORKER}/exec", json={"code": "return 1"}) as r:
                assert r.status == 401
            async with s.get(f"{WORKER}/status",
                             headers=bearer("made-up-token-000")) as r:
                assert r.status == 401
    run(go())


def test_authorize_rejects_wrong_invite():
    async def go():
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{WORKER}/api/authorize",
                              json={"invite": "nope", "name": "eve"}) as r:
                assert r.status == 403
    run(go())


def test_pairing_flow_delivers_token():
    async def go():
        async with aiohttp.ClientSession() as s:
            async with FakePlugin(s) as plugin:
                pair = await plugin.expect("pair")
                code = pair["code"]
                assert len(code) == 6

                async with s.post(f"{WORKER}/api/authorize",
                                  json={"invite": INVITE, "name": "pairer",
                                        "code": code}) as r:
                    body = await r.json()
                    assert r.status == 200 and body["ok"] and body["delivered"], body
                    token = body["token"]

                handed = await plugin.expect("token")
                assert handed["token"] == token
                assert handed["name"] == "pairer"

            # reconnect authenticated, like the real plugin does
            async with FakePlugin(s, token=token) as plugin:
                async with s.get(f"{WORKER}/status", headers=bearer(token)) as r:
                    body = await r.json()
                    assert body["plugin_connected"] is True
                    assert body["user"] == "pairer"
    run(go())


def test_deliver_with_unknown_code_fails():
    async def go():
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{WORKER}/api/authorize",
                              json={"invite": INVITE, "name": "lost",
                                    "code": "000000"}) as r:
                body = await r.json()
                assert r.status == 200 and body["ok"], body
                assert body["delivered"] is False
    run(go())


def test_exec_routed_to_own_plugin():
    async def go():
        async with aiohttp.ClientSession() as s:
            token_a = await register(s, "alice")
            token_b = await register(s, "bob")
            reply_a = lambda code: {"text": "from alice", "value": "A"}
            reply_b = lambda code: {"text": "from bob", "value": "B"}
            async with FakePlugin(s, token=token_a, reply=reply_a) as pa, \
                       FakePlugin(s, token=token_b, reply=reply_b) as pb:
                async with s.post(f"{WORKER}/exec", json={"code": "who?"},
                                  headers=bearer(token_b)) as r:
                    body = await r.json()
                    assert r.status == 200 and body["value"] == "B", body
                async with s.post(f"{WORKER}/exec", json={"code": "who?"},
                                  headers=bearer(token_a)) as r:
                    body = await r.json()
                    assert r.status == 200 and body["value"] == "A", body
                assert pa.seen_codes == ["who?"]
                assert pb.seen_codes == ["who?"]
    run(go())


def test_exec_error_carries_hint_and_logs():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "hinted")
            reply = lambda code: {"type": "error", "text": "in an unloaded font"}
            async with FakePlugin(s, token=token, reply=reply):
                async with s.post(f"{WORKER}/exec", json={"code": "x"},
                                  headers=bearer(token)) as r:
                    body = await r.json()
                    assert r.status == 500 and body["ok"] is False
                    assert "h.setText" in body["hint"]
    run(go())


def test_exec_without_plugin_is_503():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "offline")
            async with s.post(f"{WORKER}/exec", json={"code": "return 1"},
                              headers=bearer(token)) as r:
                assert r.status == 503
                assert "offline" in (await r.json())["error"]
    run(go())


def test_plugin_ws_with_bad_token_closed_4401():
    async def go():
        async with aiohttp.ClientSession() as s:
            ws = await s.ws_connect(ws_url("made-up-token-000"))
            msg = await asyncio.wait_for(ws.receive(), timeout=10)
            assert "invalid token" in json.loads(msg.data)["text"]
            await asyncio.wait_for(ws.receive(), timeout=10)
            assert ws.close_code == 4401
    run(go())


def test_second_plugin_same_token_rejected():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "twice")
            async with FakePlugin(s, token=token):
                ws = await s.ws_connect(ws_url(token))
                msg = await asyncio.wait_for(ws.receive(), timeout=10)
                assert "already connected" in json.loads(msg.data)["text"]
                await asyncio.wait_for(ws.receive(), timeout=10)
                assert ws.close_code == 1008
    run(go())


def test_exec_timeout_is_504():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "sleeper")
            reply = lambda code: {"type": "__drop__"}
            async with FakePlugin(s, token=token, reply=reply):
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "sleep", "timeout": 1},
                                  headers=bearer(token)) as r:
                    assert r.status == 504
    run(go())


# ─── half-open sockets ──────────────────────────────────────────────────────
#
# When Figma is killed, the laptop sleeps or a VPN drops the link without a
# FIN, the socket stays OPEN on the worker's side with nobody behind it. These
# play that: a plugin that holds the socket but never answers anything.


def test_status_reports_an_unresponsive_socket_as_disconnected():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "zombie-status")
            async with FakePlugin(s, token=token, pong=False):
                async with s.get(f"{WORKER}/status", headers=bearer(token)) as r:
                    body = await r.json()
                    assert body["plugin_connected"] is False, body
    run(go())


def test_exec_against_an_unresponsive_socket_is_503_not_a_timeout():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "zombie-exec")
            reply = lambda code: {"type": "__drop__"}
            async with FakePlugin(s, token=token, reply=reply, pong=False,
                                  caps=["deep-ping", "ack"], ack=False):
                started = asyncio.get_running_loop().time()
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "hello", "timeout": 30},
                                  headers=bearer(token)) as r:
                    body = await r.json()
                    assert r.status == 503, body
                    assert "plugin not connected" in body["error"], body
                # The point of the fix: an honest answer in about a second,
                # not after the caller's full timeout.
                assert asyncio.get_running_loop().time() - started < 10
    run(go())


def test_a_live_plugin_still_gets_its_full_timeout():
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "slow-but-alive")
            # Answers pings, drops the exec: alive, just slow. The probe must
            # not cut this short — it has to run out its own timeout as a 504.
            reply = lambda code: {"type": "__drop__"}
            async with FakePlugin(s, token=token, reply=reply, pong=True):
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "sleep", "timeout": 2},
                                  headers=bearer(token)) as r:
                    assert r.status == 504, await r.json()
    run(go())


def test_a_ghost_ui_frame_cannot_keep_the_slot_from_a_new_plugin():
    """The bug this fix exists for.

    An old (3.0) plugin answers pings from ui.html, so a closed plugin whose UI
    outlived its sandbox still passes the probe: it holds the slot, swallows
    every exec, and the real plugin reconnecting is turned away with 1008. One
    failed exec has to be enough to let the next instance in.
    """
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "ghost")
            drop = lambda code: {"type": "__drop__"}
            async with FakePlugin(s, token=token, reply=drop, pong=True,
                                  version="3.0"):
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "hello", "timeout": 1},
                                  headers=bearer(token)) as r:
                    assert r.status == 504, await r.json()

                # The real plugin comes back — and must be let in.
                async with FakePlugin(s, token=token) as fresh:
                    async with s.post(f"{WORKER}/exec", json={"code": "hello"},
                                      headers=bearer(token)) as r:
                        body = await r.json()
                        assert r.status == 200 and body["value"] == 42, body
                    assert fresh.seen_codes == ["hello"]
    run(go())


def test_a_healthy_plugin_keeps_its_slot_after_a_slow_exec():
    """The other side of the same rule: one slow call must not cost the slot.

    A 3.1 plugin pongs from code.js, so the probe already separates a ghost from
    a working bridge. A timeout then means nothing worse than slow code, and a
    second instance is still turned away.
    """
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "slowpoke")
            drop = lambda code: {"type": "__drop__"}
            async with FakePlugin(s, token=token, reply=drop, version="3.1"):
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "slow", "timeout": 1},
                                  headers=bearer(token)) as r:
                    assert r.status == 504, await r.json()

                ws = await s.ws_connect(ws_url(token))
                msg = await asyncio.wait_for(ws.receive(), timeout=10)
                assert "already connected" in json.loads(msg.data)["text"]
                await asyncio.wait_for(ws.receive(), timeout=10)
                assert ws.close_code == 1008
    run(go())


def test_a_busy_sandbox_is_not_mistaken_for_a_dead_one():
    """The bug this fix exists for.

    Figma's plugin sandbox is single-threaded, and from 3.1 on the pong is
    produced by code.js — so while an exec runs, a ping cannot be answered
    however healthy the bridge is. Racing that probe against the request killed
    the socket of every call that held the sandbox longer than PROBE_MS, and
    returned 503 for work that ran to completion and committed its edits. The
    ack, sent before the work starts, is what the server waits for instead.
    """
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "busy-sandbox")
            async with FakePlugin(s, token=token, caps=["deep-ping", "ack"],
                                  work=3) as plugin:
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "heavy", "timeout": 30},
                                  headers=bearer(token)) as r:
                    body = await r.json()
                    assert r.status == 200, body
                    assert body["value"] == 42, body
                assert plugin.seen_codes == ["heavy"]
    run(go())


def test_a_busy_pre_ack_plugin_is_not_killed_either():
    """A build without the ack cannot prove it is alive mid-exec.

    It gets no probe at all then: a dead socket costs one timeout, which is far
    cheaper than reporting every heavy build as failed when it in fact applied.
    """
    async def go():
        async with aiohttp.ClientSession() as s:
            token = await register(s, "busy-old")
            async with FakePlugin(s, token=token, version="3.1", work=3):
                async with s.post(f"{WORKER}/exec",
                                  json={"code": "heavy", "timeout": 30},
                                  headers=bearer(token)) as r:
                    body = await r.json()
                    assert r.status == 200 and body["value"] == 42, body
    run(go())
