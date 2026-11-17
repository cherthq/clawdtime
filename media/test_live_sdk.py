"""Optional installed-SDK compatibility fixture. No provider or handset proof."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from aiohttp import web, WSMsgType, ClientSession
from aiohttp.test_utils import TestServer
from conversational import GPTLiveFrontend, sdk_readiness
from server import Service, Session


@unittest.skipUnless(sdk_readiness()['available'], 'optional pinned LiveKit Agents SDK not installed')
class LiveSDKTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_frontend_delegation_to_backend_verified_result_and_provider_ack(self):
        from livekit.plugins import openai
        from livekit import rtc
        provider_connected=asyncio.Event(); submitted=asyncio.Event()
        provider=[];requests=[];commentaries=[]
        state={'job':{'id':'job_fixture','revision':1,'state':'queued'}}
        async def socket(request):
            ws=web.WebSocketResponse();await ws.prepare(request);provider.append(ws)
            async for message in ws:
                if message.type!=WSMsgType.TEXT:continue
                value=json.loads(message.data)
                if value['type']=='session.start':
                    self.assertEqual(value['session']['delegation'],{'type':'client'})
                    self.assertNotIn('tools',value['session'])
                    await ws.send_json({'type':'session.started','session':{'id':'fixture_session'}})
                    provider_connected.set()
                elif value['type']=='session.commentary.append':
                    commentaries.append(value)
                    await ws.send_json({'type':'session.commentary.appended','client_event_id':value['event_id'],
                                        'start_ms':0,'end_ms':100})
                elif value['type']=='session.close':
                    await ws.send_json({'type':'session.closed','reason':'close_requested','usage':{'seconds':1}})
            return ws
        async def turn(request):
            value=await request.json();requests.append(value);submitted.set()
            if len(requests) == 1:
                return web.json_response({'reply':'The fixture task is queued.','sequence':1,'job':state['job']})
            return web.json_response({'reply':'You are welcome.','sequence':2})
        async def jobs(request):
            return web.json_response({'sequence':1,'jobs':[state['job']]})
        app=web.Application()
        app.router.add_post('/media/{sid}/conversation/turn',turn)
        app.router.add_get('/media/{sid}/conversation/jobs',jobs)
        app.router.add_route('*','/live/sessions',socket)
        remote=TestServer(app);await remote.start_server()
        tmp=tempfile.TemporaryDirectory()
        service=Service({'MEDIA_DATABASE_PATH':str(Path(tmp.name)/'media.sqlite'),'OPENAI_API_KEY':'synthetic',
                         'BACKEND_URL':str(remote.make_url('')).rstrip('/'),'MEDIA_API_KEY':'x'*32})
        service.http=ClientSession()
        parent=Session(service,{'id':'ct_'+'c'*40,'meetingId':'request'})
        service.sessions[parent.id]=parent
        parent.call_id='call';parent.active=True;parent.allowed=True;parent.two_way=True;parent.policy_at=time.monotonic()
        frontend=GPTLiveFrontend(parent);parent.live_frontend=frontend
        original=openai.realtime.GPTLiveModel
        def model(**kwargs):return original(**kwargs,base_url=str(remote.make_url('')).rstrip('/'))
        async def keep_fresh():
            while True:
                parent.policy_at=time.monotonic()
                await asyncio.sleep(.05)
        freshness=asyncio.create_task(keep_fresh())
        async def wait_until(predicate):
            for _ in range(300):
                if predicate():return
                await asyncio.sleep(.01)
            self.fail('Bounded SDK fixture did not complete')
        try:
            with patch.object(openai.realtime,'GPTLiveModel',side_effect=model):
                await asyncio.wait_for(frontend.start(),5)
            await provider_connected.wait()
            await provider[0].send_json({'type':'session.input_transcript.delta','delta':'Create',
                                         'start_ms':0,'end_ms':100})
            await provider[0].send_json({'type':'session.delegation.created','event_id':'event_d1',
                'delegation':{'type':'delegation','id':'delegate_fixture','target':'client'},'offset_ms':100})
            # Let the actual SDK see the current speech item before its 800ms
            # audio-clock finalization. No private SDK methods/events are invoked.
            await asyncio.sleep(.03)
            self.assertEqual(requests,[])
            # The pinned SDK finalizes after 800ms pushed audio even when that
            # audio is not quiet. Application gating must retain both fragments.
            for _ in range(45):
                await frontend.audio_input.queue.put(rtc.AudioFrame(b'\x00\x10'*960,48000,1,960))
            await asyncio.sleep(.03)
            self.assertEqual(requests,[])
            await provider[0].send_json({'type':'session.input_transcript.delta','delta':'the fixture',
                                         'start_ms':1000,'end_ms':1100})
            await asyncio.sleep(.03)
            for _ in range(60):
                await frontend.audio_input.queue.put(rtc.AudioFrame(bytes(1920),48000,1,960))
            await asyncio.wait_for(submitted.wait(),2)
            await wait_until(lambda:frontend.commentary_receipts.counts['acknowledged']==1)
            self.assertEqual(len(requests),1)
            self.assertEqual(requests[0]['text'],'Create the fixture')
            self.assertTrue(requests[0]['qualifiedRemoteAudio'])
            self.assertEqual(commentaries[0]['delegation_id'],'delegate_fixture')
            self.assertIn('queued',commentaries[0]['content'])
            state['job']={**state['job'],'state':'succeeded','result':{'summary':'Unverified fixture'}}
            await asyncio.sleep(.6)
            self.assertEqual(len(commentaries),1)
            # Real SDK creates a second speech item without any delegation. Its
            # final alone must not release the old result; measured quiet and a
            # second real HTTP backend interpretation do so.
            await provider[0].send_json({'type':'session.input_transcript.delta','delta':'Thank you',
                                         'start_ms':2000,'end_ms':2100})
            await asyncio.sleep(.03)
            state['job']={**state['job'],'result':{'summary':'Independent fixture read matched.',
                                                'verification':{'verified':True}}}
            await asyncio.sleep(.6)
            self.assertEqual(len(commentaries),1)
            for _ in range(60):
                await frontend.audio_input.queue.put(rtc.AudioFrame(bytes(1920),48000,1,960))
            await wait_until(lambda:frontend.commentary_receipts.counts['acknowledged']==3)
            self.assertEqual(len(requests),2)
            self.assertEqual(requests[1]['text'],'Thank you')
            self.assertIsNone(commentaries[1].get('delegation_id'))
            self.assertIn('verified result',commentaries[2]['content'])
            self.assertEqual(commentaries[2]['delegation_id'],'delegate_fixture')
            await provider[0].send_json({'type':'session.delegation.created','event_id':'event_duplicate',
                'delegation':{'type':'delegation','id':'delegate_fixture','target':'client'},'offset_ms':100})
            await asyncio.sleep(.03)
            self.assertEqual(len(requests),2)
            self.assertEqual(frontend.commentary_receipts.snapshot()['acknowledged'],3)
            self.assertEqual(frontend.commentary_receipts.snapshot()['pending'],0)
        finally:
            await frontend.close()
            freshness.cancel()
            for task in list(parent.tasks):task.cancel()
            await asyncio.gather(freshness,*parent.tasks,return_exceptions=True)
            await service.http.close()
            service.db.close();await remote.close();tmp.cleanup()

    async def test_real_agents_runtime_uses_client_mode_and_closes_without_recording(self):
        from livekit.plugins import openai
        from livekit import rtc
        messages=[];started=asyncio.Event();audio=asyncio.Event()
        async def socket(request):
            ws=web.WebSocketResponse();await ws.prepare(request)
            async for message in ws:
                if message.type!=WSMsgType.TEXT:continue
                value=json.loads(message.data)
                messages.append(value['type'])
                if value['type']=='session.start':
                    self.assertEqual(value['session']['model'],'gpt-live-1')
                    self.assertEqual(value['session']['delegation'],{'type':'client'})
                    await ws.send_json({'type':'session.started','session':{'id':'fixture_session'}})
                    started.set()
                elif value['type']=='session.input_audio.append':audio.set()
                elif value['type']=='session.close':
                    await ws.send_json({'type':'session.closed','reason':'close_requested'})
            return ws
        app=web.Application();app.router.add_route('*','/{tail:.*}',socket)
        remote=TestServer(app);await remote.start_server()
        tmp=tempfile.TemporaryDirectory()
        service=Service({'MEDIA_DATABASE_PATH':str(Path(tmp.name)/'media.sqlite'),'OPENAI_API_KEY':'synthetic'})
        parent=Session(service,{'id':'ct_'+'a'*40,'meetingId':'request'})
        service.sessions[parent.id]=parent
        parent.call_id='call';parent.active=True;parent.allowed=True;parent.two_way=True;parent.policy_at=time.monotonic()
        parent.owner.backend=lambda *_: asyncio.sleep(0,result={'jobs':[]})
        frontend=GPTLiveFrontend(parent);parent.live_frontend=frontend
        original=openai.realtime.GPTLiveModel
        def model(**kwargs):return original(**kwargs,base_url=str(remote.make_url('')).rstrip('/'))
        try:
            with patch.object(openai.realtime,'GPTLiveModel',side_effect=model):
                await asyncio.wait_for(frontend.start(),5)
                await asyncio.wait_for(started.wait(),5)
                for _ in range(20):
                    await frontend.audio_input.queue.put(rtc.AudioFrame(bytes(1920),48000,1,960))
                await asyncio.wait_for(audio.wait(),2)
                self.assertTrue(frontend.ready.is_set())
                self.assertTrue(any(name=='session.start' for name in messages))
                # Public custom sink API: an old drain cannot stop a newer
                # playback generation or let an interrupted burst adopt it.
                sink=frontend.session.output.audio
                await sink.capture_frame(rtc.AudioFrame(b'\x00\x10'*960,48000,1,960))
                sink.flush()
                await asyncio.sleep(0)
                old=[]
                while not parent.audio.empty():old.append(parent.audio.get_nowait())
                await sink.capture_frame(rtc.AudioFrame(b'\x00\x10'*960,48000,1,960))
                newer=parent.playback_generation
                for generation, value in old:
                    if isinstance(value,asyncio.Future) and not value.done():value.set_result(None)
                await asyncio.sleep(.01)
                self.assertEqual(parent.playback_generation,newer)
                self.assertTrue(parent.speaking)
                parent.playback_generation+=1
                queued=parent.audio.qsize()
                await sink.capture_frame(rtc.AudioFrame(b'\x00\x10'*960,48000,1,960))
                self.assertEqual(parent.audio.qsize(),queued)
                sink.flush();sink.clear_buffer()
        finally:
            await frontend.close()
            for task in list(parent.tasks):task.cancel()
            await asyncio.gather(*parent.tasks,return_exceptions=True)
            service.db.close();await remote.close();tmp.cleanup()
