"""Authenticated narrow helper relay with durable no-replay reservations."""
import hashlib
import json
import math
import re
import time
from aiohttp import web

ID=re.compile(r'[A-Za-z0-9_-]{1,160}\Z')
HASH=re.compile(r'[a-f0-9]{64}\Z')
def valid_id(v):return isinstance(v,str) and ID.fullmatch(v)
def number(v):return type(v) in (int,float) and math.isfinite(v)
def validate(value,lease,dispatch):
    if not isinstance(value,dict) or set(value)-{'nativeExpiresAt','preparedObservation'}!={'version','operation','fingerprint','binding'} or type(value['version']) is not int or value['version']!=1:raise web.HTTPBadRequest()
    o=value['operation'];b=value['binding']
    if not isinstance(o,dict) or set(o)!={'version','operationId','sceneId','generation','action','window','expected'} or type(o['version']) is not int or o['version']!=1 or not all(valid_id(o[k]) for k in ('operationId','sceneId')) or type(o['generation']) is not int or o['generation']<0 or o['action'] not in ('activate_app','raise_window'):raise web.HTTPBadRequest()
    w=o['window'];e=o['expected']
    if not isinstance(w,dict) or set(w)!={'appId','windowId','ownerPid','displayId'} or w['appId'] not in ('com.apple.finder','com.apple.TextEdit') or not isinstance(w['windowId'],str) or not re.fullmatch('[1-9][0-9]{0,9}',w['windowId']) or int(w['windowId'])>0xffffffff or type(w['ownerPid']) is not int or not 0<w['ownerPid']<=0x7fffffff or type(w['displayId']) is not int or not 0<w['displayId']<=0xffffffff:raise web.HTTPBadRequest()
    if not isinstance(e,dict) or set(e)!={'requestId','sessionId','leaseId','epoch','cursor','policyRevision','displayId'} or not all(valid_id(e[k]) for k in ('requestId','sessionId','leaseId')) or any(type(e[k]) is not int or e[k]<0 for k in ('epoch','cursor','policyRevision','displayId')) or e['epoch']<1 or e['policyRevision']<1 or e['displayId']!=w['displayId']:raise web.HTTPBadRequest()
    if not isinstance(b,dict) or set(b)!={'mediaSessionId','pairingId','deviceId','memberId','expiresAt'} or not all(valid_id(b[k]) for k in ('mediaSessionId','pairingId','deviceId','memberId')) or not number(b['expiresAt']) or not time.time()*1000<b['expiresAt']<=time.time()*1000+20000:raise web.HTTPBadRequest()
    ordered={k:({f:w[f] for f in ('appId','windowId','ownerPid','displayId')} if k=='window' else {f:e[f] for f in ('requestId','sessionId','leaseId','epoch','cursor','policyRevision','displayId')} if k=='expected' else o[k]) for k in ('version','operationId','sceneId','generation','action','window','expected')}
    if value['fingerprint']!=hashlib.sha256(json.dumps(ordered,separators=(',',':'),ensure_ascii=False).encode()).hexdigest():raise web.HTTPConflict()
    if lease.get('protocolVersion')!=2 or lease.get('cameraVersion')!=1 or lease.get('mode')!='view' or lease.get('executor')!='native' or lease.get('surface',{}).get('kind')!='display' or lease.get('surface',{}).get('displayId')!=e['displayId'] or b['deviceId']!=lease['deviceId'] or b['memberId']!=lease['memberId'] or any(lease.get(k)!=e[v] for k,v in (('id','leaseId'),('sessionId','sessionId'),('executorEpoch','epoch'),('policyRevision','policyRevision'),('displayId','displayId'))):raise web.HTTPConflict()
    if dispatch:
        if not number(value.get('nativeExpiresAt')) or not time.time()*1000<value['nativeExpiresAt']<=min(b['expiresAt'],time.time()*1000+2000) or not isinstance(value.get('preparedObservation'),dict):raise web.HTTPConflict()
    elif set(value)!={'version','operation','fingerprint','binding'}:raise web.HTTPBadRequest()
    return hashlib.sha256(json.dumps({k:v for k,v in value.items() if k not in ('nativeExpiresAt','preparedObservation')},sort_keys=True,separators=(',',':')).encode()).hexdigest()

