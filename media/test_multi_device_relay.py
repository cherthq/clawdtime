import asyncio
import base64
import unittest

import test_service

GATEWAY = {'Authorization': 'Bearer ' + 'g' * 32}


class MultiDeviceRelayTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_service.ServiceTests.asyncSetUp
    asyncTearDown = test_service.ServiceTests.asyncTearDown

    async def connect(self, devices=None):
        self.service.env['DEVICE_GATEWAY_KEY'] = 'g' * 32
        headers = dict(GATEWAY)
        if devices is not None:
            headers['X-ClawdTime-Devices'] = devices
        return await self.client.ws_connect('/device-gateway', headers=headers)

    async def answer(self, socket, body=b'ok'):
        request = await socket.receive_json()
        await socket.send_json({'id': request['id'], 'status': 200, 'headers': {},
                                'body': base64.b64encode(body).decode()})
        return request

    async def test_two_macs_stay_connected_and_requests_route_by_device(self):
        ada = await self.connect('ada_mac')
        sam = await self.connect('sam_mac')
        relay = self.service.device_relay
        self.assertEqual(len(relay.live()), 2)
        self.assertTrue(relay.connected_for('ada_mac'))
        self.assertTrue(relay.connected_for('sam_mac'))
        self.assertFalse(relay.connected_for('unknown_mac'))

        task = asyncio.create_task(relay.request('GET', '/v1/devices/sam_mac/readiness'))
        request = await self.answer(sam, b'sam')
        self.assertEqual(request['path'], '/v1/devices/sam_mac/readiness')
        self.assertEqual((await task)[1], b'sam')

        task = asyncio.create_task(relay.request('POST', '/v1/leases', {'id': 'lease-a', 'deviceId': 'ada_mac'}))
        await self.answer(ada, b'created')
        await task
        # Lease paths carry no device; they follow the socket that created the lease.
        task = asyncio.create_task(relay.request('GET', '/v1/leases/lease-a/frame'))
        await self.answer(ada, b'frame-a')
        self.assertEqual((await task)[1], b'frame-a')

        task = asyncio.create_task(relay.request('GET', '/v1/leases/lease-s/frame', device='sam_mac'))
        await self.answer(sam, b'frame-s')
        self.assertEqual((await task)[1], b'frame-s')
        await ada.close()
        await sam.close()

    async def test_reconnect_for_same_device_replaces_stale_socket(self):
        first = await self.connect('sam_mac')
        relay = self.service.device_relay
        pending = asyncio.create_task(relay.request('GET', '/v1/devices/sam_mac/readiness'))
        await first.receive_json()
        # A plain GET cannot evict the live gateway.
        self.assertEqual((await self.client.get('/device-gateway', headers={**GATEWAY, 'X-ClawdTime-Devices': 'sam_mac'})).status, 400)
        self.assertTrue(relay.connected_for('sam_mac'))
        second = await self.connect('sam_mac')
        with self.assertRaises(ConnectionError):
            await pending  # never replayed on the new socket
        self.assertEqual(len(relay.live()), 1)
        task = asyncio.create_task(relay.request('GET', '/v1/devices/sam_mac/readiness'))
        await self.answer(second, b'new')
        self.assertEqual((await task)[1], b'new')
        await first.close()
        await second.close()

    async def test_partial_device_overlap_is_refused(self):
        both = await self.connect('ada_mac,sam_mac')
        self.assertEqual((await self.client.get('/device-gateway', headers={**GATEWAY, 'X-ClawdTime-Devices': 'sam_mac'})).status, 409)
        await both.close()

    async def test_legacy_gateway_coexists_and_serves_undeclared_devices(self):
        legacy = await self.connect()  # older gateway build, no declaration
        sam = await self.connect('sam_mac')
        relay = self.service.device_relay
        self.assertEqual((await self.client.get('/device-gateway', headers=GATEWAY)).status, 400)

        task = asyncio.create_task(relay.request('GET', '/v1/devices/ada_mac/readiness'))
        await self.answer(legacy, b'legacy')
        self.assertEqual((await task)[1], b'legacy')
        task = asyncio.create_task(relay.request('GET', '/v1/devices/sam_mac/readiness'))
        await self.answer(sam, b'sam')
        self.assertEqual((await task)[1], b'sam')
        await legacy.close()
        await sam.close()

    async def test_disconnect_of_one_mac_fails_only_its_requests(self):
        ada = await self.connect('ada_mac')
        sam = await self.connect('sam_mac')
        relay = self.service.device_relay
        task = asyncio.create_task(relay.request('POST', '/v1/leases', {'id': 'lease-s', 'deviceId': 'sam_mac'}))
        await sam.receive_json()
        await sam.close()
        with self.assertRaises(ConnectionError):
            await task
        for _ in range(50):
            if not relay.connected_for('sam_mac'):
                break
            await asyncio.sleep(.01)
        self.assertFalse(relay.connected_for('sam_mac'))
        self.assertTrue(relay.connected_for('ada_mac'))
        with self.assertRaises(ConnectionError):
            await relay.request('GET', '/v1/devices/sam_mac/readiness')
        self.assertEqual(relay.pending, {})
        await ada.close()

    async def test_invalid_device_declaration_is_rejected(self):
        self.service.env['DEVICE_GATEWAY_KEY'] = 'g' * 32
        response = await self.client.get('/device-gateway', headers={**GATEWAY, 'X-ClawdTime-Devices': 'bad device!'})
        self.assertEqual(response.status, 400)


if __name__ == '__main__':
    unittest.main()
