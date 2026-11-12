"""Transient assembly of finalized provider segments, never executable interim text.

Audio window durations can shrink between interim and final Results. VAD is a
short hint, not a transcript or proof that a human is still speaking. Only an
explicit provider boundary can emit text; timeouts never emit a partial command.
"""
import math
import time

EPSILON = .001


class UtteranceAssembler:
    def __init__(self, clock=time.monotonic, settle_seconds=.6, max_seconds=30,
                 vad_grace_seconds=1.5):
        self.clock = clock
        self.settle_seconds = settle_seconds
        self.max_seconds = max_seconds
        self.vad_grace_seconds = vad_grace_seconds
        self.reset()

    def reset(self):
        self.parts = []
        self.started = None  # First recognized text, never a VAD-only event.
        self.boundary_at = None
        self.boundary_source = None
        self.pending = None  # Numeric region metadata only; no interim words.
        self.vad_at = None
        self.vad_start = None
        self.suppressed = False
        self.discard_reason = None
        self.fragment_count = 0
        self.final_end = -1.0
        self.last_word_end = -1.0
        self.seen = set()
        self.watermark = -1.0

    @property
    def unfinalized(self):
        return self.pending is not None

    @property
    def vad_pending(self):
        return self.vad_at is not None and self.clock() - self.vad_at < self.vad_grace_seconds

    @property
    def has_text(self):
        return self.started is not None

    @property
    def busy(self):
        return self.has_text or self.vad_pending

    @staticmethod
    def number(value):
        if type(value) in (int, float) and 0 <= value <= 86400 and math.isfinite(value):
            return float(value)
        return None

    def discard(self, reason):
        self.parts.clear()
        self.suppressed = True
        self.discard_reason = self.discard_reason or reason

    def boundary(self, source):
        # Repeated silence/boundary events cannot postpone delivery forever.
        if self.has_text and not self.unfinalized and self.boundary_at is None:
            self.boundary_at = self.clock()
            self.boundary_source = source

    def covers_pending(self, end, boundary):
        if self.pending is None:
            return False
        pending_start, word_end = self.pending
        if end is not None and pending_start is not None and pending_start >= end - EPSILON:
            return False  # A final for the prior segment cannot erase a continuation.
        if not boundary and end is not None and word_end is not None and word_end > end + EPSILON:
            return False  # Known provisional words still extend into the next segment.
        # Ordered Results finalize their provisional region even when its previous
        # audio duration was longer. Duration is not an outstanding-word counter.
        return True

    def feed(self, message):
        if not isinstance(message, dict):
            return 'invalid'
        kind = message.get('type')
        if kind == 'SpeechStarted':
            stamp = self.number(message.get('timestamp'))
            if stamp is not None and stamp <= self.watermark:
                return 'stale'
            if not self.vad_pending:
                self.vad_at = self.clock()
                self.vad_start = stamp
            return 'vad_start'
        if kind == 'UtteranceEnd':
            end = self.number(message.get('last_word_end'))
            if (not self.unfinalized and end is not None and self.last_word_end >= 0
                    and abs(end - self.last_word_end) <= EPSILON):
                self.boundary('utterance_end')
                return 'utterance_end'
            return 'boundary_ignored'
        if kind != 'Results':
            return 'other'
        try:
            alternative = message['channel']['alternatives'][0]
            text = alternative['transcript'].strip()
        except (KeyError, IndexError, TypeError, AttributeError):
            return 'invalid'
        start = self.number(message.get('start'))
        duration = self.number(message.get('duration'))
        end = self.number(start + duration) if start is not None and duration is not None else None
        final = message.get('is_final') is True
        endpoint = final and message.get('speech_final') is True
        if end is not None and end <= self.watermark + EPSILON:
            return 'stale'
        key = (start, duration) if end is not None else ('text', text)
        if text and final and key in self.seen:
            if endpoint and not self.unfinalized and not self.vad_pending and end is not None and end >= self.final_end:
                self.boundary('speech_final')
            return 'duplicate'
        words = alternative.get('words', [])
        ends = [self.number(w.get('end')) for w in words if isinstance(w, dict)] if isinstance(words, list) else []
        ends = [value for value in ends if value is not None]
        word_end = max(ends) if ends else None
        if text:
            if self.started is None:
                self.started = self.clock()
            self.boundary_at = self.boundary_source = None
            if final:
                if len(self.seen) < 128:
                    self.seen.add(key)
                self.fragment_count += 1
                if len(text) + sum(len(p) + 1 for p in self.parts) > 8000:
                    self.discard('character_limit')
                if self.fragment_count > 128:
                    self.discard('fragment_limit')
                if not self.suppressed:
                    self.parts.append(text)
                if self.covers_pending(end, endpoint):
                    self.pending = None
                last_word = word_end if word_end is not None else end
                if last_word is not None:
                    self.last_word_end = max(self.last_word_end, last_word)
            else:
                self.pending = (start, word_end)
        elif final and self.covers_pending(end, endpoint):
            # Genuine provisional words were retracted. Never execute their prefix.
            self.pending = None
            self.discard('interim_retracted')
        if final:
            if end is not None:
                self.final_end = max(self.final_end, end)
            if self.vad_start is None or end is None or end >= self.vad_start:
                self.vad_at = self.vad_start = None
            if endpoint and (end is None or end >= self.final_end - EPSILON):
                self.boundary('speech_final')
        return ('final' if text else 'empty_final') if final else ('interim' if text else 'empty_interim')

    def snapshot(self):
        phase = ('quarantined' if self.suppressed else 'waiting_final' if self.unfinalized
                 else 'settling' if self.boundary_at is not None else 'collecting' if self.has_text
                 else 'vad_grace' if self.vad_pending else 'idle')
        return {'phase': phase, 'fragments': min(129, self.fragment_count),
                'hasInterim': self.unfinalized, 'vadPending': self.vad_pending,
                'ageMs': min(86400000, max(0, round((self.clock() - self.started) * 1000))) if self.has_text else 0}

    def take_ready(self):
        now = self.clock()
        if self.has_text and now - self.started >= self.max_seconds:
            self.discard('duration_limit')
        if not self.has_text or self.boundary_at is None or self.unfinalized or self.vad_pending or now - self.boundary_at < self.settle_seconds:
            return None
        result = {'text': ' '.join(self.parts), 'fragments': self.fragment_count,
                  'assemblyMs': round((now - self.started) * 1000),
                  'settleMs': round((now - self.boundary_at) * 1000),
                  'discarded': self.suppressed, 'reason': self.discard_reason or 'complete',
                  'boundary': self.boundary_source}
        watermark = max(self.watermark, self.final_end)
        self.reset()
        self.watermark = watermark
        return result
