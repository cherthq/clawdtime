"""Real loopback HTTP callback tests; no provider, capture, or native input."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import time
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock

from aiohttp import ClientSession, ClientTimeout, web
from aiohttp.test_utils import TestServer
from server import Service, Session


class SegmentDeliveryTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.requests = []
        self.effects = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.mode = 'ok'
        async def receive(request):
            body = await request.json()
            self.requests.append(body['id'])
            expired=abs((datetime.now(timezone.utc)-datetime.fromisoformat(body['at'])).total_seconds()) > 10
            if body['text'] == 'Stop':
                return web.json_response({'stopped':True,'captured':False})
            if self.mode == 'transport':
                request.transport.close()
                return web.Response()
            if self.mode == 'slow' and body['id'] == '1':
                self.entered.set()
                await self.release.wait()
            elif self.mode == 'timeout' and body['id'] == '1':
                self.entered.set()
                await self.release.wait()
            elif self.mode == 'stale':
                return web.json_response({'errorCode':'stale_speech','captured':False},status=409)
            elif self.mode == 'refused':
                return web.json_response({'error':'synthetic private detail'},status=500)
            elif self.mode == 'invalid':
                return web.Response(text='synthetic private invalid JSON')
            elif self.mode == 'array':
                return web.json_response([])
            if expired:
                return web.json_response({'errorCode':'stale_speech','captured':False},status=409)
            self.effects.append(body['id'])
            return web.json_response({'captured':True,'reply':'Synthetic accepted reply'})
        app = web.Application()
        app.router.add_post('/media/{id}/segments', receive)
        self.backend = TestServer(app)
        await self.backend.start_server()
        self.service = Service({'MEDIA_DATABASE_PATH':str(Path(self.tmp.name)/'media.sqlite'),
            'BACKEND_URL':str(self.backend.make_url('/')).rstrip('/'),'MEDIA_API_KEY':'m'*32})
        self.http = ClientSession()
        self.service.http = self.http
        self.service.reply_to_segment = Mock()
        self.session = Session(self.service, {'id':'ct_'+'a'*40,'meetingId':'fixture'})
        self.session.active = self.session.allowed = True
        self.session.call_id = 'owned-call'
        self.session.policy_at = time.monotonic()
        self.session.track_sid = 'qualified'
        self.session.fail = AsyncMock()
        self.session.close = AsyncMock()
        self.task = self.session.task(self.session.deliver(), 'segment_delivery')

    async def asyncTearDown(self):
        self.release.set()
        self.task.cancel()
        await asyncio.gather(self.task, *list(self.session.tasks), return_exceptions=True)
        await self.http.close()
        await self.backend.close()
        self.service.db.close()
        self.tmp.cleanup()

    def segment(self, identifier, age=0):
        return {'id':identifier,'text':'synthetic request',
            'at':(datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat(),
            'source':'remote_participant','callId':self.session.call_id,
            'participantIdentity':self.session.worker_identity}

    async def drain(self):
        await asyncio.wait_for(self.session.segments.join(), 3)
        await asyncio.sleep(0)

    def assert_alive(self):
        self.assertFalse(self.task.done())
        self.session.fail.assert_not_awaited()
        self.session.close.assert_not_awaited()
        self.assertFalse(self.session.closing)
        self.assertNotIn('firstFailure', self.session.lifecycle.data)

    async def fresh_turn(self, identifier='3'):
        self.mode='ok'
        self.session.policy_at=time.monotonic()
        self.session.queue_segment(self.segment(identifier))
        await self.drain()
        self.assertEqual(self.requests[-1],identifier)
        self.assert_alive()

    async def test_27_second_turn_discards_aged_queue_then_accepts_fresh_turn(self):
        self.mode='slow'
        self.session.queue_segment(self.segment('1'))
        await asyncio.wait_for(self.entered.wait(),1)
        self.session.queue_segment(self.segment('2'))
        # Exercise the actual observed turn duration against the unchanged 10s limit.
        await asyncio.sleep(27)
        self.session.policy_at=time.monotonic()
        self.release.set()
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'stale_queue')
        self.assert_alive()
        await self.fresh_turn()
        self.assertEqual(self.requests,['1','3'])

    async def test_explicit_stale409_is_once_and_nonfatal(self):
        self.mode='stale'
        self.session.queue_segment(self.segment('1'))
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'callback_stale')
        self.assert_alive()
        await self.fresh_turn()

    async def test_500_invalid_json_and_wrong_response_shape_are_nonfatal_without_repost(self):
        for index,mode in enumerate(['refused','invalid','array','transport'],1):
            self.mode=mode
            identifier=str(index)
            self.session.queue_segment(self.segment(identifier))
            await self.drain()
            self.assertEqual(self.requests.count(identifier),1)
            self.assert_alive()
            diagnostic=self.session.lifecycle.data['lastSegmentFailure']
            self.assertNotIn('private',str(diagnostic))
            self.assertIn(diagnostic['reason'],['callback_refused','callback_invalid_response','callback_transport'])
        await self.fresh_turn('5')

    async def test_timeout_keeps_unknown_without_repost_or_queued_followup(self):
        self.mode='timeout'
        real_http=self.http
        class ShortTestDeadline:
            def request(self,*args,**kwargs):
                # Test-only HTTP deadline; production timeout configuration is unchanged.
                kwargs['timeout']=ClientTimeout(total=.05)
                return real_http.request(*args,**kwargs)
        self.service.http=ShortTestDeadline()
        self.session.queue_segment(self.segment('1'))
        await asyncio.wait_for(self.entered.wait(),1)
        self.session.queue_segment(self.segment('2'))
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'callback_timeout')
        self.assert_alive()
        # The original server request can finish later, but no replay is generated.
        self.release.set()
        await asyncio.sleep(.03)
        self.service.http=real_http
        await self.fresh_turn()
        self.assertEqual(self.requests,['1','3'])
        self.assertEqual(self.effects.count('1'),1)
        self.assertEqual(self.effects.count('2'),0)

    async def test_queue_full_and_malformed_entry_do_not_kill_capture_or_delivery(self):
        self.mode='slow'
        self.session.queue_segment(self.segment('1'))
        await asyncio.wait_for(self.entered.wait(),1)
        for number in range(2,15):
            self.session.queue_segment(self.segment(str(number)))
        self.assertEqual(self.session.segments.qsize(),1)
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'queue_full')
        self.release.set()
        await self.drain()
        self.session.queue_segment({'id':'malformed','text':'synthetic private'})
        await self.drain()
        self.assert_alive()
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'invalid_segment')

    async def test_generation_change_discards_queue_without_dispatch(self):
        self.mode='slow'
        self.session.queue_segment(self.segment('1'))
        await asyncio.wait_for(self.entered.wait(),1)
        self.session.queue_segment(self.segment('2'))
        self.session.generation+=1
        self.release.set()
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'obsolete_generation')
        self.assert_alive()

    async def test_stop_bypasses_blocked_http_turn_and_clears_full_queue(self):
        self.mode='slow'
        self.session.queue_segment(self.segment('1'))
        await asyncio.wait_for(self.entered.wait(),1)
        self.session.queue_segment(self.segment('2'))
        self.session.queue_segment(self.segment('3'))
        stop=self.segment('4')
        stop['text']='Stop'
        self.assertTrue(self.session.queue_segment(stop))
        await asyncio.wait_for(self.session.priority_stop_task,1)
        self.assertEqual(self.session.priority_stop_state,'acknowledged')
        self.assertFalse(self.session.allowed)
        self.assertEqual(self.requests,['1','4'])
        self.release.set()
        await self.drain()
        self.service.reply_to_segment.assert_not_called()
        self.assertEqual(self.session.segments.qsize(),0)
        self.assertIsNone(self.session.delivery_notice)

    async def test_feedback_receipt_failure_cannot_kill_delivery_or_retry_command(self):
        self.service.reply_to_segment.side_effect=RuntimeError('synthetic private receipt failure')
        self.session.queue_segment(self.segment('1'))
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assert_alive()
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'callback_invalid_response')
        self.service.reply_to_segment.side_effect=None
        await self.fresh_turn()

    async def test_authority_loss_before_dequeue_discards_without_post_or_notice(self):
        self.session.queue_segment(self.segment('1'))
        self.session.allowed=False
        await self.drain()
        self.assertEqual(self.requests,[])
        self.assertEqual(self.session.lifecycle.data['lastSegmentFailure']['reason'],'authority_closed')
        self.service.reply_to_segment.assert_not_called()
        self.assert_alive()
