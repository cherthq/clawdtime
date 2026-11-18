"""Offline-prepared c1 audio adapter; importing this module has no network effects.

There is deliberately no public server, dialing client or executable entry point.
The authenticated coordinator supplies a confirmed connection; local cleanup never
claims the native handset call ended. No legacy screen/caption runtime is imported.
"""
import asyncio
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import ssl
import time
from urllib.parse import urlsplit

from task_voice import TaskVoiceRuntime, VoiceError, bounded_context


_FIELDS = {'mediaSessionId', 'taskId', 'voiceSessionId', 'callAttemptId', 'roomName',
           'workerIdentity', 'agentIdentity', 'expiresAt', 'audio', 'video', 'screen', 'presentation', 'control'}


def validate_binding(value, now):
    if not isinstance(value, dict) or set(value) != _FIELDS:
        raise VoiceError('handset_binding_invalid')
    for name in ('mediaSessionId', 'taskId', 'voiceSessionId', 'callAttemptId', 'workerIdentity', 'agentIdentity'):
        if not isinstance(value[name], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', value[name]):
            raise VoiceError('handset_binding_invalid')
    if (value['roomName'] != 'clawdtime-task-' + value['mediaSessionId']
            or value['workerIdentity'] == value['agentIdentity']
            or type(value['expiresAt']) is not int or not now * 1000 < value['expiresAt'] <= (now + 1200) * 1000
            or value['audio'] is not True
            or any(value[name] is not False for name in ('video', 'screen', 'presentation', 'control'))):
        raise VoiceError('handset_binding_invalid')
    return copy.deepcopy(value)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class TaskAudioJournal:
    """Private durable tombstones; never contains tokens, transcripts or PCM."""
    def __init__(self, path):
        path = Path(path)
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
            raise VoiceError('handset_journal_private_directory_required')
        self.lock = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            lock_info = os.fstat(self.lock)
            if lock_info.st_uid != os.getuid() or lock_info.st_mode & 0o077 or not stat.S_ISREG(lock_info.st_mode):
                raise VoiceError('handset_journal_private_file_required')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if path.exists() or path.is_symlink():
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise VoiceError('handset_journal_private_file_required')
            self.db = sqlite3.connect(path)
            os.chmod(path, 0o600)
            self.db.execute('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, room TEXT UNIQUE NOT NULL, state TEXT NOT NULL)')
            self.db.execute("UPDATE attempts SET state='interrupted' WHERE state!='closed'")
            self.db.commit()
        except BaseException:
            os.close(self.lock)
            raise

    def reserve(self, binding, digest):
        with self.db:
            if self.db.execute('SELECT 1 FROM attempts WHERE id=? OR room=? OR state!=?',
                               (binding['mediaSessionId'], binding['roomName'], 'closed')).fetchone():
                raise VoiceError('handset_attempt_requires_reconciliation')
            self.db.execute('INSERT INTO attempts VALUES(?,?,?,?)',
                            (binding['mediaSessionId'], digest, binding['roomName'], 'preparing'))

    def owns(self, binding, digest):
        return self.db.execute('SELECT 1 FROM attempts WHERE id=? AND fingerprint=? AND room=?',
            (binding['mediaSessionId'], digest, binding['roomName'])).fetchone() is not None

    def record(self, binding, digest, state):
        if state not in ('prepared', 'activating', 'active', 'closing', 'closed', 'unknown') or not self.owns(binding, digest):
            raise VoiceError('handset_journal_binding_refused')
        with self.db:
            self.db.execute('UPDATE attempts SET state=? WHERE id=?', (state, binding['mediaSessionId']))

    def close(self):
        self.db.close()
        os.close(self.lock)


class StatusOnlyTaskAPI:
    def __init__(self, delegate):
        self.delegate = delegate
        self.task_id, self.voice_id = delegate.task_id, delegate.voice_id
        self.call_attempt_id = None
        self.stopping = lambda: False

    async def context(self):
        if self.stopping():
            raise VoiceError('handset_session_unavailable')
        value = bounded_context(await self.delegate.context(), self.task_id, self.voice_id)
        if (self.stopping() or value['permissions'].get('instructions') is not False
                or value.get('mode') != 'handset_audio_smoke'
                or self.call_attempt_id is None or value.get('callAttemptId') != self.call_attempt_id):
            raise VoiceError('handset_status_only_required')
        return value

    async def request(self, suffix, body=None):
        if suffix not in ('/bind', '/utterances', '/end') or (suffix != '/end' and self.stopping()):
            raise VoiceError('handset_instruction_refused')
        return await self.delegate.request(suffix, body)


class GuardedProvider:
    """A late open completion after Stop cannot enter the runtime or speak."""
    def __init__(self, delegate, stopping):
        self.delegate, self.stopping = delegate, stopping

    async def readiness(self):
        if self.stopping():
            raise VoiceError('handset_session_unavailable')
        result = await self.delegate.readiness()
        if self.stopping():
            raise VoiceError('handset_session_unavailable')
        return result

    async def open(self):
        if self.stopping():
            raise VoiceError('handset_session_unavailable')
        socket = await self.delegate.open()
        if self.stopping():
            await socket.close()
            await self.delegate.close()
            raise VoiceError('handset_session_unavailable')
        return socket

    async def close(self):
        await self.delegate.close()


class FixedLiveKitHTTP:
    """Only the two scoped room RPCs, one POST each, without redirect following."""
    def __init__(self, session, origin):
        self.session, self.origin = session, origin.rstrip('/')

    @property
    def timeout(self):
        return self.session.timeout

    def post(self, url, **kwargs):
        allowed = {self.origin + '/twirp/livekit.RoomService/' + name
                   for name in ('CreateRoom', 'DeleteRoom')}
        if url not in allowed:
            raise VoiceError('handset_livekit_destination_refused')
        return self.session.post(url, **{**kwargs, 'allow_redirects': False})


class LiveKitAudioPort:
    """One scoped SDK room/track; no room is opened until prepare is called."""
    def __init__(self, url, key, secret, *, allowed_hosts):
        parsed = urlsplit(url)
        if (parsed.scheme != 'wss' or parsed.hostname not in allowed_hosts
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or parsed.port not in (None, 443)
                or not isinstance(key, str) or not key or not isinstance(secret, str) or not secret):
            raise VoiceError('handset_livekit_configuration_invalid')
        self.url, self.key, self.secret = url.rstrip('/'), key, secret
        self.room = self.client = self.source = self.stream = self.track = None
        self.sdk_http = None
        self.silence_task = self.input_task = None
        self.track_sid = None
        self.publication_sid = None
        self.binding = None
        self.closing = False
        self.create_attempted = False
        self.epoch = 0
        self.output_lock = asyncio.Lock()
        self.resampler = None
        self.output_counts = {'preparedSilentFrames': 0, 'speechFrames': 0}

    def _count_output(self, kind):
        self.output_counts[kind] = min(1000000, self.output_counts[kind] + 1)

    async def prepare(self, binding, on_audio, on_failure):
        from datetime import timedelta
        from livekit import api, rtc
        self.binding = binding
        from aiohttp import ClientSession, ClientTimeout, TCPConnector
        import certifi
        tls = ssl.create_default_context(cafile=certifi.where())
        self.sdk_http = ClientSession(timeout=ClientTimeout(total=4), connector=TCPConnector(ssl=tls))
        fixed_http = FixedLiveKitHTTP(self.sdk_http, 'https://' + urlsplit(self.url).netloc)
        # The pinned SDK otherwise enables regional mutation retries by default.
        self.client = api.LiveKitAPI(self.url, self.key, self.secret, session=fixed_http, failover=False)
        self.room = rtc.Room()
        self.on_failure = on_failure
        expected = binding['workerIdentity']

        def published(publication, participant):
            if self.closing:
                return
            if participant.identity != expected:
                on_failure('foreign_participant')
                return
            if publication.kind != rtc.TrackKind.KIND_AUDIO:
                publication.set_subscribed(False)
                return  # No video subscription or stream is ever created.
            if self.publication_sid not in (None, publication.sid):
                on_failure('conflicting_audio')
                return
            self.publication_sid = publication.sid
            publication.set_subscribed(True)

        @self.room.on('track_published')
        def publication_added(publication, participant):
            try:
                published(publication, participant)
            except Exception:
                on_failure('track_subscription_failed')

        @self.room.on('participant_connected')
        def participant_added(participant):
            if not self.closing and participant.identity != expected:
                on_failure('foreign_participant')

        @self.room.on('track_subscribed')
        def subscribed(track, publication, participant):
            if self.closing:
                return
            if participant.identity != expected:
                on_failure('foreign_participant')
                return
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                try:
                    publication.set_subscribed(False)
                except Exception:
                    on_failure('track_subscription_failed')
                return
            if self.track_sid not in (None, publication.sid):
                on_failure('conflicting_audio')
                return
            self.track, self.track_sid = track, publication.sid
            on_audio()  # Readiness only: AudioStream is not constructed here.

        @self.room.on('track_unsubscribed')
        def unsubscribed(track, publication, participant):
            if not self.closing and publication.sid == self.track_sid:
                on_failure('worker_audio_disconnected')

        @self.room.on('participant_disconnected')
        def disconnected(participant):
            if not self.closing and participant.identity == expected:
                on_failure('worker_disconnected')

        @self.room.on('disconnected')
        def room_disconnected(*args):
            if not self.closing:
                on_failure('room_disconnected')

        @self.room.on('reconnecting')
        def reconnecting(*args):
            if not self.closing:
                on_failure('room_reconnect_refused')

        ttl = max(1, min(1200, int(binding['expiresAt'] / 1000 - time.time())))
        def token(identity):
            return api.AccessToken(self.key, self.secret).with_identity(identity).with_ttl(timedelta(seconds=ttl)).with_grants(
                api.VideoGrants(room_join=True, room=binding['roomName'], can_publish=True, can_subscribe=True,
                                can_publish_data=False, can_publish_sources=['microphone'])).to_jwt()
        identity = binding['agentIdentity']
        self.create_attempted = True
        await self.client.room.create_room(api.CreateRoomRequest(name=binding['roomName'], empty_timeout=60, max_participants=2))
        await self.room.connect(self.url, token(identity), options=rtc.RoomOptions(auto_subscribe=False))
        for participant in self.room.remote_participants.values():
            if participant.identity != expected:
                raise VoiceError('handset_foreign_participant')
            for publication in participant.track_publications.values():
                published(publication, participant)
        self.source = rtc.AudioSource(48000, 1, queue_size_ms=100)
        local = rtc.LocalAudioTrack.create_audio_track('clawdtime-task-audio', self.source)
        await self.room.local_participant.publish_track(local, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        # Confirm one silent frame before claiming publisher readiness.
        await self.source.capture_frame(rtc.AudioFrame(bytes(1920), 48000, 1, 960))
        self._count_output('preparedSilentFrames')
        self.silence_task = asyncio.create_task(self._silence())
        return {'livekit_url': self.url, 'participant_token': token(expected), 'remote_participant_identity': identity}

    async def _silence(self):
        from livekit import rtc
        try:
            while not self.closing:
                await asyncio.wait_for(self.source.capture_frame(rtc.AudioFrame(bytes(1920), 48000, 1, 960)), .5)
                self._count_output('preparedSilentFrames')
                await asyncio.sleep(.02)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.on_failure('silent_publisher_failed')

    async def activate_output(self):
        if self.silence_task:
            self.silence_task.cancel()
            await asyncio.gather(self.silence_task, return_exceptions=True)
        self.source.clear_queue()

    async def play(self, pcm, epoch):
        from livekit import rtc
        async with self.output_lock:
            if self.closing or epoch != self.epoch:
                return
            if self.resampler is None:
                self.resampler = rtc.AudioResampler(16000, 48000, num_channels=1)
            frames = self.resampler.push(bytearray(pcm))
            for converted in frames:
                raw = bytes(converted.data)
                for offset in range(0, len(raw), 1920):
                    if self.closing or epoch != self.epoch:
                        return
                    chunk = raw[offset:offset + 1920]
                    await asyncio.wait_for(self.source.capture_frame(rtc.AudioFrame(chunk, 48000, 1, len(chunk) // 2)), .5)
                    self._count_output('speechFrames')

    async def clear(self, epoch):
        # Set epoch before waiting; pending old output cannot enqueue after this clear.
        self.epoch = epoch
        async with self.output_lock:
            self.resampler = None  # Discard filter tail instead of flushing old speech.
            if self.source:
                self.source.clear_queue()

    async def start_input(self, consume):
        from livekit import rtc
        if self.track is None or self.input_task is not None or self.closing:
            raise VoiceError('handset_input_binding_invalid')
        self.stream = rtc.AudioStream(self.track, capacity=5, sample_rate=16000, num_channels=1, frame_size_ms=20)
        async def capture():
            try:
                async for event in self.stream:
                    if self.closing:
                        return
                    frame = event.frame
                    pcm = bytes(frame.data)
                    if frame.sample_rate != 16000 or frame.num_channels != 1 or not 0 < len(pcm) <= 3200 or len(pcm) % 2:
                        raise VoiceError('handset_input_format_invalid')
                    await consume(pcm)
                if not self.closing:
                    self.on_failure('worker_audio_ended')
            except asyncio.CancelledError:
                raise
            except Exception:
                self.on_failure('worker_audio_failed')
        self.input_task = asyncio.create_task(capture())

    async def close(self):
        from livekit import api
        self.closing = True
        ok = True
        for task in (self.silence_task, self.input_task):
            if task:
                task.cancel()
        await asyncio.gather(*(t for t in (self.silence_task, self.input_task) if t), return_exceptions=True)
        async def cleanup(operation):
            nonlocal ok
            try:
                await asyncio.wait_for(operation(), 3)
            except Exception:
                ok = False
        if self.stream:
            await cleanup(self.stream.aclose)
        if self.source:
            try:
                self.source.clear_queue()
            except Exception:
                ok = False
            await cleanup(self.source.aclose)
        if self.room:
            await cleanup(self.room.disconnect)
        if self.client and self.create_attempted:
            async def delete():
                try:
                    await self.client.room.delete_room(api.DeleteRoomRequest(room=self.binding['roomName']))
                except api.TwirpError as error:
                    if error.code != 'not_found':
                        raise
            await cleanup(delete)
        if self.client:
            await cleanup(self.client.aclose)
        if self.sdk_http:
            await cleanup(self.sdk_http.close)
        self.track = self.stream = self.resampler = None
        return ok


class TaskVoiceLiveKit:
    def __init__(self, task_api, provider, port, journal, *, clock=time.time,
                 runtime_factory=TaskVoiceRuntime, worker_timeout=8, prepare_timeout=10, cleanup_join_timeout=12,
                 activation_timeout=None):
        self.api = StatusOnlyTaskAPI(task_api)
        self.provider, self.port, self.journal = GuardedProvider(provider, lambda: self.stopping), port, journal
        self.api.stopping = lambda: self.stopping
        self.clock, self.runtime_factory, self.worker_timeout = clock, runtime_factory, worker_timeout
        self.prepare_timeout, self.cleanup_join_timeout = prepare_timeout, cleanup_join_timeout
        self.activation_timeout = activation_timeout
        self.prepare_uncertain = False
        self.prepare_effect_inflight = False
        self.end_submitted = False
        self.binding = self.digest = self.credentials = self.provider_call_id = None
        self.runtime = None
        self.state = 'new'
        self.failure = None
        self.stopping = False
        self.reserved = False
        self.audio_ready = asyncio.Event()
        self.prepare_task = self.activation_task = self.close_task = None
        self.watch_tasks = set()

    def _fail(self, reason):
        if not self.stopping:
            self.failure = reason
            self._ensure_close()

    def _ensure_close(self):
        self.stopping = True
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close())
        return self.close_task

    def _check(self):
        if self.stopping or self.clock() * 1000 >= self.binding['expiresAt']:
            raise VoiceError('handset_session_unavailable')

    async def prepare(self, binding):
        value = validate_binding(binding, self.clock())
        digest = fingerprint(value)
        if self.binding is not None:
            if digest != self.digest or self.stopping:
                raise VoiceError('handset_prepare_replay_refused')
            return copy.deepcopy(await asyncio.shield(self.prepare_task))
        if self.api.task_id != value['taskId'] or self.api.voice_id != value['voiceSessionId']:
            raise VoiceError('handset_task_binding_refused')
        if self.stopping:
            raise VoiceError('handset_session_unavailable')
        self.binding, self.digest = value, digest
        self.api.call_attempt_id = value['callAttemptId']
        self.journal.reserve(value, digest)
        self.reserved = True
        self.state = 'preparing'
        self.prepare_task = asyncio.create_task(self._prepare())
        return copy.deepcopy(await asyncio.shield(self.prepare_task))

    async def _prepare(self):
        try:
            await self.api.context()
            self._check()
            await asyncio.wait_for(self.provider.readiness(), 10)
            self._check()
            self.prepare_effect_inflight = True
            self.credentials = await asyncio.wait_for(self.port.prepare(self.binding, self.audio_ready.set, self._fail), self.prepare_timeout)
            self.prepare_effect_inflight = False
            self._check()
            self.state = 'prepared'
            self.journal.record(self.binding, self.digest, 'prepared')
            task = asyncio.create_task(self._watch_expiry())
            self.watch_tasks.add(task)
            return {**self.status(), 'mediaSessionId': self.binding['mediaSessionId'], 'silentPublisherReady': True,
                    'videoPublisherReady': False, 'bindingFingerprint': self.digest,
                    'credentials': self.credentials}
        except BaseException:
            if self.prepare_effect_inflight:
                self.prepare_uncertain = True
            self._fail('prepare_failed')
            raise

    async def _watch_expiry(self):
        while not self.stopping:
            await asyncio.sleep(min(.25, max(0, self.binding['expiresAt'] / 1000 - self.clock())))
            if self.clock() * 1000 >= self.binding['expiresAt']:
                self._fail('binding_expired')
                return

    async def activate(self, value):
        if (not isinstance(value, dict) or set(value) != {'callAttemptId', 'providerCallId', 'connected'}
                or not self.binding or value['callAttemptId'] != self.binding['callAttemptId']
                or value['connected'] is not True or not isinstance(value['providerCallId'], str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', value['providerCallId'])):
            raise VoiceError('handset_activation_binding_invalid')
        self._check()
        if self.provider_call_id is not None:
            if self.provider_call_id != value['providerCallId']:
                raise VoiceError('handset_activation_rebind_refused')
            await asyncio.shield(self.activation_task)
            return self.status()
        if self.state != 'prepared':
            raise VoiceError('handset_not_prepared')
        self.provider_call_id = value['providerCallId']
        self.state = 'activating'
        self.journal.record(self.binding, self.digest, 'activating')
        self.activation_task = asyncio.create_task(self._activate())
        await asyncio.shield(self.activation_task)
        return self.status()

    async def _activate(self):
        try:
            async with asyncio.timeout(self.activation_timeout):
                await asyncio.wait_for(self.audio_ready.wait(), self.worker_timeout)
                self._check()
                await self.api.context()
                self._check()
                await self.port.activate_output()
                self._check()
                self.runtime = self.runtime_factory(self.api, self.provider, self.port)
                await self.runtime.start()
                self._check()
                await self.port.start_input(self.runtime.input_audio)
                if self.activation_timeout is not None:
                    await self.runtime.playback.first_output.wait()
                    self._check()
                self.state = 'active'
                self.journal.record(self.binding, self.digest, 'active')
                task = asyncio.create_task(self._watch_runtime())
                self.watch_tasks.add(task)
        except BaseException:
            self._fail('activation_failed')
            raise

    async def _watch_runtime(self):
        await self.runtime.ended.wait()
        self._fail('voice_ended' if not self.runtime.failed else 'voice_failed')

    def status(self):
        result = {'state': self.state, 'closed': self.state == 'closed', 'nativeCallClosed': False,
                  'audio': True, 'video': False, 'screen': False, 'presentation': False, 'control': False,
                  'remoteAudioReady': self.audio_ready.is_set()}
        if self.binding:
            result.update({key: self.binding[key] for key in ('mediaSessionId', 'callAttemptId', 'roomName')})
            result['bindingFingerprint'] = self.digest
        if self.provider_call_id:
            result['providerCallId'] = self.provider_call_id
        if hasattr(self.port, 'output_counts'):
            result['audioOutput'] = {'evidence': 'sdk_acceptance_not_audibility', **self.port.output_counts}
        if self.runtime:
            result['diagnostics'] = self.runtime.diagnostics.snapshot()
        if self.failure:
            result['reason'] = self.failure
        return result

    async def close(self):
        await asyncio.shield(self._ensure_close())
        return self.status()

    async def _close(self):
        self.state = 'closing'
        if self.reserved:
            self.journal.record(self.binding, self.digest, 'closing')
        # Do not cancel an external room creation then mistake an early delete/404
        # for proof that a delayed create cannot still complete. Join preparation
        # first; any timeout/uncertain acknowledgement remains a tombstone.
        if self.prepare_task is not None and not self.prepare_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.prepare_task), self.cleanup_join_timeout)
            except asyncio.TimeoutError:
                self.prepare_uncertain = True
            except BaseException:
                pass
        pending = [task for task in (self.activation_task, *self.watch_tasks)
                   if task is not None and task is not asyncio.current_task() and not task.done()]
        for task in pending:
            task.cancel()
        pending_uncertain = False
        if pending:
            _, unfinished = await asyncio.wait(pending, timeout=self.cleanup_join_timeout)
            pending_uncertain = bool(unfinished)
            # Retrieve completed failures without allowing an uncooperative port
            # to hold shutdown forever. Unfinished work retains unknown state.
            for task in pending:
                if task.done() and not task.cancelled():
                    task.exception()
        ok = not self.prepare_uncertain and not pending_uncertain
        if self.runtime:
            try:
                await asyncio.wait_for(self.runtime.close(), 8)
            except Exception:
                ok = False
        else:
            if self.reserved and not self.end_submitted:
                self.end_submitted = True
                try:
                    await asyncio.wait_for(self.api.request('/end', {'eventId': 'handset_end_' + self.binding['callAttemptId']}), 3)
                except Exception:
                    ok = False
            try:
                await asyncio.wait_for(self.provider.close(), 3)
            except Exception:
                ok = False
        # A journal mismatch must never authorize deleting any room.
        if self.reserved and self.journal.owns(self.binding, self.digest):
            try:
                ok = (await asyncio.wait_for(self.port.close(), 15)) is True and ok
            except Exception:
                ok = False
        elif self.binding:
            ok = False
        self.credentials = None
        self.state = 'closed' if ok else 'unknown'
        if self.reserved:
            self.journal.record(self.binding, self.digest, self.state)
