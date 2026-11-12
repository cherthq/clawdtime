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
        gary = await self.connect('gary_mac')
        stanley = await self.connect('stanley_mac')
        relay = self.service.device_relay
        self.assertEqual(len(relay.live()), 2)
        self.assertTrue(relay.connected_for('gary_mac'))
        self.assertTrue(relay.connected_for('stanley_mac'))
        self.assertFalse(relay.connected_for('unknown_mac'))

        task = asyncio.create_task(relay.request('GET', '/v1/devices/stanley_mac/readiness'))
        request = await self.answer(stanley, b'stanley')
        self.assertEqual(request['path'], '/v1/devices/stanley_mac/readiness')
        self.assertEqual((await task)[1], b'stanley')

        task = asyncio.create_task(relay.request('POST', '/v1/leases', {'id': 'lease-g', 'deviceId': 'gary_mac'}))
        await self.answer(gary, b'created')
        await task
        # Lease paths carry no device; they follow the socket that created the lease.
        task = asyncio.create_task(relay.request('GET', '/v1/leases/lease-g/frame'))
        await self.answer(gary, b'frame-g')
        self.assertEqual((await task)[1], b'frame-g')

        task = asyncio.create_task(relay.request('GET', '/v1/leases/lease-s/frame', device='stanley_mac'))
        await self.answer(stanley, b'frame-s')
        self.assertEqual((await task)[1], b'frame-s')
        await gary.close()
        await stanley.close()

    async def test_same_device_twice_is_refused(self):
        first = await self.connect('stanley_mac')
        self.assertEqual((await self.client.get('/device-gateway', headers={**GATEWAY, 'X-ClawdTime-Devices': 'stanley_mac'})).status, 409)
        await first.close()

    async def test_legacy_gateway_coexists_and_serves_undeclared_devices(self):
        legacy = await self.connect()  # older gateway build, no declaration
        stanley = await self.connect('stanley_mac')
        relay = self.service.device_relay
        self.assertEqual((await self.client.get('/device-gateway', headers=GATEWAY)).status, 409)

        task = asyncio.create_task(relay.request('GET', '/v1/devices/gary_mac/readiness'))
        await self.answer(legacy, b'legacy')
        self.assertEqual((await task)[1], b'legacy')
        task = asyncio.create_task(relay.request('GET', '/v1/devices/stanley_mac/readiness'))
        await self.answer(stanley, b'stanley')
        self.assertEqual((await task)[1], b'stanley')
        await legacy.close()
        await stanley.close()

    async def test_disconnect_of_one_mac_fails_only_its_requests(self):
        gary = await self.connect('gary_mac')
        stanley = await self.connect('stanley_mac')
        relay = self.service.device_relay
        task = asyncio.create_task(relay.request('POST', '/v1/leases', {'id': 'lease-s', 'deviceId': 'stanley_mac'}))
        await stanley.receive_json()
        await stanley.close()
        with self.assertRaises(ConnectionError):
            await task
        for _ in range(50):
            if not relay.connected_for('stanley_mac'):
                break
            await asyncio.sleep(.01)
        self.assertFalse(relay.connected_for('stanley_mac'))
        self.assertTrue(relay.connected_for('gary_mac'))
        with self.assertRaises(ConnectionError):
            await relay.request('GET', '/v1/devices/stanley_mac/readiness')
        self.assertEqual(relay.pending, {})
        await gary.close()

    async def test_invalid_device_declaration_is_rejected(self):
        self.service.env['DEVICE_GATEWAY_KEY'] = 'g' * 32
        response = await self.client.get('/device-gateway', headers={**GATEWAY, 'X-ClawdTime-Devices': 'bad device!'})
        self.assertEqual(response.status, 400)


if __name__ == '__main__':
    unittest.main()
