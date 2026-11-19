import asyncio
import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from aiohttp import ClientSession, WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

from task_voice import (ElevenLabsProvider, PlaybackCoordinator, TaskVoiceAPI, VoiceDiagnostics,
                        TaskVoiceRuntime, VoiceError, bounded_context,
                        provider_configuration, validate_provider)
from task_voice_local import BrowserSink, local_app, private_json


def context():
    return {'voiceSessionId': 'voice_fixture', 'taskId': 'task_fixture', 'runId': 'run_one',
            'revision': 4, 'sequence': 4, 'goal': 'Synthetic task: add a filter',
            'state': 'needs_decision', 'summary': 'Fixture tests passed',
            'decision': 'Choose the empty state', 'opening': 'The filter is working. Choose the empty state.',
            'openingRunId': 'run_one', 'openingRevision': 4, 'active': True,
            'permissions': {'screen': False, 'presentation': False, 'control': False}}


def metadata():
    return {'type': 'conversation_initiation_metadata', 'conversation_initiation_metadata_event': {
        'conversation_id': 'conv_fixture', 'agent_output_audio_format': 'pcm_16000', 'user_input_audio_format': 'pcm_16000'}}


def transcript(text='Show an empty state with Clear filters', identity=1):
    event = {'user_transcript': text}
    if identity is not None:
        event['event_id'] = identity
    return {'type': 'user_transcript', 'user_transcription_event': event}


def audio(identity=1, pcm=bytes(3200)):
    return {'type': 'audio', 'audio_event': {'event_id': identity, 'audio_base_64': base64.b64encode(pcm).decode()}}


def normalized_provider():
    value = provider_configuration('voice_fixture')
    value['agent_id'] = 'agent_fixture'
    value['workflow'] = {'edges': {}, 'nodes': {'start_node': {'type': 'start',
        'position': {'x': 0, 'y': 0}, 'edge_order': [], 'parent_subgraph_id': None,
        'parent_frame_id': None}}, 'subgraphs': {}, 'frames': {}, 'prevent_subagent_loops': True, 'version': 1}
    value['procedures'] = []
    value['platform_settings']['workspace_overrides'] = {
        'conversation_initiation_client_data_webhook': None,
        'webhooks': {'post_call_webhook_id': None, 'events': ['transcript'],
                     'transcript_format': 'json', 'exclude_transcript': False, 'send_audio': False},
        'cloud_storage_export': {'destination_id': None, 'events': ['transcript'], 'transcript_format': 'json'}}
    for tool in value['conversation_config']['agent']['prompt']['tools']:
        tool.update(disable_interruptions=False, force_pre_tool_speech=False, assignments=[],
            tool_call_sound_behavior='auto', tool_error_handling_mode='auto',
            dynamic_variables={'dynamic_variable_placeholders': {}}, execution_mode='immediate')
        tool['parameters'].update(description='', dynamic_variable='', is_omitted=False)
    return value


class API:
    task_id = 'task_fixture'
    voice_id = 'voice_fixture'

    def __init__(self):
        self.value = context()
        self.calls = []
        self.failure = None
        self.instruction_gate = None

    async def context(self):
        return bounded_context(copy.deepcopy(self.value), self.task_id, self.voice_id)

    async def request(self, suffix, body=None):
        self.calls.append((suffix, body))
        if suffix == self.failure:
            raise VoiceError('synthetic_refusal')
        if suffix == '/utterances':
            return {'utteranceId': body['utteranceId'], 'replayed': False}
        if suffix == '/instructions':
            if self.instruction_gate:
                await self.instruction_gate.wait()
            return {'state': 'applied', 'taskId': self.task_id, 'runId': 'run_two'}
        return {'accepted': True}


class Sink:
    def __init__(self):
        self.frames = []
        self.clears = []

    async def play(self, pcm, epoch):
        self.frames.append((len(pcm), epoch))

    async def clear(self, epoch):
        self.clears.append(epoch)


