import unittest
from aiohttp import web
from test_execution_policy import ExecutionPolicyTests, lease
from service import validate_lease

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

del ExecutionPolicyTests
