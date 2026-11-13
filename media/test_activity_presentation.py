"""Synthetic activity journey, privacy/replay and phone layout checks; no services."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from captions import CaptionScene, CaptionRenderer
from presentation import activity
from test_caption_experience import policy

BINDING = {'sessionId':'session_fixture', 'memberId':'member_fixture', 'deviceId':'mac_fixture', 'displayId':1}


def payload(sequence=1, work='executing', summary='Checking the synthetic result', verification='agent_observed'):
    value={'version':1,'sequence':sequence,'delivery':'acknowledged','work':work,'currentSummary':summary,
           'expiresAt':datetime.fromtimestamp(1060,timezone.utc).isoformat(),
           'entries':[{'activityId':'activity_fixture','sequence':sequence,'kind':'status','summary':summary}]}
    if work in ('completed','uncertain','canceled'):
        value['outcome']={'outcomeId':'outcome_fixture','status':work,'verification':verification,'summary':summary}
    return {**BINDING,'callId':'owned-call','expiresAt':datetime.fromtimestamp(1005,timezone.utc).isoformat(),
            'presentationVersion':1,'activity':value,'callState':'connected'}


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.now=0
        self.scene=CaptionScene('synthetic',clock=lambda:self.now)
        self.refresh()

    def refresh(self):
        self.scene.apply_policy({**policy(),'presentationBinding':BINDING})

    def apply(self, value):
        value={**value,'expiresAt':datetime.fromtimestamp(1005+self.now,timezone.utc).isoformat()}
        return self.scene.apply_presentation(value,'mac_fixture',1000+self.now)

    def test_five_turn_journey_delayed_ack_approval_outcome_without_call_end(self):
        renderer=CaptionRenderer()
        sequence=0
        for turn in range(1,6):
            self.scene.hearing(f'Synthetic partial {turn}')
            self.assertEqual(self.scene.snapshot()['feedback'],'hearing')
            segment={'id':str(turn),'text':f'Synthetic final {turn}'}
            self.scene.delivery('sending',segment)
            self.scene.append(segment)
            self.scene.delivery('received',segment)
            self.assertEqual(renderer.subtitle(self.scene.snapshot())[0],'Backend accepted')
            for state in ('received','executing','pending_approval','completed'):
                sequence+=1
                value=payload(sequence,state)
                self.assertTrue(self.apply(value))
                if state=='received':self.assertEqual(self.scene.snapshot()['activityLabel'],'Received by agent')
                if state=='pending_approval':self.assertEqual(self.scene.snapshot()['activityLabel'],'Native approval needed')
            self.assertEqual(self.scene.snapshot()['activityLabel'],'Agent reports completed')
            self.assertEqual(self.scene.state,'listening')
        self.assertEqual(self.scene.last_sequence,5)

    def test_unverified_unknown_incomplete_and_timeout_are_never_success(self):
        for seq,(state,verification,label) in enumerate([
                ('completed','not_verified','Outcome unverified'),
                ('uncertain','unknown','Outcome unresolved')],1):
            self.assertTrue(self.apply(payload(seq,state,verification=verification)))
            self.assertEqual(self.scene.snapshot()['activityLabel'],label)
        self.scene.delivery('incomplete')
        self.assertEqual(CaptionRenderer().subtitle(self.scene.snapshot())[0],'Please repeat that')
        self.scene.delivery('unconfirmed')
        self.assertEqual(CaptionRenderer().subtitle(self.scene.snapshot())[0],'Delivery unconfirmed')

    def test_exact_binding_generation_expiry_and_replay_never_restore_private_text(self):
        for mutation in ('sessionId','memberId','callId','displayId','expiry','stop','generation'):
            with self.subTest(mutation=mutation):
                self.setUp()
                value=payload(summary='PRIVATE synthetic text')
                self.assertTrue(self.apply(value))
                if mutation in BINDING or mutation=='callId':
                    self.apply({**value,mutation:2 if mutation=='displayId' else 'wrong'})
                elif mutation=='expiry':
                    self.now=6
                    self.refresh()
                else:
                    self.scene.clear('paused' if mutation=='stop' else 'reconnecting')
                    self.refresh()
                self.assertNotIn('PRIVATE',str(self.scene.snapshot()))
                self.assertFalse(self.apply(value))
                self.assertNotIn('PRIVATE',str(self.scene.snapshot()))

    def test_heartbeat_preserves_freshness_but_never_extends_text_expiry(self):
        value=payload(1,'completed',summary='PRIVATE result')
        self.apply(value)
        for t in range(1,65):
            self.now=t
            self.refresh()
            self.apply(value)
        self.assertEqual(self.scene.snapshot()['activitySummary'],'')
        self.assertNotIn('PRIVATE',str(self.scene.__dict__))
        self.assertEqual(self.scene.snapshot()['activityLabel'],'Agent reports completed')
        self.scene.clear('ended')
        self.assertNotIn('PRIVATE',str(self.scene.snapshot()))
        self.assertNotIn('PRIVATE',str(self.scene.__dict__))

    def test_boolean_display_is_not_exact_numeric_binding(self):
        self.assertFalse(self.apply({**payload(), 'displayId':True}))
        self.assertEqual(self.scene.snapshot()['activitySummary'],'')

    def test_policy_floor_rejects_unseen_pre_stop_metadata_after_resume(self):
        self.scene.apply_policy({**policy(),'presentationBinding':BINDING,'presentationSequence':8})
        self.scene.clear('paused')
        self.scene.apply_policy({**policy(),'presentationBinding':BINDING,'presentationSequence':9})
        self.assertFalse(self.apply(payload(8,summary='PRIVATE delayed generation')))
        self.assertNotIn('PRIVATE',str(self.scene.snapshot()))
        self.assertTrue(self.apply(payload(9,summary='Fresh synthetic work')))

    def test_bounded_contract_unicode_unknown_fields_and_order(self):
        value=payload()['activity']
        value['entries'][0]['summary']='界'*160
        self.assertEqual(activity(value)['entries'][0]['summary'],'界'*160)
        value['secret']='TOKEN_PRIVATE'
        self.assertNotIn('TOKEN_PRIVATE',json.dumps(activity(value)))
        for bad in [dict(value,version=2),dict(value,entries=value['entries']*21),
                    dict(value,entries=[{**value['entries'][0],'summary':'x'*161}]),
                    dict(value,entries=[{**value['entries'][0],'summary':'bad\ntext'}]),
                    dict(value,entries=[{**value['entries'][0],'sequence':100}])]:
            with self.assertRaises(ValueError):activity(bad)

    def test_stale_readiness_overrides_completed_green_success(self):
        for reason in ('agent_stale','gateway_unavailable','sharing_disabled','binding_mismatch'):
            self.setUp()
            self.apply(payload(1,'completed',summary='PRIVATE success'))
            self.apply({**payload(2,'completed'), 'readiness':{'reason':reason}})
            self.assertEqual(self.scene.snapshot()['state'],'unavailable')
            self.assertNotIn('PRIVATE',str(self.scene.__dict__))
        self.setUp()
        self.apply({**payload(1,'completed'),'readiness':{'reason':'unresolved_effect'}})
        self.assertEqual(self.scene.snapshot()['activityLabel'],'Outcome unresolved')
        self.assertEqual(self.scene.snapshot()['activitySummary'],'')

    def test_shared_cross_language_contract_fixture(self):
        fixture=json.loads((Path(__file__).resolve().parents[1]/'tests/fixtures/presentation-v1.json').read_text())
        for value in fixture['valid']:
            self.assertEqual(activity(value),value)
        for value in fixture['invalid']:
            with self.assertRaises(ValueError):activity(value)

    def test_synthetic_portrait_landscape_rendering_long_unicode_and_cleared_scene(self):
        renderer=CaptionRenderer()
        self.apply(payload(summary='Résumé synthetic approval — long safe activity summary'))
        self.scene.hearing('Synthetic phone feedback with pause and correction. '*8)
        snapshot=self.scene.snapshot()
        image=renderer.render(snapshot)
        self.assertEqual(image.size,(1280,720))
        portrait=image.crop((437,0,843,720))
        self.assertEqual(portrait.size,(406,720))
        self.assertTrue(all(renderer.measure(line)<=336 for line in renderer.subtitle(snapshot)[1]))
        self.scene.clear('ended')
        fresh=CaptionScene('synthetic');fresh.clear('ended')
        self.assertEqual(renderer.render(self.scene.snapshot()).tobytes(),renderer.render(fresh.snapshot()).tobytes())


class ActivityForwardingTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_panel_updates_only_exact_live_caption_binding(self):
        import time
        from unittest.mock import AsyncMock, patch
        from aiohttp.test_utils import TestClient, TestServer
        from server import Service, Session
        with tempfile.TemporaryDirectory() as directory:
            owner=Service({'MEDIA_DATABASE_PATH':str(Path(directory)/'media.sqlite'),'MEDIA_API_KEY':'m'*32})
            client=TestClient(TestServer(owner.app()))
            await client.start_server()
            session=Session(owner,{'id':'ct_'+'a'*40,'meetingId':'fixture','lineId':'fixture','captions':True})
            session.call_id='owned-call';session.active=session.allowed=True
            session.caption_scene.apply_policy({**policy(),'presentationBinding':BINDING})
            owner.sessions[session.id]=session
            body=payload()
            body['expiresAt']=datetime.fromtimestamp(time.time()+5,timezone.utc).isoformat()
            body['activity']['expiresAt']=datetime.fromtimestamp(time.time()+60,timezone.utc).isoformat()
            try:
                with patch('server.gateway_request',AsyncMock(return_value=(200,b'{"accepted":true}',{}))) as gateway:
                    response=await client.post('/devices/mac_fixture/panel',json=body)
                    self.assertEqual(response.status,401)
                    self.assertEqual(session.caption_scene.snapshot()['activityLabel'],'')
                    response=await client.post('/devices/mac_fixture/panel',json=body,headers={'Authorization':'Bearer '+'m'*32})
                    self.assertEqual(response.status,200)
                    self.assertEqual(session.caption_scene.snapshot()['activityLabel'],'Agent working')
                    self.assertEqual(len(owner.speech_tasks),0)
                    self.assertNotIn(body['activity']['entries'][0]['summary'],' '.join(owner.db.iterdump()))
                    gateway.assert_awaited_once()
                    bad={**body,'sessionId':'other-session'}
                    response=await client.post('/devices/mac_fixture/panel',json=bad,headers={'Authorization':'Bearer '+'m'*32})
                    self.assertEqual(response.status,200)
                    self.assertEqual(session.caption_scene.snapshot()['activitySummary'],'')
                    large={**body,'activity':{**body['activity'],'sequence':20,'currentSummary':'🧪'*160,
                        'entries':[{'activityId':'a'*157+str(n),'sequence':n,'kind':'status','summary':'🧪'*160} for n in range(1,21)]}}
                    self.assertGreater(len(json.dumps(large,ensure_ascii=False).encode()),16384)
                    response=await client.post('/devices/mac_fixture/panel',json=large,headers={'Authorization':'Bearer '+'m'*32})
                    self.assertEqual(response.status,200)
                    self.assertEqual(session.caption_scene.snapshot()['activitySummary'],'🧪'*160)
            finally:
                await client.close()


if __name__=='__main__':unittest.main()
