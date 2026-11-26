"""Real pinned OpenAI SDK with a synthetic local WebSocket provider."""
import asyncio
import json
import ssl
import unittest

from aiohttp import web, WSMsgType
from aiohttp.test_utils import TestServer
from conversational import sdk_readiness
from probe_live import probe, verified_tls_context


@unittest.skipUnless(sdk_readiness()['available'], 'optional pinned SDK not installed')
class ProbeLiveTests(unittest.IsolatedAsyncioTestCase):
    def test_real_tls_context_checks_certificate_and_hostname(self):
        context = verified_tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreater(len(context.get_ca_certs()), 0)

    async def fixture(self, mode):
        self.connections = 0
        self.messages = []
        self.disconnected = asyncio.Event()
        self.start_received = asyncio.Event()
        async def socket(request):
            self.connections += 1
            if mode == 'unauthorized':
                self.disconnected.set()
                return web.Response(status=401, text='synthetic-secret-must-not-escape')
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            try:
                async for message in ws:
                    if message.type != WSMsgType.TEXT:
                        continue
                    value = json.loads(message.data)
                    self.messages.append(value['type'])
                    if value['type'] == 'session.start':
                        self.assertEqual(value['session']['model'], 'gpt-live-1')
                        self.assertEqual(value['session']['delegation'], {'type': 'client'})
                        self.assertIs(value['session']['store'], False)
                        self.start_received.set()
                        if mode == 'error':
                            await ws.send_json({'type': 'error', 'error': {'message': 'synthetic-secret-must-not-escape',
                                'code': 'model_not_found', 'param': 'session.model', 'type': 'invalid_request_error'}})
                        elif mode != 'timeout':
                            await ws.send_json({'type': 'session.started', 'session': {'id': 'synthetic-secret-must-not-escape'}})
                            if mode == 'late_error':
                                await ws.send_json({'type': 'error', 'error': {
                                    'message': 'synthetic-secret-must-not-escape',
                                    'code': 'bad/code', 'param': 'bad param', 'type': 'invalid_request_error'}})
                    elif value['type'] == 'session.close' and mode != 'no_close_ack':
                        await ws.send_json({'type': 'session.closed', 'reason': 'close_requested'})
            finally:
                self.disconnected.set()
            return ws
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', socket)
        self.server = TestServer(app)
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        return str(self.server.make_url('')).rstrip('/')

    async def run_probe(self, mode, **kwargs):
        url = await self.fixture(mode)
        result = await probe('synthetic', _fixture_url=url, startup_timeout=.4, close_timeout=.15, **kwargs)
        await asyncio.wait_for(self.disconnected.wait(), 1)
        self.assertEqual(self.connections, 1)
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.assertTrue(set(self.messages).issubset({'session.start', 'session.close'}))
        self.assertLessEqual(self.messages.count('session.close'), 1)
        return result

    async def test_started_and_finalized_without_audio_or_work(self):
        result = await self.run_probe('success')
        self.assertTrue(result['ready_for_audio_test'])
        self.assertEqual(self.messages, ['session.start', 'session.close'])

    async def test_exact_acoustic_config_starts_and_closes_without_input_audio(self):
        result = await self.run_probe('success', audio_qualification=True)
        self.assertTrue(result['ready_for_audio_test'])
        self.assertTrue(result['audioQualificationConfig'])
        self.assertEqual(self.messages, ['session.start', 'session.close'])

    async def test_provider_error_sanitized_and_closed(self):
        result = await self.run_probe('error')
        self.assertEqual(result['status'], 'provider_error')
        self.assertEqual(result['error_code'], 'model_not_found')
        self.assertEqual(result['error_param'], 'session.model')
        self.assertFalse(result['ready_for_audio_test'])
        self.assertTrue(result['transport_closed'])

    async def test_startup_timeout_closes_once(self):
        result = await self.run_probe('timeout')
        self.assertEqual(result['status'], 'startup_timeout')
        self.assertEqual(result['failure_stage'], 'wait_session_started')
        self.assertIn('TimeoutError', result['error_types'])
        self.assertFalse(result['started'])
        self.assertTrue(result['finalized'])
        self.assertTrue(result['transport_closed'])

    async def test_missing_close_ack_is_unconfirmed_not_success(self):
        result = await self.run_probe('no_close_ack')
        self.assertTrue(result['started'])
        self.assertFalse(result['finalized'])
        self.assertFalse(result['ready_for_audio_test'])
        self.assertTrue(result['transport_closed'])

    async def test_error_during_finalization_blocks_success_and_strips_unsafe_identifiers(self):
        result = await self.run_probe('late_error')
        self.assertTrue(result['started'])
        self.assertTrue(result['finalized'])
        self.assertFalse(result['ready_for_audio_test'])
        self.assertEqual(result['status'], 'provider_error')
        self.assertNotIn('error_code', result)
        self.assertNotIn('error_param', result)

    async def test_auth_rejection_never_retries(self):
        result = await self.run_probe('unauthorized')
        self.assertFalse(result['started'])
        self.assertEqual(result['status'], 'connection_failed')
        self.assertEqual(result['http_status'], 401)
        self.assertEqual(result['failure_stage'], 'connect')
        self.assertIn('InvalidStatus', result['error_types'])

    async def test_cancellation_closes_transport_without_retry(self):
        url = await self.fixture('timeout')
        task = asyncio.create_task(probe('synthetic', _fixture_url=url, close_timeout=.15))
        await asyncio.wait_for(self.start_received.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(self.disconnected.wait(), 1)
        self.assertEqual(self.connections, 1)
        self.assertEqual(self.messages, ['session.start', 'session.close'])

    async def test_cannot_redirect_real_credential_to_fixture(self):
        with self.assertRaises(ValueError):
            await probe('not-synthetic', _fixture_url='http://127.0.0.1:1')
