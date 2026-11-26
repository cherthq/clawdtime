import asyncio
import json
import os
import stat

import httpx
import pytest

from call_guard import CallGuard, ReceiptError


def run(coro):
    return asyncio.run(coro)


def client(handler):
    return httpx.AsyncClient(base_url="https://example.invalid", transport=httpx.MockTransport(handler))


def test_timeout_is_one_post_and_durable_unknown(tmp_path):
    path = tmp_path / "receipt.json"
    requests = []

    async def handler(req):
        requests.append(req)
        saved = json.loads(path.read_text())
        assert saved["place_state"] == "pending_unknown"
        assert saved["place_key"] == req.headers["Idempotency-Key"]
        assert json.loads(req.content)["when_busy"] == "fail"
        raise httpx.ReadTimeout("sensitive ignored", request=req)

    async def scenario():
        async with client(handler) as http:
            guard = CallGuard(http, path)
            result = await guard.place({"destination": "PRIVATE", "participant_token": "SECRET", "when_busy": "queue"})
            assert result["state"] == "unknown"
            assert result["error"] == "placement_unknown"
            with pytest.raises(ReceiptError, match="existing_attempt"):
                await guard.place({})
            assert (await guard.reconcile(timeout=.01))["error"] == "unknown_call_id"
    run(scenario())
    assert len(requests) == 1
    assert "PRIVATE" not in path.read_text() and "SECRET" not in path.read_text()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert path.stat().st_uid == os.getuid()


def test_existing_receipt_rejects_new_writes(tmp_path):
    path = tmp_path / "receipt.json"
    requests = []

    def handler(req):
        requests.append(req)
        return httpx.Response(201, json={"data": {"call": {"id": "call_1"}}})

    async def scenario():
        async with client(handler) as http:
            await CallGuard(http, path).place({})
            recovered = CallGuard(http, path)
            with pytest.raises(ReceiptError, match="read_reconcile_only"):
                await recovered.place({})
            with pytest.raises(ReceiptError, match="read_reconcile_only"):
                await recovered.end()
    run(scenario())
    assert len(requests) == 1


@pytest.mark.parametrize("nested", [False, True])
def test_successful_id_and_cleanup(tmp_path, nested):
    path = tmp_path / "receipt.json"
    writes = []

    def handler(req):
        if req.method == "POST":
            writes.append(req)
            if req.url.path.endswith("/end"):
                assert json.loads(path.read_text())["end_state"] == "pending_unknown"
                return httpx.Response(409, json={"error": "not proof of cleanup"})
            call = {"id": "call_1"}
            return httpx.Response(201, json={"data": {"call": call} if nested else call})
        if req.url.path.endswith("/events"):
            return httpx.Response(200, json={"data": {"call_id": "call_1", "events": [
                {"id": "event_1", "source": "worker", "type": "cleanup_complete"}]}})
        return httpx.Response(200, json={"data": {"id": "call_1", "status": "ended"}})

    async def scenario():
        async with client(handler) as http:
            guard = CallGuard(http, path)
            result = await guard.place({})
            assert result["call_id"] == "call_1" and result["state"] == "placed"
            result = await guard.end(timeout=.1)
            assert result["state"] == "cleanup_complete" and result["cleanup_complete"]
            await guard.end(timeout=.1)
    run(scenario())
    assert len(writes) == 2
    assert writes[0].headers["Idempotency-Key"] != writes[1].headers["Idempotency-Key"]


@pytest.mark.parametrize("end_status", [None, 404, 409, 500])
def test_end_uncertain_never_retries_or_accepts_status_alone(tmp_path, end_status):
    requests = []

    def handler(req):
        requests.append(req)
        if req.method == "POST" and req.url.path.endswith("/end"):
            if end_status is None:
                raise httpx.ReadTimeout("SECRET", request=req)
            return httpx.Response(end_status)
        if req.method == "POST":
            return httpx.Response(201, json={"data": {"id": "call_1"}})
        if req.url.path.endswith("/events"):
            return httpx.Response(200, json={"data": {"call_id": "wrong_call", "events": [
                {"id": "event_1", "source": "worker", "type": "cleanup_complete"}]}})
        return httpx.Response(200, json={"data": {"id": "call_1", "status": "ended"}})

    async def scenario():
        async with client(handler) as http:
            guard = CallGuard(http, tmp_path / "receipt.json", poll_interval=.01)
            await guard.place({})
            for _ in range(2):
                result = await guard.end(timeout=.02)
                assert result["state"] == "end_unknown" and not result["cleanup_complete"]
                assert result["error"] == "cleanup_unconfirmed"
    run(scenario())
    assert sum(r.method == "POST" and r.url.path.endswith("/end") for r in requests) == 1


