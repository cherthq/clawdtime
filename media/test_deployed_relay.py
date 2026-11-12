"""Preserve already-deployed device routing while releasing speech/caption updates."""
import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock, AsyncMock
from aiohttp import web, ClientSession, WSServerHandshakeError
from aiohttp.test_utils import TestServer
from device_relay import DeviceRelay
from devices import gateway_request

class DeployedRelayTests(IsolatedAsyncioTestCase):
    async def test_two_declared_gateways_route_and_reject_duplicate_device(self):
        relay=DeviceRelay()
        app=web.Application();app.router.add_get('/relay',relay.connect)
        server=TestServer(app);await server.start_server()
        async with ClientSession() as client:
            sockets=[]
            try:
                for device in ['fixture_a','fixture_b']:
                    sockets.append(await client.ws_connect(server.make_url('/relay'),headers={'X-ClawdTime-Devices':device}))
                with self.assertRaises(WSServerHandshakeError) as refused:
                    await client.ws_connect(server.make_url('/relay'),headers={'X-ClawdTime-Devices':'fixture_a'})
                self.assertEqual(refused.exception.status,409)
                for i,device in enumerate(['fixture_a','fixture_b']):
                    task=asyncio.create_task(relay.request('GET',f'/v1/devices/{device}/readiness'))
                    request=await asyncio.wait_for(sockets[i].receive_json(),1)
                    await sockets[i].send_json({'id':request['id'],'status':200,'body':'e30=','headers':{}})
                    status,body,_=await task
                    self.assertEqual((status,body),(200,b'{}'))
                self.assertIsNone(relay.route(device='unclaimed'))
                self.assertIsNone(relay.route('/v1/leases/unowned/frame'))
            finally:
                for socket in sockets:await socket.close()
                await relay.close()
        await server.close()

    async def test_legacy_single_gateway_and_explicit_release_device_are_preserved(self):
        relay=DeviceRelay();socket=Mock(closed=False);relay.socket=socket
        self.assertIs(relay.route(device='fixture_a'),socket)
        owner=SimpleNamespace(env={'DEVICE_GATEWAY_RELAY':'true'},device_relay=SimpleNamespace(request=AsyncMock(return_value=(200,b'{}',{}))))
        await gateway_request(owner,'DELETE','/v1/leases/old',device='fixture_a')
        owner.device_relay.request.assert_awaited_once_with('DELETE','/v1/leases/old',None,device='fixture_a')
