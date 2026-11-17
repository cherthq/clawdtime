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
