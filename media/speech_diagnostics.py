"""Bounded speech-pipeline telemetry. Never accepts transcript, audio or errors."""
from collections import deque
from datetime import datetime, timezone
import json
import logging
import time

EVENTS = frozenset('capture_open capture_close capture_reset capture_error provider_invalid provider_vad_start provider_final provider_empty_final provider_interim provider_empty_interim provider_utterance_end provider_boundary_ignored provider_duplicate provider_stale provider_other utterance_emitted utterance_discarded queue_accepted callback_started callback_accepted callback_refused callback_failed reply_deferred reply_cancelled playback_started playback_completed playback_failed playback_unknown segment_rejected'.split())
COUNTERS = EVENTS | frozenset(('audio_frames', 'audio_bytes', 'audio_nonzero_frames', 'audio_sent_frames'))
REASONS = frozenset('generation_change connection_closed policy_closed priority_stop complete character_limit fragment_limit duration_limit interim_retracted human_speaking newer_human_turn authorization_closed capture_stopped playback_failed playback_interrupted invalid_segment stale_queue obsolete_generation queue_full authority_closed callback_stale callback_refused callback_timeout callback_transport callback_invalid_response'.split())
PHASES = frozenset(('idle', 'vad_grace', 'collecting', 'waiting_final', 'settling', 'quarantined'))
BOUND = 999999999


def bounded(value, limit=BOUND):
    return min(limit, max(0, int(value))) if type(value) in (int, float) and value == value and abs(value) != float('inf') else 0


class SpeechDiagnostics:
    def __init__(self, session_id, persist, clock=time.monotonic, interval=2):
        self.session_id, self.persist, self.clock = session_id, persist, clock
        self.born = clock()
        self.interval = interval
        self.last_flush = float('-inf')
        self.counts = {key: 0 for key in sorted(COUNTERS)}
        self.events = deque(maxlen=64)
        self.sequence = 0
        self.logged_sequence = 0
        self.state = {'phase':'idle','fragments':0,'hasInterim':False,'vadPending':False,'ageMs':0}
        self.dirty = False

    def audio(self, size, nonzero=False, sent=False):
        if sent:
            self.counts['audio_sent_frames'] = min(BOUND, self.counts['audio_sent_frames'] + 1)
        else:
            self.counts['audio_frames'] = min(BOUND, self.counts['audio_frames'] + 1)
            self.counts['audio_bytes'] = min(BOUND, self.counts['audio_bytes'] + bounded(size))
            self.counts['audio_nonzero_frames'] = min(BOUND, self.counts['audio_nonzero_frames'] + int(nonzero is True))
        self.dirty = True

    def event(self, event, generation=0, reason=None, segment=None, characters=None,
              start_ms=None, duration_ms=None, word_end_ms=None, endpoint=None):
        if event not in EVENTS or (reason is not None and reason not in REASONS):
            raise ValueError('Unrecognized speech diagnostic category')
        self.sequence = min(BOUND, self.sequence + 1)
        self.counts[event] = min(BOUND, self.counts[event] + 1)
        value = {'sequence':self.sequence,'event':event,'generation':bounded(generation),
                 'elapsedMs':bounded((self.clock()-self.born)*1000,86400000)}
        if reason is not None:
            value['reason'] = reason
        if segment is not None:
            value['segment'] = bounded(segment)
        if characters is not None:
            value['characters'] = bounded(characters, 8001)
        for key, number in [('startMs',start_ms),('durationMs',duration_ms),('lastWordEndMs',word_end_ms)]:
            if number is not None:
                value[key] = bounded(number,86400000)
        if type(endpoint) is bool:
            value['speechFinal'] = endpoint
        self.events.append(value)
        self.dirty = True

    def update(self, snapshot):
        phase = snapshot.get('phase')
        if phase not in PHASES:
            raise ValueError('Unrecognized speech diagnostic phase')
        value = {'phase':phase,'fragments':bounded(snapshot.get('fragments'),129),
                 'hasInterim':snapshot.get('hasInterim') is True,
                 'vadPending':snapshot.get('vadPending') is True,
                 'ageMs':bounded(snapshot.get('ageMs'),86400000)}
        if value != self.state:
            self.state = value
            self.dirty = True

    def flush(self, force=False):
        if not self.dirty or (not force and self.clock()-self.last_flush < self.interval):
            return
        self.last_flush = self.clock()
        self.dirty = False
        value = {'version':1,'at':datetime.now(timezone.utc).isoformat(),
                 'counts':dict(self.counts),'state':dict(self.state),
                 'events':[dict(event) for event in self.events]}
        try:
            self.persist(value)
        except Exception:
            logging.error('speech_diagnostic_unavailable')
        # Only fixed keys/categories and numbers; no provider payload or text.
        logging.info('speech_pipeline %s', json.dumps({'sessionId':self.session_id,
            'at':value['at'],'counts':value['counts'],'state':value['state'],
            'events':[event for event in value['events'] if event['sequence'] > self.logged_sequence]}, separators=(',',':')))
        self.logged_sequence = self.sequence
