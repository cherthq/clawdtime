import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer
from server import Service, Session


class CaptionServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service = Service({'MEDIA_DATABASE_PATH': str(Path(self.tmp.name) / 'media.sqlite'),
                                'MEDIA_API_KEY': 'm' * 32})
        self.client = TestClient(TestServer(self.service.app()))
        await self.client.start_server()
        self.service.ready = lambda: True
        self.headers = {'Authorization': 'Bearer ' + 'm' * 32}
        self.spec = {'id': 'ct_' + 'c' * 40, 'meetingId': 'meeting', 'lineId': 'line', 'captions': True}

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_caption_start_requires_auth_and_explicit_service_gate(self):
        response = await self.client.post('/sessions', json=self.spec)
        self.assertEqual(response.status, 401)
        response = await self.client.post('/sessions', json=self.spec, headers=self.headers)
        self.assertEqual(response.status, 503)
        self.assertEqual(self.service.db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
        response = await self.client.post('/sessions', json={**self.spec, 'captions': 'true'}, headers=self.headers)
        self.assertEqual(response.status, 400)

    async def test_caption_mode_is_bound_to_preparation_fingerprint(self):
        self.service.env['MEDIA_CAPTIONS_ENABLED'] = 'true'
        async def prepare(session):
            session.caption_publisher = SimpleNamespace(failed=False)
            session.credentials = {'test': 'credentials'}
            session.close = AsyncMock()
        with patch.object(Session, 'prepare', prepare):
            response = await self.client.post('/sessions', json=self.spec, headers=self.headers)
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())['videoPublisherReady'])
            response = await self.client.post('/sessions', json={**self.spec, 'captions': False}, headers=self.headers)
            self.assertEqual(response.status, 409)

    async def test_caption_delivery_requires_backend_acceptance(self):
        session = Session(self.service, self.spec)
        policy = {'callId': 'call', 'state': 'listening', 'captionsEnabled': True,
                  'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        session.caption_scene.apply_policy(policy)
        self.service.backend = AsyncMock(return_value={'captured': True})
        task = asyncio.create_task(session.deliver())
        try:
            session.queue_segment({'id': '1', 'text': 'Accepted sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], ['Accepted sentence.'])
            self.service.backend.return_value = {'captured': False}
            session.queue_segment({'id': '2', 'text': 'Rejected private sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            self.assertEqual(session.caption_scene.snapshot()['state'], 'paused')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_local_pause_latch_prevents_delayed_segment_display(self):
        session = Session(self.service, self.spec)
        session.caption_scene.apply_policy({'callId': 'call', 'state': 'listening', 'captionsEnabled': True,
            'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()})
        session.pause_latched = True
        self.service.backend = AsyncMock(return_value={'captured': True})
        task = asyncio.create_task(session.deliver())
        try:
            session.queue_segment({'id': '1', 'text': 'Delayed private sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            self.assertEqual(session.caption_scene.snapshot()['state'], 'paused')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_delayed_and_queued_pre_pause_segments_never_reappear_after_resume(self):
        session = Session(self.service, self.spec)
        policy = {'callId': 'call', 'state': 'listening', 'captionsEnabled': True,
                  'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        session.caption_scene.apply_policy(policy)
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed_ack(path, segment):
            self.assertNotIn('_caption_epoch', segment)
            started.set()
            await release.wait()
            return {'captured': True}
        self.service.backend = delayed_ack
        session.queue_segment({'id': '1', 'text': 'Private in-flight sentence.'})
        session.queue_segment({'id': '2', 'text': 'Private queued sentence.'})
        task = asyncio.create_task(session.deliver())
        try:
            await asyncio.wait_for(started.wait(), 1)
            session.caption_scene.clear('paused')
            session.caption_scene.apply_policy(policy)
            release.set()
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            session.queue_segment({'id': '3', 'text': 'Fresh approved sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], ['Fresh approved sentence.'])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_first_caption_policy_must_match_activated_call(self):
        session = Session(self.service, self.spec)
        session.active = True
        session.call_id = 'owned-call'
        session.stop_stt = AsyncMock()
        self.service.backend = AsyncMock(return_value={'callId': 'foreign-call', 'state': 'listening',
            'captionsEnabled': True, 'title': 'Private foreign title',
            'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()})
        task = asyncio.create_task(session.watch_policy())
        try:
            await asyncio.sleep(.02)
            self.assertFalse(session.allowed)
            self.assertEqual(session.caption_scene.snapshot()['state'], 'unavailable')
            self.assertEqual(session.caption_scene.title, 'ClawdTime attention')
            self.assertIsNone(session.caption_scene.call_id)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    unittest.main()
