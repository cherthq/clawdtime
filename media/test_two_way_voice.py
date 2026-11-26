"""Qualified duplex, cancellation races and timing without external effects."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from captions import CaptionScene, CaptionRenderer
from server import Service, Session
from test_utterances import result
from voice_interaction import SpeechOnset, two_way_allowed


def policy(**overrides):
    return {'callId': 'owned-call', 'state': 'listening', 'protocolVersion': 2,
            'voiceInteractionVersion': 1, 'voiceMode': 'two_way',
            'remoteAudioIsolated': True, 'conversationRevision': 0,
            'captionsEnabled': True,
            'expiresAt': (datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat(),
            **overrides}


class AdmissionTests(unittest.TestCase):
    def test_shared_backend_policy_fixture_admits_only_explicit_duplex(self):
        fixture = json.loads((Path(__file__).resolve().parent.parent / 'tests/fixtures/voice-policy.json').read_text())
        self.assertTrue(two_way_allowed(fixture, {'MEDIA_TWO_WAY_VOICE_ENABLED': 'true'}))
        self.assertEqual(fixture['conversationRevision'], 3)
        for key in ('voiceInteractionVersion', 'voiceMode', 'remoteAudioIsolated'):
            missing = dict(fixture)
            del missing[key]
            self.assertFalse(two_way_allowed(missing, {'MEDIA_TWO_WAY_VOICE_ENABLED': 'true'}))

    def test_duplex_requires_all_explicit_gates(self):
        env = {'MEDIA_TWO_WAY_VOICE_ENABLED': 'true'}
        self.assertTrue(two_way_allowed(policy(), env))
        self.assertFalse(two_way_allowed(policy(), {}))
        for change in ({'protocolVersion': 1}, {'voiceInteractionVersion': 0},
                       {'voiceMode': 'half_duplex'}, {'remoteAudioIsolated': False},
                       {'remoteAudioIsolated': 'true'}):
            self.assertFalse(two_way_allowed(policy(**change), env))

    def test_onset_requires_sustained_activity_and_quiet_rearm(self):
        detector = SpeechOnset()
        speech, silence = b'\x00\x10'*960, bytes(1920)
        self.assertFalse(detector.feed(speech))  # One loud frame is insufficient.
        detector.feed(silence)
        self.assertFalse(any(detector.feed(speech) for _ in range(5)))
        self.assertTrue(detector.feed(speech))
        self.assertFalse(any(detector.feed(speech) for _ in range(50)))
        for _ in range(10):
            detector.feed(silence)
        self.assertFalse(any(detector.feed(speech) for _ in range(5)))
        self.assertTrue(detector.feed(speech))
        for invalid in (b'', b'\x00', 'private', bytes(1000000)):
            self.assertFalse(detector.feed(invalid))

    def test_caption_does_not_claim_mic_paused_for_qualified_duplex(self):
        scene = CaptionScene('fixture')
        scene.apply_policy({**policy(), 'twoWayListening': True})
        scene.speaking('Synthetic answer')
        self.assertEqual(CaptionRenderer().subtitle(scene.snapshot())[0], 'Speaking · still listening')
        scene.hearing('Synthetic correction')
        self.assertEqual(scene.snapshot()['preview'], 'Synthetic correction')
        scene.clear('paused')
        self.assertFalse(scene.snapshot()['twoWayListening'])
        self.assertNotIn('Synthetic', str(scene.snapshot()))


class TwoWayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.owner = Service({'MEDIA_DATABASE_PATH': str(Path(self.folder.name)/'test.sqlite'),
                              'MEDIA_TWO_WAY_VOICE_ENABLED': 'true', 'DEEPGRAM_API_KEY': 'synthetic'})
        self.session = Session(self.owner, {'id': 'ct_'+'a'*40, 'meetingId': 'synthetic'})
        self.owner.sessions[self.session.id] = self.session
        self.session.active = self.session.allowed = True
        self.session.protocol_version = 2
        self.session.call_id = 'owned-call'
        self.session.track_sid = 'qualified-remote-track'
        self.session.policy_at = time.monotonic()
        self.session.source = SimpleNamespace(clear_queue=Mock())
        self.session.apply_voice_policy(policy())
        self.owner.backend = AsyncMock(return_value={'accepted': True})

    async def asyncTearDown(self):
        for task in list(self.session.tasks) + list(self.owner.speech_tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.session.tasks), *list(self.owner.speech_tasks.values()), return_exceptions=True)
        self.owner.db.close()
        self.folder.cleanup()

    def feed_onset(self):
        for _ in range(6):
            self.session.observe_audio_activity(b'\x00\x10'*960)

    async def test_candidate_cancels_audio_locally_without_resetting_capture_or_authorizing_command(self):
        s = self.session
        s.speaking = True
        s.active_reply_id = 'speech-1'
        s.playback_generation = 4
        s.audio.put_nowait((4, b'\x01\x00'*960))
        barrier = asyncio.get_running_loop().create_future()
        s.audio.put_nowait((4, barrier))
        self.owner.speech.accept('speech-1', s.id, 'synthetic-digest')
        waiting = asyncio.create_task(asyncio.Event().wait())
        self.owner.speech_tasks['speech-1'] = waiting
        generation = s.generation
        self.feed_onset()
        self.assertTrue(s.audio.empty())
        self.assertTrue(barrier.cancelled())
        self.assertEqual(s.generation, generation)
        self.assertTrue(s.allowed)
        self.assertTrue(s.segments.empty())
        self.assertEqual(self.owner.speech.get('speech-1')['reason'], 'human_interruption')
        await s.interruption_task
        self.assertEqual(self.owner.backend.call_count, 1)
        path, body = self.owner.backend.call_args.args
        self.assertEqual(path, f'/media/{s.id}/interrupt')
        self.assertEqual(body['playbackGeneration'], 4)
        self.assertNotIn('text', body)
        self.assertIn('at', body)
        self.assertEqual(s.source.clear_queue.call_count, 1)
        s.speech_diagnostics.flush(force=True)
        encoded = json.dumps(s.lifecycle.data)
        self.assertNotIn('Synthetic answer', encoded)
        events = s.lifecycle.data['speech']['events']
        names = [event['event'] for event in events]
        self.assertLess(names.index('interruption_detected'), names.index('playback_cleared'))

    async def test_muted_stale_wrong_track_and_legacy_capture_cannot_send_interrupt(self):
        for field, value in (('two_way', False), ('allowed', False), ('active', False),
                             ('track_sid', None), ('policy_at', time.monotonic()-3)):
            previous = getattr(self.session, field)
            setattr(self.session, field, value)
            self.feed_onset()
            setattr(self.session, field, previous)
        self.owner.backend.assert_not_awaited()

    async def test_failed_interruption_callback_is_not_retried_and_does_not_stop_capture(self):
        self.owner.backend.side_effect = TimeoutError('synthetic private error')
        self.feed_onset()
        await self.session.interruption_task
        self.assertTrue(self.session.allowed)
        self.assertEqual(self.owner.backend.call_count, 1)
        self.assertEqual(self.session.speech_diagnostics.counts['interruption_unconfirmed'], 1)
        self.assertNotIn('private', json.dumps(list(self.session.speech_diagnostics.events)))

    async def test_sustained_activity_refreshes_hold_with_new_evidence_but_quiet_does_not(self):
        self.feed_onset()
        await self.session.interruption_task
        first = self.owner.backend.call_args.args[1]
        self.session.last_interruption_at -= 1
        self.session.observe_audio_activity(b'\x00\x10'*960)
        await self.session.interruption_task
        second = self.owner.backend.call_args.args[1]
        self.assertNotEqual(first['interruptionId'], second['interruptionId'])
        self.assertGreaterEqual(second['at'], first['at'])
        self.session.last_interruption_at -= 1
        for _ in range(50):
            self.session.observe_audio_activity(bytes(1920))
        self.assertEqual(self.owner.backend.call_count, 2)

    async def test_accepted_speech_uses_exact_revision_and_never_overwrites_cancellation(self):
        from aiohttp.test_utils import TestClient, TestServer
        client = TestClient(TestServer(self.owner.app()))
        # Avoid service startup's real HTTP client: neither ready nor provider is used.
        await client.start_server()
        self.owner.backend = AsyncMock(return_value=policy(conversationRevision=3))
        s = self.session
        entered, release = asyncio.Event(), asyncio.Event()
        async def say(text):
            entered.set()
            await release.wait()
        s.say = say
        headers = {'Authorization': 'Bearer '+'m'*32}
        self.owner.env['MEDIA_API_KEY'] = 'm'*32
        url = f'/sessions/{s.id}/speak'
        body = {'id': 'reply-revision', 'text': 'Synthetic answer', 'callId': s.call_id}
        try:
            missing = await client.post(url, json=body, headers=headers)
            self.assertEqual(missing.status, 400)
            stale = await client.post(url, json={**body, 'expectedRevision': 2}, headers=headers)
            self.assertEqual(stale.status, 409)
            accepted = await client.post(url, json={**body, 'expectedRevision': 3}, headers=headers)
            self.assertEqual(accepted.status, 202)
            await asyncio.wait_for(entered.wait(), .5)
            self.assertEqual(self.owner.speech.get(body['id'])['state'], 'playing')
            self.owner.cancel_speech(s.id, reason='human_interruption')
            await asyncio.sleep(0)
            replay = await client.post(url, json={**body, 'expectedRevision': 3}, headers=headers)
            self.assertEqual((await replay.json())['state'], 'cancelled')
            changed = await client.post(url, json={**body, 'expectedRevision': 4}, headers=headers)
            self.assertEqual(changed.status, 409)
        finally:
            release.set()
            # No live room exists in this fixture.
            s.close = AsyncMock()
            await client.close()

    async def test_cancellation_before_task_first_step_does_not_block_next_reply(self):
        s = self.session
        self.owner.backend = AsyncMock(return_value=policy())
        s.say = AsyncMock()
        self.owner.speech.accept('never-started', s.id, 'synthetic')
        first = self.owner.schedule_speech(s, 'never-started', 'Synthetic canceled answer')
        # No yield: play_speech has not entered its try/finally yet.
        self.owner.cancel_speech(s.id, reason='human_interruption')
        await asyncio.gather(first, return_exceptions=True)
        self.assertEqual(self.owner.speech.get('never-started')['state'], 'cancelled')
        self.assertEqual(self.owner.speech_tasks, {})
        self.owner.reply_to_segment(s, {'id': '1', 'callId': s.call_id},
                                    {'captured': True, 'reply': 'Synthetic fresh answer'})
        next_tasks = list(self.owner.speech_tasks.values())
        self.assertEqual(len(next_tasks), 1)
        await asyncio.gather(*next_tasks)
        s.say.assert_awaited_once_with('Synthetic fresh answer')

    async def test_transcript_during_playback_keeps_interim_nonexecuting_and_final_survives(self):
        s = self.session
        s.speaking = True
        generation = s.generation
        now = [0.]
        s.utterances.clock = lambda: now[0]
        self.assertFalse(s.accept_transcript(result('Synthetic partial', final=False), generation))
        self.assertTrue(s.segments.empty())
        s.accept_transcript(result('Synthetic correction', boundary=True), generation)
        now[0] = 1
        s.flush_utterance(generation)
        segment = s.segments.get_nowait()
        self.assertEqual(segment['text'], 'Synthetic correction')
        self.assertEqual(s.generation, generation)
        self.assertTrue(s.speech_cancelled)

    async def test_legacy_playback_ignores_incoming_transcripts(self):
        s = self.session
        s.two_way = False
        s.speaking = True
        s.accept_transcript(result('Synthetic command', boundary=True), s.generation)
        self.assertFalse(s.utterances.has_text)
        self.assertTrue(s.segments.empty())

    async def test_revision_cancels_speech_without_rolling_back_or_restarting_capture(self):
        s = self.session
        s.speaking = True
        s.active_reply_id = 'speech-revision'
        s.playback_revision = 1
        s.conversation_revision = 1
        self.owner.speech.accept(s.active_reply_id, s.id, 'synthetic')
        self.owner.speech_tasks[s.active_reply_id] = asyncio.create_task(asyncio.Event().wait())
        s.apply_voice_policy(policy(conversationRevision=2))
        self.assertEqual(self.owner.speech.get(s.active_reply_id)['reason'], 'newer_revision')
        self.assertEqual(s.generation, 0)
        s.apply_voice_policy(policy(conversationRevision=0))
        self.assertEqual(s.conversation_revision, 2)

    async def test_revision_is_rechecked_after_vad_grace_before_any_audio(self):
        s = self.session
        s.conversation_revision = 3
        s.utterances.vad_grace_seconds = .01
        s.utterances.vad_at = time.monotonic()
        s.say = AsyncMock()
        self.owner.backend = AsyncMock(side_effect=[policy(conversationRevision=3), policy(conversationRevision=4)])
        self.owner.speech.accept('reply-wait', s.id, 'synthetic')
        await self.owner.play_speech(s, 'reply-wait', 'Synthetic answer', expected_revision=3)
        s.say.assert_not_awaited()
        self.assertEqual(self.owner.speech.get('reply-wait')['reason'], 'newer_revision')

    async def test_say_keeps_stt_open_and_late_provider_audio_is_rejected_after_interrupt(self):
        s = self.session
        entered, release = asyncio.Event(), asyncio.Event()
        class Response:
            status = 200
            async def __aenter__(self):
                entered.set()
                return self
            async def __aexit__(self, *args):
                return False
            @property
            def content(self):
                return self
            async def iter_chunked(self, size):
                await release.wait()
                yield b'\x00\x10'*960
        self.owner.http = SimpleNamespace(post=lambda *args, **kwargs: Response())
        s.stop_stt = AsyncMock()
        speech = asyncio.create_task(s.say('Synthetic answer'))
        await entered.wait()
        s.stop_stt.assert_not_awaited()
        self.assertTrue(s.allowed)
        self.feed_onset()
        await s.interruption_task
        release.set()
        with self.assertRaisesRegex(RuntimeError, 'TTS exceeds bounds'):
            await speech
        self.assertTrue(s.audio.empty())
        self.assertFalse(s.speaking)
        self.assertTrue(s.allowed)
        self.assertEqual(s.generation, 0)

    async def test_publisher_drops_obsolete_generation_and_canceled_barrier(self):
        s = self.session
        s.playback_generation = 2
        stale = b'\x00\x10'*960
        barrier = asyncio.get_running_loop().create_future()
        s.audio.put_nowait((1, stale))
        s.audio.put_nowait((1, barrier))
        frames = []
        async def capture(frame):
            frames.append(bytes(frame.data))
            s.closing = True
        s.source.capture_frame = capture
        await s.publish()
        self.assertEqual(frames, [bytes(1920)])
        self.assertTrue(barrier.cancelled())

    async def test_streaming_stage_measurements_share_reply_correlation_without_content(self):
        s = self.session
        s.active_reply_id = 'timing-reply'
        class Response:
            status = 200
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            @property
            def content(self):
                return self
            async def iter_chunked(self, size):
                yield b'\x00\x10'*960
        self.owner.http = SimpleNamespace(post=lambda *args, **kwargs: Response())
        s.source.capture_frame = AsyncMock()
        s.source.wait_for_playout = AsyncMock()
        publisher = asyncio.create_task(s.publish())
        try:
            await s.say('PRIVATE synthetic reply')
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)
        events = [event for event in s.speech_diagnostics.events if event['event'] in
                  ('tts_requested', 'tts_first_byte', 'audio_first_published', 'audio_last_published')]
        self.assertEqual([event['event'] for event in events],
                         ['tts_requested', 'tts_first_byte', 'audio_first_published', 'audio_last_published'])
        self.assertEqual(len({event['correlationId'] for event in events}), 1)
        self.assertEqual(len({event['playbackGeneration'] for event in events}), 1)
        self.assertEqual([event['elapsedMs'] for event in events], sorted(event['elapsedMs'] for event in events))
        self.assertNotIn('PRIVATE', json.dumps(events))
        self.assertTrue(s.allowed)

    async def test_policy_loss_reverts_duplex_and_cancels_playback(self):
        s = self.session
        s.speaking = True
        s.audio.put_nowait((s.playback_generation, bytes(1920)))
        s.apply_voice_policy(policy(remoteAudioIsolated=False))
        self.assertFalse(s.two_way)
        self.assertTrue(s.audio.empty())
        self.assertTrue(s.playback_blocks_capture)
