"""Default-off production activation. Backend, relay and helper all retain receipts.
No path creates a lease, extends a deadline, retries input, or arms the Mac.
"""
import asyncio
import hashlib
import json
import math
import time
from aiohttp import web
from devices import gateway_request
from preview_native import operation, fingerprint, valid_id, HASH, NativePreviewController


# Clock difference allowed between the media service and the gateway.
DISPATCH_SKEW_MS=2000


def observation(value,op,fresh=True):
    if fresh:return NativePreviewController._observation(None,value,op)
    if not isinstance(value,dict) or set(value)!={'window','observedAt','processIdentity','windowBounds','appActive','windowFocused','windowOnScreen'} or value.get('window')!=op['window'] or not valid_id(value.get('processIdentity')) or type(value.get('observedAt')) not in (int,float) or not math.isfinite(value['observedAt']) or value['observedAt']<0 or value['observedAt']>time.time()*1000+100:raise ValueError('observation_unavailable')
    b=value['windowBounds']
    if not isinstance(b,dict) or set(b)!={'x','y','width','height'} or any(type(v) not in (int,float) or not math.isfinite(v) or abs(v)>65536 for v in b.values()) or b['width']<=0 or b['height']<=0 or any(type(value[k]) is not bool for k in ('appActive','windowFocused','windowOnScreen')):raise ValueError('observation_unavailable')
    return value


def envelope(value, dispatch=False):
    if not isinstance(value,dict) or set(value)-{'nativeExpiresAt','preparedObservation'}!={'version','operation','fingerprint','binding'} or type(value['version']) is not int or value['version']!=1:raise ValueError('invalid_native_envelope')
    op=operation(value['operation']);b=value['binding'];now=time.time()*1000
    if value['fingerprint']!=fingerprint(op) or not isinstance(b,dict) or set(b)!={'mediaSessionId','pairingId','deviceId','memberId','expiresAt'} or not all(valid_id(b[k]) for k in ('mediaSessionId','pairingId','deviceId','memberId')) or type(b['expiresAt']) not in (int,float) or not math.isfinite(b['expiresAt']) or not now<b['expiresAt']<=now+20000:raise ValueError('invalid_native_binding')
    if dispatch:
        expiry=value.get('nativeExpiresAt')
        if type(expiry) not in (int,float) or not math.isfinite(expiry) or not now<expiry<=min(b['expiresAt'],now+2000):raise ValueError('native_expired')
        observation(value.get('preparedObservation'),op,False)
    elif set(value)!={'version','operation','fingerprint','binding'}:raise ValueError('invalid_native_prepare')
    return value


def base_hash(value):
    return hashlib.sha256(json.dumps({k:v for k,v in value.items() if k not in ('nativeExpiresAt','preparedObservation')},sort_keys=True,separators=(',',':')).encode()).hexdigest()


def result(value, env, fresh=True):
    if not isinstance(value,dict) or set(value)-{'terminalEvidence','observation'}!={'operationId','state','reason'} or value['operationId']!=env['operation']['operationId'] or value['state'] not in ('rejected','submitted','returned','verified','uncertain') or not isinstance(value['reason'],str) or not __import__('re').fullmatch('[a-z][a-z0-9_]{0,79}',value['reason']):raise ValueError('native_receipt_invalid')
    terminal=value.get('terminalEvidence')
    if value['state'] not in ('uncertain','submitted'):
        if not isinstance(terminal,dict) or set(terminal)!={'receiptId','operationId','fingerprint','hostId','completedAt'} or not valid_id(terminal['receiptId']) or terminal['operationId']!=value['operationId'] or terminal['fingerprint']!=env['fingerprint'] or terminal['hostId']!='clawdtime-installed-native' or type(terminal['completedAt']) not in (int,float) or not math.isfinite(terminal['completedAt']) or not env.get('nativeExpiresAt',0)-2000<=terminal['completedAt']<=(time.time()*1000+1000 if value['state']=='returned' else min(env.get('nativeExpiresAt',0),time.time()*1000+100)):raise ValueError('native_terminal_invalid')
    elif terminal is not None:raise ValueError('native_terminal_invalid')
    if value['state']=='verified':
        observed=observation(value.get('observation'),env['operation'],fresh)
        prior=env.get('preparedObservation',{})
        if not all(observed[k] for k in ('appActive','windowFocused','windowOnScreen')) or any(observed.get(k)!=prior.get(k) for k in ('window','processIdentity','windowBounds')):raise ValueError('native_target_changed')
    return value


