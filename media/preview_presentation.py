"""Prepared, read-only target presentation. Never grants or dispatches OS input."""
import asyncio
import hashlib
import json
import math
import time
import uuid

from camera import CameraError, annotation, rect
from preview_native import APPS, HASH, QUALIFICATION_REASONS, NativePreviewController, integer, valid_id

REASONS=QUALIFICATION_REASONS|frozenset(('target_not_foreground','presentation_stopped','presentation_busy',
    'invalid_presentation','presentation_fingerprint_mismatch','presentation_authority_unavailable',
    'presentation_target_changed','presentation_frame_unavailable','presentation_bracket_changed',
    'presentation_camera_changed','presentation_transaction_refused','presentation_completion_unknown',
    'presentation_resolver_unavailable','presentation_resolver_busy','presentation_witness_expired'))


def safe_reason(error):
    value=str(error)
    return value if value in REASONS else 'presentation_authority_unavailable'


def validate(value):
    required={'version','commandId','planId','sceneId','generation','window','focus','processIdentity','expected'}
    if not isinstance(value,dict) or not required<=set(value) or set(value)-required-{'annotation'}:raise ValueError('invalid_presentation')
    if type(value['version']) is not int or value['version']!=1 or not all(valid_id(value[k]) for k in ('commandId','planId','sceneId','processIdentity')) or not integer(value['generation']):raise ValueError('invalid_presentation')
    # The activation contract supplies identical window and authority validation;
    # this capability additionally permits owner-none epoch zero, never effects.
    expected=value['expected']
    if not isinstance(expected,dict) or not integer(expected.get('epoch')):raise ValueError('invalid_presentation')
    from preview_native import operation
    operation({'version':1,'operationId':value['commandId'],'sceneId':value['sceneId'],'generation':value['generation'],
        'action':'activate_app','window':value['window'],'expected':{**expected,'epoch':max(1,expected['epoch'])}})
    focus=value['focus']
    if not isinstance(focus,dict) or set(focus)!={'rect','durationMs'} or not integer(focus['durationMs'],0,1500):raise ValueError('invalid_presentation')
    rect(focus['rect'])
    if 'annotation' in value:
        mark=value['annotation']
        if not isinstance(mark,dict) or not {'kind'}<=set(mark) or set(mark)-{'kind','text'}:raise ValueError('invalid_presentation')
        annotation({**mark,'id':'validate','rect':focus['rect'],'ttlMs':3000})
    return json.loads(json.dumps(value))


