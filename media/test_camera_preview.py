import asyncio
import unittest
from aiohttp import ClientSession
from camera_preview import Preview

class PreviewWireTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.preview=Preview({'durationSeconds':30});self.info=await self.preview.setup();self.http=ClientSession();self.headers={'Authorization':'Bearer '+self.preview.token};self.base=self.info['origin'];self.path='/sessions/'+self.preview.sid+'/screen'
        for _ in range(100):
            if self.preview.screen.frame_id:break
            await asyncio.sleep(.03)
        self.assertIsNotNone(self.preview.screen.frame_id)
    async def asyncTearDown(self):await self.http.close();await self.preview.close()
    async def get(self,path):
        async with self.http.get(self.base+path,headers=self.headers) as r:return r.status,await r.json()
    async def post(self,path,body):
        async with self.http.post(self.base+path,json=body,headers=self.headers) as r:return r.status,await r.text()
    async def test_real_gateway_native_size_camera_status_auth_stop(self):
        status,frame=await self.get(self.path+'/frame');self.assertEqual(status,200);self.assertEqual((frame['width'],frame['height']),(2560,1440));self.assertEqual(frame['camera']['surface'],self.preview.surface)
        status,camera=await self.get(self.path+'/camera');self.assertEqual(status,200)
        cmd={'version':1,'commandId':'focus1','expectedRevision':camera['revision'],'sourceFrameId':camera['sourceFrameId'],'geometryGeneration':camera['geometryGeneration'],'op':'focus_region','rect':{'x':.2,'y':.2,'width':.3,'height':.3},'durationMs':0}
        status,_=await self.post(self.path+'/camera',cmd);self.assertEqual(status,200);self.assertEqual(self.preview.inputs,[])
        async with self.http.get(self.base+self.path+'/camera') as r:self.assertEqual(r.status,401)
        async with self.http.get(self.base+'/sessions/wrong/screen/camera',headers=self.headers) as r:self.assertEqual(r.status,404)
        status,_=await self.post('/preview/stop',{});self.assertEqual(status,200);self.assertIsNone(self.preview.screen.frame)
        status,_=await self.post('/preview/start',{});self.assertEqual(status,410)
    async def test_preview_info_bounds_reload_credential_without_changing_auth(self):
        status,info=await self.get('/preview/info')
        self.assertEqual(status,200);self.assertFalse(info['stopped'])
        self.assertGreater(info['expiresAt'],self.preview.expires_at-1)
        self.assertEqual(info['expiresAt'],self.preview.expires_at)
        async with self.http.get(self.base+'/preview/info') as response:self.assertEqual(response.status,401)
        async with self.http.get(self.base+'/') as response:
            self.assertEqual(response.status,200)
            self.assertNotIn(self.preview.token,await response.text())
        await self.post('/preview/stop',{})
        status,stopped=await self.get('/preview/info')
        self.assertEqual(status,200);self.assertTrue(stopped['stopped'])
        self.assertEqual(stopped['expiresAt'],info['expiresAt'])
        self.preview.deadline=0
        async with self.http.get(self.base+'/preview/info',headers=self.headers) as response:
            self.assertEqual(response.status,410)

    async def test_expiry_and_consumed_observation_clear_camera(self):
        status,frame=await self.get(self.path+'/frame');camera=self.preview.screen.camera
        self.preview.screen.invalidate_input(frame['frameId'],self.preview.selection['leaseId'])
        self.assertEqual(camera.status()['state'],'unavailable');self.assertIsNone(camera.frame_id)
        self.preview.screen.policy_at=0;self.preview.screen.expire();self.assertIsNone(camera.image)
    async def test_actions_go_through_existing_ownership_gateway_receipts(self):
        # Enter a real higher-epoch fixture control lease, then use the normal
        # DeviceActions -> Gateway -> fake helper sink. No OS API exists here.
        self.preview.selection.update(mode='control',executor='clawdtime',executorEpoch=1)
        self.preview.screen.update(self.preview.policy())
        self.assertEqual(self.preview.screen.camera.status()['state'],'unavailable')
        for _ in range(100):
            if self.preview.screen.applied_epoch==1 and self.preview.screen.frame_id:break
            await asyncio.sleep(.03)
        _,frame=await self.get(self.path+'/frame');_,camera=await self.get(self.path+'/camera')
        body={'id':'input1','leaseId':self.preview.selection['leaseId'],'callId':'preview_call','memberId':'preview_member','deviceId':'preview_device','displayId':1,
            'sessionId':'preview_session','executorEpoch':1,'policyRevision':1,'frameId':frame['frameId'],'type':'click','x':.5,'y':.5,
            'presentation':{k:camera[k] for k in ('revision','sourceFrameId','geometryGeneration')}}
        status,text=await self.post(self.path+'/actions',body);self.assertEqual(status,200,text);self.assertEqual(len(self.preview.inputs),1)
        status,_=await self.post(self.path+'/actions',body);self.assertEqual(status,200);self.assertEqual(len(self.preview.inputs),1)
        status,_=await self.post(self.path+'/actions',{**body,'id':'wrong_owner','executorEpoch':0});self.assertEqual(status,409)

