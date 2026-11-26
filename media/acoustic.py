"""Execution-disabled acoustic qualification. No broker, tool or text dispatch."""
import asyncio
from array import array
import base64
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
import time

from conversational import sdk_readiness
from policy import capture_allowed
from probe_live import verified_tls_context

PROMPT = (
    'This is a supervised acoustic test of ClawdTime. Execution is disabled. '
    'You have no tools, tasks, screen access or ability to act. Never delegate or '
    'claim to perform work. Politely redirect all other requests to the audio test. '
    'The connection greeting has already played; do not greet again. Briefly explain '
    'that this is an audio-only test, ask whether your voice is clear, and discuss '
    'only echo, volume and interruption. Keep each reply short. Stop speaking when '
    'the human interrupts. Do not claim that silence, echo isolation or handset '
    'latency has been verified. The human can hang up or use the local test controller to stop.'
)
QUALIFICATION_NOTICE = 'ClawdTime audio test. Execution is disabled.'


def session_config():
    return {'model': 'gpt-live-1', 'delegation': {'type': 'client'}, 'store': False,
            'audio': {'format': {'type': 'audio/pcm', 'rate': 24000}}, 'instructions': PROMPT}


def readiness(env):
    sdk = sdk_readiness()
    try:
        websocket_ok = version('websockets') == '15.0.1'
    except PackageNotFoundError:
        websocket_ok = False
    return {'version': 1, 'enabled': env.get('MEDIA_AUDIO_QUALIFICATION_ENABLED') == 'true',
            'directKeyConfigured': bool(env.get('OPENAI_API_KEY')),
            'sdk': sdk, 'websocketQualified': websocket_ok}


def requested(policy):
    return 'audioQualification' in policy or policy.get('voiceMode') == 'audio_qualification'


def allowed(policy, env, *, call_id=None, expiry=None, now=None):
    now = now or datetime.now(timezone.utc)
    q = policy.get('audioQualification')
    if (not isinstance(q, dict) or set(q) != {'version', 'executionDisabled', 'expiresAt'}
            or type(q.get('version')) is not int or q['version'] != 1
            or q.get('executionDisabled') is not True
            or env.get('MEDIA_AUDIO_QUALIFICATION_ENABLED') != 'true'
            or not env.get('OPENAI_API_KEY') or policy.get('protocolVersion') != 2
            or policy.get('voiceMode') != 'audio_qualification'
            or policy.get('remoteAudioIsolated') is not False
            or policy.get('captionsEnabled') is not False or policy.get('muted') is True
            or any(key in policy for key in ('screenSelection', 'presentation', 'presentationBinding',
                                             'presentationSequence', 'conversationVersion', 'conversationFrontend', 'documentPreview'))
            or not capture_allowed(policy, now)
            or (call_id is not None and policy.get('callId') != call_id)
            or (expiry is not None and q.get('expiresAt') != expiry)):
        return False
    try:
        deadline = datetime.fromisoformat(q['expiresAt'].replace('Z', '+00:00'))
        return 0 < (deadline - now).total_seconds() <= 300
    except (ValueError, TypeError, AttributeError):
        return False


