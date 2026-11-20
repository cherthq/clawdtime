"""Local-only disposable capture qualification; never exports pixels or starts a call.

Requires an idle executor, explicit local test authorization, the built capture
helper and the compiled mac/scripts/task-capture-fixture.swift executable. This creates
only temporary synthetic fixture apps; it never enumerates unrelated windows.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import plistlib
import shutil
import tempfile
import time
import uuid

from task_presentation import NativeWindowSource, PresentationJournal, TaskPresentationRuntime, target as validate_target


class QualificationSource(NativeWindowSource):
    # Only fixed native timing metadata is retained, never stderr text.
    phases = frozenset(('input_received', 'before_guard', 'before_shareable', 'before_validate',
        'capture_image', 'after_guard', 'after_shareable', 'after_validate', 'jpeg_encode',
        'response_write', 'idle', 'refused_availability', 'refused_grant', 'refused_display',
        'refused_owner_missing', 'refused_owner_hidden', 'refused_owner_bundle', 'refused_lifetime',
        'refused_enumeration', 'refused_window_match', 'refused_on_screen', 'refused_layer',
        'refused_window_pid', 'refused_window_bundle', 'refused_title', 'refused_geometry',
        'refused_display_overlap', 'refused_capture_geometry', 'refused_image_dimensions',
        'refused_capture_age', 'refused_capture_image', 'refused_encoding', 'stream_start',
        'stream_wait', 'stream_stop', 'refused_stream_stop', 'refused_stream_frame'))

    def __init__(self, binary, config, stream=False):
        super().__init__(binary, config)
        self.stream = stream
        self.profile_task = None
        self.last_phase = self.first_refusal = None

    async def start(self):
        if self.process or self.closed:
            raise RuntimeError('qualification_source_closed')
        flags = ['--profile-timing'] + (['--capture-stream'] if self.stream else [])
        self.spawn_task = asyncio.create_task(asyncio.create_subprocess_exec(self.binary,
            '--config', self.config_path, *flags, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, limit=16384))
        self.process = await asyncio.shield(self.spawn_task)
        self.profile_task = asyncio.create_task(self.profile())
        if self.closed:
            await self.close()
            raise RuntimeError('qualification_source_closed')

    async def profile(self):
        async for raw in self.process.stderr:
            try:
                value = json.loads(raw)
                if (len(raw) > 128 or set(value) != {'phase', 'elapsedMs', 'sequence'}
                        or value['phase'] not in self.phases
                        or type(value['elapsedMs']) is not int or not 0 <= value['elapsedMs'] <= 1800000
                        or type(value['sequence']) is not int or not 0 <= value['sequence'] <= 1000000):
                    continue
                self.last_phase = value
                if value['phase'].startswith('refused_') and self.first_refusal is None:
                    self.first_refusal = value
            except (ValueError, TypeError, KeyError):
                continue

    async def close(self):
        result = await super().close()
        if self.profile_task:
            await self.profile_task
        return result


async def main(helper, fixture_binary, seconds, stream=False, resolve_only=False):
    os.umask(0o077)
    identity = 'qualify_' + uuid.uuid4().hex
    processes = []
    runtime = journal = watcher = None
    watchdog_failure = None
    result = {'passed': False, 'durationSeconds': seconds, 'localOnly': True,
              'pixelsPersisted': False, 'callStarted': False, 'captureStarted': False,
              'captureMode': 'stream' if stream else 'screenshot'}
    with tempfile.TemporaryDirectory(prefix='clawdtime-capture-qualification-') as temporary:
        root = Path(temporary)
        try:
            targets = []
            bundle_id = 'com.clawdtime.capture-fixture'
            app = root / 'CaptureFixture.app' / 'Contents'
            binary = app / 'MacOS' / 'Fixture'
            binary.parent.mkdir(parents=True)
            shutil.copy2(fixture_binary, binary)
            (app / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': bundle_id, 'CFBundleName': 'Capture Fixture',
                'CFBundleExecutable': 'Fixture', 'CFBundlePackageType': 'APPL'}))
            process = await asyncio.create_subprocess_exec(str(binary),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            processes.append(process)
            await asyncio.sleep(2)
            for name in ('Alpha', 'Beta'):
                query = root / (name + '-query.json')
                query.write_text(json.dumps({'appId': bundle_id, 'title': 'ClawdTime Capture Fixture ' + name}))
                resolver = await asyncio.create_subprocess_exec(helper, '--resolve-target', str(query),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                processes.append(resolver)
                raw, _ = await asyncio.wait_for(resolver.communicate(), 10)
                if resolver.returncode:
                    value = json.loads(raw)
                    detail = value.get('reason', 'resolution_unavailable')
                    geometry = value.get('geometry', {})
                    print(json.dumps({'fixtureResolution': {key: geometry.get(key) for key in ('sameAppCount', 'exactTitleCount', 'exactAppTitleCount', 'exactOnScreenCount', 'exactLayerZeroCount', 'windowBounds', 'containingDisplayCount', 'activeDisplays')}}), flush=True)
                    raise RuntimeError('fixture_target_' + detail)
                targets.append(validate_target(json.loads(raw)))
            if resolve_only:
                result.update(passed=True, exactTargetsResolved=len(targets))
            else:
                now = time.time() * 1000
                capture_grant = root / 'capture-grant.json'
                capture_grant.write_text(json.dumps({'presentationId': identity,
                    'expiresAt': now + (seconds + 30) * 1000, 'targets': targets}))
                generation = 0
                evidence_current = True
                class Authority:
                    async def check(self, expected=None):
                        if expected is not None and expected != generation:
                            raise RuntimeError('qualification_generation_changed')
                        return {'generation': generation, 'sceneEvidenceCurrent': evidence_current}
                scenes = [{'id': 'scene_' + str(i), 'kind': 'preview', 'title': 'Synthetic fixture',
                    'narration': 'Local synthetic capture qualification.', 'expectedOutcome': 'Fresh synthetic pixels.',
                    'target': target, 'focus': {'x': 0, 'y': 0, 'width': 1, 'height': 1},
                    'transitionMs': 450} for i, target in enumerate(targets)]
                manifest = {'version': 1, 'id': identity, 'sessionId': identity, 'taskId': identity,
                    'runId': identity, 'taskRevision': 0, 'verificationId': identity, 'kind': 'review',
                    'opening': scenes[0]['narration'], 'fps': 15, 'scenes': scenes}
                grant = {'version': 1, 'id': identity, 'manifestFingerprint': 'a' * 64,
                    'sessionId': identity, 'taskId': identity, 'runId': identity, 'taskRevision': 0,
                    'hostId': identity, 'authorizedAt': now, 'expiresAt': now + (seconds + 30) * 1000,
                    'localOnly': True, 'capture': True, 'presentation': True, 'control': False,
                    'nativeActivation': False, 'calls': False, 'continuity': 'call'}
                prepared = {'presentationId': identity, 'manifest': manifest, 'grant': grant, 'fingerprint': 'a' * 64}
                journal = PresentationJournal(root / 'journal.sqlite')
                source = QualificationSource(helper, capture_grant, stream)
                runtime = TaskPresentationRuntime(prepared, Authority(), source, journal)
                await runtime.prepare(prepared)
                await runtime.local_start()
                async def show(index):
                    nonlocal generation
                    generation += 1
                    await runtime.show({'presentationId': identity, 'manifestFingerprint': 'a' * 64,
                        'operationId': 'show_' + str(generation), 'sceneId': scenes[index]['id'], 'generation': generation})
                result['captureStarted'] = True
                await show(0)
                started = time.monotonic()
                next_switch = started + 20
                switches = 0
                max_age = 0
                content_changes = 0
                async def watchdog():
                    nonlocal max_age, watchdog_failure, content_changes
                    last_content = None
                    last_source_at = runtime.output_metadata['capturedAt']
                    while not runtime.stopping:
                        if runtime.source_frame and runtime.source_frame['contentRevision'] != last_content:
                            last_content = runtime.source_frame['contentRevision']
                            content_changes += 1
                        if runtime.output_metadata:
                            last_source_at = runtime.output_metadata['capturedAt']
                        age = time.time() * 1000 - last_source_at
                        max_age = max(max_age, age)
                        if not 0 <= age < 1000:
                            watchdog_failure = 'local_frame_stale'
                            await runtime.stop()
                            return
                        await asyncio.sleep(.05)
                watcher = asyncio.create_task(watchdog())
                while time.monotonic() - started < seconds:
                    if runtime.stopping or not runtime.output_metadata:
                        raise RuntimeError('local_output_unavailable')
                    age = time.time() * 1000 - runtime.output_metadata['capturedAt']
                    max_age = max(max_age, age)
                    if not 0 <= age < 1000:
                        raise RuntimeError('local_frame_stale')
                    if time.monotonic() >= next_switch:
                        if switches == 1:
                            evidence_current = False
                            runtime.set_scene_evidence(False)
                        switches += 1
                        await show(switches % 2)
                        next_switch += 20
                        print(json.dumps({'phase': 'capture', 'elapsedSeconds': round(time.monotonic() - started),
                            'switches': switches, 'sourceFrames': runtime.counts['sourceFrames']}), flush=True)
                    await asyncio.sleep(1 / 15)
                if runtime.stopping or watchdog_failure:
                    raise RuntimeError(watchdog_failure or 'local_output_unavailable')
                if content_changes < seconds:
                    raise RuntimeError('synthetic_frame_ticks_not_observed')
                result.update(passed=True, switches=switches, maxSourceAgeMs=round(max_age),
                              contentChanges=content_changes, **runtime.counts)
        except Exception as error:
            result['reason'] = watchdog_failure or (str(error) if type(error) is RuntimeError else 'capture_qualification_failed')
            if runtime:
                runtime.diagnostics.fail(error)
                result['firstFailure'] = runtime.diagnostics.snapshot()['failure']
                result.update(runtime.counts)
        finally:
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            if runtime:
                try:
                    cleanup = await runtime.stop()
                    result['cleanupConfirmed'] = all(cleanup.values())
                    result['helperJoined'] = runtime.source.process is None or runtime.source.process.returncode is not None
                    if not result['cleanupConfirmed'] or not result['helperJoined']:
                        result['passed'] = False
                except Exception:
                    result.update(passed=False, cleanupConfirmed=False)
            if runtime:
                result['nativeLastPhase'] = runtime.source.last_phase
                result['nativeFirstRefusal'] = runtime.source.first_refusal
            if journal:
                journal.close()
            result['fixtureCleanupConfirmed'] = True
            if runtime is None:
                result['cleanupConfirmed'] = True
                result['helperJoined'] = True
            for process in processes:
                if process.returncode is None:
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 3)
                except TimeoutError:
                    process.kill()
                    await process.wait()
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', required=True)
    parser.add_argument('--fixture-binary', required=True)
    parser.add_argument('--seconds', type=int, default=240)
    parser.add_argument('--capture-stream', action='store_true')
    parser.add_argument('--resolve-only', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600:
        parser.error('seconds must be between 1 and 600')
    raise SystemExit(asyncio.run(main(str(Path(args.helper).resolve()), str(Path(args.fixture_binary).resolve()), args.seconds, args.capture_stream, args.resolve_only)))
