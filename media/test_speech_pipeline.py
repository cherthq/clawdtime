"""Synthetic audio -> real local WebSocket -> assembler -> local HTTP callback.

No provider, microphone, handset, credentials, or native control is exercised.
"""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
from aiohttp import web, WSMsgType
from aiohttp.test_utils import TestServer
import test_segment_delivery
from test_utterances import result
from utterances import UtteranceAssembler
from server import Service
from aiohttp.test_utils import make_mocked_request


class SyntheticAudio:
    def __init__(self, *args, **kwargs):
        self.closed = False

    async def __aiter__(self):
        while not self.closed:
            yield SimpleNamespace(frame=SimpleNamespace(data=b'\x01\x00'*160))
            await asyncio.sleep(.02)

    async def aclose(self):
        self.closed = True


class SpeechPipelineTests(IsolatedAsyncioTestCase):
    asyncSetUp = test_segment_delivery.SegmentDeliveryTests.asyncSetUp
    asyncTearDown = test_segment_delivery.SegmentDeliveryTests.asyncTearDown

    async def until(self, predicate):
        async def wait():
            while not predicate():
                self.session.policy_at = time.monotonic()
                await asyncio.sleep(.01)
        await asyncio.wait_for(wait(),3)

    async def test_repeated_requests_survive_noise_shrinking_windows_and_bad_json(self):
        self.session.protocol_version=2
        self.session.utterances=UtteranceAssembler(settle_seconds=.02,vad_grace_seconds=.05)
        self.session.track=object()
        self.service.env['DEEPGRAM_API_KEY']='synthetic-local-only'
        self.service.backend=AsyncMock(wraps=self.service.backend)
        connected=asyncio.Event()
        sockets=[]
        binary=[]
        async def listen(request):
            socket=web.WebSocketResponse()
            await socket.prepare(request)
            sockets.append(socket)
            connected.set()
            async for message in socket:
                if message.type==WSMsgType.BINARY:
                    binary.append(len(message.data))
            return socket
        app=web.Application()
        app.router.add_get('/listen',listen)
        provider=TestServer(app)
        await provider.start_server()
        original=self.http.ws_connect
        def local_connect(url, **kwargs):
            self.assertEqual(url,'wss://api.deepgram.com/v1/listen')
            return original(provider.make_url('/listen'))
        capture=None
        try:
            with patch.object(self.http,'ws_connect',side_effect=local_connect), patch('server.rtc.AudioStream',SyntheticAudio):
                capture=asyncio.create_task(self.session.capture_loop())
                await asyncio.wait_for(connected.wait(),1)
                await sockets[0].send_str('malformed synthetic JSON')
                await sockets[0].send_json([])
                for i in range(5):
                    start=i*10
                    await sockets[0].send_json({'type':'SpeechStarted','timestamp':start})
                    await sockets[0].send_json(result('provisional synthetic',start,4.3,final=False))
                    await sockets[0].send_json(result(f'Synthetic request {i}',start,3.26,boundary=True))
                    await sockets[0].send_json({'type':'SpeechStarted','timestamp':start+3.3})
                    await sockets[0].send_json(result('',start+3.26,1,boundary=True))
                    await self.until(lambda:len(self.effects)==i+1 and not self.session.delivering)
                self.assertEqual(self.requests,['1','2','3','4','5'])
                self.assertEqual([call.args[1]['text'] for call in self.service.backend.call_args_list],
                                 [f'Synthetic request {i}' for i in range(5)])
                self.assertTrue(binary)
                self.session.fail.assert_not_awaited()
                # An incomplete request must vanish on generation change, not dispatch.
                await sockets[0].send_json(result('Do not deliver synthetic',50,1,final=False))
                await self.until(lambda:self.session.utterances.unfinalized)
                self.session.allowed=False
                await self.session.stop_stt()
                self.assertEqual(len(self.requests),5)
        finally:
            if capture:
                capture.cancel()
                await asyncio.gather(capture,return_exceptions=True)
            for socket in sockets:
                await socket.close()
            await provider.close()
        self.session.speech_diagnostics.flush(force=True)
        data=self.session.lifecycle.data['speech']
        for name,count in [('provider_invalid',2),('provider_final',5),('utterance_emitted',5),
                           ('queue_accepted',5),('callback_accepted',5)]:
            self.assertEqual(data['counts'][name],count,name)
        self.assertGreater(data['counts']['audio_sent_frames'],0)
        self.assertNotIn('Synthetic',json.dumps(data))
        self.assertNotIn('provisional',json.dumps(data))
        self.assertEqual(data['state']['phase'],'idle')
        # The same redacted timeline remains queryable after the live session is gone.
        self.service.db.execute('INSERT INTO sessions VALUES(?,?,?)',
                                (self.session.id,'synthetic','closed'))
        self.service.db.commit()
        restarted=Service(self.service.env)
        try:
            response=await restarted.status(make_mocked_request('GET','/sessions/'+self.session.id,
                match_info={'id':self.session.id}))
            status=json.loads(response.text)
            self.assertFalse(status['alive'])
            self.assertEqual(status['lifecycleDiagnostics']['speech'],data)
        finally:
            restarted.db.close()
