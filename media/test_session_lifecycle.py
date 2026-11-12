"""Offline lifecycle regressions; SDK/network endpoints are synthetic."""
import asyncio
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from server import Service, Session


class SyntheticAudio:
    def __init__(self):
        self.first = True
        self.aclose = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.first:
            self.first = False
            return SimpleNamespace(frame=SimpleNamespace(data=b'\0\0'))
        await asyncio.Future()


class ClosingSocket:
    def __init__(self):
        self.sending = asyncio.Event()
        self.broken = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.Future()

    async def send_bytes(self, data):
        self.sending.set()
        await self.broken.wait()
        raise ConnectionError('synthetic private upstream detail')

    async def close(self):
        self.broken.set()
        # Closing a live socket yields before Session.stop_stt cancels its tasks.
        await asyncio.sleep(.03)


class CaptureGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sockets = []
        def connect(*args, **kwargs):
            socket = ClosingSocket()
            self.sockets.append(socket)
            return socket
        self.owner = SimpleNamespace(env={'DEEPGRAM_API_KEY': 'synthetic'},
                                     http=SimpleNamespace(ws_connect=connect))
        self.session = Session(self.owner, {'id': 'ct_'+'a'*40, 'meetingId': 'fixture'})
        self.session.active = self.session.allowed = True
        self.session.policy_at = time.monotonic()
        self.session.fail = AsyncMock()
        self.stream_patch = patch('server.rtc.AudioStream', side_effect=lambda *a, **kw: SyntheticAudio())
        self.stream_patch.start()
        self.capture = asyncio.create_task(self.session.capture_loop())

    async def asyncTearDown(self):
        self.session.closing = True
        self.capture.cancel()
        await asyncio.gather(self.capture, return_exceptions=True)
        self.stream_patch.stop()

    async def next_socket(self, index):
        async def ready():
            while len(self.sockets) <= index:
                await asyncio.sleep(.005)
            await self.sockets[index].sending.wait()
        await asyncio.wait_for(ready(), 1)
        return self.sockets[index]

    async def test_repeated_intentional_stt_pause_does_not_end_call(self):
        for index in range(3):
            await self.next_socket(index)
            self.session.allowed = False
            self.session.speaking = True
            await self.session.stop_stt()
            self.session.fail.assert_not_awaited()
            self.assertFalse(self.capture.done())
            self.assertEqual(len(self.sockets), index+1)
            # Fresh policy authorizes the next listening generation after speech.
            self.session.speaking = False
            self.session.allowed = True
            self.session.policy_at = time.monotonic()

    async def test_current_generation_transport_failure_still_ends_call(self):
        socket = await self.next_socket(0)
        socket.broken.set()
        await asyncio.wait_for(self.capture, 1)
        self.session.fail.assert_awaited_once()
        self.assertEqual(len(self.sockets), 1)


class LifecycleDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.owner = Service({'MEDIA_DATABASE_PATH': str(Path(self.tmp.name)/'media.sqlite')})
        self.session = Session(self.owner, {'id': 'ct_'+'b'*40, 'meetingId': 'fixture'})
        self.owner.db.execute('INSERT INTO sessions VALUES(?,?,?)', (self.session.id, 'fixture', 'prepared'))
        self.owner.db.commit()
        self.owner.backend = AsyncMock(return_value={})
        self.session.stop_stt = AsyncMock()
        self.session.close = AsyncMock()

    async def asyncTearDown(self):
        await asyncio.gather(*self.session.tasks, return_exceptions=True)
        self.owner.db.close()
        self.tmp.cleanup()

    async def test_callback_latches_first_failure_before_scheduling_and_cleanup(self):
        task = self.session.request_failure('room_disconnected', 'room_event')
        first = dict(self.session.lifecycle.data['firstFailure'])
        self.owner.backend.assert_not_awaited()
        self.session.lifecycle.close('backend_close')
        await task
        await self.session.fail('task_failed', 'segment_delivery')
        self.assertEqual(first, self.session.lifecycle.data['firstFailure'])
        self.assertEqual(first['category'], 'room_event')
        self.assertEqual(first['reason'], 'room_disconnected')
        self.assertGreaterEqual(first['elapsedMs'], 0)
        self.assertLessEqual(first['elapsedMs'], 86400000)
        self.assertEqual(self.owner.backend.await_args.args[1], first)
        self.assertEqual(self.session.lifecycle.data['closeRequested']['reason'], 'backend_close')

    async def test_normal_close_does_not_acquire_a_failure_from_cleanup(self):
        self.session.lifecycle.close('backend_close')
        self.session.lifecycle.failure('task_failed', 'audio_publish')
        self.assertNotIn('firstFailure', self.session.lifecycle.data)

    async def test_retained_first_failure_survives_restart_and_status(self):
        import json
        from aiohttp.test_utils import make_mocked_request
        self.session.lifecycle.failure('transcription_failed', 'capture_loop')
        self.session.lifecycle.close('failure')
        other = Service(self.owner.env)
        try:
            response = await other.status(make_mocked_request('GET', '/sessions/'+self.session.id,
                match_info={'id': self.session.id}))
            value = json.loads(response.text)
            self.assertFalse(value['alive'])
            self.assertEqual(value['lifecycleDiagnostics'], self.session.lifecycle.data)
        finally:
            other.db.close()

    async def test_diagnostic_sink_error_does_not_prevent_failure_cleanup(self):
        def unavailable(data):
            raise RuntimeError('synthetic private diagnostic detail')
        self.session.lifecycle.persist = unavailable
        with self.assertLogs(level='ERROR') as logs:
            await self.session.fail('transcription_failed', 'capture_loop')
        self.assertNotIn('private', ''.join(logs.output))
        self.owner.backend.assert_awaited_once()
        self.session.close.assert_awaited_once_with('failure')

    async def test_metadata_rejects_arbitrary_categories_without_retaining_them(self):
        for reason, category in [('secret contents', 'room_event'), ('task_failed', 'secret task')]:
            with self.assertRaises(ValueError):
                self.session.lifecycle.failure(reason, category)
        self.assertEqual(self.session.lifecycle.data, {'version': 1})

    async def test_diagnostic_write_does_not_commit_outer_receipt_transaction(self):
        self.owner.db.execute('INSERT INTO speech(id,session,fingerprint,state) VALUES(?,?,?,?)', ('receipt', self.session.id, 'hash', 'pending'))
        self.session.lifecycle.failure('room_disconnected', 'room_event')
        self.assertTrue(self.owner.db.in_transaction)
        self.owner.db.rollback()
        self.assertIsNone(self.owner.db.execute('SELECT id FROM speech WHERE id=?', ('receipt',)).fetchone())

    async def test_managed_task_category_is_retained_without_exception_text(self):
        async def broken():
            raise RuntimeError('synthetic private task detail')
        with self.assertLogs(level='ERROR') as logs:
            task = self.session.task(broken(), 'audio_publish')
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(0)
        self.assertNotIn('private', ''.join(logs.output))
        self.assertEqual(self.session.lifecycle.data['firstFailure']['category'], 'audio_publish')
        self.assertEqual(self.session.lifecycle.data['firstFailure']['reason'], 'task_failed')

    async def test_cancelled_task_is_not_a_failure(self):
        task = self.session.task(asyncio.sleep(10), 'audio_publish')
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertNotIn('firstFailure', self.session.lifecycle.data)
        self.owner.backend.assert_not_awaited()
