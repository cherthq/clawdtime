import asyncio
import base64
from datetime import datetime,timedelta,timezone
import io
import hashlib
from types import SimpleNamespace
import time
import unittest
from unittest.mock import AsyncMock,Mock,patch
from PIL import Image
from devices import ScreenController
from server import Session
import test_service


def selection(lease='lease-1'):
    return {'leaseId':lease,'deviceId':'mac','alias':'Test Mac','memberId':'member','callId':'call','displayId':1,'mode':'view','expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat()}

def policy(selected):
    return {'callId':'call','state':'listening','expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),'screenSelection':selected}


class ScreenTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        owner=SimpleNamespace(env={'DEVICE_GATEWAY_URL':'http://127.0.0.1:4214','DEVICE_GATEWAY_KEY':'g'*32},backend=AsyncMock())
        session=SimpleNamespace(owner=owner,id='session',call_id='call',active=True,closing=False)
        screen=ScreenController(session);screen.release=AsyncMock();return screen

    async def test_terminal_notification_survives_policy_cancelling_capture(self):
        screen=self.make()
        selected=selection()
        entered=asyncio.Event();finish=asyncio.Event()
        async def release(_):
            entered.set()
            await finish.wait()
            return True
        screen.release=AsyncMock(side_effect=release)
        screen.selection=selected;screen.created.add(selected['leaseId'])
        old=asyncio.create_task(screen.terminal(selected,'helper_stopped'))
        screen.task=old
        await asyncio.wait_for(entered.wait(),1)
        screen.update(policy(selected))
        await asyncio.sleep(0)
        self.assertTrue(old.cancelled())
        self.assertIsNone(screen.frame)
        self.assertIsNone(screen.selection)
        finish.set()
        await asyncio.wait_for(screen.terminal_tasks[selected['leaseId']],1)
        await screen.terminal(selected,'helper_stopped')
        screen.owner.backend.assert_awaited_once_with('/media/session/screen-stopped',{'leaseId':'lease-1','reason':'helper_stopped'})
        screen.release.assert_awaited_once_with(selected)
        self.assertIsNone(screen.task)
        screen.update(policy(selected))
        self.assertIsNone(screen.selection)
        await screen.close()

    async def test_switch_revoke_and_stale_frame_clear_without_auto_reacquire(self):
        screen=self.make();screen.poll=AsyncMock()
        first=selection();screen.update(policy(first));screen.frame=Image.new('RGB',(100,100),'red')
        screen.frame_id='old';screen.received_at=time.monotonic();screen.captured_at=datetime.now(timezone.utc).isoformat()
        self.assertEqual(screen.status()['frameId'],'old')
        screen.update(policy(selection('lease-2')))
        self.assertIsNone(screen.frame)
        self.assertIn('lease-1',screen.stopped)
        screen.frame=Image.new('RGB',(100,100),'blue');screen.received_at=time.monotonic()-2.1;screen.captured_at=datetime.now(timezone.utc).isoformat()
        self.assertIsNone(screen.status()['frameId']);self.assertIsNone(screen.frame)
        screen.update({});screen.update(policy(first))
        self.assertIsNone(screen.selection)
        await screen.close()

    async def test_foreign_call_and_expired_policy_never_start_capture(self):
        screen=self.make();screen.poll=AsyncMock()
        screen.update({**policy(selection()),'callId':'foreign'})
        self.assertIsNone(screen.selection)
        screen.update({**policy(selection()),'expiresAt':'2000-01-01T00:00:00Z'})
        self.assertIsNone(screen.selection)
        screen.poll.assert_not_called();await screen.close()

    async def test_frame_snapshot_is_ephemeral_bound_and_holds_only_fresh_input_frame(self):
        screen=self.make();screen.poll=AsyncMock();screen.update(policy(selection()))
        screen.frame=Image.new('RGB',(640,360),'blue');screen.frame_id='frame-observed';screen.state='viewing'
        screen.received_at=time.monotonic();screen.captured_at=datetime.now(timezone.utc).isoformat()
        observed=await screen.observed(include_frame=True)
        decoded=base64.b64decode(observed['jpegBase64'])
        self.assertEqual(observed['sha256'],hashlib.sha256(decoded).hexdigest())
        self.assertEqual(observed['leaseId'],'lease-1');self.assertEqual(observed['frameId'],'frame-observed')
        self.assertTrue(0<screen.hold_until-time.monotonic()<=1.5)
        self.assertEqual((await screen.observed(include_frame=True))['sha256'],observed['sha256'])
        screen.update({})
        with self.assertRaises(ValueError):await screen.observed(include_frame=True)
        await screen.close()

    async def test_delayed_old_device_frame_cannot_paint_after_switch(self):
        screen=self.make();begun=asyncio.Event();release=asyncio.Event()
        buf=io.BytesIO();Image.new('RGB',(100,100),'red').save(buf,'JPEG')
        async def request(method,path,body=None,frame=False):
            if method=='GET':
                begun.set()
                try:await release.wait()
                except asyncio.CancelledError:await release.wait()
                return 200,buf.getvalue(),{'x-frame-id':'old','x-captured-at':datetime.now(timezone.utc).isoformat(),'x-frame-width':'100','x-frame-height':'100'}
            return 200,b'{}',{}
        screen.request=request;screen.update(policy(selection()))
        await asyncio.wait_for(begun.wait(),1)
        old=screen.task
        screen.update({});release.set();await old
        self.assertIsNone(screen.frame);self.assertIsNone(screen.selection)
        await screen.close()


class DeviceRouteTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=test_service.ServiceTests.asyncSetUp
    asyncTearDown=test_service.ServiceTests.asyncTearDown

    async def test_receipt_reconciles_after_session_objects_are_lost_on_restart(self):
        sid='ct_'+'e'*40
        self.service.db.execute('INSERT INTO device_actions VALUES(?,?,?,?,?,NULL)',('action',sid,'lease-1','fingerprint','unknown'))
        self.service.db.commit()
        self.assertNotIn(sid,self.service.sessions)
        request=AsyncMock(return_value=(200,b'{"id":"action","leaseId":"lease-1","state":"submitted"}',{}))
        with patch('device_actions.gateway_request',request):
            result=await self.client.get(f'/sessions/{sid}/screen/actions/action',headers={'Authorization':'Bearer '+'m'*32})
            self.assertEqual((await result.json())['state'],'submitted')
        request.assert_awaited_once_with(self.service,'GET','/v1/leases/lease-1/actions/action')

    async def test_relay_has_separate_credential_and_bounded_unknown_disconnect(self):
        self.service.env['DEVICE_GATEWAY_KEY']='g'*32
        self.assertEqual((await self.client.get('/device-gateway',headers={'Authorization':'Bearer '+'m'*32})).status,401)
        socket=await self.client.ws_connect('/device-gateway',headers={'Authorization':'Bearer '+'g'*32})
        self.assertTrue(self.service.device_relay.connected)
        self.assertEqual((await self.client.get('/sessions/ct_'+'a'*40,headers={'Authorization':'Bearer '+'g'*32})).status,401)
        task=asyncio.create_task(self.service.device_relay.request('GET','/v1/leases/lease/frame'))
        request=await socket.receive_json()
        await socket.send_json({'id':request['id'],'status':200,'headers':{'X-Frame-Id':'frame'},'body':base64.b64encode(b'jpeg').decode()})
        self.assertEqual((await task)[1],b'jpeg')
        task=asyncio.create_task(self.service.device_relay.request('POST','/v1/leases',{}))
        await socket.receive_json();await socket.close()
        with self.assertRaises(ConnectionError):await task
        self.assertEqual(len(self.service.device_relay.pending),0)

    async def test_control_receipt_unknown_reconciles_without_reposting(self):
        sid='ct_'+'d'*40
        session=Session(self.service,{'id':sid,'meetingId':'meeting','lineId':'line'})
        bound={**selection(),'mode':'control'}
        posts=[]
        async def request(method,path,body=None):
            posts.append(method)
            if method=='POST':raise TimeoutError()
            return 200,b'{"id":"action","leaseId":"lease-1","state":"submitted"}',{}
        session.screen=SimpleNamespace(update=lambda p:None,selection=bound,status=lambda:{'state':'viewing','frameId':'frame'},request=request,close=AsyncMock(),clear=Mock())
        session.close=AsyncMock();self.service.sessions[sid]=session
        self.service.backend=AsyncMock(return_value=policy(bound))
        body={k:bound[k] for k in ('leaseId','callId','memberId','deviceId','displayId')}
        body.update(id='action',frameId='frame',type='click',x=.2,y=.3)
        headers={'Authorization':'Bearer '+'m'*32}
        result=await self.client.post(f'/sessions/{sid}/screen/actions',json=body,headers=headers)
        self.assertEqual(result.status,503)
        result=await self.client.post(f'/sessions/{sid}/screen/actions',json=body,headers=headers)
        self.assertEqual((await result.json())['state'],'unknown')
        result=await self.client.get(f'/sessions/{sid}/screen/actions/action',headers=headers)
        self.assertEqual((await result.json())['evidence'],'os_event_posted')
        self.assertEqual(posts,['POST','GET'])

if __name__=='__main__':unittest.main()

class ScreenStartupAndSwitchTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        owner=SimpleNamespace(env={'DEVICE_GATEWAY_URL':'http://127.0.0.1:4214','DEVICE_GATEWAY_KEY':'g'*32},backend=AsyncMock())
        session=SimpleNamespace(owner=owner,id='session',call_id='call',active=False,closing=False,spec={'screen':True})
        return ScreenController(session)

    async def test_startup_scene_has_no_capture_and_changes_only_after_active_policy(self):
        screen=self.make();screen.poll=AsyncMock();screen.release=AsyncMock(return_value=True)
        self.assertTrue(screen.starting)
        first=screen.render()
        screen.update(policy(selection()))
        self.assertIsNone(screen.selection);screen.poll.assert_not_called()
        self.assertTrue(screen.starting)
        self.assertEqual(first.tobytes(),screen.render().tobytes())
        screen.session.active=True
        screen.update({**policy(selection()),'state':'preparing'})
        self.assertTrue(screen.starting);self.assertIsNone(screen.selection)
        self.assertEqual(first.tobytes(),screen.render().tobytes())
        screen.update(policy(selection()))
        await screen.transition_task;await asyncio.sleep(0)
        self.assertFalse(screen.starting);screen.poll.assert_awaited_once()
        self.assertNotEqual(first.tobytes(),screen.render().tobytes())
        await screen.close()

    async def test_replacement_waits_for_confirmed_release_before_capture(self):
        screen=self.make();screen.session.active=True
        polls=[];deleting=asyncio.Event();release=asyncio.Event()
        async def poll(generation):
            polls.append(screen.selection['leaseId']);screen.created.add(screen.selection['leaseId'])
            await asyncio.Event().wait()
        async def stop(old):
            deleting.set();await release.wait();return True
        screen.poll=poll;screen.release=stop
        screen.update(policy(selection('view')));await screen.transition_task;await asyncio.sleep(0)
        screen.update(policy({**selection('control'),'mode':'control'}))
        await asyncio.wait_for(deleting.wait(),1)
        self.assertEqual(polls,['view'])
        release.set();await screen.transition_task;await asyncio.sleep(0)
        self.assertEqual(polls,['view','control'])
        await screen.close()

    async def test_uncertain_release_stops_replacement_without_create(self):
        screen=self.make();screen.session.active=True
        polls=[]
        async def poll(generation):
            polls.append(screen.selection['leaseId']);screen.created.add(screen.selection['leaseId'])
            await asyncio.Event().wait()
        screen.poll=poll;screen.release=AsyncMock(return_value=False)
        screen.update(policy(selection('view')));await screen.transition_task;await asyncio.sleep(0)
        latest_possible_expiry=time.time()+28
        screen.requested_expiry['view']=latest_possible_expiry
        screen.update(policy({**selection('control'),'mode':'control'}));await screen.transition_task
        self.assertEqual(polls,['view']);self.assertIn('control',screen.stopped)
        self.assertGreater(screen.release_blocked_until,time.time())
        self.assertGreaterEqual(screen.release_blocked_until,latest_possible_expiry)
        screen.owner.backend.assert_awaited_with('/media/session/screen-stopped',{'leaseId':'control','reason':'previous_release_unconfirmed'})
        await screen.close()

class ActivationWakeTests(unittest.IsolatedAsyncioTestCase):
    async def test_notice_finishes_before_capture_and_immediately_wakes_policy(self):
        fetched=asyncio.Event();notice_started=asyncio.Event();notice_done=asyncio.Event()
        async def backend(path):
            fetched.set();return policy(None)
        owner=SimpleNamespace(env={},backend=AsyncMock(side_effect=backend),cancel_speech=lambda sid:None)
        session=Session(owner,{'id':'ct_'+'b'*40,'meetingId':'m','lineId':'l'})
        session.stop_stt=AsyncMock()
        async def notice(text):
            notice_started.set();await notice_done.wait()
        session.say=notice
        watcher=asyncio.create_task(session.watch_policy())
        try:
            await asyncio.sleep(.05)
            activating=asyncio.create_task(session.activate('call'))
            await notice_started.wait()
            self.assertFalse(session.active);owner.backend.assert_not_called()
            notice_done.set()
            await activating
            await asyncio.wait_for(fetched.wait(),.2)
            self.assertTrue(session.active);self.assertTrue(session.allowed)
        finally:
            watcher.cancel();await asyncio.gather(watcher,return_exceptions=True)

class ScreenPresentationTests(unittest.IsolatedAsyncioTestCase):
    async def test_screen_call_never_falls_back_to_captions_after_terminal_and_selection_clear(self):
        from captions import CaptionScene,CaptionPublisher
        screen=ScreenStartupAndSwitchTests().make()
        screen.poll=AsyncMock();screen.release=AsyncMock(return_value=True)
        scene=CaptionScene('meeting')
        scene.apply_policy({**policy(None),'captionsEnabled':True})
        sdk=SimpleNamespace(VideoFrame=lambda width,height,kind,data:data,VideoBufferType=SimpleNamespace(RGBA=1))
        publisher=CaptionPublisher(scene,None,sdk=sdk,screen=screen)
        publisher.source=Mock()
        publisher.renderer.render=Mock(side_effect=AssertionError('Screen call fell back to notes'))
        publisher.emit()  # first video frame is the screen connecting scene
        screen.session.active=True
        selected=selection()
        screen.update(policy(selected));await screen.transition_task;await asyncio.sleep(0)
        screen.frame=Image.new('RGB',(640,360),'red');screen.frame_id='private'
        screen.captured_at=datetime.now(timezone.utc).isoformat();screen.received_at=time.monotonic()
        screen.state='viewing';screen.revision+=1
        publisher.emit();private_frame=publisher.frame
        await screen.terminal(selected,'helper_stopped')
        screen.update(policy(None));await screen.transition_task
        publisher.emit()
        self.assertTrue(screen.screen_call);self.assertIsNone(screen.selection);self.assertIsNone(screen.frame)
        self.assertNotEqual(private_frame,publisher.frame)
        self.assertEqual(screen.state,'stopped')
        publisher.renderer.render.assert_not_called()
        screen.update(policy(selected))  # the same stopped lease must not restart
        screen.poll.assert_awaited_once()
        self.assertIsNone(screen.selection)
        fresh={**selection('explicit-new-lease')}
        screen.update(policy(fresh));await screen.transition_task;await asyncio.sleep(0)
        self.assertEqual(screen.poll.await_count,2)
        await screen.close()

    async def test_caption_origin_call_can_return_to_captions_after_explicit_screen_stop(self):
        from captions import CaptionScene,CaptionPublisher
        screen=ScreenTests().make();screen.poll=AsyncMock();screen.release=AsyncMock(return_value=True)
        self.assertFalse(screen.screen_call)
        scene=CaptionScene('meeting')
        scene.apply_policy({**policy(None),'captionsEnabled':True})
        sdk=SimpleNamespace(VideoFrame=lambda width,height,kind,data:data,VideoBufferType=SimpleNamespace(RGBA=1))
        publisher=CaptionPublisher(scene,None,sdk=sdk,screen=screen);publisher.source=Mock()
        publisher.renderer.render=Mock(wraps=publisher.renderer.render)
        screen.update(policy(selection()));await screen.transition_task;await asyncio.sleep(0)
        publisher.emit();publisher.renderer.render.assert_not_called()
        screen.update(policy(None));await screen.transition_task
        publisher.emit();publisher.renderer.render.assert_called_once()
        await screen.close()
