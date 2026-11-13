"""A real activation notice must precede the worker's non-silent output deadline."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from server import NOTICE
import test_caption_service
from test_caption_experience import policy


class ConnectionNoticeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_caption_service.CaptionServiceTests.asyncSetUp
    asyncTearDown = test_caption_service.CaptionServiceTests.asyncTearDown
    fixture_session = test_caption_service.CaptionServiceTests.fixture_session

    def session(self):
        s = self.fixture_session()
        s.active = s.allowed = False
        s.protocol_version = 2
        s.source = AsyncMock()
        s.source.clear_queue = Mock()
        self.service.sessions[s.id] = s
        self.service.backend = AsyncMock(return_value=policy())
        return s

    async def test_concurrent_activation_publishes_notice_before_any_reply_exactly_once(self):
        s = self.session()
        self.service.env['DEEPGRAM_API_KEY'] = 'synthetic'
        posted, frames = [], []
        async def chunks(_):
            yield b'\x00\x10' * 960
        context = AsyncMock()
        context.__aenter__.return_value = SimpleNamespace(status=200,
            content=SimpleNamespace(iter_chunked=chunks))
        def post(_url, **kwargs):
            posted.append(kwargs['json']['text'])
            return context
        async def capture(frame):
            frames.append(bytes(frame.data))
        s.source.capture_frame.side_effect = capture
        publisher = asyncio.create_task(s.publish())
        try:
            with patch.object(self.service.http, 'post', side_effect=post):
                await asyncio.gather(s.activate(s.call_id), s.activate(s.call_id))
                self.assertTrue(any(any(frame) for frame in frames))
                self.assertEqual(posted, [NOTICE])
                self.assertEqual(s.segment_count, 0)
                self.assertTrue(s.segments.empty())
                self.assertFalse(self.service.speech_tasks)
                await s.say('Synthetic actual agent reply.')
                self.assertEqual(posted, [NOTICE, 'Synthetic actual agent reply.'])
                await s.activate(s.call_id)
                self.assertEqual(len(posted), 2)
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)

    async def test_muted_activation_does_not_speak_or_retry_after_unmute(self):
        s = self.session()
        self.service.backend.return_value = {**policy(), 'muted': True}
        s.say = AsyncMock()
        await s.activate(s.call_id)
        self.service.backend.return_value = policy()
        await s.activate(s.call_id)
        s.say.assert_not_awaited()
        self.assertFalse(s.allowed)

    async def test_fresh_policy_and_local_stop_are_checked_before_notice(self):
        for override in ({'callId': 'foreign'}, {'state': 'paused'},
                         {'expiresAt': '2000-01-01T00:00:00Z'}, {}):
            with self.subTest(override=override):
                s = self.session()
                s.pause_latched = not override
                self.service.backend.return_value = {**policy(), **override}
                s.say = AsyncMock()
                s.fail = AsyncMock()
                with self.assertRaises(web.HTTPConflict):
                    await s.activate(s.call_id)
                s.say.assert_not_awaited()
                self.assertFalse(s.active)

    async def test_policy_mute_cancels_pending_notice_without_hangup_or_replay(self):
        s = self.session()
        started = asyncio.Event()
        async def pending_notice(_):
            s.speaking = True
            started.set()
            try:
                await asyncio.Future()
            finally:
                s.speaking = False
        s.say = AsyncMock(side_effect=pending_notice)
        activation = asyncio.create_task(s.activate(s.call_id))
        await started.wait()
        self.assertTrue(s.active)
        self.service.backend.return_value = {**policy(), 'muted': True}
        watcher = asyncio.create_task(s.watch_policy())
        try:
            await asyncio.wait_for(activation, 1)
            self.assertFalse(s.closing)
            self.assertTrue(s.speech_cancelled)
            self.assertFalse(s.allowed)
            await s.activate(s.call_id)
            s.say.assert_awaited_once()
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def test_close_during_notice_cannot_report_activation_success(self):
        s = self.session()
        started = asyncio.Event()
        async def pending_notice(_):
            started.set()
            await asyncio.Future()
        s.say = AsyncMock(side_effect=pending_notice)
        s.fail = AsyncMock()
        activation = asyncio.create_task(s.activate(s.call_id))
        await started.wait()
        s.closing = True
        self.service.cancel_speech(s.id)
        with self.assertRaises(web.HTTPConflict):
            await activation
        self.assertIsNone(s.connection_notice)

    async def test_duplex_notice_retains_capture_and_half_duplex_still_blocks_it(self):
        for duplex in (False, True):
            with self.subTest(duplex=duplex):
                s = self.session()
                s.two_way = duplex
                s.active = s.allowed = True
                s.stop_stt = AsyncMock()
                self.service.env['DEEPGRAM_API_KEY'] = 'synthetic'
                started = asyncio.Event()
                context = AsyncMock()
                async def entering():
                    started.set()
                    await asyncio.Future()
                context.__aenter__.side_effect = entering
                with patch.object(self.service.http, 'post', return_value=context):
                    notice = asyncio.create_task(s.say(NOTICE))
                    await started.wait()
                    self.assertEqual(s.playback_blocks_capture, not duplex)
                    self.assertEqual(s.allowed, duplex)
                    self.assertEqual(s.stop_stt.await_count, int(not duplex))
                    notice.cancel()
                    await asyncio.gather(notice, return_exceptions=True)

    async def test_provider_wait_is_bounded_and_failed_activation_never_retries(self):
        s = self.session()
        async def pending_notice(_):
            s.audio.put_nowait((s.playback_generation, b'\x00\x10' * 960))
            await asyncio.Future()
        s.say = AsyncMock(side_effect=pending_notice)
        s.fail = AsyncMock()
        with patch('server.CONNECTION_NOTICE_TIMEOUT', .01):
            with self.assertRaises(TimeoutError):
                await s.activate(s.call_id)
        with self.assertRaises(TimeoutError):
            await s.activate(s.call_id)
        s.say.assert_awaited_once()
        s.fail.assert_awaited_once_with('activation_failed', 'activation')
        self.assertIsNone(s.connection_notice)
        self.assertTrue(s.audio.empty())
        s.source.clear_queue.assert_called()

    async def test_actual_close_cancels_activation_waiting_for_policy(self):
        s = self.session()
        started = asyncio.Event()
        async def pending_policy(_):
            started.set()
            await asyncio.Future()
        self.service.backend.side_effect = pending_policy
        self.service.delete_room = AsyncMock()
        s.room.disconnect = AsyncMock()
        s.say = AsyncMock()
        activation = asyncio.create_task(s.activate(s.call_id))
        await started.wait()
        await s.close()
        with self.assertRaises(asyncio.CancelledError):
            await activation
        s.say.assert_not_awaited()
        self.assertTrue(s.closed)

    async def test_close_while_policy_is_pending_prevents_starting_notice(self):
        s = self.session()
        started, release = asyncio.Event(), asyncio.Event()
        async def pending_policy(_):
            started.set()
            await release.wait()
            return policy()
        self.service.backend.side_effect = pending_policy
        s.say = AsyncMock()
        s.fail = AsyncMock()
        activation = asyncio.create_task(s.activate(s.call_id))
        await started.wait()
        s.closing = True
        release.set()
        with self.assertRaises(web.HTTPConflict):
            await activation
        s.say.assert_not_awaited()
