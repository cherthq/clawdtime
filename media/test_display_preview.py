import asyncio
import base64
import hashlib
import io
import unittest
from unittest.mock import AsyncMock, patch
import threading
from aiohttp import ClientSession
from aiohttp import web
from PIL import Image
from camera_preview import Preview, iso
from camera import ScreenCamera


class DisplayPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.preview=Preview({'mode':'actual','surface':{'kind':'display','id':'1','displayId':1},
            'displayStream':True,'sourceFps':15,'renderFps':30,'durationSeconds':30})
        self.preview.native_command=AsyncMock(return_value={'surface':self.preview.surface,
            'windowFrame':[0,0,400,200],'displayBounds':[0,0,400,200]})
        self.native=AsyncMock();self.native.metrics=lambda:{'transport':'synthetic_stream_fixture'}
        self.preview.native_source=self.native
        self.counter=0
        self.data=io.BytesIO();Image.new('RGB',(400,200),'navy').save(self.data,'JPEG')
        self.native.frame.side_effect=self.frame
        self.info=await self.preview.setup();self.http=ClientSession()
        self.headers={'Authorization':'Bearer '+self.preview.token}

    async def frame(self):
        self.counter+=1;raw=self.data.getvalue()
        return {'frameId':'fixture_'+str(self.counter),'capturedAt':iso(),'jpegBase64':base64.b64encode(raw).decode(),
            'camera':{'version':1,'surface':self.preview.surface,'geometryGeneration':'fixture_geometry',
                'contentRevision':hashlib.sha256(raw).hexdigest(),'source':{'width':400,'height':200,'originX':0,'originY':0,
                    'pointWidth':400,'pointHeight':200,'displayOriginX':0,'displayOriginY':0,'displayPointWidth':400,'displayPointHeight':200}}}

    async def asyncTearDown(self):await self.http.close();await self.preview.close()

    async def test_explicit_start_metrics_and_no_input(self):
        self.assertEqual(self.counter,0)
        async with self.http.post(self.info['origin']+'/preview/start',json={},headers=self.headers) as response:self.assertEqual(response.status,200)
        for _ in range(100):
            if self.preview.screen.frame_id:break
            await asyncio.sleep(.01)
        self.assertIsNotNone(self.preview.screen.frame_id)
        self.assertAlmostEqual(self.preview.screen.source_interval,1/15)
        async with self.http.get(self.info['origin']+'/preview/image',headers=self.headers) as response:
            self.assertEqual(response.status,200);await response.read()
        async with self.http.get(self.info['origin']+'/preview/metrics',headers=self.headers) as response:
            metrics=await response.json()
        self.assertEqual(metrics['renderedImages'],1);self.assertIsNotNone(metrics['sourceAgeMs'])
        self.assertEqual(metrics['sourceTargetFps'],15);self.assertEqual(metrics['renderTargetFps'],30)
        self.assertEqual(self.preview.inputs,[])
        await self.preview.stop();self.assertTrue(self.native.stop.called)
        self.assertIsNone(self.preview.screen.frame)

    async def test_stale_stream_sample_is_not_restamped(self):
        async def stale():
            value=await self.frame();value['capturedAt']='2000-01-01T00:00:00Z';return value
        self.native.frame.side_effect=stale
        await self.preview.begin_capture()
        for _ in range(100):
            if self.preview.selection['leaseId'] in self.preview.screen.stopped:break
            await asyncio.sleep(.01)
        self.assertIsNone(self.preview.screen.frame)
        self.assertIn(self.preview.selection['leaseId'],self.preview.screen.stopped)
        self.assertTrue(self.native.stop.called)

    async def test_stop_during_source_read_does_not_claim_capture_failure(self):
        entered=asyncio.Event();release=asyncio.Event();finished=asyncio.Event()
        async def pending():
            entered.set();await release.wait();finished.set();raise ValueError('Selected display stream stopped.')
        self.native.frame.side_effect=pending
        self.native.stop.side_effect=lambda:release.set()
        await self.preview.begin_capture();await entered.wait()
        await self.preview.stop()
        await finished.wait()
        self.assertIsNone(getattr(self.preview,'capture_error',None))
        self.assertIsNone(self.preview.screen.frame)

    async def render_ready(self):
        await self.preview.begin_capture()
        for _ in range(100):
            if self.preview.screen.frame_id:return
            await asyncio.sleep(.01)
        self.fail('Fixture frame unavailable')

    async def test_stop_discards_inflight_render_without_waiting_for_worker(self):
        await self.render_ready()
        entered=threading.Event();release=threading.Event()
        original=ScreenCamera.render_from_snapshot
        def blocked(snapshot):
            entered.set();release.wait(2);return original(snapshot)
        with patch.object(ScreenCamera,'render_from_snapshot',side_effect=blocked):
            task=asyncio.create_task(self.preview.render_image())
            try:
                while not entered.is_set():await asyncio.sleep(.001)
                await self.preview.stop()
                self.assertIsNone(self.preview.screen.frame)
                self.assertFalse(task.done())
            finally:release.set()
            with self.assertRaises(web.HTTPGone):await task
        self.assertEqual(self.preview.render_count,0)

    async def test_cancellation_holds_single_render_slot_until_worker_finishes(self):
        await self.render_ready()
        entered=threading.Event();release=threading.Event()
        original=ScreenCamera.render_from_snapshot
        def blocked(snapshot):
            entered.set();release.wait(2);return original(snapshot)
        with patch.object(ScreenCamera,'render_from_snapshot',side_effect=blocked):
            task=asyncio.create_task(self.preview.render_image())
            try:
                while not entered.is_set():await asyncio.sleep(.001)
                task.cancel();await asyncio.sleep(.01)
                task.cancel();await asyncio.sleep(.01)
                self.assertTrue(self.preview.render_lock.locked())
                with self.assertRaises(web.HTTPTooManyRequests):await self.preview.render_image()
            finally:release.set()
            with self.assertRaises(asyncio.CancelledError):await task
        self.assertFalse(self.preview.render_lock.locked())
        self.assertEqual(self.preview.render_count,0)

    async def test_overlay_expiry_during_render_discards_expired_pixels(self):
        await self.render_ready()
        camera=self.preview.screen.camera;state=camera.status()
        camera.command({'version':1,'commandId':'expiring_render_context','expectedRevision':state['revision'],
            'sourceFrameId':state['sourceFrameId'],'geometryGeneration':state['geometryGeneration'],
            'op':'context','text':'Transient fixture','ttlMs':100})
        entered=threading.Event();release=threading.Event()
        original=ScreenCamera.render_from_snapshot
        def blocked(snapshot):
            entered.set();release.wait(2);return original(snapshot)
        with patch.object(ScreenCamera,'render_from_snapshot',side_effect=blocked):
            task=asyncio.create_task(self.preview.render_image())
            try:
                while not entered.is_set():await asyncio.sleep(.001)
                await asyncio.sleep(.12)
            finally:release.set()
            with self.assertRaises(web.HTTPConflict):await task
        self.assertIsNone(camera.context)
        self.assertEqual(self.preview.render_count,0)

    async def test_presentation_mutation_discards_inflight_render(self):
        await self.render_ready()
        entered=threading.Event();release=threading.Event()
        original=ScreenCamera.render_from_snapshot
        def blocked(snapshot):
            entered.set();release.wait(2);return original(snapshot)
        with patch.object(ScreenCamera,'render_from_snapshot',side_effect=blocked):
            task=asyncio.create_task(self.preview.render_image())
            try:
                while not entered.is_set():await asyncio.sleep(.001)
                camera=self.preview.screen.camera;state=camera.status()
                camera.command({'version':1,'commandId':'pin_render_race','expectedRevision':state['revision'],
                    'sourceFrameId':state['sourceFrameId'],'geometryGeneration':state['geometryGeneration'],'op':'pin'})
            finally:release.set()
            with self.assertRaises(web.HTTPConflict):await task
        self.assertEqual(self.preview.render_count,0)


class DisplayPreviewConfigurationTests(unittest.TestCase):
    def test_stream_is_explicit_display_only_with_bounded_cadence(self):
        base={'mode':'actual','surface':{'kind':'display','id':'1','displayId':1},'displayStream':True}
        for change in [{'mode':'synthetic'},{'surface':{'kind':'window','id':'9','displayId':1,'ownerPid':1}},
                       {'sourceFps':16},{'sourceFps':True},{'renderFps':31},{'renderFps':0},{'displayStream':'true'}]:
            with self.assertRaises(ValueError):Preview({**base,**change})
