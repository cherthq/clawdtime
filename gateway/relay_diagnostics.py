"""Bounded metadata for relay-hop diagnosis; never accepts operation payloads."""
from contextvars import ContextVar
from datetime import datetime, timezone
import logging
import re
import time

request_id = ContextVar('clawdtime_relay_request_id', default=None)
PHASES = frozenset(('received', 'forwarded', 'helper_request', 'helper_response',
    'helper_failed', 'response_ready', 'response_sent', 'failed', 'cancelled'))
ERRORS = frozenset(('timeout', 'connection', 'http', 'invalid', 'other', 'closed', 'cancelled'))


def stamp():
    return datetime.now(timezone.utc).isoformat()


class RelayDiagnostics:
    """Last 128 hop events, independent of lease/action receipts and screen data."""
    def __init__(self, db):
        self.db = db
        self.pending = {}
        self.completed = {}
        self.last_warning = float('-inf')
        db.execute('CREATE TABLE IF NOT EXISTS relay_diagnostics(sequence INTEGER PRIMARY KEY,request TEXT,phase TEXT,at TEXT,duration INTEGER,status INTEGER,error TEXT)')
        db.commit()

    def record(self, identity, phase, duration=None, status=None, error=None):
        if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{32}', identity):
            return  # Direct HTTP requests have no relay identity.
        if phase not in PHASES or error is not None and error not in ERRORS:
            raise ValueError('Invalid relay diagnostic category')
        if duration is not None and (type(duration) is not int or not 0 <= duration <= 999999):
            raise ValueError('Invalid relay duration')
        if status is not None and (type(status) is not int or not 100 <= status <= 599):
            raise ValueError('Invalid relay status')
        row=(identity,phase,stamp(),duration,status,error)
        # Two commits per healthy request, not one fsync for every hop. Initial
        # receipt survives a hung handler; completed requests flush their stages.
        if phase == 'received':
            self.completed.pop(identity,None)
            self.pending[identity]=[]
            rows=[row]
        else:
            stages=self.pending.setdefault(identity,[])
            stages.append(row)
            if phase not in ('response_sent','failed','cancelled','helper_failed') and identity not in self.completed:
                if len(self.pending)>16:self.pending.pop(next(iter(self.pending)))
                return
            rows=self.pending.pop(identity)
            if phase in ('response_sent','failed','cancelled'):
                self.completed[identity]=True
                if len(self.completed)>128:self.completed.pop(next(iter(self.completed)))
        # Receipt code owns any existing transaction. Do not commit or roll it
        # back merely to persist optional diagnostics. All operations below are
        # synchronous, so no receipt mutation can interleave with our transaction.
        if self.db.in_transaction:
            self.unavailable();return
        try:
            self.db.executemany('INSERT INTO relay_diagnostics(request,phase,at,duration,status,error) VALUES(?,?,?,?,?,?)',rows)
            self.db.execute('DELETE FROM relay_diagnostics WHERE sequence NOT IN (SELECT sequence FROM relay_diagnostics ORDER BY sequence DESC LIMIT 128)')
            self.db.commit()
        except Exception:
            # Roll back only the transaction we opened, never a receipt's work.
            try:self.db.rollback()
            except Exception:pass
            self.unavailable()

    def unavailable(self):
        now=time.monotonic()
        if now-self.last_warning>=30:
            logging.getLogger('clawdtime.gateway').warning('relay_diagnostic_unavailable')
            self.last_warning=now


def milliseconds(seconds):
    return min(999999, max(0, round(seconds * 1000)))
