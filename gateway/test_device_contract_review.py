"""Independent boundary tests: no real helper, captures or input."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import unittest
from aiohttp import web
from aiohttp.test_utils import TestServer
import test_gateway
from service import MAX_FRAME

class ContractReviewTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_gateway.GatewayTests.asyncSetUp
    asyncTearDown = test_gateway.GatewayTests.asyncTearDown
    create = test_gateway.GatewayTests.create

    async def test_foreign_receipt_stays_unknown_and_never_reposts(self):
        await self.create()
        await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)
        original = self.gateway.helper
        async def corrupt(body,method,suffix,payload=None,frame=False):
            raw,headers = await original(body,method,suffix,payload,frame)
            if '/actions' in suffix:
                receipt=json.loads(raw);receipt['callId']='foreign'
                raw=json.dumps(receipt).encode()
            return raw,headers
        self.gateway.helper=corrupt
        action={'id':'input-owned','frameId':'frame-1','type':'click','x':.2,'y':.3}
        self.assertEqual((await self.client.post('/v1/leases/lease-1/actions',json=action,headers=self.headers)).status,503)
        result=await self.client.post('/v1/leases/lease-1/actions',json=action,headers=self.headers)
        self.assertEqual((await result.json())['state'],'unknown')
        self.assertEqual(self.inputs,1)

    async def test_action_id_cannot_cross_leases(self):
        await self.create()
        await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)
        action={'id':'input-owned','frameId':'frame-1','type':'click','x':.2,'y':.3}
        self.assertEqual((await self.client.post('/v1/leases/lease-1/actions',json=action,headers=self.headers)).status,200)
        await self.client.delete('/v1/leases/lease-1',headers=self.headers)
        self.assertEqual((await self.client.post('/v1/leases',json={**self.lease,'id':'lease-2'},headers=self.headers)).status,200)
        await self.client.get('/v1/leases/lease-2/frame',headers=self.headers)
        self.assertEqual((await self.client.post('/v1/leases/lease-2/actions',json=action,headers=self.headers)).status,409)
        self.assertEqual((await self.client.get('/v1/leases/lease-2/actions/input-owned',headers=self.headers)).status,404)
        self.assertEqual(self.inputs,1)

    async def test_late_frame_cannot_survive_stop_during_fetch(self):
        await self.create()
        entered,release=asyncio.Event(),asyncio.Event()
        original=self.gateway.helper
        async def delayed(body,method,suffix,payload=None,frame=False):
            raw,headers=await original(body,method,suffix,payload,frame)
            if frame:
                entered.set();await release.wait()
            return raw,headers
        self.gateway.helper=delayed
        task=asyncio.create_task(self.client.get('/v1/leases/lease-1/frame',headers=self.headers))
        await asyncio.wait_for(entered.wait(),1)
        self.gateway.stop('lease-1');release.set()
        self.assertEqual((await task).status,410)
        self.assertIsNone(self.gateway.lease('lease-1')[2])

    async def test_oversized_frame_never_authorizes_input(self):
        await self.create()
        self.jpeg=b'\xff\xd8'+b'x'*MAX_FRAME
        self.assertEqual((await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)).status,502)
        self.assertIsNone(self.gateway.lease('lease-1')[2])
        action={'id':'input','frameId':'frame-1','type':'click','x':.2,'y':.3}
        self.assertEqual((await self.client.post('/v1/leases/lease-1/actions',json=action,headers=self.headers)).status,409)
        self.assertEqual(self.inputs,0)

    async def test_future_and_stale_frames_never_authorize_input(self):
        await self.create()
        original=self.gateway.helper
        for offset in (-3,2):
            async def invalid_time(body,method,suffix,payload=None,frame=False):
                raw,headers=await original(body,method,suffix,payload,frame)
                headers['X-Captured-At']=(datetime.now(timezone.utc)+timedelta(seconds=offset)).isoformat()
                return raw,headers
            self.gateway.helper=invalid_time
            self.assertEqual((await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)).status,502)
            self.assertIsNone(self.gateway.lease('lease-1')[2])
        self.assertEqual(self.inputs,0)

    async def test_redirect_never_forwards_helper_secret(self):
        followed=[]
        async def destination(request):
            followed.append(request.headers.get('Authorization'));return web.json_response({'ok':True})
        target_app=web.Application();target_app.router.add_route('*','/{tail:.*}',destination)
        target=TestServer(target_app);await target.start_server()
        async def redirect(request):raise web.HTTPFound(str(target.make_url('/v1/leases')))
        source_app=web.Application();source_app.router.add_route('*','/{tail:.*}',redirect)
        source=TestServer(source_app);await source.start_server()
        try:
            self.gateway.devices['mac-test']['url']=str(source.make_url('')).rstrip('/')
            self.assertEqual((await self.client.post('/v1/leases',json=self.lease,headers=self.headers)).status,503)
            self.assertEqual(followed,[])
            self.assertEqual(self.gateway.lease('lease-1')[1],'creating_unknown')
        finally:
            await source.close();await target.close()

    async def test_failed_refresh_invalidates_previous_frame_authorization(self):
        await self.create()
        self.assertEqual((await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)).status,200)
        self.assertEqual(self.gateway.lease('lease-1')[2],'frame-1')
        self.jpeg=b'\xff\xd8'+b'x'*MAX_FRAME
        self.assertEqual((await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)).status,502)
        self.assertIsNone(self.gateway.lease('lease-1')[2])
