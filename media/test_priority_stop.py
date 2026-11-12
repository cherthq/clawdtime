import asyncio
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
import time
import unittest
from unittest.mock import AsyncMock,Mock

from policy import priority_stop_requested
from server import Session
import test_service


class PriorityStopTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=test_service.ServiceTests.asyncSetUp
    asyncTearDown=test_service.ServiceTests.asyncTearDown

    def session(self):
        session=Session(self.service,{'id':'ct_'+'a'*40,'meetingId':'fixture','lineId':'line','captions':True})
        session.active=True;session.allowed=True;session.policy_at=time.monotonic()
        session.call_id='owned-call';session.track_sid='qualified-remote-audio'
        session.screen=SimpleNamespace(update=Mock())
        return session

    def segment(self,session,identifier='2',text='Stop'):
        return {'id':identifier,'text':text,'at':datetime.now(timezone.utc).isoformat(),
                'source':'remote_participant','callId':session.call_id,'participantIdentity':session.worker_identity}

    async def test_priority_stop_bypasses_slow_turn_once_and_drops_queued_work(self):
        session=self.session();entered=asyncio.Event();release=asyncio.Event();stopped=asyncio.Event()
        received=[]
        async def backend(path,body):
            received.append(body['id'])
            if body['id']=='1':
                entered.set();await release.wait()
                return {'captured':True,'reply':'This delayed reply must not play.'}
            self.assertEqual(body,self.segment_at_stop)
            stopped.set();return {'captured':False,'stopped':True}
        self.service.backend=AsyncMock(side_effect=backend)
        task=asyncio.create_task(session.deliver())
        try:
            session.queue_segment(self.segment(session,'1','Explain this screen'))
            await asyncio.wait_for(entered.wait(),1)
            session.queue_segment(self.segment(session,'2','Click a button'))
            self.segment_at_stop=self.segment(session,'3','Stop sharing!')
            self.assertTrue(session.queue_segment(self.segment_at_stop))
            session.queue_segment(self.segment_at_stop)
            await asyncio.wait_for(stopped.wait(),1)
            await session.priority_stop_task
            self.assertFalse(session.allowed);self.assertTrue(session.pause_latched)
            self.assertEqual(session.priority_stop_state,'acknowledged')
            session.screen.update.assert_called_once_with({})
            self.assertEqual(received,['1','3'])
            release.set();await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(self.service.db.execute('SELECT count(*) FROM speech').fetchone()[0],0)
        finally:
            release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_lost_stop_acknowledgement_is_unknown_without_retry(self):
        session=self.session();self.service.backend=AsyncMock(side_effect=TimeoutError('fixture'))
        stop=self.segment(session)
        self.assertTrue(session.queue_segment(stop))
        await session.priority_stop_task
        for _ in range(3):self.assertTrue(session.queue_segment(stop))
        self.assertEqual(session.priority_stop_state,'unknown')
        self.service.backend.assert_awaited_once()
        self.assertTrue(session.pause_latched);self.assertFalse(session.allowed)

    async def test_stop_prevents_retry_of_an_inflight_ordinary_callback(self):
        session=self.session();entered=asyncio.Event();release=asyncio.Event()
        received=[]
        async def backend(path,body):
            received.append(body['id'])
            if body['id']=='1':
                entered.set();await release.wait();raise TimeoutError('ordinary reply lost')
            return {'stopped':True,'captured':False}
        self.service.backend=AsyncMock(side_effect=backend)
        task=asyncio.create_task(session.deliver())
        try:
            session.queue_segment(self.segment(session,'1','Explain the screen'))
            await asyncio.wait_for(entered.wait(),1)
            session.queue_segment(self.segment(session,'2','Stop'))
            await session.priority_stop_task
            release.set();await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(received,['1','2'])
            self.assertFalse(task.done())
        finally:release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_priority_requires_exact_fresh_qualified_remote_audio(self):
        for mutation in ['stale','foreign-call','foreign-participant','source','inactive','policy-expired','speaking','no-track']:
            session=self.session();segment=self.segment(session)
            if mutation=='stale':segment['at']=(datetime.now(timezone.utc)-timedelta(seconds=11)).isoformat()
            if mutation=='foreign-call':segment['callId']='foreign'
            if mutation=='foreign-participant':segment['participantIdentity']='other'
            if mutation=='source':segment['source']='local_microphone'
            if mutation=='inactive':session.active=False
            if mutation=='policy-expired':session.policy_at=time.monotonic()-3
            if mutation=='speaking':session.speaking=True
            if mutation=='no-track':session.track_sid=None
            self.assertFalse(session.priority_stop_allowed(segment),mutation)
            self.assertIsNone(session.priority_stop_task)

    async def test_ordinary_voice_never_dispatches_in_parallel(self):
        session=self.session();self.service.backend=AsyncMock()
        for index,text in enumerate(['Please stop later','Stop the spinner and click submit','Can you stop?','Stop sharing and type hello'],1):
            self.assertFalse(session.queue_segment(self.segment(session,str(index),text)))
        self.assertEqual(session.segments.qsize(),1)
        self.assertIsNone(session.priority_stop_task)
        self.service.backend.assert_not_awaited()

    async def test_stop_latch_cannot_reset_when_backend_policy_resumes(self):
        session=self.session();session.priority_stop_id='1';session.pause_latched=True;session.seen_pause=True
        session.stop_stt=AsyncMock()
        self.service.backend=AsyncMock(return_value={'callId':session.call_id,'state':'listening',
            'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat()})
        task=asyncio.create_task(session.watch_policy())
        try:
            await asyncio.sleep(.02)
            self.assertTrue(session.pause_latched);self.assertFalse(session.allowed)
        finally:task.cancel();await asyncio.gather(task,return_exceptions=True)


class LiteralStopTests(unittest.TestCase):
    def test_only_fail_safe_literals(self):
        for text in ['stop','Stop sharing.','STOP CONTROL!','stop listening','Hey ClawdTime, stop','ClawdTime stop control']:
            self.assertTrue(priority_stop_requested(text),text)
        for text in ['pause','go','please stop','stop after clicking','stop recording then send','the button says stop',None]:
            self.assertFalse(priority_stop_requested(text),text)
