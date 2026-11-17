import asyncio
import base64
import copy
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestClient, TestServer
from livekit import rtc

from elevenlabs_frontend import (ElevenLabsFrontend, TOOL_PARAMETERS, allowed,
                                bounded_context, client_tool_definitions, validate_agent, validate_configured_agent)
from server import Service, Session
from speech_diagnostics import SpeechDiagnostics
from elevenlabs_agent_config import configuration


def policy():
    return {'conversationVersion': 1, 'conversationFrontend': 'elevenlabs',
            'protocolVersion': 2, 'voiceInteractionVersion': 1, 'voiceMode': 'two_way',
            'remoteAudioIsolated': True, 'state': 'listening', 'callId': 'call',
            'expiresAt': '2099-01-01T00:00:00Z', 'conversationRevision': 0}


def env():
    return {'MEDIA_ELEVENLABS_ENABLED': 'true', 'MEDIA_TWO_WAY_VOICE_ENABLED': 'true',
            'ELEVENLABS_API_KEY': 'synthetic-not-a-key', 'ELEVENLABS_AGENT_ID': 'agent_fixture'}


def agent_config():
    return {'agent_id': 'agent_fixture', 'conversation_config': {
        'asr': {'user_input_audio_format': 'pcm_16000'},
        'tts': {'agent_output_audio_format': 'pcm_16000', 'model_id': 'eleven_flash_v2'},
        'agent': {'prompt': {'llm': 'gemini-2.5-flash', 'tools': client_tool_definitions()}},
        'conversation': {'client_events': ['audio', 'interruption', 'user_transcript', 'agent_response']}},
        'platform_settings': {'auth': {'enable_auth': True},
            'privacy': {'record_voice': False, 'retention_days': 0, 'delete_audio': True, 'delete_transcript_and_pii': True},
            'overrides': {'conversation_config_override': {'agent': {'prompt': {'prompt': True}, 'first_message': True}}}}}


def context(sequence=0):
    return {'sequence': sequence, 'context': 'Fixture task. No work has executed.', 'updates': [],
            'cameraTargets': [{'id': 'target_one', 'label': 'Prepared fixture region'}]}


def metadata():
    return {'type': 'conversation_initiation_metadata', 'conversation_initiation_metadata_event': {
        'conversation_id': 'conversation_fixture', 'agent_output_audio_format': 'pcm_16000',
        'user_input_audio_format': 'pcm_16000'}}


def transcript(identity=1, text='Inspect the fixture and explain the result'):
    return {'type': 'user_transcript', 'user_transcription_event': {'event_id': identity, 'user_transcript': text}}


class FrontendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner = SimpleNamespace(env=env(), backend=AsyncMock(return_value={'accepted': True, 'reply': 'Queued; not complete.'}))
        self.parent = SimpleNamespace(id='ct_' + 'a' * 40, owner=self.owner, active=True, allowed=True,
            closing=False, pause_latched=False, two_way=True, policy_at=time.monotonic(), call_id='call',
            speaking=False, playback_generation=0, conversation_revision=0, first_audio_published=False,
            audio=asyncio.Queue(maxsize=100), playback_event=Mock(), request_failure=Mock(),
            observe_audio_activity=Mock(), stream=None)
        self.frontend = ElevenLabsFrontend(self.parent)
        self.frontend.ws = SimpleNamespace(closed=False, send_json=AsyncMock(), close=AsyncMock())
        def cancel(*args, **kwargs):
            self.frontend.cutoff()
            self.parent.playback_generation += 1
            while not self.parent.audio.empty():
                item = self.parent.audio.get_nowait()[1]
                if isinstance(item, asyncio.Future): item.cancel()
        self.owner.cancel_speech = Mock(side_effect=cancel)
        await self.frontend.handle(metadata())

    async def asyncTearDown(self):
        await self.frontend.close()

    async def invoke(self, name='send_to_agent', identity='tool1', utterance='u1', **kwargs):
        await self.frontend.handle({'type': 'client_tool_call', 'client_tool_call': {
            'tool_call_id': identity, 'tool_name': name,
            'parameters': ({'text': kwargs.pop('text', self.frontend.latest['text'] if self.frontend.latest else 'Unobserved request'), **kwargs} if name == 'send_to_agent' else kwargs)}})
        await asyncio.gather(*list(self.frontend.tasks), return_exceptions=True)

    async def test_disabled_and_nonisolated_policy_cannot_enable_frontend(self):
        self.assertTrue(allowed(policy(), env()))
        for change in ({'remoteAudioIsolated': False}, {'voiceMode': 'half_duplex'},
                       {'conversationFrontend': 'gpt_live'}, {'protocolVersion': 1}):
            self.assertFalse(allowed({**policy(), **change}, env()))
        for key in env():
            changed = env(); changed.pop(key)
            self.assertFalse(allowed(policy(), changed))

    async def test_actual_transcript_once_only_even_with_different_tool_ids(self):
        await self.frontend.handle(transcript(text='Use the selected option and run the fixture test.'))
        await self.invoke()
        await self.invoke(identity='tool2')
        await self.invoke(identity='tool1')
        self.owner.backend.assert_awaited_once()
        path, body = self.owner.backend.call_args.args
        self.assertTrue(path.endswith('/voice/intent'))
        self.assertEqual(body['text'], 'Use the selected option and run the fixture test.')
        self.assertEqual(body['qualifiedRemoteAudio'], True)
        self.assertNotIn('api_managed', json.dumps(body))

    async def test_unobserved_stale_and_model_rewritten_text_cannot_execute(self):
        await self.invoke()
        await self.frontend.handle(transcript())
        await self.frontend.handle(transcript(2, 'Actually wait.'))
        await self.invoke(identity='old', text='Inspect the fixture and explain the result')
        await self.invoke(identity='rewritten', utterance='u2', text='Delete everything')
        self.owner.backend.assert_not_awaited()

    async def test_duplicate_transcript_is_read_only_and_changed_event_fails(self):
        await self.frontend.handle(transcript())
        count = self.frontend.ws.send_json.await_count
        await self.frontend.handle(transcript())
        self.assertEqual(self.frontend.ws.send_json.await_count, count)
        with self.assertRaises(ValueError):
            await self.frontend.handle(transcript(text='Changed instruction'))
        self.owner.backend.assert_not_awaited()

    async def test_legacy_transcript_without_event_id_is_bounded_and_not_reconnected(self):
        event = transcript(); del event['user_transcription_event']['event_id']
        await self.frontend.handle(event)
        await self.invoke()
        await self.frontend.handle(event)
        await self.invoke(identity='duplicate')
        self.owner.backend.assert_awaited_once()
        self.assertEqual(self.frontend.latest['id'], 'ulocal1')
        event['user_transcription_event']['user_transcript'] = 'Inspect another fixture.'
        await self.frontend.handle(event)
        self.assertEqual(self.frontend.latest['id'], 'ulocal2')

    async def test_unknown_callback_never_retries_under_same_or_new_tool_id(self):
        self.owner.backend.side_effect = TimeoutError()
        await self.frontend.handle(transcript())
        await self.invoke()
        await self.invoke(identity='tool2')
        self.owner.backend.assert_awaited_once()
        result = self.frontend.ws.send_json.call_args.args[0]
        self.assertTrue(result['is_error'])
        self.assertIn('unconfirmed', result['result'])

    async def test_backend_acceptance_is_async_while_audio_and_ping_continue(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def delayed(*args):
            entered.set(); await finish.wait(); return {'accepted': True, 'reply': 'Queued.'}
        self.owner.backend.side_effect = delayed
        output = self.frontend.spawn(self.frontend.output())
        await self.frontend.handle(transcript())
        await self.frontend.handle({'type': 'client_tool_call', 'client_tool_call': {
            'tool_call_id': 'work', 'tool_name': 'send_to_agent', 'parameters': {'text': 'Inspect the fixture and explain the result'}}})
        await entered.wait()
        tools = [task for task in self.frontend.tasks if task is not output]
        await self.frontend.handle({'type': 'ping', 'ping_event': {'event_id': 4}})
        await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 5,
            'audio_base_64': base64.b64encode(b'\x01\x00' * 1600).decode()}})
        published = await asyncio.wait_for(self.parent.audio.get(), 1)
        self.assertEqual(len(published[1]), 1920)
        self.assertTrue(any(published[1]))
        self.assertEqual(self.frontend.ws.send_json.call_args.args[0], {'type': 'pong', 'event_id': 4})
        finish.set()
        await asyncio.gather(*tools)

    async def test_capture_sends_continuous_resampled_pcm_without_microphone(self):
        class SyntheticStream:
            def __init__(self, *args, **kwargs): self.frames = 0
            def __aiter__(self): return self
            async def __anext__(self):
                self.frames += 1
                if self.frames > 12: raise StopAsyncIteration
                return SimpleNamespace(frame=rtc.AudioFrame(b'\x08\x00' * 960, 48000, 1, 960))
            async def aclose(self): pass
        with patch('elevenlabs_frontend.rtc.AudioStream', SyntheticStream):
            await self.frontend.capture(object())
        audio = [call.args[0]['user_audio_chunk'] for call in self.frontend.ws.send_json.await_args_list
                 if 'user_audio_chunk' in call.args[0]]
        self.assertEqual(len(audio), 2)
        self.assertTrue(all(len(base64.b64decode(item)) == 3200 for item in audio))
        self.assertTrue(all(any(base64.b64decode(item)) for item in audio))
        self.assertIsNone(self.parent.stream)

    async def test_cutoff_between_dequeue_and_consumer_does_not_corrupt_byte_bound(self):
        queue = self.frontend.audio_events
        original = queue.get
        async def interleaved():
            value = await original()
            self.frontend.cutoff()
            return value
        queue.get = interleaved
        self.frontend.spawn(self.frontend.output())
        await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 1,
            'audio_base_64': base64.b64encode(b'\x03\x00' * 1600).decode()}})
        await asyncio.sleep(.02)
        self.assertEqual(self.frontend.audio_bytes, 0)
        self.assertTrue(self.parent.audio.empty())

    async def test_prepared_camera_only_and_no_code_action(self):
        await self.frontend.context(context())
        await self.frontend.handle(transcript(text='Show and highlight that fixture.'))
        await self.invoke('show_target', target_id='unknown')
        self.owner.backend.assert_not_awaited()
        await self.invoke('show_target', identity='focus', target_id='target_one')
        await self.invoke('annotate_target', identity='mark', target_id='target_one')
        await self.invoke('show_overview', identity='overview')
        bodies = [call.args[1] for call in self.owner.backend.await_args_list]
        self.assertEqual([body['action'] for body in bodies], ['focus', 'annotate', 'overview'])
        self.assertTrue(all('text' not in body and 'x' not in body for body in bodies))

    async def test_context_revocation_removes_prepared_targets_and_sequences_cannot_regress(self):
        await self.frontend.context(context(2))
        value = context(3); value['cameraTargets'] = []
        await self.frontend.context(value)
        await self.frontend.handle(transcript())
        await self.invoke('show_target', target_id='target_one')
        self.owner.backend.assert_not_awaited()
        with self.assertRaises(ValueError): await self.frontend.context(context(2))

    async def test_end_requires_actual_hangup_and_is_once_only(self):
        for index, text in enumerate(('Do not hang up.', 'The file is called goodbye.', 'Do you think we should hang up?',
                                     'If the test passes, hang up.', 'Keep talking; not goodbye.'), 1):
            await self.frontend.handle(transcript(index, text))
            await self.invoke('end_call', identity='refused' + str(index))
        self.owner.backend.assert_not_awaited()
        await self.frontend.handle(transcript(6, 'Please hang up now.'))
        await self.invoke('end_call', identity='end', utterance='u2')
        await self.invoke('end_call', identity='end_again', utterance='u2')
        self.owner.backend.assert_awaited_once()
        self.assertTrue(self.owner.backend.call_args.args[0].endswith('/voice/end'))
        self.assertEqual(set(self.owner.backend.call_args.args[1]), {'eventId', 'callId', 'qualifiedRemoteAudio'})

    async def test_stop_and_policy_loss_block_new_tools_audio_and_context(self):
        await self.frontend.handle(transcript())
        self.parent.pause_latched = True
        await self.invoke()
        self.owner.backend.assert_not_awaited()
        with self.assertRaises(ValueError): await self.frontend.verified_reply('Completed fixture check.')
        self.parent.pause_latched = False
        self.parent.policy_at = time.monotonic() - 3
        await self.invoke(identity='stale')
        self.owner.backend.assert_not_awaited()

    async def test_interruption_clears_output_and_late_same_response_cannot_resume(self):
        event = {'type': 'audio', 'audio_event': {'event_id': 7,
            'audio_base_64': base64.b64encode(b'\x02\x00' * 1600).decode()}}
        await self.frontend.handle(event)
        self.assertEqual(self.frontend.audio_bytes, 3200)
        await self.frontend.handle({'type': 'interruption', 'interruption_event': {'event_id': 7}})
        self.assertEqual(self.frontend.audio_bytes, 0)
        await self.frontend.handle(event)
        self.assertTrue(self.frontend.audio_events.empty())
        event['audio_event']['event_id'] = 8
        await self.frontend.handle(event)
        self.assertEqual(self.frontend.audio_events.qsize(), 1)

    async def test_real_resampler_output_is_tagged_and_revoked_before_late_audio(self):
        self.frontend.spawn(self.frontend.output())
        await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 1,
            'audio_base_64': base64.b64encode(b'\x03\x00' * 1600).decode()}})
        item = await asyncio.wait_for(self.parent.audio.get(), 1)
        self.assertEqual(len(item[1]), 1920)
        self.assertEqual(item[0], self.parent.playback_generation)
        self.owner.cancel_speech()
        self.assertFalse(self.parent.speaking)
        self.assertTrue(self.parent.audio.empty())

    async def test_progress_dedup_and_no_false_playback_ack(self):
        value = context(1); value['updates'] = [{'id': 'turn1', 'revision': 1, 'text': 'Agent reports the fixture test passed.'}]
        await self.frontend.context(value)
        count = self.frontend.ws.send_json.await_count
        await self.frontend.context(value)
        self.assertEqual(self.frontend.ws.send_json.await_count, count)
        self.assertNotIn('completed', self.frontend.__dict__)
        self.assertFalse(self.frontend.pending_reports)

    async def test_verified_report_triggers_once_without_human_or_tool_authority(self):
        await self.frontend.handle(transcript())
        self.frontend.latest['at'] -= 1
        await self.frontend.verified_reply('The original agent reports a passing fixture check.')
        self.frontend.spawn(self.frontend.report())
        await asyncio.sleep(.12)
        reports = [call.args[0] for call in self.frontend.ws.send_json.await_args_list if call.args[0]['type'] == 'user_message']
        self.assertEqual(len(reports), 1)
        await self.frontend.handle(transcript(2, reports[0]['text']))
        self.assertEqual(self.frontend.latest['id'], 'u1')
        outcome = await self.frontend.execute_tool('synthetic_trigger', 'send_to_agent', {'text': self.frontend.latest['text']})
        self.assertTrue(outcome[1])
        self.owner.backend.assert_not_awaited()
        await self.frontend.handle(transcript(3, 'Inspect the second fixture.'))
        self.assertFalse(self.frontend.report_only)
        # Avoid gathering the long-running report loop in invoke().
        outcome = await self.frontend.execute_tool('human', 'send_to_agent', {'text': self.frontend.latest['text']})
        self.assertFalse(outcome[1])
        self.owner.backend.assert_awaited_once()

    async def test_new_human_transcript_discards_pending_narration(self):
        await self.frontend.verified_reply('Old completion report.')
        self.assertEqual(len(self.frontend.pending_reports), 1)
        await self.frontend.handle(transcript(text='Actually cancel the next step.'))
        self.assertFalse(self.frontend.pending_reports)

    async def test_report_burst_waits_for_output_and_new_human_preempts(self):
        await self.frontend.verified_reply('First explicit answer.')
        self.frontend.spawn(self.frontend.report())
        await asyncio.sleep(.12)
        await self.frontend.verified_reply('Second explicit answer.')
        await self.frontend.verified_reply('Third explicit answer.')
        await asyncio.sleep(.22)
        reports = [call.args[0] for call in self.frontend.ws.send_json.await_args_list if call.args[0]['type'] == 'user_message']
        self.assertEqual(len(reports), 1)
        self.assertEqual(self.frontend.pending_reports[0][1], 'Third explicit answer.')
        await self.frontend.handle(transcript(text='Wait, explain the earlier choice.'))
        self.assertFalse(self.frontend.pending_reports)
        self.assertIsNone(self.frontend.report_in_flight_at)
        self.assertFalse(self.frontend.report_only)

    async def test_report_output_timeout_does_not_retry_or_send_queued_report(self):
        await self.frontend.verified_reply('First explicit answer.')
        self.frontend.spawn(self.frontend.report())
        await asyncio.sleep(.12)
        await self.frontend.verified_reply('Later answer.')
        self.frontend.report_in_flight_at -= 11
        await asyncio.sleep(.12)
        self.assertTrue(self.frontend.report_stalled)
        self.assertFalse(self.frontend.pending_reports)
        reports = [call.args[0] for call in self.frontend.ws.send_json.await_args_list if call.args[0]['type'] == 'user_message']
        self.assertEqual(len(reports), 1)

    async def test_latency_metrics_are_process_scoped_metadata_not_handset_evidence(self):
        self.parent.generation = 2
        self.parent.speech_diagnostics = SpeechDiagnostics(self.parent.id, lambda _: None)
        await self.frontend.handle(transcript())
        await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 2,
            'audio_base_64': base64.b64encode(b'\x01\x00' * 1600).decode()}})
        await self.invoke()
        events = list(self.parent.speech_diagnostics.events)
        self.assertEqual([event['event'] for event in events], ['provider_final', 'voice_response_audio', 'callback_started', 'callback_accepted'])
        self.assertTrue(all(event['generation'] == 2 for event in events))
        self.assertTrue(all('text' not in event for event in events))
        self.assertGreaterEqual(events[1]['durationMs'], 0)
        self.assertGreaterEqual(events[-1]['durationMs'], 0)

    async def test_audio_malformed_and_queue_overflow_fail_closed(self):
        for encoded in ('bad!', base64.b64encode(b'\x01').decode()):
            with self.assertRaises(ValueError):
                await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 1, 'audio_base_64': encoded}})
        self.frontend.audio_bytes = 64000
        with self.assertRaises(ValueError):
            await self.frontend.handle({'type': 'audio', 'audio_event': {'event_id': 1, 'audio_base_64': 'AAA='}})