class AcousticFrontend:
    """Public OpenAI Live SDK plus existing LiveKit RTC audio, no Agent chat history."""
    def __init__(self, parent, policy):
        self.parent = parent
        self.expiry = policy['audioQualification']['expiresAt']
        ttl = (datetime.fromisoformat(self.expiry.replace('Z', '+00:00')) - datetime.now(timezone.utc)).total_seconds()
        self.deadline = time.monotonic() + min(300, max(0, ttl))
        self.ready = asyncio.Event()
        self.finalized = asyncio.Event()
        self.connection = self.client = None
        self.receiver = self.watchdog = None
        self.closed = self.started = False
        self.pending = bytearray()
        self.suppressed = False
        self.quiet_ms = 0.
        self.last_output_at = float('-inf')
        self.last_output_duration = 0.
        self.resampler = None
        self.counts = {key: 0 for key in ('inputFrames', 'outputChunks', 'discardedOutputChunks',
            'discardedDelegations', 'discardedTranscriptEvents', 'cutoffs')}
        self.born = time.monotonic()

    def snapshot(self):
        # Only fixed keys, numbers and booleans enter diagnostics.
        self.parent.lifecycle.data['audioQualification'] = {
            'version': 1, 'executionDisabled': True, 'started': self.started,
            'outputLatched': self.suppressed,
            'finalized': self.finalized.is_set(), 'elapsedMs': min(300000, max(0, int((time.monotonic()-self.born)*1000))),
            **self.counts}
        self.parent.lifecycle.save()

    def count(self, name):
        self.counts[name] = min(999999999, self.counts[name]+1)

    def authorized(self):
        p = self.parent
        return (not self.closed and p.active and p.allowed and not p.closing
                and not p.pause_latched and time.monotonic() < self.deadline
                and time.monotonic() - p.policy_at < 2)

    def policy_allowed(self, policy):
        return allowed(policy, self.parent.owner.env, call_id=self.parent.call_id, expiry=self.expiry)

    async def start(self):
        status = readiness(self.parent.owner.env)
        if not all((status['enabled'], status['directKeyConfigured'], status['sdk']['available'], status['websocketQualified'])):
            raise RuntimeError('Acoustic qualification unavailable')
        from openai import AsyncOpenAI
        from livekit import rtc
        self.resampler = rtc.AudioResampler(24000, 48000, num_channels=1)
        self.client = AsyncOpenAI(api_key=self.parent.owner.env['OPENAI_API_KEY'],
                                  base_url='https://api.openai.com/v1', max_retries=0, timeout=8)
        self.connection = await self.client.live.connect(max_retries=0, websocket_connection_options={
            'ssl': verified_tls_context(), 'open_timeout': 8, 'close_timeout': 1,
            'max_size': 262144, 'max_queue': 4}).enter()
        self.receiver = self.parent.task(self.receive(), 'capture_loop')
        await self.connection.session.start(session=session_config())
        await asyncio.wait_for(self.ready.wait(), 7)
        if not self.started or not self.authorized():
            raise RuntimeError('Acoustic session did not start under current authority')
        if self.watchdog is None:
            self.watchdog = self.parent.task(self.watch(), 'deadline')
        self.snapshot()

    async def watch(self):
        ticks = 0
        while not self.closed:
            if not self.authorized():
                self.parent.allowed = False
                self.parent.owner.cancel_speech(self.parent.id)
                await self.parent.fail('maximum_duration' if time.monotonic() >= self.deadline else 'task_failed', 'deadline')
                return
            if ticks % 10 == 0:
                self.snapshot()
            # Local queue/arrival heuristic for UI and onset only. This is not
            # provider completion, remote queue flush or handset audibility.
            if (self.started and self.parent.audio.empty() and time.monotonic()-self.last_output_at > self.last_output_duration+.3):
                self.parent.speaking = False
            ticks += 1
            await asyncio.sleep(.1)

    async def receive(self):
        try:
            async for event in self.connection:
                kind = event.type
                if kind == 'session.started':
                    self.started = True
                    self.ready.set()
                elif kind == 'session.closed':
                    self.finalized.set()
                    if not self.closed:
                        raise RuntimeError('Acoustic provider ended')
                    return
                elif kind == 'error':
                    raise RuntimeError('Acoustic provider failed')
                elif kind == 'session.output_audio.delta':
                    await self.output(event.delta)
                elif 'delegation' in kind:
                    self.count('discardedDelegations')
                elif 'transcript' in kind:
                    self.count('discardedTranscriptEvents')
                # Never keep transcript/delegation/response contents or forward them.
            if not self.closed:
                raise RuntimeError('Acoustic provider disconnected')
        finally:
            self.ready.set()

    async def output(self, delta):
        self.count('outputChunks')
        if not self.authorized():
            self.count('discardedOutputChunks')
            return
        if not isinstance(delta, str) or len(delta) > 64000:
            raise RuntimeError('Acoustic audio exceeds bounds')
        raw = base64.b64decode(delta, validate=True)
        if not raw or len(raw) % 2:
            raise RuntimeError('Invalid acoustic audio')
        from livekit import rtc
        if self.suppressed:
            # Live has no output-turn completion/flush ACK. Never infer safe
            # recovery from a timer, zero samples or an instruction ACK.
            self.count('discardedOutputChunks')
            return
        p = self.parent
        self.last_output_at = time.monotonic()
        self.last_output_duration = len(raw)/48000
        samples = array('h', raw)
        audible = sum(value*value for value in samples) / len(samples) > (32768*.003)**2
        self.quiet_ms = 0. if audible else self.quiet_ms + len(raw)/48
        if not audible and not p.speaking:
            return
        if self.quiet_ms >= 200:
            p.speaking = False
            self.pending.clear()
            return
        if not p.speaking:
            p.playback_generation += 1
            p.active_reply_id = 'acoustic_output_' + str(p.playback_generation)
            p.first_audio_published = False
            p.speaking = True
            p.speech_cancelled = False
            p.playback_event('playback_started')
        generation = p.playback_generation
        for frame in self.resampler.push(rtc.AudioFrame(raw, 24000, 1, len(raw)//2)):
            self.pending.extend(bytes(frame.data))
        while len(self.pending) >= 1920:
            if not self.authorized() or self.suppressed or generation != p.playback_generation:
                self.pending.clear()
                return
            chunk = bytes(self.pending[:1920]); del self.pending[:1920]
            await asyncio.wait_for(p.audio.put((generation, chunk)), .3)

    def cutoff(self):
        self.count('cutoffs')
        self.suppressed = True
        self.quiet_ms = 0.
        self.pending.clear()
        self.parent.speaking = False
        if self.resampler:
            from livekit import rtc
            self.resampler = rtc.AudioResampler(24000, 48000, num_channels=1)

    async def capture(self, track):
        from livekit import rtc
        await self.ready.wait()
        stream = rtc.AudioStream(track, capacity=5, sample_rate=48000, num_channels=1)
        self.parent.stream = stream
        resampler = rtc.AudioResampler(48000, 24000, num_channels=1)
        try:
            async for event in stream:
                if not self.authorized():
                    break
                raw = bytes(event.frame.data)
                self.count('inputFrames')
                self.parent.speech_diagnostics.audio(len(raw), nonzero=any(raw))
                self.parent.observe_audio_activity(raw)
                for frame in resampler.push(event.frame):
                    await self.send_frame(frame)
        finally:
            await stream.aclose()
            if self.parent.stream is stream:
                self.parent.stream = None

    async def send_frame(self, frame):
        if not self.authorized() or frame.sample_rate != 24000 or frame.num_channels != 1:
            return
        await asyncio.wait_for(self.connection.session.input_audio.append(
            audio=base64.b64encode(bytes(frame.data)).decode('ascii')), .3)
        self.parent.speech_diagnostics.audio(0, sent=True)

    async def close(self):
        if self.closed:
            return
        self.closed = True
        self.pending.clear()
        self.ready.set()
        if self.connection:
            try:
                await asyncio.wait_for(self.connection.session.close(), 1)
                await asyncio.wait_for(self.finalized.wait(), 1.5)
            except (Exception, asyncio.CancelledError):
                pass
            try:
                await asyncio.wait_for(self.connection.close(), 2)
            except (Exception, asyncio.CancelledError):
                pass
        if self.client:
            try:
                await asyncio.wait_for(self.client.close(), 2)
            except (Exception, asyncio.CancelledError):
                pass
        self.snapshot()
