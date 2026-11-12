import json
import sqlite3
import unittest
from relay_diagnostics import RelayDiagnostics


class RelayTimingTests(unittest.TestCase):
    def test_stages_are_bounded_and_survive_reopen_without_payload(self):
        db=sqlite3.connect(':memory:')
        diagnostics=RelayDiagnostics(db)
        for index in range(40):
            identity=f'{index:032x}'
            diagnostics.record(identity,'received')
            diagnostics.record(identity,'forwarded',duration=0)
            diagnostics.record(identity,'helper_request')
            diagnostics.record(identity,'helper_response',duration=12)
            diagnostics.record(identity,'response_sent',duration=14,status=200)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM relay_diagnostics').fetchone()[0],128)
        self.assertEqual(diagnostics.pending,{})
        reopened=RelayDiagnostics(db)
        rows=db.execute('SELECT request,phase,duration,status FROM relay_diagnostics WHERE request=?',(identity,)).fetchall()
        self.assertEqual([row[1] for row in rows],['received','forwarded','helper_request','helper_response','response_sent'])
        self.assertEqual(rows[-1],(identity,'response_sent',14,200))
        self.assertNotIn('body',json.dumps(rows))
        db.close()

    def test_late_helper_stage_is_persisted_after_relay_deadline(self):
        db=sqlite3.connect(':memory:')
        diagnostics=RelayDiagnostics(db)
        identity='a'*32
        diagnostics.record(identity,'received')
        diagnostics.record(identity,'helper_request')
        diagnostics.record(identity,'failed',error='timeout')
        diagnostics.record(identity,'response_sent',status=503)
        diagnostics.record(identity,'helper_response',duration=2100)
        self.assertEqual(db.execute('SELECT phase FROM relay_diagnostics').fetchall(),
            [('received',),('helper_request',),('failed',),('response_sent',),('helper_response',)])
        self.assertEqual(diagnostics.pending,{})
        db.close()

    def test_diagnostic_failure_cannot_commit_or_rollback_receipts(self):
        db=sqlite3.connect(':memory:')
        diagnostics=RelayDiagnostics(db)
        db.execute('CREATE TABLE fixture_receipts(id TEXT PRIMARY KEY)')
        db.commit()
        db.execute("INSERT INTO fixture_receipts VALUES('pending')")
        with self.assertLogs('clawdtime.gateway',level='WARNING'):
            diagnostics.record('a'*32,'received')
        self.assertTrue(db.in_transaction)
        self.assertEqual(db.execute('SELECT * FROM fixture_receipts').fetchall(),[('pending',)])
        db.rollback()
        self.assertEqual(db.execute('SELECT * FROM fixture_receipts').fetchall(),[])
        # A failed diagnostic write cleans up only its own partial transaction.
        db.execute("CREATE TRIGGER diagnostic_failure BEFORE DELETE ON relay_diagnostics BEGIN SELECT RAISE(ABORT,'fixture'); END")
        db.commit()
        for index in range(129):diagnostics.record(f'{index:032x}','received')
        self.assertFalse(db.in_transaction)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM relay_diagnostics').fetchone()[0],128)
        db.execute("INSERT INTO fixture_receipts VALUES('next')")
        db.commit()
        self.assertEqual(db.execute('SELECT * FROM fixture_receipts').fetchall(),[('next',)])
        db.close()

    def test_hung_request_retains_received_and_rejects_raw_identifiers(self):
        db=sqlite3.connect(':memory:')
        diagnostics=RelayDiagnostics(db)
        diagnostics.record('a'*32,'received')
        diagnostics.record('a'*32,'forwarded',duration=0)
        diagnostics.record('private-token','received')
        self.assertEqual(db.execute('SELECT phase FROM relay_diagnostics').fetchall(),[('received',)])
        for kwargs in ({'phase':'private'},{'phase':'failed','error':'private'},
                {'phase':'failed','duration':True},{'phase':'failed','status':999}):
            with self.assertRaises(ValueError):diagnostics.record('a'*32,**kwargs)
        diagnostics.record('a'*32,'cancelled',duration=20)
        self.assertEqual(db.execute('SELECT phase FROM relay_diagnostics').fetchall(),[('received',),('forwarded',),('cancelled',)])
        self.assertEqual(diagnostics.pending,{})
        db.close()


class RelayCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_helper_cancellation_flushes_stages_without_retry(self):
        import asyncio
        from pathlib import Path
        import tempfile
        from unittest.mock import AsyncMock
        from service import Gateway
        from relay_diagnostics import request_id
        with tempfile.TemporaryDirectory() as folder:
            gateway=Gateway({'DEVICE_GATEWAY_DATABASE_PATH':str(Path(folder)/'gateway.sqlite')},devices={})
            gateway._helper=AsyncMock(side_effect=asyncio.CancelledError())
            identity='c'*32
            gateway.relay_diagnostics.record(identity,'received')
            context=request_id.set(identity)
            try:
                with self.assertRaises(asyncio.CancelledError):
                    await gateway.helper({},'GET','/fixture/frame',frame=True)
                rows=gateway.db.execute('SELECT phase,error FROM relay_diagnostics ORDER BY sequence').fetchall()
                self.assertEqual(rows,[('received',None),('helper_request',None),('helper_failed','cancelled')])
                self.assertEqual(gateway._helper.await_count,1)
                self.assertEqual(gateway.relay_diagnostics.pending,{})
            finally:
                request_id.reset(context)
                gateway.db.close()
