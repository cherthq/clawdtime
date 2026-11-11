"""Real HTTP gateway/media frame path; only OS pixels and room publication are fixtures."""
import asyncio
from datetime import datetime, timedelta, timezone
import io
import ipaddress
from pathlib import Path
import sys
import ssl
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from server import Service
from devices import ScreenController
from captions import CaptionPublisher, CaptionScene
sys.path.append(str(Path(__file__).resolve().parents[1] / 'gateway'))
from service import Gateway
import relay as gateway_relay


class ScreenWireTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.received = []
        self.lease = None
        self.frames = 0
        self.fail_frames = False
        self.slow_frames = False
        self.frame_gate = None
        image = io.BytesIO()
        Image.new('RGB', (320, 180), '#8d17cb').save(image, 'JPEG')
        self.jpeg = image.getvalue()

        async def helper(request):
            self.assertEqual(request.headers.get('Authorization'), 'Bearer ' + 'h'*32)
            self.received.append((request.method, request.path))
            if request.method == 'POST' and request.path.endswith('/actions'):
                action=await request.json()
                return web.json_response({'id':action['id'],'leaseId':self.lease['id'],'state':'submitted',
                    **{key:self.lease[key] for key in ('deviceId','memberId','callId')}})
            if request.method == 'POST':
                self.lease = await request.json()
                self.assertEqual(set(self.lease), {'id','deviceId','memberId','callId','displayId','mode','expiresAt'})
                return web.json_response(self.lease)
            if request.method == 'DELETE':
                self.lease = None
                return web.json_response({'stopped': True})
            if request.path.endswith('/frame') and self.lease:
                if self.frame_gate: await self.frame_gate.wait()
                if self.slow_frames: await asyncio.sleep(1.7)
                if self.fail_frames:
                    raise web.HTTPForbidden()
                self.frames += 1
                return web.Response(body=self.jpeg, content_type='image/jpeg', headers={
                    'X-Frame-Id': f'frame-{self.frames}',
                    'X-Captured-At': datetime.now(timezone.utc).isoformat(),
                    'X-Frame-Width': '320', 'X-Frame-Height': '180'})
            raise web.HTTPNotFound()
        helper_app = web.Application()
        helper_app.router.add_route('*', '/v1/leases{tail:.*}', helper)
        self.helper_server = TestServer(helper_app)
        await self.helper_server.start_server()
        self.gateway = Gateway({'DEVICE_GATEWAY_KEY': 'g'*32,
            'DEVICE_GATEWAY_DATABASE_PATH': str(self.root/'gateway.sqlite')},
            devices={'fixture_mac': {'url': str(self.helper_server.make_url('/')).rstrip('/'), 'key': 'h'*32}})
        self.gateway_server = TestServer(self.gateway.app())
        await self.gateway_server.start_server()
        self.service = Service({'MEDIA_API_KEY': 'm'*32, 'MEDIA_DATABASE_PATH': str(self.root/'media.sqlite'),
            'DEVICE_GATEWAY_URL': str(self.gateway_server.make_url('/')).rstrip('/'),
            'DEVICE_GATEWAY_KEY': 'g'*32, 'MEDIA_DEVICES_ENABLED': 'true'})
        self.client = TestClient(TestServer(self.service.app()))
        await self.client.start_server()
        self.sid = 'ct_'+'9'*40
        expiry = (datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat()
        self.selection = {'leaseId':'view_fixture','deviceId':'fixture_mac','alias':'Fixture Mac','memberId':'fixture_member',
            'callId':self.sid,'displayId':1,'mode':'view','expiresAt':expiry}
        self.policy = {'callId':self.sid,'state':'listening','expiresAt':expiry,'screenSelection':self.selection}
        self.service.backend = AsyncMock(return_value=self.policy)
        session = SimpleNamespace(owner=self.service,id=self.sid,call_id=self.sid,active=True,closing=False,spec={'screen':True},caption_scene=None)
        self.screen = ScreenController(session)
        session.screen = self.screen
        session.close = self.screen.close
        self.service.sessions[self.sid] = session
        self.service.db.execute('INSERT INTO sessions VALUES(?,?,?)',(self.sid,'fixture','active'))
        self.service.db.commit()
        self.headers = {'Authorization': 'Bearer '+'m'*32}
        self.relay_task = None
        if getattr(self, 'outbound', False):
            await self.start_outbound()

    async def start_outbound(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, '127.0.0.1')])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .sign(key, hashes.SHA256()))
        cert_path, key_path = self.root/'cert.pem', self.root/'key.pem'
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_tls.load_cert_chain(cert_path, key_path)
        trusted = ssl.create_default_context(cafile=str(cert_path))
        relay_app = web.Application()
        async def connect(request):
            if request.headers.get('Authorization') != 'Bearer '+'g'*32:
                raise web.HTTPUnauthorized()
            return await self.service.device_relay.connect(request)
        relay_app.router.add_get('/device-gateway', connect)
        self.relay_server = TestServer(relay_app)
        await self.relay_server.start_server(ssl=server_tls)
        self.tls_patch = patch.object(gateway_relay, 'trusted_tls_context', return_value=trusted)
        self.tls_patch.start()
        gateway = Gateway({'DEVICE_GATEWAY_KEY':'g'*32, 'DEVICE_GATEWAY_DATABASE_PATH':str(self.root/'gateway-wss.sqlite')},
            devices={'fixture_mac':{'url':str(self.helper_server.make_url('/')).rstrip('/'), 'key':'h'*32}})
        endpoint = str(self.relay_server.make_url('/device-gateway')).replace('https://','wss://').replace('http://','wss://')
        self.relay_task = asyncio.create_task(gateway_relay.relay(gateway, endpoint))
        for _ in range(100):
            if self.service.device_relay.connected:
                break
            await asyncio.sleep(.01)
        self.assertTrue(self.service.device_relay.connected)
        self.service.env['DEVICE_GATEWAY_RELAY'] = 'true'
        self.screen.use_relay = True

    async def asyncTearDown(self):
        await self.screen.close()
        if self.relay_task:
            self.relay_task.cancel()
            await asyncio.gather(self.relay_task, return_exceptions=True)
            self.tls_patch.stop()
            await self.relay_server.close()
        await self.client.close()
        await self.gateway_server.close()
        await self.helper_server.close()
        self.tmp.cleanup()

    async def test_real_wire_path_paints_sdk_video_and_returns_bound_observation(self):
        response = await self.client.post(f'/sessions/{self.sid}/screen/lease', headers=self.headers, json={'leaseId':'view_fixture'})
        self.assertEqual(response.status, 200)
        for _ in range(100):
            if self.screen.frame is not None:
                break
            await asyncio.sleep(.01)
        self.assertIsNotNone(self.screen.frame)
        response = await self.client.get(f'/sessions/{self.sid}/screen/frame', headers=self.headers)
        self.assertEqual(response.status, 200)
        observed = await response.json()
        self.assertEqual(observed['state'], 'viewing')
        self.assertEqual(observed['leaseId'], 'view_fixture')
        self.assertEqual(observed['deviceId'], 'fixture_mac')
        self.assertEqual(observed['displayId'], 1)
        self.assertEqual((observed['width'], observed['height']), (320, 180))
        participant = SimpleNamespace(publish_track=AsyncMock(return_value=SimpleNamespace(sid='fixture_video')), unpublish_track=AsyncMock())
        publisher = CaptionPublisher(CaptionScene('fixture'), SimpleNamespace(local_participant=participant), screen=self.screen)
        await publisher.start()
        try:
            self.assertEqual((publisher.frame.width, publisher.frame.height), (1280, 720))
            pixel = self.screen.render().getpixel((640, 400))
            self.assertGreater(pixel[0], 100)
            self.assertGreater(pixel[2], 100)
            self.assertFalse(publisher.failed)
        finally:
            await publisher.close()
        response = await self.client.post(f'/sessions/{self.sid}/screen/stop', headers=self.headers, json={'leaseId':'view_fixture'})
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())['released'])
        self.assertIsNone(self.screen.frame)
        self.assertIsNone(self.lease)
        self.assertFalse(any('/actions' in path for _, path in self.received))
        await self.screen.close()
        self.service.sessions.pop(self.sid)
        self.service.db.execute("UPDATE sessions SET state='closed' WHERE id=?",(self.sid,))
        self.service.db.commit()
        response=await self.client.get(f'/sessions/{self.sid}',headers=self.headers)
        self.assertEqual(response.status,200)
        diagnostic=(await response.json())['screenDiagnostics']
        self.assertEqual(diagnostic['phase'],'closed')
        self.assertGreater(diagnostic['framesReceived'],0)
        self.assertTrue(diagnostic['screenVideoObserved'])
        self.assertIn('lastFrameAt',diagnostic)
        self.assertNotIn('jpegBase64',diagnostic)
        self.assertNotIn('frameId',diagnostic)
        self.assertEqual((await self.client.get(f'/sessions/{self.sid}')).status,401)

    async def test_helper_denial_stops_without_auto_reacquisition(self):
        self.fail_frames = True
        response = await self.client.post(f'/sessions/{self.sid}/screen/lease', headers=self.headers, json={'leaseId':'view_fixture'})
        self.assertEqual(response.status, 200)
        for _ in range(100):
            if 'view_fixture' in self.screen.stopped:
                break
            await asyncio.sleep(.01)
        self.assertIn('view_fixture', self.screen.stopped)
        self.assertIsNone(self.screen.frame)
        if self.screen.task: await asyncio.wait_for(asyncio.shield(self.screen.task),2)
        self.screen.update(self.policy)
        self.assertIsNone(self.screen.selection)
        posts = [p for method, p in self.received if method == 'POST' and p == '/v1/leases']
        self.assertEqual(len(posts), 1)
        self.service.backend.assert_any_await(f'/media/{self.sid}/screen-stopped', {'leaseId':'view_fixture','reason':'helper_stopped'})
        diagnostic=self.screen.diagnostics.data
        self.assertEqual(diagnostic['framesReceived'],0)
        self.assertEqual(diagnostic['lastGatewayFailure']['phase'],'frame_request')
        self.assertEqual(diagnostic['lastGatewayFailure']['httpStatus'],410)

    async def test_cold_capture_timeout_is_observable_without_retry(self):
        self.slow_frames=True
        response=await self.client.post(f'/sessions/{self.sid}/screen/lease',headers=self.headers,json={'leaseId':'view_fixture'})
        self.assertEqual(response.status,200)
        for _ in range(250):
            if 'view_fixture' in self.screen.stopped: break
            await asyncio.sleep(.01)
        self.assertIn('view_fixture',self.screen.stopped)
        diagnostic=self.screen.diagnostics.data
        self.assertEqual(diagnostic['framesReceived'],0)
        failure=diagnostic['lastGatewayFailure']
        self.assertEqual(failure['phase'],'frame_request')
        self.assertGreaterEqual(failure['durationMs'],1000)
        self.assertTrue(failure.get('httpStatus')==503 or failure.get('error')=='timeout')
        self.assertEqual(sum(1 for method,path in self.received if method=='GET' and path.endswith('/frame')),1)

    async def test_action_retains_video_but_requires_new_input_observation_without_recreate(self):
        self.selection['mode']='control'
        response=await self.client.post(f'/sessions/{self.sid}/screen/lease',headers=self.headers,json={'leaseId':'view_fixture'})
        self.assertEqual(response.status,200)
        for _ in range(100):
            if self.screen.frame_id:break
            await asyncio.sleep(.01)
        before=self.screen.frame_id
        response=await self.client.get(f'/sessions/{self.sid}/screen/frame',headers=self.headers)
        self.assertEqual(response.status,200)
        self.frame_gate=asyncio.Event()
        try:
            response=await self.client.post(f'/sessions/{self.sid}/screen/actions',headers=self.headers,json={
                'id':'action_fixture','leaseId':'view_fixture','callId':self.sid,'memberId':'fixture_member',
                'deviceId':'fixture_mac','displayId':1,'frameId':before,'type':'click','x':.5,'y':.5})
            self.assertEqual(response.status,200)
            self.assertEqual((await response.json())['state'],'submitted')
            self.assertIsNotNone(self.screen.frame)
            self.assertIsNone(self.screen.frame_id)
            self.assertEqual((await self.client.get(f'/sessions/{self.sid}/screen/frame',headers=self.headers)).status,409)
        finally:self.frame_gate.set()
        for _ in range(100):
            if self.screen.frame_id and self.screen.frame_id!=before:break
            await asyncio.sleep(.01)
        self.assertIsNotNone(self.screen.frame_id)
        self.assertNotEqual(self.screen.frame_id,before)
        self.assertEqual(self.screen.selection['leaseId'],'view_fixture')
        self.assertFalse(any(method=='DELETE' for method,_ in self.received))
        self.assertEqual(sum(1 for method,path in self.received if method=='POST' and path=='/v1/leases'),1)


class OutboundScreenWireTests(ScreenWireTests):
    outbound = True


if __name__ == '__main__':
    unittest.main()
