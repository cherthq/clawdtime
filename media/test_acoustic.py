"""Execution-disabled admission and lifetime boundaries; no handset/provider."""
import asyncio
import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from acoustic import AcousticFrontend, QUALIFICATION_NOTICE, allowed, readiness
from server import Service, Session, BackendRequestError, NOTICE


ENV = {'MEDIA_AUDIO_QUALIFICATION_ENABLED': 'true', 'OPENAI_API_KEY': 'synthetic'}


def policy(**changes):
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
    return {'callId': 'owned-call', 'state': 'listening', 'expiresAt': expiry,
            'protocolVersion': 2, 'voiceMode': 'audio_qualification', 'remoteAudioIsolated': False,
            'captionsEnabled': False,
            'audioQualification': {'version': 1, 'executionDisabled': True, 'expiresAt': expiry}, **changes}


class AcousticPolicyTests(unittest.TestCase):
    def test_explicit_audio_mode_does_not_require_or_admit_fake_isolation(self):
        self.assertTrue(allowed(policy(), ENV))
        self.assertFalse(allowed(policy(), {}))
        for change in ({'remoteAudioIsolated': True}, {'voiceMode': 'two_way'}, {'captionsEnabled': True},
                       {'muted': True}, {'state': 'paused'}, {'protocolVersion': 1},
                       {'screenSelection': None}, {'presentation': None}, {'presentationBinding': None},
                       {'presentationSequence': 1}, {'documentPreview': None}, {'conversationVersion': 1}, {'conversationFrontend': 'gpt_live'}):
            with self.subTest(change=change):
                self.assertFalse(allowed(policy(**change), ENV))

    def test_expiry_shape_and_binding_cannot_be_extended(self):
        p = policy()
        self.assertFalse(allowed(p, ENV, call_id='wrong'))
        self.assertFalse(allowed(p, ENV, expiry='changed'))
        for q in (None, {}, {'version': True, 'executionDisabled': True, 'expiresAt': p['expiresAt']},
                  {'version': 1, 'executionDisabled': False, 'expiresAt': p['expiresAt']},
                  {'version': 1, 'executionDisabled': True, 'expiresAt': 'malformed'}):
            self.assertFalse(allowed({**p, 'audioQualification': q}, ENV))
        for seconds in (-1, 301):
            q = {**p['audioQualification'], 'expiresAt': (datetime.now(timezone.utc)+timedelta(seconds=seconds)).isoformat()}
            self.assertFalse(allowed({**p, 'audioQualification': q}, ENV))


class AcousticBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service = Service({**ENV, 'MEDIA_API_KEY': 'x'*32, 'MEDIA_DATABASE_PATH': str(Path(self.tmp.name)/'test.sqlite')})
        self.session = Session(self.service, {'id': 'ct_'+'a'*40, 'meetingId': 'request',
            'audioQualification': True, 'captions': False, 'screen': False})
        self.service.sessions[self.session.id] = self.session
        self.p = policy()
        self.session.call_id = 'owned-call'
        self.session.active = self.session.allowed = True
        self.session.policy_at = time.monotonic()
        self.session.protocol_version = 2
        self.session.track_sid = 'synthetic-track'
        self.session.live_frontend = AcousticFrontend(self.session, self.p)
        self.session.apply_voice_policy(self.p)

    async def asyncTearDown(self):
        for task in list(self.session.tasks):
            task.cancel()
        await asyncio.gather(*self.session.tasks, return_exceptions=True)
        self.service.db.close()
        self.tmp.cleanup()

    def request(self, action='activate', body=None):
        return SimpleNamespace(match_info={'id': self.session.id, 'action': action},
                               json=AsyncMock(return_value=body or {'callId': 'owned-call'}))

    async def test_no_screens_captions_broker_or_legacy_segments(self):
        self.assertIsNone(self.session.screen)
        self.assertIsNone(self.session.caption_scene)
        self.assertFalse(hasattr(self.session.live_frontend, 'broker'))
        self.assertFalse(self.session.queue_segment({'id': '1', 'text': 'perform work'}))
        self.assertFalse(self.session.accept_transcript({'type': 'Results'}, self.session.generation))
        self.assertTrue(self.session.segments.empty())
        for path in ('segments', 'interrupt', 'conversation/turn', 'conversation/jobs'):
            with self.assertRaises(BackendRequestError):
                await self.service.backend(f'/media/{self.session.id}/{path}', {})

    async def test_external_speech_and_device_actions_rejected_before_dispatch(self):
        with self.assertRaises(web.HTTPConflict):
            await self.service.action(self.request('speak'))
        with self.assertRaises(web.HTTPConflict):
            await self.service.device_actions.post(self.request(body={'text': 'perform work'}))
        self.assertEqual(self.service.speech_tasks, {})
        self.session.greeted = True
        with self.assertRaises(web.HTTPConflict):
            await self.session.say(NOTICE)

    async def test_qualification_notice_is_once_and_precedes_model_start(self):
        events = []
        self.service.backend = AsyncMock(return_value=self.p)
        async def notice(text):
            events.append(text)
        async def start():
            events.append('model_started')
        self.session.say = AsyncMock(side_effect=notice)
        self.session.live_frontend.start = AsyncMock(side_effect=start)
        await asyncio.gather(self.session.activate('owned-call'), self.session.activate('owned-call'))
        self.assertEqual(events, [QUALIFICATION_NOTICE, 'model_started'])

    async def test_inert_video_contains_only_solid_pixels(self):
        self.session.qualification_video = Mock()
        task = asyncio.create_task(self.session.publish_qualification_video())
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        frame = self.session.qualification_video.capture_frame.call_args.args[0]
        self.assertEqual((frame.width, frame.height), (640, 360))
        self.assertEqual(bytes(frame.data), bytes((0, 0, 0, 255))*(640*360))
        self.assertIsNone(self.session.screen)

    async def test_local_queue_quiet_clears_speaking_without_claiming_provider_done(self):
        self.session.speaking = True
        frontend = self.session.live_frontend
        frontend.started = True
        task = asyncio.create_task(frontend.watch())
        await asyncio.sleep(0)
        self.assertFalse(self.session.speaking)
        self.assertFalse(frontend.finalized.is_set())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_prepare_marker_cannot_request_screen_or_caption(self):
        self.service.ready = lambda: True
        for changes in ({'screen': True}, {'captions': True}, {'audioQualification': False}):
            body = {**self.session.spec, 'lineId': 'synthetic-line', **changes}
            with self.assertRaises(web.HTTPBadRequest):
                await self.service.prepare(self.request(body=body))

    async def test_successful_activation_reports_only_actual_acoustic_owner(self):
        self.service.backend=AsyncMock(return_value=self.p)
        self.session.activate=AsyncMock(return_value={'activated':True})
        response=await self.service.action(self.request())
        self.assertEqual(json.loads(response.body),{'activated':True,'audioQualification':True})

    async def test_activate_rejects_missing_or_mutated_mode(self):
        self.service.backend = AsyncMock(return_value={**self.p, 'audioQualification': None})
        self.session.activate = AsyncMock()
        with self.assertRaises(web.HTTPConflict):
            await self.service.action(self.request())
        self.session.activate.assert_not_called()
        self.session.activation = asyncio.get_running_loop().create_future()
        newer = policy()
        self.service.backend.return_value = newer
        with self.assertRaises(web.HTTPConflict):
            await self.service.action(self.request())
        self.session.activation.cancel()

    async def test_onset_cuts_audio_without_any_backend_interrupt(self):
        self.service.backend = AsyncMock()
        self.session.source = SimpleNamespace(clear_queue=Mock())
        self.session.speaking = True
        self.session.audio.put_nowait((0, bytes(1920)))
        for _ in range(6):
            self.session.observe_audio_activity(b'\x00\x10'*960)
        self.assertTrue(self.session.audio.empty())
        self.assertTrue(self.session.live_frontend.suppressed)
        self.service.backend.assert_not_called()
        self.assertIsNone(self.session.interruption_task)

    async def test_watchdog_fails_closed_on_stale_policy_even_when_network_is_stuck(self):
        self.session.policy_at -= 3
        self.session.fail = AsyncMock()
        await self.session.live_frontend.watch()
        self.assertFalse(self.session.allowed)
        self.session.fail.assert_awaited_once()

    async def test_fixed_monotonic_deadline_and_local_stop_latch(self):
        frontend = self.session.live_frontend
        self.assertTrue(frontend.authorized())
        self.session.pause_latched = True
        self.assertFalse(frontend.authorized())
        self.session.pause_latched = False
        frontend.deadline = time.monotonic()-1
        self.session.policy_at = time.monotonic()
        self.assertFalse(frontend.authorized())
        self.session.fail = AsyncMock()
        await frontend.watch()
        self.session.fail.assert_awaited_once_with('maximum_duration', 'deadline')

    async def test_policy_revocation_or_unavailability_closes_and_cannot_resume(self):
        for outcome in ({**self.p, 'muted': True}, {**self.p, 'state': 'paused'}, RuntimeError('synthetic')):
            self.session.close = AsyncMock()
            self.service.backend = AsyncMock(side_effect=outcome if isinstance(outcome, Exception) else None,
                                              return_value=outcome)
            await self.session.watch_policy()
            self.session.close.assert_awaited_once_with('policy_ended')

    async def test_cutoff_never_resumes_from_silence_or_elapsed_time(self):
        frontend = self.session.live_frontend
        frontend.cutoff()
        speech = base64.b64encode(b'\x01\x01'*4800).decode()
        silence = base64.b64encode(bytes(9600)).decode()
        await frontend.output(speech)
        self.assertTrue(frontend.suppressed)
        await frontend.output(silence)
        self.assertTrue(frontend.suppressed)
        self.session.onset.silent_ms = 200
        await frontend.output(silence)
        self.assertTrue(frontend.suppressed)
        self.assertTrue(self.session.audio.empty())

    async def test_readiness_is_authenticated_and_metadata_only(self):
        client = TestClient(TestServer(self.service.app()))
        await client.start_server()
        try:
            self.assertEqual((await client.get('/audio-qualification/readiness')).status, 401)
            response = await client.get('/audio-qualification/readiness', headers={'Authorization': 'Bearer '+'x'*32})
            self.assertEqual(response.status, 200)
            value = await response.json()
            self.assertEqual(set(value), {'version', 'enabled', 'directKeyConfigured', 'sdk', 'websocketQualified'})
            self.assertNotIn('synthetic', json.dumps(value))
        finally:
            # Test app startup owns a disposable HTTP client, no configured live credentials.
            self.service.sessions.clear()
            await client.close()
