import asyncio
import copy
import hashlib
import json
import math
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image, ImageDraw
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from task_voice import VoiceError
from task_presentation import TaskPresentationRuntime, PresentationJournal, validate_prepare
from task_presentation_local import AttachedSink, PresentationBrowserSink, control_app
from task_presentation_narrator import PresentationNarrator
from task_presentation_diagnostics import PresentationDiagnostics


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
        self.assertEqual(self.runtime.status()['diagnostics']['runtime']['failure']['phase'], 'narrate_frame')
        self.assertEqual(self.runtime.status()['diagnostics']['runtime']['failure']['reason'], 'presentation_refused')

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

    async def test_every_transition_crop_stays_inside_prepared_overview(self):
        scene = self.binding['manifest']['scenes'][0]
        scene['overview'] = {'x': .101, 'y': .151, 'width': .798, 'height': .748}
        validate_prepare(self.binding)
        image = Image.new('RGB', (800, 600), '#568cab')
        tick = [0.0]
        self.runtime.clock = lambda: tick[0]
        self.runtime.scene = scene
        self.runtime.source_frame = {'image': image, 'capturedAt': time.time() * 1000,
            'sourceFrameId': 'synthetic', 'geometryGeneration': 'geometry', 'contentRevision': 'a' * 64}
        self.runtime.authority_at = self.runtime.transition_at = 0
        self.runtime.authority_generation = self.runtime.generation
        bounds = (math.ceil(.101 * 800), math.ceil(.151 * 600), math.floor(.899 * 800), math.floor(.899 * 600))
        with patch.object(image, 'crop', wraps=image.crop) as crop:
            for frame_index in range(16):
                tick[0] = frame_index / 15 * .450
                self.runtime.render()
                left, top, right, bottom = crop.call_args.args[0]
                self.assertGreaterEqual(left, bounds[0])
                self.assertGreaterEqual(top, bounds[1])
                self.assertLessEqual(right, bounds[2])
                self.assertLessEqual(bottom, bounds[3])
                self.assertIsNotNone(self.runtime.output)
            self.assertEqual(crop.call_args_list[0].args[0], bounds)
            self.assertNotEqual(crop.call_args_list[-1].args[0], bounds)

    async def test_overview_rejects_invalid_rect_and_focus_outside_it(self):
        for overview in ({'x': 0, 'y': 0, 'width': float('nan'), 'height': 1},
                         {'x': 0, 'y': 0, 'width': .5, 'height': 1},
                         {'x': .3, 'y': .2, 'width': .6, 'height': .6},
                         {'x': 0, 'y': .4, 'width': 1, 'height': .8}):
            binding = copy.deepcopy(self.binding)
            binding['manifest']['scenes'][0]['overview'] = overview
            with self.assertRaises(VoiceError):
                validate_prepare(binding)

    async def test_annotation_tracks_integer_crop_and_letterboxed_tile_at_twenty_positions(self):
        scene = self.binding['manifest']['scenes'][0]
        scene['overview'] = {'x': .101, 'y': .151, 'width': .798, 'height': .748}
        scene['annotation'] = {'rect': {'x': .251, 'y': .301, 'width': .399, 'height': .349}, 'label': 'Verified empty state'}
        validate_prepare(self.binding)
        image = Image.new('RGB', (801, 603), '#568cab')
        tick = [0.0]
        self.runtime.clock = lambda: tick[0]
        self.runtime.scene = scene
        self.runtime.source_frame = {'image': image, 'capturedAt': time.time() * 1000,
            'sourceFrameId': 'synthetic', 'geometryGeneration': 'geometry', 'contentRevision': 'a' * 64}
        self.runtime.authority_at = self.runtime.transition_at = 0
        self.runtime.authority_generation = self.runtime.generation
        boxes = []
        rectangle = ImageDraw.ImageDraw.rectangle
        def record(draw, box, *args, **kwargs):
            boxes.append((draw._image.size, box, kwargs))
            return rectangle(draw, box, *args, **kwargs)
        with patch.object(image, 'crop', wraps=image.crop) as crops, patch.object(ImageDraw.ImageDraw, 'rectangle', new=record):
            for index in range(20):
                tick[0] = index / 19 * .450
                self.runtime.render()
                (tw, th), box, style = boxes[-1]
                x, y, right, bottom = crops.call_args.args[0]
                expected = (round((.251 * 801 - x) * tw / (right - x)),
                    round((.301 * 603 - y) * th / (bottom - y)),
                    round((.650 * 801 - x) * tw / (right - x)),
                    round((.650 * 603 - y) * th / (bottom - y)))
                self.assertEqual(box, expected)
                self.assertGreaterEqual(min(box), 0)
                self.assertLess(box[2], tw)
                self.assertLess(box[3], th)
                self.assertEqual(style, {'outline': '#ffd166', 'width': 3})
        # Omitting annotation restores the previous renderer bytes exactly.
        scene.pop('annotation')
        self.runtime.render(); unchanged = self.runtime.output
        self.runtime.render(); self.assertEqual(self.runtime.output, unchanged)

    async def test_annotation_rejects_outside_focus_and_arbitrary_style(self):
        for annotation in ({'rect': {'x': 0, 'y': 0, 'width': 1, 'height': 1}, 'label': 'Outside'},
                           {'rect': {'x': .3, 'y': .3, 'width': .1, 'height': .1}, 'label': 'x' * 101},
                           {'rect': {'x': .3, 'y': .3, 'width': .1, 'height': .1}, 'label': 'Bounded', 'style': 'html'}):
            binding = copy.deepcopy(self.binding)
            binding['manifest']['scenes'][0]['annotation'] = annotation
            with self.assertRaises(VoiceError):
                validate_prepare(binding)

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
        self.audio_first = self.omit_text = self.omit_done = False
        self.pcm = b'\x01\x00' * 160
    def event(self, value):
        self.events.put_nowait(SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps(value)))
    async def send_json(self, value):
        self.sent.append(value)
        if value['type'] == 'Settings':
            self.event({'type': 'SettingsApplied'})
        if value['type'] == 'InjectAgentMessage':
            if self.audio_first:
                self.events.put_nowait(SimpleNamespace(type=WSMsgType.BINARY, data=self.pcm))
            if not self.omit_text:
                self.event({'type': 'ConversationText', 'role': 'assistant', 'content': self.reply})
            if not self.audio_first:
                self.events.put_nowait(SimpleNamespace(type=WSMsgType.BINARY, data=self.pcm))
            if not self.omit_done:
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

    async def test_lookahead_is_bounded_and_eof_waits_every_actual_receipt(self):
        self.ws.pcm = b'\x01\x00' * 480 * 12
        receipts, chunks = [], []
        async def enqueue(pcm, epoch):
            chunks.append(pcm)
            future = asyncio.get_running_loop().create_future()
            receipts.append(future)
            return future
        self.sink.enqueue = AsyncMock(side_effect=enqueue)
        speaking = asyncio.create_task(self.narrator.speak('Prepared sentence.', self.authorize))
        while len(receipts) < 4:
            await asyncio.sleep(0)
        await asyncio.sleep(.01)
        self.assertEqual(len(receipts), 4)
        self.assertFalse(speaking.done())
        for index in range(12):
            while len(receipts) <= index:
                await asyncio.sleep(0)
            self.assertFalse(speaking.done())
            receipts[index].set_result(None)
        self.assertTrue((await speaking)['completed'])
        self.assertEqual(b''.join(chunks), self.ws.pcm)
        self.assertTrue(all(len(chunk) <= 960 for chunk in chunks))
        self.assertGreaterEqual(self.authorize.await_count, 12)

    async def test_presentation_sink_bounds_and_clear_cancel_receipts_ignore_late_acks(self):
        socket = SimpleNamespace(closed=False, send_json=AsyncMock())
        sink = PresentationBrowserSink(socket)
        receipts = [await sink.enqueue(b'\x01\x00' * 480, 0) for _ in range(4)]
        with self.assertRaises(VoiceError):
            await sink.enqueue(b'\x01\x00' * 480, 0)
        sink.acknowledge(1, 1)
        self.assertFalse(receipts[0].done())
        sink.acknowledge(1, 0)
        self.assertIsNone(await receipts[0])
        await sink.clear(1)
        self.assertTrue(all(receipt.cancelled() for receipt in receipts[1:]))
        sink.acknowledge(2, 0)
        self.assertEqual(sink.pending_bytes, 0)
    async def test_wrong_narration_never_reaches_sink(self):
        self.ws.reply = 'Different invented sentence.'
        with self.assertRaises(VoiceError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.play.assert_not_awaited()
        self.assertTrue(self.ws.closed)
        self.assertEqual(self.narrator.diagnostics.snapshot()['failure']['reason'], 'narration_prefix_mismatch')
        self.assertEqual(self.narrator.diagnostics.snapshot()['counts']['assistantText'], 1)

    async def test_audio_before_exact_text_quarantined_then_played_for_two_cues(self):
        self.ws.audio_first = True
        for _ in range(2):
            result = await self.narrator.speak('Prepared sentence.', self.authorize)
            self.assertTrue(result['completed'])
        self.assertEqual(self.sink.play.await_count, 2)
        counts = self.narrator.diagnostics.snapshot()['counts']
        self.assertEqual(counts['quarantinedChunks'], 2)
        self.assertEqual(counts['quarantineReleasedChunks'], 2)
        self.assertEqual(self.narrator.quarantined_bytes, 0)

    async def test_audio_before_diverging_text_never_reaches_sink(self):
        self.ws.audio_first = True
        self.ws.reply = 'Unapproved substituted sentence.'
        with self.assertRaises(VoiceError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.play.assert_not_awaited()
        self.assertEqual(self.narrator.quarantined, [])
        self.assertEqual(self.narrator.diagnostics.snapshot()['failure']['reason'], 'narration_prefix_mismatch')

    async def test_partial_matching_text_does_not_release_until_complete_cue(self):
        self.ws.audio_first = self.ws.omit_done = True
        self.ws.reply = 'Prepared'
        speaking = asyncio.create_task(self.narrator.speak('Prepared sentence.', self.authorize))
        while not self.narrator.transcript:
            await asyncio.sleep(0)
        self.sink.play.assert_not_awaited()
        self.ws.event({'type': 'ConversationText', 'role': 'assistant', 'content': 'sentence.'})
        self.ws.event({'type': 'AgentAudioDone'})
        self.assertTrue((await speaking)['completed'])
        self.sink.play.assert_awaited_once()

    async def test_missing_text_times_out_without_playback(self):
        self.ws.audio_first = self.ws.omit_text = self.ws.omit_done = True
        with patch('task_presentation_narrator.QUARANTINE_SECONDS', .02):
            with self.assertRaises(VoiceError):
                await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.play.assert_not_awaited()
        self.assertEqual(self.narrator.diagnostics.snapshot()['failure']['reason'], 'narration_text_quarantine_timeout')
        self.assertEqual(self.narrator.quarantined_bytes, 0)

    async def test_pretext_capacity_refused_without_playback(self):
        self.ws.audio_first = True
        self.ws.pcm = b'\x01\x00' * 32001
        with self.assertRaises(VoiceError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        self.sink.play.assert_not_awaited()
        self.assertEqual(self.narrator.diagnostics.snapshot()['failure']['reason'], 'narration_text_quarantine_capacity')

    async def test_stop_drops_quarantine_and_late_text_cannot_restore_audio(self):
        self.ws.audio_first = self.ws.omit_text = self.ws.omit_done = True
        speaking = asyncio.create_task(self.narrator.speak('Prepared sentence.', self.authorize))
        while not self.narrator.quarantined:
            await asyncio.sleep(0)
        await self.narrator.close()
        self.ws.event({'type': 'ConversationText', 'role': 'assistant', 'content': 'Prepared sentence.'})
        with self.assertRaises(VoiceError):
            await speaking
        self.sink.play.assert_not_awaited()
        self.assertEqual(self.narrator.quarantined_bytes, 0)
        self.assertTrue(self.narrator.quarantine_task.done())
    async def test_readiness_failure_has_fixed_phase_and_no_raw_error(self):
        self.provider.readiness.side_effect = RuntimeError('secret-key raw-provider-body private-cue')
        with self.assertRaises(RuntimeError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        result = self.narrator.diagnostics.snapshot()
        self.assertEqual(result['failure']['phase'], 'provider_readiness')
        self.assertEqual(result['failure']['reason'], 'operation_failed')
        self.assertNotIn('secret-key', json.dumps(result))
        self.assertNotIn('private-cue', json.dumps(result))
        self.provider.open.assert_not_awaited()

    async def test_sink_error_diagnostic_preserves_first_failure_after_cleanup(self):
        self.sink.play.side_effect = RuntimeError('private audio or provider body')
        with self.assertRaises(VoiceError):
            await self.narrator.speak('Prepared sentence.', self.authorize)
        snapshot = self.narrator.diagnostics.snapshot()
        self.assertEqual(snapshot['failure']['reason'], 'operation_failed')
        self.assertEqual(snapshot['counts']['sinkChunks'], 1)
        self.assertNotIn('private audio', json.dumps(snapshot))
        self.assertEqual(snapshot['phase'], 'closed')

    async def test_diagnostics_counters_saturate_and_unknown_names_refused(self):
        diagnostic = PresentationDiagnostics()
        diagnostic.increment('audioBytes', 2000000)
        self.assertEqual(diagnostic.snapshot()['counts']['audioBytes'], 1000000)
        with self.assertRaises(ValueError):
            diagnostic.increment('private-cue')
        with self.assertRaises(ValueError):
            diagnostic.phase('https://secret.invalid')
        diagnostic.fail(VoiceError('private-cue'))
        diagnostic.fail(VoiceError('narration_prefix_mismatch'))
        self.assertEqual(diagnostic.snapshot()['failure']['reason'], 'operation_failed')
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
