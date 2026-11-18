import asyncio
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from task_voice import VoiceError
from task_presentation import TaskPresentationRuntime, PresentationJournal, validate_prepare
from task_presentation_local import AttachedSink, control_app
from task_presentation_narrator import PresentationNarrator


def fixture():
    now = time.time() * 1000
    target = {'appId': 'com.example.fixture', 'windowId': '101', 'ownerPid': 123,
              'processIdentity': 'a' * 64, 'displayId': 1, 'titleHash': 'b' * 64}
    manifest = {'version': 1, 'id': 'presentation_fixture', 'sessionId': 'session_fixture',
        'taskId': 'task_fixture', 'runId': 'run_fixture', 'taskRevision': 4,
        'verificationId': 'verification_fixture', 'kind': 'review', 'opening': 'The filter now handles an empty result.',
        'fps': 15, 'scenes': [{'id': 'scene_code', 'kind': 'code', 'title': 'Filter implementation',
            'narration': 'The filter now handles an empty result.', 'expectedOutcome': 'A clear empty state.',
            'target': target, 'focus': {'x': .2, 'y': .2, 'width': .6, 'height': .6}, 'transitionMs': 450}]}
    grant = {'version': 1, 'id': 'grant_fixture', 'manifestFingerprint': 'c' * 64,
        'sessionId': manifest['sessionId'], 'taskId': manifest['taskId'], 'runId': manifest['runId'],
        'taskRevision': 4, 'hostId': 'host_fixture', 'authorizedAt': now, 'expiresAt': now + 600000,
        'localOnly': True, 'capture': True, 'presentation': True, 'control': False, 'nativeActivation': False, 'calls': False}
    return {'presentationId': manifest['id'], 'manifest': manifest, 'grant': grant, 'fingerprint': 'c' * 64}