def validate_observation(observed,op,fresh=True):
    if not isinstance(observed,dict) or set(observed)!={'window','processIdentity','observedAt','windowBounds','appActive','windowFocused','windowOnScreen'} or observed['window']!=op['window'] or not isinstance(observed['processIdentity'],str) or not HASH.fullmatch(observed['processIdentity']) or not number(observed['observedAt']) or observed['observedAt']<0 or observed['observedAt']>time.time()*1000+100 or (fresh and observed['observedAt']<time.time()*1000-2000) or any(type(observed[k]) is not bool for k in ('appActive','windowFocused','windowOnScreen')):raise web.HTTPBadGateway()
    b=observed['windowBounds']
    if not isinstance(b,dict) or set(b)!={'x','y','width','height'} or any(not number(v) or abs(v)>65536 for v in b.values()) or b['width']<=0 or b['height']<=0:raise web.HTTPBadGateway()

def validated_result(answer,value):
    op=value['operation'];deadline=value.get('nativeExpiresAt',0)
    if not isinstance(answer,dict) or set(answer)-{'observation','terminalEvidence'}!={'operationId','state','reason'} or answer['operationId']!=op['operationId'] or answer['state'] not in ('rejected','submitted','returned','verified','uncertain') or not isinstance(answer['reason'],str) or not re.fullmatch('[a-z][a-z0-9_]{0,79}',answer['reason']):raise web.HTTPBadGateway()
    if 'observation' in answer:validate_observation(answer['observation'],op,False)
    terminal=answer.get('terminalEvidence')
    if answer['state'] in ('uncertain','submitted'):
        if terminal is not None:raise web.HTTPBadGateway()
        return False
    if not isinstance(terminal,dict) or set(terminal)!={'receiptId','operationId','fingerprint','hostId','completedAt'} or not valid_id(terminal['receiptId']) or terminal['operationId']!=op['operationId'] or terminal['fingerprint']!=value['fingerprint'] or terminal['hostId']!='clawdtime-installed-native' or not number(terminal['completedAt']) or not deadline-2000<=terminal['completedAt']<=(time.time()*1000+1000 if answer['state']=='returned' else min(deadline,time.time()*1000+100)):raise web.HTTPBadGateway()
    if answer['state']=='verified':
        observed=answer.get('observation');prior=value.get('preparedObservation',{})
        if not isinstance(observed,dict) or set(observed)!={'window','processIdentity','observedAt','windowBounds','appActive','windowFocused','windowOnScreen'} or any(observed.get(k)!=prior.get(k) for k in ('window','processIdentity','windowBounds')) or not all(observed.get(k) is True for k in ('appActive','windowFocused','windowOnScreen')) or not number(observed.get('observedAt')) or not deadline-2000<=observed['observedAt']<=terminal['completedAt']+100:raise web.HTTPBadGateway()
    return True

