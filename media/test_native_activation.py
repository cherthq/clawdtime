import asyncio
import copy
import json
import sqlite3
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from native_activation import ProductionNative, envelope, result
from preview_native import fingerprint


def fixture():
    op={'version':1,'operationId':'operation','sceneId':'scene','generation':1,'action':'activate_app','window':{'appId':'com.apple.finder','windowId':'2','ownerPid':1,'displayId':1},'expected':{'requestId':'request','sessionId':'agent','leaseId':'lease','epoch':1,'cursor':0,'policyRevision':1,'displayId':1}}
    value={'version':1,'operation':op,'fingerprint':fingerprint(op),'binding':{'mediaSessionId':'media','pairingId':'pair','deviceId':'device','memberId':'member','expiresAt':time.time()*1000+19000}}
    observed={'window':op['window'],'observedAt':time.time()*1000,'processIdentity':'a'*64,'windowBounds':{'x':0,'y':0,'width':100,'height':100},'appActive':True,'windowFocused':True,'windowOnScreen':True}
    return value,observed

class NativeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.value,self.observed=fixture();self.effects=0;self.revoked=False
        selected={'leaseId':'lease','deviceId':'device','memberId':'member','protocolVersion':2,'cameraVersion':1,'executor':'native','mode':'view','surface':{'kind':'display'},'sessionId':'agent','executorEpoch':1,'policyRevision':1,'displayId':1}
        screen=SimpleNamespace(expire=lambda:None,closed=False,selection=selected,stopped=set(),applied_lease='lease',applied_epoch=1,camera=SimpleNamespace(status=lambda:{'state':'live'}),frame=object())
        self.session=SimpleNamespace(active=True,closing=False,screen=screen)
        async def backend(path,payload):return payload['envelope']
        self.owner=SimpleNamespace(db=self.db,env={'CLAWDTIME_NATIVE_ACTIVATION_ENABLED':'true'},sessions={'media':self.session},backend=backend)
        self.host=ProductionNative(self.owner)
    def tearDown(self):self.db.close()
    async def gateway(self,owner,method,path,value=None,device=None):
        if path.endswith('/prepare'):return 200,json.dumps(self.observed).encode(),{}
        self.effects+=1
        answer={'operationId':'operation','state':'verified','reason':'target_foreground','terminalEvidence':{'receiptId':'receipt','operationId':'operation','fingerprint':self.value['fingerprint'],'hostId':'clawdtime-installed-native','completedAt':time.time()*1000},'observation':self.observed}
        return 200,json.dumps(answer).encode(),{}
    async def prepared(self):
        await self.host.run('media',self.value,False)
        return {**self.value,'nativeExpiresAt':time.time()*1000+1800,'preparedObservation':self.observed}
    async def test_duplicate_dispatch_is_one_effect_and_conflicts_refuse(self):
        with patch('native_activation.gateway_request',self.gateway):
            dispatch=await self.prepared();a=await self.host.run('media',dispatch,True);b=await self.host.run('media',dispatch,True)
            self.assertEqual(a,b);self.assertEqual(self.effects,1)
            with self.assertRaises(ValueError):await self.host.run('media',self.value,False)
            self.assertEqual((await self.host.run('media',dispatch,True)),a);self.assertEqual(self.effects,1)
            changed=copy.deepcopy(dispatch);changed['binding']['pairingId']='foreign'
            with self.assertRaises(ValueError):await self.host.run('media',changed,True)
    async def test_revoked_cloud_callback_prevents_effect_and_preserves_uncertain(self):
        with patch('native_activation.gateway_request',self.gateway):
            dispatch=await self.prepared()
            async def revoke(path,payload):self.session.closing=True;return payload['envelope']
            self.owner.backend=revoke
            answer=await self.host.run('media',dispatch,True)
            self.assertEqual(answer['state'],'uncertain');self.assertEqual(self.effects,0)
            self.session.closing=False;self.host=ProductionNative(self.owner)
            self.assertEqual((await self.host.run('media',dispatch,True))['state'],'uncertain');self.assertEqual(self.effects,0)
    async def test_unknown_fences_replacement_session_device(self):
        with patch('native_activation.gateway_request',self.gateway):
            dispatch=await self.prepared()
            async def timeout(*args,**kwargs):raise TimeoutError()
            with patch('native_activation.gateway_request',timeout):self.assertEqual((await self.host.run('media',dispatch,True))['state'],'uncertain')
            other=copy.deepcopy(self.value);other['operation']['operationId']='new';other['fingerprint']=fingerprint(other['operation'])
            with self.assertRaises(ValueError):await self.host.run('media',other,False)
    async def test_disabled_gate_and_exact_scope(self):
        for section,key,value in [('binding','deviceId','other'),('binding','mediaSessionId','other')]:
            changed=copy.deepcopy(self.value);changed[section][key]=value
            with self.assertRaises(ValueError):self.host.guard('media',changed)
        self.owner.env.clear()
        with self.assertRaises(ValueError):await self.host.run('media',self.value,False)
    def test_original_prepare_age_not_restamped_but_dispatch_deadline_is_short(self):
        self.observed['observedAt']-=5000
        dispatch={**self.value,'nativeExpiresAt':time.time()*1000+1800,'preparedObservation':self.observed}
        self.assertEqual(envelope(dispatch,True)['preparedObservation']['observedAt'],self.observed['observedAt'])
        dispatch['nativeExpiresAt']=time.time()*1000+2100
        with self.assertRaises(ValueError):envelope(dispatch,True)

    def test_terminal_binding_and_returned_after_expiry(self):
        now=time.time()*1000
        value={**self.value,'preparedObservation':self.observed,'nativeExpiresAt':now-100}
        answer={'operationId':'operation','state':'returned','reason':'host_returned_target_unverified','terminalEvidence':{'receiptId':'receipt','operationId':'operation','fingerprint':value['fingerprint'],'hostId':'clawdtime-installed-native','completedAt':now}}
        self.assertEqual(result(answer,value),answer)
        for field,changed in [('fingerprint','a'*64),('hostId','preview'),('completedAt',now+5000)]:
            invalid=copy.deepcopy(answer);invalid['terminalEvidence'][field]=changed
            with self.assertRaises(ValueError):result(invalid,value)
        with self.assertRaises(ValueError):result({**answer,'state':'verified','observation':self.observed},value)
        pending={'operationId':'operation','state':'submitted','reason':'effect_submitted'}
        self.assertEqual(result(pending,value),pending)
        with self.assertRaises(ValueError):result({**answer,'state':'submitted'},value)
