"""Bounded inherited-pipe transport for the opt-in local display preview."""
import asyncio
import json
import re
import time

MAX_LINE = 3 * 1024 * 1024
FAILURE_REASONS = frozenset(('display_changed','authority_changed','frame_stale','capture_dimensions',
    'capture_failed','stream_interrupted','stream_start','deadline'))
AUTHORITY_STAGES = frozenset(('session_forced_unavailable','session_missing','session_off_console',
    'session_login_incomplete','session_locked','permission_missing','stream_stopped','stream_geometry_missing'))


def failure_diagnostic(raw):
    # Native stderr is never returned verbatim, even for a configured dev binary.
    if len(raw)>256:return {'reason':'stream_unavailable'}
    try:text=raw.decode('ascii')
    except UnicodeDecodeError:return {'reason':'stream_unavailable'}
    for line in text.splitlines():
        match=re.fullmatch(r'Camera stream unavailable: ([a-z_]+)(?: native_domain=(screen_capture_kit) native_code=(-?(?:0|[1-9][0-9]{0,4})))?(?: authority_stage=([a-z_]+))?(?: snapshot_active=([01]) snapshot_count=(0|[1-9][0-9]{0,4}))?',line)
        if match and match[1] in FAILURE_REASONS:
            if match[4] is not None and (match[1]!='authority_changed' or match[4] not in AUTHORITY_STAGES):continue
            result={'reason':match[1]}
            if match[2]:result.update(nativeDomain=match[2],nativeCode=int(match[3]))
            if match[4] is not None:result['authorityStage']=match[4]
            if match[5] is not None:result.update(snapshotActive=match[5]=='1',snapshotCount=int(match[6]))
            return result
    return {'reason':'stream_unavailable'}


def failure_reason(raw):return failure_diagnostic(raw)['reason']


class NativeDisplaySource:
    def __init__(self, binary, surface):
        if surface.get('kind') != 'display':
            raise ValueError('Persistent preview requires an explicit display.')
        self.binary, self.surface = binary, dict(surface)
        self.process = None
        self.closed = False
        self.lock = asyncio.Lock()
        self.requests = 0
        self.frames = 0
        self.last_id = None
        self.started = None
        self.read_ms = 0
        self.failure_reason = None
        self.failure_diagnostic = None

    async def frame(self):
        async with self.lock:
            if self.closed:
                raise ValueError('Selected display stream stopped.')
            try:
                if self.process is None:
                    self.process = await asyncio.create_subprocess_exec(
                        self.binary, '--camera-stream', '--surface', json.dumps(self.surface),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE, limit=MAX_LINE + 1)
                    self.started = time.monotonic()
                if self.closed:
                    await self.stop()
                    raise ValueError('Selected display stream stopped.')
                began = time.monotonic()
                self.process.stdin.write(b'frame\n')
                await asyncio.wait_for(self.process.stdin.drain(), .5)
                line = await asyncio.wait_for(self.process.stdout.readline(), 2)
                if self.closed or not line.endswith(b'\n') or len(line) > MAX_LINE:
                    raise ValueError('Selected display stream response unavailable.')
                value = json.loads(line)
                if not isinstance(value, dict) or value.get('camera', {}).get('surface') != self.surface:
                    raise ValueError('Selected display identity changed.')
                self.requests += 1
                self.read_ms += (time.monotonic() - began) * 1000
                if value.get('frameId') != self.last_id:
                    self.frames += 1
                    self.last_id = value.get('frameId')
                return value
            except BaseException as error:
                intentionally_stopped=self.closed
                await self.stop()
                if isinstance(error,asyncio.CancelledError):raise
                if intentionally_stopped:raise ValueError('Selected display stream stopped.') from None
                self.failure_reason='stream_unavailable'
                if self.process and self.process.stderr:
                    try:
                        self.failure_diagnostic=failure_diagnostic(await asyncio.wait_for(self.process.stderr.read(257),.1))
                        self.failure_reason=self.failure_diagnostic['reason']
                    except Exception:pass
                raise ValueError('Native display stream unavailable: '+self.failure_reason) from None

    async def stop(self):
        self.closed = True
        process = self.process
        if process is None or process.returncode is not None:
            return
        try:
            process.stdin.write(b'stop\n')
            await asyncio.wait_for(process.stdin.drain(), .1)
            await asyncio.wait_for(process.wait(), .5)
        except (Exception, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
            await process.wait()

    def metrics(self):
        elapsed = max(.001, time.monotonic() - self.started) if self.started else 0
        return {'transport': 'persistent_display', 'requests': self.requests,
                'distinctFrames': self.frames, 'elapsedMs': round(elapsed * 1000),
                'deliveredFps': round(self.frames / elapsed, 2) if elapsed else 0,
                'meanReadMs': round(self.read_ms / self.requests, 2) if self.requests else 0,
                'closed': self.closed,'failureReason':self.failure_reason,'failureDiagnostic':self.failure_diagnostic}