class ProviderContractTests(unittest.TestCase):
    def test_offline_builder_matches_validation_without_secrets(self):
        config = configuration('fixture_voice')
        validate_agent(config, config['conversation_config']['agent']['prompt']['tools'])
        self.assertEqual(len(config['conversation_config']['agent']['prompt']['tools']), 7)
        for value in ('', '../other', 'voice?secret=value'):
            with self.assertRaises(ValueError): configuration(value)

    def test_exact_agent_configuration_and_tools(self):
        config = agent_config()
        validate_agent(config, client_tool_definitions())
        for key, value in [('record_voice', True), ('retention_days', 1), ('delete_audio', False)]:
            changed = copy.deepcopy(config)
            changed['platform_settings']['privacy'][key] = value
            with self.assertRaises(ValueError): validate_agent(changed, client_tool_definitions())
        for tools in ([], client_tool_definitions() + [{'type': 'webhook', 'name': 'execute'}]):
            with self.assertRaises(ValueError): validate_agent(config, tools)
        changed = client_tool_definitions(); changed[0]['parameters']['additionalProperties'] = True
        with self.assertRaises(ValueError): validate_agent(config, changed)
        changed = copy.deepcopy(config); changed['conversation_config']['agent']['prompt']['built_in_tools'] = {'transfer': {'type': 'system'}}
        with self.assertRaises(ValueError): validate_agent(changed, client_tool_definitions())

    def test_context_bounds_and_shape(self):
        for value in ({}, {**context(), 'sequence': True}, {**context(), 'context': 'x' * 6001},
                      {**context(), 'cameraTargets': [{'id': 'x', 'label': ''}]}):
            with self.assertRaises(ValueError): bounded_context(value)


class ServiceSpeechTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = {**env(), 'MEDIA_DATABASE_PATH': str(Path(self.tmp.name) / 'media.sqlite'), 'MEDIA_API_KEY': 'm' * 32}
        self.service = Service(self.settings)
        self.client = TestClient(TestServer(self.service.app())); await self.client.start_server()
        self.session = Session(self.service, {'id': 'ct_' + 'c' * 40, 'meetingId': 'm', 'lineId': 'l'})
        self.service.sessions[self.session.id] = self.session
        self.session.active = self.session.allowed = self.session.two_way = True
        self.session.policy_at = time.monotonic(); self.session.call_id = 'call'
        self.session.live_frontend = ElevenLabsFrontend(self.session)
        self.session.live_frontend.verified_reply = AsyncMock()
        self.session.say = AsyncMock()
        self.session.close = AsyncMock()
        self.service.backend = AsyncMock(return_value=policy())
        self.headers = {'Authorization': 'Bearer ' + 'm' * 32}
        self.body = {'id': 'reply1', 'text': 'Original agent verified the fixture.', 'callId': 'call', 'expectedRevision': 0}

    async def asyncTearDown(self):
        await self.client.close(); self.tmp.cleanup()

    async def test_verified_reply_is_context_once_unknown_and_never_legacy_tts(self):
        for _ in range(2):
            response = await self.client.post(f'/sessions/{self.session.id}/speak', json=self.body, headers=self.headers)
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['state'], 'unknown')
        self.session.live_frontend.verified_reply.assert_awaited_once_with(self.body['text'])
        self.session.say.assert_not_awaited()
        receipt = self.service.speech.get('reply1')
        self.assertEqual(receipt['reason'], 'frontend_context_submitted')
        second = Service(self.settings)
        try:
            self.assertEqual(second.speech.get('reply1')['state'], 'unknown')
        finally: second.db.close()

    async def test_lost_context_and_changed_fingerprint_do_not_resubmit(self):
        self.session.live_frontend.verified_reply.side_effect = TimeoutError()
        path = f'/sessions/{self.session.id}/speak'
        response = await self.client.post(path, json=self.body, headers=self.headers)
        self.assertEqual((await response.json())['reason'], 'frontend_context_unconfirmed')
        response = await self.client.post(path, json={**self.body, 'text': 'Changed'}, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.session.live_frontend.verified_reply.assert_awaited_once()

    async def test_missing_configuration_rejects_activation_without_fallback(self):
        self.service.env.pop('ELEVENLABS_API_KEY')
        self.session.activation = None
        response = await self.client.post(f'/sessions/{self.session.id}/activate', json={'callId': 'call'}, headers=self.headers)
        self.assertEqual(response.status, 503)
        self.session.say.assert_not_awaited()

    async def test_unknown_frontend_and_hot_switch_are_refused(self):
        self.service.backend.return_value = {**policy(), 'conversationFrontend': 'future_unknown'}
        response = await self.client.post(f'/sessions/{self.session.id}/activate', json={'callId': 'call'}, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.session.say.assert_not_awaited()

    async def test_authenticated_readiness_is_read_only_and_sanitized(self):
        with patch('elevenlabs_frontend.provider_get', new=AsyncMock(return_value=agent_config())) as get:
            response = await self.client.get('/voice/elevenlabs/readiness')
            self.assertEqual(response.status, 401)
            get.assert_not_awaited()
            response = await self.client.get('/voice/elevenlabs/readiness', headers=self.headers)
            self.assertEqual(await response.json(), {'configured': True, 'agentValidated': True, 'ready': True})
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(get.call_args.args[1], '/agents/agent_fixture')
            get.assert_awaited_once()

    async def test_readiness_missing_config_and_provider_drift_fail_before_any_session(self):
        with patch('elevenlabs_frontend.provider_get', new=AsyncMock()) as get:
            self.service.env.pop('ELEVENLABS_API_KEY')
            response = await self.client.get('/voice/elevenlabs/readiness', headers=self.headers)
            self.assertEqual(await response.json(), {'configured': False, 'agentValidated': False, 'ready': False})
            get.assert_not_awaited()
            self.service.env.update(env())
            config = agent_config(); config['platform_settings']['privacy']['retention_days'] = 30
            get.return_value = config
            response = await self.client.get('/voice/elevenlabs/readiness', headers=self.headers)
            self.assertEqual(await response.json(), {'configured': True, 'agentValidated': False, 'ready': False})
            get.side_effect = ValueError('sensitive provider payload must not escape')
            response = await self.client.get('/voice/elevenlabs/readiness', headers=self.headers)
            self.assertNotIn('sensitive', await response.text())
            self.session.say.assert_not_awaited()

    async def test_tool_ids_are_resolved_by_read_only_get_and_checked(self):
        config = agent_config()
        prompt = config['conversation_config']['agent']['prompt']
        tools = prompt.pop('tools'); prompt['tool_ids'] = ['tool_' + str(index) for index in range(7)]
        async def getter(path):
            if path.startswith('/agents/'): return config
            identity = path.split('/')[-1]
            return {'id': identity, 'tool_config': tools[int(identity.split('_')[-1])]}
        fake = AsyncMock(side_effect=getter)
        await validate_configured_agent(self.service, fake)
        self.assertEqual(fake.await_count, 8)
        self.assertTrue(all(call.args[0].startswith(('/agents/', '/tools/')) for call in fake.await_args_list))
        tools[0]['type'] = 'webhook'
        with self.assertRaises(ValueError): await validate_configured_agent(self.service, fake)


class LoopbackProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_handshake_refuses_redirect_without_contacting_destination(self):
        destination = Mock()
        async def redirect(request): raise web.HTTPFound('/other')
        async def other(request): destination(); return web.Response(text='unexpected')
        app = web.Application(); app.router.add_get('/socket', redirect); app.router.add_get('/other', other)
        server = TestServer(app); await server.start_server()
        frontend = ElevenLabsFrontend(SimpleNamespace(speaking=False))
        try:
            with self.assertRaises(ValueError): await frontend.open_socket(server.make_url('/socket'))
            destination.assert_not_called()
        finally:
            await frontend.close(); await server.close()

    async def test_handshake_does_not_retry_connection_reset(self):
        attempts = []
        async def reset(request):
            attempts.append(1); request.transport.abort(); return web.Response()
        app = web.Application(); app.router.add_get('/socket', reset)
        server = TestServer(app); await server.start_server()
        frontend = ElevenLabsFrontend(SimpleNamespace(speaking=False))
        try:
            with self.assertRaises(Exception): await frontend.open_socket(server.make_url('/socket'))
            self.assertEqual(attempts, [1])
        finally:
            await frontend.close(); await server.close()

    async def test_real_websocket_handshake_tool_and_close_without_reconnect(self):
        messages = []
        done = asyncio.Event()
        async def socket(request):
            ws = web.WebSocketResponse(); await ws.prepare(request)
            messages.append(await ws.receive_json())
            await ws.send_json(metadata())
            await ws.send_json(transcript())
            await ws.send_json({'type': 'client_tool_call', 'client_tool_call': {
                'tool_call_id': 'loopback_tool', 'tool_name': 'send_to_agent', 'parameters': {'text': 'Inspect the fixture and explain the result'}}})
            async for message in ws:
                value = json.loads(message.data); messages.append(value)
                if value.get('type') == 'client_tool_result': done.set()
            return ws
        app = web.Application(); app.router.add_get('/socket', socket)
        server = TestServer(app); await server.start_server()
        async with ClientSession() as http:
            calls = []
            async def backend(path, body=None):
                calls.append((path, body))
                return context() if body is None else {'accepted': True, 'reply': 'Queued; original agent has not executed.'}
            owner = SimpleNamespace(env=env(), backend=backend,
                http=SimpleNamespace(ws_connect=lambda *a, **kw: http.ws_connect(server.make_url('/socket'), **kw)))
            parent = SimpleNamespace(id='ct_' + 'd' * 40, owner=owner, active=True, allowed=True,
                closing=False, pause_latched=False, two_way=True, policy_at=time.monotonic(), call_id='call',
                speaking=False, audio=asyncio.Queue(), request_failure=Mock())
            frontend = ElevenLabsFrontend(parent)
            frontend.open_socket = lambda url: http.ws_connect(server.make_url('/socket'))
            frontend.provider_get = AsyncMock(side_effect=[agent_config(), {'signed_url': 'wss://api.elevenlabs.io/v1/convai/conversation?fixture=true'}])
            try:
                await frontend.start()
                await asyncio.wait_for(done.wait(), 2)
                self.assertEqual(messages[0]['type'], 'conversation_initiation_client_data')
                effects = [body for _, body in calls if body is not None]
                self.assertEqual(len(effects), 1)
                self.assertEqual(effects[0]['text'], transcript()['user_transcription_event']['user_transcript'])
                self.assertEqual(frontend.provider_get.await_count, 2)
                await frontend.ws.close()
                await asyncio.sleep(.02)
                parent.request_failure.assert_called_once()
                self.assertEqual(frontend.provider_get.await_count, 2)
            finally:
                await frontend.close()
        await server.close()


if __name__ == '__main__':
    unittest.main()
