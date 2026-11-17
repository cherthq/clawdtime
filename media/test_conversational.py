import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from conversational import AudioTurnGate, DelegationBroker, CommentaryReceipts, document_report_parts, live_allowed, sdk_readiness
from test_two_way_voice import policy


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.replies = []
        self.submit = AsyncMock(return_value={'reply': 'Queued, not complete.', 'sequence': 1,
            'job': {'id': 'job1', 'revision': 1, 'state': 'queued'}})
        self.active = True
        self.broker = DelegationBroker(self.submit, lambda text, identity:self.replies.append((text,identity)),lambda:self.active)

    async def asyncTearDown(self):
        await self.broker.close()

    def delegate(self, identity='d1', pending=''):
        self.broker.delegation(SimpleNamespace(id=identity,mode='client',pending_transcript=pending))

    def final(self, identity='u1', text='Create the fixture', final=True):
        self.broker.transcript(SimpleNamespace(item_id=identity,transcript=text,is_final=final))

    async def settle(self):
        await asyncio.gather(*list(self.broker.tasks))

    def turn(self, text='Create the fixture', item='u1', delegation='d1'):
        self.final(item, text, final=False)
        self.delegate(delegation, pending=text)
        self.final(item, text)

    async def test_delegation_metadata_and_partial_transcript_never_execute(self):
        self.final(text='Final', final=False)
        self.delegate(pending='Final')
        self.final(text='Final instruction', final=False)
        self.submit.assert_not_called()
        self.final(text='Final instruction')
        await self.settle()
        self.assertEqual(self.submit.call_count,1)
        self.assertEqual(self.submit.call_args.args[1],'Final instruction')
        self.assertEqual(self.replies[0][0],'Queued, not complete.')

    async def test_repeated_final_or_delegation_does_not_submit_twice(self):
        self.turn();await self.settle()
        self.delegate();self.final();self.delegate('d2',pending='');await self.settle()
        self.assertEqual(self.submit.call_count,1)

    async def test_identical_new_turn_is_not_wording_deduplicated(self):
        self.turn();await self.settle()
        self.turn(item='u2',delegation='d2');await self.settle()
        self.assertEqual(self.submit.call_count,2)

    async def test_submissions_keep_speech_order_without_blocking_event_loop(self):
        release=asyncio.Event()
        calls=[]
        async def submit(identity,text):
            calls.append(text)
            if text=='slow':await release.wait()
            return {'reply':text,'sequence':1 if text=='slow' else 2,
                    **({'job':{'id':'job1','revision':1,'state':'queued'}} if text=='slow' else {})}
        self.broker.submit=submit
        self.turn(text='slow');await asyncio.sleep(0)
        self.turn(text='status',item='u2',delegation='d2');await asyncio.sleep(0)
        self.assertEqual(calls,['slow'])
        self.assertEqual(len(self.broker.tasks),2)
        release.set();await self.settle()
        self.assertEqual(calls,['slow','status'])
        self.assertEqual(self.replies,[('status','d2')])
        self.assertIn('job1',self.broker.jobs)

    async def test_job_state_requires_current_revision_and_verified_success(self):
        self.turn();await self.settle();self.replies.clear()
        self.broker.update_jobs([{'id':'job1','revision':1,'state':'succeeded'}])
        self.assertEqual(self.replies,[])
        self.broker.update_jobs([{'id':'job1','revision':2,'state':'succeeded','result':{'verification':{'verified':True}}}])
        self.assertEqual(self.replies,[])
        self.assertEqual(self.broker.jobs,{})

    async def test_document_catalog_preview_and_transfer_use_only_authoritative_report(self):
        reports = [
            'Candidates: One.docx and Two.pages. Choose a document.',
            'First-page preview is ready for Two.pages.',
            'The provider accepted Two.pages. Delivery is unconfirmed.',
        ]
        for report in reports:
            with self.subTest(report=report):
                self.broker.jobs={'doc':('delegation',1,'running')}
                self.replies.clear()
                self.broker.update_jobs([{'id':'doc','kind':'document','revision':1,'state':'succeeded',
                    'report':report,'result':{'summary':'WRONG: delivered and read.',
                    'verification':{'verified':True}}}])
                self.assertEqual(len(self.replies),1)
                self.assertIn(report,self.replies[0][0])
                self.assertNotIn('WRONG',self.replies[0][0])
                self.assertEqual(self.broker.jobs,{})

    async def test_document_report_cannot_bypass_verification_revision_or_hold(self):
        job={'id':'doc','kind':'document','revision':1,'state':'succeeded',
             'report':'Preview ready.','result':{'verification':{'verified':True}}}
        self.broker.jobs={'doc':('delegation',1,'running')}
        self.broker.update_jobs([{**job,'result':{}}])
        self.assertEqual(self.replies,[])
        for report in (None,'','x'*1201):
            self.broker.update_jobs([{**job,'report':report}])
        self.assertEqual(self.replies,[])
        self.broker.unadjudicated=True;self.broker.update_jobs([job])
        self.assertEqual(self.replies,[])
        self.broker.unadjudicated=False
        self.broker.update_jobs([{**job,'revision':2}])
        self.assertEqual(self.replies,[])
        self.assertEqual(self.broker.jobs,{})

    def test_unicode_document_report_is_not_silently_truncated_by_provider_byte_cap(self):
        report='文件'*600
        parts=document_report_parts(report)
        self.assertLessEqual(len(parts),12)
        self.assertTrue(all(len(part.encode('utf-8'))<=480 for part in parts))
        self.assertEqual(''.join(part.split(': ',1)[1] for part in parts),report)

    async def test_delivery_timeout_is_unknown_and_is_never_retried(self):
        self.submit.side_effect=TimeoutError()
        self.turn();await self.settle()
        self.assertIn('unconfirmed',self.replies[0][0])
        self.delegate();self.final();await self.settle()
        self.assertEqual(self.submit.call_count,1)

    async def test_delegation_cannot_consume_other_speech_item_with_same_prefix(self):
        self.final('old',text='Open settings')
        self.final('current',text='Open',final=False)
        self.delegate(pending='Open')
        await asyncio.sleep(0)
        self.submit.assert_not_called()
        self.final('unrelated',text='Open another app')
        self.submit.assert_not_called()
        self.final('current',text='Open the fixture')
        await self.settle()
        self.submit.assert_not_called()
        self.turn(text='Open the fixture',item='clarified',delegation='clarified-delegation')
        await self.settle()
        self.assertEqual(self.submit.call_args.args[1],'Open the fixture')

    async def test_new_partial_holds_old_job_result_until_final_adjudication(self):
        self.turn();await self.settle();self.replies.clear()
        self.final('correction',text='Actually',final=False)
        job={'id':'job1','revision':1,'state':'succeeded','result':{'verification':{'verified':True}}}
        self.broker.update_jobs([job])
        self.assertEqual(self.replies,[])
        self.final('correction',text='Actually what is its status')
        self.broker.update_jobs([job])
        self.assertEqual(self.replies,[])
        self.delegate('status')
        await self.settle()
        self.assertFalse(self.broker.unadjudicated)

    async def test_unbound_or_stale_delegation_requires_clarification(self):
        self.delegate(pending='Unobserved text')
        self.final(text='Unobserved text')
        self.broker.final_at-=6
        self.delegate('late')
        await self.settle()
        self.submit.assert_not_called()

    def test_provider_receipts_distinguish_ack_error_and_unknown_without_payloads(self):
        now=[0.]
        receipts=CommentaryReceipts(lambda:now[0])
        for identity in ('one','two','three'):
            receipts.queued({'type':'session.commentary.append','event_id':identity,'content':'PRIVATE'})
        now[0]=.123
        receipts.received({'type':'session.commentary.appended','client_event_id':'one'})
        receipts.received({'type':'error','error':{'client_event_id':'two','message':'PRIVATE'}})
        now[0]=31
        receipts.expire()
        self.assertEqual(receipts.snapshot(),{'version':1,'queued':3,'acknowledged':1,'rejected':1,'unknown':1,'pending':0,'lastAckMs':123})
        self.assertNotIn('PRIVATE',str(receipts.__dict__))

    async def test_revocation_prevents_results_and_discards_context(self):
        self.active=False;self.delegate();self.final();await self.settle()
        self.submit.assert_not_called()
        await self.broker.close()
        self.assertIsNone(self.broker.final)

    def test_admission_requires_provider_and_qualified_audio(self):
        p=policy(conversationVersion=1,conversationFrontend='gpt_live')
        e={'MEDIA_TWO_WAY_VOICE_ENABLED':'true','MEDIA_GPT_LIVE_ENABLED':'true','OPENAI_API_KEY':'test-only'}
        self.assertTrue(live_allowed(p,e))
        self.assertFalse(live_allowed(p,{**e,'OPENAI_API_KEY':''}))
        self.assertFalse(live_allowed({**p,'remoteAudioIsolated':False},e))
        self.assertFalse(live_allowed({**p,'conversationVersion':2},e))
        self.assertIn('available',sdk_readiness())

    def test_public_context_is_bounded_and_excludes_tools_and_duplicate_final(self):
        from conversational import GPTLiveFrontend
        frontend=GPTLiveFrontend(SimpleNamespace())
        frontend.agent=SimpleNamespace(chat_ctx=SimpleNamespace(items=[
            SimpleNamespace(role='user',text_content='old'*1000),
            SimpleNamespace(role='tool',text_content='private tool payload'),
            SimpleNamespace(role='assistant',text_content='Which display?'),
            SimpleNamespace(role='user',text_content='Display seven'),
        ]))
        value=frontend.context('Display seven')
        self.assertEqual(value[-1],{'role':'assistant','text':'Which display?'})
        self.assertLessEqual(sum(len(item['text']) for item in value),3000)
        self.assertNotIn('private tool',str(value))
        self.assertNotIn('Display seven',str(value))


class SettledAudioTurnTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = ConversationTests.asyncTearDown
    settle = ConversationTests.settle

    async def asyncSetUp(self):
        await ConversationTests.asyncSetUp(self)
        self.gate = AudioTurnGate(self.broker)

    def speech(self, identity, text, final=False):
        self.gate.transcript(SimpleNamespace(item_id=identity, transcript=text, is_final=final))

    def quiet(self, frames=50):
        for _ in range(frames): self.gate.audio(bytes(1920))

    async def test_sdk_final_during_audible_speech_does_not_submit_fragment(self):
        self.speech('one', 'Create', True)
        for _ in range(70): self.gate.audio(b'\x00\x10'*960)
        await asyncio.sleep(0)
        self.submit.assert_not_called()
        self.speech('two', 'the fixture', True)
        self.quiet(49)
        self.submit.assert_not_called()
        self.quiet(1); await self.settle()
        self.assertEqual(self.submit.call_args.args[1], 'Create the fixture')
        self.assertIsNone(self.replies[0][1])

    async def test_final_and_measured_quiet_both_required_and_changes_restart_window(self):
        self.speech('one', 'Create', False); self.quiet(100)
        self.submit.assert_not_called()
        self.speech('one', 'Create the fixture', True); self.quiet(49)
        self.submit.assert_not_called()
        await asyncio.sleep(.01)  # Wall time has no authority to release this hold.
        self.submit.assert_not_called()
        self.quiet(1); await self.settle()
        self.assertEqual(self.submit.call_count, 1)

    async def test_late_final_aggregates_without_duplicating_effect(self):
        self.speech('one', 'Create', False)
        self.speech('two', 'the fixture', True)
        self.quiet(50)
        self.submit.assert_not_called()
        self.speech('one', 'Create', True); await self.settle()
        self.assertEqual(self.submit.call_args.args[1], 'Create the fixture')
        self.speech('one', 'Create', True)
        self.speech('two', 'the fixture', True); self.quiet(100)
        await self.settle()
        self.assertEqual(self.submit.call_count, 1)

    async def test_trailing_nondelegated_chat_gets_adjudicated_then_verified_report(self):
        self.speech('task', 'Create fixture', True); self.quiet(); await self.settle()
        self.replies.clear()
        self.speech('chat', 'Thank you', True)
        job={'id':'job1','revision':1,'state':'succeeded','result':{'verification':{'verified':True}}}
        self.broker.update_jobs([job]); self.assertEqual(self.replies, [])
        self.submit.return_value={'reply':'You are welcome.', 'sequence':2}
        self.quiet(); await self.settle()
        self.broker.update_jobs([job])
        self.assertEqual(self.submit.call_count, 2)
        self.assertEqual(self.submit.call_args.args[1], 'Thank you')
        self.assertIn('verified result', self.replies[-1][0])
        self.assertFalse(self.broker.unadjudicated)

    async def test_new_correction_supersedes_inflight_response_and_holds_completion(self):
        release=asyncio.Event()
        async def submit(*args):
            await release.wait()
            return {'reply':'Queued', 'sequence':1,'job':{'id':'job1','revision':1,'state':'queued'}}
        self.broker.submit=submit
        self.speech('task', 'Create fixture', True); self.quiet(); await asyncio.sleep(0)
        self.gate.audio(b'\x00\x10'*960)
        self.speech('correction', 'Actually cancel', False)
        release.set(); await self.settle()
        self.assertEqual(self.replies, [])
        job={'id':'job1','revision':1,'state':'succeeded','result':{'verification':{'verified':True}}}
        self.broker.update_jobs([job]); self.assertEqual(self.replies, [])
        self.broker.submit=AsyncMock(return_value={'reply':'Canceled.', 'sequence':2,
            'job':{'id':'job1','revision':2,'state':'canceled'}})
        self.speech('correction', 'Actually cancel', True); self.quiet(); await self.settle()
        self.broker.update_jobs([job])
        self.assertEqual(self.replies, [('Canceled.',None)])

    async def test_quiet_stays_quiet_and_audio_without_text_does_not_cancel_work(self):
        self.speech('task', 'Create fixture', True); self.quiet(); await self.settle()
        self.submit.return_value={'reply':'', 'sequence':2, 'quiet':True}
        self.speech('quiet', 'Be quiet', True); self.quiet(); await self.settle()
        self.replies.clear()
        job={'id':'job1','revision':1,'state':'succeeded','result':{'verification':{'verified':True}}}
        self.broker.update_jobs([job]); self.assertEqual(self.replies, [])
        self.assertIn('job1',self.broker.jobs)
        self.submit.return_value={'reply':'Listening.', 'sequence':3}
        self.speech('resume','Thanks',True);self.quiet();await self.settle();self.replies.clear()
        self.gate.audio(b'\x00\x10'*960)
        self.broker.update_jobs([job]);self.assertEqual(self.replies,[])
        self.quiet();self.broker.update_jobs([job])
        self.assertIn('verified result',self.replies[-1][0])

    async def test_revoked_audio_does_not_settle_pending_text(self):
        self.speech('one','Create fixture',True);self.active=False;self.quiet()
        await self.settle();self.submit.assert_not_called()
        await self.broker.close();self.gate.clear()
        self.assertEqual(self.gate.parts,{})

class VoiceAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile
        from pathlib import Path
        from server import Service, Session
        self.tmp=tempfile.TemporaryDirectory()
        self.service=Service({'MEDIA_DATABASE_PATH':str(Path(self.tmp.name)/'media.sqlite')})
        self.session=Session(self.service,{'id':'ct_'+'b'*40,'meetingId':'request'})
        self.service.sessions[self.session.id]=self.session
        self.service.backend=AsyncMock(return_value=policy(conversationVersion=1,conversationFrontend='gpt_live'))
        self.session.activate=AsyncMock(return_value={'activated':True})

    async def asyncTearDown(self):
        self.service.db.close();self.tmp.cleanup()

    def request(self, action='activate'):
        return SimpleNamespace(match_info={'id':self.session.id,'action':action},json=AsyncMock(return_value={'callId':'owned-call'}))

    async def test_absent_sdk_key_or_audio_gate_refuses_before_activation(self):
        from aiohttp import web
        with self.assertRaises(web.HTTPServiceUnavailable):await self.service.action(self.request())
        self.session.activate.assert_not_called()

    async def test_legacy_active_call_cannot_upgrade_voice_owner_in_place(self):
        from aiohttp import web
        from unittest.mock import patch
        self.service.env.update(MEDIA_GPT_LIVE_ENABLED='true',MEDIA_TWO_WAY_VOICE_ENABLED='true',OPENAI_API_KEY='synthetic')
        self.session.activation=asyncio.get_running_loop().create_future()
        with patch('server.sdk_readiness',return_value={'available':True}):
            with self.assertRaises(web.HTTPConflict):await self.service.action(self.request())
        self.session.activate.assert_not_called()
        self.session.activation.cancel()

    async def test_activation_reports_actual_frontend_and_never_failed_or_legacy_mode(self):
        import json
        from unittest.mock import patch
        self.service.env.update(MEDIA_GPT_LIVE_ENABLED='true',MEDIA_TWO_WAY_VOICE_ENABLED='true',OPENAI_API_KEY='synthetic')
        with patch('server.sdk_readiness',return_value={'available':True}):
            response=await self.service.action(self.request())
        self.assertEqual(json.loads(response.body),{'activated':True,'conversationFrontend':'gpt_live'})
        self.session.live_frontend=None
        self.service.backend.return_value=policy()
        response=await self.service.action(self.request())
        self.assertEqual(json.loads(response.body),{'activated':True})
        self.service.backend.return_value=policy(conversationVersion=1,conversationFrontend='gpt_live')
        self.session.activate.side_effect=RuntimeError('Synthetic startup failure')
        with patch('server.sdk_readiness',return_value={'available':True}):
            with self.assertRaises(RuntimeError):await self.service.action(self.request())

    async def test_live_frontend_is_the_only_speech_owner(self):
        from aiohttp import web
        self.session.live_frontend=SimpleNamespace()
        with self.assertRaises(web.HTTPConflict):await self.service.action(self.request('speak'))
        self.assertEqual(self.service.speech_tasks,{})