class Socket:
    def __init__(self):
        self.sent = []
        self.closed = False

    async def send_json(self, value):
        self.sent.append(value)

    async def close(self):
        self.closed = True


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.api, self.sink, self.socket = API(), Sink(), Socket()
        self.provider = type('Provider', (), {'close': AsyncMock()})()
        self.now = 100.
        self.runtime = TaskVoiceRuntime(self.api, self.provider, self.sink, clock=lambda: self.now, poll_seconds=.01)
        self.runtime.ws = self.socket
        self.runtime.context = await self.api.context()
        await self.runtime.handle(metadata())

    async def asyncTearDown(self):
        await self.runtime.close()

    async def tool(self, name, identity='tool_one', params=None):
        self.runtime.pending_tools += 1
        await self.runtime.tool({'tool_name': name, 'tool_call_id': identity, 'parameters': {} if params is None else params}, self.runtime.latest)
        return self.socket.sent[-1]

    async def test_prepared_binding_and_finalized_instruction_are_distinct_from_playback(self):
        await self.runtime.handle(transcript())
        await self.runtime.handle({'type': 'interruption', 'interruption_event': {'event_id': 2}})
        result = await self.tool('submit_instruction')
        self.assertFalse(result['is_error'])
        self.assertEqual(self.api.calls[0], ('/bind', {'providerConversationId': 'conv_fixture'}))
        utterances = [body for path, body in self.api.calls if path == '/utterances']
        self.assertEqual(utterances[0]['text'], 'Show an empty state with Clear filters')
        instructions = [body for path, body in self.api.calls if path == '/instructions']
        self.assertEqual(instructions, [{'eventId': 'instruction_provider_1', 'utteranceId': 'provider_1'}])
        self.assertEqual(self.sink.clears, [1])

    async def test_duplicate_finals_and_model_tools_create_one_instruction(self):
        await self.runtime.handle(transcript())
        await self.runtime.handle(transcript())
        await self.tool('submit_instruction')
        await self.tool('submit_instruction')
        await self.tool('submit_instruction', 'tool_two')
        self.assertEqual(sum(path == '/utterances' for path, _ in self.api.calls), 1)
        self.assertEqual(sum(path == '/instructions' for path, _ in self.api.calls), 1)

    async def test_malformed_clarification_stays_unconfirmed_and_never_reposts(self):
        original = self.api.request
        invalid = {}
        async def request(path, body=None):
            result = await original(path, body)
            if path == '/instructions':
                return {'state': 'clarification_required', 'instructionSubmitted': False,
                    'question': 'Which choice?', 'options': ['A', 'B'], **invalid}
            return result
        self.api.request = request
        for index, invalid in enumerate(({'instructionSubmitted': True}, {'question': ' ' * 2000 + '?'},
                                        {'options': [' ' * 500 + 'A']}, {'options': ['A'] * 4})):
            with self.subTest(invalid=index):
                await self.runtime.handle(transcript('Yes. ' + str(index), identity=index + 1))
                result = await self.tool('submit_instruction', 'tool_' + str(index))
                self.assertTrue(result['is_error'])
                repeated = await self.tool('submit_instruction', 'repeat_' + str(index))
                self.assertTrue(repeated['is_error'])
                self.assertEqual(sum(path == '/instructions' for path, _ in self.api.calls), index + 1)

    async def test_no_id_transcripts_use_non_reconnectable_sequence_and_conservative_duplicate_suppression(self):
        await self.runtime.handle(transcript(identity=None))
        await self.runtime.handle(transcript(identity=None))
        await self.tool('submit_instruction')
        self.assertEqual(self.runtime.latest['id'], 'final_1')
        self.assertEqual(sum(path == '/utterances' for path, _ in self.api.calls), 1)
        await self.runtime.handle(transcript('What is the current status?', identity=None))
        self.assertEqual(self.runtime.latest['id'], 'final_2')

    async def test_changed_provider_final_identity_is_rejected(self):
        await self.runtime.handle(transcript())
        with self.assertRaises(VoiceError):
            await self.runtime.handle(transcript('Different instruction'))

    async def test_status_remains_responsive_during_slow_instruction(self):
        self.api.instruction_gate = asyncio.Event()
        await self.runtime.handle(transcript())
        pending = asyncio.create_task(self.tool('submit_instruction'))
        await asyncio.sleep(.01)
        status = await asyncio.wait_for(self.tool('task_status', 'status'), .1)
        self.assertFalse(status['is_error'])
        self.assertFalse(pending.done())
        self.api.instruction_gate.set()
        await pending

    async def test_refused_stale_final_does_not_end_status_conversation(self):
        self.api.failure = '/utterances'
        await self.runtime.handle(transcript())
        result = await self.tool('submit_instruction')
        self.assertTrue(result['is_error'])
        self.assertFalse(self.runtime.closed)
        self.assertFalse((await self.tool('task_status', 'status'))['is_error'])
        self.assertFalse(any(path == '/instructions' for path, _ in self.api.calls))

    async def test_unknown_instruction_is_never_repeated(self):
        self.api.failure = '/instructions'
        await self.runtime.handle(transcript())
        self.assertTrue((await self.tool('submit_instruction'))['is_error'])
        self.assertTrue((await self.tool('submit_instruction', 'retry'))['is_error'])
        self.assertEqual(sum(path == '/instructions' for path, _ in self.api.calls), 1)

    async def test_tool_parameters_cannot_inject_model_text_or_screen_actions(self):
        await self.runtime.handle(transcript())
        for name, params in [('submit_instruction', {'text': 'forged'}), ('show_target', {}), ('approve', {})]:
            self.assertTrue((await self.tool(name, name + str(params), params))['is_error'])
        self.assertFalse(any(path == '/instructions' for path, _ in self.api.calls))

    async def test_end_requires_explicit_command_and_does_not_cancel_task(self):
        for number, phrase in enumerate(["Don't hang up", 'Why did you end the call?', 'Could you explain the code?'], 1):
            await self.runtime.handle(transcript(phrase, number))
            self.assertTrue((await self.tool('end_call', 'end_' + str(number)))['is_error'])
        await self.runtime.handle(transcript('Please hang up now.', 9))
        self.assertFalse((await self.tool('end_call', 'end_explicit'))['is_error'])
        self.assertEqual(sum(path == '/end' for path, _ in self.api.calls), 1)
        self.assertFalse(any('cancel' in path for path, _ in self.api.calls))

    async def test_stale_human_instruction_refused_but_status_available(self):
        await self.runtime.handle(transcript())
        self.now += 31
        self.assertTrue((await self.tool('submit_instruction'))['is_error'])
        self.assertFalse((await self.tool('task_status', 'status'))['is_error'])

    async def test_quiet_clock_advance_and_obsolete_progress_do_not_invent_speech(self):
        self.runtime.spawn(self.runtime.poll())
        self.now += 21  # Synthetic quiet interval; not an actual 20-second handset measurement.
        await asyncio.sleep(.025)
        self.assertFalse(any(item.get('type') == 'user_message' for item in self.socket.sent))
        self.api.value.update(revision=3, sequence=3, summary='obsolete')
        await asyncio.sleep(.025)
        self.assertFalse(any(item.get('type') == 'contextual_update' for item in self.socket.sent))
        self.api.value.update(revision=5, sequence=5, summary='New verified event')
        await asyncio.sleep(.025)
        self.assertEqual(sum(item.get('type') == 'contextual_update' for item in self.socket.sent), 1)

    async def test_audio_interruption_is_once_only_and_stale_audio_cannot_return(self):
        self.runtime.spawn(self.runtime.playback.run())
        await self.runtime.handle(audio(1))
        await asyncio.wait_for(self.runtime.playback.first_output.wait(), .2)
        await self.runtime.handle({'type': 'interruption', 'interruption_event': {'event_id': 2}})
        await self.runtime.handle({'type': 'interruption', 'interruption_event': {'event_id': 2}})
        await self.runtime.handle(audio(1))
        await self.runtime.handle(audio(2))
        await self.runtime.handle(audio(3))
        await asyncio.sleep(.01)
        self.assertEqual(self.sink.clears, [1])
        self.assertEqual(self.sink.frames, [(3200, 0), (3200, 1)])

    async def test_input_and_output_are_bounded_pcm_only(self):
        await self.runtime.input_audio(bytes(3200))
        self.assertIn('user_audio_chunk', self.socket.sent[-1])
        for pcm in [b'x', bytes(3202), b'']:
            with self.assertRaises(VoiceError):
                await self.runtime.input_audio(pcm)
        with self.assertRaises(VoiceError):
            await self.runtime.handle({'type': 'audio', 'audio_event': {'event_id': 2, 'audio_base_64': 'invalid!'}})


