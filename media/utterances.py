"""Transient utterance assembly. Stable STT segments are not complete requests.

Only finalized text is emitted, after a boundary plus a continuation window.
Interim text is never retained or executable. Reset on every capture generation.
"""
import math
import time


class UtteranceAssembler:
    def __init__(self, clock=time.monotonic, settle_seconds=.6, max_seconds=30):
        self.clock = clock
        self.settle_seconds, self.max_seconds = settle_seconds, max_seconds
        self.watermark = -1.0
        self.reset()

    def reset(self):
        self.parts = []
        self.started = None
        self.boundary_at = None
        self.unfinalized = False
        self.suppressed = False
        self.fragment_count = 0
        self.final_end = -1.0
        self.last_word_end = -1.0
        self.latest_end = -1.0
        self.seen = set()
        self.watermark = -1.0

    @property
    def busy(self):
        return self.started is not None

    @staticmethod
    def number(value):
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None

    def feed(self, message):
        if not isinstance(message, dict):
            return
        now = self.clock()
        kind = message.get('type')
        if kind == 'SpeechStarted':
            if self.started is None:
                self.started = now
            self.boundary_at = None
            self.unfinalized = True
            return
        if kind == 'UtteranceEnd':
            end = self.number(message.get('last_word_end'))
            if self.busy and not self.unfinalized and end is not None and self.last_word_end >= 0 and end >= self.last_word_end:
                self.boundary_at = now
            return
        if kind != 'Results':
            return
        try:
            text = message['channel']['alternatives'][0]['transcript'].strip()
        except (KeyError, IndexError, TypeError, AttributeError):
            return
        start, duration = self.number(message.get('start')), self.number(message.get('duration'))
        end = start + duration if start is not None and duration is not None else None
        if end is not None and end <= self.watermark:
            return  # Already emitted audio on this capture connection.
        key = (start, duration) if end is not None else ('text', text)
        if text and message.get('is_final') is True and key in self.seen:
            return  # A duplicate cannot finish or erase newer speech activity.
        if text:
            if self.started is None:
                self.started = now
            self.boundary_at = None
            if end is not None:
                self.latest_end = max(self.latest_end, end)
            if message.get('is_final') is True:
                if key not in self.seen:
                    if len(self.seen) < 128:
                        self.seen.add(key)
                    self.fragment_count += 1
                    if len(text) + sum(len(p) + 1 for p in self.parts) > 8000 or self.fragment_count > 128:
                        self.parts.clear()
                        self.suppressed = True
                    if not self.suppressed:
                        self.parts.append(text)
                if end is not None:
                    self.final_end = max(self.final_end, end)
                words = message['channel']['alternatives'][0].get('words', [])
                word_ends = [self.number(w.get('end')) for w in words if isinstance(w, dict)] if isinstance(words, list) else []
                word_ends = [value for value in word_ends if value is not None]
                last_word = max(word_ends) if word_ends else end
                if last_word is not None:
                    self.last_word_end = max(self.last_word_end, last_word)
                self.unfinalized = end is not None and self.latest_end > self.final_end
            else:
                self.unfinalized = True
        elif message.get('is_final') is True and message.get('speech_final') is True and self.unfinalized:
            # VAD can detect noise or provisional words that never finalize.
            # Drop the whole incomplete request rather than execute its prefix.
            self.parts.clear()
            self.suppressed = True
            self.unfinalized = False
            if end is not None:
                self.final_end = max(self.final_end, end)
        if message.get('speech_final') is True and self.busy and not self.unfinalized:
            self.boundary_at = now

    def take_ready(self):
        now = self.clock()
        if self.busy and now - self.started >= self.max_seconds:
            # Never execute a truncated command; remain suppressed until a boundary.
            self.parts.clear()
            self.suppressed = True
        if not self.busy or self.boundary_at is None or self.unfinalized or now - self.boundary_at < self.settle_seconds:
            return None
        result = {'text': ' '.join(self.parts), 'fragments': self.fragment_count,
                  'assemblyMs': round((now - self.started) * 1000),
                  'settleMs': round((now - self.boundary_at) * 1000),
                  'discarded': self.suppressed}
        watermark = max(self.watermark, self.final_end)
        self.reset()
        self.watermark = watermark
        return result
