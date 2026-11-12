"""Allowlisted first-failure metadata; no exception strings or media content."""
from datetime import datetime, timezone
import logging
import time

REASONS = frozenset(('task_failed', 'transcription_failed', 'remote_participant_disconnected',
    'room_disconnected', 'foreign_track', 'unexpected_track', 'conflicting_audio',
    'video_unsubscribe_failed', 'activation_failed', 'maximum_duration',
    'activation_timeout', 'unspecified'))
CATEGORIES = frozenset(('audio_publish', 'segment_delivery', 'policy_watch', 'capture_loop',
    'priority_stop', 'room_event', 'track_event', 'activation', 'deadline',
    'failure_cleanup', 'unspecified'))
SEGMENT_REASONS = frozenset(('stale_queue', 'obsolete_generation', 'queue_full',
    'authority_closed', 'callback_stale', 'callback_refused', 'callback_timeout',
    'callback_transport', 'callback_invalid_response', 'invalid_segment'))
CLOSE_REASONS = frozenset(('failure', 'policy_ended', 'backend_close', 'service_shutdown',
    'prepare_failed', 'unspecified'))


class LifecycleDiagnostics:
    def __init__(self, born, persist=None):
        self.born, self.persist = born, persist
        self.data = {'version': 1}

    def timing(self):
        return {'at': datetime.now(timezone.utc).isoformat(),
                'elapsedMs': max(0, min(86400000, int((time.monotonic()-self.born)*1000)))}

    def save(self):
        if self.persist:
            try:
                self.persist(self.data)
            except Exception:
                # Diagnostics must never prevent revocation or commit receipt work.
                logging.error('media_lifecycle_diagnostic_unavailable')

    def failure(self, reason, category):
        if reason not in REASONS or category not in CATEGORIES:
            raise ValueError('Unrecognized media lifecycle category')
        if 'firstFailure' not in self.data and 'closeRequested' not in self.data:
            self.data['firstFailure'] = {'reason': reason, 'category': category, **self.timing()}
            self.save()
        return self.data.get('firstFailure')

    def close(self, reason):
        if reason not in CLOSE_REASONS:
            raise ValueError('Unrecognized media close category')
        if 'closeRequested' not in self.data:
            self.data['closeRequested'] = {'reason': reason, **self.timing()}
            self.save()

    def segment_failure(self, reason, age_ms, http_status=None):
        if reason not in SEGMENT_REASONS:
            raise ValueError('Unrecognized speech delivery category')
        value = {'reason': reason, **self.timing(),
                 'ageMs': max(0, min(86400000, int(age_ms)))}
        if http_status is not None:
            if type(http_status) is not int or not 100 <= http_status <= 599:
                raise ValueError('Invalid speech delivery status')
            value['httpStatus'] = http_status
        self.data['lastSegmentFailure'] = value
        self.save()
