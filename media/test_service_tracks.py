"""Track subscription regression through Session.prepare's actual event handlers.

Only synthetic SDK/provider objects; no rooms, media capture or provider effects.
"""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from livekit import rtc
from server import Session


class FakeRoom:
    def __init__(self):
        self.handlers = {}
        self.connect = AsyncMock()
        self.local_participant = SimpleNamespace(publish_track=AsyncMock())

    def on(self, event):
        def register(callback):
            self.handlers[event] = callback
            return callback
        return register


class RemoteTrackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        owner = SimpleNamespace(env={
            'LIVEKIT_URL': 'wss://fixture.invalid',
            'LIVEKIT_API_KEY': 'fixture-key',
            'LIVEKIT_API_SECRET': 'fixture-secret-not-a-live-credential',
        }, lk=SimpleNamespace(room=SimpleNamespace(create_room=AsyncMock())))
        self.session = Session(owner, {'id': 'ct_'+'a'*40, 'meetingId': 'fixture'})
        self.session.room = FakeRoom()
        self.session.publish = AsyncMock()
        self.session.deliver = AsyncMock()
        self.session.watch_policy = AsyncMock()
        self.session.capture_loop = AsyncMock()
        self.session.fail = AsyncMock()
        self.session.say = AsyncMock()
        with patch('server.rtc.AudioSource'), patch('server.rtc.LocalAudioTrack.create_audio_track'):
            await self.session.prepare()
        await asyncio.sleep(0)
        self.handler = self.session.room.handlers['track_subscribed']
        self.worker = SimpleNamespace(identity=self.session.worker_identity)

    async def asyncTearDown(self):
        await asyncio.gather(*list(self.session.tasks), return_exceptions=True)

    async def subscribe(self, kind, sid, participant=None, failure=None):
        track = SimpleNamespace(kind=kind)
        publication = SimpleNamespace(sid=sid, set_subscribed=Mock(side_effect=failure))
        self.handler(track, publication, participant or self.worker)
        await asyncio.sleep(0)
        return track, publication

    async def test_expected_video_before_audio_does_not_end_or_activate_call(self):
        _, video = await self.subscribe(rtc.TrackKind.KIND_VIDEO, 'caller-video')
        video.set_subscribed.assert_called_once_with(False)
        self.session.fail.assert_not_awaited()
        self.session.capture_loop.assert_not_awaited()
        self.assertIsNone(self.session.track_sid)
        self.assertFalse(self.session.active)
        self.assertFalse(self.session.allowed)
        audio, _ = await self.subscribe(rtc.TrackKind.KIND_AUDIO, 'caller-audio')
        self.assertIs(self.session.track, audio)
        self.session.capture_loop.assert_awaited_once()
        # Disclosure remains required; ignoring video grants no capture authority.
        await self.session.activate('owned-call')
        self.session.say.assert_awaited_once()
        self.assertTrue(self.session.active)
        self.session.fail.assert_not_awaited()

    async def test_video_after_audio_preserves_exact_audio_track_and_active_session(self):
        audio, _ = await self.subscribe(rtc.TrackKind.KIND_AUDIO, 'caller-audio')
        self.session.active = True
        _, video = await self.subscribe(rtc.TrackKind.KIND_VIDEO, 'caller-video')
        video.set_subscribed.assert_called_once_with(False)
        self.assertIs(self.session.track, audio)
        self.assertEqual(self.session.track_sid, 'caller-audio')
        self.session.capture_loop.assert_awaited_once()
        self.session.fail.assert_not_awaited()
        self.assertTrue(self.session.active)

    async def test_foreign_video_is_rejected_before_expected_video_exception(self):
        _, publication = await self.subscribe(rtc.TrackKind.KIND_VIDEO, 'foreign-video', SimpleNamespace(identity='foreign'))
        self.session.fail.assert_awaited_once()
        publication.set_subscribed.assert_not_called()
        self.session.capture_loop.assert_not_awaited()
        self.assertIsNone(self.session.track_sid)

    async def test_foreign_audio_remains_rejected(self):
        await self.subscribe(rtc.TrackKind.KIND_AUDIO, 'foreign-audio', SimpleNamespace(identity='foreign'))
        self.session.fail.assert_awaited_once()
        self.session.capture_loop.assert_not_awaited()

    async def test_unknown_track_kind_remains_rejected(self):
        await self.subscribe(-1, 'unsupported-track')
        self.session.fail.assert_awaited_once()
        self.session.capture_loop.assert_not_awaited()

    async def test_second_audio_identity_still_fails_closed(self):
        audio, _ = await self.subscribe(rtc.TrackKind.KIND_AUDIO, 'first-audio')
        await self.subscribe(rtc.TrackKind.KIND_VIDEO, 'caller-video')
        await self.subscribe(rtc.TrackKind.KIND_AUDIO, 'second-audio')
        self.session.fail.assert_awaited_once()
        self.assertIs(self.session.track, audio)
        self.assertEqual(self.session.track_sid, 'first-audio')
        self.session.capture_loop.assert_awaited_once()

    async def test_worker_disconnect_during_normal_close_is_not_failure(self):
        self.session.lifecycle.close('backend_close')
        self.session.room.handlers['participant_disconnected'](self.worker)
        self.session.room.handlers['disconnected']()
        await asyncio.sleep(0)
        self.session.fail.assert_not_awaited()
        self.assertNotIn('firstFailure', self.session.lifecycle.data)

    async def test_worker_disconnect_retains_specific_reason_before_fail_task(self):
        self.session.room.handlers['participant_disconnected'](self.worker)
        first = self.session.lifecycle.data['firstFailure']
        self.assertEqual(first['reason'], 'remote_participant_disconnected')
        self.assertEqual(first['category'], 'room_event')
        self.session.fail.assert_not_awaited()
        await asyncio.sleep(0)
        self.session.fail.assert_awaited_once()

    async def test_unsubscription_failure_fails_closed_without_video_stream(self):
        await self.subscribe(rtc.TrackKind.KIND_VIDEO, 'caller-video', failure=RuntimeError('fixture only'))
        self.session.fail.assert_awaited_once()
        self.session.capture_loop.assert_not_awaited()
        self.assertIsNone(self.session.track)


if __name__ == '__main__':
    unittest.main()
