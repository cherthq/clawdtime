"""Relay timing failures retain no request content and never retry the effect."""
import asyncio
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from device_relay import DeviceRelay, RelayTimeout, RelayDisconnected
from screen_diagnostics import ScreenDiagnostics


class RelayTimingTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_timeout_has_correlation_and_no_replay(self):
        relay=DeviceRelay()
        socket=SimpleNamespace(closed=False,send_json=AsyncMock())
        relay.socket=socket
        with self.assertRaises(RelayTimeout) as raised:
            await relay.request('POST','/v1/leases/private/actions',{'text':'private-screen-content'})
        self.assertIsInstance(raised.exception,TimeoutError)
        data=raised.exception.diagnostic
        self.assertEqual(data['phase'],'response')
        self.assertTrue(data['socketConnected'])
        self.assertEqual(data['requestId'],socket.send_json.call_args.args[0]['id'])
        self.assertEqual(socket.send_json.await_count,1)
        self.assertEqual(relay.pending,{})
        diagnostic=ScreenDiagnostics()
        diagnostic.request_result('frame_request',time.monotonic()-2,error='timeout',relay=data)
        stored=json.dumps(diagnostic.data)
        self.assertNotIn('private',stored)
        self.assertNotIn('text',stored)
        self.assertLess(len(stored),2048)

    async def test_send_timeout_is_distinct_from_response_timeout(self):
        relay=DeviceRelay()
        relay.socket=SimpleNamespace(closed=False,send_json=AsyncMock(side_effect=TimeoutError('secret')))
        with self.assertRaises(RelayTimeout) as raised:
            await relay.request('GET','/v1/leases/private/frame')
        self.assertEqual(raised.exception.diagnostic['phase'],'send')
        self.assertNotIn('secret',str(raised.exception))
        self.assertEqual(relay.pending,{})

    async def test_disconnect_keeps_connection_error_contract_and_stage(self):
        relay=DeviceRelay()
        relay.socket=SimpleNamespace(closed=False,send_json=AsyncMock(side_effect=ConnectionError('secret')))
        with self.assertRaises(RelayDisconnected) as raised:
            await relay.request('DELETE','/v1/leases/private')
        self.assertIsInstance(raised.exception,ConnectionError)
        self.assertEqual(raised.exception.diagnostic['phase'],'send')
        self.assertEqual(relay.pending,{})

    async def test_diagnostic_rejects_payload_and_hostile_correlation(self):
        diagnostic=ScreenDiagnostics()
        base={'requestId':'a'*32,'phase':'response','startedAt':'2026-11-12T01:08:00+00:00',
            'sendDurationMs':1,'socketConnected':True}
        for data in ({**base,'body':'secret'},{**base,'requestId':'secret\nvalue'},
                {**base,'phase':'secret'},{**base,'sendDurationMs':True}):
            with self.assertRaises(ValueError):
                diagnostic.request_result('frame_request',time.monotonic(),error='timeout',relay=data)
