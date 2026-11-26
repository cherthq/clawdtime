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


class SpeechCorrelationTests(unittest.TestCase):
    def test_process_scope_correlation_and_reset_prevent_mixed_durations(self):
        now=[10.0];saved=[]
        diagnostic=SpeechDiagnostics('synthetic-session',saved.append,clock=lambda:now[0])
        diagnostic.event('queue_accepted',generation=2,segment=1)
        first_process=diagnostic.process_id
        now[0]=10.2
        diagnostic.event('callback_accepted',generation=2,segment=1)
        diagnostic.flush(force=True)
        first,second=saved[-1]['events']
        self.assertEqual(first['correlationId'],second['correlationId'])
        self.assertGreaterEqual(second['elapsedMs'],199)
        self.assertNotIn('synthetic-session',json.dumps(saved))
        now[0]=1
        diagnostic.event('capture_open',generation=3)
        diagnostic.flush(force=True)
        self.assertNotEqual(first_process,saved[-1]['processId'])
        self.assertEqual(len(saved[-1]['events']),1)
        self.assertEqual(saved[-1]['events'][0]['elapsedMs'],0)
        for bad in ('SECRET', 'f'*25, None):
            if bad is not None:
                with self.assertRaises(ValueError):diagnostic.event('capture_open',correlation_id=bad)
        other=SpeechDiagnostics('synthetic-session',lambda value:None)
        self.assertNotEqual(diagnostic.process_id,other.process_id)


    def test_day_rollover_starts_new_duration_scope(self):
        now=[0.0];saved=[]
        diagnostic=SpeechDiagnostics('fixture',saved.append,clock=lambda:now[0])
        initial=diagnostic.process_id
        now[0]=86400
        diagnostic.event('callback_started',segment=1)
        now[0]+=0.25
        diagnostic.event('callback_accepted',segment=1)
        diagnostic.flush(force=True)
        self.assertNotEqual(initial,saved[-1]['processId'])
        self.assertEqual([event['elapsedMs'] for event in saved[-1]['events']],[0,250])
