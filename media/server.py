"""One bounded, silent-by-default LiveKit attention participant per Chert call.

No raw audio is persisted. Authentication and callback origin are server config.
SQLite tombstones prevent room resurrection after process interruption.
"""
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import os
import re
from pathlib import Path
import sqlite3
import time

from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
from livekit import api, rtc

from captions import CaptionScene, CaptionPublisher
from devices import ScreenController, gateway_request
from device_actions import DeviceActions
from device_relay import DeviceRelay
from playback import SpeechLedger, TERMINAL
from utterances import UtteranceAssembler
from speech_diagnostics import SpeechDiagnostics
from ledger_backup import encrypted_snapshot
from lifecycle_diagnostics import LifecycleDiagnostics, CATEGORIES
from policy import call_only_allowed, capture_allowed, final_transcript, pause_requested, priority_stop_requested, validate_session_id

RATE = 48000
SAMPLES = 960
NOTICE = 'Sharing your screen and listening. Say Stop to stop sharing.'


class BackendRequestError(Exception):
    """Only fixed metadata crosses into delivery diagnostics."""
    def __init__(self, reason, status=None):
        super().__init__('Backend callback unavailable')
        self.reason, self.status = reason, status


class Session:
    def __init__(self, owner, spec):
        self.owner, self.spec = owner, spec
        self.id = spec['id']
        self.room_name = 'clawdtime-' + self.id[3:]
        self.worker_identity = 'worker-' + self.id
        self.agent_identity = 'notes-' + self.id
        self.room = rtc.Room()
        self.source = None
        self.tasks = set()
        self.stt_tasks = set()
        self.stream = None
        self.ws = None
        self.active = False
        self.recording = True
        self.closing = False
        self.closed = False
        self.allowed = False
        self.speaking = False
        self.protocol_version = 1
        self.priority_stop_seen = set()
        self.call_id = None
        self.audio = asyncio.Queue(maxsize=100)  # 2 seconds maximum outgoing PCM
        self.segments = asyncio.Queue(maxsize=1)  # One waiting ordinary turn, never a speech backlog.
        self.delivery_notice = None
        self.track_sid = None
        self.track = None
        self.capture_task = None
        self.born = time.monotonic()
        self.lifecycle = LifecycleDiagnostics(self.born,
            (lambda data: owner.record_lifecycle_diagnostic(self.id, data))
            if hasattr(owner, "record_lifecycle_diagnostic") else None)
        self.activation = None
        self.close_task = None
        self.policy_at = 0.0
        self.policy_wakeup = asyncio.Event()
        self.segment_count = 0
        self.utterances = UtteranceAssembler()
        self.speech_diagnostics = SpeechDiagnostics(self.id, self.record_speech_diagnostic)
        self.delivering = False
        self.generation = 0
        self.credentials = None
        self.pause_latched = False
        self.seen_pause = False
        self.speech_cancelled = False
        self.priority_stop_id = None
        self.priority_stop_state = None
        self.priority_stop_task = None
        self.caption_scene = CaptionScene(spec['meetingId']) if spec.get('captions') is True or spec.get('screen') is True else None
        self.screen = ScreenController(self) if self.caption_scene and owner.env.get('MEDIA_DEVICES_ENABLED') == 'true' and (owner.env.get('DEVICE_GATEWAY_URL') or owner.env.get('DEVICE_GATEWAY_RELAY')=='true') and len(owner.env.get('DEVICE_GATEWAY_KEY','')) >= 32 else None
        self.caption_publisher = None

    def task(self, coro, category="unspecified"):
        if category not in CATEGORIES:
            raise ValueError("Unrecognized media task category")
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        def done(t):
            self.tasks.discard(t)
            if not t.cancelled() and t.exception():
                logging.error('media_task_failed session=%s category=%s', self.id, category)
                self.allowed = False
                if not self.closing:
                    self.request_failure("task_failed", category)
        task.add_done_callback(done)
        return task

    def request_failure(self, reason, category):
        # Local room teardown emits disconnect callbacks too.
        if self.closing or "closeRequested" in self.lifecycle.data:
            return None
        # Latch at callback time, before task scheduling can reorder cleanup.
        self.lifecycle.failure(reason, category)
        return self.task(self.fail(reason, category), "failure_cleanup")

    async def prepare(self):
        await self.owner.lk.room.create_room(api.CreateRoomRequest(name=self.room_name, empty_timeout=60, max_participants=2))
        def token(identity):
            return api.AccessToken(self.owner.env['LIVEKIT_API_KEY'], self.owner.env['LIVEKIT_API_SECRET']).with_identity(identity).with_ttl(timedelta(minutes=60)).with_grants(api.VideoGrants(room_join=True, room=self.room_name, can_publish=True, can_subscribe=True, can_publish_data=False)).to_jwt()
        self.credentials = {'livekit_url':self.owner.env['LIVEKIT_URL'], 'participant_token':token(self.worker_identity), 'remote_participant_identity':self.agent_identity}

        @self.room.on('track_subscribed')
        def subscribed(track, publication, participant):
            if participant.identity != self.worker_identity:
                self.request_failure("foreign_track", "track_event")
                return
            if track.kind == rtc.TrackKind.KIND_VIDEO:
                # The FaceTime worker may publish the caller's camera alongside
                # its audio. It is not our paired Mac screen source. Discard it
                # without ending the authorized call or creating a video stream.
                try:
                    publication.set_subscribed(False)
                except Exception:
                    self.request_failure("video_unsubscribe_failed", "track_event")
                return
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                self.request_failure("unexpected_track", "track_event")
                return
            if self.track_sid and self.track_sid != publication.sid:
                self.request_failure("conflicting_audio", "track_event")
                return
            self.track_sid, self.track = publication.sid, track
            if self.capture_task is None:
                self.capture_task = self.task(self.capture_loop(), "capture_loop")

        @self.room.on('participant_disconnected')
        def disconnected(participant):
            if participant.identity == self.worker_identity:
                self.request_failure("remote_participant_disconnected", "room_event")

        @self.room.on('disconnected')
        def lost(*args):
            if not self.closing:
                self.request_failure("room_disconnected", "room_event")

        await self.room.connect(self.owner.env['LIVEKIT_URL'], token(self.agent_identity))
        self.source = rtc.AudioSource(RATE, 1, queue_size_ms=100)
        track = rtc.LocalAudioTrack.create_audio_track('clawdtime-audio', self.source)
        await self.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        if self.caption_scene:
            self.caption_publisher = CaptionPublisher(self.caption_scene, self.room, screen=self.screen)
            await self.caption_publisher.start()
        self.task(self.publish(), "audio_publish")
        self.task(self.deliver(), "segment_delivery")
        self.task(self.watch_policy(), "policy_watch")

    async def publish(self):
        silence = bytes(SAMPLES * 2)
        while not self.closing:
            start = time.monotonic()
            try:
                pcm = self.audio.get_nowait()
            except asyncio.QueueEmpty:
                pcm = silence
            if isinstance(pcm, asyncio.Future):
                # Pause silence publication at an utterance boundary so LiveKit's
                # playout waiter cannot be perpetually extended by silent frames.
                if not pcm.cancelled():
                    await asyncio.wait_for(self.source.wait_for_playout(), 2)
                    if not pcm.done():
                        pcm.set_result(None)
                continue
            frame = rtc.AudioFrame(pcm, RATE, 1, SAMPLES)
            await self.source.capture_frame(frame)
            await asyncio.sleep(max(0, .02 - (time.monotonic() - start)))

    async def watch_policy(self):
        while not self.closing:
            # Active calls follow current backend authority, not a wall-clock
            # lifetime. Abandoned preparations retain their bounded cleanup.
            if not self.active and time.monotonic() - self.born > 120:
                await self.fail("activation_timeout", "deadline")
                return
            if self.active:
                try:
                    policy = await self.owner.backend(f'/media/{self.id}/policy')
                    self.policy_at = time.monotonic()
                    self.protocol_version = 2 if policy.get('protocolVersion') == 2 else 1
                    authorized = self.recording and capture_allowed(policy) and policy.get('callId') == self.call_id
                    if not authorized or policy.get('muted') is True:
                        self.owner.cancel_speech(self.id)
                    if policy.get('state') == 'paused':
                        self.seen_pause = True
                    elif self.seen_pause and policy.get('state') == 'listening' and self.priority_stop_id is None:
                        self.pause_latched = False
                        self.seen_pause = False
                    self.allowed = authorized and not self.speaking and not self.pause_latched and policy.get('muted') is not True
                    if self.screen:
                        self.screen.update(policy if authorized and not self.pause_latched else {})
                    if self.caption_scene:
                        if policy.get('callId') != self.call_id:
                            self.caption_scene.clear('unavailable')
                        elif self.pause_latched:
                            self.caption_scene.clear('paused')
                        elif self.speaking:
                            self.caption_scene.clear('speaking')
                        else:
                            self.caption_scene.apply_policy(policy)
                    if policy.get('state') == 'ended':
                        await self.close("policy_ended")
                        return
                except Exception:
                    self.allowed = False
                    self.owner.cancel_speech(self.id)
                    if self.screen:
                        self.screen.update({})
                        self.screen.diagnostics.phase('policy_unavailable','backend_unavailable')
                    if self.caption_scene:
                        self.caption_scene.clear('reconnecting')
                if not self.allowed:
                    await self.stop_stt()
            try:
                await asyncio.wait_for(self.policy_wakeup.wait(), .5)
            except asyncio.TimeoutError:
                pass
            self.policy_wakeup.clear()

    def record_speech_diagnostic(self, data):
        self.lifecycle.data['speech'] = data
        self.lifecycle.save()

    def reset_utterance(self, reason):
        if self.utterances.busy:
            self.speech_diagnostics.event('capture_reset', self.generation, reason)
        self.utterances.reset()
        self.speech_diagnostics.update(self.utterances.snapshot())
        self.speech_diagnostics.flush(force=True)

    async def stop_stt(self):
        self.generation += 1
        self.reset_utterance('generation_change')
        if self.ws:
            await self.ws.close()
        for t in list(self.stt_tasks):
            if t is not asyncio.current_task():
                t.cancel()
        if self.stream:
            await self.stream.aclose()
            self.stream = None

    async def capture_loop(self):
        while not self.closing:
            if not (self.active and self.allowed and not self.speaking and time.monotonic() - self.policy_at < 2):
                await asyncio.sleep(.1)
                continue
            generation = self.generation
            try:
                self.reset_utterance('connection_closed')
                async with self.owner.http.ws_connect('wss://api.deepgram.com/v1/listen', params={'model':self.owner.env.get('DEEPGRAM_STT_MODEL','nova-3'),'encoding':'linear16','sample_rate':str(RATE),'channels':'1','interim_results':'true','endpointing':'400','utterance_end_ms':'1000','vad_events':'true','smart_format':'true','mip_opt_out':'true'},headers={'Authorization':'Token '+self.owner.env['DEEPGRAM_API_KEY']},heartbeat=5,max_msg_size=128*1024) as ws:
                    self.ws = ws
                    self.speech_diagnostics.event('capture_open', generation)
                    self.speech_diagnostics.flush(force=True)
                    self.stream = rtc.AudioStream(self.track, capacity=5, sample_rate=RATE, num_channels=1)
                    async def send_audio():
                        async for frame in self.stream:
                            data = bytes(frame.frame.data)
                            self.speech_diagnostics.audio(len(data), nonzero=any(data))
                            if not self.allowed or generation != self.generation or self.speaking or time.monotonic()-self.policy_at>=2:
                                break
                            await asyncio.wait_for(ws.send_bytes(data),2)
                            self.speech_diagnostics.audio(0, sent=True)
                    async def receive_text():
                        async for msg in ws:
                            if msg.type != WSMsgType.TEXT:
                                continue
                            try:
                                message = json.loads(msg.data)
                            except (ValueError, TypeError):
                                self.speech_diagnostics.event('provider_invalid', generation)
                                continue
                            if self.accept_transcript(message, generation): return
                    async def flush_utterance():
                        while self.allowed and generation == self.generation and not self.closing:
                            self.flush_utterance(generation)
                            await asyncio.sleep(.05)
                    a,b,c = asyncio.create_task(send_audio()),asyncio.create_task(receive_text()),asyncio.create_task(flush_utterance())
                    self.stt_tasks.update([a,b,c])
                    try:
                        done,_ = await asyncio.wait([a,b,c],return_when=asyncio.FIRST_COMPLETED)
                        for t in done:
                            if not t.cancelled():
                                t.result()
                    finally:
                        for t in (a,b,c):
                            t.cancel()
                        await asyncio.gather(a,b,c,return_exceptions=True)
                        self.stt_tasks.difference_update([a,b,c])
            except asyncio.CancelledError:
                raise
            except Exception:
                # A deliberate pause closes the old socket before its sender is
                # cancelled. Errors from that obsolete generation are cleanup,
                # not a new provider failure. Current-generation errors remain fatal.
                if generation == self.generation and not self.closing:
                    self.speech_diagnostics.event('capture_error', generation)
                    self.speech_diagnostics.flush(force=True)
                    logging.error('transcription_stopped session=%s',self.id)
                    await self.fail("transcription_failed", "capture_loop")
                    return
            finally:
                self.speech_diagnostics.event('capture_close', generation)
                self.reset_utterance('connection_closed')
                self.ws = None
                if self.stream:
                    await self.stream.aclose()
                    self.stream = None
            await asyncio.sleep(.1)

    def segment(self, text):
        self.segment_count += 1
        return {'id':str(self.segment_count), 'text':text,
                'at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
                'source':'remote_participant', 'callId':self.call_id,
                'participantIdentity':self.worker_identity}

    def accept_transcript(self, message, generation):
        if not self.allowed or self.speaking or self.closing or generation != self.generation:
            return False
        if not isinstance(message, dict):
            self.speech_diagnostics.event('provider_invalid', generation)
            return False
        text = final_transcript(message)
        if text and (priority_stop_requested(text) or pause_requested(text)):
            self.reset_utterance('priority_stop')
            if self.queue_segment(self.segment(text)):
                return True
            self.allowed = False
            self.pause_latched = True
            if self.caption_scene:
                self.caption_scene.clear('paused')
            return True
        outcome = self.utterances.feed(message)
        number = self.utterances.number
        start = number(message.get('start', message.get('timestamp')))
        duration = number(message.get('duration'))
        last_word = number(message.get('last_word_end'))
        try:
            alternative = message['channel']['alternatives'][0]
            chars = len(alternative['transcript']) if isinstance(alternative['transcript'], str) else None
            words = alternative.get('words', [])
            ends = [number(w.get('end')) for w in words if isinstance(w, dict)] if isinstance(words, list) else []
            ends = [end for end in ends if end is not None]
            if ends:
                last_word = max(ends)
        except (KeyError, IndexError, TypeError, AttributeError):
            chars = None
        self.speech_diagnostics.event('provider_' + outcome, generation,
            characters=chars, start_ms=start*1000 if start is not None else None,
            duration_ms=duration*1000 if duration is not None else None,
            word_end_ms=last_word*1000 if last_word is not None else None,
            endpoint=message.get('speech_final') if type(message.get('speech_final')) is bool else None)
        self.speech_diagnostics.update(self.utterances.snapshot())
        self.speech_diagnostics.flush()
        return False

    def flush_utterance(self, generation):
        if not self.allowed or self.speaking or self.closing or generation != self.generation or time.monotonic()-self.policy_at >= 2:
            self.reset_utterance('policy_closed')
            return
        result = self.utterances.take_ready()
        self.speech_diagnostics.update(self.utterances.snapshot())
        self.speech_diagnostics.flush()
        if result is None:
            return
        self.lifecycle.utterance(result)
        self.speech_diagnostics.event('utterance_discarded' if result['discarded'] else 'utterance_emitted',
            generation, result['reason'])
        if result['text'] and not result['discarded']:
            self.queue_segment(self.segment(result['text']))

    def human_speaking(self):
        return self.protocol_version == 2 and (self.utterances.has_text or self.delivering or not self.segments.empty())

    def queue_segment(self, segment):
        if isinstance(segment,dict) and segment.get('id') in self.priority_stop_seen:
            return True
        if self.priority_stop_id is not None:
            return True  # A local voice Stop never automatically resumes capture or queued work.
        if isinstance(segment, dict) and self.priority_stop_allowed(segment):
            self.priority_stop_seen.add(segment['id'])
            self.priority_stop_id=segment['id']
            self.priority_stop_state='pending'
            self.allowed=False
            self.pause_latched=True
            self.generation+=1
            self.owner.cancel_speech(self.id)
            if self.caption_scene:self.caption_scene.clear('paused')
            if self.screen:self.screen.update({})
            self.delivery_notice = None
            self.discard_waiting_segments()
            # One fixed fail-safe bypass, never an ordinary parallel model/action turn.
            self.priority_stop_task=self.task(self.deliver_priority_stop(dict(segment)), "priority_stop")
            return True
        age = self.segment_age(segment)
        if not self.valid_segment(segment) or age is None:
            self.lifecycle.segment_failure('invalid_segment', 0)
            self.speech_diagnostics.event('segment_rejected', self.generation, 'invalid_segment')
            return False
        if self.segments.full():
            self.note_segment_failure(segment, 'queue_full', age)
            return False
        segment = {**segment, '_capture_generation': self.generation}
        if self.caption_scene:
            self.caption_scene.snapshot()  # expire any stale authorization first
            segment = {**segment, '_caption_epoch': self.caption_scene.epoch}
        self.segments.put_nowait(segment)
        self.speech_diagnostics.event('queue_accepted', self.generation, segment=int(segment['id']))
        return False

    def priority_stop_allowed(self,segment):
        if (not priority_stop_requested(segment.get('text')) or not self.active or
                not self.allowed or self.speaking or self.closing or not self.track_sid or
                time.monotonic()-self.policy_at>=2 or segment.get('source')!='remote_participant' or
                segment.get('participantIdentity')!=self.worker_identity or segment.get('callId')!=self.call_id or
                not isinstance(segment.get('id'),str) or not re.fullmatch(r'[1-9][0-9]{0,7}',segment['id'])):
            return False
        try:
            at=datetime.fromisoformat(segment['at'].replace('Z','+00:00'))
            return at.tzinfo is not None and abs((datetime.now(timezone.utc)-at).total_seconds())<=10
        except (KeyError,ValueError,TypeError,AttributeError):return False

    async def deliver_priority_stop(self,segment):
        try:
            # Exactly one dispatch. A lost acknowledgement remains unknown; do
            # not retry or manufacture another segment/action identity.
            result=await asyncio.wait_for(self.owner.backend(f'/media/{self.id}/segments',segment),5)
            self.priority_stop_state='acknowledged' if result.get('stopped') is True else 'unknown'
            if self.protocol_version == 2 and self.priority_stop_state == 'acknowledged':
                # The stopped sharing lease stays retired. Conversation may keep
                # listening only after the backend acknowledged the local Stop.
                self.pause_latched=False
                self.priority_stop_id=None
                self.policy_wakeup.set()
        except asyncio.CancelledError:
            self.priority_stop_state='unknown'
            raise
        except Exception:
            self.priority_stop_state='unknown'
            logging.warning('priority_voice_stop_unconfirmed session=%s',self.id)

    @staticmethod
    def segment_age(segment):
        try:
            at = datetime.fromisoformat(segment['at'].replace('Z', '+00:00'))
            if at.tzinfo is None:
                return None
            return int(abs((datetime.now(timezone.utc)-at).total_seconds())*1000)
        except (KeyError, TypeError, ValueError, AttributeError):
            return None

    def valid_segment(self, segment):
        return (isinstance(segment, dict) and
            isinstance(segment.get('id'), str) and re.fullmatch(r'[1-9][0-9]{0,7}', segment['id']) and
            isinstance(segment.get('text'), str) and 0 < len(segment['text']) <= 8000 and
            segment.get('source') == 'remote_participant' and
            segment.get('callId') == self.call_id and
            segment.get('participantIdentity') == self.worker_identity)

    def note_segment_failure(self, segment, reason, age, status=None, uncertain=False):
        self.lifecycle.segment_failure(reason, age, status)
        self.speech_diagnostics.event('segment_rejected', self.generation, reason,
            segment=int(segment['id']) if self.valid_segment(segment) else None)
        # One transient notice, with uncertainty taking precedence. No raw speech retained.
        if self.valid_segment(segment) and (self.delivery_notice is None or uncertain):
            self.delivery_notice = ({'id': segment['id'], 'callId': segment['callId']}, uncertain)

    def discard_waiting_segments(self):
        while not self.segments.empty():
            self.segments.get_nowait()
            self.segments.task_done()

    def speak_delivery_notice(self):
        if self.delivery_notice is None or not self.segments.empty():
            return
        segment, uncertain = self.delivery_notice
        self.delivery_notice = None  # Never retry an uncertain notice receipt.
        if (self.closing or not self.active or self.pause_latched or
                self.priority_stop_id is not None or self.speaking or
                not self.allowed or time.monotonic()-self.policy_at >= 2):
            return
        reply = ("I couldn't confirm that request. Check the screen before asking again."
                 if uncertain else "I missed that request. Please repeat it.")
        try:
            # Existing durable speech receipt and playback policy checks apply.
            self.owner.reply_to_segment(self, segment, {'captured': True, 'reply': reply})
        except Exception:
            logging.warning('segment_notice_unavailable session=%s', self.id)

    async def deliver(self):
        while not self.closed:
            segment = await self.segments.get()
            self.delivering = True
            try:
                if not self.valid_segment(segment):
                    self.lifecycle.segment_failure('invalid_segment', 0)
                    self.speech_diagnostics.event('segment_rejected', self.generation, 'invalid_segment')
                    continue
                caption_epoch = segment.pop('_caption_epoch', None)
                capture_generation = segment.pop('_capture_generation', None)
                age = self.segment_age(segment)
                if age is None:
                    self.lifecycle.segment_failure('invalid_segment', 0)
                    self.speech_diagnostics.event('segment_rejected', self.generation, 'invalid_segment')
                    continue
                if age > 10000:
                    self.note_segment_failure(segment, 'stale_queue', age)
                    continue
                if capture_generation != self.generation:
                    self.note_segment_failure(segment, 'obsolete_generation', age)
                    continue
                if (self.closing or not self.active or self.pause_latched or
                        self.priority_stop_id is not None or not self.allowed or
                        time.monotonic()-self.policy_at >= 2):
                    self.lifecycle.segment_failure('authority_closed', age)
                    self.speech_diagnostics.event('segment_rejected', self.generation, 'authority_closed',
                        segment=int(segment['id']))
                    continue
                try:
                    # Exactly one dispatch. Refusal or lost acknowledgement never
                    # replays a voice command, even under the same receipt identity.
                    self.speech_diagnostics.event('callback_started', self.generation, segment=int(segment['id']))
                    result = await self.owner.backend(f'/media/{self.id}/segments', segment)
                    if not isinstance(result, dict) or type(result.get('captured')) is not bool:
                        raise BackendRequestError('callback_invalid_response')
                    self.speech_diagnostics.event('callback_accepted' if result['captured'] else 'callback_refused',
                        self.generation, segment=int(segment['id']))
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    reason, status = 'callback_transport', None
                    if isinstance(error, BackendRequestError):
                        reason, status = error.reason, error.status
                    elif isinstance(error, (asyncio.TimeoutError, TimeoutError)):
                        reason = 'callback_timeout'
                    uncertain = reason != 'callback_stale'
                    self.speech_diagnostics.event('callback_failed', self.generation, reason, segment=int(segment['id']))
                    self.note_segment_failure(segment, reason, age, status, uncertain=uncertain)
                    # Queued follow-ups cannot assume an unconfirmed turn completed.
                    if uncertain:
                        self.discard_waiting_segments()
                    continue
                try:
                    if self.caption_scene and not self.closing:
                        if result.get('captured') is True and not self.pause_latched:
                            if caption_epoch == self.caption_scene.epoch:
                                self.caption_scene.append(segment)
                        else:
                            self.caption_scene.clear('paused')
                    if (capture_generation == self.generation and
                            (not self.caption_scene or caption_epoch == self.caption_scene.epoch)):
                        self.owner.reply_to_segment(self, segment, result)
                except Exception:
                    # A display/feedback failure cannot replay an accepted command
                    # or turn one conversational problem into a call hangup.
                    self.note_segment_failure(segment, 'callback_invalid_response', age, uncertain=True)
                    self.discard_waiting_segments()
            finally:
                self.delivering = False
                self.segments.task_done()
                self.speak_delivery_notice()
                self.speech_diagnostics.flush()

    async def say(self,text):
        if self.speaking or self.closing:
            raise web.HTTPConflict()
        self.speaking = True
        self.speech_cancelled = False
        self.allowed = False
        if self.caption_scene:
            self.caption_scene.clear('speaking')
        await self.stop_stt()
        try:
            async with self.owner.http.post('https://api.deepgram.com/v1/speak',params={'model':self.owner.env.get('DEEPGRAM_TTS_MODEL','aura-2-thalia-en'),'encoding':'linear16','container':'none','sample_rate':str(RATE),'mip_opt_out':'true'},headers={'Authorization':'Token '+self.owner.env['DEEPGRAM_API_KEY']},json={'text':text[:1000]}) as response:
                if response.status != 200:
                    raise RuntimeError('TTS request refused')
                pending=b''
                size=0
                async for chunk in response.content.iter_chunked(SAMPLES*2):
                    size+=len(chunk)
                    if size>RATE*2*60 or self.closing or self.speech_cancelled:
                        raise RuntimeError('TTS exceeds bounds')
                    pending+=chunk
                    while len(pending)>=SAMPLES*2:
                        await asyncio.wait_for(self.audio.put(pending[:SAMPLES*2]),3)
                        pending=pending[SAMPLES*2:]
                if pending:
                    await self.audio.put(pending.ljust(SAMPLES*2,b'\0'))
            if self.closing or self.speech_cancelled:
                raise RuntimeError('Speech cancelled')
            barrier = asyncio.get_running_loop().create_future()
            await asyncio.wait_for(self.audio.put(barrier), 3)
            await asyncio.wait_for(barrier, 3)
        finally:
            self.speaking = False
            self.policy_wakeup.set()

    async def activate(self,call_id,recording=True):
        if self.closing:
            raise web.HTTPConflict()
        if self.activation is not None and self.recording != recording:
            raise web.HTTPConflict()
        if self.call_id and self.call_id != call_id:
            raise web.HTTPConflict()
        self.call_id = call_id
        self.recording = recording
        if self.activation is None:
            async def begin():
                try:
                    if self.recording:
                        if self.screen: self.screen.diagnostics.phase('notice_playing')
                        await self.say(NOTICE)
                        if self.screen: self.screen.diagnostics.phase('notice_completed')
                    self.active = True
                    self.policy_wakeup.set()
                except Exception:
                    await self.fail("activation_failed", "activation")
                    raise
            self.activation = asyncio.create_task(begin())
        await asyncio.shield(self.activation)
        return {'activated':True}

    async def fail(self, reason="unspecified", category="unspecified"):
        diagnostic = self.lifecycle.failure(reason, category)
        self.allowed = False
        if self.screen:
            self.screen.update({})
        if self.caption_scene:
            self.caption_scene.clear('unavailable')
        await self.stop_stt()
        # Backend holds the line reservation until the worker confirms cleanup.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.owner.backend(f'/media/{self.id}/failure', diagnostic or {}), 5)
        await self.close("failure")

    async def close(self, reason="unspecified"):
        self.lifecycle.close(reason)
        if self.close_task and self.close_task.done() and not self.close_task.cancelled() and self.close_task.exception():
            self.close_task = None
        if self.close_task:
            if self.close_task is not asyncio.current_task():
                await asyncio.shield(self.close_task)
            return
        async def cleanup():
            self.closing = True
            self.allowed = False
            self.speech_cancelled = True
            self.owner.cancel_speech(self.id)
            if self.screen:
                await self.screen.close()
            if self.caption_scene:
                self.caption_scene.clear('ended')
            if self.caption_publisher:
                await self.caption_publisher.close()
            await self.stop_stt()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.segments.join(),8)
            for t in list(self.tasks):
                if t is not asyncio.current_task():
                    t.cancel()
            if self.source:
                self.source.clear_queue()
                await self.source.aclose()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.room.disconnect(),3)
            # Scoped room deletion prevents reconnect after token replay. No global room cleanup.
            await self.owner.delete_room(self.room_name)
            self.closed = True
            self.speech_diagnostics.flush(force=True)
            self.owner.db.execute('UPDATE sessions SET state=? WHERE id=?',('closed',self.id))
            self.owner.db.commit()
        self.close_task = asyncio.create_task(cleanup())
        await asyncio.shield(self.close_task)