class Source:
    def __init__(self):
        self.started = self.closed = False
        self.calls = []
        self.capture_gate = None
        self.geometry = 'geometry_fixture'
    async def start(self):
        self.started = True
    async def request(self, op, target):
        self.calls.append(op)
        if op == 'inspect':
            return {'target': target}
        if self.capture_gate:
            await self.capture_gate.wait()
        count = len(self.calls)
        return {'target': copy.deepcopy(target), 'sourceFrameId': 'frame_' + str(count),
                'geometryGeneration': self.geometry, 'contentRevision': hashlib.sha256(str(count).encode()).hexdigest(),
                'capturedAt': time.time() * 1000, 'image': Image.new('RGB', (800, 600), '#568cab')}
    async def close(self):
        self.closed = True
        return True


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.binding = fixture()
        self.authority = SimpleNamespace(check=AsyncMock(side_effect=lambda generation=None: {'generation': generation if generation is not None else self.remote_generation}))
        self.remote_generation = 0
        self.source = Source()
        self.journal = PresentationJournal(Path(self.temp.name) / 'receipts.sqlite')
        self.narrator = SimpleNamespace(interrupt=AsyncMock(), close=AsyncMock(),
            speak=AsyncMock(return_value={'completed': True, 'evidence': 'playback_completed_not_audibility'}))
        self.runtime = TaskPresentationRuntime(self.binding, self.authority, self.source, self.journal, narrator=self.narrator)
    async def asyncTearDown(self):
        await self.runtime.stop()
        self.journal.close()
        self.temp.cleanup()
    def show_body(self, generation=1):
        return {'presentationId': self.binding['presentationId'], 'manifestFingerprint': self.binding['fingerprint'],
                'operationId': 'show_' + str(generation), 'sceneId': 'scene_code', 'generation': generation}
    async def start(self):
        await self.runtime.prepare(self.binding)
        await self.runtime.local_start()
    async def show(self):
        self.remote_generation = 1
        return await self.runtime.show(self.show_body())
    def narration(self, frame):
        return {'presentationId': self.binding['presentationId'], 'operationId': 'narration_one', 'sceneId': 'scene_code',
            'generation': 1, 'frame': frame, 'text': self.binding['manifest']['scenes'][0]['narration']}

    async def test_prepare_is_metadata_only_and_local_start_required(self):
        await self.runtime.prepare(self.binding)
        self.assertFalse(self.source.started)
        self.assertEqual(self.source.calls, [])
        with self.assertRaises(VoiceError):
            await self.runtime.show(self.show_body())
        self.narrator.speak.assert_not_awaited()
        await self.runtime.local_start()
        self.assertEqual(self.source.calls, ['inspect'])
        self.assertIsNone(self.runtime.output)

    async def test_real_renderer_15fps_easing_waits_for_posttransition_capture(self):
        await self.start()
        frame = await self.show()
        self.assertGreaterEqual(frame['capturedAt'], frame['transitionCompletedAt'])
        self.assertGreaterEqual(frame['renderedAt'], frame['capturedAt'])
        self.assertEqual(frame['target'], self.binding['manifest']['scenes'][0]['target'])
        self.assertEqual(frame['evidence'], 'local_frame_rendered_not_human_seen')
        self.assertGreaterEqual(self.runtime.counts['renderedFrames'], 7)
        self.assertGreaterEqual(self.runtime.counts['sourceFrames'], 4)
        self.assertTrue(self.runtime.output.startswith(b'\xff\xd8'))
        self.runtime.acknowledge_paint(self.runtime.output_token)
        result = await self.runtime.narrate(self.narration(frame))
        self.assertTrue(result['completed'])
        self.narrator.speak.assert_awaited_once()

    async def test_forged_frame_or_narration_refused_before_provider(self):
        await self.start()
        frame = await self.show()
        forged = dict(frame, contentRevision='d' * 64)
        with self.assertRaises(VoiceError):
            await self.runtime.narrate(self.narration(forged))
        self.narrator.speak.assert_not_awaited()

    async def test_browser_paint_ack_required_and_stale_scene_ack_ignored(self):
        await self.start()
        frame = await self.show()
        speaking = asyncio.create_task(self.runtime.narrate(self.narration(frame)))
        await asyncio.sleep(.05)
        self.narrator.speak.assert_not_awaited()
        self.runtime.acknowledge_paint('not_a_rendered_frame')
        await asyncio.sleep(.01)
        self.narrator.speak.assert_not_awaited()
        self.runtime.acknowledge_paint(self.runtime.output_token)
        await speaking
        self.narrator.speak.assert_awaited_once()
        old = self.runtime.output_token
        await self.runtime.stop()
        self.runtime.acknowledge_paint(old)
        self.assertIsNone(self.runtime.painted)

    async def test_render_timestamp_remains_bound_to_pixels_until_next_render(self):
        await self.start()
        await self.show()
        original = self.runtime.output_metadata['capturedAt']
        self.runtime.source_frame = dict(self.runtime.source_frame, capturedAt=original + 1)
        self.assertEqual(self.runtime.output_metadata['capturedAt'], original)

    async def test_renderer_cadence_accounts_for_work_and_drops_overrun_debt(self):
        tick = [0.0]
        starts, sleeps = [], []
        work = iter((.020, .120, .020))
        self.runtime.clock = lambda: tick[0]
        def render():
            starts.append(tick[0])
            tick[0] += next(work)
            if len(starts) == 3:
                self.runtime.stopping = True
        async def sleep(delay):
            sleeps.append(delay)
            tick[0] += delay
        self.runtime.render = render
        with patch('task_presentation.asyncio.sleep', side_effect=sleep):
            await self.runtime.render_loop()
        self.assertAlmostEqual(starts[1], 1 / 15)
        self.assertAlmostEqual(sleeps[0], 1 / 15 - .020)
        self.assertEqual(sleeps[1], 0)
        self.assertAlmostEqual(sleeps[2], 1 / 15 - .020)

    async def test_journal_rejects_symlink_lock_without_modifying_target(self):
        path = Path(self.temp.name) / 'other.sqlite'
        external = Path(self.temp.name) / 'unrelated'
        external.write_text('unchanged')
        Path(str(path) + '.lock').symlink_to(external)
        with self.assertRaises(OSError):
            PresentationJournal(path)
        self.assertEqual(external.read_text(), 'unchanged')

    async def test_stop_during_capture_blanks_and_late_frame_cannot_restore(self):
        await self.start()
        self.source.capture_gate = asyncio.Event()
        showing = asyncio.create_task(self.show())
        await asyncio.sleep(.05)
        result = await self.runtime.stop()
        self.source.capture_gate.set()
        with self.assertRaises(VoiceError):
            await showing
        self.assertTrue(all(result.values()))
        self.assertIsNone(self.runtime.output)
        self.assertIsNone(self.runtime.source_frame)
        self.assertTrue(self.source.closed)
        self.assertFalse(self.runtime.armed)

    async def test_geometry_change_stops_without_substituting_window(self):
        await self.start()
        await self.show()
        self.source.geometry = 'other_geometry'
        await asyncio.sleep(.3)
        await self.runtime.stop()
        self.assertIsNone(self.runtime.output)
        self.assertTrue(self.source.closed)

    async def test_expiry_and_authority_loss_clear_current_pixels(self):
        await self.start()
        await self.show()
        self.authority.check.side_effect = VoiceError('revoked')
        await asyncio.sleep(.3)
        await self.runtime.stop()
        self.assertIsNone(self.runtime.output)
        self.narrator.close.assert_awaited_once()

    async def test_changed_manifest_control_and_display_target_rejected(self):
        for modify in (lambda v: v['grant'].update(control=True),
                       lambda v: v['manifest']['scenes'][0]['target'].update(kind='display'),
                       lambda v: v['manifest']['scenes'][0].update(transitionMs=100),
                       lambda v: v['manifest']['scenes'][0]['focus'].update(width=float('nan'))):
            changed = copy.deepcopy(self.binding); modify(changed)
            with self.assertRaises(VoiceError):
                validate_prepare(changed)
        changed = copy.deepcopy(self.binding)
        changed['manifest']['opening'] = 'Substituted text'
        with self.assertRaises(VoiceError):
            await self.runtime.prepare(changed)

    async def test_journal_restart_never_replays_prior_capture(self):
        await self.runtime.prepare(self.binding)
        self.journal.close()
        self.journal = PresentationJournal(Path(self.temp.name) / 'receipts.sqlite')
        self.runtime.journal = self.journal
        with self.assertRaisesRegex(VoiceError, 'restart'):
            self.journal.prepare(self.binding)
        self.assertFalse(self.source.started)

    async def test_browser_operator_credentials_separate_and_no_startup_effect(self):
        sink = AttachedSink()
        port = 3398
        app = control_app(self.runtime, 'o' * 40, 'b' * 40, port, sink)
        server = TestServer(app, port=port)
        client = TestClient(server)
        await client.start_server()
        try:
            response = await client.post('/prepare', json=self.binding)
            self.assertEqual(response.status, 401)
            response = await client.post('/prepare', json=self.binding, headers={'Authorization': 'Bearer ' + 'o' * 40, 'Origin': f'http://127.0.0.1:{port}'})
            self.assertEqual(response.status, 401)
            response = await client.post('/prepare', json=self.binding, headers={'Authorization': 'Bearer ' + 'o' * 40})
            self.assertEqual(response.status, 200)
            response = await client.get('/frame', headers={'Authorization': 'Bearer ' + 'o' * 40})
            self.assertEqual(response.status, 401)
            self.assertFalse(self.source.started)
        finally:
            await client.close()


