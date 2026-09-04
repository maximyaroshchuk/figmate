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

    def __init__(self, session, *, token=None, reply=None):
        self.session = session
        self.token = token
        self.reply = reply or (lambda code: {"text": "ok", "value": 42})
        self.ws = None
        self._task = None
        self.seen_codes = []
        self.received = asyncio.Queue()   # pair / token / error messages

    async def __aenter__(self):
        self.ws = await self.session.ws_connect(ws_url(self.token), heartbeat=None)
        await self.ws.send_str(json.dumps({"type": "hello", "version": "test"}))
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
                await self.ws.send_str(json.dumps({"type": "pong"}))
            elif mtype == "exec":
                self.seen_codes.append(m["code"])
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
            async with s.get(f"{WORKER}/") as r:
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
