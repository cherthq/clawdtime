import asyncio
import copy
import tempfile
import time
import unittest
from preview_native import NativePreviewController, operation, fingerprint


def fixture():
    return {'version':1,'operationId':'op_1','sceneId':'scene','generation':1,'action':'activate_app',
        'window':{'appId':'com.apple.TextEdit','windowId':'77','ownerPid':42,'displayId':1},
        'expected':{'requestId':'request','sessionId':'session','leaseId':'lease','epoch':1,'cursor':0,'policyRevision':1,'displayId':1}}


class NativeControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.calls=[];self.authorities=0
        self.fail_authority=False;self.mode='verified';self.block=None;self.identity='process_identity'
        self.controller=NativePreviewController('unused',self.authority,self.tmp.name+'/receipts.sqlite',self.transport)
        await self.controller.qualify(fixture());self.calls.clear();self.authorities=0
    async def asyncTearDown(self):
        await self.controller.stop();self.controller.db.close();self.tmp.cleanup()
    async def authority(self,op):
        self.authorities+=1
        if self.fail_authority and self.authorities>1:raise ValueError('revoked')
        return {**op['expected'],'expiresAt':time.time()*1000+1500}
    def observation(self):
        return {'window':fixture()['window'],'observedAt':time.time()*1000,'processIdentity':self.identity,
            'windowBounds':{'x':8,'y':46,'width':800,'height':600},'appActive':True,'windowFocused':True,'windowOnScreen':True}
    async def transport(self,wire):
        self.calls.append(copy.deepcopy(wire))
        if wire['op']=='qualify':
            return {'v':1,'requestId':wire['requestId'],'status':'qualified','targetToken':'token',
                'wireTarget':{**wire['target'],'titleHash':'a'*64,'bounds':self.observation()['windowBounds']},'observation':self.observation()}
        if self.block:
            self.block.set();await asyncio.Event().wait()
        if self.mode=='timeout':raise TimeoutError()
        observed=self.observation()
        if self.mode in ('false_verified','submitted'):observed['windowFocused']=False
        return {'v':1,'requestId':wire['requestId'],'status':'verified' if self.mode=='false_verified' else self.mode,
            'effectAttempted':True,'reason':'target_foreground','observation':observed}
    async def test_one_effect_and_exact_duplicate_returns_original_receipt(self):
        op=fixture();mark=fingerprint(op)
        first=await self.controller.execute(op,mark)
        self.assertEqual(first['state'],'verified');self.assertIn('terminalEvidence',first)
        self.assertEqual(self.authorities,2);self.assertEqual([c['op'] for c in self.calls],['qualify','activate'])
        self.assertLessEqual(self.calls[1]['expiresAt'],self.calls[0]['expiresAt'])
        self.assertEqual(await self.controller.execute(op,mark),first);self.assertEqual(len(self.calls),2)
        self.assertEqual(self.controller.receipt(op['operationId'],mark),first)
    async def test_authority_loss_after_qualification_never_submits_effect(self):
        self.fail_authority=True;op=fixture()
        result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'rejected');self.assertEqual([c['op'] for c in self.calls],['qualify'])
    async def test_unknown_and_duplicate_never_retry_and_have_no_terminal_evidence(self):
        for mode in ('timeout','unknown','false_verified'):
            self.mode=mode;op=fixture()
            result=await self.controller.execute(op,fingerprint(op))
            self.assertEqual(result['state'],'uncertain');self.assertNotIn('terminalEvidence',result)
            count=len(self.calls)
            self.assertEqual(await self.controller.execute(op,fingerprint(op)),result);self.assertEqual(len(self.calls),count)
            if self.controller.closed:break
    async def test_native_unknown_has_no_terminal_evidence(self):
        self.mode='unknown';op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'uncertain');self.assertNotIn('terminalEvidence',result)
    async def test_false_verification_cannot_be_upgraded(self):
        self.mode='false_verified';op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'uncertain');self.assertNotIn('terminalEvidence',result)
    async def test_returned_native_call_with_unverified_focus_is_returned_not_submitted(self):
        self.mode='submitted';op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'returned');self.assertIn('terminalEvidence',result)
        self.assertFalse(result['observation']['windowFocused'])
    async def test_false_rejection_cannot_settle_attempted_effect(self):
        self.mode='rejected';op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'uncertain');self.assertNotIn('terminalEvidence',result)
    async def test_process_change_after_external_qualification_refuses_before_effect(self):
        self.identity='new_process';op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'rejected');self.assertEqual([c['op'] for c in self.calls],['qualify'])
    async def test_external_qualification_age_is_not_restamped(self):
        mark,observation,_=self.controller.qualifications['op_1']
        self.controller.qualifications['op_1']=(mark,observation,time.monotonic()-2)
        op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'rejected');self.assertEqual(self.calls,[])
    async def test_qualification_propagates_only_fixed_native_stage(self):
        async def refused(wire):return {'status':'rejected','reason':'app_launch_identity_unavailable'}
        self.controller.transport=refused
        with self.assertRaisesRegex(ValueError,'^app_launch_identity_unavailable$'):await self.controller.qualify(fixture())
        async def private(wire):return {'status':'rejected','reason':'unrecognized detail must not leave native host'}
        self.controller.transport=private
        with self.assertRaisesRegex(ValueError,'^qualification_unavailable$'):await self.controller.qualify(fixture())
    async def test_broker_shape_binding_and_expiry_have_separate_fixed_stages(self):
        for wrong,stage in [({},'broker_authority_shape'),
                            ({**fixture()['expected'],'displayId':'1','expiresAt':time.time()*1000+1000},'broker_authority_binding'),
                            ({**fixture()['expected'],'expiresAt':0},'broker_authority_expired')]:
            async def authority(op):return wrong
            self.controller.authority=authority
            with self.assertRaisesRegex(ValueError,'^'+stage+'$'):await self.controller.qualify(fixture())
        self.assertEqual(self.calls,[])
    async def test_duplicate_changed_fingerprint_and_denylisted_target_refuse(self):
        op=fixture();await self.controller.execute(op,fingerprint(op));op['action']='raise_window'
        with self.assertRaises(ValueError):await self.controller.execute(op,fingerprint(op))
        op=fixture();op['window']['appId']='com.openai.codex'
        with self.assertRaises(ValueError):await self.controller.execute(op,fingerprint(op))
        self.assertEqual(len(self.calls),2)
    async def test_cancel_after_dispatch_preserves_unknown_and_does_not_replay(self):
        self.block=asyncio.Event();op=fixture();task=asyncio.create_task(self.controller.execute(op,fingerprint(op)))
        await self.block.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        result=self.controller.receipt(op['operationId']);self.assertEqual(result['state'],'uncertain')
        self.assertTrue(self.controller.closed);self.assertEqual(await self.controller.execute(op,fingerprint(op)),result)
    async def test_pending_receipt_survives_controller_restart(self):
        op=fixture();self.controller._save(op,fingerprint(op),{'operationId':op['operationId'],'state':'uncertain','reason':'dispatch_not_confirmed'})
        second=NativePreviewController('unused',self.authority,self.tmp.name+'/receipts.sqlite',self.transport)
        try:
            result=await second.execute(op,fingerprint(op));self.assertEqual(result['state'],'uncertain');self.assertEqual(self.calls,[])
        finally:second.db.close()
    async def test_stop_during_qualification_denies_effect(self):
        original=self.transport
        async def stopped(wire):
            result=await original(wire);await self.controller.stop();return result
        self.controller.transport=stopped;op=fixture();result=await self.controller.execute(op,fingerprint(op))
        self.assertEqual(result['state'],'rejected');self.assertEqual(len(self.calls),1)
    def test_strict_bounded_contract(self):
        for mutate in (lambda op:op.update(script='anything'),lambda op:op['window'].update(ownerPid=True),
                       lambda op:op['expected'].update(epoch=0),lambda op:op.update(action='type')):
            op=fixture();mutate(op)
            with self.assertRaises(ValueError):operation(op)

class NativePreviewRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from camera_preview import Preview
        from aiohttp import ClientSession
        from unittest.mock import AsyncMock
        self.tmp=tempfile.TemporaryDirectory()
        self.preview=Preview({'mode':'actual','surface':{'kind':'display','id':'1','displayId':1},'nativeControl':True,
            'nativePresentation':True,'nativePresentationToken':'h'*40,'nativeReceiptPath':self.tmp.name+'/native.sqlite',
            'backendOrigin':'http://127.0.0.1:9999','backendToken':'b'*40})
        self.preview.native_command=AsyncMock(return_value={'surface':self.preview.surface,'windowFrame':[0,0,1000,800],'displayBounds':[0,0,1000,800]})
        self.info=await self.preview.setup();self.http=ClientSession()
        self.preview.backend=AsyncMock(return_value={'prepared':None,'state':'idle'})
        self.preview.native_executor.qualify=AsyncMock(return_value={'fixture':True})
    async def asyncTearDown(self):
        await self.http.close();await self.preview.close();self.preview.native_executor.db.close();self.tmp.cleanup()
    async def test_browser_cannot_dispatch_native_payload_and_backend_origin_rejected(self):
        path=self.info['origin']+'/sessions/'+self.preview.sid+'/native/qualify'
        async with self.http.post(path,json={'operation':fixture()},headers={'Authorization':'Bearer '+self.preview.token}) as r:self.assertEqual(r.status,401)
        async with self.http.post(path,json={'operation':fixture()},headers={'Authorization':'Bearer '+'h'*40,'Origin':self.info['origin']}) as r:self.assertEqual(r.status,403)
        self.preview.native_executor.qualify.assert_not_called()
        async with self.http.post(path,json={'operation':fixture()},headers={'Authorization':'Bearer '+'h'*40}) as r:self.assertEqual(r.status,200)
        self.preview.native_executor.qualify.assert_awaited_once()
    async def test_ui_transmits_prepared_id_only_and_stop_preserves_receipts(self):
        headers={'Authorization':'Bearer '+self.preview.token}
        async with self.http.post(self.info['origin']+'/preview/native/execute',json={'operationId':'op_1','operation':fixture()},headers=headers) as r:self.assertEqual(r.status,400)
        async with self.http.post(self.info['origin']+'/preview/native/execute',json={'operationId':'op_1'},headers=headers) as r:self.assertEqual(r.status,200)
        self.preview.backend.assert_awaited_with('/local-native/'+self.preview.sid+'/execute',{'operationId':'op_1'})
        op=fixture();self.preview.native_executor._save(op,fingerprint(op),{'operationId':'op_1','state':'uncertain','reason':'fixture_unknown'})
        await self.preview.stop()
        path=self.info['origin']+'/sessions/'+self.preview.sid+'/native/receipts/op_1'
        async with self.http.get(path,headers={'Authorization':'Bearer '+'h'*40}) as r:
            self.assertEqual(r.status,200);self.assertEqual((await r.json())['state'],'uncertain')
        import os
        self.assertTrue(os.path.isfile(self.tmp.name+'/native.sqlite'))
    async def test_host_qualification_409_is_fixed_metadata_json(self):
        path=self.info['origin']+'/sessions/'+self.preview.sid+'/native/qualify'
        for raw,expected in [('ax_windows_unavailable','ax_windows_unavailable'),('unrecognized diagnostic detail','qualification_unavailable')]:
            self.preview.native_executor.qualify.side_effect=ValueError(raw)
            async with self.http.post(path,json={'operation':fixture()},headers={'Authorization':'Bearer '+'h'*40}) as response:
                self.assertEqual(response.status,409)
                self.assertEqual(await response.json(),{'error':'native_qualification_unavailable','reason':expected})
    async def test_media_preflight_identifies_layer_before_broker_or_native(self):
        with self.assertRaisesRegex(ValueError,'^media_not_started$'):await self.preview.native_authority(fixture())
        self.preview.backend.assert_not_called()
    async def test_live_presentation_route_requires_backend_only_credential(self):
        from unittest.mock import AsyncMock
        self.preview.presentation_controller.present=AsyncMock(return_value={'fixture':True})
        path=self.info['origin']+'/sessions/'+self.preview.sid+'/native/present'
        body={'presentation':{},'fingerprint':'a'*64}
        async with self.http.post(path,json=body,headers={'Authorization':'Bearer '+self.preview.token}) as response:self.assertEqual(response.status,401)
        self.preview.presentation_controller.present.assert_not_called()
        async with self.http.post(path,json=body,headers={'Authorization':'Bearer '+'h'*40}) as response:self.assertEqual(response.status,200)
        self.preview.presentation_controller.present.assert_awaited_once()
