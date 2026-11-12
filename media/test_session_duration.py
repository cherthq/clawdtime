"""Session age never extends authority; fresh policy controls active calls."""
import asyncio
from datetime import datetime, timedelta, timezone
import time
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from server import Session


class SessionDurationTests(IsolatedAsyncioTestCase):
    def session(self, active, age):
        owner=SimpleNamespace(env={},cancel_speech=lambda sid: None)
        session=Session(owner,{'id':'ct_'+'a'*40,'meetingId':'fixture'})
        session.active=active
        session.call_id='owned-call'
        session.born=time.monotonic()-age
        session.stop_stt=AsyncMock()
        session.fail=AsyncMock()
        session.close=AsyncMock()
        return session

    async def one_policy(self, session, policy):
        async def backend(path):
            # One actual policy-loop iteration without sleeping or provider I/O.
            session.closing=True
            session.policy_wakeup.set()
            return policy
        session.owner.backend=AsyncMock(side_effect=backend)
        await session.watch_policy()

    def policy(self, state='listening', age=-20):
        return {'callId':'owned-call','state':state,
            'expiresAt':(datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat()}

    async def test_healthy_active_call_beyond_55_minutes_uses_fresh_policy(self):
        session=self.session(True,56*60)
        await self.one_policy(session,self.policy())
        session.fail.assert_not_awaited()
        session.close.assert_not_awaited()
        session.owner.backend.assert_awaited_once()
        self.assertTrue(session.allowed)

    async def test_unactivated_session_still_fails_after_120_seconds(self):
        session=self.session(False,121)
        await self.one_policy(session,self.policy())
        session.fail.assert_awaited_once_with('activation_timeout','deadline')
        session.owner.backend.assert_not_awaited()
        self.assertFalse(session.allowed)

    async def test_old_active_call_closes_when_backend_policy_ends(self):
        session=self.session(True,56*60)
        await self.one_policy(session,self.policy('ended'))
        session.close.assert_awaited_once_with('policy_ended')
        self.assertFalse(session.allowed)
        session.fail.assert_not_awaited()

    async def test_old_call_with_expired_policy_stops_capture_without_age_override(self):
        session=self.session(True,56*60)
        session.allowed=True
        await self.one_policy(session,self.policy(age=1))
        self.assertFalse(session.allowed)
        session.stop_stt.assert_awaited_once()
        session.fail.assert_not_awaited()

    async def test_old_call_cannot_override_local_stop_with_fresh_policy(self):
        session=self.session(True,56*60)
        session.pause_latched=True
        session.priority_stop_id='1'
        session.seen_pause=True
        await self.one_policy(session,self.policy())
        self.assertFalse(session.allowed)
        self.assertTrue(session.pause_latched)
        session.stop_stt.assert_awaited_once()