class NativeRelay:
    def __init__(self,gateway):
        self.gateway=gateway;self.busy=set()
        gateway.db.execute('CREATE TABLE IF NOT EXISTS native_activations (id TEXT PRIMARY KEY,lease TEXT NOT NULL,device TEXT NOT NULL,base_hash TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,binding TEXT NOT NULL)')
        gateway.db.execute("UPDATE native_activations SET phase='uncertain' WHERE phase='dispatching'");gateway.db.commit()
    def blocked(self,device):
        return device in self.busy or self.gateway.db.execute("SELECT id FROM native_activations WHERE device=? AND phase IN ('dispatching','uncertain')",(device,)).fetchone() is not None
    async def helper(self,lease,method,suffix,body=None):
        config=self.gateway.devices[lease['deviceId']]
        async with self.gateway.http.request(method,config['url']+f"/v1/leases/{lease['id']}/native/{suffix}",headers={'Authorization':'Bearer '+config['key']},**({'json':body} if body is not None else {}),allow_redirects=False,timeout=2.5) as response:
            raw=await response.content.read(16385)
            if response.status!=200 or len(raw)>16384:raise web.HTTPConflict()
            value=json.loads(raw)
            if not isinstance(value,dict):raise web.HTTPBadGateway()
            return value
    async def post(self,request):
        data=await request.content.read(16385)
        if len(data)>16384:raise web.HTTPBadRequest()
        value=json.loads(data);dispatch=request.match_info['stage']=='dispatch';lease_id=request.match_info['id']
        lease,_,_=self.gateway.active(lease_id);mark=validate(value,lease,dispatch);op=value['operation']['operationId'];device=lease['deviceId']
        row=self.gateway.db.execute('SELECT lease,base_hash,phase,result FROM native_activations WHERE id=?',(op,)).fetchone()
        if row:
            if row[0]!=lease_id or row[1]!=mark:raise web.HTTPConflict()
            if not dispatch:
                if row[2]=='prepared':return web.json_response(json.loads(row[3]))
                raise web.HTTPConflict()
            if dispatch and row[2]!='prepared':return web.json_response(json.loads(row[3]))
        if self.blocked(device) or (dispatch and (not row or row[2]!='prepared' or json.loads(row[3])!=value['preparedObservation'])):raise web.HTTPConflict()
        self.busy.add(device)
        pending={'operationId':op,'state':'uncertain','reason':'native_completion_unknown'}
        try:
            if dispatch:
                self.gateway.db.execute("UPDATE native_activations SET phase='dispatching',result=?,binding=? WHERE id=?",(json.dumps(pending),json.dumps(value),op));self.gateway.db.commit()
            answer=await self.helper(lease,'POST','dispatch' if dispatch else 'prepare',value)
            current,_,_=self.gateway.active(lease_id);validate(value,current,dispatch)
            if dispatch:validated_result(answer,value)
            else:validate_observation(answer,value["operation"])
            self.gateway.db.execute('INSERT OR REPLACE INTO native_activations VALUES (?,?,?,?,?,?,?)',(op,lease_id,device,mark,'uncertain' if dispatch and answer['state'] in ('uncertain','submitted') else 'complete' if dispatch else 'prepared',json.dumps(answer),json.dumps(value)));self.gateway.db.commit()
            return web.json_response(answer,headers={'Cache-Control':'no-store'})
        except BaseException:
            if dispatch:
                self.gateway.db.execute("UPDATE native_activations SET phase='uncertain',result=? WHERE id=?",(json.dumps(pending),op));self.gateway.db.commit();return web.json_response(pending,headers={'Cache-Control':'no-store'})
            raise
        finally:self.busy.discard(device)
    async def get(self,request):
        op=request.match_info['operation'];lease_id=request.match_info['id']
        row=self.gateway.db.execute('SELECT lease,phase,result,binding FROM native_activations WHERE id=?',(op,)).fetchone()
        if not row or row[0]!=lease_id or row[1]=='prepared':raise web.HTTPNotFound()
        if row[1] in ('dispatching','uncertain'):
            lease,_,_,_=self.gateway.lease(lease_id)
            try:
                answer=await self.helper(lease,'GET',op)
                if validated_result(answer,json.loads(row[3])):
                    self.gateway.db.execute("UPDATE native_activations SET phase='complete',result=? WHERE id=?",(json.dumps(answer),op));self.gateway.db.commit();return web.json_response(answer,headers={'Cache-Control':'no-store'})
            except Exception:pass
        return web.json_response(json.loads(row[2]),headers={'Cache-Control':'no-store'})
