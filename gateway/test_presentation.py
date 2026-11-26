import copy
import json
import time
import unittest
from aiohttp import web
from service import validate_presentation_resolve
from relay import PATH
from test_execution_policy import lease


def request():
    return {'version':1,'window':{'appId':'com.apple.finder','windowId':'77','ownerPid':42,'displayId':1},
        'expected':{'requestId':'request','sessionId':'session','leaseId':'lease','epoch':0,'cursor':0,'policyRevision':1,'displayId':1},
        'expiresAt':time.time()*1000+1500}


class PresentationPolicyTests(unittest.TestCase):
    def setUp(self):self.lease={**lease(),'cameraVersion':1,'surface':{'kind':'display','id':'1','displayId':1}}
    def test_exact_current_view_only_lease(self):
        validate_presentation_resolve(request(),self.lease)
        for changes in ({'executor':'native'},{'executor':'clawdtime'},{'mode':'control'},{'executorEpoch':1},
                {'sessionId':'other'},{'displayId':2},{'policyRevision':2},{'cameraVersion':None},
                {'surface':{'kind':'window','id':'77','displayId':1,'ownerPid':42}}):
            with self.subTest(changes=changes),self.assertRaises(web.HTTPConflict):validate_presentation_resolve(request(),{**self.lease,**changes})
    def test_no_input_fields_or_unbounded_identity_or_expiry(self):
        for extra in ('op','effect','targetToken','script','text'):
            with self.assertRaises(web.HTTPBadRequest):validate_presentation_resolve({**request(),extra:'activate'},self.lease)
        for expiry in (time.time()*1000-1,time.time()*1000+3000,float('nan'),True):
            with self.assertRaises(web.HTTPConflict):validate_presentation_resolve({**request(),'expiresAt':expiry},self.lease)
        for identity in ('pid42',None,'x'*65):
            with self.assertRaises(web.HTTPBadRequest):validate_presentation_resolve({**request(),'processIdentity':identity},self.lease)
        value=request();value['window']['appId']='com.openai.codex'
        with self.assertRaises(web.HTTPBadRequest):validate_presentation_resolve(value,self.lease)
    def test_only_fixed_resolver_path_in_relay(self):
        self.assertTrue(PATH.fullmatch('/v1/leases/lease/presentation/resolve'))
        for path in ('activate','raise','resolve/extra','resolve?url=secret','input'):
            self.assertFalse(PATH.fullmatch('/v1/leases/lease/presentation/'+path))

class PresentationRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile
        from pathlib import Path
        from aiohttp.test_utils import TestClient, TestServer
        from service import Gateway, validate_lease
        self.tmp=tempfile.TemporaryDirectory();self.calls=[];self.mode='ok'
        async def helper(req):
            self.calls.append((req.method,req.path));self.assertEqual(req.headers['Authorization'],'Bearer '+'h'*32)
            value=await req.json()
            if self.mode=='refuse':return web.json_response({'error':'PRIVATE TITLE'},status=409)
            if self.mode=='stop':self.gateway.stop('lease')
            result={'window':value['window'],'observedAt':time.time()*1000,'processIdentity':'a'*64,
                'windowBounds':{'x':0,'y':0,'width':100,'height':100},'appActive':True,'windowFocused':True,'windowOnScreen':True}
            if self.mode=='extra':result['windowBounds']['title']='PRIVATE TITLE'
            return web.json_response(result)
        app=web.Application();app.router.add_post('/v1/leases/lease/presentation/resolve',helper)
        self.helper=TestServer(app);await self.helper.start_server()
        self.gateway=Gateway({'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(self.tmp.name)/'test.sqlite')},
            {'mac':{'url':str(self.helper.make_url('')).rstrip('/'),'key':'h'*32}})
        self.client=TestClient(TestServer(self.gateway.app()));await self.client.start_server()
        selected={**lease(),'cameraVersion':1,'surface':{'kind':'display','id':'1','displayId':1}}
        self.gateway.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,?,?)',('lease','mac',json.dumps(selected),validate_lease(selected),'active','frame',time.time()));self.gateway.db.commit()
        self.headers={'Authorization':'Bearer '+'g'*32};self.path='/v1/leases/lease/presentation/resolve'
    async def asyncTearDown(self):await self.client.close();await self.helper.close();self.tmp.cleanup()
    async def test_auth_metadata_only_and_no_capture_or_action_mutation(self):
        self.assertEqual((await self.client.post(self.path,json=request())).status,401)
        response=await self.client.post(self.path,json=request(),headers=self.headers)
        self.assertEqual(response.status,200);self.assertEqual((await response.json())['processIdentity'],'a'*64)
        self.assertEqual(self.calls,[('POST',self.path)])
        self.assertEqual(self.gateway.lease('lease')[2],'frame')
        self.assertEqual(self.gateway.db.execute('SELECT COUNT(*) FROM actions').fetchone()[0],0)
    async def test_refusal_does_not_stop_capture_and_private_details_not_forwarded(self):
        self.mode='refuse';response=await self.client.post(self.path,json=request(),headers=self.headers)
        self.assertEqual(response.status,409);self.assertNotIn('PRIVATE',await response.text());self.assertEqual(self.gateway.lease('lease')[1],'active')
        self.mode='extra';response=await self.client.post(self.path,json=request(),headers=self.headers)
        self.assertEqual(response.status,502);self.assertNotIn('PRIVATE',await response.text())
    async def test_stop_during_read_rejects_late_observation(self):
        self.mode='stop';response=await self.client.post(self.path,json=request(),headers=self.headers)
        self.assertEqual(response.status,410);self.assertEqual(len(self.calls),1)
