from datetime import datetime,timezone
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock

from screen_diagnostics import ScreenDiagnostics
from server import Service


class ScreenDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_closed_diagnostic_survives_process_state_loss(self):
        with tempfile.TemporaryDirectory() as folder:
            env={'MEDIA_DATABASE_PATH':str(Path(folder)/'media.sqlite')}
            service=Service(env)
            sid='ct_'+'7'*40
            service.db.execute('INSERT INTO sessions VALUES(?,?,?)',(sid,'fixture','closed'))
            diagnostic=ScreenDiagnostics(lambda data: service.record_screen_diagnostic(sid,data))
            diagnostic.phase('notice_playing')
            diagnostic.phase('notice_completed')
            diagnostic.request_result('frame_request',time.monotonic()-1.5,error='timeout')
            diagnostic.phase('stopped','gateway_unavailable')
            diagnostic.phase('closed')
            service.db.close()
            restarted=Service(env)
            try:
                request=AsyncMock();request.match_info={'id':sid}
                response=await restarted.status(request)
                data=json.loads(response.body)
                self.assertFalse(data['alive'])
                self.assertEqual(data['screenDiagnostics']['phase'],'closed')
                self.assertEqual(data['screenDiagnostics']['lastGatewayFailure']['error'],'timeout')
                self.assertEqual(data['screenDiagnostics']['framesReceived'],0)
                self.assertEqual(response.headers['Cache-Control'],'no-store')
            finally: restarted.db.close()

    async def test_only_fixed_categories_and_canonical_timestamps_are_retained(self):
        saved=[]
        diagnostic=ScreenDiagnostics(saved.append)
        with self.assertRaises(ValueError): diagnostic.phase('private-url-or-token')
        with self.assertRaises(ValueError): diagnostic.request_result('frame_request',time.monotonic(),error='private-message')
        diagnostic.frame(datetime.now(timezone.utc).isoformat())
        diagnostic.emitted(screen=True)
        self.assertTrue(saved[-1]['screenVideoObserved'])
        self.assertLess(len(json.dumps(saved[-1])),2048)
        self.assertEqual(saved[-1]['framesReceived'],1)
