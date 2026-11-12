"""Assembled speech through the real bounded callback loop, using local HTTP."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
import test_segment_delivery
import test_playback
from test_utterances import result
from utterances import UtteranceAssembler


class UtteranceDeliveryTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = test_segment_delivery.SegmentDeliveryTests.asyncTearDown
    segment = test_segment_delivery.SegmentDeliveryTests.segment
    drain = test_segment_delivery.SegmentDeliveryTests.drain
    async def asyncSetUp(self):
        await test_segment_delivery.SegmentDeliveryTests.asyncSetUp(self)
        self.session.protocol_version=2
        self.now=0
        self.session.utterances=UtteranceAssembler(clock=lambda:self.now)

    async def test_fragments_arrive_as_one_callback_with_private_free_timings(self):
        session=self.session
        self.service.backend=AsyncMock(wraps=self.service.backend)
        for i,text in enumerate(['Open Messages', 'and send hello', 'to the test group.']):
            session.accept_transcript(result(text,i,1,boundary=i==2),session.generation)
        self.assertTrue(session.human_speaking())
        session.flush_utterance(session.generation)
        self.assertEqual(self.requests,[])
        self.now=.61
        session.flush_utterance(session.generation)
        self.assertTrue(session.human_speaking())
        await self.drain()
        self.assertEqual(self.requests,['1'])
        self.assertEqual(self.service.backend.call_args.args[1]['text'], 'Open Messages and send hello to the test group.')
        self.assertFalse(session.human_speaking())
        self.assertEqual(session.lifecycle.data['lastUtterance']['fragments'],3)
        self.assertNotIn('Open Messages',str(session.lifecycle.data))

    async def test_local_stop_bypasses_buffer_and_never_dispatches_partial_request(self):
        session=self.session
        session.accept_transcript(result('Send something',0,1),session.generation)
        session.deliver_priority_stop=AsyncMock()
        self.assertTrue(session.accept_transcript(result('Stop',1,1),session.generation))
        await session.priority_stop_task
        self.assertFalse(session.allowed)
        self.assertFalse(session.utterances.busy)
        self.assertEqual(self.requests,[])

    async def test_stale_generation_muting_and_tts_cannot_leak_partial_speech(self):
        session=self.session
        session.accept_transcript(result('Do not execute',boundary=True),session.generation)
        await session.stop_stt()
        self.now=1
        session.flush_utterance(session.generation)
        self.assertEqual(self.requests,[])
        session.speaking=True
        session.accept_transcript(result('Echoed agent text',boundary=True),session.generation)
        self.assertFalse(session.utterances.busy)
        session.speaking=False
        session.allowed=False
        session.accept_transcript(result('Muted text',boundary=True),session.generation)
        self.assertFalse(session.utterances.busy)

    async def test_speech_cancelled_if_human_continues_before_playback_without_replay(self):
        session=self.session
        self.service.backend=AsyncMock(return_value={'state':'listening','callId':session.call_id,
            'expiresAt':'2099-01-01T00:00:00Z'})
        session.say=AsyncMock()
        self.service.speech.accept('reply','ct_'+'a'*40,'synthetic')
        session.accept_transcript(result('Wait, correction',final=False),session.generation)
        await self.service.play_speech(session,'reply','Synthetic response')
        session.say.assert_not_awaited()
        self.assertEqual(self.service.speech.get('reply')['state'],'cancelled')
        self.assertEqual(self.service.speech.get('reply')['reason'],'human_speaking')

    async def test_continuation_between_policy_fetch_and_scheduled_playback_is_preserved(self):
        session = self.session
        async def policy(path):
            asyncio.get_running_loop().call_soon(session.accept_transcript,
                result('Wait, correction',final=False),session.generation)
            return {'state':'listening','callId':session.call_id,'expiresAt':'2099-01-01T00:00:00Z'}
        self.service.backend = policy
        session.say = AsyncMock()
        self.service.speech.accept('race',session.id,'synthetic')
        async def scheduled(awaitable, timeout):
            # Exercise a task handoff even on Python versions where wait_for
            # directly awaits its coroutine instead of scheduling a task.
            await asyncio.sleep(0)
            return await awaitable
        with patch('server.asyncio.wait_for',side_effect=scheduled):
            await self.service.play_speech(session,'race','Synthetic response')
        session.say.assert_not_awaited()
        self.assertEqual(self.service.speech.get('race')['reason'],'human_speaking')
        self.assertTrue(session.utterances.busy)


class UtterancePlaybackTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_playback.PlaybackTests.asyncSetUp
    asyncTearDown = test_playback.PlaybackTests.asyncTearDown
    create_session = test_playback.PlaybackTests.create_session

    async def test_http_speak_cancellation_is_durable_and_never_replayed(self):
        session = await self.create_session()
        session.protocol_version = 2
        session.utterances.feed(result('Still talking',final=False))
        url = f'/sessions/{session.id}/speak'
        body = {'id':'speech-busy','text':'Synthetic reply','callId':session.call_id}
        first = await self.client.post(url,json=body,headers=self.headers)
        self.assertEqual(first.status,200)
        receipt = await first.json()
        self.assertEqual(receipt['state'],'cancelled')
        self.assertEqual(receipt['reason'],'human_speaking')
        session.utterances.reset()
        repeated = await self.client.post(url,json=body,headers=self.headers)
        self.assertEqual(await repeated.json(),receipt)
        self.assertEqual(self.play_count,0)
        self.assertEqual(self.service.speech_tasks,{})
