import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from camera import CameraError, ScreenCamera
from camera_http import camera_request


class CameraHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.screen = SimpleNamespace(camera=Mock(), frame_lock=asyncio.Lock(), expire=Mock())
        app = web.Application()
        async def handle(request):
            return await camera_request(self.screen, request)
        app.router.add_route('*', '/camera', handle)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_known_rejections_keep_status_and_only_fixed_code(self):
        cases = (
            ('Invalid camera command', 400, 'camera_invalid_command'),
            ('Command identity reused', 409, 'camera_identity_conflict'),
            ('Fresh source frame required', 409, 'camera_frame_stale'),
            ('Source content changed; observe again', 409, 'camera_content_changed'),
            ('Presentation changed; observe again', 409, 'camera_presentation_changed'),
            ('Camera update rate exceeded', 429, 'camera_rate_limited'),
            ('Resume before changing paused camera', 409, 'camera_paused'),
            ('PRIVATE_TARGET_TITLE_AND_PROVIDER_BODY', 503, 'camera_rejected'),
            ('Fresh source frame required PRIVATE_TEXT', 409, 'camera_rejected'),
        )
        for message, status, code in cases:
            with self.subTest(code=code, message=message):
                self.screen.camera.command = Mock(side_effect=CameraError(message, status))
                response = await self.client.post('/camera', json={})
                self.assertEqual(response.status, status if status in (400, 409, 429) else 409)
                self.assertEqual(await response.json(), {'errorCode': code})
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.screen.camera.command.assert_called_once_with({})

    async def test_status_failure_uses_same_fixed_vocabulary(self):
        self.screen.camera.status.side_effect = CameraError('PRIVATE_BODY')
        response = await self.client.get('/camera')
        self.assertEqual(response.status, 409)
        self.assertEqual(await response.json(), {'errorCode': 'camera_rejected'})

    async def test_unnegotiated_camera_does_not_expire_or_command(self):
        for screen in (None, SimpleNamespace(camera=None)):
            self.screen = screen
            response = await self.client.post('/camera', json={})
            self.assertEqual(response.status, 409)
            self.assertEqual(await response.json(), {'errorCode': 'camera_not_negotiated'})
            self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_real_camera_clear_then_changed_frame_preserves_overview_rejection(self):
        selected = {'sessionId': 'session', 'deviceId': 'device', 'leaseId': 'lease',
                    'displayId': 1, 'surface': {'kind': 'display', 'id': '1', 'displayId': 1}}
        source = {'width': 100, 'height': 100, 'originX': 0, 'originY': 0,
                  'pointWidth': 100, 'pointHeight': 100, 'displayOriginX': 0, 'displayOriginY': 0,
                  'displayPointWidth': 100, 'displayPointHeight': 100}
        meta = {'version': 1, 'surface': selected['surface'], 'geometryGeneration': 'geometry',
                'contentRevision': 'content', 'source': source}
        image = Image.new('RGB', (100, 100))
        camera = ScreenCamera(selected, clock=lambda: 100, wall=lambda: 1000)
        self.screen.camera = camera
        camera.accept(image, 'frame1', 1000, meta)
        def command(op, identity):
            status = camera.status()
            return {'version': 1, 'commandId': identity, 'op': op, 'expectedRevision': status['revision'],
                    'sourceFrameId': status['sourceFrameId'], 'geometryGeneration': status['geometryGeneration']}
        response = await self.client.post('/camera', json=command('clear', 'clear'))
        self.assertEqual(response.status, 200)
        overview = command('overview', 'overview')
        camera.accept(image, 'frame2', 1000, meta)
        response = await self.client.post('/camera', json=overview)
        self.assertEqual(response.status, 409)
        self.assertEqual(await response.json(), {'errorCode': 'camera_presentation_changed'})
        self.assertNotIn('overview', camera.receipts)
        self.assertIn('clear', camera.receipts)


if __name__ == '__main__':
    unittest.main()
