"""No model or phone: exercise independent sharing, native work and call controls."""
import asyncio
from datetime import datetime, timezone
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from PIL import Image
from devices import ScreenController
from test_devices import selection, policy
import test_session_duration
import test_priority_stop


class AgentOwnedSharingTests(unittest.IsolatedAsyncioTestCase):
    async def test_epoch_handoff_preserves_stream_and_refuses_stale_policy(self):
        owner=SimpleNamespace(env={'DEVICE_GATEWAY_URL':'http://127.0.0.1:4214','DEVICE_GATEWAY_KEY':'g'*32},backend=AsyncMock())
        session=SimpleNamespace(owner=owner,id='session',call_id='call',active=True,closing=False)
        screen=ScreenController(session);screen.release=AsyncMock(return_value=True);screen.poll=AsyncMock()
        selected={**selection(),'protocolVersion':2,'sessionId':'session','executorEpoch':0,'policyRevision':1,'executor':'none'}
        screen.update(policy(selected));await asyncio.sleep(0)
        screen.frame=Image.new('RGB',(100,100),'blue');screen.frame_id='frame';screen.state='viewing'
        screen.received_at=time.monotonic();screen.captured_at=datetime.now(timezone.utc).isoformat()
        generation=screen.generation;task=screen.task;pixels=screen.frame
        screen.update(policy({**selected,'executorEpoch':1,'executor':'native'}))
        self.assertEqual(screen.generation,generation);self.assertIs(screen.task,task);self.assertIs(screen.frame,pixels)
        self.assertIsNone(screen.frame_id);self.assertEqual(screen.selection['executor'],'native')
        screen.update(policy(selected))
        self.assertEqual(screen.selection['executorEpoch'],1);screen.release.assert_not_awaited()
        screen.update(policy({**selected,'executorEpoch':2,'executor':'clawdtime','mode':'control'}))
        self.assertEqual(screen.selection['mode'],'control');self.assertEqual(screen.generation,generation)
        screen.applied_epoch=2;screen.applied_lease=selected['leaseId']
        screen.update(policy({**selected,'leaseId':'new-lease','executorEpoch':2}))
        self.assertIsNone(screen.applied_epoch);self.assertIsNone(screen.applied_lease)
        await screen.close()

    async def test_muted_call_keeps_screen_policy_but_stops_listening_and_speech(self):
        fixture=test_session_duration.SessionDurationTests();session=fixture.session(True,60)
        session.screen=SimpleNamespace(update=Mock());session.owner.cancel_speech=Mock()
        value={**fixture.policy(),'protocolVersion':2,'muted':True}
        await fixture.one_policy(session,value)
        self.assertFalse(session.allowed);session.stop_stt.assert_awaited_once()
        session.screen.update.assert_called_once_with(value)
        session.owner.cancel_speech.assert_called_once();session.close.assert_not_awaited()


class AgentOwnedStopTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=test_priority_stop.PriorityStopTests.asyncSetUp
    asyncTearDown=test_priority_stop.PriorityStopTests.asyncTearDown
    session=test_priority_stop.PriorityStopTests.session
    segment=test_priority_stop.PriorityStopTests.segment
    async def test_version_two_stop_keeps_conversation_after_ack_without_restarting_share(self):
        session=self.session();session.protocol_version=2
        self.service.backend=AsyncMock(return_value={'stopped':True,'captured':False})
        segment=self.segment(session)
        session.queue_segment(segment);await session.priority_stop_task
        self.assertFalse(session.pause_latched);self.assertIsNone(session.priority_stop_id)
        session.screen.update.assert_called_once_with({})
        self.assertTrue(session.queue_segment(segment))
        self.service.backend.assert_awaited_once()


class PanelMediaStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_panel_uses_exact_media_call_state_and_preserves_terminal_or_mute(self):
        import json
        from pathlib import Path
        import tempfile
        from unittest.mock import patch
        from aiohttp.test_utils import TestClient, TestServer
        from server import Service, Session
        with tempfile.TemporaryDirectory() as folder:
            owner=Service({'MEDIA_DATABASE_PATH':str(Path(folder)/'media.sqlite'),'MEDIA_API_KEY':'m'*32})
            client=TestClient(TestServer(owner.app()));await client.start_server()
            call_id='ct_'+'b'*40
            session=Session(owner,{'id':call_id,'meetingId':'fixture','lineId':'fixture'})
            session.call_id=call_id;session.active=True
            owner.sessions[call_id]=session
            body={'callId':call_id,'sessionId':'coding-session','memberId':'person','displayId':1,
                  'executor':'native','executorEpoch':2,'policyRevision':1,'callState':'connected',
                  'personLabel':'Paired fixture contact','projectLabel':'fixture-project · chat test'}
            async def forward(expected):
                with patch('server.gateway_request',AsyncMock(return_value=(200,b'{"accepted":true}',{}))) as gateway:
                    response=await client.post('/devices/fixture/panel',json=body,headers={'Authorization':'Bearer '+'m'*32})
                    self.assertEqual(response.status,200)
                    gateway.assert_awaited_once_with(owner,'POST','/v1/devices/fixture/panel',{**body,'callState':expected})
            try:
                session.speaking=True;session.allowed=False
                await forward('speaking')
                session.speaking=False;session.allowed=True
                await forward('listening')
                session.allowed=False
                await forward('connected')
                session.speaking=True
                for protected in ('muted','ended'):
                    body['callState']=protected
                    await forward(protected)
                body['callState']='listening';body['callId']='ct_'+'c'*40
                await forward('connected')
                body['callId']=call_id;session.call_id='different'
                await forward('connected')
                session.call_id=call_id;session.closing=True
                await forward('connected')
            finally:
                await client.close()