class Socket:
    def __init__(self):
        self.events = asyncio.Queue()
        self.closed = False
        self.sent = []
        self.reply = 'Prepared sentence.'
    def event(self, value):
        self.events.put_nowait(SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps(value)))
    async def send_json(self, value):
        self.sent.append(value)
        if value['type'] == 'Settings':
            self.event({'type': 'SettingsApplied'})
        if value['type'] == 'InjectAgentMessage':
            self.event({'type': 'ConversationText', 'role': 'assistant', 'content': self.reply})
            self.events.put_nowait(SimpleNamespace(type=WSMsgType.BINARY, data=b'\x01\x00' * 160))
            self.event({'type': 'AgentAudioDone'})
    def __aiter__(self):
        return self
    async def __anext__(self):
        return await self.events.get()
    async def close(self):
        self.closed = True


class NarrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ws = Socket()
        self.ws.event({'type': 'Welcome', 'request_id': 'fixture'})
        self.provider = SimpleNamespace(readiness=AsyncMock(), open=AsyncMock(return_value=self.ws), close=AsyncMock())
        self.sink = SimpleNamespace(play=AsyncMock(), clear=AsyncMock())
        self.narrator = PresentationNarrator(self.provider, self.sink)
        self.authorize = AsyncMock()
    async def asyncTearDown(self):
        try:
            await self.narrator.close()
        except VoiceError:
            pass
    async def test_exact_injection_and_actual_sink_completion_required(self):
        gate = asyncio.Event()
        self.sink.play.side_effect = lambda *args: gate.wait()
        async def playing(*args):
            await gate.wait()
        self.sink.play.side_effect = playing
        speaking = asyncio.create_task(self.narrator.speak('Prepared sentence.', self.authorize))
        await asyncio.sleep(.05)
        self.assertFalse(speaking.done())
        gate.set()
        result = await speaking
        self.assertEqual(result, {'completed': True, 'evidence': 'playback_completed_not_audibility'})
        self.assertEqual(self.ws.sent[-1], {'type': 'InjectAgentMessage', 'message': 'Prepared sentence.', 'behavior': 'default'})
        self.assertEqual(self.ws.sent[0]['agent']['think']['functions'], [])
        self.assertNotIn('greeting', self.ws.sent[0]['agent'])
    async def test_wrong_narration_never_reaches_sink(self):
        self.ws.reply = 'Different invented sentence.'
        with self.assertRaises(VoiceError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.play.assert_not_awaited()
        self.assertTrue(self.ws.closed)
    async def test_clear_failure_still_closes_provider_and_reader(self):
        await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.clear.side_effect = RuntimeError('synthetic')
        with self.assertRaises(VoiceError):
            await self.narrator.close()
        self.provider.close.assert_awaited_once()
        self.assertTrue(self.ws.closed)
        self.assertTrue(self.narrator.reader.done())
    async def test_stop_during_late_open_closes_returned_socket(self):
        entered, gate = asyncio.Event(), asyncio.Event()
        async def opening():
            entered.set()
            try:
                await gate.wait()
            except asyncio.CancelledError:
                await gate.wait()
            return self.ws
        self.provider.open.side_effect = opening
        speaking = asyncio.create_task(self.narrator.speak('Prepared sentence.', self.authorize))
        await entered.wait()
        closing = asyncio.create_task(self.narrator.close())
        await asyncio.sleep(.01)
        self.assertFalse(closing.done())
        gate.set()
        await closing
        with self.assertRaises((VoiceError, asyncio.CancelledError)):
            await speaking
        self.assertTrue(self.ws.closed)
        self.assertEqual(self.ws.sent, [])


if __name__ == '__main__':
    unittest.main()
