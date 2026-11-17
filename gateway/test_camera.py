import unittest
import json
import time
import tempfile
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_execution_policy import ExecutionPolicyTests, lease
from service import validate_lease, Gateway

class CameraLeaseTests(unittest.TestCase):
    def test_explicit_v2_surface_binding_and_old_shape_compatibility(self):
        self.assertIsInstance(validate_lease(lease()),str)
        value={**lease(),'cameraVersion':1,'surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123}}
        self.assertIsInstance(validate_lease(value),str)
        for change in [{'cameraVersion':2},{'protocolVersion':3},{'surface':{'kind':'window','id':'99','displayId':1}},
            {'surface':{'kind':'display','id':'2','displayId':1}},{'surface':{'kind':'window','id':'99','displayId':2,'ownerPid':123}}]:
            with self.assertRaises(web.HTTPBadRequest):validate_lease({**value,**change})

class CameraCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=ExecutionPolicyTests.asyncSetUp
    asyncTearDown=ExecutionPolicyTests.asyncTearDown
    async def test_old_helper_cannot_silently_accept_selected_window(self):
        value={**lease(),'cameraVersion':1,'surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123}}
        result=await self.client.post('/v1/leases',json=value,headers=self.headers)
        self.assertEqual(result.status,409)
        self.assertNotIn('/v1/leases',self.received)


    async def test_window_fallback_rejects_before_receipt_or_helper_dispatch(self):
        selected={**lease(1,'clawdtime','control'),'cameraVersion':1,
            'surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123}}
        self.gateway.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,?,?)',
            ('lease','mac',json.dumps(selected),validate_lease(selected),'active','frame',time.time()))
        self.gateway.db.commit()
        for index,action in enumerate([{'type':'click','x':.5,'y':.5},{'type':'scroll','x':.5,'y':.5,'deltaY':10},{'type':'type','text':'fixture'}]):
            body={**action,'id':'denied'+str(index),'frameId':'frame','sessionId':'session','executorEpoch':1,'policyRevision':1}
            response=await self.client.post('/v1/leases/lease/actions',json=body,headers=self.headers)
            self.assertEqual(response.status,409)
        self.assertEqual(self.received,[])
        self.assertEqual(self.gateway.db.execute('SELECT count(*) FROM actions').fetchone()[0],0)
        self.assertEqual(self.gateway.lease('lease')[1],'active')

del ExecutionPolicyTests


class CameraFailureDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_fixed_error_categories_only_no_body_logging_or_retry(self):
        calls=0
        diagnostic={'X-ClawdTime-Capture-Error':'stream_start','X-ClawdTime-Capture-Code':'-3805'}
        async def helper(request):
            nonlocal calls
            calls+=1
            return web.Response(status=503,headers=diagnostic,text='PRIVATE native app/error detail')
        app=web.Application();app.router.add_get('/v1/leases/lease/frame',helper)
        server=TestServer(app);await server.start_server()
        with tempfile.TemporaryDirectory() as directory:
            gateway=Gateway({'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(directory)/'gateway.sqlite')},
                {'mac':{'url':str(server.make_url('')).rstrip('/'),'key':'h'*32}})
            client=TestClient(TestServer(gateway.app()));await client.start_server()
            try:
                selected={**lease(),'cameraVersion':1,'surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123}}
                gateway.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,?,?)',
                    ('lease','mac',json.dumps(selected),validate_lease(selected),'active','old-frame',time.time()))
                gateway.db.commit()
                with self.assertLogs(level='WARNING') as captured:
                    response=await client.get('/v1/leases/lease/frame',headers={'Authorization':'Bearer '+'g'*32})
                    self.assertEqual(response.status,503)
                    self.assertEqual(response.headers['X-ClawdTime-Capture-Error'],'stream_start')
                    self.assertEqual(response.headers['X-ClawdTime-Capture-Code'],'-3805')
                    self.assertNotIn('PRIVATE',await response.text())
                self.assertIn('reason=stream_start native_code=-3805',' '.join(captured.output))
                self.assertNotIn('PRIVATE',' '.join(captured.output))
                self.assertEqual(calls,1)
                self.assertIsNone(gateway.lease('lease')[2])
                diagnostic.update({'X-ClawdTime-Capture-Error':'PRIVATE','X-ClawdTime-Capture-Code':'secret'})
                with self.assertLogs(level='WARNING') as captured:
                    response=await client.get('/v1/leases/lease/frame',headers={'Authorization':'Bearer '+'g'*32})
                    self.assertEqual(response.status,503)
                    self.assertNotIn('X-ClawdTime-Capture-Error',response.headers)
                self.assertNotIn('PRIVATE',' '.join(captured.output))
            finally:
                await client.close();await server.close()
