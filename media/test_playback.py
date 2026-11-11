import asyncio
from datetime import datetime, timedelta, timezone
from server import Session, Service
import unittest
import test_service

class PlaybackTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_service.ServiceTests.asyncSetUp
    asyncTearDown = test_service.ServiceTests.asyncTearDown
    async def create_session(self):
        sid = 'ct_' + 'e' * 40
        session = Session(self.service, {'id': sid, 'meetingId': 'm', 'lineId': 'l'})
        session.active = True
        session.call_id = 'call-1'
        self.service.sessions[sid] = session
        self.service.db.execute('INSERT INTO sessions VALUES(?,?,?)', (sid, 'fingerprint', 'prepared'))
        self.service.db.commit()
        self.policy = {'state': 'listening', 'callId': 'call-1', 'expiresAt': (datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()}
        async def backend(path, body=None):
            return self.policy
        self.service.backend = backend
        self.headers = {'Authorization': 'Bearer ' + 'm'*32}
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.play_count = 0
        async def say(text):
            self.play_count += 1
            self.started.set()
            await self.release.wait()
        session.say = say
        async def close():
            self.service.cancel_speech(sid)
            session.closing = True
        session.close = close
        return session

    async def test_accepts_without_waiting_for_playback_and_deduplicates_until_complete(self):
        s = await self.create_session()
        url = f'/sessions/{s.id}/speak'
        payload = {'id': 'speech-1', 'text': 'We launch Friday.', 'callId': 'call-1'}
        response = await asyncio.wait_for(self.client.post(url, json=payload, headers=self.headers), .5)
        self.assertEqual(response.status, 202)
        self.assertEqual((await response.json())['state'], 'accepted')
        await self.started.wait()
        duplicate = await self.client.post(url, json=payload, headers=self.headers)
        self.assertEqual(duplicate.status, 202)
        self.assertEqual((await duplicate.json())['state'], 'playing')
        self.assertEqual(self.play_count, 1)
        self.release.set()
        await asyncio.sleep(.01)
        status = await self.client.get(f'/sessions/{s.id}/speech/speech-1', headers=self.headers)
        self.assertEqual((await status.json())['state'], 'completed')
        conflict = await self.client.post(url, json={**payload, 'text':'Other'}, headers=self.headers)
        self.assertEqual(conflict.status, 409)
        wrong = await self.client.get('/sessions/ct_'+'f'*40+'/speech/speech-1', headers=self.headers)
        self.assertEqual(wrong.status,404)

    async def test_pause_cancels_accepted_playback_without_replay(self):
        s = await self.create_session()
        body = {'id':'speech-cancel', 'text':'We launch Friday.', 'callId':'call-1'}
        response = await self.client.post(f'/sessions/{s.id}/speak',json=body,headers=self.headers)
        self.assertEqual(response.status,202)
        await asyncio.wait_for(self.started.wait(), .5)
        self.service.cancel_speech(s.id)
        await asyncio.sleep(.01)
        response = await self.client.get(f'/sessions/{s.id}/speech/speech-cancel',headers=self.headers)
        self.assertEqual((await response.json())['state'],'cancelled')
        repeated = await self.client.post(f'/sessions/{s.id}/speak',json=body,headers=self.headers)
        self.assertEqual((await repeated.json())['state'],'cancelled')
        self.assertEqual(self.play_count,1)

    async def test_policy_loss_cancels_speech_and_clears_audio(self):
        from unittest.mock import Mock
        s = await self.create_session()
        s.source = Mock()
        body = {'id':'speech-policy', 'text':'We launch Friday.', 'callId':'call-1'}
        response = await self.client.post(f'/sessions/{s.id}/speak',json=body,headers=self.headers)
        self.assertEqual(response.status,202)
        await asyncio.wait_for(self.started.wait(), .5)
        barrier = asyncio.get_running_loop().create_future()
        s.audio.put_nowait(barrier)
        self.policy = {**self.policy, 'callId':'different-call'}
        watcher = asyncio.create_task(s.watch_policy())
        try:
            await asyncio.sleep(.01)
            self.assertEqual(self.service.speech.get('speech-policy')['state'],'cancelled')
            self.assertTrue(barrier.cancelled())
            s.source.clear_queue.assert_called()
            self.assertFalse(s.allowed)
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def test_restart_retains_completed_receipt_and_marks_inflight_unknown(self):
        self.service.db.execute('INSERT INTO speech(id,session,fingerprint,state) VALUES(?,?,?,?)',('old-done','ct_'+'e'*40,'digest','done'))
        self.service.db.execute('INSERT INTO speech(id,session,fingerprint,state) VALUES(?,?,?,?)',('old-running','ct_'+'e'*40,'digest','running'))
        self.service.db.commit()
        second = Service(self.service.env)
        try:
            self.assertEqual(second.speech.get('old-done')['state'],'completed')
            self.assertEqual(second.speech.get('old-running')['state'],'unknown')
        finally:
            second.db.close()

    async def test_playout_barrier_completes_before_publishing_more_silence(self):
        s = await self.create_session()
        from unittest.mock import Mock
        s.source = Mock()
        sequence = []
        async def capture(frame):
            sequence.append('frame')
        async def playout():
            sequence.append('played')
        s.source.capture_frame = capture
        s.source.wait_for_playout = playout
        barrier = asyncio.get_running_loop().create_future()
        s.audio.put_nowait(bytes(1920))
        s.audio.put_nowait(barrier)
        publisher = asyncio.create_task(s.publish())
        try:
            await asyncio.wait_for(barrier, .3)
            self.assertEqual(sequence[:2], ['frame', 'played'])
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)
