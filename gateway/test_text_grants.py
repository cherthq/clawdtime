from datetime import datetime, timedelta, timezone
import unittest
from aiohttp import web
from service import validate_lease
from relay import PATH


def lease(**changes):
    return {'id':'lease','deviceId':'device','memberId':'member','displayId':7,'mode':'control',
        'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat(),
        'protocolVersion':3,'sessionId':'session','executorEpoch':1,'policyRevision':1,'executor':'clawdtime',
        'authority':{'kind':'text_session','grantId':'grant','projectId':'/tmp/synthetic-project'},**changes}


class TextGrantTests(unittest.TestCase):
    def test_text_lease_is_separate_from_call_authority(self):
        self.assertEqual(len(validate_lease(lease())),64)
        for changes in ({'callId':'fake'}, {'protocolVersion':2}, {'authority':None},
                        {'authority':{'kind':'call','grantId':'grant','projectId':'/tmp/synthetic-project'}}):
            with self.assertRaises(web.HTTPBadRequest):validate_lease(lease(**changes))

    def test_old_call_wire_does_not_accept_new_authority(self):
        old=lease(protocolVersion=2,callId='call')
        old.pop('authority')
        self.assertEqual(len(validate_lease(old)),64)
        old.pop('callId')
        with self.assertRaises(web.HTTPBadRequest):validate_lease(old)

    def test_only_bounded_grant_routes_are_relayable(self):
        for path in ('/v1/devices/device/text-grants','/v1/devices/device/text-grants/grant'):
            self.assertIsNotNone(PATH.fullmatch(path))
        for path in ('/v1/devices/device/text-grants/grant/approve','/v1/devices/device/text-grants/../status'):
            self.assertIsNone(PATH.fullmatch(path))

    def test_text_receipt_requires_exact_authority_and_never_call_id(self):
        import sqlite3
        from types import SimpleNamespace
        from service import Gateway
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE actions(id TEXT PRIMARY KEY,state TEXT,receipt TEXT)')
        db.execute("INSERT INTO actions VALUES('action','accepted',NULL)")
        owner=SimpleNamespace(db=db)
        body=lease()
        receipt={'id':'action','leaseId':'lease','deviceId':'device','memberId':'member',
            'authority':body['authority'],'sessionId':'session','executorEpoch':1,
            'policyRevision':1,'protocolVersion':3,'state':'submitted'}
        Gateway.record_receipt(owner,body,'action',receipt)
        self.assertEqual(db.execute('SELECT state FROM actions').fetchone()[0],'submitted')
        for change in ({'callId':None},{'sessionId':'other'}, {'authority':{**body['authority'],'grantId':'other'}}, {'executorEpoch':0}):
            with self.assertRaises(ValueError):Gateway.record_receipt(owner,body,'action',{**receipt,**change})
        db.close()
