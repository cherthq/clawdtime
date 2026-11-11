import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from captions import CaptionScene, CaptionRenderer, CaptionPublisher


class CaptionSceneTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.scene = CaptionScene('meeting', clock=lambda: self.now)
        self.policy = {'callId': 'call-1', 'state': 'listening', 'captionsEnabled': True,
                       'title': 'Launch review',
                       'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        self.scene.apply_policy(self.policy)

    def test_requires_exact_call_policy_and_fresh_lease(self):
        self.assertTrue(self.scene.append({'id': '1', 'text': 'We launch Friday.'}))
        self.assertEqual(self.scene.snapshot()['segments'], ['We launch Friday.'])
        self.now += 2.1
        self.assertEqual(self.scene.snapshot()['segments'], [])
        self.assertEqual(self.scene.snapshot()['state'], 'reconnecting')
        self.scene.apply_policy({**self.policy, 'callId': 'other-call'})
        self.assertFalse(self.scene.append({'id': '2', 'text': 'Wrong call'}))
        self.assertEqual(self.scene.snapshot()['segments'], [])

    def test_pause_revocation_and_resume_do_not_reveal_retained_text(self):
        self.scene.append({'id': '1', 'text': 'Private budget 42.'})
        self.scene.apply_policy({**self.policy, 'state': 'paused'})
        self.assertEqual(self.scene.snapshot()['segments'], [])
        self.assertFalse(self.scene.append({'id': '2', 'text': 'Paused secret'}))
        self.scene.apply_policy(self.policy)
        self.assertEqual(self.scene.snapshot()['segments'], [])
        self.assertFalse(self.scene.append({'id': '1', 'text': 'Private budget 42.'}))
        self.assertTrue(self.scene.append({'id': '3', 'text': 'New approved text'}))
        self.scene.apply_policy({**self.policy, 'captionsEnabled': False})
        self.assertEqual(self.scene.snapshot()['segments'], [])
        self.assertFalse(self.scene.append({'id': '4', 'text': 'Revoked secret'}))

    def test_final_segments_are_bounded_ordered_and_not_replayed(self):
        for index in range(1, 10):
            self.scene.append({'id': str(index), 'text': f'Sentence {index}.'})
        self.assertEqual(self.scene.snapshot()['segments'], ['Sentence 7.', 'Sentence 8.', 'Sentence 9.'])
        self.assertFalse(self.scene.append({'id': '9', 'text': 'Duplicate'}))
        self.assertFalse(self.scene.append({'id': '4', 'text': 'Late'}))
        self.assertFalse(self.scene.append({'id': 'malformed', 'text': 'Bad ID'}))
        self.scene.append({'id': '10', 'text': 'x' * 8000})
        self.assertLessEqual(len(self.scene.snapshot()['segments'][-1]), 500)
        self.scene.clear('ended')
        self.assertEqual(self.scene.snapshot()['segments'], [])

    def test_renderer_never_includes_previous_caption_after_pause(self):
        renderer = CaptionRenderer()
        self.scene.append({'id': '1', 'text': 'Private budget 42.'})
        first = renderer.render(self.scene.snapshot())
        self.scene.apply_policy({**self.policy, 'state': 'paused'})
        cleared = renderer.render(self.scene.snapshot())
        fresh = CaptionScene('meeting', clock=lambda: self.now)
        fresh.apply_policy({**self.policy, 'state': 'paused'})
        self.assertEqual(cleared.tobytes(), renderer.render(fresh.snapshot()).tobytes())
        self.assertNotEqual(first.tobytes(), cleared.tobytes())
        self.assertEqual(cleared.size, (1280, 720))

    def test_long_text_layout_stays_inside_the_caption_region(self):
        renderer = CaptionRenderer()
        lines = renderer.lines(['ExtraordinarilyLongUnbrokenToken' * 80, 'A final decision.'])
        self.assertLessEqual(len(lines), 9)
        self.assertTrue(all(renderer.measure(line) <= 336 for line in lines))
        self.assertIn('A final decision.', lines)


class CaptionPublisherTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_video_publication_repeats_frames_and_cleans_up(self):
        source = Mock()
        source.aclose = AsyncMock()
        participant = SimpleNamespace(publish_track=AsyncMock(return_value=SimpleNamespace(sid='video-1')),
                                      unpublish_track=AsyncMock())
        sdk = SimpleNamespace(VideoSource=Mock(return_value=source),
            LocalVideoTrack=SimpleNamespace(create_video_track=Mock(return_value='video-track')),
            TrackPublishOptions=lambda **kw: kw, TrackSource=SimpleNamespace(SOURCE_CAMERA=1),
            VideoEncoding=lambda **kw: kw, VideoCodec=SimpleNamespace(H264=1),
            VideoFrame=lambda *args: args, VideoBufferType=SimpleNamespace(RGBA=1))
        scene = CaptionScene('meeting')
        publisher = CaptionPublisher(scene, SimpleNamespace(local_participant=participant), sdk=sdk)
        await publisher.start()
        await asyncio.sleep(.24)
        await publisher.close()
        participant.publish_track.assert_awaited_once()
        self.assertGreaterEqual(source.capture_frame.call_count, 3)
        participant.unpublish_track.assert_awaited_once_with('video-1')
        source.aclose.assert_awaited_once()
        self.assertEqual(scene.snapshot()['state'], 'ended')

    async def test_real_sdk_accepts_rendered_rgba_and_publication_options(self):
        # Exercise installed SDK constructors/FFI, without a network room or call.
        participant = SimpleNamespace(publish_track=AsyncMock(return_value=SimpleNamespace(sid='video-real')),
                                      unpublish_track=AsyncMock())
        publisher = CaptionPublisher(CaptionScene('meeting'), SimpleNamespace(local_participant=participant))
        await publisher.start()
        self.assertEqual(publisher.frame.width, 1280)
        self.assertEqual(publisher.frame.height, 720)
        options = participant.publish_track.call_args.args[1]
        self.assertEqual(options.video_encoding.max_framerate, 5)
        await publisher.close()

    async def test_capture_failure_removes_video_without_touching_audio(self):
        source = Mock()
        source.aclose = AsyncMock()
        participant = SimpleNamespace(publish_track=AsyncMock(return_value=SimpleNamespace(sid='video-1')),
                                      unpublish_track=AsyncMock())
        sdk = SimpleNamespace(VideoSource=Mock(return_value=source),
            LocalVideoTrack=SimpleNamespace(create_video_track=Mock(return_value='video-track')),
            TrackPublishOptions=lambda **kw: kw, TrackSource=SimpleNamespace(SOURCE_CAMERA=1),
            VideoEncoding=lambda **kw: kw, VideoCodec=SimpleNamespace(H264=1),
            VideoFrame=lambda *args: args, VideoBufferType=SimpleNamespace(RGBA=1))
        publisher = CaptionPublisher(CaptionScene('meeting'), SimpleNamespace(local_participant=participant), sdk=sdk)
        await publisher.start()
        source.capture_frame.side_effect = RuntimeError('video failure')
        await asyncio.sleep(.24)
        self.assertTrue(publisher.failed)
        participant.unpublish_track.assert_awaited_once_with('video-1')
        await publisher.close()


if __name__ == '__main__':
    unittest.main()