class ConfigTests(unittest.TestCase):
    def test_template_is_offline_and_rejects_original_chat_or_unsafe_provider_config(self):
        original = provider_configuration('voice_fixture')
        self.assertEqual(validate_provider(original), 1200)
        self.assertTrue(all('additionalProperties' not in tool['parameters']
                            for tool in original['conversation_config']['agent']['prompt']['tools']))
        mutations = [
            lambda value: value['conversation_config']['conversation'].update(text_only=True),
            lambda value: value['conversation_config']['conversation'].pop('text_only'),
            lambda value: value['conversation_config']['agent']['prompt']['tools'][0].update(name='send_to_agent'),
            lambda value: value['platform_settings']['privacy'].update(record_voice=True),
            lambda value: value['platform_settings']['privacy'].update(retention_days=7),
            lambda value: value['conversation_config']['turn'].update(silence_end_call_timeout=20),
            lambda value: value['conversation_config']['turn'].update(turn_timeout=10),
            lambda value: value['conversation_config']['turn'].update(soft_timeout_config={'timeout_seconds': 2}),
            lambda value: value['conversation_config']['agent'].update(disable_first_message_interruptions=True),
            lambda value: value['conversation_config']['agent']['prompt']['tools'][0].update(interruption_mode='disable_during_tool'),
            lambda value: value['conversation_config']['agent']['prompt']['tools'][0].update(pre_tool_speech='force'),
            lambda value: value['conversation_config']['agent']['prompt']['tools'][0].update(tool_call_sound='typing'),
            lambda value: value['conversation_config']['conversation']['client_events'].remove('client_tool_call'),
            lambda value: value['conversation_config']['agent']['prompt'].update(mcp_server_ids=['remote']),
            lambda value: value['platform_settings']['overrides']['conversation_config_override']['agent'].update(first_message=False),
            lambda value: value['conversation_config']['agent'].update(subagent_config={'agents': [{'agent_id': 'other'}]}),
            lambda value: value['platform_settings'].update(workspace_overrides={'webhooks': {'post_call_webhook_id': 'hook'}}),
            lambda value: value['platform_settings'].update(workspace_overrides={'conversation_initiation_client_data_webhook': {'url': 'https://example.invalid'}}),
            lambda value: value['platform_settings'].update(data_collection={'field': {'type': 'string'}}),
        ]
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaises(VoiceError):
                validate_provider(value)

    def test_inert_provider_defaults_are_not_external_hooks(self):
        value = provider_configuration('voice_fixture')
        value['conversation_config']['agent']['subagent_config'] = {'agents': [], 'self_subagent': None}
        value['platform_settings'].update(workspace_overrides={
            'conversation_initiation_client_data_webhook': None,
            'webhooks': {'post_call_webhook_id': None, 'events': [], 'send_audio': False,
                         'transcript_format': 'json', 'exclude_transcript': False}},
            evaluation={'criteria': []}, analysis_items={'evaluation_criteria': [], 'data_collection': []})
        self.assertEqual(validate_provider(value), 1200)

    def test_diagnostics_only_accept_bounded_content_free_metadata(self):
        telemetry = VoiceDiagnostics(clock=lambda: 1.)
        for _ in range(600):
            telemetry.record('provider_audio')
        self.assertEqual(len(telemetry.snapshot()['events']), 512)
        self.assertEqual(telemetry.snapshot()['counts']['provider_audio'], 600)
        with self.assertRaises(VoiceError):
            telemetry.record('synthetic transcript content')
        with self.assertRaises(VoiceError):
            telemetry.record('browser_scheduled', duration_ms=float('nan'))
        with self.assertRaises(VoiceError):
            telemetry.record('browser_scheduled', duration_ms=-1)

    def test_provider_tls_uses_certifi_without_disabling_verification(self):
        import ssl
        provider = ElevenLabsProvider(None, 'synthetic', 'agent_fixture')
        self.assertEqual(provider.ssl_context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(provider.ssl_context.check_hostname)

    def test_context_refuses_identity_or_screen_authority(self):
        for update in [{'taskId': 'other'}, {'active': False}, {'permissions': {'screen': True, 'presentation': False, 'control': False}}]:
            with self.assertRaises(VoiceError):
                bounded_context({**context(), **update}, 'task_fixture', 'voice_fixture')

    def test_private_files_refuse_public_modes_symlinks_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private.json'
            path.write_text('{"synthetic":true}')
            path.chmod(0o600)
            self.assertEqual(private_json(path), {'synthetic': True})
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(VoiceError):
                private_json(link)
            path.chmod(0o644)
            with self.assertRaises(VoiceError):
                private_json(path)
            path.chmod(0o600)
            path.write_text('x' * 20000)
            with self.assertRaises(VoiceError):
                private_json(path)


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_referenced_tools_resolved_and_normalized_defaults_checked(self):
        config = normalized_provider()
        prompt = config['conversation_config']['agent']['prompt']
        prompt['tool_ids'] = ['tool_fixture_' + str(number) for number in range(3)]
        tool_lookup = {identity: {'id': identity, 'tool_config': copy.deepcopy(tool), 'response_mocks': []}
                       for identity, tool in zip(prompt['tool_ids'], prompt['tools'])}
        provider = ElevenLabsProvider(None, 'synthetic', 'agent_fixture')
        async def get(path):
            return copy.deepcopy(config if path.startswith('/agents/') else tool_lookup[path.split('/')[-1]])
        provider.get = AsyncMock(side_effect=get)
        self.assertEqual(await provider.readiness(), 1200)
        self.assertEqual(provider.get.await_count, 4)
        tool_lookup['tool_fixture_0']['tool_config']['execution_mode'] = 'async'
        with self.assertRaises(VoiceError):
            await provider.readiness()
        tool_lookup['tool_fixture_0']['tool_config']['execution_mode'] = 'immediate'
        tool_lookup['tool_fixture_0']['response_mocks'] = [{'synthetic': True}]
        with self.assertRaises(VoiceError):
            await provider.readiness()
        tool_lookup['tool_fixture_0']['response_mocks'] = []
        tool_lookup['tool_fixture_0']['id'] = 'wrong_identity'
        with self.assertRaises(VoiceError):
            await provider.readiness()

    async def test_normalized_workflow_cannot_hide_actions_or_external_destinations(self):
        config = normalized_provider()
        self.assertEqual(validate_provider(config), 1200)
        for mutate in [
            lambda value: value['workflow']['edges'].update(edge={'source': 'start_node'}),
            lambda value: value['workflow']['nodes']['start_node'].update(type='tool'),
            lambda value: value['platform_settings']['workspace_overrides']['cloud_storage_export'].update(destination_id='destination'),
            lambda value: value['platform_settings']['workspace_overrides']['webhooks'].update(post_call_webhook_id='webhook'),
        ]:
            changed = copy.deepcopy(config)
            mutate(changed)
            with self.assertRaises(VoiceError):
                validate_provider(changed)

    async def test_local_websocket_uses_prepared_first_message_pcm_and_task_api(self):
        api_calls, provider_messages = [], []
        peer_socket = None
        peer_ready = asyncio.Event()
        task_app = web.Application()
        async def task_endpoint(request):
            self.assertEqual(request.headers['Authorization'], 'Bearer ' + 's' * 40)
            suffix = request.match_info['operation']
            if suffix == 'context':
                return web.json_response(context())
            body = await request.json()
            api_calls.append((suffix, body))
            return web.json_response({'utteranceId': body.get('utteranceId'), 'state': 'applied'})
        task_app.router.add_route('*', '/tasks/task_fixture/voice/voice_fixture/{operation}', task_endpoint)
        task_server = TestServer(task_app)
        await task_server.start_server()
        peer_app = web.Application()
        async def provider_endpoint(request):
            nonlocal peer_socket
            peer_socket = web.WebSocketResponse()
            await peer_socket.prepare(request)
            peer_ready.set()
            async for message in peer_socket:
                value = json.loads(message.data)
                provider_messages.append(value)
                if value.get('type') == 'conversation_initiation_client_data':
                    await peer_socket.send_json(metadata())
                    await peer_socket.send_json(audio())
            return peer_socket
        peer_app.router.add_get('/provider', provider_endpoint)
        peer_server = TestServer(peer_app)
        await peer_server.start_server()
        runtime = None
        try:
            async with ClientSession() as http:
                api = TaskVoiceAPI(http, str(task_server.make_url('')).rstrip('/'), 'task_fixture', 'voice_fixture', 's' * 40)
                class Provider:
                    async def open(self):
                        return await http.ws_connect(peer_server.make_url('/provider'))
                    async def close(self):
                        pass
                sink = Sink()
                runtime = TaskVoiceRuntime(api, Provider(), sink, poll_seconds=.02)
                await runtime.start()
                await asyncio.wait_for(runtime.playback.first_output.wait(), 1)
                opening = provider_messages[0]['conversation_config_override']['agent']['first_message']
                self.assertEqual(opening, context()['opening'])
                await peer_socket.send_json(transcript())
                await peer_socket.send_json({'type': 'client_tool_call', 'client_tool_call': {'tool_call_id': 'change', 'tool_name': 'submit_instruction', 'parameters': {}}})
                for _ in range(100):
                    if any(path == 'instructions' for path, _ in api_calls):
                        break
                    await asyncio.sleep(.01)
                self.assertEqual(sum(path == 'instructions' for path, _ in api_calls), 1)
                self.assertEqual(sum(path == 'utterances' for path, _ in api_calls), 1)
                await runtime.input_audio(bytes(3200))
                await asyncio.sleep(.01)
                self.assertTrue(any('user_audio_chunk' in value for value in provider_messages))
                self.assertEqual(sink.frames, [(3200, 0)])
                await peer_socket.close()
                await asyncio.wait_for(runtime.ended.wait(), 1)
                self.assertTrue(runtime.closed)
                self.assertEqual(sum(path == 'end' for path, _ in api_calls), 1)
        finally:
            if runtime:
                await runtime.close()
            await peer_server.close()
            await task_server.close()

    async def test_browser_origin_and_private_capability_required_without_provider_access(self):
        app, url = local_app({}, {}, 3321)
        session_query = url.split('?', 1)[1]
        async with TestClient(TestServer(app)) as client:
            headers = {'Host': '127.0.0.1:3321'}
            self.assertEqual((await client.get('/?' + session_query, headers=headers)).status, 200)
            self.assertEqual((await client.get('/', headers=headers)).status, 403)
            self.assertEqual((await client.get('/?' + session_query, headers={**headers, 'Origin': 'https://untrusted.invalid'})).status, 403)
            self.assertEqual((await client.get('/?' + session_query, headers={'Host': 'untrusted.invalid'})).status, 403)
        html = Path(__file__).with_name('task_voice_local.html').read_text()
        self.assertNotIn('getDisplayMedia', html)
        self.assertIn('video:false', html)

    async def test_stale_opening_is_refused_before_provider_open(self):
        api = API()
        api.value['revision'] = 5
        provider = type('Provider', (), {'open': AsyncMock(), 'close': AsyncMock()})()
        runtime = TaskVoiceRuntime(api, provider, Sink())
        with self.assertRaises(VoiceError):
            await runtime.start()
        provider.open.assert_not_called()
        await runtime.close()

    async def test_playback_clear_unblocks_browser_backpressure_without_replaying_frames(self):
        socket = Socket()
        sink = BrowserSink(socket)
        waiting = asyncio.create_task(sink.play(bytes(3200), 0))
        await asyncio.sleep(0)
        await sink.clear(1)
        await waiting
        self.assertEqual([value['kind'] for value in socket.sent], ['audio', 'clear'])
        self.assertEqual(sink.pending, {})


if __name__ == '__main__':
    unittest.main()
