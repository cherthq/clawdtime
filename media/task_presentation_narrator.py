"""Exact prepared scene narration over Deepgram; no input stream or tools.

Provider audio-done is only EOF. Completion also requires every browser playback
acknowledgment after onended and current presentation authority. No audio is saved.
"""
import asyncio
import json
import time

from task_voice import VoiceError
from task_voice_deepgram import settings
from task_presentation_diagnostics import PresentationDiagnostics

QUARANTINE_BYTES = 64000
QUARANTINE_SECONDS = 2


class PresentationNarrator:
    def __init__(self, provider, sink):
        self.provider, self.sink = provider, sink
        self.ws = None
        self.reader = self.player = self.keepalive = None
        self.closed = False
        self.close_task = None
        self.ready = asyncio.Event()
        self.queue = asyncio.Queue(maxsize=256)
        self.queued_bytes = 0
        self.epoch = 0
        self.pending = None
        self.expected = None
        self.transcript = []
        self.received_audio = False
        self.authorize = None
        self.provider_done = False
        self.send_lock = asyncio.Lock()
        self.start_task = None
        self.diagnostics = PresentationDiagnostics()
        self.text_verified = False
        self.quarantined = []
        self.quarantined_bytes = 0
        self.quarantine_deadline = None
        self.quarantine_task = None

    async def send(self, value):
        async with self.send_lock:
            if self.closed or not self.ws:
                raise VoiceError('narration_closed')
            await asyncio.wait_for(self.ws.send_json(value), 2)

    async def start(self):
        if self.start_task:
            raise VoiceError('narration_restart_refused')
        self.start_task = asyncio.create_task(self._start())
        try:
            await asyncio.shield(self.start_task)
        except BaseException as error:
            self.diagnostics.fail(error)
            raise

    async def _start(self):
        if self.closed or self.ws:
            raise VoiceError('narration_restart_refused')
        self.diagnostics.phase('provider_readiness')
        await self.provider.readiness()
        await self.authorize()
        self.diagnostics.phase('provider_open')
        self.ws = await self.provider.open()
        if self.closed:
            await self.ws.close()
            await self.provider.close()
            raise VoiceError('narration_stopped')
        await self.authorize()
        self.reader = asyncio.create_task(self.read())
        self.player = asyncio.create_task(self.play())
        for task in (self.reader, self.player):
            task.add_done_callback(self.failed)
        self.diagnostics.phase('await_settings')
        await asyncio.wait_for(self.ready.wait(), 5)
        self.diagnostics.phase('ready')
        self.keepalive = asyncio.create_task(self.ping())
        self.keepalive.add_done_callback(self.failed)

    def failed(self, task):
        if not task.cancelled() and task.exception() and not self.closed:
            self.diagnostics.fail(task.exception())
            if self.pending and not self.pending.done():
                self.pending.set_exception(VoiceError('narration_unconfirmed'))
            asyncio.create_task(self.close())

    async def expire_quarantine(self):
        await asyncio.sleep(max(0, self.quarantine_deadline - time.monotonic()))
        if not self.closed and not self.text_verified and self.quarantined:
            raise VoiceError('narration_text_quarantine_timeout')

    async def release_quarantine(self):
        if self.quarantine_deadline is not None and time.monotonic() >= self.quarantine_deadline:
            raise VoiceError('narration_text_quarantine_timeout')
        self.text_verified = True
        if self.quarantine_task:
            self.quarantine_task.cancel()
            await asyncio.gather(self.quarantine_task, return_exceptions=True)
        if self.closed:
            raise VoiceError('narration_stopped')
        for pcm in self.quarantined:
            self.queued_bytes += len(pcm)
            self.queue.put_nowait((self.epoch, pcm))
            self.diagnostics.increment('quarantineReleasedChunks')
        self.quarantined.clear()
        self.quarantined_bytes = 0
        self.quarantine_deadline = None

    async def read(self):
        from aiohttp import WSMsgType
        welcomed = False
        async for message in self.ws:
            if message.type == WSMsgType.BINARY:
                pcm = message.data
                self.diagnostics.increment('audioChunks')
                self.diagnostics.increment('audioBytes', len(pcm))
                if (not self.pending or self.provider_done
                        or not pcm or len(pcm) % 2 or len(pcm) > 320000
                        or self.queued_bytes + self.quarantined_bytes + len(pcm) > 640000):
                    raise VoiceError('narration_audio_refused')
                self.received_audio = self.received_audio or any(pcm)
                if not self.text_verified:
                    if self.quarantined_bytes + len(pcm) > QUARANTINE_BYTES or len(self.quarantined) >= 256:
                        raise VoiceError('narration_text_quarantine_capacity')
                    self.quarantined.append(pcm)
                    self.quarantined_bytes += len(pcm)
                    self.diagnostics.increment('quarantinedChunks')
                    if self.quarantine_deadline is None:
                        self.quarantine_deadline = time.monotonic() + QUARANTINE_SECONDS
                        self.quarantine_task = asyncio.create_task(self.expire_quarantine())
                        self.quarantine_task.add_done_callback(self.failed)
                    continue
                self.queued_bytes += len(pcm)
                self.queue.put_nowait((self.epoch, pcm))
                continue
            if message.type != WSMsgType.TEXT:
                raise VoiceError('narration_disconnected')
            value = json.loads(message.data)
            kind = value.get('type')
            if kind == 'Welcome':
                self.diagnostics.increment('welcome')
                if welcomed:
                    raise VoiceError('narration_protocol_refused')
                welcomed = True
                config = settings({'opening': ''})
                config['agent'].pop('greeting')
                config['agent']['think']['functions'] = []
                config['agent']['think']['prompt'] = 'Read only explicitly injected prepared narration. No greeting, questions, tools, or spontaneous statements.'
                self.diagnostics.phase('settings_send')
                await self.send(config)
                self.diagnostics.phase('await_settings')
            elif kind == 'SettingsApplied':
                self.diagnostics.increment('settingsApplied')
                if not welcomed or self.ready.is_set():
                    raise VoiceError('narration_protocol_refused')
                self.ready.set()
            elif kind == 'ConversationText':
                self.diagnostics.increment('assistantText')
                if (not self.pending or value.get('role') != 'assistant'
                        or not isinstance(value.get('content'), str)
                        or value.get('conversational_behavior', 'default') != 'default'
                        or sum(map(len, self.transcript)) + len(value['content']) > 2000):
                    raise VoiceError('narration_text_refused')
                self.transcript.append(value['content'])
                prefix = ' '.join(' '.join(self.transcript).split())
                if not ' '.join(self.expected.split()).startswith(prefix):
                    raise VoiceError('narration_prefix_mismatch')
                if prefix == ' '.join(self.expected.split()) and not self.text_verified:
                    await self.release_quarantine()
            elif kind == 'AgentAudioDone':
                self.diagnostics.increment('providerAudioDone')
                if (not self.pending or self.provider_done or not self.received_audio or not self.text_verified
                        or ' '.join(' '.join(self.transcript).split()) != ' '.join(self.expected.split())):
                    raise VoiceError('narration_completion_unconfirmed')
                self.provider_done = True
                self.queue.put_nowait((self.epoch, None))
            elif kind in ('UserStartedSpeaking', 'InjectionRefused', 'Error', 'Warning', 'FunctionCallRequest'):
                raise VoiceError({'UserStartedSpeaking': 'narration_user_started', 'InjectionRefused': 'narration_injection_refused',
                    'Error': 'narration_provider_error', 'Warning': 'narration_provider_warning', 'FunctionCallRequest': 'narration_unexpected_tool'}[kind])
        if not self.closed:
            raise VoiceError('narration_disconnected')

    async def play(self):
        while not self.closed:
            epoch, pcm = await self.queue.get()
            if pcm is not None:
                self.queued_bytes -= len(pcm)
            if epoch != self.epoch:
                continue
            if pcm is None:
                self.diagnostics.phase('cue_drain')
                await self.authorize()
                if self.pending and not self.pending.done() and epoch == self.epoch:
                    self.diagnostics.phase('cue_complete')
                    self.pending.set_result({'completed': True, 'evidence': 'playback_completed_not_audibility'})
                continue
            for offset in range(0, len(pcm), 3200):
                await self.authorize()
                if self.closed or epoch != self.epoch:
                    break
                self.diagnostics.increment('sinkChunks')
                await asyncio.wait_for(self.sink.play(pcm[offset:offset + 3200], epoch), 2)
                self.diagnostics.increment('sinkCompleted')

    async def ping(self):
        while not self.closed:
            await asyncio.sleep(8)
            await self.send({'type': 'KeepAlive'})

    async def speak(self, text, authorize):
        if self.closed or self.pending:
            raise VoiceError('narration_busy_or_closed')
        self.authorize = authorize
        self.diagnostics.phase('cue_authority')
        await authorize()
        if not self.ws:
            await self.start()
        await authorize()
        self.pending = asyncio.get_running_loop().create_future()
        self.expected = text
        self.transcript = []
        self.text_verified = False
        self.quarantine_deadline = None
        self.quarantine_task = None
        self.provider_done = self.received_audio = False
        try:
            self.diagnostics.phase('cue_inject')
            await self.send({'type': 'InjectAgentMessage', 'message': text, 'behavior': 'default'})
            self.diagnostics.increment('injected')
            self.diagnostics.phase('cue_playback')
            return await asyncio.wait_for(asyncio.shield(self.pending), 90)
        except BaseException as error:
            self.diagnostics.fail(error)
            await self.close()
            raise
        finally:
            if self.pending and not self.pending.done():
                self.pending.cancel()
            self.pending = None
            self.expected = None
            self.transcript = []

    async def interrupt(self):
        # No provider cancellation message with a reliable cue ID exists here.
        # A scene cannot advance during narration; Stop closes the provider.
        if self.pending:
            await self.close()
            raise VoiceError('narration_interrupted')

    async def close(self):
        self.closed = True
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close())
        await asyncio.shield(self.close_task)

    async def _close(self):
        self.diagnostics.phase('stop')
        self.epoch += 1
        self.diagnostics.increment('quarantineDiscardedBytes', self.quarantined_bytes)
        self.quarantined.clear()
        self.quarantined_bytes = 0
        failures = []
        try:
            await asyncio.wait_for(self.sink.clear(self.epoch), 1)
        except Exception as error:
            failures.append(error)
        if self.pending and not self.pending.done():
            self.pending.set_exception(VoiceError('narration_stopped'))
        if self.start_task and not self.start_task.done():
            self.start_task.cancel()
            try:
                await asyncio.wait_for(asyncio.gather(self.start_task, return_exceptions=True), 8)
            except Exception as error:
                failures.append(error)
        for task in (self.reader, self.player, self.keepalive, self.quarantine_task):
            if task:
                task.cancel()
        await asyncio.gather(*(task for task in (self.reader, self.player, self.keepalive, self.quarantine_task) if task), return_exceptions=True)
        for operation in ([self.ws.close] if self.ws else []) + [self.provider.close]:
            try:
                await asyncio.wait_for(operation(), 3)
            except Exception as error:
                failures.append(error)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queued_bytes = 0
        if failures:
            self.diagnostics.fail(VoiceError('narration_cleanup_unconfirmed'))
            raise VoiceError('narration_cleanup_unconfirmed')
        self.diagnostics.phase('closed')