class ProductionNative:
    def __init__(self,owner):
        self.owner=owner;self.busy=set()
        owner.db.execute('CREATE TABLE IF NOT EXISTS native_activation_receipts (id TEXT PRIMARY KEY,device TEXT NOT NULL,binding TEXT NOT NULL,base_hash TEXT NOT NULL,phase TEXT NOT NULL,result TEXT)')
        owner.db.execute("UPDATE native_activation_receipts SET phase='uncertain' WHERE phase='dispatching'");owner.db.commit()
    def guard(self,sid,value):
        session=self.owner.sessions.get(sid);e=value['operation']['expected'];b=value['binding']
        if self.owner.env.get('CLAWDTIME_NATIVE_ACTIVATION_ENABLED')!='true' or b['mediaSessionId']!=sid or not session or not session.active or session.closing or not session.screen:raise ValueError('native_unavailable')
        screen=session.screen;screen.expire();s=screen.selection
        if screen.closed or not s or s['leaseId'] in screen.stopped or s.get('protocolVersion')!=2 or s.get('cameraVersion')!=1 or s.get('executor')!='native' or s.get('mode')!='view' or s.get('surface',{}).get('kind')!='display' or screen.applied_lease!=e['leaseId'] or screen.applied_epoch!=e['epoch'] or any(s.get(k)!=e[v] for k,v in (('sessionId','sessionId'),('leaseId','leaseId'),('executorEpoch','epoch'),('policyRevision','policyRevision'),('displayId','displayId'))) or s.get('deviceId')!=b['deviceId'] or s.get('memberId')!=b['memberId'] or not screen.camera or screen.camera.status()['state']!='live' or screen.frame is None:raise ValueError('native_authority_changed')
        if time.time()*1000>=value.get('nativeExpiresAt',b['expiresAt']):raise ValueError('native_expired')
        return session
    async def authority(self,sid,value):
        self.guard(sid,value)
        async with asyncio.timeout(max(0,(value.get('nativeExpiresAt',value['binding']['expiresAt'])-time.time()*1000)/1000)):
            answer=await self.owner.backend(f'/media/{sid}/native-activation-authority',{'envelope':value})
        self.guard(sid,value)
        if answer!=value:raise ValueError('native_authority_changed')
    def key(self,sid,op):return sid+'/'+op
    async def run(self,sid,value,dispatch):
        envelope(value,dispatch);key=self.key(sid,value['operation']['operationId']);mark=base_hash(value);device=value['binding']['deviceId']
        old=self.owner.db.execute('SELECT base_hash,phase,result FROM native_activation_receipts WHERE id=?',(key,)).fetchone()
        if old and old[0]!=mark:raise ValueError('native_id_conflict')
        if old and not dispatch:
            if old[1]=='prepared':return json.loads(old[2])
            raise ValueError('native_operation_retired')
        if old and dispatch and old[1] in ('dispatching','uncertain','complete'):
            if old[2]:return json.loads(old[2])
            return {'operationId':value['operation']['operationId'],'state':'uncertain','reason':'native_completion_unknown'}
        if device in self.busy or self.owner.db.execute("SELECT id FROM native_activation_receipts WHERE device=? AND phase IN ('dispatching','uncertain')",(device,)).fetchone():raise ValueError('native_unresolved')
        if dispatch and (not old or old[1]!='prepared' or json.loads(old[2])!=value['preparedObservation']):raise ValueError('native_preparation_changed')
        self.guard(sid,value);self.busy.add(device)
        pending={'operationId':value['operation']['operationId'],'state':'uncertain','reason':'native_completion_unknown'}
        marked=False
        try:
            # A refused authority sends nothing, so it leaves the row prepared.
            await self.authority(sid,value)
            if dispatch:
                self.owner.db.execute("UPDATE native_activation_receipts SET phase='dispatching',binding=?,result=? WHERE id=?",(json.dumps(value),json.dumps(pending),key));self.owner.db.commit();marked=True
            status,raw,_=await gateway_request(self.owner,'POST',f"/v1/leases/{value['operation']['expected']['leaseId']}/native/"+('dispatch' if dispatch else 'prepare'),value,device=device)
            if status!=200 or len(raw)>16384:raise ValueError('native_helper_unavailable')
            answer=json.loads(raw)
            if dispatch:result(answer,value)
            else:NativePreviewController._observation(None,answer,value['operation'])
            await self.authority(sid,value)
            self.owner.db.execute('INSERT OR REPLACE INTO native_activation_receipts VALUES (?,?,?,?,?,?)',(key,device,json.dumps(value),mark,'uncertain' if dispatch and answer['state'] in ('uncertain','submitted') else 'complete' if dispatch else 'prepared',json.dumps(answer)));self.owner.db.commit()
            return answer
        except BaseException:
            if marked:
                self.owner.db.execute("UPDATE native_activation_receipts SET phase='uncertain',result=? WHERE id=?",(json.dumps(pending),key));self.owner.db.commit();return pending
            raise
        finally:self.busy.discard(device)
    async def receipt(self,sid,op,mark):
        row=self.owner.db.execute('SELECT binding,phase,result FROM native_activation_receipts WHERE id=?',(self.key(sid,op),)).fetchone()
        if not row:raise web.HTTPNotFound()
        value=json.loads(row[0])
        if value['fingerprint']!=mark:raise web.HTTPConflict()
        if row[1] in ('dispatching','uncertain'):
            # Read-only reconciliation does not require a surviving call object.
            try:
                status,raw,_=await gateway_request(self.owner,'GET',f"/v1/leases/{value['operation']['expected']['leaseId']}/native/{op}",device=value['binding']['deviceId'])
                if status==200:
                    answer=result(json.loads(raw),value,False)
                    if answer['state'] not in ('uncertain','submitted'):
                        self.owner.db.execute("UPDATE native_activation_receipts SET phase='complete',result=? WHERE id=?",(json.dumps(answer),self.key(sid,op)));self.owner.db.commit();return answer
                elif status==404 and time.time()*1000>value.get('nativeExpiresAt',math.inf)+DISPATCH_SKEW_MS:
                    # The gateway records a dispatch before it sends one and refuses
                    # one after its deadline. No record after the deadline proves
                    # that the dispatch was never sent.
                    answer={'operationId':op,'state':'rejected','reason':'native_not_dispatched'}
                    self.owner.db.execute("UPDATE native_activation_receipts SET phase='complete',result=? WHERE id=?",(json.dumps(answer),self.key(sid,op)));self.owner.db.commit();return answer
            except Exception:pass
        if row[1]=='prepared':raise web.HTTPConflict()
        return json.loads(row[2])


def routes(owner,app):
    host=ProductionNative(owner);owner.native_activation=host
    async def post(request):
        try:
            data=await request.content.read(16385)
            if len(data)>16384:raise ValueError()
            answer=await host.run(request.match_info['id'],json.loads(data),request.match_info['stage']=='dispatch')
            return web.json_response(answer,headers={'Cache-Control':'no-store'})
        except Exception:return web.json_response({'error':'native_activation_unavailable'},status=409)
    async def get(request):
        return web.json_response(await host.receipt(request.match_info['id'],request.match_info['operation'],request.query.get('fingerprint','')),headers={'Cache-Control':'no-store'})
    app.router.add_post('/sessions/{id}/screen/native/{stage:prepare|dispatch}',post)
    app.router.add_get('/sessions/{id}/screen/native/receipts/{operation}',get)
