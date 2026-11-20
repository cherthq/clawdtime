"""Probe setup/cleanup regressions; no native processes or pixels are used."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from qualify_task_capture import main, failure_reason


class Process:
    def __init__(self, result=None, timeout=False):
        self.returncode = None
        self.result, self.timeout = result, timeout
        self.terminated = self.joined = False

    async def communicate(self):
        if self.timeout:
            raise TimeoutError()
        self.returncode = 2 if self.result.get('ok') is False else 0
        return json.dumps(self.result).encode(), None

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    async def wait(self):
        self.joined = True
        return self.returncode


class QualificationSetupTests(unittest.IsolatedAsyncioTestCase):
    def test_failure_report_does_not_serialize_arbitrary_exceptions(self):
        self.assertEqual(failure_reason(RuntimeError('synthetic private text')),
                         'capture_qualification_failed')
        self.assertEqual(failure_reason(RuntimeError('local_frame_stale')), 'local_frame_stale')

    async def run_probe(self, resolvers):
        fixture = Process()
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / 'fixture'
            binary.write_bytes(b'synthetic-not-executed')
            with patch('qualify_task_capture.asyncio.create_subprocess_exec',
                       AsyncMock(side_effect=[fixture, *resolvers])), \
                    patch('qualify_task_capture.asyncio.sleep', AsyncMock()), \
                    patch('qualify_task_capture.TaskPresentationRuntime') as runtime, \
                    contextlib.redirect_stdout(output):
                code = await main('/synthetic/helper', str(binary), 1, resolve_only=True)
                runtime.assert_not_called()
        return code, json.loads(output.getvalue().splitlines()[-1]), fixture

    async def test_resolution_failure_joins_fixture_without_starting_capture(self):
        resolver = Process({'ok': False, 'reason': 'window_outside_single_display'})
        code, result, fixture = await self.run_probe([resolver])
        self.assertEqual(code, 1)
        self.assertFalse(result['captureStarted'])
        self.assertTrue(result['cleanupConfirmed'])
        self.assertTrue(result['fixtureCleanupConfirmed'])
        self.assertTrue(fixture.terminated and fixture.joined and resolver.joined)

    async def test_stalled_resolver_is_joined_without_capture(self):
        resolver = Process(timeout=True)
        code, result, fixture = await self.run_probe([resolver])
        self.assertEqual(code, 1)
        self.assertFalse(result['captureStarted'])
        self.assertTrue(result['helperJoined'])
        self.assertTrue(fixture.joined and resolver.terminated and resolver.joined)

    async def test_metadata_only_success_never_constructs_capture_runtime(self):
        resolvers = [Process({'appId': 'com.example.fixture', 'windowId': str(index + 1),
            'ownerPid': 1, 'displayId': 1, 'processIdentity': 'a' * 64, 'titleHash': 'b' * 64})
            for index in range(2)]
        code, result, fixture = await self.run_probe(resolvers)
        self.assertEqual(code, 0)
        self.assertEqual(result['exactTargetsResolved'], 2)
        self.assertFalse(result['captureStarted'])
        self.assertTrue(fixture.joined and all(item.joined for item in resolvers))
