import io
import json
import tempfile
from datetime import datetime,timedelta,timezone
from pathlib import Path
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient,TestServer
from PIL import Image
from service import Gateway

class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.creates=0;self.inputs=0;self.local_stop=False;self.actions={}
        buf=io.BytesIO();Image.new('RGB',(640,360),'navy').save(buf,'JPEG');self.jpeg=buf.getvalue()
        async def helper(request):
            self.assertEqual(request.headers.get('Authorization'),'Bearer '+'h'*32)
            if request.path=='/v1/leases':
                self.creates+=1;self.current=await request.json();return web.json_response({'ok':True})
            if '/actions' in request.path:
                if request.method=='POST':
                    self.inputs+=1;a=await request.json()
                    self.actions[a['id']]={**{k:self.current[k] for k in ('deviceId','memberId','callId')},'id':a['id'],'leaseId':self.current['id'],'state':'submitted','evidence':'os_event_posted'}
                    return web.json_response(self.actions[a['id']])
                return web.json_response(self.actions[request.path.split('/')[-1]])
            if self.local_stop:return web.Response(status=423)
            if request.path.endswith('/frame'):
                return web.Response(body=self.jpeg,content_type='image/jpeg',headers={'X-Frame-Id':'frame-1','X-Captured-At':datetime.now(timezone.utc).isoformat(),'X-Frame-Width':'640','X-Frame-Height':'360'})
            return web.json_response({'ok':True})
        app=web.Application();app.router.add_route('*','/{tail:.*}',helper)
        self.helper=TestServer(app);await self.helper.start_server()
        self.env={'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(self.tmp.name)/'gateway.sqlite')}
        self.gateway=Gateway(self.env,{'mac-test':{'url':str(self.helper.make_url('')).rstrip('/'),'key':'h'*32}})
        self.client=TestClient(TestServer(self.gateway.app()));await self.client.start_server()
        self.headers={'Authorization':'Bearer '+'g'*32}
        self.lease={'id':'lease-1','deviceId':'mac-test','memberId':'member','callId':'call','displayId':1,'mode':'control','expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat()}

    async def asyncTearDown(self):
        await self.client.close();await self.helper.close();self.tmp.cleanup()

    async def create(self):
        r=await self.client.post('/v1/leases',json=self.lease,headers=self.headers);self.assertEqual(r.status,200)

    async def test_auth_allowlist_and_stopped_lease_never_reacquire(self):
        self.assertEqual((await self.client.post('/v1/leases',json=self.lease)).status,401)
        self.assertEqual((await self.client.post('/v1/leases',json={**self.lease,'deviceId':'unregistered'},headers=self.headers)).status,403)
        await self.create()
        self.local_stop=True
        self.assertEqual((await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)).status,410)
        self.assertEqual((await self.client.post('/v1/leases',json=self.lease,headers=self.headers)).status,410)
        self.assertEqual(self.creates,1)

    async def test_bound_frames_and_durable_control_receipts_never_replay(self):
        await self.create()
        frame=await self.client.get('/v1/leases/lease-1/frame',headers=self.headers)
        self.assertEqual(frame.status,200);self.assertEqual(await frame.read(),self.jpeg)
        body={'id':'action-1','frameId':'frame-1','type':'type','text':'synthetic private input'}
        r=await self.client.post('/v1/leases/lease-1/actions',json=body,headers=self.headers)
        self.assertEqual(r.status,200);self.assertEqual((await r.json())['state'],'submitted')
        r=await self.client.post('/v1/leases/lease-1/actions',json=body,headers=self.headers)
        self.assertEqual(r.status,200);self.assertEqual(self.inputs,1)
        r=await self.client.post('/v1/leases/lease-1/actions',json={**body,'text':'different'},headers=self.headers)
        self.assertEqual(r.status,409)
        self.assertNotIn('synthetic private input',str(self.gateway.db.execute('SELECT * FROM actions').fetchall()))
        await self.client.delete('/v1/leases/lease-1',headers=self.headers)
        self.assertEqual((await self.client.get('/v1/leases/lease-1/actions/action-1',headers=self.headers)).status,200)

    async def test_restart_tombstones_active_leases_and_rejects_new_control_without_frame(self):
        await self.create()
        body={'id':'action-1','frameId':'frame-1','type':'click','x':.2,'y':.3}
        self.assertEqual((await self.client.post('/v1/leases/lease-1/actions',json=body,headers=self.headers)).status,409)
        other=Gateway(self.env,{})
        try:self.assertEqual(other.lease('lease-1')[1],'stopped')
        finally:other.db.close()
        self.assertEqual((await self.client.post('/v1/leases/lease-1/renew',json=self.lease,headers=self.headers)).status,410)

if __name__=='__main__':unittest.main()

class GatewayReleaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=GatewayTests.asyncSetUp
    asyncTearDown=GatewayTests.asyncTearDown
    create=GatewayTests.create
    async def test_uncertain_helper_delete_does_not_claim_release(self):
        await self.create()
        self.local_stop=True  # helper returns423, not proof of successful deletion
        result=await self.client.delete('/v1/leases/lease-1',headers=self.headers)
        self.assertEqual(await result.json(),{'stopped':True,'released':False})
        self.assertEqual(self.gateway.lease('lease-1')[1],'stopped')

    async def test_successful_helper_delete_reports_confirmation(self):
        await self.create()
        result=await self.client.delete('/v1/leases/lease-1',headers=self.headers)
        self.assertEqual(await result.json(),{'stopped':True,'released':True})

    async def test_pending_create_stays_unconfirmed_after_delete_and_restart(self):
        body=json.dumps(self.lease)
        self.gateway.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,NULL,NULL)',('lease-1','mac-test',body,'digest','creating'))
        self.gateway.db.commit()
        result=await self.client.delete('/v1/leases/lease-1',headers=self.headers)
        self.assertEqual(await result.json(),{'stopped':True,'released':False})
        self.assertEqual(self.gateway.lease('lease-1')[1],'creating_unknown')
        restarted=Gateway(self.env,{})
        try:self.assertEqual(restarted.lease('lease-1')[1],'creating_unknown')
        finally:restarted.db.close()
