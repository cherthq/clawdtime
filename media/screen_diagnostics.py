"""Bounded screen lifecycle metadata. Never accepts pixels, text, URLs or exceptions."""
from datetime import datetime, timezone
import time
import re

PHASES = frozenset(('prepared', 'notice_playing', 'notice_completed', 'waiting_selection',
    'selection_received', 'lease_create', 'lease_renew', 'frame_request', 'viewing',
    'policy_unavailable', 'stopped', 'closed', 'video_unavailable'))
REASONS = frozenset(('authorization_expired', 'previous_release_unconfirmed', 'helper_stopped',
    'gateway_unavailable', 'video_unavailable', 'backend_unavailable', 'policy_removed',
    'frame_unavailable', 'frame_invalid', 'frame_stale', 'frame_dimensions', 'lease_refused'))


def stamp():
    return datetime.now(timezone.utc).isoformat()


class ScreenDiagnostics:
    def __init__(self, persist=None):
        self.persist = persist
        self.last_saved = float('-inf')
        self.data = {'version': 1, 'phase': 'prepared', 'updatedAt': stamp(),
                     'framesReceived': 0, 'videoFramesEmitted': 0}
        self.save(force=True)

    def save(self, force=False):
        now = time.monotonic()
        if self.persist and (force or now-self.last_saved >= 1):
            self.persist(dict(self.data))
            self.last_saved = now

    def phase(self, phase, reason=None, http_status=None, force=False):
        if phase not in PHASES or (reason is not None and reason not in REASONS):
            raise ValueError('Unrecognized screen diagnostic category')
        self.data.update(phase=phase, updatedAt=stamp())
        if phase == 'notice_playing': self.data.setdefault('noticeStartedAt', stamp())
        if phase == 'notice_completed': self.data.setdefault('noticeCompletedAt', stamp())
        if phase == 'selection_received': self.data.setdefault('selectionReceivedAt', stamp())
        if phase == 'lease_create':
            force = force or 'leaseCreateStartedAt' not in self.data
            self.data.setdefault('leaseCreateStartedAt', stamp())
        if phase == 'frame_request':
            force = force or 'firstFrameRequestedAt' not in self.data
            self.data.setdefault('firstFrameRequestedAt', stamp())
        if phase == 'closed': self.data['closedAt'] = stamp()
        if http_status is not None:
            if type(http_status) is not int or not 100 <= http_status <= 599:
                raise ValueError('Invalid screen HTTP status')
            self.data['lastGatewayHTTPStatus'] = http_status
        if reason:
            if phase == 'stopped': self.data['terminalReason'] = reason
            self.data['lastFailure'] = {'phase': phase, 'reason': reason, 'at': stamp(),
                **({'httpStatus': http_status} if http_status is not None else {})}
        self.save(force or bool(reason) or phase in ('notice_playing', 'notice_completed', 'selection_received', 'stopped', 'closed'))

    def frame(self, captured_at):
        # Timestamp validated by the frame receiver; never retain the frame ID or pixels.
        captured_at=datetime.fromisoformat(captured_at.replace('Z','+00:00')).astimezone(timezone.utc).isoformat()
        self.data['framesReceived'] = min(self.data['framesReceived']+1, 999999999)
        self.data.setdefault('firstFrameAt', captured_at)
        self.data['lastFrameAt'] = captured_at
        self.phase('viewing', force=self.data['framesReceived'] == 1)

    def request_result(self,phase,started,http_status=None,error=None,relay=None):
        if phase not in ('lease_create','lease_renew','frame_request'): raise ValueError('Invalid request phase')
        if error not in (None,'timeout','connection','invalid_response','other'): raise ValueError('Invalid request error')
        result={'phase':phase,'at':stamp(),'durationMs':min(999999,max(0,round((time.monotonic()-started)*1000)))}
        if http_status is not None: result['httpStatus']=http_status
        if error: result['error']=error
        if relay is not None:
            if (not isinstance(relay,dict) or set(relay)!={'requestId','phase','startedAt','sendDurationMs','socketConnected'}
                    or not isinstance(relay['requestId'],str) or not re.fullmatch(r'[a-f0-9]{32}',relay['requestId'])
                    or relay['phase'] not in ('send','response') or type(relay['sendDurationMs']) is not int
                    or not 0<=relay['sendDurationMs']<=999999 or type(relay['socketConnected']) is not bool):
                raise ValueError('Invalid relay diagnostic')
            at=datetime.fromisoformat(relay['startedAt'].replace('Z','+00:00'))
            if at.tzinfo is None: raise ValueError('Relay diagnostic requires timezone')
            result['relay']={**relay,'startedAt':at.astimezone(timezone.utc).isoformat()}
        self.data['lastGatewayResult']=result
        if error or (http_status is not None and http_status>=300): self.data['lastGatewayFailure']=result
        self.save(force=bool(error) or (http_status is not None and http_status>=300))

    def emitted(self, screen=False):
        first_screen = screen and self.data.get('screenVideoObserved') is not True
        self.data['videoFramesEmitted'] = min(self.data['videoFramesEmitted']+1, 999999999)
        if screen:
            self.data['screenVideoObserved'] = True
            self.data.setdefault('firstScreenVideoAt', stamp())
            self.data['lastScreenVideoAt'] = stamp()
        self.save(force=first_screen)
