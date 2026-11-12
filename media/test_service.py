import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock
from livekit import api
from aiohttp.test_utils import TestClient,TestServer
from server import Service,Session


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.service=Service({'MEDIA_DATABASE_PATH':str(Path(self.tmp.name)/'media.sqlite'),'MEDIA_API_KEY':'m'*32})
        self.client=TestClient(TestServer(self.service.app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_public_health_and_authenticated_standby(self):
        r=await self.client.get('/health')
        self.assertEqual(await r.json(),{'ok':True,'service':'clawdtime-media','configured':False,'activeSessions':0,'deviceGatewayConnected':False,'devicesConfigured':False})
        r=await self.client.post('/sessions',json={})
        self.assertEqual(r.status,401)
        r=await self.client.post('/sessions',json={},headers={'Authorization':'Bearer '+'m'*32})
        self.assertEqual(r.status,503)
        self.assertEqual(self.service.db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)

    async def test_publisher_sends_only_silence_before_activation(self):
        session=Session(self.service,{'id':'ct_'+'a'*40,'meetingId':'m','lineId':'l'})
        frames=[]
        async def capture(frame):
            frames.append(bytes(frame.data))
            if len(frames)==3:
                session.closing=True
        session.source=AsyncMock()
        session.source.capture_frame=capture
        await session.publish()
        self.assertEqual(len(frames),3)
        self.assertTrue(all(frame==bytes(1920) for frame in frames))
        self.assertFalse(session.active)

    async def test_call_only_activation_uses_backend_policy_without_capture_notice(self):
        session=Session(self.service,{'id':'ct_'+'e'*40,'meetingId':'m','lineId':'l'})
        session.say=AsyncMock()
        self.service.sessions[session.id]=session
        self.service.backend=AsyncMock(return_value={
            'callOnly':True,'state':'paused','callId':'call','expiresAt':'2099-11-09T01:00:00Z'})
        headers={'Authorization':'Bearer '+'m'*32}
        response=await self.client.post(f'/sessions/{session.id}/activate',json={'callId':'other'},headers=headers)
        self.assertEqual(response.status,409)
        response=await self.client.post(f'/sessions/{session.id}/activate',json={'callId':'call'},headers=headers)
        self.assertEqual(response.status,200)
        self.assertTrue(session.active)
        self.assertFalse(session.recording)
        self.assertFalse(session.allowed)
        session.say.assert_not_awaited()
        # A later policy cannot silently upgrade the existing session to capture.
        self.service.backend.return_value={'state':'listening','callId':'call','expiresAt':'2099-11-09T01:00:00Z'}
        response=await self.client.post(f'/sessions/{session.id}/activate',json={'callId':'call'},headers=headers)
        self.assertEqual(response.status,409)
        session.say.assert_not_awaited()

    async def test_pause_closes_upstream_stt_and_clears_generation(self):
        session=Session(self.service,{'id':'ct_'+'b'*40,'meetingId':'m','lineId':'l'})
        ws,stream=AsyncMock(),AsyncMock()
        session.ws,session.stream=ws,stream
        await session.stop_stt()
        ws.close.assert_awaited_once();stream.aclose.assert_awaited_once()
        self.assertIsNone(session.stream)
        self.assertEqual(session.generation,1)

    async def test_interrupted_session_cannot_be_resurrected(self):
        self.service.db.execute('INSERT INTO sessions VALUES(?,?,?)',('ct_'+'c'*40,'fingerprint','prepared'))
        self.service.db.commit()
        second=Service(self.service.env)
        try:
            self.assertEqual(second.db.execute('SELECT state FROM sessions').fetchone()[0],'interrupted')
        finally:
            second.db.close()

    async def test_deleted_room_is_successful_cleanup(self):
        self.service.lk=AsyncMock()
        self.service.lk.room.delete_room.side_effect=api.TwirpError('not_found','gone',status=404)
        await self.service.delete_room('owned-room')
        self.service.lk.room.delete_room.side_effect=api.TwirpError('permission_denied','denied',status=403)
        with self.assertRaises(api.TwirpError):
            await self.service.delete_room('owned-room')

    async def test_capture_failure_notifies_backend_before_close(self):
        session=Session(self.service,{'id':'ct_'+'d'*40,'meetingId':'m','lineId':'l'})
        calls=[]
        async def backend(path,body):
            calls.append(path)
        async def close(reason):
            self.assertEqual(reason, 'failure')
            calls.append('close')
        self.service.backend=backend
        session.close=close
        await session.fail()
        self.assertEqual(calls,[f'/media/{session.id}/failure','close'])
        self.assertFalse(session.allowed)


if __name__=='__main__':
    unittest.main()
