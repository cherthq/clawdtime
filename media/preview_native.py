"""Activation-only preview capability. No production fallback actions or input API."""
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid

ID = re.compile(r'[A-Za-z0-9_-]{1,160}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
APPS = frozenset(('com.apple.finder', 'com.apple.TextEdit'))
MAX_LINE = 8192
QUALIFICATION_REASONS = frozenset(('qualification_unavailable','invalid_operation','native_stopped','native_busy',
    'native_request_expired_or_invalid','invalid_request','binding_changed','target_unavailable',
    'accessibility_permission_missing','screen_permission_missing','display_inactive','window_outside_display',
    'session_forced_unavailable','session_missing','session_off_console','session_login_incomplete','session_locked',
    'cg_list_unavailable','cg_list_bound','cg_window_missing','cg_owner_changed','cg_bounds_unavailable','cg_geometry_changed','cg_geometry_ambiguous',
    'app_unavailable','app_terminated','app_bundle_changed','app_launch_identity_unavailable',
    'ax_windows_unavailable','ax_window_bound','ax_read_deadline','ax_title_unavailable','ax_geometry_unavailable',
    'ax_title_changed','ax_minimized_or_unavailable','ax_target_missing','ax_target_ambiguous',
    'broker_authority_shape','broker_authority_binding','broker_authority_expired','broker_authority_unavailable',
    'media_capability_disabled','media_stopped','media_not_started','media_selection_missing','media_lease_retired',
    'media_executor_mismatch','media_session_mismatch','media_lease_mismatch','media_epoch_mismatch','media_epoch_unapplied',
    'media_policy_mismatch','media_display_mismatch','media_display_type_mismatch','media_camera_missing','media_camera_not_live','media_frame_missing',
    'native_transport_unavailable','native_response_unavailable','native_response_mismatch','observation_unavailable',
    'prepared_target_changed','qualification_limit'))

def qualification_reason(value):
    reason=str(value)
    return reason if reason in QUALIFICATION_REASONS else 'qualification_unavailable'


def valid_id(value): return isinstance(value, str) and ID.fullmatch(value) is not None

def integer(value, lower=0, upper=2**53-1): return type(value) is int and lower <= value <= upper


def operation(value):
    if not isinstance(value, dict) or set(value) != {'version','operationId','sceneId','generation','action','window','expected'}:
        raise ValueError('invalid_operation')
    w, a = value['window'], value['expected']
    if (value['version'] != 1 or type(value['version']) is not int or not valid_id(value['operationId'])
        or not valid_id(value['sceneId']) or not integer(value['generation'])
        or value['action'] not in ('activate_app','raise_window') or not isinstance(w,dict)
        or set(w) != {'appId','windowId','ownerPid','displayId'} or w['appId'] not in APPS
        or not isinstance(w['windowId'],str) or not re.fullmatch(r'[1-9][0-9]{0,9}',w['windowId'])
        or int(w['windowId']) > 0xffffffff or not integer(w['ownerPid'],1,0x7fffffff)
        or not integer(w['displayId'],1,0xffffffff) or not isinstance(a,dict)
        or set(a) != {'requestId','sessionId','leaseId','epoch','cursor','policyRevision','displayId'}
        or not all(valid_id(a[k]) for k in ('requestId','sessionId','leaseId'))
        or not integer(a['epoch'],1) or not integer(a['cursor']) or not integer(a['policyRevision'],1)
        or not integer(a['displayId'],1,0xffffffff) or a['displayId'] != w['displayId']): raise ValueError('invalid_operation')
    # Match the shared Zod schema's insertion order for its JSON fingerprint.
    return {k: ({f:w[f] for f in ('appId','windowId','ownerPid','displayId')} if k=='window' else
        {f:a[f] for f in ('requestId','sessionId','leaseId','epoch','cursor','policyRevision','displayId')} if k=='expected' else value[k])
        for k in ('version','operationId','sceneId','generation','action','window','expected')}


def fingerprint(value): return hashlib.sha256(json.dumps(value,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


class NativePreviewController:
    def __init__(self, binary, authority, receipt_path, transport=None):
        self.binary, self.authority = binary, authority
        self.process = None; self.closed = False; self.lock = asyncio.Lock(); self.transport = transport
        self.qualifications={}
        path=Path(receipt_path)
        parent=path.parent.stat()
        if not path.is_absolute() or parent.st_uid!=os.getuid() or stat.S_IMODE(parent.st_mode)&0o077:
            raise ValueError('receipt_directory_not_private')
        descriptor=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            metadata=os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or stat.S_IMODE(metadata.st_mode)&0o077:
                raise ValueError('receipt_file_not_private')
        finally:os.close(descriptor)
        self.db = sqlite3.connect(receipt_path)
        self.db.execute('CREATE TABLE IF NOT EXISTS native_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)')
        self.db.commit()

    async def _authority(self, op):
        if self.closed: raise ValueError('native_stopped')
        result = await self.authority(op)
        if not isinstance(result,dict) or set(result) != set(op['expected'])|{'expiresAt'}:raise ValueError('broker_authority_shape')
        if any(result[k] != v or type(result[k]) is not type(v) for k,v in op['expected'].items()):raise ValueError('broker_authority_binding')
        if (type(result['expiresAt']) not in (float,int) or not math.isfinite(result['expiresAt'])
            or not time.time()*1000 < result['expiresAt'] <= time.time()*1000+2000):raise ValueError('broker_authority_expired')
        if self.closed:raise ValueError('native_stopped')
        return result

    async def _request(self, value):
        if self.closed: raise ValueError('native_stopped')
        if self.transport is not None: return await self.transport(value)
        raw = json.dumps(value,separators=(',',':')).encode()+b'\n'
        if len(raw)>MAX_LINE: raise ValueError('native_request_bound')
        if self.process is None:
            self.process = await asyncio.create_subprocess_exec(self.binary,'--preview-native-executor',
                stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,limit=MAX_LINE+1)
        if self.closed: await self.stop(); raise ValueError('native_stopped')
        self.process.stdin.write(raw)
        await asyncio.wait_for(self.process.stdin.drain(),.2)
        line = await asyncio.wait_for(self.process.stdout.readline(),2.2)
        if self.closed or not line.endswith(b'\n') or len(line)>MAX_LINE: raise ValueError('native_response_unavailable')
        result = json.loads(line)
        if not isinstance(result,dict) or result.get('v')!=1 or result.get('requestId')!=value['requestId']:
            raise ValueError('native_response_mismatch')
        return result

    def _wire(self, op, authority):
        w,a=op['window'],op['expected']
        return {'v':1,'requestId':str(uuid.uuid4()),'op':'qualify','effect':'activate' if op['action']=='activate_app' else 'raise',
            'sessionId':a['sessionId'],'leaseId':a['leaseId'],'executorEpoch':a['epoch'],
            'authorityRequestId':a['requestId'],'cursor':a['cursor'],
            'policyRevision':a['policyRevision'],'displayId':a['displayId'],'expiresAt':authority['expiresAt'],
            'target':{'pid':w['ownerPid'],'bundleId':w['appId'],'windowId':int(w['windowId'])}}

    def _observation(self, value, op):
        if not isinstance(value,dict) or set(value)!={'window','observedAt','processIdentity','windowBounds','appActive','windowFocused','windowOnScreen'}:
            raise ValueError('observation_unavailable')
        bounds=value['windowBounds']; now=time.time()*1000
        if (value['window']!=op['window'] or not valid_id(value['processIdentity'])
            or type(value['observedAt']) not in (float,int) or not now-2000 < value['observedAt'] <= now+100
            or not isinstance(bounds,dict) or set(bounds)!={'x','y','width','height'}
            or any(type(v) not in (float,int) or not math.isfinite(v) or abs(v)>65536 for v in bounds.values())
            or bounds['width']<=0 or bounds['height']<=0
            or any(type(value[k]) is not bool for k in ('appActive','windowFocused','windowOnScreen'))):
            raise ValueError('observation_unavailable')
        return value

    async def _qualify(self, op):
        authority=await self._authority(op); wire=self._wire(op,authority)
        try:result=await self._request(wire)
        except (OSError,asyncio.TimeoutError):raise ValueError('native_transport_unavailable') from None
        if result.get('status')!='qualified' or not valid_id(result.get('targetToken')):
            raise ValueError(qualification_reason(result.get('reason')))
        observation=self._observation(result.get('observation'),op)
        target=result.get('wireTarget')
        if (not isinstance(target,dict) or set(target)!={'pid','bundleId','windowId','titleHash','bounds'}
            or any(target[k]!=wire['target'][k] for k in wire['target'])
            or not isinstance(target['titleHash'],str) or not HASH.fullmatch(target['titleHash'])
            or target['bounds']!=observation['windowBounds']): raise ValueError('target_unavailable')
        return wire,result,observation

    async def qualify(self, value):
        op=operation(value)
        if self.lock.locked(): raise ValueError('native_busy')
        async with self.lock:
            _,_,observed=await self._qualify(op)
            await self._authority(op)
            mark=fingerprint(op);old=self.qualifications.get(op['operationId'])
            if old and (old[0]!=mark or old[1]['processIdentity']!=observed['processIdentity'] or old[1]['windowBounds']!=observed['windowBounds']):
                raise ValueError('prepared_target_changed')
            if not old and len(self.qualifications)>=128:raise ValueError('qualification_limit')
            self.qualifications[op['operationId']]=(mark,observed,time.monotonic())
            return observed

    def receipt(self, operation_id, expected_fingerprint=None):
        row=self.db.execute('SELECT fingerprint,result FROM native_receipts WHERE id=?',(operation_id,)).fetchone()
        if not row:return None
        if expected_fingerprint is not None and row[0]!=expected_fingerprint:raise ValueError('fingerprint_mismatch')
        return json.loads(row[1])

    def _save(self, op, mark, result):
        self.db.execute('INSERT OR REPLACE INTO native_receipts VALUES (?,?,?)',(op['operationId'],mark,json.dumps(result,separators=(',',':'))))
        self.db.commit()

    async def execute(self, value, mark):
        op=operation(value)
        if not isinstance(mark,str) or not HASH.fullmatch(mark) or fingerprint(op)!=mark:raise ValueError('fingerprint_mismatch')
        old=self.receipt(op['operationId'],mark)
        if old is not None:return old
        if self.closed:raise ValueError('native_stopped')
        if self.lock.locked():raise ValueError('native_busy')
        async with self.lock:
            if self.db.execute('SELECT COUNT(*) FROM native_receipts').fetchone()[0]>=128:raise ValueError('receipt_limit')
            result={'operationId':op['operationId'],'state':'uncertain','reason':'dispatch_not_confirmed'}
            self._save(op,mark,result)  # Durable reservation. Any crash/retry preserves unknown.
            attempted=False
            try:
                previous=self.qualifications.get(op['operationId'])
                if not previous or previous[0]!=mark or time.monotonic()-previous[2]>=2:raise ValueError('qualification_unavailable')
                wire,qualified,observation=await self._qualify(op)
                if previous[1]['processIdentity']!=observation['processIdentity'] or previous[1]['windowBounds']!=observation['windowBounds']:
                    raise ValueError('prepared_target_changed')
                authority=await self._authority(op)
                wire.update(op=wire['effect'],requestId=str(uuid.uuid4()),target=qualified['wireTarget'],targetToken=qualified['targetToken'],
                    expiresAt=min(wire['expiresAt'],authority['expiresAt']))
                if self.closed or time.time()*1000>=wire['expiresAt']:raise ValueError('authority_changed')
                # Reservation is committed before this single write; no retry path.
                attempted=True
                native=await self._request(wire)
                state={'rejected':'rejected','submitted':'returned','verified':'verified','unknown':'uncertain'}.get(native.get('status'))
                if state is None or type(native.get('effectAttempted')) is not bool:raise ValueError('native_response_mismatch')
                if native['effectAttempted'] != (state!='rejected'):raise ValueError('native_response_mismatch')
                reason=native.get('reason')
                if not isinstance(reason,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,79}',reason):raise ValueError('native_response_mismatch')
                result={'operationId':op['operationId'],'state':state,'reason':reason}
                if 'observation' in native:
                    fresh=self._observation(native['observation'],op)
                    if fresh['processIdentity']!=observation['processIdentity'] or fresh['windowBounds']!=observation['windowBounds']:
                        raise ValueError('target_changed')
                    result['observation']=fresh
                    if state=='verified' and not all(fresh[k] for k in ('appActive','windowFocused','windowOnScreen')):
                        raise ValueError('verification_unavailable')
                elif state=='verified':raise ValueError('verification_unavailable')
                if self.closed:raise ValueError('native_stopped')
                if state=='uncertain':await self.stop()
                if state!='uncertain':
                    result['terminalEvidence']={'receiptId':str(uuid.uuid4()),'operationId':op['operationId'],'fingerprint':mark,
                        'hostId':'clawdtime-local-native','completedAt':time.time()*1000}
            except BaseException as error:
                if attempted:
                    await self.stop()
                    result={'operationId':op['operationId'],'state':'uncertain','reason':'native_completion_unknown'}
                else:
                    result={'operationId':op['operationId'],'state':'rejected','reason':'preflight_unavailable',
                        'terminalEvidence':{'receiptId':str(uuid.uuid4()),'operationId':op['operationId'],'fingerprint':mark,
                            'hostId':'clawdtime-local-native','completedAt':time.time()*1000}}
                self._save(op,mark,result)
                if isinstance(error,asyncio.CancelledError):raise
            self._save(op,mark,result)
            return result

    async def stop(self):
        self.closed=True
        if self.process and self.process.returncode is None:
            self.process.kill()
            await self.process.wait()
