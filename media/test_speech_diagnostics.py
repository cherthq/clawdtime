"""Bounded metadata telemetry must never become a speech/audio data store."""
import json
import unittest
from unittest.mock import Mock
from speech_diagnostics import SpeechDiagnostics, BOUND


class SpeechDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.now=0
        self.saved=[]
        self.d=SpeechDiagnostics('ct_'+'a'*40,self.saved.append,clock=lambda:self.now)

    def test_throttle_bounded_ring_counts_and_snapshot_independence(self):
        self.d.audio(320,nonzero=True)
        self.d.audio(0,sent=True)
        self.d.flush()
        first=json.dumps(self.saved[0])
        for _ in range(100):
            self.d.event('provider_final',characters=9000,start_ms=1000,endpoint=True)
            self.d.flush()
        self.assertEqual(len(self.saved),1)
        self.now=2
        self.d.flush()
        self.assertEqual(len(self.saved),2)
        latest=self.saved[-1]
        self.assertEqual(len(latest['events']),64)
        self.assertEqual(latest['counts']['provider_final'],100)
        self.assertEqual(latest['counts']['audio_bytes'],320)
        self.assertEqual(latest['counts']['audio_sent_frames'],1)
        self.assertEqual(latest['events'][0]['sequence'],37)
        self.assertEqual(latest['events'][0]['characters'],8001)
        self.assertEqual(json.dumps(self.saved[0]),first)
        self.d.flush(force=True)
        self.assertEqual(len(self.saved),2)  # No writes without changed metadata.

    def test_untrusted_values_cannot_leak_text_or_unbounded_numbers(self):
        for value in ['PRIVATE',float('inf'),float('nan'),-10,True,10**30]:
            self.d.event('provider_interim',generation=value,characters=value,start_ms=value,segment=value)
            self.d.audio(value)
        self.d.update({'phase':'waiting_final','fragments':10**30,'ageMs':10**30,
                       'hasInterim':True,'vadPending':False,'transcript':'PRIVATE'})
        self.d.flush(force=True)
        data=self.saved[-1]
        self.assertNotIn('PRIVATE',json.dumps(data))
        self.assertEqual(data['state']['fragments'],129)
        self.assertEqual(data['state']['ageMs'],86400000)
        self.assertLessEqual(data['counts']['audio_bytes'],BOUND)
        for event,reason in [('PRIVATE',None),('provider_final','PRIVATE')]:
            with self.assertRaises(ValueError):self.d.event(event,reason=reason)
        with self.assertRaises(TypeError):self.d.event('provider_final',transcript='PRIVATE')

    def test_persistence_failure_is_nonfatal_and_error_content_is_not_logged(self):
        self.d.persist=Mock(side_effect=RuntimeError('PRIVATE'))
        self.d.event('capture_open')
        with self.assertLogs(level='INFO') as logs:self.d.flush(force=True)
        self.assertNotIn('PRIVATE',' '.join(logs.output))
        self.assertIn('speech_diagnostic_unavailable',' '.join(logs.output))
