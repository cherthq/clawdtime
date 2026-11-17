import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from preview_stream import NativeDisplaySource, MAX_LINE, failure_reason, failure_diagnostic

SURFACE = {'kind': 'display', 'id': '1', 'displayId': 1}


class NativeDisplayTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = None

    async def asyncTearDown(self):
        if self.source: await self.source.stop()
        self.tmp.cleanup()

    def source_with(self, body):
        path = Path(self.tmp.name) / 'fixture'
        path.write_text('#!' + sys.executable + '\nimport sys,json,time\n' + body)
        path.chmod(0o700)
        self.source = NativeDisplaySource(str(path), SURFACE)
        return self.source

    async def test_one_process_original_timestamp_and_bounded_distinct_metrics(self):
        value = {'frameId': 'fixed', 'capturedAt': '2026-01-01T00:00:00Z', 'camera': {'surface': SURFACE}, 'jpegBase64': ''}
        source = self.source_with('for line in sys.stdin:\n if line.strip()=="stop": break\n print(' + repr(json.dumps(value)) + ',flush=True)\n')
        first = await source.frame(); pid = source.process.pid
        second = await source.frame()
        self.assertEqual(first, second)
        self.assertEqual(second['capturedAt'], value['capturedAt'])
        self.assertEqual(source.process.pid, pid)
        self.assertEqual(source.metrics()['distinctFrames'], 1)
        self.assertEqual(source.metrics()['requests'], 2)
        await source.stop()
        self.assertIsNotNone(source.process.returncode)
        with self.assertRaises(ValueError): await source.frame()

    async def test_stop_preempts_read_and_late_output_cannot_revive(self):
        source = self.source_with('sys.stdin.readline()\ntime.sleep(5)\nprint("{}",flush=True)\n')
        pending = asyncio.create_task(source.frame())
        while source.process is None: await asyncio.sleep(.001)
        began = time.monotonic(); await source.stop()
        self.assertLess(time.monotonic() - began, 1)
        with self.assertRaises((ValueError, BrokenPipeError, ConnectionResetError)): await pending
        self.assertTrue(source.closed)
        self.assertEqual(source.metrics()['requests'], 0)
        self.assertIsNone(source.metrics()['failureReason'])

    async def test_wrong_surface_retires_without_relaunch(self):
        source = self.source_with('sys.stdin.readline()\nprint(\'{"camera":{"surface":{"kind":"display","id":"2","displayId":2}}}\',flush=True)\n')
        with self.assertRaises(ValueError): await source.frame()
        pid = source.process.pid
        with self.assertRaises(ValueError): await source.frame()
        self.assertEqual(pid, source.process.pid)
        self.assertTrue(source.closed)

    async def test_oversized_frame_retires_process(self):
        source = self.source_with('sys.stdin.readline()\nsys.stdout.write("x"*' + str(MAX_LINE + 2) + '+"\\n");sys.stdout.flush()\n')
        with self.assertRaises(ValueError): await source.frame()
        self.assertTrue(source.closed)
        self.assertEqual(source.requests, 0)

    def test_window_cannot_enter_display_transport(self):
        with self.assertRaises(ValueError): NativeDisplaySource('unused', {'kind': 'window'})

    async def test_native_failure_surfaces_only_allowlisted_reason(self):
        source=self.source_with('sys.stdin.readline()\nsys.stderr.write("Camera stream unavailable: display_changed\\n")\n')
        with self.assertRaisesRegex(ValueError,'display_changed'):await source.frame()
        self.assertEqual(source.metrics()['failureReason'],'display_changed')

    def test_arbitrary_or_oversized_native_stderr_is_not_forwarded(self):
        for raw in [b'private window title',b'Camera stream unavailable: private_text\n',
                    b'Camera stream unavailable: stream_interrupted\xc3\xa9\n',
                    b'Camera stream unavailable: display_changed '+b'x'*256]:
            self.assertEqual(failure_reason(raw),'stream_unavailable')

    def test_native_code_domain_and_snapshot_context_are_bounded_metadata(self):
        raw=b'Camera stream unavailable: stream_interrupted native_domain=screen_capture_kit native_code=-3821 snapshot_active=1 snapshot_count=12\n'
        self.assertEqual(failure_diagnostic(raw),{'reason':'stream_interrupted','nativeDomain':'screen_capture_kit',
            'nativeCode':-3821,'snapshotActive':True,'snapshotCount':12})
        for raw in [raw.replace(b'screen_capture_kit',b'private.domain'),raw.replace(b'-3821',b'-100000'),
                    raw.replace(b'snapshot_count=12',b'snapshot_count=100000'),raw+b'private'*100]:
            self.assertEqual(failure_diagnostic(raw),{'reason':'stream_unavailable'})

    def test_authority_stage_is_fixed_allowlisted_metadata_only(self):
        from preview_stream import AUTHORITY_STAGES
        for stage in AUTHORITY_STAGES:
            raw=('Camera stream unavailable: authority_changed authority_stage='+stage+' snapshot_active=0 snapshot_count=1\n').encode()
            self.assertEqual(failure_diagnostic(raw),{'reason':'authority_changed','authorityStage':stage,'snapshotActive':False,'snapshotCount':1})
        for raw in [b'Camera stream unavailable: authority_changed authority_stage=private_name\n',
                    b'Camera stream unavailable: display_changed authority_stage=session_locked\n',
                    b'Camera stream unavailable: authority_changed authority_stage=session_locked private text\n']:
            self.assertEqual(failure_diagnostic(raw),{'reason':'stream_unavailable'})
