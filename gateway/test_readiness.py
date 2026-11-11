import json
from pathlib import Path
import tempfile
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from service import Gateway
from relay import PATH


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.paths=[];self.wrong=False
        async def helper(request):
            self.paths.append(request.path)
            self.assertEqual(request.method,'GET')
            self.assertEqual(request.headers['Authorization'],'Bearer '+'h'*32)
            if request.path=='/v1/status':return web.json_response({'deviceId':'foreign' if self.wrong else 'device_fixture','armed':False,'available':True,'screenPermission':False,'controlPermission':False,'secret':'MUST_NOT_FORWARD'})
            if request.path=='/v1/displays':return web.json_response([{'id':1,'width':100,'height':100}])
            if request.path=='/v1/permissions':return web.json_response([{'displayId':1,'viewers':['member_fixture'],'controllers':[]}])
            raise AssertionError('Readiness touched an effect route')
        app=web.Application();app.router.add_route('*','/{tail:.*}',helper)
        self.helper=TestServer(app);await self.helper.start_server()
        self.gateway=Gateway({'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(self.tmp.name)/'gateway.sqlite')},{'device_fixture':{'url':str(self.helper.make_url('')).rstrip('/'),'key':'h'*32}})
        self.client=TestClient(TestServer(self.gateway.app()));await self.client.start_server()
        self.headers={'Authorization':'Bearer '+'g'*32}

    async def asyncTearDown(self):
        await self.client.close();await self.helper.close();self.tmp.cleanup()

    async def test_readiness_is_authenticated_scoped_metadata_only(self):
        path='/v1/devices/device_fixture/readiness/member_fixture/1'
        self.assertEqual((await self.client.get(path)).status,401)
        response=await self.client.get(path,headers=self.headers);self.assertEqual(response.status,200)
        value=await response.json();self.assertTrue(value['viewAllowed']);self.assertFalse(value['controlAllowed'])
        self.assertEqual(value['memberId'],'member_fixture');self.assertEqual(value['displayId'],'1')
        self.assertEqual(self.paths,['/v1/status','/v1/displays','/v1/permissions'])
        self.assertNotIn('secret',value);self.assertNotIn('MUST_NOT_FORWARD',json.dumps(value))
        self.assertEqual(self.gateway.db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)
        other=await self.client.get('/v1/devices/device_fixture/readiness/other_member/1',headers=self.headers)
        self.assertFalse((await other.json())['viewAllowed'])

    async def test_wrong_device_and_malformed_scope_fail_closed(self):
        self.wrong=True
        self.assertEqual((await self.client.get('/v1/devices/device_fixture/readiness/member_fixture/1',headers=self.headers)).status,502)
        self.assertEqual((await self.client.get('/v1/devices/other/readiness/member_fixture/1',headers=self.headers)).status,404)
        self.assertFalse(PATH.fullmatch('/v1/devices/device_fixture/readiness/member_fixture/1?url=secret'))
        self.assertFalse(PATH.fullmatch('/v1/devices/device_fixture/arm'))
        self.assertTrue(PATH.fullmatch('/v1/devices/device_fixture/readiness/member_fixture/1'))