def test_definitive_rejection(tmp_path):
    async def scenario():
        async with client(lambda req: httpx.Response(422, json={"error": "private detail"})) as http:
            result = await CallGuard(http, tmp_path / "receipt.json").place({})
            assert result["state"] == "rejected" and result["http_status"] == 422
            assert "private" not in json.dumps(result)
    run(scenario())


@pytest.mark.parametrize('code', ['recipient_not_verified', 'SECRET', {'secret': 'PRIVATE'}])
def test_provider_diagnostic_is_allowlisted_and_durable(tmp_path, code):
    path = tmp_path / 'receipt.json'
    async def scenario():
        async with client(lambda req: httpx.Response(403, json={'error': {
            'code': code, 'message': 'PRIVATE', 'details': {'token': 'SECRET'}}})) as http:
            result = await CallGuard(http, path).place({})
            expected = code if code == 'recipient_not_verified' else None
            assert result['provider_error'] == expected
            assert (await CallGuard(http, path).reconcile())['provider_error'] == expected
            assert 'PRIVATE' not in json.dumps(result) + path.read_text()
            assert 'SECRET' not in json.dumps(result) + path.read_text()
    run(scenario())


def test_end_before_placement_does_not_send(tmp_path):
    def handler(req):
        raise AssertionError("must not send")

    async def scenario():
        async with client(handler) as http:
            result = await CallGuard(http, tmp_path / "receipt.json").end()
            assert result["error"] == "no_call" and result["call_id"] is None
            assert not (tmp_path / "receipt.json").exists()
            assert (await CallGuard(http, tmp_path / "receipt.json").reconcile())["error"] == "no_call"
    run(scenario())


def test_preconstructed_guard_cannot_end_another_attempt(tmp_path):
    requests = []
    def handler(req):
        requests.append(req)
        return httpx.Response(201, json={'data': {'id': 'call_1'}})
    async def scenario():
        async with client(handler) as http:
            owner = CallGuard(http, tmp_path / 'receipt.json')
            other = CallGuard(http, tmp_path / 'receipt.json')
            await owner.place({})
            with pytest.raises(ReceiptError):
                await other.end()
    run(scenario())
    assert len(requests) == 1


@pytest.mark.parametrize("terminal,source,duplicate", [(False, "worker", False),
    (True, "api", False), (True, "worker", True)])
def test_cleanup_requires_terminal_and_unique_worker_evidence(tmp_path, terminal, source, duplicate):
    def handler(req):
        if req.method == "POST":
            return httpx.Response(201, json={"data": {"id": "call_1"}})
        if req.url.path.endswith("/events"):
            event = {"id": "event_1", "source": source, "type": "cleanup_complete"}
            return httpx.Response(200, json={"data": {"call_id": "call_1", "events": [event] * (2 if duplicate else 1)}})
        return httpx.Response(200, json={"data": {"id": "call_1", "status": "ended" if terminal else "active"}})

    async def scenario():
        async with client(handler) as http:
            guard = CallGuard(http, tmp_path / "receipt.json")
            await guard.place({})
            result = await guard.reconcile(timeout=.01)
            assert not result["cleanup_complete"] and result["state"] != "cleanup_complete"
    run(scenario())


@pytest.mark.parametrize("status,data", [(500, {}), (200, {"queued": True, "queue": {"id": "q1"}})])
def test_server_failure_or_unexpected_queue_is_unknown(tmp_path, status, data):
    async def scenario():
        async with client(lambda req: httpx.Response(status, json={"data": data})) as http:
            guard = CallGuard(http, tmp_path / "receipt.json")
            assert (await guard.place({}))["state"] == "unknown"
            with pytest.raises(ReceiptError):
                await guard.place({})
    run(scenario())