def argument_hash(value):
    # Local same-ID comparison only; broker supplies the cross-language hash.
    def normalize(item):
        if isinstance(item,dict):return {k:normalize(v) for k,v in item.items()}
        if isinstance(item,list):return [normalize(v) for v in item]
        if type(item) is float and item.is_integer():return int(item)
        return item
    return hashlib.sha256(json.dumps(normalize(value),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def target_rect(window, relative, source):
    x,y,w,h=(window[k] for k in ('x','y','width','height'))
    ox,oy,sw,sh=(source[k] for k in ('originX','originY','pointWidth','pointHeight'))
    if not (ox<=x and oy<=y and x+w<=ox+sw and y+h<=oy+sh):raise ValueError('presentation_target_changed')
    return rect({'x':(x+relative['x']*w-ox)/sw,'y':(y+relative['y']*h-oy)/sh,
        'width':relative['width']*w/sw,'height':relative['height']*h/sh})


class ReadOnlyResolver:
    def __init__(self,binary):self.binary=binary;self.process=None;self.closed=False;self.lock=asyncio.Lock()
    async def resolve(self,presentation,authority,timeout=1.5):
        if self.closed or self.lock.locked():raise ValueError('presentation_resolver_unavailable')
        async with self.lock:
            a=authority;w=presentation['window'];request_id=str(uuid.uuid4())
            value={'v':1,'requestId':request_id,'op':'resolve','sessionId':a['sessionId'],'leaseId':a['leaseId'],
                'authorityRequestId':a['requestId'],'processIdentity':presentation['processIdentity'],'epoch':a['epoch'],
                'cursor':a['cursor'],'policyRevision':a['policyRevision'],'displayId':a['displayId'],'expiresAt':a['expiresAt'],
                'target':{'pid':w['ownerPid'],'bundleId':w['appId'],'windowId':int(w['windowId'])}}
            raw=json.dumps(value,separators=(',',':')).encode()+b'\n'
            if len(raw)>8192:raise ValueError('invalid_presentation')
            try:
                if self.process is None:
                    self.process=await asyncio.create_subprocess_exec(self.binary,'--preview-presentation-resolver',stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,limit=8193)
                if self.closed:raise ValueError('presentation_stopped')
                self.process.stdin.write(raw);await asyncio.wait_for(self.process.stdin.drain(),.1)
                line=await asyncio.wait_for(self.process.stdout.readline(),timeout)
                if self.closed or len(line)>8192 or not line.endswith(b'\n'):raise ValueError('presentation_resolver_unavailable')
                result=json.loads(line)
                if not isinstance(result,dict) or result.get('v')!=1 or result.get('requestId')!=request_id:raise ValueError('presentation_resolver_unavailable')
                if result.get('status')!='resolved':raise ValueError(safe_reason(result.get('reason')))
                return result.get('observation')
            except BaseException:
                await self.close();raise
    async def close(self):
        self.closed=True
        if self.process and self.process.returncode is None:
            try:self.process.kill()
            except ProcessLookupError:pass
            await self.process.wait()


class LivePresentationController:
    def __init__(self,screen,binary,authority,local_guard,db,resolver_factory=ReadOnlyResolver,receipt_namespace=''):
        self.screen=screen;self.binary=binary;self.authority=authority;self.local_guard=local_guard;self.db=db;self.factory=resolver_factory
        self.closed=False;self.lock=asyncio.Lock();self.source=None;self.monitor=None;self.active=None
        self.receipt_namespace=receipt_namespace+'/' if receipt_namespace else ''
        self.db.execute('CREATE TABLE IF NOT EXISTS presentation_receipts (id TEXT PRIMARY KEY, arguments TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL)');self.db.commit()
    def receipt(self,command_id,mark=None,args=None):
        row=self.db.execute('SELECT arguments,fingerprint,result FROM presentation_receipts WHERE id=?',(self.receipt_namespace+command_id,)).fetchone()
        if not row:return None
        if (mark is not None and row[1]!=mark) or (args is not None and row[0]!=args):raise ValueError('presentation_fingerprint_mismatch')
        return json.loads(row[2])
    def save(self,value,args,mark,result):
        self.db.execute('INSERT OR REPLACE INTO presentation_receipts VALUES (?,?,?,?)',(self.receipt_namespace+value['commandId'],args,mark,json.dumps(result,separators=(',',':'))));self.db.commit()
    def checked_authority(self,value,mark,result):
        if self.closed:raise ValueError('presentation_stopped')
        self.local_guard(value)
        expected=value['expected']
        if (not isinstance(result,dict) or set(result)!=set(expected)|{'expiresAt','fingerprint'}
            or any(result[k]!=v or type(result[k]) is not type(v) for k,v in expected.items())
            or result['fingerprint']!=mark or type(result['expiresAt']) not in (int,float)
            or not math.isfinite(result['expiresAt']) or not time.time()*1000<result['expiresAt']<=time.time()*1000+2000):raise ValueError('presentation_authority_unavailable')
        self.local_guard(value)
        if self.closed:raise ValueError('presentation_stopped')
        return dict(result)
    async def authorized(self,value,mark):
        if self.closed:raise ValueError('presentation_stopped')
        self.local_guard(value)
        return self.checked_authority(value,mark,await self.authority(value))
    def timing(self,stage,started,error=None):
        diagnostics=getattr(self.screen,'diagnostics',None)
        if diagnostics:diagnostics.presentation_result(stage,started,error)
    async def timed(self,stage,pending,timeout=None):
        started=time.monotonic();error=None
        try:
            return await pending if timeout is None else await asyncio.wait_for(pending,timeout)
        except BaseException as failure:
            error='timeout' if isinstance(failure,TimeoutError) else 'cancelled' if isinstance(failure,asyncio.CancelledError) else 'refused'
            raise
        finally:self.timing(stage,started,error)
    def observation(self,raw,value,previous=None):
        observed=NativePreviewController._observation(None,raw,{'window':value['window']})
        if (observed['processIdentity']!=value['processIdentity'] or not all(observed[k] for k in ('appActive','windowFocused','windowOnScreen'))
            or (previous and (previous['processIdentity']!=observed['processIdentity'] or previous['windowBounds']!=observed['windowBounds']))):raise ValueError('presentation_target_changed')
        return observed
    async def retire(self):
        if self.active:
            camera,command_id=self.active;camera.invalidate_target_scope(command_id);self.active=None
        source=self.source;self.source=None
        if source:await source.close()
        task=self.monitor;self.monitor=None
        if task and task is not asyncio.current_task():task.cancel();await asyncio.gather(task,return_exceptions=True)
    async def present(self,raw,mark):
        value=validate(raw);args=argument_hash(value)
        if not isinstance(mark,str) or not HASH.fullmatch(mark):raise ValueError('presentation_fingerprint_mismatch')
        old=self.receipt(value['commandId'],mark,args)
        if old is not None:return old
        if self.closed:raise ValueError('presentation_stopped')
        if self.lock.locked():raise ValueError('presentation_busy')
        async with self.lock:
            if self.db.execute('SELECT COUNT(*) FROM presentation_receipts WHERE substr(id,1,?)=?',(len(self.receipt_namespace),self.receipt_namespace)).fetchone()[0]>=128:raise ValueError('qualification_limit')
            result={'version':1,'commandId':value['commandId'],'state':'uncertain','reason':'presentation_completion_unknown','fingerprint':mark,'receiptId':str(uuid.uuid4())}
            self.save(value,args,mark,result)
            committed=False
            try:
                async with asyncio.timeout(4):
                    authority=await self.timed('initial_authority',self.authorized(value,mark))
                    await self.retire()
                    source=self.factory(self.binary);self.source=source
                    first=self.observation(await self.timed('first_resolve',source.resolve(value,authority)),value)
                    self.local_guard(value)
                    until=time.monotonic()+1.2
                    while True:
                        self.local_guard(value);camera=self.screen.camera
                        if camera and camera.status()['capturedAt'] is not None and camera.status()['capturedAt']>=first['observedAt']:break
                        if self.closed or time.monotonic()>=until:raise ValueError('presentation_frame_unavailable')
                        await asyncio.sleep(.01)
                    async with self.screen.frame_lock:
                        self.local_guard(value);camera=self.screen.camera;generation=self.screen.generation
                        before=camera.status()
                        second=self.observation(await self.timed('second_resolve',source.resolve(value,authority,timeout=.2)),value,first)
                        authority=await self.timed('final_authority',self.authorized(value,mark),.15)
                        self.local_guard(value);after=camera.status()
                        if self.closed or self.screen.camera is not camera or self.screen.generation!=generation or any(before[k]!=after[k] for k in ('revision','sourceFrameId','geometryGeneration','contentRevision')):raise ValueError('presentation_camera_changed')
                        if (not first['observedAt']<=after['capturedAt']<=second['observedAt']
                            or time.time()*1000-first['observedAt']>=2000):raise ValueError('presentation_bracket_changed')
                        confirmed=time.monotonic()-(time.time()*1000-second['observedAt'])/1000
                        if not 0<=time.monotonic()-confirmed<=.25:raise ValueError('presentation_witness_expired')
                        mapped=target_rect(second['windowBounds'],value['focus']['rect'],after['source'])
                        state=camera.present_target(value['commandId'],mapped,value.get('annotation'),value['focus']['durationMs'],confirmed)
                        committed=True;self.active=(camera,value['commandId'])
                        result.update(state='accepted',reason='target_presentation_applied',observation=second,
                            camera={k:state[k] for k in ('revision','sourceFrameId','geometryGeneration','contentRevision','capturedAt')})
                    self.save(value,args,mark,result)
                    self.monitor=asyncio.create_task(self.watch(value,mark,source,camera,second,authority))
                    return result
            except BaseException as error:
                await self.retire()
                result.update(state='uncertain' if committed else 'rejected',reason='presentation_completion_unknown' if committed else safe_reason(error))
                result.pop('camera',None);result.pop('observation',None)
                self.save(value,args,mark,result)
                if isinstance(error,asyncio.CancelledError):raise
                return result
    async def watch(self,value,mark,source,camera,previous,authority):
        try:
            while not self.closed and self.source is source:
                began=time.monotonic()
                camera.expire_target_scope()
                if not camera.target_scope or camera.target_scope['commandId']!=value['commandId']:return
                async with asyncio.timeout(.2):
                    # The previous successful post-read callback may authorize
                    # only another read. Preserve its exact absolute expiry and
                    # binding; never reuse it to renew or publish targeting.
                    self.checked_authority(value,mark,authority)
                    observed=self.observation(await self.timed('monitor_resolve',source.resolve(value,authority,timeout=.18)),value,previous)
                    renewed_authority=await self.timed('monitor_authority',self.authorized(value,mark))
                    self.local_guard(value)
                    confirmed=time.monotonic()-(time.time()*1000-observed['observedAt'])/1000
                    if self.screen.camera is not camera or not camera.renew_target_scope(value['commandId'],confirmed):
                        self.timing('monitor_cycle',began,'refused');return
                    authority=renewed_authority
                self.timing('monitor_cycle',began)
                await asyncio.sleep(max(0,.1-(time.monotonic()-began)))
        except (Exception,asyncio.CancelledError) as error:
            self.timing('monitor_cycle',began,'timeout' if isinstance(error,TimeoutError) else 'cancelled' if isinstance(error,asyncio.CancelledError) else 'refused')
        finally:
            camera.invalidate_target_scope(value['commandId'])
            await source.close()
            if self.source is source:self.source=None
            if self.active and self.active[1]==value['commandId']:self.active=None
    async def stop(self):
        self.closed=True;await self.retire()