class Service:
    def __init__(self,env=None):
        self.env = dict(os.environ if env is None else env)
        self.sessions = {}
        self.preparing = {}
        self.speech_tasks = {}
        self.ledger_backup_task = None
        self.last_ledger_backup = float("-inf")
        self.http = None
        self.lk = None
        path = self.env.get('MEDIA_DATABASE_PATH','.data/clawdtime-media.sqlite')
        Path(path).parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db = sqlite3.connect(path)
        os.chmod(path,0o600)
        self.db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS speech(id TEXT PRIMARY KEY,session TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL);')
        self.db.execute('CREATE TABLE IF NOT EXISTS screen_diagnostics(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS lifecycle_diagnostics(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
        self.db.execute("UPDATE sessions SET state='interrupted' WHERE state!='closed'")
        self.db.commit()
        self.speech = SpeechLedger(self.db)
        self.device_actions = DeviceActions(self)
        self.device_relay = DeviceRelay()

    def record_screen_diagnostic(self,sid,data):
        self.db.execute('INSERT INTO screen_diagnostics(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
                        (sid,json.dumps(data,separators=(',',':'))))
        self.db.commit()

    def record_lifecycle_diagnostic(self, sid, data):
        # A savepoint isolates diagnostic errors from any outer receipt transaction.
        self.db.execute("SAVEPOINT lifecycle_diagnostic")
        try:
            self.db.execute("INSERT INTO lifecycle_diagnostics(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                            (sid,json.dumps(data,separators=(",",":"))))
            self.db.execute("RELEASE SAVEPOINT lifecycle_diagnostic")
        except Exception:
            self.db.execute("ROLLBACK TO SAVEPOINT lifecycle_diagnostic")
            self.db.execute("RELEASE SAVEPOINT lifecycle_diagnostic")
            raise

    def ready(self):
        return all(self.env.get(k) for k in ['MEDIA_API_KEY','BACKEND_URL','LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','DEEPGRAM_API_KEY'])

    async def backend(self,path,body=None):
        # A bounded conversational turn may legitimately await several tools.
        # Its single callback response must outlive that 45-second turn; other
        # policy and cleanup requests retain their existing shorter deadlines.
        segment_timeout={'timeout':ClientTimeout(total=60,connect=5,sock_read=55)} if re.fullmatch(r'/media/ct_[a-f0-9]{40}/segments',path) else {}
        async with self.http.request('GET' if body is None else 'POST',self.env['BACKEND_URL']+path,headers={'Authorization':'Bearer '+self.env['MEDIA_API_KEY']},**({} if body is None else {'json':body}),allow_redirects=False,**segment_timeout) as response:
            raw=await response.content.read(128*1024+1)
            if len(raw)>128*1024:
                raise BackendRequestError('callback_invalid_response', response.status)
            try:
                parsed=json.loads(raw)
            except (ValueError, UnicodeError):
                raise BackendRequestError('callback_refused' if response.status >= 300 else 'callback_invalid_response', response.status) from None
            if response.status >= 300:
                stale = (response.status == 409 and isinstance(parsed, dict) and
                         parsed.get('errorCode') == 'stale_speech' and parsed.get('captured') is False)
                raise BackendRequestError('callback_stale' if stale else 'callback_refused', response.status)
            if not isinstance(parsed, dict):
                raise BackendRequestError('callback_invalid_response', response.status)
            return parsed

    async def start(self,app):
        self.http=ClientSession(timeout=ClientTimeout(total=70,connect=5,sock_read=15))
        if self.ready():
            self.lk=api.LiveKitAPI(self.env['LIVEKIT_URL'],self.env['LIVEKIT_API_KEY'],self.env['LIVEKIT_API_SECRET'])

    async def stop(self,app):
        for s in self.sessions.values():
            with contextlib.suppress(Exception):
                await asyncio.wait_for(s.close("service_shutdown"),12)
        for task in list(self.speech_tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.speech_tasks.values()), return_exceptions=True)
        await self.device_relay.close()
        if self.lk:
            await self.lk.aclose()
        await self.http.close()
        self.db.close()

    async def delete_room(self, name):
        try:
            await self.lk.room.delete_room(api.DeleteRoomRequest(room=name))
        except api.TwirpError as error:
            if error.code != 'not_found':
                raise

    async def status(self,request):
        sid=request.match_info['id']
        if not validate_session_id(sid):
            raise web.HTTPBadRequest()
        row=self.db.execute('SELECT state FROM sessions WHERE id=?',(sid,)).fetchone()
        if not row:
            raise web.HTTPNotFound()
        session=self.sessions.get(sid)
        result = {'id':sid,'alive':bool(session and not session.closing),'state':row[0]}
        diagnostic=self.db.execute('SELECT body FROM screen_diagnostics WHERE id=?',(sid,)).fetchone()
        if diagnostic:
            result['screenDiagnostics']=json.loads(diagnostic[0])
        lifecycle=self.db.execute('SELECT body FROM lifecycle_diagnostics WHERE id=?',(sid,)).fetchone()
        if lifecycle:
            result['lifecycleDiagnostics']=json.loads(lifecycle[0])
        if session and session.caption_scene:
            result['captions'] = {'enabled':session.spec.get('captions') is True, 'state':session.caption_scene.snapshot()['state'],
                                  'failed':bool(session.caption_publisher and session.caption_publisher.failed)}
        if session and session.screen:
            result['screen'] = session.screen.status()
        return web.json_response(result,headers={'Cache-Control':'no-store'})

    async def prepare(self,request):
        if not self.ready():
            raise web.HTTPServiceUnavailable(text='Media credentials are not configured.')
        spec=await request.json()
        required = {'id','meetingId','lineId'}
        if (not isinstance(spec,dict) or not required.issubset(spec)
                or not set(spec).issubset(required | {'captions','screen'})
                or not validate_session_id(spec['id'])
                or any(not isinstance(spec[k],str) or not 0<len(spec[k])<=160 for k in required)
                or any(k in spec and not isinstance(spec[k],bool) for k in ('captions','screen'))):
            raise web.HTTPBadRequest()
        if spec.get('captions') is True and self.env.get('MEDIA_CAPTIONS_ENABLED') != 'true':
            raise web.HTTPServiceUnavailable(text='Live captions are not enabled on this media service.')
        if spec.get('screen') is True and (self.env.get('MEDIA_DEVICES_ENABLED') != 'true' or not (self.env.get('DEVICE_GATEWAY_URL') or self.env.get('DEVICE_GATEWAY_RELAY')=='true') or len(self.env.get('DEVICE_GATEWAY_KEY',''))<32):
            raise web.HTTPServiceUnavailable(text='Device viewing is not configured and enabled.')
        if spec.get('screen') is True and self.env.get('DEVICE_GATEWAY_RELAY')=='true' and not self.device_relay.connected:
            raise web.HTTPServiceUnavailable(text='Device gateway is disconnected.')
        sid=spec['id']
        fingerprint=hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()
        previous=self.db.execute('SELECT fingerprint,state FROM sessions WHERE id=?',(sid,)).fetchone()
        if previous and previous[0]!=fingerprint:
            raise web.HTTPConflict()
        if sid in self.preparing:
            s=await asyncio.shield(self.preparing[sid])
        elif sid in self.sessions and not self.sessions[sid].closing:
            s=self.sessions[sid]
        else:
            if previous or sum(not s.closed for s in self.sessions.values())>=int(self.env.get('MEDIA_MAX_SESSIONS','2')):
                raise web.HTTPConflict(text='Session interrupted or capacity reached; reconcile first.')
            self.db.execute('INSERT INTO sessions VALUES(?,?,?)',(sid,fingerprint,'preparing'))
            self.db.commit()
            s=Session(self,spec)
            self.sessions[sid]=s
            async def prepare():
                try:
                    await asyncio.wait_for(s.prepare(),7)
                    self.db.execute('UPDATE sessions SET state=? WHERE id=?',('prepared',sid));self.db.commit()
                    return s
                except BaseException:
                    with contextlib.suppress(Exception):
                        await s.close("prepare_failed")
                    raise
            self.preparing[sid]=asyncio.create_task(prepare())
            try:
                s=await asyncio.shield(self.preparing[sid])
            finally:
                self.preparing.pop(sid,None)
        result = {'id':sid,'silentPublisherReady':True,'credentials':s.credentials}
        if spec.get('captions') is True or spec.get('screen') is True:
            result['videoPublisherReady'] = bool(s.caption_publisher and not s.caption_publisher.failed)
        return web.json_response(result)

    def cancel_speech(self, sid):
        session = self.sessions.get(sid)
        if session:
            session.speech_cancelled = True
            while not session.audio.empty():
                item = session.audio.get_nowait()
                if isinstance(item, asyncio.Future) and not item.done():
                    item.cancel()
            if session.source:
                session.source.clear_queue()
        for utterance_id, task in list(self.speech_tasks.items()):
            receipt = self.speech.get(utterance_id)
            if receipt and receipt['sessionId'] == sid and receipt['state'] not in TERMINAL:
                self.speech.set(utterance_id, 'cancelled', 'capture_stopped')
                task.cancel()

    async def speech_status(self, request):
        sid, utterance_id = request.match_info['id'], request.match_info['utterance']
        if not validate_session_id(sid) or not 0 < len(utterance_id) <= 200:
            raise web.HTTPBadRequest()
        receipt = self.speech.get(utterance_id)
        if not receipt or receipt['sessionId'] != sid:
            raise web.HTTPNotFound()
        return web.json_response(self.speech.public(receipt))

    async def play_speech(self, session, utterance_id, text, expected_segments=None):
        observed_segments = session.segment_count if expected_segments is None else expected_segments
        generation = session.generation
        def outcome(state, reason=None):
            self.speech.set(utterance_id, state, reason)
            event = {'playing':'playback_started','completed':'playback_completed',
                     'cancelled':'reply_cancelled','failed':'playback_failed','unknown':'playback_unknown'}.get(state)
            if event:
                session.speech_diagnostics.event(event, session.generation, reason)
                session.speech_diagnostics.update(session.utterances.snapshot())
                session.speech_diagnostics.flush(force=True)
        try:
            policy = await self.backend(f'/media/{session.id}/policy')
            if session.closing or session.pause_latched or not session.active or not capture_allowed(policy) or policy.get('muted') is True or policy.get('callId') != session.call_id:
                outcome('cancelled', 'authorization_closed')
                return
            async def start_playback():
                # wait_for schedules a new task; check inside that task so no
                # continuation can arrive between this guard and say's mute.
                if session.protocol_version == 2 and session.utterances.vad_pending and not session.human_speaking():
                    session.speech_diagnostics.event('reply_deferred', session.generation)
                    until = time.monotonic() + session.utterances.vad_grace_seconds
                    while session.utterances.vad_pending and time.monotonic() < until:
                        if (session.human_speaking() or session.segment_count != observed_segments
                                or session.closing or session.pause_latched or session.generation != generation):
                            break
                        await asyncio.sleep(.05)
                    # Waiting does not extend authority. Recheck policy before playback.
                    current = await self.backend(f'/media/{session.id}/policy')
                    if not capture_allowed(current) or current.get('muted') is True or current.get('callId') != session.call_id:
                        return 'authorization_closed'
                if session.closing or session.pause_latched or not session.active or session.generation != generation:
                    return 'authorization_closed'
                if session.protocol_version == 2 and session.segment_count != observed_segments:
                    return 'newer_human_turn'
                if session.human_speaking():
                    return 'human_speaking'
                outcome('playing')
                await session.say(text)
                return None
            refused = await asyncio.wait_for(start_playback(), 30)
            if refused:
                outcome('cancelled', refused)
                return
            if session.closing or session.speech_cancelled:
                outcome('cancelled', 'capture_stopped')
            else:
                outcome('completed')
        except asyncio.CancelledError:
            receipt = self.speech.get(utterance_id)
            if receipt and receipt['state'] not in TERMINAL:
                outcome('unknown', 'playback_interrupted')
            raise
        except Exception:
            outcome('failed', 'playback_failed')
            # Do not let a partial failed utterance continue playing.
            session.speech_cancelled = True
            while not session.audio.empty():
                session.audio.get_nowait()
            if session.source:
                session.source.clear_queue()
        finally:
            self.speech_tasks.pop(utterance_id, None)

    def reply_to_segment(self, session, segment, result):
        """At-most-once bounded spoken feedback; text stays transient, receipts do not."""
        text=result.get('reply')
        if (result.get('captured') is not True or not isinstance(text,str) or
                not text.strip() or len(text)>1000 or
                not isinstance(segment.get('id'),str) or not re.fullmatch(r'[1-9][0-9]{0,7}',segment['id']) or
                segment.get('callId')!=session.call_id or not session.active or
                session.closing or session.pause_latched): return
        utterance_id='reply_'+hashlib.sha256((session.id+':'+segment['id']).encode()).hexdigest()
        if self.speech.get(utterance_id): return  # completed, failed and unknown never replay
        self.speech.accept(utterance_id,session.id,hashlib.sha256(text.encode()).hexdigest())
        if session.speaking or any(self.speech.get(key)['sessionId']==session.id for key in self.speech_tasks):
            self.speech.set(utterance_id,'cancelled','speech_busy')
            return
        self.speech_tasks[utterance_id]=asyncio.create_task(
            self.play_speech(session,utterance_id,text,session.segment_count))

    async def action(self,request):
        sid,action=request.match_info['id'],request.match_info['action']
        if not validate_session_id(sid):
            raise web.HTTPBadRequest()
        s=self.sessions.get(sid)
        body=await request.json()
        if action=='close':
            if s:
                await s.close("backend_close")
            elif self.lk:
                # Interrupted session has no audio buffers to drain, but its room must still be deleted.
                if not self.db.execute('SELECT id FROM sessions WHERE id=?',(sid,)).fetchone():
                    raise web.HTTPNotFound()
                await self.delete_room('clawdtime-'+sid[3:])
                self.db.execute('UPDATE sessions SET state=? WHERE id=?',('closed',sid));self.db.commit()
            else:
                raise web.HTTPServiceUnavailable()
            return web.json_response({'closed':True})
        if not s or s.closing:
            raise web.HTTPConflict()
        if action=='activate':
            policy=await self.backend(f'/media/{sid}/policy')
            recording = capture_allowed(policy)
            if not body.get('callId') or policy.get('callId')!=body['callId'] or not (recording or call_only_allowed(policy)):
                raise web.HTTPConflict()
            return web.json_response(await s.activate(body.get('callId'), recording=recording))
        if action=='speak':
            expected_segments = s.segment_count
            if set(body) not in ({'id','text'}, {'id','text','callId'}) or not isinstance(body['id'],str) or not 0<len(body['id'])<=200 or not isinstance(body['text'],str) or not 0<len(body['text'])<=1600:
                raise web.HTTPBadRequest()
            digest=hashlib.sha256(body['text'].encode()).hexdigest()
            previous=self.speech.get(body['id'])
            if previous:
                if previous['sessionId'] != sid or previous['fingerprint'] != digest:
                    raise web.HTTPConflict(text='Speech identity conflict.')
                return web.json_response(self.speech.public(previous), status=200 if previous['state'] in TERMINAL else 202)
            policy=await self.backend(f'/media/{sid}/policy')
            if not s.active or not capture_allowed(policy) or policy.get('muted') is True or policy.get('callId') != s.call_id or ('callId' in body and body['callId'] != s.call_id):
                raise web.HTTPConflict()
            # Another request may have committed this ID while policy was fetched.
            previous=self.speech.get(body['id'])
            if previous:
                if previous['sessionId'] != sid or previous['fingerprint'] != digest:
                    raise web.HTTPConflict(text='Speech identity conflict.')
                return web.json_response(self.speech.public(previous),status=200 if previous['state'] in TERMINAL else 202)
            if s.speaking or any(self.speech.get(key)['sessionId'] == sid for key in self.speech_tasks):
                raise web.HTTPConflict(text='Speech is already playing.')
            receipt=self.speech.accept(body['id'], sid, digest)
            if s.human_speaking():
                self.speech.set(body['id'], 'cancelled', 'human_speaking')
                s.speech_diagnostics.event('reply_cancelled', s.generation, 'human_speaking')
                s.speech_diagnostics.update(s.utterances.snapshot())
                s.speech_diagnostics.flush(force=True)
                return web.json_response(self.speech.public(self.speech.get(body['id'])))
            self.speech_tasks[body['id']] = asyncio.create_task(self.play_speech(s, body['id'], body['text'], expected_segments))
            return web.json_response(self.speech.public(receipt),status=202)
        raise web.HTTPNotFound()

    async def ledger_backup(self, request):
        key = self.env.get('BACKUP_ENCRYPTION_KEY')
        if not key:
            raise web.HTTPNotFound()
        if request.query_string:
            raise web.HTTPBadRequest(text='Backup identity and source are fixed by the service.')
        if self.ledger_backup_task is not None or time.monotonic() - self.last_ledger_backup < 60:
            raise web.HTTPTooManyRequests(headers={'Retry-After': '60'})
        self.last_ledger_backup = time.monotonic()
        task = asyncio.create_task(asyncio.to_thread(
            encrypted_snapshot,
            self.env.get('MEDIA_DATABASE_PATH', '.data/clawdtime-media.sqlite'),
            key, 'clawdtime-media-ledger-v1',
        ))
        self.ledger_backup_task = task
        def finished(completed):
            if self.ledger_backup_task is completed:
                self.ledger_backup_task = None
            if not completed.cancelled():
                completed.exception()  # Retrieve failures even if the client disconnected.
        task.add_done_callback(finished)
        # Client cancellation cannot release the slot while its worker still snapshots.
        envelope, _counts = await asyncio.shield(task)
        return web.Response(body=envelope, content_type='application/octet-stream', headers={
            'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="media-ledger.sqlite.enc"',
            'X-Content-SHA256': hashlib.sha256(envelope).hexdigest(),
        })

    def app(self):
        @web.middleware
        async def auth(request,handler):
            if request.path!='/health':
                key=self.env.get('DEVICE_GATEWAY_KEY','') if request.path=='/device-gateway' else self.env.get('MEDIA_API_KEY','')
                if len(key)<32 or not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+key):
                    raise web.HTTPUnauthorized()
            try:
                return await handler(request)
            except web.HTTPException:
                raise
            except Exception:
                logging.error('media_request_failed path=%s',request.path)
                return web.json_response({'error':'Media operation failed; reconcile before retrying.'},status=503)
        app=web.Application(client_max_size=16384,middlewares=[auth])
        async def health(request):
            devices_configured=self.env.get('MEDIA_DEVICES_ENABLED')=='true' and len(self.env.get('DEVICE_GATEWAY_KEY',''))>=32 and bool(self.env.get('DEVICE_GATEWAY_URL') or self.env.get('DEVICE_GATEWAY_RELAY')=='true')
            return web.json_response({'ok':True,'service':'clawdtime-media','configured':self.ready(),'activeSessions':sum(not s.closed for s in self.sessions.values()),'deviceGatewayConnected':self.device_relay.connected,'devicesConfigured':devices_configured})
        app.router.add_get('/health',health)
        app.router.add_get('/internal/ledger-backup',self.ledger_backup, allow_head=False)
        async def device_readiness(request):
            device=request.match_info['device']
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',device):raise web.HTTPBadRequest()
            member=request.match_info.get('member');display=request.match_info.get('display')
            suffix=''
            if member is not None or display is not None:
                if not member or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',member) or not display or not re.fullmatch(r'[0-9]{1,10}',display) or not 0<int(display)<=0xffffffff:raise web.HTTPBadRequest()
                suffix=f'/{member}/{display}'
            status,raw,_=await gateway_request(self,'GET',f'/v1/devices/{device}/readiness'+suffix)
            if status!=200:raise web.HTTPServiceUnavailable(text='Registered helper readiness unavailable.')
            value=json.loads(raw)
            if not isinstance(value,dict) or value.get('deviceId')!=device:raise web.HTTPBadGateway()
            return web.json_response(value,headers={'Cache-Control':'no-store'})
        async def device_panel(request):
            device=request.match_info['device']
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',device):raise web.HTTPBadRequest()
            body=await request.json()
            if not isinstance(body,dict):raise web.HTTPBadRequest()
            # Display actual state from this exact media call, never another
            # active call. Terminal/local mute status remains backend-owned.
            if body.get('callState') not in ('ended','muted'):
                call_id=body.get('callId')
                session=self.sessions.get(call_id) if isinstance(call_id,str) else None
                state='connected'
                if session and session.call_id==call_id and session.active and not session.closing:
                    if session.speaking:state='speaking'
                    elif session.allowed:state='listening'
                body={**body,'callState':state}
            status,raw,_=await gateway_request(self,'POST',f'/v1/devices/{device}/panel',body)
            return web.Response(status=status,body=raw,content_type='application/json',headers={'Cache-Control':'no-store'})
        app.router.add_post('/devices/{device}/panel',device_panel)
        app.router.add_get('/devices/{device}/readiness',device_readiness)
        app.router.add_get('/devices/{device}/readiness/{member}/{display}',device_readiness)
        app.router.add_get('/device-gateway',self.device_relay.connect)
        app.router.add_post('/sessions',self.prepare)
        app.router.add_get('/sessions/{id}',self.status)
        app.router.add_get('/sessions/{id}/speech/{utterance}',self.speech_status)
        async def screen_status(request):
            session=self.sessions.get(request.match_info['id'])
            if not session or not session.screen:raise web.HTTPNotFound()
            return web.json_response(await session.screen.observed())
        async def screen_frame(request):
            session=self.sessions.get(request.match_info['id'])
            if not session or not session.screen:raise web.HTTPNotFound()
            try:return web.json_response(await session.screen.observed(include_frame=True))
            except ValueError:raise web.HTTPConflict(text='A fresh authorized screen frame is unavailable.')
        async def screen_lease(request):
            sid=request.match_info['id'];body=await request.json()
            session=self.sessions.get(sid)
            if not isinstance(body,dict) or set(body) not in ({'leaseId'},{'leaseId','executorEpoch'}) or not isinstance(body['leaseId'],str):raise web.HTTPBadRequest()
            if not session or not session.screen:raise web.HTTPConflict()
            policy=await self.backend(f'/media/{sid}/policy')
            selection=session.screen.valid_selection(policy)
            if not selection or selection['leaseId']!=body['leaseId']:raise web.HTTPConflict(text='Lease is not currently authorized by backend policy.')
            if selection.get('protocolVersion')==2 and body.get('executorEpoch')!=selection['executorEpoch']:raise web.HTTPConflict()
            session.screen.update(policy)
            if selection.get('protocolVersion')==2:
                until=time.monotonic()+2.5
                while (session.screen.applied_epoch!=selection['executorEpoch'] or session.screen.applied_lease!=body['leaseId']) and time.monotonic()<until:
                    if session.screen.state=='stopped' or not session.screen.selection or session.screen.selection['leaseId']!=body['leaseId']:raise web.HTTPConflict()
                    await asyncio.sleep(.025)
                if not session.screen.selection or session.screen.selection['leaseId']!=body['leaseId'] or session.screen.selection.get('executorEpoch')!=selection['executorEpoch'] or session.screen.applied_lease!=body['leaseId'] or session.screen.applied_epoch!=selection['executorEpoch']:raise web.HTTPServiceUnavailable(text='Ownership acknowledgement pending; reconcile before input.')
            return web.json_response({'accepted':True,'leaseId':body['leaseId'],**({'executorEpoch':session.screen.applied_epoch} if selection.get('protocolVersion')==2 else {})})
        async def screen_stop(request):
            sid=request.match_info['id'];body=await request.json()
            session=self.sessions.get(sid)
            if not isinstance(body,dict) or set(body)!={'leaseId'} or not isinstance(body['leaseId'],str):raise web.HTTPBadRequest()
            if not session or not session.screen:raise web.HTTPConflict()
            screen=session.screen;selection=screen.selection
            if not selection or selection['leaseId']!=body['leaseId']:
                if body['leaseId'] in screen.stopped and time.time()>=screen.release_blocked_until:
                    return web.json_response({'released':True,'leaseId':body['leaseId']})
                raise web.HTTPConflict(text='Lease release requires exact current selection.')
            screen.update({})
            if screen.transition_task:await asyncio.shield(screen.transition_task)
            if time.time()<screen.release_blocked_until:raise web.HTTPServiceUnavailable(text='Release is uncertain; wait for lease expiry and reconcile.')
            return web.json_response({'released':True,'leaseId':body['leaseId']})
        app.router.add_post('/sessions/{id}/screen/lease',screen_lease)
        app.router.add_post('/sessions/{id}/screen/stop',screen_stop)
        app.router.add_get('/sessions/{id}/screen',screen_status)
        app.router.add_get('/sessions/{id}/screen/frame',screen_frame)
        app.router.add_post('/sessions/{id}/screen/actions',self.device_actions.post)
        app.router.add_get('/sessions/{id}/screen/actions/{action_id}',self.device_actions.get)
        app.router.add_post('/sessions/{id}/{action}',self.action)
        app.on_startup.append(self.start)
        app.on_cleanup.append(self.stop)
        return app


if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    web.run_app(Service().app(),host=os.getenv('HOST','127.0.0.1'),port=int(os.getenv('PORT','4212')),access_log=None)
