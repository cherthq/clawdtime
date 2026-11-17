"""One-attempt Chert lifecycle with durable, content-free receipts.

Lead supplies an httpx.AsyncClient configured with origin and authentication.
Use one new receipt per explicitly authorized attempt; NEVER create another
receipt to retry an unknown call. Existing receipts permit read reconciliation
only. No destination, line, token, response body, or exception text is persisted.
This module owns neither client closure nor credentials and never auto-retries.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from urllib.parse import quote
import uuid

import httpx

TERMINAL = frozenset({"ended", "completed", "failed", "rejected", "cancelled", "canceled", "no_answer", "busy"})
DEFINITIVE_REJECTION = frozenset({400, 401, 403, 404, 405, 422})
FIELDS = frozenset({"state", "place_state", "end_state", "call_id", "place_key", "end_key", "call_status", "cleanup_state"})
PROVIDER_CODES = frozenset({"recipient_not_verified", "verification_unavailable", "verification_conflict", "credit_exhausted", "forbidden", "insufficient_scope", "invalid_request", "line_busy", "admin_action_denied", "cli_scope_denied"})
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")


class ReceiptError(RuntimeError):
    """Fixed, non-sensitive error code; never contains provider data."""


class CallGuard:
    def __init__(self, client: httpx.AsyncClient, receipt_path, *, poll_interval=0.5):
        self.client = client
        self.path = Path(receipt_path).absolute()
        self.poll_interval = max(0.01, min(float(poll_interval), 2.0))
        self._recovery_only = self.path.exists() or self.path.is_symlink()
        self._receipt = None
        self._attempted = False
        self._owned_place_key = None

    @contextmanager
    def _lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                os.close(fd)
                raise ReceiptError("unsafe_receipt_lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                raise ReceiptError("receipt_in_use") from None
        except OSError:
            raise ReceiptError("receipt_lock_failed") from None
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def _load(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as handle:
                info = os.fstat(handle.fileno())
                if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ReceiptError("unsafe_receipt")
                raw = handle.read(8193)
            data = json.loads(raw)
            if len(raw) > 8192 or not isinstance(data, dict) or set(data) not in (FIELDS, FIELDS | {"provider_error"}):
                raise ReceiptError("invalid_receipt")
            if "provider_error" in data and data["provider_error"] not in PROVIDER_CODES:
                raise ReceiptError("invalid_receipt")
            if not all(isinstance(data[k], str) for k in FIELDS - {"call_id"}):
                raise ReceiptError("invalid_receipt")
            if data["call_id"] is not None and not SAFE_ID.fullmatch(str(data["call_id"])):
                raise ReceiptError("invalid_receipt")
            for key in ("place_key", "end_key"):
                if not SAFE_ID.fullmatch(data[key]):
                    raise ReceiptError("invalid_receipt")
            self._receipt = data
            return data
        except (OSError, ValueError, TypeError):
            raise ReceiptError("receipt_read_failed") from None

    def _save(self):
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(prefix=".call-receipt-", dir=self.path.parent)
            with os.fdopen(fd, "w") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump(self._receipt, handle, separators=(",", ":"), sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
            tmp = None
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            raise ReceiptError("receipt_commit_failed") from None
        finally:
            if tmp is not None:
                os.unlink(tmp)

    def _result(self, error=None, http_status=None):
        r = self._receipt or {}
        return {"state": r.get("state", "unattempted"), "call_id": r.get("call_id"),
                "place_state": r.get("place_state"), "end_state": r.get("end_state"),
                "call_status": r.get("call_status"), "cleanup_complete": r.get("state") == "cleanup_complete",
                "error": error, "http_status": http_status, "provider_error": r.get("provider_error")}

    @staticmethod
    def _data(response):
        try:
            payload = response.json()
            return payload.get("data") if isinstance(payload, dict) else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _call(data):
        if not isinstance(data, dict):
            return None
        call = data.get("call", data)
        if not isinstance(call, dict) or not isinstance(call.get("id"), str) or not SAFE_ID.fullmatch(call["id"]):
            return None
        return call

    async def place(self, body):
        """POST exactly once. Cancellation/network failure leaves durable unknown."""
        with self._lock():
            if self._recovery_only or self._attempted or self.path.exists():
                raise ReceiptError("existing_attempt_read_reconcile_only")
            self._attempted = True
            self._receipt = {"state": "unknown", "place_state": "pending_unknown",
                "end_state": "not_attempted", "call_id": None,
                "place_key": "call-" + uuid.uuid4().hex, "end_key": "end-" + uuid.uuid4().hex,
                "call_status": "unknown", "cleanup_state": "unknown"}
            self._save()
            self._owned_place_key = self._receipt['place_key']
            request_body = dict(body)
            request_body["when_busy"] = "fail"
            try:
                response = await asyncio.wait_for(self.client.post("/api/v1/calls", json=request_body,
                    headers={"Idempotency-Key": self._receipt["place_key"]}, timeout=15,
                    follow_redirects=False), timeout=15)
            except asyncio.CancelledError:
                raise
            except Exception:
                return self._result("placement_unknown")
            data = self._data(response)
            # Retain only enumerated protocol codes, never arbitrary provider text.
            try:
                payload = response.json()
                error = payload.get("error") if isinstance(payload, dict) else None
                code = error.get("code") if isinstance(error, dict) else None
                if isinstance(code, str) and code in PROVIDER_CODES:
                    self._receipt["provider_error"] = code
            except (ValueError, TypeError):
                pass
            call = self._call(data)
            queued = isinstance(data, dict) and (data.get("queued") is True or bool(data.get("queue")))
            # Retain any explicit call ID even if the outcome is otherwise unknown.
            if call:
                self._receipt["call_id"] = call["id"]
            if 200 <= response.status_code < 300 and call and not queued:
                self._receipt.update(state="placed", place_state="accepted")
            elif response.status_code in DEFINITIVE_REJECTION and not call and not queued:
                self._receipt.update(state="rejected", place_state="rejected")
            else:
                self._receipt["place_state"] = "unknown"
            self._save()
            return self._result(None if self._receipt["state"] == "placed" else
                "placement_rejected" if self._receipt["state"] == "rejected" else "placement_unknown", response.status_code)

    async def end(self, *, timeout=0):
        """End known ID once (5s cap), then return without polling by default.

        Call ``reconcile(timeout=20)`` after media teardown. An explicit positive
        timeout requests polling here; repeated end calls never POST again.
        """
        with self._lock():
            if not self.path.exists() and not self._attempted:
                return self._result("no_call")
            r = self._load()
            if self._recovery_only or self._owned_place_key != r['place_key']:
                raise ReceiptError("existing_attempt_read_reconcile_only")
            if not r["call_id"]:
                return self._result("unknown_call_id")
            if r["end_state"] == "not_attempted":
                r.update(state="end_unknown", end_state="pending_unknown")
                self._save()
                try:
                    response = await asyncio.wait_for(self.client.post(
                        f"/api/v1/calls/{quote(r['call_id'], safe='')}/end", json={},
                        headers={"Idempotency-Key": r["end_key"]}, timeout=5,
                        follow_redirects=False), timeout=5)
                    r["end_state"] = "submitted" if 200 <= response.status_code < 300 else "unknown"
                except asyncio.CancelledError:
                    raise
                except Exception:
                    r["end_state"] = "unknown"
                self._save()
            if timeout <= 0:
                return self._result(None if r["state"] == "cleanup_complete" else "cleanup_unconfirmed")
            return await self._reconcile_locked(timeout)

    async def reconcile(self, *, timeout=20):
        """Read-only provider reconciliation; no POST, DELETE, or inferred retries."""
        with self._lock():
            if not self.path.exists() and not self._attempted:
                return self._result("no_call")
            self._load()
            return await self._reconcile_locked(timeout)

    async def _reconcile_locked(self, timeout):
        r = self._receipt
        if not r["call_id"]:
            return self._result("unknown_call_id")
        deadline = time.monotonic() + max(0.01, min(float(timeout), 20.0))
        call_path = f"/api/v1/calls/{quote(r['call_id'], safe='')}"
        while time.monotonic() < deadline:
            try:
                remaining = max(0.001, deadline - time.monotonic())
                calls, events = await asyncio.wait_for(asyncio.gather(
                    self.client.get(call_path, timeout=min(5, remaining)),
                    self.client.get(call_path + "/events", timeout=min(5, remaining))), timeout=remaining)
                call = self._call(self._data(calls)) if calls.status_code == 200 else None
                event_data = self._data(events) if events.status_code == 200 else None
                terminal = bool(call and call["id"] == r["call_id"] and call.get("status") in TERMINAL)
                rows = event_data.get("events") if isinstance(event_data, dict) and event_data.get("call_id") == r["call_id"] else None
                cleanup = False
                if isinstance(rows, list) and len(rows) <= 10000:
                    ids = [e.get("id") for e in rows if isinstance(e, dict)]
                    cleanup = any(isinstance(e, dict) and isinstance(e.get("id"), str) and bool(e["id"])
                        and e.get("source") == "worker" and e.get("type") == "cleanup_complete"
                        and ids.count(e["id"]) == 1 for e in rows)
                if terminal:
                    r["call_status"] = call["status"]
                if cleanup:
                    r["cleanup_state"] = "complete"
                if terminal and cleanup:
                    r.update(state="cleanup_complete", end_state="reconciled")
                    self._save()
                    return self._result()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
        self._save()
        return self._result("cleanup_unconfirmed")
