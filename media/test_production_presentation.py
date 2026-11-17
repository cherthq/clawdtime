import asyncio
import copy
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock,Mock,patch
from PIL import Image
from captions import CaptionPublisher,CaptionScene
from live_presentation import ProductionPresentation,RemoteResolver,resolve_request
from preview_presentation import LivePresentationController
import test_live_presentation as fixtures
from test_live_presentation import intent


class ProductionPresentationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture=fixtures.LivePresentationTests();await self.fixture.asyncSetUp()
        self.value=intent();self.value['processIdentity']='a'*64;self.value['expected']['sessionId']='agent_session'
        self.screen=self.fixture.screen;self.screen.frame=self.fixture.image
        self.screen.selection={'leaseId':'lease','sessionId':'agent_session','executorEpoch':0,'policyRevision':1,'displayId':1,
            'deviceId':'device','protocolVersion':2,'cameraVersion':1,'executor':'none','mode':'view','surface':{'kind':'display','id':'1','displayId':1}}
        self.screen.stopped=set();self.screen.closed=False;self.screen.applied_epoch=0;self.screen.applied_lease='lease'
        self.owner=SimpleNamespace(env={'CLAWDTIME_LIVE_PRESENTATION_ENABLED':'true'},db=self.fixture.db,backend=AsyncMock(side_effect=self.backend))
        self.session=SimpleNamespace(id='ct_media',screen=self.screen,owner=self.owner,active=True,closing=False)
        self.host=ProductionPresentation(self.session);self.calls=0;self.mode='ok';self.mark='b'*64
        self.patch=patch('live_presentation.gateway_request',side_effect=self.gateway);self.transport=self.patch.start()
    async def asyncTearDown(self):
        await self.host.stop();self.patch.stop();await self.fixture.asyncTearDown()
    def qualification(self):return {'commandId':'qualify1','window':self.value['window'],'expected':self.value['expected'],'expiresAt':time.time()*1000+1500}
    async def backend(self,path,body):
        if 'qualification' in body:
            q=body['qualification'];return {**q['expected'],'expiresAt':q['expiresAt']}
        return {**body['presentation']['expected'],'expiresAt':time.time()*1000+1500,'fingerprint':self.mark}
    async def gateway(self,owner,method,path,body,device=None):
        self.calls+=1
        self.assertEqual(method,'POST');self.assertEqual(path,'/v1/leases/lease/presentation/resolve');self.assertEqual(device,'device')
        self.assertNotIn('effect',body);self.assertNotIn('targetToken',body)
        if self.mode=='hang':await asyncio.Event().wait()
        if self.mode=='stop':self.screen.closed=True
        observed=time.time()*1000
        if self.mode=='past':observed-=2500
        if self.mode=='future':observed+=200
        if self.mode=='old_witness' and self.calls==2:observed-=300
        result={'window':body['window'],'observedAt':observed,'processIdentity':'a'*64,
            'windowBounds':{'x':20,'y':20,'width':200,'height':100},'appActive':True,'windowFocused':True,'windowOnScreen':True}
        if self.calls==1:self.fixture.camera.accept(self.fixture.image,'bracketed',time.time(),self.fixture.meta)
        return 200,json.dumps(result).encode(),{}
    async def test_initial_qualification_preserves_identity_expiry_and_backend_scope(self):
        q=self.qualification();result=await self.host.qualify(q)
        self.assertEqual(result['processIdentity'],'a'*64);self.assertEqual(self.calls,1)
        self.assertEqual(self.owner.backend.await_count,2)
        sent=self.transport.call_args.args[3];self.assertEqual(sent['expiresAt'],q['expiresAt']);self.assertNotIn('processIdentity',sent)
    async def test_gate_and_every_current_local_binding_refuses_before_gateway(self):
        q=self.qualification()
        for field,value in [('executor','native'),('mode','control'),('executorEpoch',1),('sessionId','other'),('policyRevision',2),('displayId',2),('cameraVersion',None)]:
            original=self.screen.selection[field];self.screen.selection[field]=value
            with self.assertRaises(ValueError):await self.host.qualify(q)
            self.screen.selection[field]=original
        self.owner.env.clear()
        with self.assertRaises(ValueError):await self.host.qualify(q)
        self.assertEqual(self.calls,0)
    async def test_stop_during_remote_read_discards_observation_without_retry(self):
        self.mode='stop'
        with self.assertRaises(ValueError):await self.host.qualify(self.qualification())
        self.assertEqual(self.calls,1)
    async def test_remote_timeout_closes_one_shot_source_and_no_retry(self):
        self.mode='hang';source=RemoteResolver(self.host);q=self.qualification();authority={**q['expected'],'expiresAt':q['expiresAt']}
        with self.assertRaises(asyncio.TimeoutError):await source.resolve(self.value,authority,timeout=.01)
        self.assertTrue(source.closed)
        with self.assertRaises(ValueError):await source.resolve(self.value,authority)
        self.assertEqual(self.calls,1)
    async def test_original_native_timestamp_skew_is_not_restamped(self):
        for mode in ('past','future'):
            self.mode=mode
            with self.assertRaises(ValueError):await self.host.qualify(self.qualification())
    async def test_atomic_production_receipt_is_scoped_and_retained_after_stop(self):
        result=await self.host.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'accepted');self.assertIsNotNone(self.fixture.camera.target_scope)
        self.assertLessEqual(result['camera']['capturedAt'],result['observation']['observedAt'])
        await self.host.stop();self.assertIsNone(self.fixture.camera.target_scope)
        self.assertEqual(self.host.controller.receipt(self.value['commandId']),result)
        other=LivePresentationController(self.screen,None,None,None,self.owner.db,receipt_namespace='other')
        self.assertIsNone(other.receipt(self.value['commandId']))
        self.assertNotIn('Fixture heading',self.owner.db.execute('SELECT result FROM presentation_receipts').fetchone()[0])
    async def test_delayed_witness_cannot_commit_or_refresh_original_age(self):
        self.mode='old_witness';result=await self.host.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'rejected');self.assertIsNone(self.fixture.camera.target_scope)
        self.assertEqual(self.fixture.camera.annotations,{})
    async def test_monitor_network_hang_expires_crop_and_marks(self):
        result=await self.host.controller.present(self.value,self.mark);self.assertEqual(result['state'],'accepted')
        self.mode='hang';await asyncio.sleep(.31)
        self.fixture.camera.status();self.assertIsNone(self.fixture.camera.target_scope);self.assertEqual(self.fixture.camera.annotations,{})
    def test_qualification_wire_requires_command_identity_and_rejects_effects(self):
        q=self.qualification();resolve_request(q)
        for field in ('effect','op','targetToken'):
            with self.assertRaises(ValueError):resolve_request({**q,field:'activate'})
        q.pop('commandId')
        with self.assertRaises(ValueError):resolve_request(q)


class ProductionRenderFreshnessTests(unittest.TestCase):
    def test_expired_scope_during_render_is_never_published(self):
        camera=SimpleNamespace(status=Mock(side_effect=[{'revision':1},{'revision':2}]))
        image=Image.new('RGBA',(1280,720))
        screen=SimpleNamespace(expire=Mock(),camera=camera,screen_call=True,selection={},starting=False,
            revision=1,render=Mock(return_value=image),diagnostics=SimpleNamespace(emitted=Mock()),frame=image)
        sdk=SimpleNamespace(VideoFrame=lambda *args:args,VideoBufferType=SimpleNamespace(RGBA=1))
        publisher=CaptionPublisher(CaptionScene('fixture'),None,sdk=sdk,screen=screen)
        publisher.renderer.camera_overlay=Mock(return_value=image);publisher.source=SimpleNamespace(capture_frame=Mock())
        publisher.emit();publisher.source.capture_frame.assert_not_called();self.assertIsNone(publisher.frame)
