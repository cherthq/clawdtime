import copy
import math
import unittest
from PIL import Image
from camera import ScreenCamera, CameraError, frame_metadata, surface

class CameraTests(unittest.TestCase):
    def setUp(self):
        self.now=100.;self.wall=1000.
        self.binding={'sessionId':'session','deviceId':'device','leaseId':'lease','displayId':1,'surface':{'kind':'display','id':'1','displayId':1}}
        self.source={'width':2560,'height':1440,'originX':-1280,'originY':-100,'pointWidth':1280,'pointHeight':720,'displayOriginX':-1280,'displayOriginY':-100,'displayPointWidth':1280,'displayPointHeight':720}
        self.meta={'version':1,'surface':self.binding['surface'],'geometryGeneration':'geometry1','contentRevision':'content1','source':self.source}
        self.image=Image.new('RGB',(2560,1440),'#204040')
        self.camera=ScreenCamera(self.binding,clock=lambda:self.now,wall=lambda:self.wall)
        self.camera.accept(self.image,'frame1',self.wall,self.meta)
        self.serial=0
    def cmd(self,op,**kw):
        self.serial+=1;s=self.camera.status()
        return {'version':1,'commandId':'cmd'+str(self.serial),'expectedRevision':s['revision'],'sourceFrameId':s['sourceFrameId'],'geometryGeneration':s['geometryGeneration'],'op':op,**kw}
    def test_crop_inverse_letterbox_retina_negative_origin(self):
        self.camera.command(self.cmd('focus_region',rect={'x':.2,'y':.1,'width':.3,'height':.4},durationMs=0))
        s=self.camera.status();v=s['output']['viewport'];ref={k:s[k] for k in ('revision','sourceFrameId','geometryGeneration')}
        for nx,ny in [(0,0),(.5,.5),(1,1),(.12,.83)]:
            x=(v['x']+v['width']*nx)/1280;y=(v['y']+v['height']*ny)/720
            sx,sy=self.camera.map_input(ref,x,y)
            self.assertAlmostEqual(sx,s['crop']['x']+s['crop']['width']*nx);self.assertAlmostEqual(sy,s['crop']['y']+s['crop']['height']*ny)
            self.assertAlmostEqual(-1280+sx*1280,self.source['originX']+sx*self.source['pointWidth'])
        with self.assertRaises(CameraError):self.camera.map_input(ref,0,0)
    def test_latest_motion_no_overshoot_and_stable_input_only(self):
        self.camera.command(self.cmd('focus_region',rect={'x':.2,'y':.2,'width':.4,'height':.4},durationMs=1000))
        self.now+=.5;s=self.camera.status();self.assertAlmostEqual(s['crop']['x'],.1)
        with self.assertRaises(CameraError):self.camera.map_input({k:s[k] for k in ('revision','sourceFrameId','geometryGeneration')},.5,.5)
        self.camera.command(self.cmd('overview'));self.now+=.45
        self.assertEqual(self.camera.status()['crop'],{'x':0.,'y':0.,'width':1.,'height':1.})
    def test_invalid_geometry_and_surface(self):
        for rect in [{'x':0,'y':0,'width':0,'height':1},{'x':0,'y':0,'width':math.nan,'height':1},{'x':.9,'y':0,'width':.3,'height':1},{'x':0,'y':0,'width':2,'height':1}]:
            with self.assertRaises(CameraError):self.camera.command(self.cmd('focus_region',rect=rect))
        for changes in [{'surface':{'kind':'display','id':'2','displayId':2}},{'source':{**self.source,'width':8193}},{'source':{**self.source,'originX':-1400}}]:
            with self.assertRaises(CameraError):frame_metadata({**self.meta,**changes},self.binding['surface'],2560,1440)
        for target in [{'kind':'window','id':'3','displayId':1},{'kind':'display','id':'1','displayId':1,'ownerPid':1}]:
            with self.assertRaises(CameraError):surface(target)
    def test_offscreen_window_geometry_is_bound_to_identity_not_display_crop(self):
        selected={'kind':'window','id':'99','ownerPid':123,'displayId':1}
        metadata={**self.meta,'surface':selected,'source':{**self.source,'originX':-5000}}
        self.assertEqual(frame_metadata(metadata,selected,2560,1440)['surface'],selected)
        with self.assertRaises(CameraError):
            frame_metadata({**metadata,'surface':self.binding['surface']},self.binding['surface'],2560,1440)

    def test_frame_binding_order_and_duplicate_expiry(self):
        for field,value in [('expectedRevision',5),('sourceFrameId','other'),('geometryGeneration','forged')]:
            with self.assertRaises(CameraError):self.camera.command({**self.cmd('pin'),field:value})
        cmd=self.cmd('annotation_upsert',annotation={'id':'a','kind':'label','rect':{'x':0,'y':0,'width':.1,'height':.1},'text':'<script>literal</script>','ttlMs':100})
        receipt=self.camera.command(cmd);self.wall+=.2
        self.assertEqual(self.camera.status()['annotations'],[])
        self.assertEqual(self.camera.command(cmd),receipt);self.assertEqual(self.camera.status()['annotations'],[])
        with self.assertRaises(CameraError):self.camera.command({**cmd,'op':'clear'})
    def test_content_geometry_changes_clear_marks_and_pin(self):
        self.camera.command(self.cmd('annotation_upsert',annotation={'id':'a','kind':'rectangle','rect':{'x':0,'y':0,'width':.1,'height':.1},'ttlMs':1000}))
        self.camera.command(self.cmd('pin'))
        self.camera.accept(self.image,'frame2',self.wall,{**self.meta,'contentRevision':'content2'})
        self.assertEqual(self.camera.status()['annotations'],[]);self.assertTrue(self.camera.pinned)
        self.camera.accept(self.image,'frame3',self.wall,{**self.meta,'geometryGeneration':'geometry2'})
        self.assertFalse(self.camera.pinned)
    def test_window_translation_preserves_zoom_but_invalidates_old_input(self):
        self.binding['surface']={'kind':'window','id':'99','displayId':1,'ownerPid':123}
        self.meta={**self.meta,'surface':self.binding['surface']}
        self.camera=ScreenCamera(self.binding,clock=lambda:self.now,wall=lambda:self.wall)
        self.camera.accept(self.image,'frame1',self.wall,self.meta)
        self.camera.command(self.cmd('focus_region',rect={'x':.2,'y':.2,'width':.4,'height':.4},durationMs=1000))
        self.now+=.5
        old=self.camera.status();reference={k:old[k] for k in ('revision','geometryGeneration','sourceFrameId')}
        self.camera.annotations['mark']={'expiresAt':self.wall*1000+1000}
        self.camera.context={'text':'old context','expiresAt':self.wall*1000+1000}
        moved={**self.meta,'geometryGeneration':'translated','source':{**self.source,'originX':-5000}}
        self.camera.accept(self.image,'frame2',self.wall,moved)
        state=self.camera.status()
        self.assertEqual(state['crop'],old['crop']);self.assertTrue(state['moving'])
        self.assertEqual(state['geometryGeneration'],'translated');self.assertEqual(state['annotations'],[]);self.assertIsNone(state['context'])
        with self.assertRaises(CameraError):self.camera.map_input(reference,.5,.5)
        self.now+=.5;state=self.camera.status();self.assertAlmostEqual(state['crop']['width'],.4,places=2)
        resized={**moved,'geometryGeneration':'resized','source':{**moved['source'],'width':1280,'pointWidth':640}}
        self.camera.accept(Image.new('RGB',(1280,1440)),'frame3',self.wall,resized)
        self.assertEqual(self.camera.status()['crop'],{'x':0.,'y':0.,'width':1.,'height':1.})

    def test_paused_window_translation_keeps_frozen_presentation_and_no_input(self):
        self.binding['surface']={'kind':'window','id':'99','displayId':1,'ownerPid':123}
        self.meta={**self.meta,'surface':self.binding['surface']}
        self.camera=ScreenCamera(self.binding,clock=lambda:self.now,wall=lambda:self.wall)
        self.camera.accept(self.image,'frame1',self.wall,self.meta)
        self.camera.command(self.cmd('focus_region',rect={'x':.2,'y':.2,'width':.4,'height':.4},durationMs=0))
        self.camera.command(self.cmd('freeze'));before=self.camera.status();frozen=self.camera.frozen
        moved={**self.meta,'geometryGeneration':'translated','source':{**self.source,'originX':-5000}}
        self.camera.accept(self.image,'frame2',self.wall,moved)
        state=self.camera.status();self.assertEqual(state['state'],'paused');self.assertEqual(state['crop'],before['crop'])
        self.assertIs(self.camera.frozen,frozen);self.assertEqual(state['sourceFrameId'],'frame1')
        self.assertEqual(self.camera.meta['geometryGeneration'],'translated')
        with self.assertRaises(CameraError):self.camera.map_input({k:state[k] for k in ('revision','geometryGeneration','sourceFrameId')},.5,.5)
        self.camera.command(self.cmd('resume'));self.assertEqual(self.camera.status()['geometryGeneration'],'translated')

    def test_freeze_freshness_resume_and_clear_release_pixels(self):
        self.camera.command(self.cmd('freeze'));self.assertEqual(self.camera.status()['state'],'paused')
        self.camera.accept(self.image,'frame2',self.wall,self.meta)
        s=self.camera.status();self.assertEqual(s['sourceFrameId'],'frame1')
        with self.assertRaises(CameraError):self.camera.map_input({k:s[k] for k in ('revision','sourceFrameId','geometryGeneration')},.5,.5)
        self.camera.command(self.cmd('resume'));self.assertEqual(self.camera.status()['sourceFrameId'],'frame2')
        self.camera.command(self.cmd('freeze'));self.camera.clear()
        self.assertIsNone(self.camera.frozen);self.assertIsNone(self.camera.image);self.assertEqual(self.camera.status()['state'],'unavailable')
    def test_rate_count_text_ttl_and_receipt_bounds(self):
        with self.assertRaises(CameraError):
            self.camera.command(self.cmd('annotation_upsert',annotation={'id':'missing_text','kind':'label','rect':{'x':0,'y':0,'width':.1,'height':.1},'ttlMs':1000}))
        for text in ['', 'a'*161, 'line\nbreak', '😀'*81]:
            with self.assertRaises(CameraError):self.camera.command(self.cmd('context',text=text,ttlMs=100))
        for value in [0,99,10001,True]:
            with self.assertRaises(CameraError):self.camera.command(self.cmd('context',text='fixture',ttlMs=value))
        for n in range(16):self.camera.command(self.cmd('annotation_upsert',annotation={'id':'a'+str(n),'kind':'highlight','rect':{'x':0,'y':0,'width':.1,'height':.1},'ttlMs':10000}))
        with self.assertRaises(CameraError):self.camera.command(self.cmd('annotation_upsert',annotation={'id':'overflow','kind':'pointer','rect':{'x':0,'y':0,'width':.1,'height':.1},'ttlMs':10000}))
        for _ in range(4):self.camera.command(self.cmd('pin'))
        with self.assertRaises(CameraError):self.camera.command(self.cmd('unpin'))
        old=self.cmd('clear');self.now+=2;self.camera.command(old)
        for _ in range(260):
            self.now+=.1;self.camera.command(self.cmd('clear'))
        self.assertEqual(len(self.camera.receipts),256)
        with self.assertRaises(CameraError):self.camera.command(old)
    def test_pinning_overrides_automatic_and_raw_pixels_remain_pristine(self):
        before=self.image.tobytes();self.camera.command(self.cmd('pin'))
        r=self.camera.command(self.cmd('focus_region',rect={'x':.1,'y':.1,'width':.3,'height':.3},automatic=True))
        self.assertEqual(r['state'],'superseded');self.assertEqual(self.camera.render().size,(1280,720));self.assertEqual(self.image.tobytes(),before)

    def test_identical_new_frame_accepts_content_bound_camera_command_only(self):
        old=self.cmd('focus_region',rect={'x':.1,'y':.1,'width':.5,'height':.5},durationMs=0,
            contentRevision=self.meta['contentRevision'])
        reference={k:self.camera.status()[k] for k in ('revision','sourceFrameId','geometryGeneration')}
        self.wall+=.1;self.now+=.1
        self.camera.accept(self.image,'frame2',self.wall,self.meta)
        strict={k:v for k,v in old.items() if k!='contentRevision'}
        with self.assertRaises(CameraError):self.camera.command(strict)
        with self.assertRaises(CameraError):self.camera.map_input(reference,.5,.5)
        self.assertEqual(self.camera.command(old)['state'],'accepted')

    def test_content_bound_command_rejects_invented_id_wrong_hash_and_bad_field(self):
        for extra in [{'sourceFrameId':'never_observed','contentRevision':'content1'},
                      {'contentRevision':'wrong_content'},{'contentRevision':''},{'contentRevision':False}]:
            with self.assertRaises(CameraError):self.camera.command(self.cmd('pin',**extra))

    def test_content_bound_reference_expires_by_capture_age_not_receipt_age(self):
        self.camera.accept(self.image,'old_capture',self.wall-1.9,self.meta)
        old=self.cmd('pin',contentRevision='content1')
        self.now+=.2;self.wall+=.2
        self.camera.accept(self.image,'fresh_capture',self.wall,self.meta)
        with self.assertRaises(CameraError):self.camera.command(old)
        self.assertNotIn('old_capture',self.camera.recent_frames)

    def test_content_bound_reference_has_monotonic_age_and_count_limits(self):
        old=self.cmd('pin',contentRevision='content1')
        for n in range(33):self.camera.accept(self.image,'rolled_'+str(n),self.wall,self.meta)
        self.assertEqual(len(self.camera.recent_frames),32)
        with self.assertRaises(CameraError):self.camera.command(old)
        current=self.cmd('pin',contentRevision='content1')
        # Even a wall-clock adjustment cannot keep the history alive indefinitely.
        self.now+=2.01
        self.camera.accept(self.image,'fresh_after_clock_change',self.wall,self.meta)
        with self.assertRaises(CameraError):self.camera.command(current)

    def test_content_bound_reference_cannot_survive_content_or_geometry_roundtrip(self):
        for change in [{'contentRevision':'content2'}, {'geometryGeneration':'geometry2'},
                       {'source':{**self.source,'originX':-1279,'pointWidth':1279}}]:
            self.setUp()
            old=self.cmd('pin',contentRevision='content1')
            self.camera.accept(self.image,'changed',self.wall,{**self.meta,**change})
            self.camera.accept(self.image,'returned',self.wall,self.meta)
            old['expectedRevision']=self.camera.revision
            with self.assertRaises(CameraError):self.camera.command(old)

    def test_content_bound_reference_clears_on_lifecycle_and_clear_command(self):
        old=self.cmd('pin',contentRevision='content1')
        self.camera.clear();self.assertEqual(self.camera.recent_frames,{})
        self.camera.accept(self.image,'after_stop',self.wall,self.meta)
        old['expectedRevision']=self.camera.revision
        with self.assertRaises(CameraError):self.camera.command(old)
        old=self.cmd('pin',contentRevision='content1')
        self.camera.accept(self.image,'before_clear',self.wall,self.meta)
        original=dict(self.camera.recent_frames['before_clear'])
        self.camera.command(self.cmd('clear'))
        after_clear=self.cmd('overview',contentRevision='content1')
        self.assertEqual(self.camera.recent_frames,{'before_clear':original})
        self.camera.accept(self.image,'after_clear',self.wall,self.meta)
        old['expectedRevision']=self.camera.revision
        with self.assertRaises(CameraError):self.camera.command(old)
        self.assertEqual(self.camera.command(after_clear)['state'],'accepted')

    def test_paused_view_keeps_exact_resume_without_history_relaxation(self):
        self.camera.accept(self.image,'frame2',self.wall,self.meta)
        self.camera.command(self.cmd('freeze'))
        cmd=self.cmd('resume',sourceFrameId='frame1',contentRevision='content1')
        self.camera.accept(self.image,'frame3',self.wall,self.meta)
        with self.assertRaises(CameraError):self.camera.command(cmd)
        with self.assertRaises(CameraError):self.camera.command(self.cmd('clear',sourceFrameId='frame1',contentRevision='content1'))
        self.assertEqual(self.camera.command(self.cmd('resume',contentRevision='content1'))['state'],'accepted')

    def test_content_revision_participates_in_duplicate_fingerprint(self):
        cmd=self.cmd('pin',contentRevision='content1')
        receipt=self.camera.command(cmd)
        self.assertEqual(self.camera.command(cmd),receipt)
        with self.assertRaises(CameraError):self.camera.command({**cmd,'contentRevision':'content2'})
        with self.assertRaises(CameraError):self.camera.command({k:v for k,v in cmd.items() if k!='contentRevision'})

    def test_render_snapshot_is_detached_from_later_presentation_mutations(self):
        snapshot=self.camera.render_snapshot()
        expected=ScreenCamera.render_from_snapshot(snapshot).tobytes()
        self.camera.command(self.cmd('focus_region',rect={'x':.1,'y':.2,'width':.4,'height':.3},durationMs=0))
        self.camera.command(self.cmd('context',text='Later context',ttlMs=1000))
        self.camera.clear()
        self.assertEqual(ScreenCamera.render_from_snapshot(snapshot).tobytes(),expected)

    def test_clear_and_overview_survive_content_only_change_with_known_fresh_reference(self):
        for op in ('clear','overview'):
            self.setUp()
            self.camera.command(self.cmd('focus_region',rect={'x':.1,'y':.1,'width':.5,'height':.5},durationMs=0))
            cmd=self.cmd(op,contentRevision='content1')
            self.wall+=.1;self.now+=.1
            self.camera.accept(self.image,'changed_content',self.wall,{**self.meta,'contentRevision':'content2'})
            with self.assertRaises(CameraError):self.camera.command({k:v for k,v in cmd.items() if k!='contentRevision'})
            self.assertEqual(self.camera.command(cmd)['state'],'accepted')
            self.assertEqual(self.camera.annotations,{})
            if op=='overview':
                self.now+=.5
                self.assertEqual(self.camera.status()['crop'],{'x':0.,'y':0.,'width':1.,'height':1.})

    def test_safe_resets_still_require_observed_content_and_exact_revision(self):
        for change in [{'sourceFrameId':'invented'},{'contentRevision':'forged'},{'expectedRevision':99}]:
            self.setUp();cmd=self.cmd('overview',contentRevision='content1',**{k:v for k,v in change.items() if k!='contentRevision'})
            cmd.update(change)
            self.camera.accept(self.image,'changed',self.wall,{**self.meta,'contentRevision':'content2'})
            with self.assertRaises(CameraError):self.camera.command(cmd)
        with self.assertRaises(CameraError):self.camera.command(self.cmd('clear',contentRevision='wrong_current_hash'))

    def test_targeting_operations_never_use_content_independent_reset_history(self):
        operations={'focus_region':{'rect':{'x':.1,'y':.1,'width':.3,'height':.3}},'zoom_out':{},'pin':{},'unpin':{},
            'freeze':{},'resume':{},'annotation_remove':{'annotationId':'a'},
            'annotation_upsert':{'annotation':{'id':'a','kind':'rectangle','rect':{'x':0,'y':0,'width':.1,'height':.1},'ttlMs':1000}},
            'context':{'text':'Fixture','ttlMs':1000}}
        for op,extra in operations.items():
            self.setUp();cmd=self.cmd(op,contentRevision='content1',**extra)
            self.camera.accept(self.image,'changed',self.wall,{**self.meta,'contentRevision':'content2'})
            with self.assertRaises(CameraError):self.camera.command(cmd)

    def test_reset_history_expires_and_cannot_cross_geometry_or_lifecycle(self):
        for change in ('capture_age','monotonic_age','geometry','source','stop'):
            self.setUp();cmd=self.cmd('clear',contentRevision='content1')
            if change=='capture_age':self.wall+=2.01
            elif change=='monotonic_age':self.now+=2.01
            elif change=='geometry':self.camera.accept(self.image,'moved',self.wall,{**self.meta,'geometryGeneration':'geometry2'})
            elif change=='source':self.camera.accept(self.image,'moved',self.wall,{**self.meta,'source':{**self.source,'originX':-1279,'pointWidth':1279}})
            else:self.camera.clear()
            self.camera.accept(self.image,'returned',self.wall,{**self.meta,'contentRevision':'content2'})
            cmd['expectedRevision']=self.camera.revision
            with self.assertRaises(CameraError):self.camera.command(cmd)

    def test_reset_history_indexes_share_at_most_32_metadata_records(self):
        old=self.cmd('overview',contentRevision='content1')
        for n in range(40):self.camera.accept(self.image,'frame_'+str(n),self.wall,{**self.meta,'contentRevision':'content_'+str(n)})
        self.assertEqual(len(self.camera.reset_frames),32)
        records={id(value) for value in [*self.camera.reset_frames.values(),*self.camera.recent_frames.values()]}
        self.assertEqual(len(records),32)
        with self.assertRaises(CameraError):self.camera.command(old)
        self.camera.command(self.cmd('clear',contentRevision='content_39'))
        self.assertEqual(len(self.camera.reset_frames),1)
        self.camera.clear();self.assertEqual(self.camera.reset_frames,{})

if __name__=='__main__':unittest.main()
