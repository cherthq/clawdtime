"""Versioned authority and local policy remain separate from old control ACLs."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from service import Gateway, validate_lease


def lease(epoch=0, executor='none', mode='view'):
    return {'id':'lease','deviceId':'mac','memberId':'person','callId':'call','displayId':1,
            'mode':mode,'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=25)).isoformat(),
            'protocolVersion':2,'sessionId':'session','executorEpoch':epoch,'policyRevision':1,'executor':executor}


class ExecutionPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.received=[];self.refuse_renew=False
        self.delay_old=False;self.old_entered=asyncio.Event();self.old_release=asyncio.Event()
        self.active_lease=None;self.armed=True
        self.presentation_version=None;self.panels=[];self.status_unavailable=False
        self.command={'id':'command','sessionId':'session','callId':'call','type':'mute'}
        async def helper(request):
            self.received.append(request.path)
            if request.path=='/v1/status' and self.status_unavailable:raise web.HTTPServiceUnavailable()
            if request.path=='/v1/status':return web.json_response({'deviceId':'mac','armed':self.armed,'activeLeaseId':self.active_lease,'available':True,'screenPermission':True,'controlPermission':True,'controlPolicy':'agent_tools_only','policyRevision':1,'panelCommand':self.command,'unresolvedActionCount':0,**({'presentationVersion':self.presentation_version} if self.presentation_version is not None else {})})
            if request.path=='/v1/displays':return web.json_response([{'id':1,'width':100,'height':100}])
            if request.path=='/v1/permissions':return web.json_response([{'displayId':1,'viewers':['person'],'controllers':['person']}])
            if request.path=='/v1/panel':
                self.panels.append(await request.json())
                return web.json_response({'accepted':True})
            if request.path.endswith('/renew'):
                body=await request.json()
                if self.delay_old and body.get('executorEpoch')==0:
                    self.old_entered.set();await self.old_release.wait()
                if self.refuse_renew:raise web.HTTPServiceUnavailable()
            return web.json_response({'accepted':True})
        app=web.Application();app.router.add_route('*','/{tail:.*}',helper)
        self.helper=TestServer(app);await self.helper.start_server()
        self.gateway=Gateway({'DEVICE_GATEWAY_KEY':'g'*32,'DEVICE_GATEWAY_DATABASE_PATH':str(Path(self.tmp.name)/'gateway.sqlite')},{'mac':{'url':str(self.helper.make_url('')).rstrip('/'),'key':'h'*32}})
        self.client=TestClient(TestServer(self.gateway.app()));await self.client.start_server()
        self.headers={'Authorization':'Bearer '+'g'*32}

    async def asyncTearDown(self):
        await self.client.close();await self.helper.close();self.tmp.cleanup()

    async def test_same_lease_handoff_rejects_old_epoch_and_retains_unknown_transition(self):
        self.assertEqual((await self.client.post('/v1/leases',json=lease(),headers=self.headers)).status,200)
        self.assertEqual((await self.client.post('/v1/leases/lease/renew',json=lease(1,'native'),headers=self.headers)).status,200)
        count=len(self.received)
        self.assertEqual((await self.client.post('/v1/leases/lease/renew',json=lease(),headers=self.headers)).status,409)
        self.assertEqual(len(self.received),count)
        self.refuse_renew=True
        self.assertEqual((await self.client.post('/v1/leases/lease/renew',json=lease(2,'clawdtime','control'),headers=self.headers)).status,503)
        body,state,_,_=self.gateway.lease('lease')
        self.assertEqual(state,'creating_unknown');self.assertEqual(body['executorEpoch'],2)
        self.assertEqual((await self.client.post('/v1/leases/lease/actions',json={'id':'a','frameId':'f','type':'click','x':.5,'y':.5},headers=self.headers)).status,410)

    async def test_late_old_renewal_cannot_overwrite_new_executor(self):
        await self.client.post('/v1/leases',json=lease(),headers=self.headers)
        self.delay_old=True
        previous=asyncio.create_task(self.client.post('/v1/leases/lease/renew',json=lease(),headers=self.headers))
        await asyncio.wait_for(self.old_entered.wait(),1)
        self.assertEqual((await self.client.post('/v1/leases/lease/renew',json=lease(1,'native'),headers=self.headers)).status,200)
        self.old_release.set()
        self.assertEqual((await previous).status,409)
        body,state,_,_=self.gateway.lease('lease')
        self.assertEqual(state,'active');self.assertEqual(body['executorEpoch'],1)

    async def test_readiness_keeps_fallback_permission_distinct_and_forwards_scoped_command(self):
        result=await (await self.client.get('/v1/devices/mac/readiness/person/1',headers=self.headers)).json()
        self.assertTrue(result['controlAllowed'])
        self.assertEqual(result['controlPolicy'],'agent_tools_only')
        self.assertEqual(result['policyRevision'],1)
        self.assertEqual(result['panelCommand'],self.command)
        self.assertEqual((await self.client.post('/v1/devices/mac/panel',json={'sessionId':'session'},headers=self.headers)).status,200)
        self.assertEqual((await self.client.post('/v1/devices/other/panel',json={},headers=self.headers)).status,404)

    async def test_readiness_reports_exact_active_lease_and_local_stop_without_rearming(self):
        path='/v1/devices/mac/readiness/person/1'
        self.active_lease='lease-current'
        active=await (await self.client.get(path,headers=self.headers)).json()
        self.assertTrue(active['activeLease']);self.assertTrue(active['armed'])
        self.assertEqual(active['activeLeaseId'],'lease-current')
        self.active_lease=None;self.armed=False
        stopped=await (await self.client.get(path,headers=self.headers)).json()
        self.assertFalse(stopped['activeLease']);self.assertFalse(stopped['armed'])
        self.assertNotIn('activeLeaseId',stopped)
        self.assertTrue(all(p in ('/v1/status','/v1/displays','/v1/permissions') for p in self.received))
        for invalid in ('', 'wrong/id', True, ['lease']):
            self.active_lease=invalid
            self.assertEqual((await self.client.get(path,headers=self.headers)).status,502)

    def test_partial_or_unsupported_authority_fails_closed(self):
        for changed in ({'executorEpoch':True},{'protocolVersion':3},{'sessionId':''},{'policyRevision':0},{'executor':'other'}):
            with self.assertRaises(web.HTTPBadRequest):validate_lease({**lease(),**changed})
        bad=lease();del bad['sessionId']
        with self.assertRaises(web.HTTPBadRequest):validate_lease(bad)


    async def test_optional_activity_capability_and_old_helper_fallback(self):
        body={'sessionId':'session','presentationVersion':1,'activity':{'version':1,'sequence':1}}
        for version in (None,1,2,True):
            self.presentation_version=version
            result=await (await self.client.get('/v1/devices/mac/readiness/person/1',headers=self.headers)).json()
            self.assertEqual(result.get('presentationVersion'),1 if type(version) is int and version==1 else None)
            response=await self.client.post('/v1/devices/mac/panel',json=body,headers=self.headers)
            self.assertEqual(response.status,200)
            self.assertEqual(self.panels[-1],body if type(version) is int and version==1 else {'sessionId':'session'})
        self.assertEqual(self.gateway.db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)
        self.assertTrue(all(p in ('/v1/status','/v1/displays','/v1/permissions','/v1/panel') for p in self.received))


    async def test_optional_discovery_failure_still_forwards_baseline_control_ack(self):
        self.status_unavailable=True
        body={'sessionId':'session','callId':'call','acknowledgedCommandId':'command',
              'presentationVersion':1,'activity':{'version':1,'sequence':1},'readiness':{'reason':'gateway_absent'}}
        response=await self.client.post('/v1/devices/mac/panel',json=body,headers=self.headers)
        self.assertEqual(response.status,200)
        self.assertEqual(self.panels[-1],{'sessionId':'session','callId':'call','acknowledgedCommandId':'command'})
        self.assertEqual(self.gateway.db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)
