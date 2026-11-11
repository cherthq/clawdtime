"""New ClawdTime boundaries, separate from retained Apple Teams regressions."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from aiohttp.test_utils import TestClient, TestServer
from devices import ScreenController
from policy import pause_requested, validate_session_id
from server import Service


class AttentionMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.owner = Service({'MEDIA_DATABASE_PATH': str(Path(self.tmp.name) / 'media.sqlite'),
                              'MEDIA_API_KEY': 'm' * 32,
                              'DEVICE_GATEWAY_URL': 'http://127.0.0.1:4214',
                              'DEVICE_GATEWAY_KEY': 'g' * 32})
        self.sid = 'ct_' + 'a' * 40
        self.session = SimpleNamespace(id=self.sid, owner=self.owner, active=True,
            closing=False, closed=False, call_id='call_a', spec={'screen': True}, close=AsyncMock())
        self.screen = ScreenController(self.session)
        self.session.screen = self.screen
        self.owner.sessions[self.sid] = self.session
        self.policy = {'state': 'listening', 'callId': 'call_a',
            'expiresAt': (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat(),
            'screenSelection': {'leaseId': 'lease_a', 'deviceId': 'device_a', 'alias': 'Fixture',
                'memberId': 'member_a', 'callId': 'call_a', 'displayId': 1, 'mode': 'control',
                'expiresAt': (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()}}
        self.owner.backend = AsyncMock(return_value=self.policy)
        # Actual policy/lease transition logic runs; physical helper I/O is replaced.
        self.screen.poll = AsyncMock()
        self.screen.release = AsyncMock(return_value=True)
        self.client = TestClient(TestServer(self.owner.app()))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer ' + 'm' * 32}

    async def asyncTearDown(self):
        await self.screen.close()
        await self.client.close()
        self.tmp.cleanup()

    async def post(self, action, lease='lease_a'):
        return await self.client.post(f'/sessions/{self.sid}/screen/{action}',
            json={'leaseId': lease}, headers=self.headers)

    async def test_refresh_requires_exact_authorized_lease_and_active_call(self):
        self.assertEqual((await self.post('lease', 'wrong')).status, 409)
        self.assertIsNone(self.screen.selection)
        self.session.active = False
        self.assertEqual((await self.post('lease')).status, 409)
        self.session.active = True
        response = await self.post('lease')
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'accepted': True, 'leaseId': 'lease_a'})
        self.assertEqual(self.screen.selection['memberId'], 'member_a')

    async def test_stop_tombstones_lease_and_stale_policy_cannot_revive_it(self):
        self.assertEqual((await self.post('lease')).status, 200)
        self.screen.created.add('lease_a')
        self.assertEqual((await self.post('stop', 'wrong')).status, 409)
        response = await self.post('stop')
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())['released'])
        self.assertIsNone(self.screen.selection)
        self.assertIn('lease_a', self.screen.stopped)
        self.assertEqual((await self.post('lease')).status, 409)
        self.screen.release.assert_awaited_once()

    async def test_uncertain_release_blocks_confirmation_and_fresh_selection(self):
        await self.post('lease')
        self.screen.created.add('lease_a')
        self.screen.release.return_value = False
        self.assertEqual((await self.post('stop')).status, 503)
        self.assertGreater(self.screen.release_blocked_until, time.time())
        self.assertEqual((await self.post('stop')).status, 409)
        self.assertEqual((await self.post('lease')).status, 409)

    def test_independent_identity_and_explicit_stop_words(self):
        self.assertTrue(validate_session_id(self.sid))
        self.assertFalse(validate_session_id('at_' + 'a' * 40))
        self.assertTrue(pause_requested('Hey ClawdTime, stop listening.'))
        self.assertFalse(pause_requested('Hey Apple, stop notes.'))
        self.assertFalse(pause_requested('This screen says stop listening'))


if __name__ == '__main__':
    unittest.main()

class DeviceReadinessBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_media_requires_own_key_and_forwards_only_exact_readiness_path(self):
        from unittest.mock import patch
        from server import Service
        with tempfile.TemporaryDirectory() as folder:
            owner=Service({'MEDIA_DATABASE_PATH':str(Path(folder)/'media.sqlite'),'MEDIA_API_KEY':'m'*32,'DEVICE_GATEWAY_KEY':'g'*32})
            client=TestClient(TestServer(owner.app()));await client.start_server()
            try:
                path='/devices/device_fixture/readiness/member_fixture/1'
                self.assertEqual((await client.get(path,headers={'Authorization':'Bearer '+'g'*32})).status,401)
                body={'deviceId':'device_fixture','memberId':'member_fixture','displayId':'1','viewAllowed':False,'controlAllowed':False}
                import json
                with patch('server.gateway_request',AsyncMock(return_value=(200,json.dumps(body).encode(),{}))) as request:
                    response=await client.get(path,headers={'Authorization':'Bearer '+'m'*32})
                    self.assertEqual(await response.json(),body)
                    request.assert_awaited_once_with(owner,'GET','/v1/devices/device_fixture/readiness/member_fixture/1')
            finally:await client.close()
