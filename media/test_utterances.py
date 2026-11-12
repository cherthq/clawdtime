"""Deterministic provider-event replay; no microphone, network provider or call."""
import unittest
from utterances import UtteranceAssembler


def result(text, start=0, duration=1, final=True, boundary=False):
    return {'type':'Results', 'start':start, 'duration':duration,
            'is_final':final, 'speech_final':boundary,
            'channel':{'alternatives':[{'transcript':text}]}}


class UtteranceTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.a = UtteranceAssembler(clock=lambda:self.now)

    def advance(self, seconds):
        self.now += seconds
        return self.a.take_ready()

    def test_three_stable_fragments_become_one_request(self):
        self.a.feed(result('Open Messages',0,1))
        self.assertIsNone(self.advance(.2))
        self.a.feed(result('and send hello',1,1))
        self.assertIsNone(self.advance(.2))
        self.a.feed(result('to the test group.',2,1,boundary=True))
        self.assertIsNone(self.advance(.59))
        merged=self.advance(.02)
        self.assertEqual(merged['text'],'Open Messages and send hello to the test group.')
        self.assertEqual(merged['fragments'],3)
        self.assertIsNone(self.advance(1))
        self.a.feed(result('to the test group.',2,1,boundary=True))
        self.assertIsNone(self.advance(1))

    def test_mid_thought_pause_resumes_and_does_not_emit_early(self):
        self.a.feed(result('Send hello',boundary=True))
        self.assertIsNone(self.advance(.4))
        self.a.feed({'type':'SpeechStarted'})
        self.a.feed(result('to the',1,1,final=False))
        self.assertIsNone(self.advance(1))
        self.a.feed(result('to the other group.',1,2,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Send hello to the other group.')

    def test_utterance_end_is_fallback_but_cannot_finalize_new_interim_speech(self):
        self.a.feed(result('First part',0,1))
        self.a.feed(result('unfinished correction',1,1,final=False))
        self.a.feed({'type':'UtteranceEnd','last_word_end':1})
        self.assertIsNone(self.advance(2))
        self.a.feed(result('finished correction',1,1))
        self.a.feed({'type':'UtteranceEnd','last_word_end':2})
        self.assertEqual(self.advance(.61)['text'],'First part finished correction')

    def test_empty_boundary_flushes_final_text_and_interim_never_executes(self):
        self.a.feed(result('provisional yes',final=False,boundary=True))
        self.assertIsNone(self.advance(1))
        self.a.feed(result('Actually no',boundary=False))
        self.a.feed(result('',1,.5,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Actually no')

    def test_duplicate_final_segment_and_earlier_boundary_do_not_repeat_text(self):
        event=result('Keep this',0,1)
        self.a.feed(event);self.a.feed(event)
        self.a.feed(result('and this',1,1))
        self.a.feed({'type':'UtteranceEnd','last_word_end':1})
        self.assertIsNone(self.advance(1))
        self.a.feed({'type':'UtteranceEnd','last_word_end':2})
        self.assertEqual(self.advance(.61)['text'],'Keep this and this')

    def test_duplicate_boundary_cannot_end_new_speech_before_its_interim_arrives(self):
        event = result('Send hello',boundary=True)
        self.a.feed(event)
        self.advance(.3)
        self.a.feed({'type':'SpeechStarted'})
        self.a.feed(event)
        self.assertIsNone(self.advance(1))
        self.a.feed(result('to the other group',1,1,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Send hello to the other group')

    def test_reset_discards_incomplete_text_and_new_generation_can_restart_timestamps(self):
        self.a.feed(result('Never send this',boundary=True))
        self.a.reset()
        self.assertIsNone(self.advance(1))
        self.a.feed(result('New request',boundary=True))
        self.assertEqual(self.advance(.61)['text'],'New request')

    def test_utterance_end_uses_word_end_not_trailing_audio_silence(self):
        event = result('Complete request',0,2)
        event['channel']['alternatives'][0]['words'] = [{'word':'request','end':1.3}]
        self.a.feed(event)
        self.a.feed({'type':'UtteranceEnd','last_word_end':1.3})
        self.assertEqual(self.advance(.61)['text'],'Complete request')

    def test_empty_final_after_vad_or_retracted_interim_does_not_stick_or_execute_prefix(self):
        self.a.feed(result('Send hello',0,1))
        self.a.feed({'type':'SpeechStarted'})
        self.a.feed(result('unless',1,1,final=False))
        self.a.feed(result('',1,1,boundary=True))
        rejected = self.advance(.61)
        self.assertTrue(rejected['discarded'])
        self.assertEqual(rejected['text'],'')
        self.assertFalse(self.a.busy)
        self.a.feed({'type':'SpeechStarted'})
        self.a.feed(result('',2,1,boundary=True))
        self.assertIsNone(self.advance(.61))  # Noise alone is not an utterance.
        self.assertFalse(self.a.busy)

    def test_overlong_utterance_is_discarded_not_truncated_into_an_action(self):
        self.a.feed(result('x'*8001,boundary=True))
        rejected=self.advance(.61)
        self.assertTrue(rejected['discarded']);self.assertEqual(rejected['text'],'')
        self.a.feed(result('Long incomplete request',2,1))
        self.assertIsNone(self.advance(31))
        self.a.feed(result('last part',3,1,boundary=True))
        self.assertTrue(self.advance(.61)['discarded'])
        self.a.feed(result('Fresh request',4,1,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Fresh request')

    def test_no_provider_boundary_means_no_action_and_memory_is_bounded(self):
        for n in range(150):
            self.a.feed(result('part',n,1))
        self.assertIsNone(self.advance(31))
        self.assertLessEqual(len(self.a.seen),128)
        self.assertEqual(self.a.parts,[])

    def test_malformed_events_are_ignored(self):
        for event in [None,[],{}, {'type':'Results'}, {'type':'UtteranceEnd','last_word_end':float('nan')}]:
            self.a.feed(event)
        self.assertFalse(self.a.busy)
        self.assertIsNone(self.advance(1))

    def test_final_can_shrink_the_previous_interim_audio_window(self):
        self.a.feed(result('provisional request',0,4.3,final=False))
        self.a.feed(result('Final request',0,3.26,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Final request')

    def test_vad_noise_and_empty_final_do_not_erase_finalized_words(self):
        self.a.feed(result('A complete request',0,1,boundary=True))
        self.advance(.2)
        self.a.feed({'type':'SpeechStarted','timestamp':1.2})
        self.a.feed(result('',1,1,boundary=True))
        delivered = self.advance(.61)
        self.assertFalse(delivered['discarded'])
        self.assertEqual(delivered['text'],'A complete request')

    def test_orphan_vad_cannot_poison_the_next_real_request(self):
        self.a.feed({'type':'SpeechStarted','timestamp':0})
        self.assertIsNone(self.advance(31))
        self.a.feed(result('Fresh complete request',32,1,boundary=True))
        delivered = self.advance(.61)
        self.assertFalse(delivered['discarded'])
        self.assertEqual(delivered['text'],'Fresh complete request')

    def test_short_final_preserves_known_provisional_tail_until_next_final(self):
        interim = result('provisional first and second',0,4.3,final=False)
        interim['channel']['alternatives'][0]['words'] = [{'end':4.1}]
        self.a.feed(interim)
        self.a.feed(result('First',0,3.26))
        self.a.feed({'type':'UtteranceEnd','last_word_end':3.26})
        self.assertIsNone(self.advance(1))
        self.a.feed(result('second',3.26,2.24,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'First second')

    def test_old_final_cannot_clear_new_region_interim(self):
        self.a.feed(result('new region',2,1,final=False))
        self.a.feed(result('Earlier',0,1,boundary=True))
        self.assertIsNone(self.advance(2))
        self.a.feed(result('new region',2,1,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Earlier new region')

    def test_repeated_empty_boundaries_do_not_restart_settle_window(self):
        self.a.feed(result('Complete',boundary=True))
        self.advance(.4)
        self.a.feed(result('',1,.1,boundary=True))
        self.assertEqual(self.advance(.21)['text'],'Complete')

    def test_duplicate_final_can_upgrade_boundary_without_duplicating_words(self):
        self.a.feed(result('Complete'))
        self.a.feed(result('Complete',boundary=True))
        self.assertEqual(self.advance(.61)['text'],'Complete')

    def test_noise_grace_expires_without_final_or_new_utterance(self):
        self.a.feed({'type':'SpeechStarted','timestamp':0})
        self.assertEqual(self.a.snapshot()['phase'],'vad_grace')
        self.advance(1.51)
        self.assertFalse(self.a.busy)
        self.assertEqual(self.a.snapshot()['phase'],'idle')

    def test_boundary_after_timeout_discards_then_recovers(self):
        self.a.feed(result('Unfinished',final=False))
        self.advance(31)
        self.assertEqual(self.a.snapshot()['phase'],'quarantined')
        self.a.feed(result('Late final',boundary=True))
        self.assertEqual(self.advance(.61)['reason'],'duration_limit')
        self.a.feed(result('New request',2,1,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'New request')

    def test_malformed_numeric_metadata_does_not_crash_or_execute_interim(self):
        for value in [float('inf'),float('nan'),10**1000,-1,True,'PRIVATE',{},[]]:
            self.a.reset()
            self.a.feed({'type':'SpeechStarted','timestamp':value})
            event=result('Synthetic provisional',value,value,final=False)
            event['channel']['alternatives'][0]['words']=[{'end':value}]
            self.a.feed(event)
            self.a.feed({'type':'UtteranceEnd','last_word_end':value})
            self.assertIsNone(self.advance(2))

    def test_old_empty_endpoint_cannot_finalize_a_later_fragment(self):
        self.a.feed(result('First',0,1))
        self.a.feed(result('second',1,1))
        self.a.feed(result('',0,1,boundary=True))
        self.assertIsNone(self.advance(1))
        self.a.feed(result('',2,1,boundary=True))
        self.assertEqual(self.advance(.61)['text'],'First second')
