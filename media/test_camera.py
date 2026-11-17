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

if __name__=='__main__':unittest.main()
