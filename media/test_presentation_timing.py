"""Synthetic cloud-hop delays: no network, capture, credentials or native input."""
import asyncio
import time
import unittest
from unittest.mock import AsyncMock

import test_production_presentation as fixtures
from screen_diagnostics import ScreenDiagnostics


class PresentationTimingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture=fixtures.ProductionPresentationTests()
        await self.fixture.asyncSetUp()
        self.host=self.fixture.host;self.controller=self.host.controller
        self.value=self.fixture.value;self.mark=self.fixture.mark
        self.camera=self.fixture.fixture.camera
        self.diagnostics=ScreenDiagnostics();self.fixture.screen.diagnostics=self.diagnostics
        self.backend_rtt=0;self.resolver_rtt=0;self.revoked=False
        self.monitor_started=asyncio.Event();self.monitor_release=None
        self.authorities=[];self.witnesses=[]
        self.fixture.owner.backend=AsyncMock(side_effect=self.backend)
        self.fixture.transport.side_effect=self.gateway
    async def asyncTearDown(self):await self.fixture.asyncTearDown()
    async def backend(self,path,body):
        await asyncio.sleep(self.backend_rtt/2)
        if self.revoked:raise ValueError('presentation_authority_unavailable')
        result=await self.fixture.backend(path,body)
        self.authorities.append(dict(result))
        await asyncio.sleep(self.backend_rtt/2)
        return result
    async def gateway(self,*args,**kwargs):
        monitor=self.fixture.calls>=2
        if monitor:
            self.monitor_started.set()
            if self.monitor_release:await self.monitor_release.wait()
        await asyncio.sleep(self.resolver_rtt/2)
        result=await self.fixture.gateway(*args,**kwargs)
        # Model the helper timestamp at the far end, before the return trip.
        import json
        self.witnesses.append(json.loads(result[1])['observedAt'])
        await asyncio.sleep(self.resolver_rtt/2)
        return result
    async def present(self):
        return await self.controller.present(self.value,self.mark)
    async def detach_monitor(self):
        task=self.controller.monitor;self.controller.monitor=None
        task.cancel();await asyncio.gather(task,return_exceptions=True)
    async def test_realistic_hops_sustain_where_redundant_callback_exceeds_budget(self):
        self.backend_rtt=.09;self.resolver_rtt=.03
        self.assertGreater(2*self.backend_rtt+self.resolver_rtt,.2)
        self.assertLess(self.backend_rtt+self.resolver_rtt,.2)
        result=await self.present();self.assertEqual(result['state'],'accepted')
        self.assertEqual(result['observation']['observedAt'],self.witnesses[1])
        await asyncio.sleep(.48)
        self.assertIsNotNone(self.camera.target_scope)
        self.assertGreaterEqual(self.fixture.calls,4)
        # Final fresh callback is still made for each completed monitor read.
        self.assertGreaterEqual(len(self.authorities),4)
        self.assertEqual(self.controller.receipt(self.value['commandId']),result)
    async def test_two_remaining_hops_over_budget_clear_without_replay(self):
        self.backend_rtt=.13;self.resolver_rtt=.09
        result=await self.present();self.assertEqual(result['state'],'accepted')
        await asyncio.sleep(.25)
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.annotations,{})
        self.assertEqual(self.diagnostics.data['lastPresentationFailure']['stage'],'monitor_cycle')
        self.assertEqual(self.diagnostics.data['lastPresentationFailure']['error'],'timeout')
        calls=self.fixture.calls
        self.assertEqual(await self.present(),result);self.assertEqual(self.fixture.calls,calls)
    async def test_in_budget_hops_still_cannot_extend_original_witness_age(self):
        self.backend_rtt=.09;self.resolver_rtt=.06
        self.assertLess(self.backend_rtt+self.resolver_rtt,.2)
        result=await self.present();self.assertEqual(result['state'],'accepted')
        await asyncio.sleep(.35)
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.annotations,{})
        self.assertEqual(result['observation']['observedAt'],self.witnesses[1])
    async def test_final_callback_deadline_is_not_relaxed_for_cloud(self):
        self.backend_rtt=.19;self.resolver_rtt=.02
        result=await self.present();self.assertEqual(result['state'],'rejected')
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.annotations,{})
        self.assertEqual(self.diagnostics.data['lastPresentationFailure']['stage'],'final_authority')
        self.assertEqual(self.diagnostics.data['lastPresentationFailure']['error'],'timeout')
    async def test_expired_or_wrong_cached_authority_never_starts_remote_read(self):
        result=await self.present();self.assertEqual(result['state'],'accepted')
        await self.detach_monitor()
        from live_presentation import RemoteResolver
        original_scope=dict(self.camera.target_scope)
        original=self.authorities[-1]
        for changes in ({'expiresAt':time.time()*1000-1},{'cursor':1},{'fingerprint':'c'*64},
                        {'expiresAt':time.time()*1000+2100}):
            with self.subTest(changes=changes):
                source=RemoteResolver(self.host)
                self.controller.source=source
                self.camera.target_scope=dict(original_scope)
                calls=self.fixture.calls;callbacks=self.fixture.owner.backend.await_count
                await self.controller.watch(self.value,self.mark,source,self.camera,result['observation'],{**original,**changes})
                self.assertEqual(self.fixture.calls,calls)
                self.assertEqual(self.fixture.owner.backend.await_count,callbacks)
                self.assertIsNone(self.camera.target_scope)
    async def test_revocation_during_read_rejects_before_witness_renewal(self):
        self.monitor_release=asyncio.Event()
        result=await self.present();self.assertEqual(result['state'],'accepted')
        await self.monitor_started.wait()
        self.revoked=True;self.monitor_release.set()
        await self.controller.monitor
        self.assertIsNone(self.camera.target_scope);self.assertEqual(self.camera.annotations,{})
        self.assertEqual(self.controller.receipt(self.value['commandId']),result)
    async def test_stop_during_read_cancels_without_callback_or_receipt_rewrite(self):
        self.monitor_release=asyncio.Event()
        result=await self.present();self.assertEqual(result['state'],'accepted')
        await self.monitor_started.wait()
        callbacks=self.fixture.owner.backend.await_count
        await self.host.stop()
        self.assertIsNone(self.camera.target_scope)
        self.assertEqual(self.fixture.owner.backend.await_count,callbacks)
        self.assertEqual(self.controller.receipt(self.value['commandId']),result)
    async def test_cached_authority_keeps_original_expiry_and_is_copied(self):
        result=await self.present();self.assertEqual(result['state'],'accepted')
        original=self.authorities[-1]
        checked=self.controller.checked_authority(self.value,self.mark,original)
        self.assertEqual(checked['expiresAt'],original['expiresAt'])
        self.assertIsNot(checked,original)
        original['cursor']=1
        self.assertEqual(checked['cursor'],self.value['expected']['cursor'])
    def test_diagnostics_are_bounded_fixed_metadata_only(self):
        import json
        self.diagnostics.presentation_result('monitor_resolve',time.monotonic()-.03)
        self.diagnostics.presentation_result('monitor_authority',time.monotonic()-.04,'timeout')
        for stage,error in [('private window title',None),('monitor_cycle','private upstream error')]:
            with self.assertRaises(ValueError):self.diagnostics.presentation_result(stage,time.monotonic(),error)
        encoded=json.dumps(self.diagnostics.data)
        self.assertNotIn('private',encoded);self.assertNotIn('Fixture',encoded)
        self.assertLess(len(encoded),1024)
