import asyncio
import json
import sqlite3
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from text_devices import TextDevices


class TextDeviceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db=sqlite3.connect(':memory:')
        self.owner=SimpleNamespace(db=self.db,env={'MEDIA_TEXT_CONTROL_ENABLED':'true'})
        self.devices=TextDevices(self.owner)
        self.wire={'id':'lease','deviceId':'device','protocolVersion':3,
            'authority':{'kind':'text_session','grantId':'grant','projectId':'/tmp/synthetic'}}
        self.gateway=AsyncMock(return_value=(200,b'{"id":"lease","state":"active"}',{}))
        self.patch=patch('text_devices.gateway_request',self.gateway);self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop();self.db.close()

    def request(self, body=None, **info):
        return SimpleNamespace(json=AsyncMock(return_value=body),match_info=info,method='POST')

    async def test_no_call_or_feature_flag_bypass(self):
        for body in ({**self.wire,'callId':'fake'}, {**self.wire,'protocolVersion':2}):
            with self.assertRaises(web.HTTPBadRequest):await self.devices.create(self.request(body))
        self.owner.env={}
        with self.assertRaises(web.HTTPServiceUnavailable):await self.devices.create(self.request(self.wire))
        self.gateway.assert_not_called()

    async def test_create_timeout_is_durable_unknown_and_never_reposted(self):
        self.gateway.side_effect=TimeoutError()
        with self.assertRaises(TimeoutError):await self.devices.create(self.request(self.wire))
        response=await self.devices.create(self.request(self.wire))
        self.assertEqual(json.loads(response.body)['state'],'unknown')
        self.assertEqual(self.gateway.call_count,1)
        changed={**self.wire,'deviceId':'other'}
        with self.assertRaises(web.HTTPConflict):await self.devices.create(self.request(changed))

    async def test_restart_tombstones_active_lease_and_retains_device_for_release(self):
        await self.devices.create(self.request(self.wire))
        self.devices=TextDevices(self.owner)
        self.assertEqual(self.devices.lease('lease'),'unknown')
        with self.assertRaises(web.HTTPConflict):await self.devices.frame(self.request(id='lease'))
        self.gateway.return_value=(200,b'{"released":true}',{})
        await self.devices.release(self.request(id='lease'))
        self.assertEqual(self.gateway.call_args.kwargs['device'],'device')
        self.assertEqual(self.devices.lease('lease'),'unknown')

    async def test_ambiguous_action_is_only_reconciled_by_original_id(self):
        await self.devices.create(self.request(self.wire))
        self.gateway.side_effect=TimeoutError()
        action={'id':'action','frameId':'frame','type':'type','text':'synthetic'}
        with self.assertRaises(TimeoutError):await self.devices.action(self.request(action,id='lease'))
        self.gateway.side_effect=None
        self.gateway.return_value=(200,b'{"id":"action","leaseId":"lease","state":"unknown"}',{})
        await self.devices.action(self.request(action,id='lease'))
        self.assertEqual(self.gateway.call_args.args[1],'GET')
        self.assertEqual(self.gateway.call_args.kwargs['device'],'device')
        with self.assertRaises(web.HTTPConflict):await self.devices.action(self.request({**action,'id':'another'},id='lease'))
        # No text/screens persisted in either operational metadata table.
        self.assertNotIn('synthetic',str(self.db.execute('SELECT * FROM text_actions').fetchall()))

    async def test_release_during_inflight_creation_cannot_resurrect_lease(self):
        entered=asyncio.Event();release=asyncio.Event()
        async def gateway(owner,method,path,*args,**kwargs):
            if method=='POST':
                entered.set();await release.wait()
                return (200,b'{"id":"lease","state":"active"}',{})
            return (200,b'{"stopped":true,"released":true}',{})
        self.gateway.side_effect=gateway
        creation=asyncio.create_task(self.devices.create(self.request(self.wire)))
        await entered.wait()
        result=await self.devices.release(self.request(id='lease'))
        self.assertFalse(json.loads(result.body)['released'])
        release.set()
        with self.assertRaises(web.HTTPConflict):await creation
        self.assertEqual(self.devices.lease('lease'),'unknown')

    async def test_disable_stops_new_input_but_keeps_receipt_and_release_reconciliation(self):
        await self.devices.create(self.request(self.wire))
        self.owner.env={}
        with self.assertRaises(web.HTTPServiceUnavailable):await self.devices.frame(self.request(id='lease'))
        with self.assertRaises(web.HTTPServiceUnavailable):await self.devices.action(self.request({'id':'a'},id='lease'))
        self.gateway.return_value=(200,b'{"stopped":true,"released":true}',{})
        response=await self.devices.release(self.request(id='lease'))
        self.assertTrue(json.loads(response.body)['released'])
