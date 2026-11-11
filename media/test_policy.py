import unittest
from datetime import datetime, timezone
from policy import call_only_allowed, capture_allowed, final_transcript, pause_requested, validate_session_id


class PolicyTests(unittest.TestCase):
    def test_requires_current_call_consent_policy(self):
        now=datetime(2026,11,9,tzinfo=timezone.utc)
        p={'state':'listening','callId':'call','expiresAt':'2026-11-09T01:00:00Z'}
        self.assertTrue(capture_allowed(p,now))
        for patch in [{'state':'paused'},{'state':'requested'},{'callId':None},{'expiresAt':'2026-11-08T00:00:00Z'}]:
            self.assertFalse(capture_allowed({**p,**patch},now))

    def test_call_only_is_explicit_owned_unexpired_and_never_capture(self):
        now=datetime(2026,11,9,tzinfo=timezone.utc)
        p={'callOnly':True,'state':'paused','callId':'call','expiresAt':'2026-11-09T01:00:00Z'}
        self.assertTrue(call_only_allowed(p,now))
        self.assertFalse(capture_allowed(p,now))
        for patch in [{'callOnly':False},{'state':'listening'},{'callId':None},{'expiresAt':'2026-11-08T00:00:00Z'}]:
            self.assertFalse(call_only_allowed({**p,**patch},now))

    def test_only_final_bounded_transcripts(self):
        p={'type':'Results','is_final':True,'channel':{'alternatives':[{'transcript':'We ship Friday.'}]}}
        self.assertEqual(final_transcript(p),'We ship Friday.')
        self.assertIsNone(final_transcript({**p,'is_final':False}))
        self.assertIsNone(final_transcript({'type':'Metadata'}))
        self.assertIsNone(final_transcript({**p,'channel':{'alternatives':[{'transcript':'x'*8001}]}}))

    def test_pause_is_explicit_and_session_identifiers_are_bounded(self):
        self.assertTrue(pause_requested('Hey ClawdTime, pause notes.'))
        self.assertFalse(pause_requested('I might pause notes later'))
        self.assertTrue(validate_session_id('ct_'+'a'*40))
        self.assertFalse(validate_session_id('../../other-room'))


if __name__=='__main__':
    unittest.main()
