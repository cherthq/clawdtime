import copy
import hashlib
import json
import time
import unittest
from pathlib import Path
import tempfile
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from service import Gateway, validate_lease
from native_relay import validate, validated_result
from test_execution_policy import lease


def fixture():
    o={'version':1,'operationId':'operation','sceneId':'scene','generation':1,'action':'activate_app','window':{'appId':'com.apple.finder','windowId':'2','ownerPid':1,'displayId':1},'expected':{'requestId':'request','sessionId':'session','leaseId':'lease','epoch':1,'cursor':0,'policyRevision':1,'displayId':1}}
    return {'version':1,'operation':o,'fingerprint':hashlib.sha256(json.dumps(o,separators=(',',':')).encode()).hexdigest(),'binding':{'mediaSessionId':'media','pairingId':'pair','deviceId':'mac','memberId':'person','expiresAt':time.time()*1000+19000}}

class NativeRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.calls=[];self.fail=False;self.stop=False;self.value=fixture()
        self.observed={'window':self.value['operation']['window'],'processIdentity':'a'*64,'observedAt':time.time()*1000,'windowBounds':{'x':0,'y':0,'width':100,'height':100},'appActive':True,'windowFocused':True,'windowOnScreen':True}
        async def helper(req):
            self.calls.append(req.path)
            if self.fail:raise web.HTTPServiceUnavailable()
            if req.path.endswith('/prepare'):return web.json_response(self.observed)
            if self.stop:self.gateway.stop('lease')
            return web.json_response({'operationId':'operation','state':'verified','reason':'target_foreground','observation':self.observed,'terminalEvidence':{'receiptId':'receipt','operationId':'operation','fingerprint':self.value['fingerprint'],'hostId':'clawdtime-installed-native','completedAt':time.time()*1000}})
        app=web.Application();app.router.add_route('*','/{tail:.*}',helper);self.helper=TestServer(app);await self.helper.start_server()
        self.gateway=Gateway({'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(self.tmp.name)/'gateway.sqlite')},{'mac':{'url':str(self.helper.make_url('')).rstrip('/'),'key':'h'*32}})
        self.client=TestClient(TestServer(self.gateway.app()));await self.client.start_server();self.headers={'Authorization':'Bearer '+'g'*32}
        self.lease={**lease(1,'native'),'cameraVersion':1,'surface':{'kind':'display','id':'1','displayId':1}}
        self.gateway.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,?,?)',('lease','mac',json.dumps(self.lease),validate_lease(self.lease),'active','frame',time.time()));self.gateway.db.commit()
    async def asyncTearDown(self):await self.client.close();await self.helper.close();self.tmp.cleanup()
    async def dispatch(self):
        r=await self.client.post('/v1/leases/lease/native/prepare',json=self.value,headers=self.headers);self.assertEqual(r.status,200)
        return {**self.value,'preparedObservation':await r.json(),'nativeExpiresAt':time.time()*1000+1800}
    async def test_authenticated_one_effect_and_duplicate_receipt(self):
        self.assertEqual((await self.client.post('/v1/leases/lease/native/prepare',json=self.value)).status,401)
        value=await self.dispatch()
        a=await self.client.post('/v1/leases/lease/native/dispatch',json=value,headers=self.headers)
        b=await self.client.post('/v1/leases/lease/native/dispatch',json=value,headers=self.headers)
        self.assertEqual(await a.json(),await b.json());self.assertEqual(len(self.calls),2)
        self.assertEqual((await self.client.post('/v1/leases/lease/native/prepare',json=self.value,headers=self.headers)).status,409)
        self.assertEqual(len(self.calls),2)
    async def test_unknown_fences_ownership_and_reconciles_read_only_after_stop(self):
        value=await self.dispatch();self.fail=True
        r=await self.client.post('/v1/leases/lease/native/dispatch',json=value,headers=self.headers);self.assertEqual((await r.json())['state'],'uncertain')
        self.assertTrue(self.gateway.native_activation.blocked('mac'))
        renew={**self.lease,'executorEpoch':2,'executor':'none'}
        self.assertEqual((await self.client.post('/v1/leases/lease/renew',json=renew,headers=self.headers)).status,409)
        self.gateway.stop('lease');self.fail=False
        r=await self.client.get('/v1/leases/lease/native/operation',headers=self.headers)
        self.assertEqual((await r.json())['state'],'verified');self.assertFalse(self.gateway.native_activation.blocked('mac'))
    async def test_stop_during_effect_is_unknown_and_never_replayed(self):
        value=await self.dispatch();self.stop=True
        r=await self.client.post('/v1/leases/lease/native/dispatch',json=value,headers=self.headers);self.assertEqual((await r.json())['state'],'uncertain');self.assertEqual(len(self.calls),2)
    def test_scope_fingerprint_expiry_and_unexpected_fields(self):
        validate(self.value,self.lease,False)
        for mutate in (lambda v:v.update(fingerprint='a'*64),lambda v:v['binding'].update(deviceId='other'),lambda v:v['binding'].update(expiresAt=time.time()*1000-1),lambda v:v.update(script='input')):
            v=copy.deepcopy(self.value);mutate(v)
            with self.assertRaises(web.HTTPException):validate(v,self.lease,False)

    def test_terminal_binding_and_returned_after_expiry(self):
        now=time.time()*1000
        value={**self.value,'preparedObservation':self.observed,'nativeExpiresAt':now-100}
        answer={'operationId':'operation','state':'returned','reason':'host_returned_target_unverified','terminalEvidence':{'receiptId':'receipt','operationId':'operation','fingerprint':value['fingerprint'],'hostId':'clawdtime-installed-native','completedAt':now}}
        self.assertTrue(validated_result(answer,value))
        for field,changed in [('fingerprint','a'*64),('hostId','preview'),('completedAt',now+5000)]:
            invalid=copy.deepcopy(answer);invalid['terminalEvidence'][field]=changed
            with self.assertRaises(web.HTTPBadGateway):validated_result(invalid,value)
        invalid={**answer,'state':'verified','observation':self.observed}
        with self.assertRaises(web.HTTPBadGateway):validated_result(invalid,value)
        self.assertFalse(validated_result({'operationId':'operation','state':'submitted','reason':'effect_submitted'},value))
        with self.assertRaises(web.HTTPBadGateway):validated_result({**answer,'state':'submitted'},value)

    async def test_authenticated_runtime_version_is_metadata_only(self):
        self.assertEqual((await self.client.get('/v1/version')).status,401)
        response=await self.client.get('/v1/devices/mac/version',headers=self.headers)
        self.assertEqual(response.status,200)
        value=await response.json();self.assertEqual(value['sourceRevision'],'development')
        self.assertRegex(value['runtimeSha256'],'^[a-f0-9]{64}$')
        self.assertEqual(value['nativeActivationVersion'],1);self.assertEqual(self.calls,[])
        self.assertEqual((await self.client.get('/v1/devices/foreign/version',headers=self.headers)).status,404)
