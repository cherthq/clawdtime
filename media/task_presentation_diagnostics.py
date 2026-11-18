"""Content-free, bounded presentation diagnostics. Never serialize exceptions."""
import asyncio
import time

PHASES = frozenset(('idle', 'prepare_authority', 'local_start', 'native_inspect', 'show_authority',
    'await_source', 'source_capture', 'frame_render', 'narrate_frame', 'await_paint', 'narration',
    'provider_readiness', 'provider_open', 'await_settings', 'settings_send', 'ready',
    'cue_authority', 'cue_inject', 'cue_playback', 'cue_drain', 'cue_complete', 'stop', 'closed'))
COUNTERS = frozenset(('paintAccepted', 'paintRefused', 'welcome', 'settingsApplied', 'injected',
    'assistantText', 'audioChunks', 'audioBytes', 'providerAudioDone', 'sinkChunks', 'sinkCompleted',
    'quarantinedChunks', 'quarantineReleasedChunks', 'quarantineDiscardedBytes'))
REASONS = frozenset(('presentation_refused', 'presentation_authority_unavailable',
    'presentation_cleanup_unconfirmed', 'provider_preflight_refused', 'provider_preflight_unavailable',
    'provider_preflight_stale', 'provider_origin_refused', 'provider_reconnect_refused',
    'provider_socket_refused', 'provider_socket_unavailable', 'narration_closed',
    'narration_restart_refused', 'narration_stopped', 'narration_audio_refused',
    'narration_disconnected', 'narration_protocol_refused', 'narration_text_refused',
    'narration_prefix_mismatch', 'narration_completion_unconfirmed', 'narration_provider_error',
    'narration_text_quarantine_timeout', 'narration_text_quarantine_capacity',
    'narration_provider_warning', 'narration_injection_refused', 'narration_unexpected_tool',
    'narration_user_started', 'narration_interrupted', 'narration_busy_or_closed',
    'narration_cleanup_unconfirmed', 'playback_ack_timeout', 'local_audio_unavailable'))


class PresentationDiagnostics:
    def __init__(self):
        self.current = 'idle'
        self.entered = time.monotonic()
        self.failure = None
        self.counts = {}

    def phase(self, name):
        if name not in PHASES:
            raise ValueError('diagnostic_phase_refused')
        self.current, self.entered = name, time.monotonic()

    def increment(self, name, amount=1):
        if name not in COUNTERS or type(amount) is not int or amount < 0:
            raise ValueError('diagnostic_counter_refused')
        self.counts[name] = min(1000000, self.counts.get(name, 0) + amount)

    def fail(self, error, phase=None):
        if self.failure is not None:
            return
        selected = phase or self.current
        if selected not in PHASES:
            selected = 'idle'
        reason = 'operation_failed'
        if isinstance(error, TimeoutError):
            reason = 'deadline_exceeded'
        elif isinstance(error, asyncio.CancelledError):
            reason = 'operation_cancelled'
        elif type(error).__name__ == 'VoiceError' and len(error.args) == 1 and isinstance(error.args[0], str) and error.args[0] in REASONS:
            reason = error.args[0]
        self.failure = {'phase': selected, 'reason': reason,
            'elapsedMs': min(900000, max(0, round((time.monotonic() - self.entered) * 1000)))}

    def snapshot(self):
        return {'phase': self.current, 'failure': dict(self.failure) if self.failure else None, 'counts': dict(self.counts)}
