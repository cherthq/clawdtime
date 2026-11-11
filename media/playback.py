"""Durable utterance receipts. Interrupted output is never automatically replayed."""
from datetime import datetime, timezone

TERMINAL = {'completed', 'cancelled', 'failed', 'unknown'}


class SpeechLedger:
    def __init__(self, db):
        self.db = db
        columns = {r[1] for r in db.execute('PRAGMA table_info(speech)')}
        for name in ('updated_at', 'reason'):
            if name not in columns:
                db.execute(f'ALTER TABLE speech ADD COLUMN {name} TEXT')
        # Old receipts used done/running. Completion remains durable; no active
        # process can still own accepted or playing speech after a restart.
        db.execute("UPDATE speech SET state='completed' WHERE state='done'")
        db.execute("UPDATE speech SET state='unknown', reason='service_interrupted' WHERE state IN ('running','accepted','playing')")
        db.commit()

    def get(self, utterance_id):
        row = self.db.execute('SELECT id,session,fingerprint,state,updated_at,reason FROM speech WHERE id=?', (utterance_id,)).fetchone()
        return dict(zip(('id','sessionId','fingerprint','state','updatedAt','reason'), row)) if row else None

    def accept(self, utterance_id, session_id, fingerprint):
        self.db.execute('INSERT INTO speech(id,session,fingerprint,state,updated_at) VALUES(?,?,?,?,?)',
                        (utterance_id, session_id, fingerprint, 'accepted', datetime.now(timezone.utc).isoformat()))
        self.db.commit()
        return self.get(utterance_id)

    def set(self, utterance_id, state, reason=None):
        self.db.execute('UPDATE speech SET state=?,reason=?,updated_at=? WHERE id=?',
                        (state, reason, datetime.now(timezone.utc).isoformat(), utterance_id))
        self.db.commit()

    @staticmethod
    def public(receipt):
        return {k:v for k,v in receipt.items() if k != 'fingerprint'}
