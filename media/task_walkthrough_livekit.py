"""Explicit independent-task handset export; the audio-only admission stays separate.

No provider, native capture, room or call starts by importing/constructing objects.
Only the exact prepared renderer may publish video into the one bound room.
"""
import asyncio
import copy
import io
import json
import re
import time

from PIL import Image
from task_voice import VoiceError, TaskVoiceAPI
from task_voice_livekit import LiveKitAudioPort, TaskVoiceLiveKit, fingerprint

IDENTITY = re.compile(r'[A-Za-z0-9_-]{1,120}')
DIGEST = re.compile(r'[a-f0-9]{64}')
PRESENTATION_FIELDS = {'presentationId', 'manifestFingerprint', 'presentationGrantId', 'verificationId', 'hostId', 'captureDeviceId'}
FIELDS = {'mediaSessionId', 'taskId', 'voiceSessionId', 'callAttemptId', 'roomName', 'workerIdentity', 'agentIdentity',
    'mode', 'dispatchExpiresAt', 'expiresAt', 'exportGrantId', 'presentationBinding', 'planFingerprint',
    'audio', 'video', 'screen', 'presentation', 'instructions', 'control', 'nativeActivation'}


def validate_walkthrough_binding(value, now):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise VoiceError('walkthrough_binding_invalid')
    presentation = value['presentationBinding']
    if not isinstance(presentation, dict) or set(presentation) != PRESENTATION_FIELDS:
        raise VoiceError('walkthrough_binding_invalid')
    identities = [value[k] for k in ('mediaSessionId', 'taskId', 'voiceSessionId', 'callAttemptId', 'workerIdentity', 'agentIdentity', 'exportGrantId')]
    identities += [presentation[k] for k in PRESENTATION_FIELDS - {'manifestFingerprint'}]
    if (any(not isinstance(item, str) or not IDENTITY.fullmatch(item) for item in identities)
            or any(not isinstance(item, str) or not DIGEST.fullmatch(item) for item in (value['planFingerprint'], presentation['manifestFingerprint']))
            or value['mode'] != 'handset_walkthrough' or value['roomName'] != 'clawdtime-task-' + value['mediaSessionId']
            or value['workerIdentity'] == value['agentIdentity']
            or type(value['dispatchExpiresAt']) is not int or type(value['expiresAt']) is not int
            or not now * 1000 < value['dispatchExpiresAt'] <= min(value['expiresAt'], (now + 300) * 1000)
            or value['expiresAt'] > (now + 1800) * 1000
            or any(value[k] is not True for k in ('audio', 'video', 'screen', 'presentation', 'instructions'))
            or any(value[k] is not False for k in ('control', 'nativeActivation'))):
        raise VoiceError('walkthrough_binding_invalid')
    return copy.deepcopy(value)


class WalkthroughTaskAPI:
    """Voice capability validates independent export identity on every context read."""
    def __init__(self, delegate, binding):
        self.delegate, self.binding = delegate, binding
        self.task_id, self.voice_id = delegate.task_id, delegate.voice_id
        self.stopping = lambda: False

    def validate_context(self, value):
        b, p = self.binding, self.binding['presentationBinding']
        expected = {'mode': 'handset_walkthrough', 'taskId': b['taskId'], 'voiceSessionId': b['voiceSessionId'],
            'callAttemptId': b['callAttemptId'], 'exportGrantId': b['exportGrantId'], 'planFingerprint': b['planFingerprint'],
            'presentationId': p['presentationId'], 'manifestFingerprint': p['manifestFingerprint'], 'active': True}
        if (not isinstance(value, dict) or any(type(value.get(k)) is not type(v) or value[k] != v for k, v in expected.items())
                or type(value.get('sharingActive')) is not bool or type(value.get('exportActive')) is not bool
                or not isinstance(value.get('permissions'), dict)
                or any(value['permissions'].get(k) is not True for k in ('screen', 'presentation', 'instructions'))
                or value['permissions'].get('control') is not False
                or any(type(value.get(k)) is not int or not 0 <= value[k] <= 9007199254740991 for k in ('revision', 'sequence'))
                or not isinstance(value.get('runId'), str) or not 0 < len(value['runId']) <= 200
                or not isinstance(value.get('opening'), str) or not 0 < len(value['opening']) <= 2000
                or not isinstance(value.get('goal'), str) or not 0 < len(value['goal']) <= 8000
                or not isinstance(value.get('state'), str) or len(value['state']) > 100):
            raise VoiceError('walkthrough_context_refused')
        if len(json.dumps(value)) > 32000:
            raise VoiceError('walkthrough_context_refused')
        return value

    async def context(self):
        if self.stopping():
            raise VoiceError('walkthrough_stopped')
        value = self.validate_context(await self.delegate.request('/context'))
        if self.stopping():
            raise VoiceError('walkthrough_stopped')
        return value

    async def request(self, suffix, body=None):
        if suffix not in ('/bind', '/utterances', '/instructions', '/accept', '/end',
                          '/presentation/opening', '/presentation/show', '/presentation/stop', '/presentation/retire'):
            raise VoiceError('walkthrough_route_refused')
        if suffix != '/end' and self.stopping():
            raise VoiceError('walkthrough_stopped')
        if suffix.startswith('/presentation/') and isinstance(self.delegate, TaskVoiceAPI):
            return await self.delegate.request(suffix, body, timeout_seconds=8)
        return await self.delegate.request(suffix, body)


