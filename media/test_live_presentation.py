import asyncio
import copy
import sqlite3
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
from aiohttp import web
from camera import ScreenCamera,CameraError,FULL
from preview_presentation import LivePresentationController,argument_hash,target_rect,validate


def intent():
    return {'commandId':'present_1','planId':'plan','sceneId':'scene','generation':1,
        'window':{'appId':'com.apple.finder','windowId':'77','ownerPid':42,'displayId':1},
        'focus':{'rect':{'x':.1,'y':.1,'width':.8,'height':.6},'durationMs':0},
        'annotation':{'kind':'label','text':'Fixture heading'},'version':1,'processIdentity':'process_identity',
        'expected':{'requestId':'request','sessionId':'session','leaseId':'lease','epoch':0,'cursor':0,'policyRevision':1,'displayId':1}}


class CameraTargetScopeTests(unittest.TestCase):
    def setUp(self):
        from test_camera import CameraTests
        self.fixture=CameraTests();self.fixture.setUp();self.camera=self.fixture.camera
        self.focus={'x':.1,'y':.1,'width':.5,'height':.5}
        self.serial=0
    def present(self,mark=None):
        self.serial+=1;self.scope_id='scope_'+str(self.serial)
        return self.camera.present_target(self.scope_id,self.focus,mark or {'kind':'label','text':'Fixture'},0,self.fixture.now)
    def test_atomic_rejection_leaves_prior_focus_marks_receipts_unchanged(self):
        before=copy.deepcopy(self.camera.status());receipts=dict(self.camera.receipts)
        with self.assertRaises(CameraError):self.present({'kind':'label'})
        self.assertEqual(self.camera.status(),before);self.assertEqual(self.camera.receipts,receipts)
    def test_content_change_preserves_only_monitored_marks_and_input_stays_exact(self):
        state=self.present();ref={k:state[k] for k in ('revision','sourceFrameId','geometryGeneration')}
        image=self.camera.image
        self.camera.accept(image,'new_frame',self.fixture.wall,{**self.fixture.meta,'contentRevision':'new_content'})
        self.assertEqual(len(self.camera.status()['annotations']),1);self.assertEqual(self.camera.status()['crop'],self.focus)
        with self.assertRaises(CameraError):self.camera.map_input(ref,.5,.5)
        with self.assertRaises(CameraError):self.camera.command({'version':1,'commandId':'old_target','expectedRevision':state['revision'],
            'sourceFrameId':state['sourceFrameId'],'geometryGeneration':state['geometryGeneration'],'contentRevision':state['contentRevision'],
            'op':'focus_region','rect':self.focus})
        self.fixture.now+=.251;revision=self.camera.revision
        self.assertEqual(self.camera.status()['annotations'],[]);self.assertEqual(self.camera.status()['crop'],FULL)
        self.assertGreater(self.camera.revision,revision);self.assertFalse(self.camera.renew_target_scope('scope',self.fixture.now))
    def test_geometry_stop_and_original_monotonic_ttl_invalidate_scope(self):
        self.present();self.camera.accept(self.fixture.image,'new_frame',self.fixture.wall,{**self.fixture.meta,'geometryGeneration':'geometry2'})
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.status()['crop'],FULL)
        self.present()
        for _ in range(14):
            self.fixture.now+=.2;self.assertTrue(self.camera.renew_target_scope(self.scope_id,self.fixture.now))
        self.fixture.now+=.201;self.camera.status()
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.crop,FULL)
        self.present();self.camera.clear();self.assertIsNone(self.camera.target_scope)
    def test_pin_pause_and_stale_original_witness_refuse_without_mutation(self):
        self.camera.pinned=True
        with self.assertRaises(CameraError):self.present()
        self.camera.pinned=False;self.camera.paused=True
        with self.assertRaises(CameraError):self.present()
        self.camera.paused=False
        with self.assertRaises(CameraError):self.camera.present_target('scope',self.focus,None,0,self.fixture.now-.251)
    def test_invalid_external_command_does_not_take_over_scope(self):
        self.present();state=self.camera.status()
        with self.assertRaises(CameraError):self.camera.command({'version':1,'commandId':'invalid','expectedRevision':state['revision'],
            'sourceFrameId':state['sourceFrameId'],'geometryGeneration':state['geometryGeneration'],'op':'annotation_upsert','annotation':{}})
        self.assertIsNotNone(self.camera.target_scope);self.assertEqual(len(self.camera.annotations),1)
    def test_relative_mapping_retina_negative_origin_and_numeric_hash(self):
        source={'originX':-1000,'originY':-100,'pointWidth':1000,'pointHeight':500}
        result=target_rect({'x':-900,'y':0,'width':500,'height':200},{'x':.2,'y':0,'width':.4,'height':1},source)
        self.assertEqual(result,{'x':.2,'y':.2,'width':.2,'height':.4})
        first=intent();first['focus']['rect']['x']=1e-6
        other=copy.deepcopy(first);other['generation']=1.0
        self.assertEqual(argument_hash(first),argument_hash(other))
        self.assertEqual(validate(first)['focus']['rect']['x'],1e-6)


class LivePresentationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.value=intent();self.mark='a'*64;self.allowed=True;self.broker_allowed=True;self.mode='normal';self.calls=0;self.authorities=0
        self.blocked=asyncio.Event();self.release=asyncio.Event()
        binding={'sessionId':'session','deviceId':'device','leaseId':'lease','displayId':1,'surface':{'kind':'display','id':'1','displayId':1}}
        self.camera=ScreenCamera(binding);self.image=Image.new('RGB',(400,200),'navy')
        self.meta={'version':1,'surface':binding['surface'],'geometryGeneration':'geometry','contentRevision':'content',
            'source':{'width':400,'height':200,'originX':0,'originY':0,'pointWidth':400,'pointHeight':200,
                'displayOriginX':0,'displayOriginY':0,'displayPointWidth':400,'displayPointHeight':200}}
        self.camera.accept(self.image,'initial',time.time(),self.meta)
        self.screen=SimpleNamespace(camera=self.camera,frame_lock=asyncio.Lock(),generation=0,expire=lambda:None)
        self.db=sqlite3.connect(':memory:');self.sources=[]
        self.controller=LivePresentationController(self.screen,'unused',self.authority,self.guard,self.db,self.factory)
    async def asyncTearDown(self):await self.controller.stop();self.db.close()
    def guard(self,value):
        if not self.allowed:raise ValueError('media_epoch_mismatch')
    async def authority(self,value):
        self.authorities+=1;self.guard(value)
        if not self.broker_allowed:raise ValueError('presentation_authority_unavailable')
        if self.mode=='slow_final_authority' and self.authorities==2:await asyncio.sleep(.3)
        return {**value['expected'],'expiresAt':time.time()*1000+1500,'fingerprint':self.mark}
    def factory(self,binary):
        owner=self
        class Source:
            closed=False
            async def resolve(self,value,authority,timeout=1.5):
                owner.calls+=1;n=owner.calls
                if owner.mode=='raw_error':raise ValueError('unrecognized native detail must remain private')
                if owner.mode=='stop_in_resolver' and n==1:
                    owner.blocked.set();await owner.release.wait()
                if owner.mode=='monitor_hang' and n>=3:await asyncio.Event().wait()
                if owner.mode=='generation_during_monitor' and n>=3:owner.broker_allowed=False
                if self.closed:raise ValueError('presentation_stopped')
                observed={'window':value['window'],'observedAt':time.time()*1000,'processIdentity':'process_identity',
                    'windowBounds':{'x':20,'y':20,'width':200,'height':100},'appActive':True,'windowFocused':True,'windowOnScreen':True}
                if n==1 and owner.mode!='no_bracketing_frame':owner.camera.accept(owner.image,'bracketed',time.time(),owner.meta)
                if n==2:
                    if owner.mode=='move':observed['windowBounds']['x']=21
                    if owner.mode=='process':observed['processIdentity']='other_process'
                    if owner.mode=='focus':observed['windowFocused']=False
                    if owner.mode=='old_second':observed['observedAt']=owner.camera.captured*1000-1
                    if owner.mode=='manual_camera':owner.camera.revision+=1
                if n>=3 and owner.mode=='monitor_move':observed['windowBounds']['x']=21
                return observed
            async def close(self):self.closed=True;owner.release.set()
        source=Source();self.sources.append(source);return source
    async def test_bracketed_transaction_duplicate_and_broker_bound_numeric_fingerprint(self):
        self.value['focus']['rect']['x']=1e-6
        result=await self.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'accepted');self.assertLessEqual(result['camera']['capturedAt'],result['observation']['observedAt'])
        self.assertEqual(len(self.camera.annotations),1);self.assertIsNotNone(self.camera.target_scope)
        calls=self.calls;self.assertEqual(await self.controller.present(self.value,self.mark),result);self.assertEqual(calls,self.calls)
        changed=copy.deepcopy(self.value);changed['focus']['rect']['x']=.2
        with self.assertRaises(ValueError):await self.controller.present(changed,self.mark)
    async def test_move_process_focus_or_frame_outside_bracket_reject_atomically(self):
        for mode in ('move','process','focus','old_second','manual_camera'):
            self.mode=mode;self.calls=0;self.value['commandId']=mode
            result=await self.controller.present(self.value,self.mark)
            self.assertEqual(result['state'],'rejected',mode);self.assertEqual(self.camera.annotations,{})
            self.assertEqual(self.camera.status()['crop'],FULL)
    async def test_monitor_failure_or_generation_change_clears_focus_marks(self):
        for mode in ('monitor_move','generation_during_monitor'):
            self.mode=mode;self.calls=0;self.allowed=True;self.broker_allowed=True;self.value['commandId']=mode
            result=await self.controller.present(self.value,self.mark);self.assertEqual(result['state'],'accepted')
            await asyncio.sleep(.03)
            self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.status()['crop'],FULL);self.assertEqual(self.camera.annotations,{})
    async def test_hung_monitor_does_not_extend_witness_age(self):
        self.mode='monitor_hang';result=await self.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'accepted');await asyncio.sleep(.26)
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.status()['crop'],FULL)
    async def test_slow_authority_after_native_witness_refuses_no_restamp(self):
        self.mode='slow_final_authority';result=await self.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'rejected');self.assertIsNone(self.camera.target_scope)
    async def test_missing_bracketing_frame_is_not_relabelled(self):
        self.mode='no_bracketing_frame';result=await self.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'rejected');self.assertEqual(self.camera.frame_id,'initial')
    async def test_stop_during_resolver_preserves_one_shot_receipt(self):
        self.mode='stop_in_resolver';task=asyncio.create_task(self.controller.present(self.value,self.mark))
        await self.blocked.wait();await self.controller.stop();result=await task
        self.assertEqual(result['state'],'rejected');self.assertEqual(self.camera.annotations,{})
        self.assertEqual(await self.controller.present(self.value,self.mark),result);self.assertEqual(self.calls,1)
    async def test_unrecognized_resolver_errors_remain_fixed_and_do_not_mutate(self):
        self.mode='raw_error';before=self.camera.revision
        result=await self.controller.present(self.value,self.mark)
        self.assertEqual(result['state'],'rejected');self.assertEqual(result['reason'],'presentation_authority_unavailable')
        self.assertEqual(self.camera.revision,before);self.assertEqual(self.camera.annotations,{})
    async def test_render_started_before_monitor_expiry_cannot_publish_old_scope(self):
        from camera_preview import Preview
        result=await self.controller.present(self.value,self.mark);self.assertEqual(result['state'],'accepted')
        # Stop monitor without invalidating scope to model a starved/hung worker.
        self.controller.monitor.cancel();await asyncio.gather(self.controller.monitor,return_exceptions=True)
        self.camera.present_target('render_scope',{'x':.1,'y':.1,'width':.5,'height':.5},{'kind':'label','text':'Fixture'},0,time.monotonic())
        preview=object.__new__(Preview);preview.screen=self.screen;preview.stopped=False;preview.render_lock=asyncio.Lock();preview.render_count=0;preview.render_ms=0
        began=threading.Event();release=threading.Event()
        def render(snapshot):began.set();release.wait(2);return Image.new('RGB',(10,10),'black')
        with patch.object(ScreenCamera,'render_from_snapshot',side_effect=render):
            task=asyncio.create_task(preview.render_image())
            while not began.is_set():await asyncio.sleep(.005)
            self.camera.target_scope['confirmedAt']-=.251
            release.set()
            with self.assertRaises(web.HTTPConflict):await task
        self.assertEqual(preview.render_count,0);self.assertEqual(self.camera.status()['crop'],FULL)
