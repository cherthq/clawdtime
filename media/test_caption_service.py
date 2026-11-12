import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import time
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

    def fixture_session(self):
        session=Session(self.service,self.spec)
        session.active=session.allowed=True
        session.call_id='owned-call'
        session.policy_at=time.monotonic()
        return session

    def queue(self, session, segment):
        return session.queue_segment({'at':datetime.now(timezone.utc).isoformat(),
            'source':'remote_participant','callId':session.call_id,
            'participantIdentity':session.worker_identity,**segment})

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
        session = self.fixture_session()
        policy = {'callId': 'call', 'state': 'listening', 'captionsEnabled': True,
                  'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        session.caption_scene.apply_policy(policy)
        self.service.backend = AsyncMock(return_value={'captured': True})
        task = asyncio.create_task(session.deliver())
        try:
            self.queue(session,{'id': '1', 'text': 'Accepted sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], ['Accepted sentence.'])
            self.service.backend.return_value = {'captured': False}
            self.queue(session,{'id': '2', 'text': 'Rejected private sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            self.assertEqual(session.caption_scene.snapshot()['state'], 'paused')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_local_pause_latch_prevents_delayed_segment_display(self):
        session = self.fixture_session()
        session.caption_scene.apply_policy({'callId': 'call', 'state': 'listening', 'captionsEnabled': True,
            'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()})
        session.pause_latched = True
        session.caption_scene.clear('paused')
        self.service.backend = AsyncMock(return_value={'captured': True})
        task = asyncio.create_task(session.deliver())
        try:
            self.queue(session,{'id': '1', 'text': 'Delayed private sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            self.assertEqual(session.caption_scene.snapshot()['state'], 'paused')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_delayed_and_queued_pre_pause_segments_never_reappear_after_resume(self):
        session = self.fixture_session()
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
        self.queue(session,{'id': '1', 'text': 'Private in-flight sentence.'})
        task = asyncio.create_task(session.deliver())
        try:
            await asyncio.wait_for(started.wait(), 1)
            self.queue(session,{'id': '2', 'text': 'Private queued sentence.'})
            self.assertEqual(session.segments.qsize(), 1)
            session.caption_scene.clear('paused')
            session.caption_scene.apply_policy(policy)
            release.set()
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], [])
            self.queue(session,{'id': '3', 'text': 'Fresh approved sentence.'})
            await asyncio.wait_for(session.segments.join(), 1)
            self.assertEqual(session.caption_scene.snapshot()['segments'], ['Fresh approved sentence.'])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_first_caption_policy_must_match_activated_call(self):
        session = self.fixture_session()
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

    async def test_segment_reply_plays_once_with_transient_text_and_policy_recheck(self):
        session=Session(self.service,{**self.spec,'captions':False})
        session.active=True;session.allowed=True;session.policy_at=time.monotonic()
        session.call_id='owned-call';session.say=AsyncMock()
        policy={'callId':'owned-call','state':'listening','expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()}
        async def backend(path,body=None):
            return policy if path.endswith('/policy') else {'captured':True,'reply':'Private fixture reply.'}
        self.service.backend=AsyncMock(side_effect=backend)
        task=asyncio.create_task(session.deliver())
        try:
            for _ in range(2):
                self.queue(session,{'id':'1','callId':'owned-call','text':'Fixture question'})
                await asyncio.wait_for(session.segments.join(),1)
                await asyncio.gather(*list(self.service.speech_tasks.values()))
            session.say.assert_awaited_once_with('Private fixture reply.')
            rows=self.service.db.execute('SELECT state,fingerprint FROM speech').fetchall()
            self.assertEqual(len(rows),1);self.assertEqual(rows[0][0],'completed')
            self.assertNotIn('Private fixture reply',' '.join(self.service.db.iterdump()))
            self.service.backend.assert_any_await(f'/media/{session.id}/policy')
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_segment_reply_cannot_cross_pause_during_callback(self):
        session=Session(self.service,{**self.spec,'captions':False})
        session.active=True;session.allowed=True;session.policy_at=time.monotonic()
        session.call_id='owned-call';session.say=AsyncMock()
        async def backend(path,body=None):
            session.pause_latched=True;session.generation+=1
            return {'captured':True,'reply':'Do not speak this stale reply.'}
        self.service.backend=AsyncMock(side_effect=backend)
        task=asyncio.create_task(session.deliver())
        try:
            self.queue(session,{'id':'1','callId':'owned-call','text':'Fixture question'})
            await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(self.service.db.execute('SELECT count(*) FROM speech').fetchone()[0],0)
            session.say.assert_not_awaited()
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_busy_reply_is_cancelled_never_replayed_or_overlapped(self):
        session=self.fixture_session()
        session.active=True;session.call_id='owned-call';session.speaking=True;session.say=AsyncMock()
        segment={'id':'1','callId':'owned-call'};result={'captured':True,'reply':'Fixture'}
        self.service.reply_to_segment(session,segment,result)
        session.speaking=False
        self.service.reply_to_segment(session,segment,result)
        self.assertFalse(self.service.speech_tasks)
        self.assertEqual(self.service.db.execute('SELECT state,reason FROM speech').fetchone(),('cancelled','speech_busy'))
        session.say.assert_not_awaited()

    async def test_reply_cancels_if_policy_closed_before_playback(self):
        session=self.fixture_session()
        session.active=True;session.allowed=True;session.policy_at=time.monotonic()
        session.call_id='owned-call';session.say=AsyncMock()
        self.service.backend=AsyncMock(return_value={'callId':'owned-call','state':'ended'})
        self.service.reply_to_segment(session,{'id':'1','callId':'owned-call'},{'captured':True,'reply':'Fixture'})
        await asyncio.gather(*list(self.service.speech_tasks.values()))
        session.say.assert_not_awaited()
        self.assertEqual(self.service.db.execute('SELECT state FROM speech').fetchone()[0],'cancelled')

    async def test_only_conversational_callback_extends_response_deadline(self):
        self.service.env['BACKEND_URL']='http://127.0.0.1:1'
        response=SimpleNamespace(status=200,content=SimpleNamespace(read=AsyncMock(return_value=b'{}')))
        context=AsyncMock();context.__aenter__.return_value=response
        with patch.object(self.service.http,'request',return_value=context) as request:
            await self.service.backend(f"/media/{self.spec['id']}/segments",{'id':'1'})
            timeout=request.call_args.kwargs['timeout']
            self.assertEqual((timeout.total,timeout.sock_read),(60,55))
            await self.service.backend(f"/media/{self.spec['id']}/policy")
            self.assertNotIn('timeout',request.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