if __name__=='__main__':unittest.main()

class ActualPreviewModeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.preview=Preview({'mode':'actual','surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123},'durationSeconds':30,'surfaceLabel':'Finder — <Review>'})
        from unittest.mock import AsyncMock
        self.preview.native_command=AsyncMock(return_value={'surface':self.preview.surface,'windowFrame':[10,10,100,100],'displayBounds':[0,0,1000,800]})
        self.info=await self.preview.setup();self.http=ClientSession();self.headers={'Authorization':'Bearer '+self.preview.token};self.base=self.info['origin']
    async def asyncTearDown(self):await self.http.close();await self.preview.close()
    async def test_actual_ui_requires_start_and_rejects_synthetic_controls(self):
        self.assertFalse(self.preview.started);self.assertIsNone(self.preview.process);self.assertEqual(self.preview.frame_count,0)
        async with self.http.get(self.base+'/') as response:
            html=await response.text()
            self.assertIn('Actual window sharing</h1>',html)
            self.assertIn('<select id="fixture" hidden disabled>',html)
            self.assertIn('<button id="click" hidden disabled>',html)
            self.assertIn('Window 99 · display 1 · process 123',html)
            self.assertIn('<p id="source">Finder — &lt;Review&gt;</p>',html)
            self.assertIn('<details><summary>Diagnostics</summary>',html)
            self.assertIn('<button id="start">Start sharing</button>',html)
            self.assertIn('<button disabled data-op="focus_region">',html)
            self.assertIn('<button id="mark" disabled>',html)
        async with self.http.get(self.base+'/preview/info',headers=self.headers) as response:
            info=await response.json();self.assertEqual(info['inputSink'],'none');self.assertIsNone(info['unavailableReason'])
        for path,body in [('/preview/fixture',{'kind':'finder'}),('/preview/fake-input',{'x':.5,'y':.5})]:
            async with self.http.post(self.base+path,headers=self.headers,json=body) as response:self.assertIn(response.status,(400,403))
        self.assertEqual(self.preview.frame_count,0)
    async def test_actual_source_failure_is_explicit_and_cannot_restart_retired_selection(self):
        from unittest.mock import AsyncMock
        self.preview.native=AsyncMock(side_effect=ValueError('Camera preview unavailable: Exact selected window identity is unavailable.'))
        async with self.http.post(self.base+'/preview/start',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        for _ in range(100):
            if self.preview.selection['leaseId'] in self.preview.screen.stopped:break
            await asyncio.sleep(.01)
        self.assertEqual(self.preview.native.await_count,1)
        async with self.http.get(self.base+'/preview/info',headers=self.headers) as response:
            info=await response.json();self.assertIn('Exact selected window identity is unavailable',info['unavailableReason'])
        self.assertIsNone(self.preview.screen.frame)
        async with self.http.post(self.base+'/preview/stop',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        async with self.http.post(self.base+'/preview/start',headers=self.headers,json={}) as response:self.assertEqual(response.status,410)

    async def test_geometry_race_discards_pixels_and_retries_only_same_selection(self):
        from unittest.mock import AsyncMock
        from service import CameraGeometryChanged
        self.preview.native=AsyncMock(side_effect=[CameraGeometryChanged(),ValueError('Camera preview unavailable: Selected window closed.')])
        async with self.http.post(self.base+'/preview/start',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        for _ in range(100):
            if self.preview.native.await_count:break
            await asyncio.sleep(.005)
        self.assertNotIn(self.preview.selection['leaseId'],self.preview.screen.stopped)
        self.assertIsNone(self.preview.screen.frame)
        self.assertIsNone(self.preview.screen.camera.image)
        self.assertEqual(self.preview.gateway.lease(self.preview.selection['leaseId'])[1],'active')
        for _ in range(100):
            if self.preview.selection['leaseId'] in self.preview.screen.stopped:break
            await asyncio.sleep(.01)
        self.assertEqual(self.preview.native.await_count,2)
        self.assertIn(self.preview.selection['leaseId'],self.preview.screen.stopped)

    async def test_stop_during_geometry_retry_does_not_capture_again(self):
        from unittest.mock import AsyncMock
        from service import CameraGeometryChanged
        self.preview.native=AsyncMock(side_effect=CameraGeometryChanged())
        async with self.http.post(self.base+'/preview/start',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        for _ in range(100):
            if self.preview.native.await_count:break
            await asyncio.sleep(.005)
        async with self.http.post(self.base+'/preview/stop',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        await asyncio.sleep(.25)
        self.assertEqual(self.preview.native.await_count,1)
        self.assertIsNone(self.preview.screen.frame)
        self.assertTrue(self.preview.stopped)

    async def test_initial_off_display_selection_refuses_before_any_capture(self):
        self.preview.native_command.return_value['windowFrame']=[-100,10,100,100]
        async with self.http.post(self.base+'/preview/start',headers=self.headers,json={}) as response:
            self.assertEqual(response.status,409)
            self.assertIn('wholly on its chosen display',await response.text())
        self.assertFalse(self.preview.started);self.assertEqual(self.preview.frame_count,0)
        self.assertIsNone(self.preview.screen.selection)

    async def test_stop_during_initial_metadata_check_cannot_start_capture(self):
        entered=asyncio.Event();release=asyncio.Event()
        async def inspect(mode):
            entered.set();await release.wait()
            return {'surface':self.preview.surface,'windowFrame':[10,10,100,100],'displayBounds':[0,0,1000,800]}
        self.preview.native_command.side_effect=inspect
        task=asyncio.create_task(self.http.post(self.base+'/preview/start',headers=self.headers,json={}))
        await entered.wait()
        async with self.http.post(self.base+'/preview/stop',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        release.set();response=await task
        self.assertEqual(response.status,410);await response.read();response.release()
        self.assertFalse(self.preview.started);self.assertEqual(self.preview.frame_count,0)


class NativeReviewConfigurationTests(unittest.TestCase):
    def test_native_review_is_explicit_actual_and_loopback_authenticated(self):
        surface={'kind':'window','id':'99','displayId':1,'ownerPid':123}
        base={'mode':'actual','surface':surface,'nativeControl':True,
            'backendOrigin':'http://127.0.0.1:4215','backendToken':'b'*32}
        for changes in [{'mode':'synthetic'},{'backendOrigin':''},{'backendOrigin':'https://example.com'},
            {'backendOrigin':'http://127.0.0.1:123@evil.example'},{'backendToken':''},{'nativeControl':'true'}]:
            with self.assertRaises(ValueError):Preview({**base,**changes})

class NativeReviewPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.preview=Preview({'mode':'actual','surface':{'kind':'window','id':'99','displayId':1,'ownerPid':123},
            'nativeControl':True,'backendOrigin':'http://127.0.0.1:1','backendToken':'b'*32,'durationSeconds':30})
        self.info=await self.preview.setup();self.http=ClientSession();self.headers={'Authorization':'Bearer '+self.preview.token};self.base=self.info['origin']
    asyncTearDown=ActualPreviewModeTests.asyncTearDown
    async def test_native_readiness_does_not_enable_capture_or_preview_input(self):
        async with self.http.get(self.base+'/devices/preview_device/readiness',headers=self.headers) as response:
            state=await response.json()
            self.assertEqual(state['controlPolicy'],'agent_tools_only')
            self.assertTrue(state['controlAllowed']);self.assertTrue(state['controlPermission'])
            self.assertFalse(state['activeLease']);self.assertTrue(state['preview'])
        async with self.http.get(self.base+'/preview/info',headers=self.headers) as response:
            state=await response.json();self.assertEqual(state['inputSink'],'none');self.assertFalse(state['started'])
        async with self.http.get(self.base+'/') as response:
            html=await response.text();self.assertIn('native control coordinated separately; no preview input',html)
        async with self.http.post(self.base+'/sessions/'+self.preview.sid+'/screen/actions',headers=self.headers,json={}) as response:self.assertEqual(response.status,409)
        self.assertEqual(self.preview.db.execute('SELECT count(*) FROM device_actions').fetchone()[0],0)
        self.assertEqual(self.preview.frame_count,0);self.assertEqual(self.preview.inputs,[])
        async with self.http.post(self.base+'/preview/stop',headers=self.headers,json={}) as response:self.assertEqual(response.status,200)
        async with self.http.get(self.base+'/devices/preview_device/readiness',headers=self.headers) as response:
            self.assertFalse((await response.json())['controlAllowed'])
