"""Small, bounded duplex admission and speech-onset primitives.

Energy is only an interruption candidate, never recognized text or authority to
execute a command. Duplex additionally requires operator-qualified audio isolation.
"""
from array import array
import math
import sys


def two_way_allowed(policy, env):
    return (env.get('MEDIA_TWO_WAY_VOICE_ENABLED') == 'true'
            and policy.get('protocolVersion') == 2
            and type(policy.get('voiceInteractionVersion')) is int
            and policy.get('voiceInteractionVersion') == 1
            and policy.get('voiceMode') == 'two_way'
            and policy.get('remoteAudioIsolated') is True)


class SpeechOnset:
    """Sustained PCM activity with a quiet rearm interval, constant memory."""
    def __init__(self, rate=48000, threshold=.012, minimum_ms=120, quiet_ms=200):
        if not 8000 <= rate <= 96000 or not .001 <= threshold <= .2:
            raise ValueError('Invalid speech detector calibration')
        if not 80 <= minimum_ms <= 500 or not 100 <= quiet_ms <= 1000:
            raise ValueError('Invalid speech detector timing')
        self.rate, self.threshold = rate, threshold
        self.minimum_ms, self.quiet_ms = minimum_ms, quiet_ms
        self.reset()

    def reset(self):
        self.active_ms = self.silent_ms = 0
        self.triggered = False

    def feed(self, pcm):
        if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > self.rate * 2:
            return False
        samples = array('h', pcm)
        if sys.byteorder != 'little':
            samples.byteswap()
        energy = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
        duration = len(samples) * 1000 / self.rate
        if energy >= self.threshold:
            self.silent_ms = 0
            self.active_ms += duration
            if not self.triggered and self.active_ms >= self.minimum_ms:
                self.triggered = True
                return True
        else:
            self.silent_ms += duration
            self.active_ms = 0
            if self.silent_ms >= self.quiet_ms:
                self.triggered = False
        return False
