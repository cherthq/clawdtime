"""Actual pinned Live SDK + RTC PCM plumbing against loopback, no handset."""
import asyncio
import base64
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from aiohttp import web, WSMsgType
from aiohttp.test_utils import TestServer
from acoustic import AcousticFrontend, readiness
from server import Service, Session
from test_acoustic import policy, ENV


@unittest.skipUnless(readiness(ENV)['sdk']['available'] and readiness(ENV)['websocketQualified'],
                     'optional pinned Live SDK not installed')
class AcousticSDKTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_sdk_audio_no_broker_transcript_retention_or_retry(self):
        from openai import AsyncOpenAI
        from livekit import rtc
        input_seen = asyncio.Event()
        disconnected = asyncio.Event()
        sent = []
        connections = []
        async def socket(request):
            connections.append(True)
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            try:
                async for message in ws:
                    if message.type != WSMsgType.TEXT:
                        continue
                    event = json.loads(message.data)
                    sent.append(event['type'])
                    if event['type'] == 'session.start':
                        config = event['session']
                        self.assertEqual(config['delegation'], {'type': 'client'})
                        self.assertEqual(config['audio']['format'], {'type': 'audio/pcm', 'rate': 24000})
                        self.assertIs(config['store'], False)
                        self.assertNotIn('tools', config)
                        await ws.send_json({'type': 'session.started', 'session': {'id': 'fixture'}})
                    elif event['type'] == 'session.input_audio.append':
                        self.assertEqual(len(base64.b64decode(event['audio'])), 960)
                        await ws.send_json({'type': 'session.output_audio.delta',
                                           'delta': base64.b64encode(b'\x00\x10'*2400).decode()})
                        await ws.send_json({'type': 'session.input_transcript.delta', 'delta': 'PRIVATE_SYNTHETIC_TEXT'})
                        await ws.send_json({'type': 'delegation.created', 'delegation': {
                            'type': 'delegation', 'id': 'private_task', 'target': 'client'}, 'offset_ms': 0, 'event_id': 'private_event'})
                        input_seen.set()
                    elif event['type'] == 'session.close':
                        await ws.send_json({'type': 'session.closed', 'reason': 'close_requested'})
            finally:
                disconnected.set()
            return ws
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', socket)
        remote = TestServer(app)
        await remote.start_server()
        folder = tempfile.TemporaryDirectory()
        service = Service({**ENV, 'MEDIA_DATABASE_PATH': str(Path(folder.name)/'media.sqlite')})
        parent = Session(service, {'id': 'ct_'+'d'*40, 'meetingId': 'request',
            'audioQualification': True, 'captions': False, 'screen': False})
        service.sessions[parent.id] = parent
        p = policy()
        parent.call_id = p['callId']
        parent.active = parent.allowed = True
        parent.policy_at = time.monotonic()
        parent.apply_voice_policy(p)
        frontend = AcousticFrontend(parent, p)
        parent.live_frontend = frontend
        def client(**kwargs):
            return AsyncOpenAI(**{**kwargs, 'base_url': str(remote.make_url('')).rstrip('/')})
        try:
            with patch('openai.AsyncOpenAI', side_effect=client), patch('acoustic.verified_tls_context', return_value=None):
                await frontend.start()
            await frontend.send_frame(rtc.AudioFrame(bytes(960), 24000, 1, 480))
            await asyncio.wait_for(input_seen.wait(), 1)
            for _ in range(30):
                if frontend.counts['discardedDelegations']:
                    break
                await asyncio.sleep(.01)
            self.assertGreater(parent.audio.qsize(), 0)
            self.assertEqual(frontend.counts['discardedDelegations'], 1)
            self.assertEqual(frontend.counts['discardedTranscriptEvents'], 1)
            frontend.snapshot()
            evidence = json.dumps(parent.lifecycle.data)
            self.assertNotIn('PRIVATE_SYNTHETIC_TEXT', evidence)
            self.assertNotIn('private_task', evidence)
            self.assertEqual(parent.segment_count, 0)
            self.assertFalse(hasattr(frontend, 'broker'))
            await frontend.close()
            await asyncio.wait_for(disconnected.wait(), 1)
            self.assertTrue(frontend.finalized.is_set())
            self.assertEqual(len(connections), 1)
            self.assertEqual(sent, ['session.start', 'session.input_audio.append', 'session.close'])
            self.assertIsNone(parent.screen)
            self.assertIsNone(parent.caption_scene)
        finally:
            await frontend.close()
            for task in list(parent.tasks):
                task.cancel()
            await asyncio.gather(*parent.tasks, return_exceptions=True)
            await remote.close()
            service.db.close()
            folder.cleanup()
