"""Offline SDK/event and localhost provider tests; never opens a real room/call."""
import asyncio
import base64
import copy
import json
import socket
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer, TestClient
from livekit import rtc

from task_voice import VoiceError
from task_voice_livekit_local import control_app, configured_app
from task_voice_livekit import LiveKitAudioPort, TaskAudioJournal, TaskVoiceLiveKit, validate_binding, fingerprint, FixedLiveKitHTTP
from test_task_voice import API, metadata, audio, transcript


def binding():
    return {'mediaSessionId': 'media_fixture', 'taskId': 'task_fixture', 'voiceSessionId': 'voice_fixture',
            'callAttemptId': 'call_fixture', 'roomName': 'clawdtime-task-media_fixture',
            'workerIdentity': 'worker_fixture', 'agentIdentity': 'agent_fixture',
            'expiresAt': int((time.time() + 60) * 1000), 'audio': True,
            'video': False, 'screen': False, 'presentation': False, 'control': False}


class FakeRoom:
    def __init__(self):
        self.handlers = {}
        self.remote_participants = {}
        self.connect = AsyncMock()
        self.disconnect = AsyncMock()
        self.local_participant = SimpleNamespace(publish_track=AsyncMock())

    def on(self, name):
        def install(handler):
            self.handlers[name] = handler
            return handler
        return install


class FakeSource:
    def __init__(self, rate, channels, queue_size_ms):
        self.rate, self.channels, self.queue_ms = rate, channels, queue_size_ms
        self.frames = []
        self.queued = []
        self.clear_count = 0
        self.closed = False
        self.gate = None
        self.entered = asyncio.Event()

    async def capture_frame(self, frame):
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        self.frames.append(bytes(frame.data))
        self.queued.append(bytes(frame.data))

    def clear_queue(self):
        self.clear_count += 1
        self.queued.clear()

    async def aclose(self):
        self.closed = True


