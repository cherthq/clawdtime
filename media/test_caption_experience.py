"""Transient hearing/receipt/subtitle UX, exercised without a call or microphone."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from PIL import Image

from captions import CaptionScene, CaptionRenderer, CaptionPublisher
import test_caption_service
from test_utterances import result


def policy():
    return {'callId':'owned-call','state':'listening','captionsEnabled':True,'protocolVersion':2,
            'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}


class CaptionExperienceTests(unittest.TestCase):
    def setUp(self):
        self.now=0
        self.scene=CaptionScene('synthetic',clock=lambda:self.now)
        self.scene.apply_policy(policy())

    def test_partial_sending_and_receipt_are_distinct_and_newer_speech_wins(self):
        self.scene.hearing('Synthetic provisional words')
        self.assertEqual(self.scene.snapshot()['feedback'],'hearing')
        self.assertEqual(self.scene.snapshot()['segments'],[])
        first={'id':'1','text':'Synthetic final words'}
        self.scene.delivery('sending',first)
        self.assertEqual(self.scene.snapshot()['feedback'],'sending')
        self.scene.append(first)
        self.scene.delivery('received',first)
        self.assertEqual(self.scene.snapshot()['feedback'],'received')
        self.scene.hearing('New correction')
        self.scene.delivery('received',first)
        self.assertEqual(self.scene.snapshot()['preview'],'New correction')
        self.assertEqual(self.scene.snapshot()['feedback'],'hearing')

    def test_all_private_text_clears_on_expiry_mute_revoke_wrong_call_and_close(self):
        for change in ['expiry','mute','revoke','wrong-call','close']:
            with self.subTest(change=change):
                scene=CaptionScene('synthetic',clock=lambda:self.now)
                scene.apply_policy(policy())
                scene.hearing('PRIVATE human text')
                scene.speaking('PRIVATE agent text')
                if change=='expiry':self.now+=2.01
                elif change=='mute':scene.apply_policy({**policy(),'muted':True},speaking=True)
                elif change=='revoke':scene.apply_policy({**policy(),'captionsEnabled':False},speaking=True)
                elif change=='wrong-call':scene.apply_policy({**policy(),'callId':'other'},speaking=True)
                else:scene.clear('ended')
                self.assertNotIn('PRIVATE',str(scene.snapshot()))

    def test_policy_refresh_preserves_agent_subtitles_but_failure_clears_them(self):
        self.scene.speaking('Synthetic spoken answer')
        for _ in range(5):
            self.now+=.5
            self.scene.apply_policy(policy(),speaking=True)
        self.assertEqual(self.scene.snapshot()['agentText'],'Synthetic spoken answer')
        self.scene.finish_speaking(False)
        self.assertEqual(self.scene.snapshot()['agentText'],'')

    def test_long_agent_text_paginates_and_live_human_text_keeps_the_latest_words(self):
        renderer=CaptionRenderer()
        self.scene.speaking('First synthetic sentence. ' + 'More synthetic words. '*30 + 'Last sentence.')
        first=renderer.subtitle(self.scene.snapshot())[1]
        self.now=5
        self.scene.apply_policy(policy(),speaking=True)
        second=renderer.subtitle(self.scene.snapshot())[1]
        self.assertNotEqual(first,second)
        self.assertIn('First',first[0])
        self.assertTrue(all(renderer.measure(line)<=336 for line in first+second))
        self.scene.finish_speaking(True)
        self.scene.hearing('Long sentence '*100+'LATEST correction')
        self.assertTrue(self.scene.snapshot()['preview'].endswith('LATEST correction'))
        self.assertLessEqual(len(self.scene.snapshot()['preview']),500)
        self.assertEqual(self.scene.snapshot()['agentText'],'')

    def test_screen_overlay_is_visible_and_preserves_pixels_outside_its_region(self):
        self.scene.hearing('Synthetic request')
        renderer=CaptionRenderer()
        desktop=Image.new('RGBA',(1280,720),'#496482')
        result=renderer.overlay(desktop,self.scene.snapshot())
        self.assertNotEqual(result.tobytes(),desktop.tobytes())
        self.assertEqual(result.getpixel((100,100)),desktop.getpixel((100,100)))
        self.scene.clear('paused')
        fresh=CaptionScene('synthetic')
        fresh.clear('paused')
        self.assertEqual(renderer.overlay(desktop,self.scene.snapshot()).tobytes(),
                         renderer.overlay(desktop,fresh.snapshot()).tobytes())

    def test_publisher_composes_subtitles_on_screen_instead_of_replacing_screen(self):
        self.scene.hearing('Synthetic request')
        screen=SimpleNamespace(screen_call=True,selection=None,starting=False,revision=1,
            frame=True,expire=Mock(),render=Mock(return_value=Image.new('RGBA',(1280,720),'blue')),
            diagnostics=SimpleNamespace(emitted=Mock()))
        sdk=SimpleNamespace(VideoFrame=lambda *args:args[-1],VideoBufferType=SimpleNamespace(RGBA=1))
        publisher=CaptionPublisher(self.scene,None,sdk=sdk,screen=screen)
        publisher.source=Mock()
        publisher.emit()
        partial=publisher.frame
        self.scene.delivery('sending',{'id':'1','text':'Synthetic final request'})
        publisher.emit()
        self.assertNotEqual(partial,publisher.frame)
        self.assertEqual(screen.render.call_count,2)


class CaptionFlowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=test_caption_service.CaptionServiceTests.asyncSetUp
    asyncTearDown=test_caption_service.CaptionServiceTests.asyncTearDown
    fixture_session=test_caption_service.CaptionServiceTests.fixture_session

    async def test_preview_then_backend_confirmed_receipt_without_persisting_caption_text(self):
        session=self.fixture_session()
        session.protocol_version=2
        session.caption_scene.apply_policy(policy())
        now=[0]
        session.utterances.clock=lambda:now[0]
        session.accept_transcript(result('Synthetic interim',final=False),session.generation)
        self.assertEqual(session.caption_scene.snapshot()['preview'],'Synthetic interim')
        self.assertEqual(session.caption_scene.snapshot()['feedback'],'hearing')
        session.accept_transcript(result('Synthetic completed request',boundary=True),session.generation)
        now[0]=.61
        session.flush_utterance(session.generation)
        self.assertEqual(session.caption_scene.snapshot()['feedback'],'sending')
        self.assertEqual(session.caption_scene.snapshot()['segments'],[])
        self.service.backend=AsyncMock(return_value={'captured':True})
        task=asyncio.create_task(session.deliver())
        try:
            await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(session.caption_scene.snapshot()['feedback'],'received')
            self.assertEqual(session.caption_scene.snapshot()['segments'],['Synthetic completed request'])
            self.assertNotIn('Synthetic', ' '.join(self.service.db.iterdump()))
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)

    async def test_unknown_callback_never_claims_receipt(self):
        session=self.fixture_session()
        session.caption_scene.apply_policy(policy())
        segment={'id':'1','text':'Synthetic request','callId':session.call_id,
                 'at':datetime.now(timezone.utc).isoformat(),'source':'remote_participant',
                 'participantIdentity':session.worker_identity}
        session.queue_segment(segment)
        self.service.backend=AsyncMock(side_effect=TimeoutError())
        self.service.reply_to_segment=Mock()
        task=asyncio.create_task(session.deliver())
        try:
            await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(session.caption_scene.snapshot()['feedback'],'unconfirmed')
            self.assertEqual(session.caption_scene.snapshot()['segments'],[])
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)

    async def test_v2_activation_is_silent_and_duplicate_activation_does_not_greet_again(self):
        session=self.fixture_session()
        session.active=False
        session.activation=None
        session.say=AsyncMock()
        self.service.sessions[session.id]=session
        self.service.backend=AsyncMock(return_value=policy())
        for _ in range(2):
            response=await self.client.post(f'/sessions/{session.id}/activate',
                json={'callId':session.call_id},headers=self.headers)
            self.assertEqual(response.status,200)
        self.assertTrue(session.active)
        self.assertEqual(session.protocol_version,2)
        session.say.assert_not_awaited()
        self.assertEqual(session.caption_scene.snapshot()['state'],'listening')

    async def test_exact_spoken_text_is_subtitled_with_one_greeting_and_cleared_on_tts_failure(self):
        session=self.fixture_session()
        session.protocol_version=2
        session.caption_scene.apply_policy(policy())
        self.service.env['DEEPGRAM_API_KEY']='synthetic'
        posted=[]
        status=[200]
        async def chunks(_size):
            yield bytes(1920)
        response=SimpleNamespace(status=200,content=SimpleNamespace(iter_chunked=chunks))
        context=AsyncMock()
        context.__aenter__.return_value=response
        def post(url,**kwargs):
            response.status=status[0]
            posted.append(kwargs['json']['text'])
            self.assertEqual(session.caption_scene.snapshot()['agentText'],kwargs['json']['text'])
            return context
        async def playout():
            while True:
                item=await session.audio.get()
                if isinstance(item,asyncio.Future):item.set_result(None)
        pump=asyncio.create_task(playout())
        try:
            with patch.object(self.service.http,'post',side_effect=post):
                await session.say('Here is the synthetic decision.')
                await session.say('Second synthetic reply.')
                self.assertEqual(posted[:2],['Hey, this is your agent. Here is the synthetic decision.',
                                             'Second synthetic reply.'])
                self.assertEqual(session.caption_scene.snapshot()['state'],'listening')
                long_reply='Synthetic '+('x'*1585)+' done'
                await session.say(long_reply)
                self.assertEqual(posted[-1],long_reply)
                status[0]=500
                with self.assertRaises(RuntimeError):await session.say('Failed synthetic reply.')
                self.assertEqual(session.caption_scene.snapshot()['agentText'],'')
            self.assertNotIn('synthetic reply',' '.join(self.service.db.iterdump()))
        finally:
            pump.cancel()
            await asyncio.gather(pump,return_exceptions=True)

    async def test_policy_watcher_preserves_speaking_subtitle_then_clears_on_mute(self):
        session=self.fixture_session()
        session.caption_scene.apply_policy(policy())
        session.speaking=True
        session.caption_scene.speaking('PRIVATE synthetic spoken answer')
        self.service.backend=AsyncMock(return_value=policy())
        task=asyncio.create_task(session.watch_policy())
        try:
            await asyncio.sleep(.02)
            self.assertEqual(session.caption_scene.snapshot()['agentText'],'PRIVATE synthetic spoken answer')
            self.service.backend.return_value={**policy(),'muted':True}
            session.policy_wakeup.set()
            await asyncio.sleep(.02)
            self.assertEqual(session.caption_scene.snapshot()['state'],'paused')
            self.assertNotIn('PRIVATE',str(session.caption_scene.snapshot()))
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)

    async def test_pre_playback_callback_cannot_redisplay_old_transcript(self):
        session=self.fixture_session()
        session.caption_scene.apply_policy(policy())
        entered,release=asyncio.Event(),asyncio.Event()
        async def delayed(path,body=None):
            entered.set()
            await release.wait()
            return {'captured':True}
        self.service.backend=delayed
        session.queue_segment({'id':'1','text':'Old synthetic request','callId':session.call_id,
            'at':datetime.now(timezone.utc).isoformat(),'source':'remote_participant',
            'participantIdentity':session.worker_identity})
        task=asyncio.create_task(session.deliver())
        try:
            await asyncio.wait_for(entered.wait(),1)
            session.caption_scene.speaking('New synthetic reply')
            session.caption_scene.finish_speaking(True)
            release.set()
            await asyncio.wait_for(session.segments.join(),1)
            self.assertEqual(session.caption_scene.snapshot()['segments'],[])
            self.assertEqual(session.caption_scene.snapshot()['agentText'],'New synthetic reply')
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
