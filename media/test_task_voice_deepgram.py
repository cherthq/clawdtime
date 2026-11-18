import asyncio
import copy
import json
import ssl
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import WSMsgType, ClientSession, web
from aiohttp.test_utils import TestServer
from task_voice import VoiceError
from task_voice_deepgram import (DeepgramProvider, DeepgramTaskVoiceRuntime,
                                AUTH_URL, MODELS_URL, SOCKET_URL, settings)
from test_task_voice import API, Sink


class Socket:
    def __init__(self):
        self.events = asyncio.Queue()
        self.sent = []
        self.binary = []
        self.closed = False

    def event(self, value):
        self.events.put_nowait(SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps(value)))

    def audio(self, value=b'\x01\x00' * 160):
        self.events.put_nowait(SimpleNamespace(type=WSMsgType.BINARY, data=value))

    async def send_json(self, value):
        self.sent.append(copy.deepcopy(value))
        if value['type'] == 'Settings':
            self.event({'type': 'SettingsApplied'})

    async def send_bytes(self, value):
        self.binary.append(value)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.events.get()

    async def close(self):
        self.closed = True


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.api, self.sink, self.ws = API(), Sink(), Socket()
        self.api.value['mode'] = 'handset_audio_smoke'
        self.api.value['permissions']['instructions'] = False
        self.provider = SimpleNamespace(open=AsyncMock(return_value=self.ws), close=AsyncMock())
        self.runtime = DeepgramTaskVoiceRuntime(self.api, self.provider, self.sink,
                                               poll_seconds=60, startup_seconds=.3)

    async def asyncTearDown(self):
        await self.runtime.close()

    async def start(self):
        self.ws.event({'type': 'Welcome', 'request_id': 'fixture_request'})
        await self.runtime.start()
        self.ws.audio()
        await asyncio.wait_for(self.runtime.playback.first_output.wait(), .2)

    async def drain(self):
        for _ in range(20):
            await asyncio.sleep(0)

    async def transcript(self, text):
        await self.runtime.handle({'type': 'ConversationText', 'role': 'user', 'content': text})
        await self.runtime.latest['receipt']

    async def call(self, name, identity='call_fixture', arguments='{}', **extra):
        await self.runtime.handle({'type': 'FunctionCallRequest', 'functions': [
            {'id': identity, 'name': name, 'arguments': arguments, 'client_side': True, **extra}]})
        await self.drain()

    async def test_exact_settings_bound_identity_and_binary_input(self):
        await self.start()
        self.assertIn(('/bind', {'providerConversationId': 'deepgram_fixture_request'}), self.api.calls)
        value = self.ws.sent[0]
        self.assertEqual(value, settings(self.api.value))
        self.assertTrue(value['mip_opt_out'])
        self.assertFalse(value['flags']['history'])
        self.assertEqual(value['agent']['greeting'], self.api.value['opening'])
        self.assertNotIn('think_live', value['agent'])
        functions = value['agent']['think']['functions']
        self.assertEqual([item['name'] for item in functions], ['task_status', 'end_call'])
        self.assertTrue(all(item['defer_until_eot'] and 'endpoint' not in item for item in functions))
        pcm = b'\x01\x00' * 160
        await self.runtime.input_audio(pcm)
        self.assertEqual(self.ws.binary, [pcm])
        self.assertFalse(any('conversation_initiation' in json.dumps(item) for item in self.ws.sent))

    async def test_no_settings_before_welcome_and_no_input_before_applied(self):
        with self.assertRaises(VoiceError):
            await self.runtime.input_audio(bytes(320))
        start = asyncio.create_task(self.runtime.start())
        await self.drain()
        self.assertEqual(self.ws.sent, [])
        self.ws.event({'type': 'Welcome', 'request_id': 'fixture_request'})
        await start

    async def test_status_without_transcript_and_instruction_refused(self):
        await self.start()
        await self.call('task_status')
        self.assertIn('needs_decision', self.ws.sent[-1]['content'])
        await self.call('submit_instruction', 'other')
        self.assertTrue(json.loads(self.ws.sent[-1]['content'])['is_error'])
        self.assertFalse(any(path == '/instructions' for path, _ in self.api.calls))

    async def test_end_exact_final_human_once_and_duplicate_ignored(self):
        await self.start()
        await self.transcript('Please hang up.')
        await self.call('end_call')
        await self.call('end_call')
        self.assertEqual(sum(path == '/end' for path, _ in self.api.calls), 1)
        self.assertEqual(sum(item['type'] == 'FunctionCallResponse' for item in self.ws.sent), 1)
        self.assertTrue(self.runtime.ended.is_set())

    async def test_end_before_current_transcript_cannot_use_previous_turn(self):
        await self.start()
        await self.transcript('hang up')
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        await self.call('end_call')
        self.assertFalse(any(path == '/end' for path, _ in self.api.calls))

    async def test_cancel_or_new_speech_during_receipt_prevents_end(self):
        await self.start()
        receipt = asyncio.Future()
        self.runtime.latest = {'id': 'held', 'text': 'hang up', 'at': self.runtime.clock(),
                               'generation': 0, 'receipt': receipt}
        await self.call('end_call')
        await self.runtime.handle({'type': 'FunctionCallCancelled', 'functions': [{'id': 'call_fixture', 'name': 'end_call'}]})
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        receipt.set_result({'utteranceId': 'held'})
        await self.drain()
        self.assertFalse(any(path == '/end' for path, _ in self.api.calls))
        self.assertFalse(any(item['type'] == 'FunctionCallResponse' for item in self.ws.sent))

    async def test_negation_forged_parameters_and_assistant_text_do_not_end(self):
        await self.start()
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'hang up'})
        await self.call('end_call', 'assistant')
        await self.transcript("Don't hang up")
        await self.call('end_call', 'negated')
        await self.transcript('hang up')
        await self.call('end_call', 'forged', '{"text":"hang up"}')
        self.assertFalse(any(path == '/end' for path, _ in self.api.calls))

    async def test_refused_transcript_does_not_break_status(self):
        await self.start()
        self.api.failure = '/utterances'
        await self.transcript('hang up')
        await self.call('end_call')
        await self.call('task_status', 'status')
        self.assertIsNone(self.runtime.failed)
        self.assertFalse(json.loads(self.ws.sent[-1]['content'])['is_error'])
        self.assertFalse(any(path == '/end' for path, _ in self.api.calls))

    async def test_interruption_discards_tail_until_next_agent_boundary(self):
        await self.start()
        await self.runtime.handle({'type': 'UserStartedSpeaking'})
        self.ws.audio()
        await self.drain()
        frames = len(self.sink.frames)
        self.assertEqual(frames, 1)
        await self.runtime.handle({'type': 'AgentStartedSpeaking'})
        self.ws.audio()
        await self.drain()
        self.assertEqual(len(self.sink.frames), frames)
        await self.runtime.handle({'type': 'ConversationText', 'role': 'assistant', 'content': 'Current task status.'})
        self.ws.audio()
        await self.drain()
        self.assertEqual(len(self.sink.frames), frames + 1)
        self.assertEqual(self.sink.clears, [1])

    async def test_startup_silence_times_out_and_closes_once(self):
        self.ws.event({'type': 'Welcome', 'request_id': 'fixture_request'})
        await self.runtime.start()
        await asyncio.wait_for(self.runtime.ended.wait(), 1)
        await self.runtime.close()
        self.assertEqual(self.runtime.failed, 'voice_runtime_failed')
        self.assertEqual(sum(path == '/end' for path, _ in self.api.calls), 1)
        self.assertTrue(self.ws.closed)

    async def test_scope_stale_opening_error_warning_and_bad_metadata_fail_closed(self):
        self.api.value['permissions']['instructions'] = True
        with self.assertRaises(VoiceError):
            await self.runtime.start()
        self.provider.open.assert_not_awaited()
        for value in ({'type': 'Error', 'description': 'private text'},
                      {'type': 'Warning', 'description': 'private text'},
                      {'type': 'SettingsApplied'}, {'type': 'Welcome', 'request_id': '../unsafe'}):
            with self.assertRaises(VoiceError):
                await self.runtime.handle(value)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_aiohttp_websocket_handshake_and_no_redirect_or_retry(self):
        counts = {'socket': 0, 'redirect': 0}
        mode = 'success'
        async def connect(request):
            counts['socket'] += 1
            if mode == 'redirect':
                return web.Response(status=307, headers={'Location': '/redirected'})
            if mode == 'fail':
                return web.Response(status=503)
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.send_json({'type': 'Welcome', 'request_id': 'localhost_fixture'})
            async for message in ws:
                if message.type == WSMsgType.BINARY:
                    await ws.send_bytes(message.data)
            return ws
        async def redirected(request):
            counts['redirect'] += 1
            return web.Response(status=500)
        app = web.Application()
        app.router.add_get('/v1/agent/converse', connect)
        app.router.add_get('/redirected', redirected)
        server = TestServer(app)
        await server.start_server()
        url = str(server.make_url('/v1/agent/converse')).replace('http:', 'ws:')
        try:
            # Only this test changes the fixed endpoint; production has no
            # configurable origin, insecure TLS option or endpoint parameter.
            with patch('task_voice_deepgram.SOCKET_URL', url):
                for value in ('success', 'redirect', 'fail'):
                    mode = value
                    provider = DeepgramProvider(None, 'synthetic_test_key_only')
                    provider.checked_at = provider.clock()
                    try:
                        if value == 'success':
                            ws = await provider.open()
                            self.assertEqual((await ws.receive_json())['request_id'], 'localhost_fixture')
                            await ws.send_bytes(bytes(320))
                            self.assertEqual((await ws.receive()).data, bytes(320))
                            await ws.close()
                        else:
                            with self.assertRaises(VoiceError):
                                await provider.open()
                    finally:
                        await provider.close()
            self.assertEqual(counts, {'socket': 3, 'redirect': 0})
        finally:
            await server.close()

    async def test_readiness_checks_fixed_gets_model_and_tls_without_socket(self):
        provider = DeepgramProvider(None, 'synthetic_test_key_only')
        provider.get = AsyncMock(side_effect=[{'key_id': 'synthetic'},
            {'models': [{'id': 'gpt-4o-mini', 'provider': 'open_ai'}]}])
        self.assertEqual(await provider.readiness(), 1200)
        self.assertEqual([call.args[0] for call in provider.get.await_args_list], [AUTH_URL, MODELS_URL])
        self.assertIsNone(provider.socket_http)
        self.assertTrue(provider.ssl_context.check_hostname)
        self.assertEqual(provider.ssl_context.verify_mode, ssl.CERT_REQUIRED)
        provider.get = AsyncMock(return_value={'models': []})
        with self.assertRaises(VoiceError):
            await provider.readiness()

    async def test_stale_preflight_and_second_open_refuse_before_network(self):
        provider = DeepgramProvider(None, 'synthetic_test_key_only')
        with self.assertRaisesRegex(VoiceError, 'preflight_stale'):
            await provider.open()
        with self.assertRaisesRegex(VoiceError, 'reconnect_refused'):
            await provider.open()

    async def test_socket_fixed_endpoint_no_redirect_or_retry(self):
        provider = DeepgramProvider(None, 'synthetic_test_key_only')
        provider.checked_at = provider.clock()
        response = SimpleNamespace(status=307, release=lambda: None)
        calls = []
        class HTTP:
            def __init__(self, **kwargs):
                self.middleware = kwargs['middlewares'][0]
            async def ws_connect(self, url, **kwargs):
                calls.append((url, kwargs))
                async def handler(request):
                    return response
                return await self.middleware(SimpleNamespace(url=url), handler)
            async def close(self):
                pass
        with patch('aiohttp.ClientSession', HTTP):
            with self.assertRaisesRegex(VoiceError, 'socket_unavailable'):
                await provider.open()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], SOCKET_URL)
        self.assertEqual(calls[0][1]['headers']['Authorization'], 'Token synthetic_test_key_only')


if __name__ == '__main__':
    unittest.main()