class LiveKitWalkthroughPort(LiveKitAudioPort):
    """One audio/video participant. Remote participants still publish only mic."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.video_source = self.video_publication = None
        self.video_stopped = False
        self.video_frames = 0
        self.video_evidence = None
        self.video_lock = asyncio.Lock()
        self.video_publish_task = None
        self.video_close_task = None
        self.blank_task = None

    def _token_sources(self, identity):
        return ['microphone', 'screen_share'] if identity == self.binding['agentIdentity'] else ['microphone']

    def _token_lifetime(self):
        return 1800

    async def prepare(self, binding, on_audio, on_failure):
        from livekit import rtc
        if binding.get('mode') != 'handset_walkthrough':
            raise VoiceError('walkthrough_binding_invalid')
        credentials = await super().prepare(binding, on_audio, on_failure)
        if self.closing or self.video_stopped:
            raise VoiceError('walkthrough_stopped')
        self.video_source = rtc.VideoSource(1280, 720, is_screencast=True)
        track = rtc.LocalVideoTrack.create_video_track('clawdtime-prepared-task-screen', self.video_source)
        self.video_publish_task = asyncio.create_task(self.room.local_participant.publish_track(track,
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_SCREENSHARE, simulcast=False,
                video_encoding=rtc.VideoEncoding(max_bitrate=2000000, max_framerate=15))))
        self.video_publication = await asyncio.shield(self.video_publish_task)
        if self.closing or self.video_stopped:
            raise VoiceError('walkthrough_stopped')
        return credentials

    async def publish_video(self, jpeg, frame):
        from livekit import rtc
        async with self.video_lock:
            if self.closing or self.video_stopped or not self.video_source or not self.video_publication:
                raise VoiceError('walkthrough_video_unavailable')
            expected = self.binding['presentationBinding']
            now = time.time() * 1000
            if (frame.get('presentationId') != expected['presentationId'] or frame.get('manifestFingerprint') != expected['manifestFingerprint']
                    or not 0 <= now - frame['capturedAt'] < 1000 or not frame['capturedAt'] <= frame['renderedAt'] <= now):
                raise VoiceError('walkthrough_frame_stale')
            with Image.open(io.BytesIO(jpeg)) as image:
                if image.format != 'JPEG' or image.size != (1280, 720):
                    raise VoiceError('walkthrough_frame_invalid')
                raw = image.convert('RGBA').tobytes()
            self.video_source.capture_frame(rtc.VideoFrame(1280, 720, rtc.VideoBufferType.RGBA, raw))
            accepted = time.time() * 1000
            if self.video_stopped or self.closing or accepted - frame['capturedAt'] >= 1000:
                raise VoiceError('walkthrough_frame_stale')
            self.video_frames = min(1000000, self.video_frames + 1)
            self.video_evidence = {key: frame[key] for key in ('presentationId', 'manifestFingerprint', 'sceneId', 'generation',
                'sourceFrameId', 'geometryGeneration', 'capturedAt', 'renderedAt')}
            self.video_evidence.update(acceptedAt=accepted, evidence='sdk_frame_accepted_not_remote_seen')
            return copy.deepcopy(self.video_evidence)

    async def stop_video(self):
        self.video_stopped = True
        if self.video_close_task is None:
            self.video_close_task = asyncio.create_task(self._stop_video())
        return await asyncio.shield(self.video_close_task)

    async def _blank(self):
        from livekit import rtc
        frame = rtc.VideoFrame(1280, 720, rtc.VideoBufferType.RGBA, b'\x00\x00\x00\xff' * (1280 * 720))
        self.video_source.capture_frame(frame)

    async def _blank_loop(self):
        try:
            while not self.closing:
                await asyncio.sleep(1 / 15)
                async with self.video_lock:
                    if self.video_source and self.video_publication:
                        await self._blank()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.on_failure('video_blank_failed')

    async def _stop_video(self):
        async with self.video_lock:
            if self.video_publish_task:
                try:
                    self.video_publication = await asyncio.wait_for(asyncio.shield(self.video_publish_task), 3)
                except BaseException:
                    return False
            if self.video_source and self.video_publication:
                try:
                    await self._blank()
                    if not self.closing:
                        self.blank_task = asyncio.create_task(self._blank_loop())
                except Exception:
                    return False
            self.video_evidence = None
            return True

    async def close(self):
        video_ok = await self.stop_video()
        if self.blank_task:
            self.blank_task.cancel()
            await asyncio.gather(self.blank_task, return_exceptions=True)
        async with self.video_lock:
            if self.video_publication and self.room:
                try:
                    await asyncio.wait_for(self.room.local_participant.unpublish_track(self.video_publication.sid), 3)
                except Exception:
                    video_ok = False
            if self.video_source:
                try:
                    await asyncio.wait_for(self.video_source.aclose(), 3)
                except Exception:
                    video_ok = False
            self.video_source = self.video_publication = None
        return await super().close() and video_ok


class ExportAuthority:
    """A local capture grant cannot by itself authorize any room export."""
    def __init__(self, local, owner):
        self.local, self.owner = local, owner

    async def check(self, generation=None):
        result = await self.local.check(generation)
        await self.owner.authorize_export()
        return result


class TaskWalkthroughLiveKit(TaskVoiceLiveKit):
    def __init__(self, task_api, provider, port, journal, configured_binding, presentation, *,
                 clock=time.time, runtime_factory=None, **kwargs):
        self.configured = validate_walkthrough_binding(configured_binding, clock())
        self.presentation = presentation
        self.sharing_stopped = False
        self.sharing_close_task = None
        self.video_task = None
        self.video_watchdog_task = None
        self.last_export_capture = None
        self.video_changed = asyncio.Event()
        self.accepted_frame = self.accepted_video = None
        self.retirement_submitted = False
        self.retirement_task = None
        self.retirement_unknown = False
        if runtime_factory is None:
            from task_walkthrough_voice import DeepgramWalkthroughRuntime
            runtime_factory = lambda api, provider, sink: DeepgramWalkthroughRuntime(api, provider, sink, presentation=self)
        super().__init__(task_api, provider, port, journal, clock=clock, runtime_factory=runtime_factory,
                         activation_timeout=8, prepare_timeout=15, **kwargs)
        if task_api.task_id != self.configured['taskId'] or task_api.voice_id != self.configured['voiceSessionId']:
            raise VoiceError('walkthrough_voice_binding_refused')
        self.api = WalkthroughTaskAPI(task_api, self.configured)
        self.api.stopping = lambda: self.stopping
        binding, prepared = self.configured['presentationBinding'], presentation.binding
        if (prepared['presentationId'] != binding['presentationId'] or prepared['fingerprint'] != binding['manifestFingerprint']
                or prepared['grant']['id'] != binding['presentationGrantId'] or prepared['grant']['hostId'] != binding['hostId']
                or prepared['manifest']['verificationId'] != binding['verificationId']
                or prepared['manifest']['taskId'] != self.configured['taskId'] or presentation.narrator is not None):
            raise VoiceError('walkthrough_presentation_binding_refused')
        self.presentation.authority = ExportAuthority(presentation.authority, self)

    def _check(self):
        if self.stopping or self.clock() * 1000 >= self.configured['expiresAt']:
            raise VoiceError('walkthrough_stopped')

    def _dispatch_check(self):
        self._check()
        if self.clock() * 1000 >= self.configured['dispatchExpiresAt']:
            raise VoiceError('walkthrough_dispatch_expired')

    async def authorize_export(self):
        self._check()
        if self.sharing_stopped:
            raise VoiceError('walkthrough_sharing_stopped')
        value = await self.api.context()
        manifest = self.presentation.binding['manifest']
        if (not value['exportActive'] or value['runId'] != manifest['runId'] or value['revision'] != manifest['taskRevision']):
            raise VoiceError('walkthrough_export_stale')
        self._check()
        return value

    async def presentation_prepare(self, value):
        if not isinstance(value, dict) or value.get('callAttemptId') != self.configured['callAttemptId']:
            raise VoiceError('walkthrough_attempt_refused')
        return await self.presentation.prepare({k: v for k, v in value.items() if k != 'callAttemptId'})

    async def prepare(self, binding):
        value = validate_walkthrough_binding(binding, self.clock())
        if value != self.configured:
            raise VoiceError('walkthrough_binding_refused')
        self._dispatch_check()
        digest = fingerprint(value)
        if self.binding is not None:
            if digest != self.digest or self.stopping:
                raise VoiceError('walkthrough_prepare_replay_refused')
            return copy.deepcopy(await asyncio.shield(self.prepare_task))
        self.binding, self.digest = value, digest
        self.journal.reserve(value, digest)
        self.reserved = True
        self.state = 'preparing'
        self.prepare_task = asyncio.create_task(self._prepare())
        return copy.deepcopy(await asyncio.shield(self.prepare_task))

    async def _prepare(self):
        try:
            context = await self.authorize_export()
            if context['opening'] != self.presentation.binding['manifest']['opening']:
                raise VoiceError('walkthrough_opening_refused')
            await asyncio.wait_for(self.provider.readiness(), 10)
            self._dispatch_check()
            await self.presentation.prepare(self.presentation.binding)
            await self.presentation.local_start()  # Exact metadata inspection before room creation.
            self._dispatch_check()
            self.prepare_effect_inflight = True
            self.credentials = await asyncio.wait_for(self.port.prepare(self.binding, self.audio_ready.set, self._fail), self.prepare_timeout)
            self.prepare_effect_inflight = False
            self._dispatch_check()
            self.video_task = asyncio.create_task(self.export_video())
            self.video_watchdog_task = asyncio.create_task(self.video_watchdog())
            # Root reserves first scene/generation durably and calls our show route.
            result = await self.api.request('/presentation/opening', {'eventId': 'opening_' + self.binding['callAttemptId']})
            if result.get('sceneId') != self.presentation.binding['manifest']['scenes'][0]['id']:
                raise VoiceError('walkthrough_opening_scene_refused')
            _, evidence = await self.fresh_video()
            self._dispatch_check()
            self.state = 'prepared'
            self.journal.record(self.binding, self.digest, 'prepared')
            self.watch_tasks.add(asyncio.create_task(self._watch_expiry()))
            return {**self.status(), 'silentPublisherReady': True, 'videoPublisherReady': True,
                    'videoEvidence': evidence, 'credentials': self.credentials}
        except BaseException:
            if self.prepare_effect_inflight:
                self.prepare_uncertain = True
            self._fail('prepare_failed')
            raise

    async def export_video(self):
        last_token = None
        deadline = asyncio.get_running_loop().time()
        try:
            while not self.stopping and not self.sharing_stopped:
                if self.presentation.stopping:
                    raise VoiceError('walkthrough_source_stopped')
                await self.authorize_export()
                source = self.presentation.output_metadata
                token = self.presentation.output_token
                if source and self.presentation.output and token != last_token:
                    frame = {**copy.deepcopy(source), 'presentationId': self.presentation.binding['presentationId'],
                        'manifestFingerprint': self.presentation.binding['fingerprint']}
                    full = copy.deepcopy(self.presentation.frame)
                    jpeg = self.presentation.output
                    evidence = await self.port.publish_video(jpeg, frame)
                    self.last_export_capture = frame['capturedAt']
                    last_token = token
                    if (full and full['sourceFrameId'] == frame['sourceFrameId'] and full['renderedAt'] == frame['renderedAt']
                            and full['generation'] == frame['generation']):
                        self.accepted_frame, self.accepted_video = full, evidence
                        self.video_changed.set()
                deadline = max(deadline + 1 / 15, asyncio.get_running_loop().time())
                await asyncio.sleep(max(0, deadline - asyncio.get_running_loop().time()))
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.stopping:
                if not self.retirement_submitted:
                    self.retirement_submitted = True
                    self.retirement_task = asyncio.create_task(self._retire_sharing())

    async def video_watchdog(self):
        while not self.stopping and not self.sharing_stopped:
            await asyncio.sleep(.05)
            if self.last_export_capture is not None and self.clock() * 1000 - self.last_export_capture >= 1000:
                if not self.retirement_submitted:
                    self.retirement_submitted = True
                    self.retirement_task = asyncio.create_task(self._retire_sharing())
                return

    async def _retire_sharing(self):
        # This is separate from the export loop so Stop can join that loop
        # without cancelling an already submitted durable retirement request.
        await self.stop_sharing()
        try:
            await self.api.request('/presentation/retire',
                {'eventId': 'retire_' + self.configured['callAttemptId'], 'reason': 'export_unavailable'})
        except Exception:
            self.retirement_unknown = True
            self._fail('sharing_retirement_unknown')

    async def fresh_video(self, scene_id=None, generation=None):
        async with asyncio.timeout(2):
            while True:
                await self.authorize_export()
                frame, evidence = self.accepted_frame, self.accepted_video
                if (frame and evidence and self.presentation.scene
                        and frame['sceneId'] == self.presentation.scene['id'] and frame['generation'] == self.presentation.generation
                        and (scene_id is None or frame['sceneId'] == scene_id)
                        and (generation is None or frame['generation'] == generation)
                        and 0 <= self.clock() * 1000 - frame['capturedAt'] < 1000):
                    return copy.deepcopy(frame), copy.deepcopy(evidence)
                self.video_changed.clear()
                await self.video_changed.wait()

    async def show_scene(self, value):
        if not isinstance(value, dict) or value.get('callAttemptId') != self.configured['callAttemptId']:
            raise VoiceError('walkthrough_attempt_refused')
        await self.authorize_export()
        if self.state not in ('preparing', 'prepared', 'activating', 'active') or self.port.video_source is None:
            raise VoiceError('walkthrough_video_unavailable')
        if self.runtime:
            await self.runtime.suppress_scene_speech()
        command = {k: v for k, v in value.items() if k != 'callAttemptId'}
        await self.presentation.show(command)
        frame, evidence = await self.fresh_video(command['sceneId'], command['generation'])
        return {'frame': frame, 'videoEvidence': evidence}

    async def observe_scene(self, call_attempt_id, presentation_id):
        if call_attempt_id != self.configured['callAttemptId'] or presentation_id != self.presentation.binding['presentationId']:
            raise VoiceError('walkthrough_attempt_refused')
        frame, evidence = await self.fresh_video()
        return {'frame': frame, 'videoEvidence': evidence}

    async def _activate(self):
        try:
            async with asyncio.timeout(8):
                self._dispatch_check()
                await asyncio.wait_for(self.audio_ready.wait(), self.worker_timeout)
                await self.fresh_video()
                self._dispatch_check()
                await self.port.activate_output()
                self.runtime = self.runtime_factory(self.api, self.provider, self.port)
                await self.runtime.start()
                self._check()
                await self.port.start_input(self.runtime.input_audio)
                await self.runtime.playback.first_output.wait()
                await self.fresh_video()
                self.state = 'active'
                self.journal.record(self.binding, self.digest, 'active')
                self.watch_tasks.add(asyncio.create_task(self._watch_runtime()))
        except BaseException:
            self._fail('activation_failed')
            raise

    async def stop_sharing(self):
        self.sharing_stopped = True
        self.video_changed.set()
        if self.sharing_close_task is None:
            self.sharing_close_task = asyncio.create_task(self._stop_sharing())
        return await asyncio.shield(self.sharing_close_task)

    async def _stop_sharing(self):
        pending = [task for task in (self.video_task, self.video_watchdog_task)
                   if task and task is not asyncio.current_task()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        # Clearing scene speech must not delay immediate blank-only video/source
        # shutdown if the audio sink is slow or reports a cleanup failure.
        effects = [self.presentation.stop(), self.port.stop_video()]
        if self.runtime and not self.runtime.closed:
            effects.append(self.runtime.suppress_scene_speech())
        results = await asyncio.gather(*effects, return_exceptions=True)
        self.accepted_frame = self.accepted_video = None
        if any(isinstance(value, BaseException) for value in results) or results[1] is not True:
            self._fail('sharing_cleanup_unknown')
            raise VoiceError('walkthrough_sharing_cleanup_unknown')
        return results[0]

    def status(self):
        result = super().status()
        result.update(mode='handset_walkthrough', video=True, screen=True, presentation=True, instructions=True,
            nativeActivation=False, planFingerprint=self.configured['planFingerprint'], exportGrantId=self.configured['exportGrantId'],
            presentationBinding=copy.deepcopy(self.configured['presentationBinding']),
            sharingActive=not self.sharing_stopped and self.presentation.armed)
        if self.accepted_video:
            result['videoEvidence'] = copy.deepcopy(self.accepted_video)
        return result

    async def _close(self):
        # Revoke pixels immediately; provider/end receipts may take seconds.
        sharing_ok = True
        try:
            await self.stop_sharing()
        except Exception:
            sharing_ok = False
        await super()._close()
        ok = self.state == 'closed' and sharing_ok
        self.state = 'closing'
        if self.retirement_task and self.retirement_task is not asyncio.current_task():
            try:
                await asyncio.wait_for(asyncio.shield(self.retirement_task), 9)
            except BaseException:
                ok = False
        ok = ok and not self.retirement_unknown
        self.state = 'closed' if ok else 'unknown'
        if self.reserved:
            self.journal.record(self.binding, self.digest, self.state)