class FakeResampler:
    def __init__(self, input_rate, output_rate, num_channels):
        assert (input_rate, output_rate, num_channels) == (16000, 48000, 1)

    def push(self, pcm):
        raw = b''.join(pcm[offset:offset + 2] * 3 for offset in range(0, len(pcm), 2))
        return [rtc.AudioFrame(raw, 48000, 1, len(raw) // 2)]


class FakeStream:
    instances = []

    def __init__(self, track, **options):
        self.track, self.options = track, options
        self.queue = asyncio.Queue()
        self.closed = False
        self.instances.append(self)

    def __aiter__(self):
        return self

    async def __anext__(self):
        frame = await self.queue.get()
        if frame is None:
            raise StopAsyncIteration
        return SimpleNamespace(frame=frame)

    async def aclose(self):
        self.closed = True
        self.queue.put_nowait(None)


async def until(predicate, timeout=2):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.005)


class LiveKitAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = TaskAudioJournal(Path(self.temp.name) / 'attempts.sqlite')
        self.api = API()
        self.api.value['permissions']['instructions'] = False
        self.api.value.update(mode='handset_audio_smoke', callAttemptId='call_fixture')
        self.sdk_api = SimpleNamespace(room=SimpleNamespace(create_room=AsyncMock(), delete_room=AsyncMock()), aclose=AsyncMock())
        self.patches = [patch('livekit.api.LiveKitAPI', return_value=self.sdk_api),
                        patch('livekit.rtc.Room', FakeRoom), patch('livekit.rtc.AudioSource', FakeSource),
                        patch('livekit.rtc.LocalAudioTrack.create_audio_track', return_value=SimpleNamespace(kind='audio')),
                        patch('livekit.rtc.AudioStream', FakeStream), patch('livekit.rtc.AudioResampler', FakeResampler)]
        self.sdk_constructor = self.patches[0].start()
        for item in self.patches[1:]:
            item.start()
        FakeStream.instances = []
        self.received = []
        self.opens = 0
        self.readiness_reads = 0
        self.provider_socket = None
        app = web.Application()
        async def endpoint(request):
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            self.provider_socket = socket
            async for message in socket:
                value = json.loads(message.data)
                self.received.append(value)
                if value.get('type') == 'conversation_initiation_client_data':
                    await socket.send_json(metadata())
                    await socket.send_json(audio(pcm=b'\x02\x00' * 1600))
            return socket
        app.router.add_get('/voice', endpoint)
        self.server = TestServer(app)
        await self.server.start_server()
        self.http = ClientSession()
        owner = self
        class Provider:
            async def readiness(self):
                owner.readiness_reads += 1
                return 1200
            async def open(self):
                owner.opens += 1
                return await owner.http.ws_connect(owner.server.make_url('/voice'))
            async def close(self):
                pass
        self.provider = Provider()
        self.port = LiveKitAudioPort('wss://fixture.invalid', 'fixture', 'synthetic-secret-not-a-live-key-12345678', allowed_hosts={'fixture.invalid'})
        self.adapter = TaskVoiceLiveKit(self.api, self.provider, self.port, self.journal, worker_timeout=.1)
        self.bound = binding()

    async def asyncTearDown(self):
        await self.adapter.close()
        await self.http.close()
        await self.server.close()
        for item in reversed(self.patches):
            item.stop()
        self.journal.close()
        self.temp.cleanup()

    def track(self, kind=rtc.TrackKind.KIND_AUDIO, identity='worker_fixture', sid='audio_one'):
        publication = SimpleNamespace(kind=kind, sid=sid, set_subscribed=Mock())
        participant = SimpleNamespace(identity=identity)
        self.port.room.handlers['track_published'](publication, participant)
        self.port.room.handlers['track_subscribed'](SimpleNamespace(kind=kind), publication, participant)
        return publication

    async def activate(self):
        return await self.adapter.activate({'callAttemptId': 'call_fixture', 'providerCallId': 'native_fixture', 'connected': True})

    async def test_silent_prepare_exact_credentials_and_no_input_before_activation(self):
        result = await self.adapter.prepare(self.bound)
        self.assertFalse(self.sdk_constructor.call_args.kwargs['failover'])
        configured_http = self.sdk_constructor.call_args.kwargs['session']
        self.assertIsInstance(configured_http, FixedLiveKitHTTP)
        tls = configured_http.session.connector._ssl
        self.assertTrue(tls.check_hostname)
        self.assertEqual(tls.verify_mode, __import__('ssl').CERT_REQUIRED)
        self.assertTrue(result['silentPublisherReady'])
        self.assertFalse(result['videoPublisherReady'])
        self.assertEqual(result['credentials']['remote_participant_identity'], 'agent_fixture')
        claims = json.loads(base64.urlsafe_b64decode(result['credentials']['participant_token'].split('.')[1] + '=='))
        self.assertEqual(claims['sub'], 'worker_fixture')
        self.assertEqual(claims['video']['room'], self.bound['roomName'])
        self.assertEqual(claims['video']['canPublishSources'], ['microphone'])
        self.assertFalse(claims['video']['canPublishData'])
        connect = self.port.room.connect.call_args
        agent_claims = json.loads(base64.urlsafe_b64decode(connect.args[1].split('.')[1] + '=='))
        self.assertEqual(agent_claims['sub'], 'agent_fixture')
        self.assertFalse(connect.kwargs['options'].auto_subscribe)
        self.track()
        await asyncio.sleep(.03)
        self.assertEqual(self.opens, 0)
        self.assertEqual(self.readiness_reads, 1)
        self.assertEqual(FakeStream.instances, [])
        self.assertTrue(all(not any(frame) for frame in self.port.source.frames))
        repeated = await self.adapter.prepare(self.bound)
        self.assertEqual(repeated, result)
        self.sdk_api.room.create_room.assert_awaited_once()
        self.assertNotIn('voiceToken', json.dumps(result))

    async def test_prepared_silence_is_continuous_and_transition_joins_it(self):
        await self.adapter.prepare(self.bound)
        await until(lambda: len(self.port.source.frames) >= 12)
        self.assertTrue(all(frame == bytes(1920) for frame in self.port.source.frames))
        self.assertEqual(self.opens, 0)
        self.assertEqual(FakeStream.instances, [])
        await self.port.activate_output()
        self.assertTrue(self.port.silence_task.done())
        counts = self.adapter.status()['audioOutput']
        prepared_count = counts['preparedSilentFrames']
        self.assertGreaterEqual(prepared_count, 11)
        self.assertLessEqual(prepared_count, len(self.port.source.frames))
        self.assertEqual(counts['speechFrames'], 0)
        self.assertEqual(counts['evidence'], 'sdk_acceptance_not_audibility')
        self.assertEqual(self.port.source.queued, [])
        count = len(self.port.source.frames)
        await asyncio.sleep(.06)
        self.assertEqual(len(self.port.source.frames), count)
        await self.port.play(b'\x07\x00' * 1600, 0)
        self.assertTrue(all(any(frame) for frame in self.port.source.frames[count:]))
        counts = self.adapter.status()['audioOutput']
        self.assertEqual(counts['preparedSilentFrames'], prepared_count)
        self.assertEqual(counts['speechFrames'], len(self.port.source.frames) - count)
        self.assertEqual(set(counts), {'evidence', 'preparedSilentFrames', 'speechFrames'})
        self.port.output_counts['speechFrames'] = 1000000
        self.port._count_output('speechFrames')
        self.assertEqual(self.port.output_counts['speechFrames'], 1000000)

    async def test_prepared_expiry_joins_silent_producer_and_ends_voice_once(self):
        now = time.time()
        self.adapter.clock = lambda: now
        await self.adapter.prepare(self.bound)
        await until(lambda: len(self.port.source.frames) >= 3)
        now = self.bound['expiresAt'] / 1000 + 1
        await until(lambda: self.adapter.state == 'closed')
        self.assertTrue(self.port.silence_task.done())
        count = len(self.port.source.frames)
        await asyncio.sleep(.06)
        self.assertEqual(len(self.port.source.frames), count)
        self.assertEqual(self.opens, 0)
        self.assertEqual(len([1 for path, body in self.api.calls if path == '/end']), 1)
        self.assertFalse(self.adapter.status()['nativeCallClosed'])

    async def test_real_runtime_pcm_status_end_and_local_instruction_refusal(self):
        await self.adapter.prepare(self.bound)
        self.track()
        active = await self.activate()
        self.assertEqual(active['state'], 'active')
        self.assertEqual(self.opens, 1)
        stream = FakeStream.instances[0]
        self.assertEqual(stream.options, {'capacity': 5, 'sample_rate': 16000, 'num_channels': 1, 'frame_size_ms': 20})
        await stream.queue.put(rtc.AudioFrame(b'\x03\x00' * 320, 16000, 1, 320))
        await until(lambda: any('user_audio_chunk' in message for message in self.received))
        # Human input remains active while provider output is queued.
        await until(lambda: any(any(frame) for frame in self.port.source.frames))
        await self.provider_socket.send_json(transcript('Add another task'))
        await self.provider_socket.send_json({'type': 'client_tool_call', 'client_tool_call': {
            'tool_call_id': 'instruction_one', 'tool_name': 'submit_instruction', 'parameters': {}}})
        await self.provider_socket.send_json({'type': 'client_tool_call', 'client_tool_call': {
            'tool_call_id': 'status_one', 'tool_name': 'task_status', 'parameters': {}}})
        await until(lambda: len([message for message in self.received if message.get('type') == 'client_tool_result']) == 2)
        results = {message['tool_call_id']: message for message in self.received if message.get('type') == 'client_tool_result'}
        self.assertTrue(results['instruction_one']['is_error'])
        self.assertFalse(results['status_one']['is_error'])
        self.assertFalse(any(path == '/instructions' for path, body in self.api.calls))
        await self.provider_socket.send_json(transcript('End the call', 2))
        await self.provider_socket.send_json({'type': 'client_tool_call', 'client_tool_call': {
            'tool_call_id': 'end_one', 'tool_name': 'end_call', 'parameters': {}}})
        await until(lambda: self.adapter.state == 'closed')
        self.assertFalse(self.adapter.status()['nativeCallClosed'])
        self.assertTrue(stream.closed)
        self.sdk_api.room.delete_room.assert_awaited_once()
        self.assertTrue(self.port.sdk_http.closed)

    async def test_activation_waits_for_worker_and_duplicate_activation_never_reopens_provider(self):
        await self.adapter.prepare(self.bound)
        started = asyncio.create_task(self.activate())
        await asyncio.sleep(.02)
        self.assertEqual(self.opens, 0)
        self.track()
        await started
        await self.activate()
        self.assertEqual(self.opens, 1)
        with self.assertRaises(VoiceError):
            await self.adapter.activate({'callAttemptId': 'call_fixture', 'providerCallId': 'other', 'connected': True})

    async def test_no_worker_audio_times_out_without_provider_and_cleans_room(self):
        await self.adapter.prepare(self.bound)
        with self.assertRaises(asyncio.TimeoutError):
            await self.activate()
        await self.adapter.close()
        self.assertEqual(self.opens, 0)
        self.assertEqual(self.adapter.state, 'closed')
        self.assertFalse(self.adapter.status()['nativeCallClosed'])

    async def test_expected_video_never_subscribes_or_creates_capture(self):
        await self.adapter.prepare(self.bound)
        video = self.track(rtc.TrackKind.KIND_VIDEO, sid='video_one')
        self.assertTrue(all(call.args == (False,) for call in video.set_subscribed.call_args_list))
        self.assertFalse(self.adapter.audio_ready.is_set())
        self.assertEqual(FakeStream.instances, [])
        self.assertEqual(self.adapter.state, 'prepared')

    async def test_foreign_participant_fails_closed_before_provider(self):
        await self.adapter.prepare(self.bound)
        self.track(identity='foreign')
        await self.adapter.close()
        self.assertEqual(self.adapter.status()['reason'], 'foreign_participant')
        self.assertEqual(self.opens, 0)

    async def test_second_audio_track_and_room_reconnect_are_refused(self):
        await self.adapter.prepare(self.bound)
        self.track()
        self.track(sid='second_audio')
        await self.adapter.close()
        self.assertEqual(self.adapter.status()['reason'], 'conflicting_audio')
        self.assertEqual(self.opens, 0)

    async def test_reconnecting_active_room_closes_without_provider_retry(self):
        await self.adapter.prepare(self.bound)
        self.track()
        await self.activate()
        self.port.room.handlers['reconnecting']()
        await self.adapter.close()
        self.assertEqual(self.opens, 1)
        self.assertEqual(self.adapter.status()['reason'], 'room_reconnect_refused')
        self.assertFalse(self.adapter.status()['nativeCallClosed'])

    async def test_stale_opening_at_activation_never_opens_provider(self):
        await self.adapter.prepare(self.bound)
        self.track()
        self.api.value['revision'] += 1
        with self.assertRaises(VoiceError):
            await self.activate()
        await self.adapter.close()
        self.assertEqual(self.opens, 0)

    async def test_outer_activation_deadline_includes_worker_wait_and_joins_cleanup(self):
        self.adapter.activation_timeout = .02
        await self.adapter.prepare(self.bound)
        with self.assertRaises(TimeoutError):
            await self.activate()
        await self.adapter.close()
        self.assertEqual(self.opens, 0)
        self.assertEqual(self.adapter.state, 'closed')
        self.assertTrue(self.adapter.activation_task.done())
        self.sdk_api.room.delete_room.assert_awaited_once()
        self.assertFalse(self.adapter.status()['nativeCallClosed'])

    async def test_outer_activation_deadline_waits_for_first_output_and_joins_runtime(self):
        from task_voice import VoiceDiagnostics
        fake = SimpleNamespace(start=AsyncMock(), close=AsyncMock(), input_audio=AsyncMock(),
            ended=asyncio.Event(), failed=None, diagnostics=VoiceDiagnostics(),
            playback=SimpleNamespace(first_output=asyncio.Event()))
        self.adapter.activation_timeout = .03
        self.adapter.runtime_factory = lambda *args: fake
        await self.adapter.prepare(self.bound)
        self.track()
        with self.assertRaises(TimeoutError):
            await self.activate()
        await self.adapter.close()
        fake.close.assert_awaited_once()
        self.assertTrue(self.adapter.activation_task.done())
        self.assertEqual(self.adapter.state, 'closed')
        self.assertTrue(all(stream.closed for stream in FakeStream.instances))

    async def test_instructions_enabled_voice_refused_before_room_effect(self):
        self.api.value['permissions']['instructions'] = True
        with self.assertRaises(VoiceError):
            await self.adapter.prepare(self.bound)
        await self.adapter.close()
        self.sdk_api.room.create_room.assert_not_awaited()

    async def test_provider_readiness_refusal_prevents_room_creation(self):
        self.provider.readiness = AsyncMock(side_effect=VoiceError('synthetic'))
        with self.assertRaises(VoiceError):
            await self.adapter.prepare(self.bound)
        await self.adapter.close()
        self.sdk_api.room.create_room.assert_not_awaited()
        self.assertEqual(self.opens, 0)

    async def test_live_policy_revocation_closes_runtime_and_capture(self):
        await self.adapter.prepare(self.bound)
        self.track()
        await self.activate()
        self.api.value['active'] = False
        await until(lambda: self.adapter.state == 'closed')
        self.assertTrue(FakeStream.instances[0].closed)
        self.assertFalse(self.adapter.status()['nativeCallClosed'])

    async def test_provider_interruption_clears_source_and_old_epoch(self):
        await self.adapter.prepare(self.bound)
        self.track()
        await self.activate()
        await until(lambda: any(any(frame) for frame in self.port.source.frames))
        before = self.port.source.clear_count
        await self.provider_socket.send_json({'type': 'interruption', 'interruption_event': {'event_id': 2}})
        await until(lambda: self.port.source.clear_count > before)
        self.assertIsNone(self.port.resampler)
        self.assertEqual(self.port.source.queued, [])
        previous = len(self.port.source.frames)
        await self.port.play(b'\x05\x00' * 100, 0)
        self.assertEqual(len(self.port.source.frames), previous)

    async def test_clear_waits_for_inflight_capture_then_discards_old_tail(self):
        await self.adapter.prepare(self.bound)
        await self.port.activate_output()
        self.port.source.gate = asyncio.Event()
        self.port.source.entered.clear()
        play = asyncio.create_task(self.port.play(b'\x04\x00' * 1600, 0))
        await self.port.source.entered.wait()
        clear = asyncio.create_task(self.port.clear(1))
        await asyncio.sleep(0)
        self.port.source.gate.set()
        await asyncio.gather(play, clear)
        self.assertEqual(self.port.source.queued, [])
        self.assertIsNone(self.port.resampler)

    async def test_unknown_room_delete_retains_tombstone_and_never_claims_closed(self):
        await self.adapter.prepare(self.bound)
        self.sdk_api.room.delete_room.side_effect = TimeoutError('synthetic')
        result = await self.adapter.close()
        self.assertEqual(result['state'], 'unknown')
        self.assertFalse(result['closed'])
        self.assertFalse(result['nativeCallClosed'])
        self.assertEqual(self.journal.db.execute('SELECT state FROM attempts').fetchone()[0], 'unknown')
        await self.adapter.close()
        self.sdk_api.room.delete_room.assert_awaited_once()

    async def test_canceled_close_waiter_does_not_abandon_owned_cleanup(self):
        await self.adapter.prepare(self.bound)
        gate = asyncio.Event()
        self.sdk_api.room.delete_room.side_effect = lambda request: None
        async def delayed(request):
            await gate.wait()
        self.sdk_api.room.delete_room.side_effect = delayed
        first = asyncio.create_task(self.adapter.close())
        await asyncio.sleep(.01)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(self.adapter.close())
        await asyncio.sleep(.01)
        self.assertFalse(second.done())
        gate.set()
        self.assertTrue((await second)['closed'])
        self.sdk_api.room.delete_room.assert_awaited_once()

    async def test_restart_tombstone_refuses_resurrection_without_room_effect(self):
        await self.adapter.prepare(self.bound)
        await self.adapter.close()
        self.journal.close()
        self.journal = TaskAudioJournal(Path(self.temp.name) / 'attempts.sqlite')
        another = TaskVoiceLiveKit(self.api, self.provider, self.port, self.journal)
        with self.assertRaises(VoiceError):
            await another.prepare(self.bound)
        self.sdk_api.room.create_room.assert_awaited_once()

    async def test_close_joins_delayed_room_creation_before_scoped_delete(self):
        gate = asyncio.Event()
        entered = asyncio.Event()
        async def delayed(request):
            entered.set()
            await gate.wait()
        self.sdk_api.room.create_room.side_effect = delayed
        prepared = asyncio.create_task(self.adapter.prepare(self.bound))
        await entered.wait()
        closed = asyncio.create_task(self.adapter.close())
        await asyncio.sleep(.01)
        self.assertFalse(closed.done())
        self.sdk_api.room.delete_room.assert_not_awaited()
        gate.set()
        with self.assertRaises(VoiceError):
            await prepared
        self.assertTrue((await closed)['closed'])
        self.sdk_api.room.delete_room.assert_awaited_once()
        self.assertEqual(self.opens, 0)
        self.assertEqual(len([1 for path, body in self.api.calls if path == '/end']), 1)

    async def test_uncertain_create_never_becomes_closed_even_after_delete_ack(self):
        self.sdk_api.room.create_room.side_effect = TimeoutError('synthetic unknown')
        with self.assertRaises(TimeoutError):
            await self.adapter.prepare(self.bound)
        result = await self.adapter.close()
        self.assertEqual(result['state'], 'unknown')
        self.assertFalse(result['closed'])
        self.sdk_api.room.delete_room.assert_awaited_once()

    async def test_wrong_authoritative_call_attempt_refused_before_room_effect(self):
        self.api.value['callAttemptId'] = 'other'
        with self.assertRaises(VoiceError):
            await self.adapter.prepare(self.bound)
        await self.adapter.close()
        self.sdk_api.room.create_room.assert_not_awaited()

    async def test_close_cancels_delayed_provider_start_without_late_audio_or_input(self):
        await self.adapter.prepare(self.bound)
        self.track()
        entered = asyncio.Event()
        canceled = asyncio.Event()
        async def delayed():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                canceled.set()
        self.provider.open = delayed
        active = asyncio.create_task(self.activate())
        await entered.wait()
        result = await self.adapter.close()
        with self.assertRaises(asyncio.CancelledError):
            await active
        self.assertTrue(canceled.is_set())
        self.assertTrue(result['closed'])
        self.assertEqual(FakeStream.instances, [])
        self.assertFalse(any(any(frame) for frame in self.port.source.frames))

    async def test_loopback_controller_starts_without_effect_and_refuses_browser_or_wrong_binding(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        app = control_app(self.adapter, self.bound, 't' * 40, port)
        client = TestClient(TestServer(app, port=port))
        await client.start_server()
        headers = {'Authorization': 'Bearer ' + 't' * 40}
        try:
            response = await client.get('/status', headers=headers)
            status = await response.json()
            self.assertEqual(status['state'], 'absent')
            self.assertEqual(status['callAttemptId'], 'call_fixture')
            self.assertEqual(status['bindingFingerprint'], fingerprint(self.bound))
            self.sdk_api.room.create_room.assert_not_awaited()
            self.assertEqual(self.opens, 0)
            response = await client.post('/prepare', json=self.bound)
            self.assertEqual(response.status, 401)
            response = await client.post('/prepare', json=self.bound, headers={**headers, 'Origin': f'http://127.0.0.1:{port}'})
            self.assertEqual(response.status, 403)
            response = await client.post('/prepare', json=dict(self.bound, workerIdentity='other'), headers=headers)
            self.assertEqual(response.status, 409)
            response = await client.post('/prepare', json=self.bound, headers={**headers, 'Host': 'localhost:' + str(port)})
            self.assertEqual(response.status, 403)
            self.sdk_api.room.create_room.assert_not_awaited()
            response = await client.post('/prepare', json=self.bound, headers=headers)
            prepared = await response.json()
            self.assertEqual(prepared['state'], 'prepared')
            self.assertTrue(prepared['silentPublisherReady'])
            self.assertFalse(prepared['videoPublisherReady'])
            self.assertEqual(prepared['roomName'], self.bound['roomName'])
            self.assertEqual(self.opens, 0)
            response = await client.post('/close', json={'callAttemptId': 'other'}, headers=headers)
            self.assertEqual(response.status, 409)
            self.sdk_api.room.delete_room.assert_not_awaited()
            response = await client.post('/close', json={'callAttemptId': 'call_fixture'}, headers=headers)
            ended = await response.json()
            self.assertTrue(ended['closed'])
            self.assertFalse(ended['nativeCallClosed'])
        finally:
            await client.close()

    async def test_configured_controller_reads_private_files_but_never_prepares_on_startup(self):
        values = {
            'binding': self.bound,
            'voice': {'version': 1, 'taskOrigin': 'http://127.0.0.1:1234', 'taskId': 'task_fixture', 'voiceSessionId': 'voice_fixture', 'voiceToken': 'v' * 40},
            'provider': {'elevenlabsAgentId': 'agent_fixture', 'elevenlabsApiKey': 'synthetic'},
            'livekit': {'url': 'wss://fixture.invalid', 'key': 'fixture', 'secret': 'synthetic' * 8, 'allowedHosts': ['fixture.invalid']},
            'control': {'token': 't' * 40}}
        args = SimpleNamespace(journal=str(Path(self.temp.name) / 'controller.sqlite'), port=3322)
        for name, value in values.items():
            path = Path(self.temp.name) / (name + '.json')
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            setattr(args, name + '_file', str(path))
        app = await configured_app(args)
        runner = web.AppRunner(app)
        await runner.setup()
        try:
            self.sdk_api.room.create_room.assert_not_awaited()
            self.assertEqual(self.opens, 0)
        finally:
            await runner.cleanup()
        self.sdk_api.room.delete_room.assert_not_awaited()

    async def test_deepgram_controller_selects_only_explicit_fallback_with_no_startup_effect(self):
        from task_voice_deepgram import DeepgramProvider, DeepgramTaskVoiceRuntime
        values = {
            'binding': self.bound,
            'voice': {'version': 1, 'taskOrigin': 'http://127.0.0.1:1234', 'taskId': 'task_fixture', 'voiceSessionId': 'voice_fixture', 'voiceToken': 'v' * 40},
            'provider': {'provider': 'deepgram', 'deepgramApiKey': 'synthetic_test_key_only'},
            'livekit': {'url': 'wss://fixture.invalid', 'key': 'fixture', 'secret': 'synthetic' * 8, 'allowedHosts': ['fixture.invalid']},
            'control': {'token': 't' * 40}}
        args = SimpleNamespace(journal=str(Path(self.temp.name) / 'deepgram-controller.sqlite'), port=3322)
        for name, value in values.items():
            path = Path(self.temp.name) / ('deepgram-' + name + '.json')
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            setattr(args, name + '_file', str(path))
        with patch('task_voice_livekit_local.TaskVoiceLiveKit', wraps=TaskVoiceLiveKit) as constructor:
            app = await configured_app(args)
            self.assertIsInstance(constructor.call_args.args[1], DeepgramProvider)
            self.assertIs(constructor.call_args.kwargs['runtime_factory'], DeepgramTaskVoiceRuntime)
            self.assertEqual(constructor.call_args.kwargs['activation_timeout'], 8)
            runner = web.AppRunner(app)
            await runner.setup()
            await runner.cleanup()
        self.sdk_api.room.create_room.assert_not_awaited()
        self.sdk_api.room.delete_room.assert_not_awaited()
        self.assertEqual(self.opens, 0)

    async def test_binding_mutation_wrong_task_and_unconfirmed_activation_have_no_effect(self):
        for field in ('audio', 'video', 'screen', 'presentation', 'control'):
            value = dict(self.bound)
            value[field] = not value[field]
            with self.assertRaises(VoiceError):
                await self.adapter.prepare(value)
        value = dict(self.bound, taskId='other')
        with self.assertRaises(VoiceError):
            await self.adapter.prepare(value)
        self.sdk_api.room.create_room.assert_not_awaited()
        await self.adapter.prepare(self.bound)
        for value in ({'callAttemptId': 'wrong', 'providerCallId': 'native', 'connected': True},
                      {'callAttemptId': 'call_fixture', 'providerCallId': 'native', 'connected': False}):
            with self.assertRaises(VoiceError):
                await self.adapter.activate(value)
        self.assertEqual(self.opens, 0)


class RealSDKSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_sdk_room_rpc_never_follows_redirect_or_retries_503(self):
        from livekit import api
        counts = {'create': 0, 'redirected': 0}
        response_code = 307
        app = web.Application()
        async def create(request):
            counts['create'] += 1
            if response_code == 307:
                return web.Response(status=307, headers={'Location': '/redirected'})
            return web.json_response({'code': 'unavailable', 'msg': 'synthetic'}, status=503)
        async def redirected(request):
            counts['redirected'] += 1
            return web.Response(status=200)
        app.router.add_post('/twirp/livekit.RoomService/CreateRoom', create)
        app.router.add_route('*', '/redirected', redirected)
        server = TestServer(app)
        await server.start_server()
        async with ClientSession() as http:
            port = FixedLiveKitHTTP(http, str(server.make_url('')).rstrip('/'))
            client = api.LiveKitAPI(str(server.make_url('')), 'fixture', 'synthetic' * 8, session=port, failover=False)
            try:
                for code in (307, 503):
                    response_code = code
                    with self.assertRaises(api.TwirpError):
                        await client.room.create_room(api.CreateRoomRequest(name='synthetic-room'))
                self.assertEqual(counts, {'create': 2, 'redirected': 0})
                with self.assertRaises(VoiceError):
                    port.post('https://foreign.invalid/twirp/livekit.RoomService/CreateRoom')
            finally:
                await client.aclose()
        await server.close()

    async def test_pinned_sdk_resamples_and_queues_audio_without_room_or_hardware(self):
        # An unconnected in-memory SDK source: no room, mic, speaker, key or network.
        resampler = rtc.AudioResampler(16000, 48000, num_channels=1)
        frames = resampler.push(bytearray(b'\x04\x00' * 1600)) + resampler.flush()
        self.assertTrue(frames)
        self.assertEqual(sum(frame.samples_per_channel for frame in frames), 4800)
        self.assertTrue(all(frame.sample_rate == 48000 and frame.num_channels == 1 for frame in frames))
        source = rtc.AudioSource(48000, 1, queue_size_ms=100)
        try:
            self.assertEqual((source.sample_rate, source.num_channels), (48000, 1))
            await asyncio.wait_for(source.capture_frame(rtc.AudioFrame(bytes(1920), 48000, 1, 960)), 1)
            source.clear_queue()
            await asyncio.wait_for(source.wait_for_playout(), 1)
        finally:
            await source.aclose()


class ConfigurationTests(unittest.TestCase):
    def test_fixed_livekit_destination_and_binding_shape(self):
        for url in ('http://fixture.invalid', 'wss://foreign.invalid', 'wss://fixture.invalid?key=x',
                    'wss://user:password@fixture.invalid', 'wss://fixture.invalid/other'):
            with self.assertRaises(VoiceError):
                LiveKitAudioPort(url, 'fixture', 'fixture', allowed_hosts={'fixture.invalid'})
        for value in (dict(binding(), roomName='another-room'), dict(binding(), expiresAt=0),
                      dict(binding(), agentIdentity='worker_fixture'), dict(binding(), unexpected=True)):
            with self.assertRaises(VoiceError):
                validate_binding(value, time.time())

    def test_journal_exclusive_lock_and_interrupted_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'attempts.sqlite'
            journal = TaskAudioJournal(path)
            with self.assertRaises(BlockingIOError):
                TaskAudioJournal(path)
            value = binding()
            journal.reserve(value, 'fixture_digest')
            journal.close()
            second = TaskAudioJournal(path)
            try:
                self.assertEqual(second.db.execute('SELECT state FROM attempts').fetchone()[0], 'interrupted')
                with self.assertRaises(VoiceError):
                    second.reserve(value, 'fixture_digest')
                self.assertNotIn('token', ' '.join(row[1] for row in second.db.execute('PRAGMA table_info(attempts)')))
            finally:
                second.close()


if __name__ == '__main__':
    unittest.main()
