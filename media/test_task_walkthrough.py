"""Offline exact-window renderer, export, dialogue and controller regressions."""
import asyncio
import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
from livekit import rtc

from task_voice import VoiceError
from task_voice_livekit import TaskAudioJournal, validate_binding
from task_presentation import PresentationJournal, TaskPresentationRuntime
from task_walkthrough_livekit import (validate_walkthrough_binding, WalkthroughTaskAPI,
                                      TaskWalkthroughLiveKit, LiveKitWalkthroughPort)
from task_walkthrough_livekit_local import control_app, validate_export, configured_app
from task_walkthrough_voice import DeepgramWalkthroughRuntime, walkthrough_settings
from test_task_presentation import fixture, Source
from test_task_voice import Sink
from test_task_voice_deepgram import Socket


def binding(prepared=None):
    p = prepared or fixture()
    now = int(time.time() * 1000)
    return {'mediaSessionId': 'media_fixture', 'taskId': 'task_fixture', 'voiceSessionId': 'voice_fixture',
        'callAttemptId': 'call_fixture', 'roomName': 'clawdtime-task-media_fixture', 'workerIdentity': 'worker_fixture',
        'agentIdentity': 'agent_fixture', 'mode': 'handset_walkthrough', 'dispatchExpiresAt': now + 60000,
        'expiresAt': now + 120000, 'exportGrantId': 'export_fixture', 'planFingerprint': 'd' * 64,
        'presentationBinding': {'presentationId': p['presentationId'], 'manifestFingerprint': p['fingerprint'],
            'presentationGrantId': p['grant']['id'], 'verificationId': p['manifest']['verificationId'],
            'hostId': p['grant']['hostId'], 'captureDeviceId': 'device_fixture'},
        'audio': True, 'video': True, 'screen': True, 'presentation': True, 'instructions': True,
        'control': False, 'nativeActivation': False}


class API:
    task_id, voice_id = 'task_fixture', 'voice_fixture'
    def __init__(self, b, prepared):
        m = prepared['manifest']
        self.value = {'taskId': self.task_id, 'voiceSessionId': self.voice_id, 'mode': b['mode'],
            'callAttemptId': b['callAttemptId'], 'exportGrantId': b['exportGrantId'], 'planFingerprint': b['planFingerprint'],
            'presentationId': prepared['presentationId'], 'manifestFingerprint': prepared['fingerprint'],
            'active': True, 'sharingActive': False, 'exportActive': True,
            'runId': m['runId'], 'openingRunId': m['runId'], 'revision': m['taskRevision'],
            'openingRevision': m['taskRevision'], 'sequence': m['taskRevision'], 'opening': m['opening'],
            'state': 'review_ready', 'goal': 'Synthetic task', 'permissions': {'screen': True, 'presentation': True,
                'instructions': True, 'control': False}, 'scenes': [{'id': s['id'], 'title': s['title']} for s in m['scenes']]}
        self.calls = []
        self.owner = None
        self.instruction_gate = None
        self.failure = None
    async def request(self, suffix, body=None):
        self.calls.append((suffix, copy.deepcopy(body)))
        if suffix == self.failure:
            raise VoiceError('synthetic_refusal')
        if suffix == '/context':
            return copy.deepcopy(self.value)
        if suffix in ('/presentation/opening', '/presentation/show'):
            generation = self.owner.presentation.generation + 1
            self.owner.remote_generation = generation
            await self.owner.show_scene({'callAttemptId': 'call_fixture', 'presentationId': self.value['presentationId'],
                'manifestFingerprint': self.value['manifestFingerprint'], 'sceneId': 'scene_code',
                'operationId': 'show_' + str(generation), 'generation': generation})
            self.value['sharingActive'] = True
            return {'sceneId': 'scene_code', 'generation': generation, 'evidence': 'sdk_frame_accepted_not_remote_seen',
                    'title': 'Synthetic scene', 'narration': 'Synthetic result', 'expectedOutcome': 'Synthetic expectation'}
        if suffix == '/utterances':
            return {'utteranceId': body['utteranceId']}
        if suffix == '/instructions':
            if self.instruction_gate:
                await self.instruction_gate.wait()
            return {'state': 'held', 'taskId': self.task_id, 'replayed': False}
        if suffix == '/accept':
            return {'accepted': True, 'taskId': self.task_id, 'runId': self.value['runId'], 'deployed': False, 'replayed': False}
        if suffix == '/presentation/stop':
            self.value['exportActive'] = self.value['sharingActive'] = False
            if self.owner:
                await self.owner.stop_sharing()
            return {'sharingStopped': True, 'voiceEnded': False, 'taskCanceled': False}
        return {'received': True}


class Port(Sink):
    def __init__(self):
        super().__init__()
        self.video_source = None
        self.frames = []
        self.prepared = 0
        self.stopped = False
        self.closed = False
        self.prepare_gate = None
        self.prepare_entered = asyncio.Event()
    async def prepare(self, b, on_audio, on_failure):
        self.prepared += 1
        self.prepare_entered.set()
        if self.prepare_gate:
            await self.prepare_gate.wait()
        self.video_source = object()
        on_audio()
        return {'livekit_url': 'wss://example.invalid', 'participant_token': 'synthetic', 'remote_participant_identity': b['agentIdentity']}
    async def publish_video(self, jpeg, frame):
        if self.stopped:
            raise VoiceError('stopped')
        with Image.open(io.BytesIO(jpeg)) as image:
            assert image.size == (1280, 720)
        self.frames.append(copy.deepcopy(frame))
        return {**frame, 'acceptedAt': time.time() * 1000, 'evidence': 'sdk_frame_accepted_not_remote_seen'}
    async def stop_video(self):
        self.stopped = True
        return True
    async def close(self):
        self.closed = True
        return True
    async def activate_output(self):
        pass
    async def start_input(self, callback):
        self.input = callback


class ExportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.p = fixture()
        self.b = binding(self.p)
        self.api = API(self.b, self.p)
        self.port = Port()
        self.provider = SimpleNamespace(readiness=AsyncMock(), open=AsyncMock(), close=AsyncMock())
        self.source = Source()
        self.journal = TaskAudioJournal(Path(self.temp.name) / 'call.sqlite')
        self.pjournal = PresentationJournal(Path(self.temp.name) / 'presentation.sqlite')
        authority = SimpleNamespace(check=AsyncMock(side_effect=lambda generation=None: {'generation': generation or self.owner.remote_generation}))
        self.renderer = TaskPresentationRuntime(self.p, authority, self.source, self.pjournal)
        self.owner = TaskWalkthroughLiveKit(self.api, self.provider, self.port, self.journal, self.b, self.renderer)
        self.owner.remote_generation = 0
        self.api.owner = self.owner
    async def asyncTearDown(self):
        await self.owner.close()
        self.journal.close()
        self.pjournal.close()
        self.temp.cleanup()
    async def test_prepare_inspects_exact_source_then_publishes_real_render_without_provider(self):
        result = await self.owner.prepare(self.b)
        self.assertEqual(self.source.calls[0], 'inspect')
        self.assertTrue(result['videoPublisherReady'])
        self.assertTrue(result['silentPublisherReady'])
        self.assertGreater(len(self.port.frames), 3)
        frame, evidence = await self.owner.fresh_video()
        self.assertEqual(frame['sourceFrameId'], evidence['sourceFrameId'])
        self.assertGreaterEqual(evidence['acceptedAt'], frame['renderedAt'])
        self.assertGreaterEqual(frame['capturedAt'], frame['transitionCompletedAt'])
        self.provider.open.assert_not_awaited()
    async def test_metadata_prepare_and_shutdown_have_no_external_effect(self):
        await self.owner.presentation_prepare({'callAttemptId': self.b['callAttemptId'], **self.p})
        self.assertFalse(self.source.started)
        self.assertEqual(self.port.prepared, 0)
        await self.owner.close()
        self.assertFalse(any(path == '/end' for path, body in self.api.calls))
        self.provider.readiness.assert_not_awaited()
        self.assertEqual(self.owner.status()['sharingDiagnostics']['firstStop']['reason'], 'call_closed')
    async def test_audio_smoke_validator_still_rejects_new_mode(self):
        with self.assertRaises(VoiceError):
            validate_binding(self.b, time.time())
        wrong = dict(self.b, control=True)
        with self.assertRaises(VoiceError):
            validate_walkthrough_binding(wrong, time.time())
    async def test_export_revocation_prevents_capture_and_room(self):
        self.api.value['exportActive'] = False
        with self.assertRaises(VoiceError):
            await self.owner.prepare(self.b)
        await self.owner.close()
        self.assertFalse(self.source.started)
        self.assertEqual(self.port.prepared, 0)
    async def test_stop_sharing_keeps_voice_task_alive_and_no_recursive_retire(self):
        await self.owner.prepare(self.b)
        runtime = SimpleNamespace(closed=False, suppress_scene_speech=AsyncMock(), close=AsyncMock(), diagnostics=SimpleNamespace(snapshot=lambda: {}))
        self.owner.runtime = runtime
        result = await self.owner.stop_sharing()
        self.assertTrue(all(result.values()))
        self.assertFalse(self.owner.stopping)
        self.assertTrue(self.source.closed)
        self.assertFalse(self.port.closed)
        runtime.close.assert_not_awaited()
        self.assertFalse(any(path in ('/end', '/presentation/retire') for path, body in self.api.calls))
        self.assertFalse(self.owner.status()['sharingActive'])
        with self.assertRaises(VoiceError):
            await self.owner.fresh_video()
    async def test_close_joins_late_room_prepare_without_resurrection(self):
        self.port.prepare_gate = asyncio.Event()
        pending = asyncio.create_task(self.owner.prepare(self.b))
        await self.port.prepare_entered.wait()
        closing = asyncio.create_task(self.owner.close())
        await asyncio.sleep(.01)
        self.assertFalse(closing.done())
        self.port.prepare_gate.set()
        await asyncio.gather(pending, return_exceptions=True)
        value = await closing
        self.assertTrue(value['closed'])
        self.assertTrue(self.port.closed)
        self.assertTrue(self.source.closed)
        self.assertIsNone(self.owner.video_task)
    async def test_source_failure_retires_once_without_voice_hangup(self):
        await self.owner.prepare(self.b)
        await self.renderer.stop()
        async with asyncio.timeout(2):
            while not self.owner.retirement_task:
                await asyncio.sleep(.01)
        await self.owner.retirement_task
        self.assertEqual(sum(path == '/presentation/retire' for path, body in self.api.calls), 1)
        self.assertFalse(self.owner.stopping)
        before = self.owner.status()['sharingDiagnostics']
        self.assertEqual(before['firstStop']['reason'], 'source_unavailable')
        self.assertEqual(before['firstStop']['mediaState'], 'prepared')
        await self.owner.close()
        self.assertEqual(self.owner.status()['sharingDiagnostics'], before)

    async def test_diagnostics_distinguish_task_change_and_authority_retirement(self):
        self.api.value['exportActive'] = False
        with self.assertRaises(VoiceError):
            await self.owner.authorize_export()
        self.assertEqual(self.owner.status()['sharingDiagnostics']['firstStop']['reason'], 'authority_retired')
        # A later task change must not overwrite the first observed cause.
        self.api.value['revision'] += 1
        with self.assertRaises(VoiceError):
            await self.owner.authorize_export()
        self.assertEqual(self.owner.status()['sharingDiagnostics']['firstStop']['reason'], 'authority_retired')

    async def test_diagnostics_bound_metadata_and_never_serialize_exception_text(self):
        self.renderer.diagnostics.fail(VoiceError('SECRET_PROVIDER_BODY_AND_TRANSCRIPT'), 'source_capture')
        self.renderer.counts.update(sourceFrames=1000001, renderedFrames=1000002)
        self.owner.last_export_capture = 0
        self.owner.sharing_diagnostics_started -= 1900
        await self.owner.stop_sharing()
        value = self.owner.status()['sharingDiagnostics']
        self.assertEqual(value['firstStop']['reason'], 'remote_stop')
        self.assertEqual(value['firstStop']['elapsedMs'], 1800000)
        self.assertEqual(value['firstStop']['lastFrameAgeMs'], 1800000)
        self.assertEqual((value['sourceFrames'], value['renderedFrames']), (1000000, 1000000))
        self.assertEqual(value['presentationFailure'], {'phase': 'source_capture', 'reason': 'other'})
        self.assertNotIn('SECRET', json.dumps(value))
        with self.assertRaises(VoiceError):
            self.owner._record_sharing_stop('arbitrary_secret_reason')
        await self.owner.close()
        self.assertEqual(self.owner.status()['sharingDiagnostics'], value)

    async def test_changed_task_is_diagnostic_only_and_does_not_enable_activation(self):
        await self.owner.prepare(self.b)
        self.api.value['revision'] += 1
        with self.assertRaises(VoiceError):
            await self.owner.fresh_video()
        self.assertEqual(self.owner.status()['sharingDiagnostics']['firstStop']['reason'], 'task_changed')
        self.provider.open.assert_not_awaited()

    async def test_export_failure_records_generic_reason_without_error_payload(self):
        await self.owner.prepare(self.b)
        self.port.publish_video = AsyncMock(side_effect=RuntimeError('PRIVATE_URL_TOKEN_TEXT'))
        async with asyncio.timeout(2):
            while not self.owner.retirement_task:
                await asyncio.sleep(.01)
        await self.owner.retirement_task
        value = self.owner.status()['sharingDiagnostics']
        self.assertEqual(value['firstStop']['reason'], 'export_unavailable')
        self.assertNotIn('PRIVATE', json.dumps(value))
        await self.owner.close()
        self.assertEqual(self.owner.status()['sharingDiagnostics']['firstStop'], value['firstStop'])
    async def test_controller_routes_require_exact_binding_and_no_browser(self):
        server = TestServer(web_app := control_app(self.owner, self.b, 'x' * 40, 3322))
        client = TestClient(server)
        await client.start_server()
        try:
            headers = {'Host': '127.0.0.1:3322', 'Authorization': 'Bearer ' + 'x' * 40}
            response = await client.get('/status', headers=headers)
            self.assertEqual(response.status, 200)
            value = await response.json()
            self.assertEqual(value['state'], 'absent')
            self.assertEqual(value['mode'], 'handset_walkthrough')
            self.assertFalse(value['nativeCallClosed'])
            response = await client.post('/presentation/prepare', headers={**headers, 'Origin': 'http://127.0.0.1:3322'},
                json={'callAttemptId': self.b['callAttemptId'], **self.p})
            self.assertEqual(response.status, 403)
            response = await client.post('/presentation/show', headers=headers, json={'callAttemptId': 'wrong'})
            self.assertEqual(response.status, 409)
            self.assertFalse(self.source.started)
        finally:
            await client.close()

    async def test_activation_waits_for_exact_worker_and_fresh_frame(self):
        await self.owner.prepare(self.b)
        self.owner.audio_ready.clear()
        opened = asyncio.Event()
        class Runtime:
            closed = False
            failed = None
            ended = asyncio.Event()
            playback = SimpleNamespace(first_output=asyncio.Event())
            diagnostics = SimpleNamespace(snapshot=lambda: {})
            async def start(inner):
                await self.owner.fresh_video()
                opened.set()
                inner.playback.first_output.set()
            async def input_audio(inner, pcm): pass
            async def close(inner): inner.closed = True
            async def suppress_scene_speech(inner): pass
        self.owner.runtime_factory = lambda *args: Runtime()
        activation = asyncio.create_task(self.owner.activate({'callAttemptId': 'call_fixture',
            'providerCallId': 'provider_fixture', 'connected': True}))
        await asyncio.sleep(.03)
        self.assertFalse(opened.is_set())
        self.owner.audio_ready.set()
        value = await activation
        self.assertTrue(opened.is_set())
        self.assertEqual(value['state'], 'active')
        self.assertLess(time.time() * 1000 - value['videoEvidence']['capturedAt'], 1000)

    async def test_stale_source_watchdog_blanks_while_authority_waits(self):
        await self.owner.prepare(self.b)
        # Simulate an authority call which stalls independently of the source.
        gate = asyncio.Event()
        original = self.owner.authorize_export
        async def stalled():
            await gate.wait()
            return await original()
        self.owner.authorize_export = stalled
        async with asyncio.timeout(2):
            while not self.port.stopped:
                await asyncio.sleep(.01)
        await self.owner.stop_sharing()
        self.assertTrue(self.source.closed)
        self.assertFalse(self.owner.stopping)
        gate.set()
        if self.owner.retirement_task:
            await self.owner.retirement_task
        value = self.owner.status()['sharingDiagnostics']
        self.assertEqual(value['firstStop']['reason'], 'frame_stale')
        self.assertEqual(value['firstStop']['mediaState'], 'prepared')
        self.assertGreaterEqual(value['firstStop']['lastFrameAgeMs'], 1000)
        self.provider.open.assert_not_awaited()

    async def test_stop_after_failed_speech_clear_still_stops_source_and_video(self):
        await self.owner.prepare(self.b)
        self.owner.runtime = SimpleNamespace(closed=False, suppress_scene_speech=AsyncMock(side_effect=VoiceError('sink_failed')),
            close=AsyncMock(), diagnostics=SimpleNamespace(snapshot=lambda: {}))
        with self.assertRaises(VoiceError):
            await self.owner.stop_sharing()
        self.assertTrue(self.source.closed)
        self.assertTrue(self.port.stopped)

    async def test_full_stop_blanks_before_slow_voice_end_receipt(self):
        await self.owner.prepare(self.b)
        gate, entered = asyncio.Event(), asyncio.Event()
        async def close_voice():
            entered.set()
            await gate.wait()
        self.owner.runtime = SimpleNamespace(closed=False, suppress_scene_speech=AsyncMock(),
            close=close_voice, diagnostics=SimpleNamespace(snapshot=lambda: {}))
        closing = asyncio.create_task(self.owner.close())
        await entered.wait()
        self.assertTrue(self.port.stopped)
        self.assertTrue(self.source.closed)
        self.assertFalse(closing.done())
        gate.set()
        self.assertTrue((await closing)['closed'])


class DialogueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = fixture()
        self.b = binding(self.p)
        self.delegate = API(self.b, self.p)
        self.api = WalkthroughTaskAPI(self.delegate, self.b)
        self.ws, self.sink = Socket(), Sink()
        self.provider = SimpleNamespace(open=AsyncMock(return_value=self.ws), close=AsyncMock())
        self.presentation = SimpleNamespace(presentation=SimpleNamespace(binding=self.p), fresh_video=AsyncMock(),
            sharing_stopped=False, stop_sharing=AsyncMock())
        self.runtime = DeepgramWalkthroughRuntime(self.api, self.provider, self.sink, presentation=self.presentation,
            poll_seconds=60, startup_seconds=.5)
    async def asyncTearDown(self):
        await self.runtime.close()
    async def start(self):
        self.ws.event({'type': 'Welcome', 'request_id': 'fixture'})
        await self.runtime.start()
        self.ws.audio()
        await asyncio.wait_for(self.runtime.playback.first_output.wait(), .2)
    async def transcript(self, text):
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': text})
        await self.runtime.latest['receipt']
    async def call(self, name, params=None, identity='function_fixture'):
        self.runtime.pending_tools += 1
        await self.runtime.function({'id': identity, 'name': name, 'arguments': json.dumps(params or {})}, self.runtime.latest)
    async def test_first_greeting_waits_for_fresh_video_twice_and_one_provider(self):
        await self.start()
        self.assertEqual(self.presentation.fresh_video.await_count, 2)
        self.provider.open.assert_awaited_once()
        value = self.ws.sent[0]
        self.assertEqual(value['agent']['greeting'], self.p['manifest']['opening'])
        self.assertEqual(len(value['agent']['think']['functions']), 6)
        self.assertTrue(all(f['defer_until_eot'] for f in value['agent']['think']['functions']))
        self.assertNotIn('think_live', value['agent'])
    async def test_stale_video_refuses_provider_open(self):
        self.presentation.fresh_video.side_effect = VoiceError('stale')
        with self.assertRaises(VoiceError):
            await self.runtime.start()
        self.provider.open.assert_not_awaited()
    async def test_instruction_uses_exact_final_receipt_no_model_text(self):
        await self.start()
        await self.transcript('Add a clear filters button')
        await self.call('submit_instruction', {'text': 'Substitute malicious text'})
        self.assertFalse(any(p == '/instructions' for p, _ in self.delegate.calls))
        await self.call('submit_instruction')
        calls = [body for p, body in self.delegate.calls if p == '/instructions']
        self.assertEqual(calls, [{'eventId': 'instruction_deepgram_final_1', 'utteranceId': 'deepgram_final_1'}])
        await self.call('submit_instruction', identity='another')
        self.assertEqual(sum(p == '/instructions' for p, _ in self.delegate.calls), 1)
    async def test_interruption_preserves_submitted_held_instruction(self):
        await self.start()
        await self.transcript('Change the empty state')
        self.delegate.instruction_gate = asyncio.Event()
        task = asyncio.create_task(self.call('submit_instruction'))
        async with asyncio.timeout(1):
            while not any(p == '/instructions' for p, _ in self.delegate.calls):
                await asyncio.sleep(0)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        self.delegate.instruction_gate.set()
        await task
        self.assertIn('deepgram_final_1', self.runtime.intent_receipts)
        self.assertFalse(self.runtime.response_authorized)

    async def test_clarification_is_cached_then_explicit_fresh_choice_submits_once(self):
        await self.start()
        original = self.delegate.request
        async def request(path, body=None):
            result = await original(path, body)
            if path == '/instructions' and body['utteranceId'] == 'deepgram_final_1':
                return {'state': 'clarification_required', 'instructionSubmitted': False,
                    'taskId': self.api.task_id, 'question': 'Which empty state should be shown?',
                    'options': ['Show a clear filters button', 'Show a message only']}
            return result
        self.delegate.request = request
        await self.transcript('Yes, go ahead.')
        await self.call('submit_instruction')
        response = json.loads(self.ws.sent[-1]['content'])
        value = json.loads(response['result'])
        self.assertFalse(response['is_error'])
        self.assertFalse(value['instructionSubmitted'])
        self.assertEqual(value['state'], 'clarification_required')
        self.assertIn('no new run', value['guidance'])
        self.assertTrue(self.runtime.response_authorized)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant',
            'content': 'Which empty state should be shown: a clear filters button or a message only?'})
        self.assertTrue(self.runtime.output_allowed)
        await self.call('submit_instruction', identity='duplicate_clarification')
        self.assertEqual(sum(path == '/instructions' for path, _ in self.delegate.calls), 1)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('Show a clear filters button')
        await self.call('submit_instruction', identity='explicit_choice')
        posts = [body for path, body in self.delegate.calls if path == '/instructions']
        self.assertEqual([body['utteranceId'] for body in posts], ['deepgram_final_1', 'deepgram_final_2'])
        self.assertTrue(all(set(body) == {'eventId', 'utteranceId'} for body in posts))
        self.assertEqual(json.loads(json.loads(self.ws.sent[-1]['content'])['result'])['state'], 'held')
        await self.call('submit_instruction', identity='duplicate_choice')
        self.assertEqual(sum(path == '/instructions' for path, _ in self.delegate.calls), 2)
        self.assertNotIn('server-bound pending decision', self.ws.sent[0]['agent']['think']['prompt'])

    async def test_late_clarification_cannot_reopen_retired_scene_speech(self):
        await self.start()
        await self.transcript('Yes.')
        original = self.delegate.request
        async def request(path, body=None):
            result = await original(path, body)
            if path == '/instructions':
                await self.runtime.suppress_scene_speech()
                return {'state': 'clarification_required', 'instructionSubmitted': False,
                    'question': 'State the exact change.', 'options': []}
            return result
        self.delegate.request = request
        await self.call('submit_instruction')
        self.assertFalse(self.runtime.response_authorized)
        await self.call('submit_instruction', identity='cached_late_clarification')
        self.assertFalse(self.runtime.response_authorized)
        self.assertEqual(sum(path == '/instructions' for path, _ in self.delegate.calls), 1)
    async def test_cancelled_function_and_stale_final_cannot_mutate(self):
        await self.start()
        await self.transcript('Looks good')
        self.runtime.cancelled_functions.add('function_fixture')
        await self.call('accept_result')
        self.assertFalse(any(p == '/accept' for p, _ in self.delegate.calls))
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.call('accept_result', identity='new')
        self.assertFalse(any(p == '/accept' for p, _ in self.delegate.calls))
    async def test_unprepared_scene_and_model_text_refused(self):
        await self.start()
        await self.transcript('Show the source')
        await self.call('show_scene', {'sceneId': 'unprepared'})
        self.assertFalse(any(p == '/presentation/show' for p, _ in self.delegate.calls))
    async def test_scene_suppression_drops_old_audio_but_status_reopens_dialogue(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old scene'})
        self.assertFalse(self.runtime.output_allowed)
        await self.call('task_status')
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Current status'})
        self.assertTrue(self.runtime.output_allowed)
    async def test_context_wrong_export_and_mode_refused(self):
        for key, value in (('mode', 'handset_audio_smoke'), ('exportGrantId', 'wrong'), ('planFingerprint', 'f' * 64)):
            wrong = dict(self.delegate.value, **{key: value})
            with self.assertRaises(VoiceError):
                self.api.validate_context(wrong)

    async def test_accept_and_stop_use_admitted_id_without_model_substitution(self):
        await self.start()
        await self.transcript('Looks good')
        await self.call('accept_result')
        self.assertIn(('/accept', {'eventId': 'accept_result_deepgram_final_1', 'utteranceId': 'deepgram_final_1'}), self.delegate.calls)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('Stop sharing')
        await self.call('stop_sharing', identity='sharing_stop')
        self.assertIn(('/presentation/stop', {'eventId': 'stop_sharing_deepgram_final_2', 'utteranceId': 'deepgram_final_2'}), self.delegate.calls)
        self.assertFalse(self.runtime.closed)
        self.assertFalse(any(p == '/end' for p, _ in self.delegate.calls))

    async def test_blocked_tool_response_cannot_reopen_old_scene_speech(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.ws.send_json
        async def delayed(value):
            if value['type'] == 'FunctionCallResponse':
                entered.set()
                await gate.wait()
            await original(value)
        self.ws.send_json = delayed
        task = asyncio.create_task(self.call('task_status'))
        await entered.wait()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old scene'})
        self.assertFalse(self.runtime.output_allowed)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        gate.set()
        await task
        self.assertFalse(self.runtime.response_authorized)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old response'})
        self.assertFalse(self.runtime.output_allowed)

    async def test_tool_generation_is_captured_before_spawn_runs(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        self.runtime.latest = None
        # Admission occurs now; execution does not start until after barge-in.
        self.runtime.pending_tools += 1
        admitted = self.runtime.function_coroutine({'id': 'old_status', 'name': 'task_status', 'arguments': '{}'}, None)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await admitted
        self.assertFalse(self.runtime.response_authorized)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old status'})
        self.assertFalse(self.runtime.output_allowed)

    async def test_cached_show_receipt_cannot_restore_retired_scene_speech(self):
        await self.start()
        await self.transcript('Show the source')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/presentation/show':
                self.delegate.calls.append((path, body))
                return {'sceneId': 'scene_code', 'generation': 1, 'evidence': 'sdk_frame_accepted_not_remote_seen'}
            return await original(path, body)
        self.delegate.request = request
        await self.call('show_scene', {'sceneId': 'scene_code'}, identity='first')
        self.assertTrue(self.runtime.response_authorized)
        await self.runtime.suppress_scene_speech()
        self.presentation.fresh_video.side_effect = VoiceError('sharing_stopped')
        await self.call('show_scene', {'sceneId': 'scene_code'}, identity='duplicate')
        self.assertEqual(sum(p == '/presentation/show' for p, _ in self.delegate.calls), 1)
        self.assertFalse(self.runtime.response_authorized)
        self.assertTrue(json.loads(self.ws.sent[-1]['content'])['is_error'])

    async def wait_reply(self):
        async with asyncio.timeout(.5):
            while self.runtime.reply_candidate and not self.runtime.reply_candidate['admitted']:
                await asyncio.sleep(0)

    async def test_post_retirement_natural_followup_plays_without_any_tool(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        before = len(self.sink.frames)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old source narration'})
        await self.runtime.handle_audio(b'\x01\x00' * 160)
        self.assertFalse(self.runtime.output_allowed)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('Are you still there?')
        await self.wait_reply()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Yes. What replacement text would you like?'})
        await self.runtime.handle_audio(b'\x02\x00' * 160)
        async with asyncio.timeout(.5):
            while len(self.sink.frames) == before:
                await asyncio.sleep(0)
        self.assertTrue(self.runtime.output_allowed)
        self.assertFalse(any(p in ('/instructions', '/presentation/show') for p, _ in self.delegate.calls))
        self.provider.open.assert_awaited_once()
        # Every subsequent ordinary turn can resume too, not just the first one.
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('Can we talk before another change?')
        await self.wait_reply()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Yes, we can clarify it first.'})
        self.assertTrue(self.runtime.output_allowed)

    async def test_pending_final_receipt_quarantines_then_releases_current_reply(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate = asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'What text do you need?'})
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Please give me the replacement text.'})
        await self.runtime.handle_audio(b'\x02\x00' * 160)
        self.assertFalse(self.runtime.output_allowed)
        self.assertEqual(self.runtime.reply_candidate['bytes'], 320)
        gate.set()
        await self.wait_reply()
        self.assertTrue(self.runtime.output_allowed)
        self.assertEqual(self.runtime.reply_candidate['bytes'], 0)

    async def test_stop_before_prior_receipt_finishes_cannot_reopen_speech(self):
        await self.start()
        gate = asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'Change the text'})
        prior = self.runtime.latest
        await self.runtime.suppress_scene_speech()
        gate.set()
        await prior['receipt']
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old scene response'})
        await self.runtime.handle_audio(b'\x01\x00' * 160)
        self.assertFalse(self.runtime.output_allowed)
        self.assertIsNone(self.runtime.reply_candidate)

    async def test_new_onset_discards_quarantine_without_canceling_human_receipt(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate = asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'What should we change?'})
        prior = self.runtime.latest
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'An old clarification'})
        await self.runtime.handle_audio(b'\x01\x00' * 160)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        self.assertIsNone(self.runtime.reply_candidate)
        gate.set()
        self.assertEqual((await prior['receipt'])['utteranceId'], prior['id'])
        self.assertFalse(self.runtime.output_allowed)

    async def test_quarantine_overflow_drops_without_ending_dialogue(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate = asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'Please clarify'})
        prior = self.runtime.latest
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Clarification'})
        await self.runtime.handle_audio(bytes(64002))
        self.assertIsNone(self.runtime.reply_candidate)
        self.assertFalse(self.runtime.closed)
        gate.set()
        await prior['receipt']

    async def test_instruction_response_then_automatic_retirement_allows_next_clarification(self):
        await self.start()
        await self.transcript('Change the active state text.')
        await self.call('submit_instruction')
        self.assertTrue(self.runtime.response_authorized)
        # Root retires the old presentation after the instruction creates a run.
        await self.runtime.suppress_scene_speech()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Stale prior scene'})
        self.assertFalse(self.runtime.output_allowed)
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('Yes. Please change that.')
        await self.wait_reply()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'What exact replacement text should I use?'})
        self.assertTrue(self.runtime.output_allowed)
        self.assertEqual(sum(p == '/instructions' for p, _ in self.delegate.calls), 1)
        prompt = self.runtime.provider_settings(self.runtime.context)['agent']['think']['prompt']
        self.assertIn('ask one concrete', prompt)
        self.assertIn("utterance itself names it", prompt)
        self.assertIn('itself an offered option (for example Yes/No)', prompt)
        self.assertNotIn('server-bound pending decision', prompt)

    async def test_first_final_after_retirement_uses_fresh_run_once(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        self.delegate.value.update(runId='run_after_instruction', revision=5, sequence=5, exportActive=False, sharingActive=False)
        self.assertNotEqual(self.runtime.context['runId'], self.delegate.value['runId'])
        await self.transcript('What exact replacement do you need?')
        await self.wait_reply()
        posts = [body for path, body in self.delegate.calls if path == '/utterances']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]['runId'], 'run_after_instruction')
        self.assertEqual(posts[0]['expectedRevision'], 5)
        self.assertEqual(posts[0]['text'], 'What exact replacement do you need?')
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'What should the active label say?'})
        self.assertTrue(self.runtime.output_allowed)

    async def test_refused_final_is_not_rebound_or_retried_and_next_turn_can_recover(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        self.delegate.failure = '/utterances'
        await self.transcript('A refused turn')
        await self.wait_reply()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Do not play this'})
        self.assertFalse(self.runtime.output_allowed)
        self.assertEqual(sum(path == '/utterances' for path, _ in self.delegate.calls), 1)
        self.delegate.failure = None
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.transcript('A fresh clarification')
        await self.wait_reply()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Please give the replacement text.'})
        self.assertTrue(self.runtime.output_allowed)
        self.assertEqual(sum(path == '/utterances' for path, _ in self.delegate.calls), 2)

    async def test_stop_during_fresh_context_lookup_preserves_receipt_without_speech(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/context':
                entered.set()
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'A bounded final turn'})
        prior = self.runtime.latest
        await entered.wait()
        await self.runtime.suppress_scene_speech()
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        gate.set()
        receipt = await prior['receipt']
        self.assertEqual(receipt['utteranceId'], prior['id'])
        posts = [body for path, body in self.delegate.calls if path == '/utterances']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]['text'], 'A bounded final turn')
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old reply'})
        self.assertFalse(self.runtime.output_allowed)

    async def test_quarantine_deadline_discards_before_late_receipt_without_voice_end(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate = asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'A delayed final turn'})
        prior = self.runtime.latest
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'A bounded delayed reply'})
        await self.runtime.handle_audio(b'\x01\x00' * 160)
        async with asyncio.timeout(2.5):
            while self.runtime.reply_candidate is not None:
                await asyncio.sleep(.02)
        self.assertFalse(self.runtime.closed)
        gate.set()
        await prior['receipt']
        self.assertFalse(self.runtime.output_allowed)
        self.assertIsNone(self.runtime.reply_candidate)

    async def test_old_status_send_cannot_reopen_speech_after_retirement_without_onset(self):
        await self.start()
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.ws.send_json
        async def delayed(value):
            if value['type'] == 'FunctionCallResponse':
                entered.set()
                await gate.wait()
            await original(value)
        self.ws.send_json = delayed
        task = asyncio.create_task(self.call('task_status'))
        await entered.wait()
        await self.runtime.suppress_scene_speech()
        gate.set()
        await task
        self.assertFalse(self.runtime.response_authorized)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Old visible scene status'})
        self.assertFalse(self.runtime.output_allowed)

    async def test_scene_show_can_establish_epoch_only_after_its_fresh_frame(self):
        await self.start()
        await self.transcript('Show the source')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/presentation/show':
                await self.runtime.suppress_scene_speech()
                return {'sceneId': 'scene_code', 'generation': 1, 'evidence': 'sdk_frame_accepted_not_remote_seen'}
            return await original(path, body)
        self.delegate.request = request
        await self.call('show_scene', {'sceneId': 'scene_code'})
        self.presentation.fresh_video.assert_awaited_with('scene_code', 1)
        self.assertTrue(self.runtime.response_authorized)

    async def test_new_confirmed_instruction_ack_survives_its_own_retirement(self):
        await self.start()
        await self.transcript('Set the active state text to Ready')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/instructions':
                await self.runtime.suppress_scene_speech()
            return await original(path, body)
        self.delegate.request = request
        await self.call('submit_instruction')
        self.assertTrue(self.runtime.response_authorized)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'The instruction is queued.'})
        self.assertTrue(self.runtime.output_allowed)
        # A subsequent suppression cannot be renewed by the cached old receipt.
        await self.runtime.suppress_scene_speech()
        await self.call('submit_instruction', identity='old_cached')
        self.assertFalse(self.runtime.response_authorized)
        self.assertEqual(sum(path == '/instructions' for path, _ in self.delegate.calls), 1)

    async def test_unknown_instruction_result_cannot_adopt_retirement_epoch(self):
        await self.start()
        await self.transcript('Set the active state text to Ready')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/instructions':
                await self.runtime.suppress_scene_speech()
                return {'state': 'unknown', 'taskId': self.api.task_id}
            return await original(path, body)
        self.delegate.request = request
        await self.call('submit_instruction')
        self.assertFalse(self.runtime.response_authorized)
        self.assertFalse(self.runtime.output_allowed)

    async def test_confirmed_stop_ack_can_follow_its_own_suppression(self):
        await self.start()
        await self.transcript('Stop sharing')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/presentation/stop':
                await self.runtime.suppress_scene_speech()
            return await original(path, body)
        self.delegate.request = request
        await self.call('stop_sharing')
        self.assertTrue(self.runtime.response_authorized)
        self.assertFalse(self.runtime.closed)

    async def test_cancelled_tool_waiter_does_not_cancel_shared_transcript_receipt(self):
        await self.start()
        await self.runtime.suppress_scene_speech()
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/utterances':
                entered.set()
                await gate.wait()
            return await original(path, body)
        self.delegate.request = request
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': 'A pending final instruction'})
        final = self.runtime.latest
        await entered.wait()
        waiter = asyncio.create_task(self.call('submit_instruction'))
        await asyncio.sleep(0)
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        self.assertFalse(final['receipt'].cancelled())
        gate.set()
        self.assertEqual((await final['receipt'])['utteranceId'], final['id'])
        await self.wait_reply()
        self.assertTrue(self.runtime.reply_candidate['admitted'])
        self.assertFalse(any(path == '/instructions' for path, _ in self.delegate.calls))

    async def test_malformed_confirmations_cannot_adopt_retirement_epoch(self):
        await self.start()
        original = self.delegate.request
        cases = [
            ('stop_sharing', '/presentation/stop', {'sharingStopped': 1, 'voiceEnded': False, 'taskCanceled': False}),
            ('submit_instruction', '/instructions', {'state': 'held', 'taskId': 'wrong_task'}),
            ('submit_instruction', '/instructions', {'state': 'applied', 'taskId': self.api.task_id, 'runId': None}),
        ]
        for index, (name, route, result) in enumerate(cases):
            async def request(path, body=None):
                if path == route:
                    await self.runtime.suppress_scene_speech()
                    return result
                return await original(path, body)
            self.delegate.request = request
            await self.runtime.handle({'type': 'UserStartedSpeaking'})
            await self.transcript('An explicit fixture instruction ' + str(index))
            await self.call(name, identity='shape_' + str(index))
            self.assertFalse(self.runtime.response_authorized)
            self.assertFalse(self.runtime.output_allowed)

    async def test_failed_acceptance_reads_status_once_and_never_reposts_same_final(self):
        await self.start()
        await self.transcript('Looks good, thanks.')
        self.delegate.failure = '/accept'
        before = sum(path == '/context' for path, _ in self.delegate.calls)
        await self.call('accept_result', identity='first_accept')
        result = json.loads(json.loads(self.ws.sent[-1]['content'])['result'])
        self.assertEqual(result['guidance'], 'explicit_acceptance_if_wanted')
        self.assertEqual(result['attemptOutcome'], 'unconfirmed')
        self.assertTrue(json.loads(self.ws.sent[-1]['content'])['is_error'])
        self.assertTrue(self.runtime.response_authorized)
        await self.call('accept_result', identity='duplicate_accept')
        self.assertEqual(sum(path == '/accept' for path, _ in self.delegate.calls), 1)
        self.assertEqual(sum(path == '/context' for path, _ in self.delegate.calls) - before, 1)

    async def test_unconfirmed_acceptance_reports_already_accepted_from_status_only(self):
        await self.start()
        await self.transcript('I accept the result')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/accept':
                self.delegate.calls.append((path, body))
                self.delegate.value['state'] = 'accepted'
                raise VoiceError('synthetic_transport_unknown')
            return await original(path, body)
        self.delegate.request = request
        await self.call('accept_result')
        result = json.loads(json.loads(self.ws.sent[-1]['content'])['result'])
        self.assertEqual(result['guidance'], 'already_accepted')
        self.assertEqual(result['attemptOutcome'], 'unconfirmed')
        self.assertEqual(result['taskState'], 'accepted')
        self.assertNotIn('accepted', {key: value for key, value in result.items() if key != 'taskState'})

    async def test_failed_acceptance_of_changed_result_requires_fresh_review(self):
        await self.start()
        await self.transcript('Looks good')
        self.delegate.failure = '/accept'
        self.delegate.value.update(runId='new_run', revision=9, sequence=9, state='review_ready')
        await self.call('accept_result')
        result = json.loads(json.loads(self.ws.sent[-1]['content'])['result'])
        self.assertEqual(result['guidance'], 'fresh_review_required')
        self.assertFalse(any(path == '/instructions' for path, _ in self.delegate.calls))

    async def test_acceptance_recovery_status_failure_is_bounded_and_not_success(self):
        await self.start()
        await self.transcript('Looks good')
        original = self.delegate.request
        async def request(path, body=None):
            if path in ('/accept', '/context'):
                self.delegate.calls.append((path, body))
                raise VoiceError('synthetic_peer_secret_must_not_escape')
            return await original(path, body)
        self.delegate.request = request
        await self.call('accept_result')
        await self.call('accept_result', identity='duplicate')
        content = json.loads(self.ws.sent[-1]['content'])
        result = json.loads(content['result'])
        self.assertEqual(result['guidance'], 'status_unavailable')
        self.assertTrue(content['is_error'])
        self.assertNotIn('synthetic_peer_secret', content['result'])
        self.assertEqual(sum(path == '/accept' for path, _ in self.delegate.calls), 1)

    async def test_retirement_during_recovery_status_read_cannot_reopen_old_speech(self):
        await self.start()
        await self.transcript('Looks good')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/accept':
                raise VoiceError('synthetic_refusal')
            if path == '/context':
                await self.runtime.suppress_scene_speech()
            return await original(path, body)
        self.delegate.request = request
        await self.call('accept_result')
        self.assertFalse(self.runtime.response_authorized)
        self.assertFalse(self.runtime.output_allowed)

    async def test_confirmed_acceptance_does_not_run_recovery_check(self):
        await self.start()
        await self.transcript('I accept the result')
        before = sum(path == '/context' for path, _ in self.delegate.calls)
        await self.call('accept_result')
        self.assertFalse(json.loads(self.ws.sent[-1]['content'])['is_error'])
        self.assertEqual(sum(path == '/context' for path, _ in self.delegate.calls), before)
        self.assertEqual(self.runtime.acceptance_recovery_epochs, {})

    async def test_delayed_older_acceptance_status_cannot_describe_retired_result(self):
        await self.start()
        await self.transcript('Looks good')
        original = self.delegate.request
        async def request(path, body=None):
            if path == '/accept':
                self.delegate.calls.append((path, body))
                raise VoiceError('synthetic_refusal')
            if path == '/context':
                old = await original(path, body)
                self.runtime.context = {**old, 'runId': 'newer_run', 'revision': old['revision'] + 1, 'sequence': old['sequence'] + 1}
                return old
            return await original(path, body)
        self.delegate.request = request
        await self.call('accept_result')
        content = json.loads(self.ws.sent[-1]['content'])
        result = json.loads(content['result'])
        self.assertTrue(content['is_error'])
        self.assertEqual(result['statusRead'], 'unavailable')
        self.assertEqual(result['guidance'], 'status_unavailable')
        self.assertNotIn('taskState', result)
        self.assertEqual(self.runtime.context['runId'], 'newer_run')
        self.assertFalse(self.runtime.response_authorized)
        self.assertEqual(sum(path == '/accept' for path, _ in self.delegate.calls), 1)


class ConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_controller_start_status_shutdown_has_zero_external_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p, b = fixture(), binding()
            now = int(time.time() * 1000)
            grant = {'version': 1, 'mode': 'handset_walkthrough', 'id': b['exportGrantId'],
                'planFingerprint': b['planFingerprint'], 'authorizationId': 'authorization_fixture',
                'sourcePairingId': 'pairing_fixture', 'projectRoot': str(root / 'worker'),
                'authorizedAt': now - 100, 'dispatchExpiresAt': b['dispatchExpiresAt'], 'expiresAt': b['expiresAt'],
                'exportPreparedWindows': True, 'instructions': True, 'control': False, 'nativeActivation': False, 'maxCalls': 1}
            helper = root / 'helper'
            helper.write_text('This fixture is never executed.')
            values = {'binding': b,
                'voice': {'version': 1, 'taskOrigin': 'http://127.0.0.1:13323', 'taskId': b['taskId'],
                    'voiceSessionId': b['voiceSessionId'], 'voiceToken': 'v' * 40},
                'provider': {'provider': 'deepgram', 'deepgramApiKey': 'synthetic_key_not_real'},
                'livekit': {'url': 'wss://example.invalid', 'key': 'synthetic', 'secret': 'synthetic', 'allowedHosts': ['example.invalid']},
                'control': {'token': 'c' * 40},
                'presentation': {'prepare': p, 'taskOrigin': 'http://127.0.0.1:13323', 'taskToken': 't' * 40,
                    'helperBinary': str(helper), 'exportGrant': grant}}
            args = SimpleNamespace(port=3322, journal=str(root / 'journal.sqlite'))
            for name, value in values.items():
                path = root / (name + '.json')
                path.write_text(json.dumps(value))
                path.chmod(0o600)
                setattr(args, name + '_file', str(path))
            with patch('task_walkthrough_livekit_local.DeepgramProvider.readiness', new_callable=AsyncMock) as ready, \
                 patch('task_walkthrough_livekit_local.NativeWindowSource.start', new_callable=AsyncMock) as capture, \
                 patch('task_walkthrough_livekit_local.LiveKitWalkthroughPort.prepare', new_callable=AsyncMock) as room:
                app = await configured_app(args)
                client = TestClient(TestServer(app))
                await client.start_server()
                response = await client.get('/status', headers={'Host': '127.0.0.1:3322', 'Authorization': 'Bearer ' + 'c' * 40})
                self.assertEqual(response.status, 200)
                self.assertEqual((await response.json())['state'], 'absent')
                await client.close()
                ready.assert_not_awaited()
                capture.assert_not_awaited()
                room.assert_not_awaited()
            wrong = dict(grant, exportPreparedWindows=False)
            with self.assertRaises(VoiceError):
                validate_export(wrong, b, p, time.time())


class SDKTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_sdk_rgba_frame_and_blank_only_after_stop(self):
        port = LiveKitWalkthroughPort('wss://example.invalid', 'key', 'secret', allowed_hosts={'example.invalid'})
        port.binding = binding()
        port.video_source = rtc.VideoSource(1280, 720, is_screencast=True)
        port.video_publication = SimpleNamespace(sid='synthetic_publication')
        port.room = SimpleNamespace(local_participant=SimpleNamespace(unpublish_track=AsyncMock()))
        now = time.time() * 1000
        frame = {'presentationId': port.binding['presentationBinding']['presentationId'],
            'manifestFingerprint': port.binding['presentationBinding']['manifestFingerprint'], 'sceneId': 'scene_code',
            'generation': 1, 'sourceFrameId': 'source_1', 'geometryGeneration': 'geometry_1',
            'capturedAt': now, 'renderedAt': now}
        image = io.BytesIO()
        Image.new('RGB', (1280, 720), '#00ab55').save(image, 'JPEG')
        try:
            evidence = await port.publish_video(image.getvalue(), frame)
            self.assertEqual(evidence['evidence'], 'sdk_frame_accepted_not_remote_seen')
            self.assertGreaterEqual(evidence['acceptedAt'], now)
            self.assertEqual(port._token_sources('worker_fixture'), ['microphone'])
            self.assertEqual(port._token_sources('agent_fixture'), ['microphone', 'screen_share'])
            with patch.object(port.video_source, 'capture_frame', wraps=port.video_source.capture_frame) as capture:
                self.assertTrue(await port.stop_video())
                blank = bytes(capture.call_args.args[0].data)
                self.assertEqual(blank, b'\x00\x00\x00\xff' * (1280 * 720))
            self.assertIsNotNone(port.blank_task)
            port.room.local_participant.unpublish_track.assert_not_awaited()
            with self.assertRaises(VoiceError):
                await port.publish_video(image.getvalue(), frame)
        finally:
            if port.blank_task:
                port.blank_task.cancel()
                await asyncio.gather(port.blank_task, return_exceptions=True)
            await port.video_source.aclose()

    async def test_late_video_publication_is_joined_and_blanked_after_stop(self):
        from task_voice_livekit import LiveKitAudioPort
        port = LiveKitWalkthroughPort('wss://example.invalid', 'key', 'secret', allowed_hosts={'example.invalid'})
        entered, gate = asyncio.Event(), asyncio.Event()
        publication = SimpleNamespace(sid='fixture')
        async def publish(*args):
            entered.set()
            await gate.wait()
            return publication
        room = SimpleNamespace(local_participant=SimpleNamespace(publish_track=publish, unpublish_track=AsyncMock()),
            disconnect=AsyncMock())
        async def prepare_audio(instance, b, *args):
            instance.binding, instance.room = b, room
            return {'remote_participant_identity': b['agentIdentity']}
        with patch.object(LiveKitAudioPort, 'prepare', prepare_audio):
            preparing = asyncio.create_task(port.prepare(binding(), lambda: None, lambda reason: None))
            await entered.wait()
            stopping = asyncio.create_task(port.stop_video())
            await asyncio.sleep(.01)
            self.assertFalse(stopping.done())
            gate.set()
            result = await asyncio.gather(preparing, return_exceptions=True)
            self.assertIsInstance(result[0], VoiceError)
            self.assertTrue(await stopping)
            self.assertIsNotNone(port.blank_task)
            self.assertTrue(await port.close())
            room.local_participant.unpublish_track.assert_awaited_once_with('fixture')
            room.disconnect.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
