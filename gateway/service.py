"""Private Tailscale relay. Only operator-registered helper origins are reachable.

Lease/action metadata is durable; frames are never cached or persisted. Unknown
creation or input outcomes are not retried. Local stop requires a fresh lease ID.
"""
import asyncio
from datetime import datetime, timezone
import hashlib
import hmac
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, web
from relay_diagnostics import RelayDiagnostics, request_id, milliseconds

ID = re.compile(r'^[A-Za-z0-9_-]{1,160}$')
MAX_FRAME = 2 * 1024 * 1024


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Invalid time')
    parsed=datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:raise ValueError('Time requires an offset')
    return parsed.timestamp()


def valid_origin(value):
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Use a bare helper origin')
    if parsed.scheme == 'https' and parsed.hostname:
        return value.rstrip('/')
    if parsed.scheme == 'http':
        ip = ipaddress.ip_address(parsed.hostname)
        if ip.is_loopback or ip in ipaddress.ip_network('100.64.0.0/10'):
            return value.rstrip('/')
    raise ValueError('Helper must use HTTPS or a loopback/Tailscale IP')


def validate_lease(body):
    required={'id','deviceId','memberId','callId','displayId','mode','expiresAt'}
    authority={'protocolVersion','sessionId','executorEpoch','policyRevision','executor'}
    if not isinstance(body, dict) or set(body) not in (required,required|authority):
        raise web.HTTPBadRequest()
    if any(not isinstance(body[k], str) or not ID.fullmatch(body[k]) for k in ('id','deviceId','memberId','callId')):
        raise web.HTTPBadRequest()
    if type(body['displayId']) is not int or not 0 <= body['displayId'] <= 0xffffffff or body['mode'] not in ('view','control'):
        raise web.HTTPBadRequest()
    if 'protocolVersion' in body:
        if body['protocolVersion']!=2 or not isinstance(body['sessionId'],str) or not ID.fullmatch(body['sessionId']) or any(type(body[k]) is not int or body[k]<0 for k in ('executorEpoch','policyRevision')) or body['policyRevision']<1 or body['executor'] not in ('none','native','clawdtime') or (body['mode']=='control' and body['executor']!='clawdtime'):
            raise web.HTTPBadRequest()
    try:
        remaining = timestamp(body['expiresAt']) - time.time()
        if not 0 < remaining <= 30:
            raise ValueError()
    except (ValueError, TypeError):
        raise web.HTTPBadRequest()
    return hashlib.sha256(json.dumps({k:v for k,v in body.items() if k != 'expiresAt'},sort_keys=True).encode()).hexdigest()


def validate_action(body):
    if not isinstance(body,dict) or not all(isinstance(body.get(k),str) and ID.fullmatch(body[k]) for k in ('id','frameId')):
        raise web.HTTPBadRequest()
    kind = body.get('type')
    keys = {'id','frameId','type'} | ({'x','y'} if kind == 'click' else {'x','y','deltaY'} if kind == 'scroll' else {'text'} if kind == 'type' else set())
    if kind not in ('click','scroll','type') or set(body) not in (keys,keys|{'sessionId','executorEpoch','policyRevision'}):
        raise web.HTTPBadRequest()
    if 'executorEpoch' in body and (not isinstance(body['sessionId'],str) or not ID.fullmatch(body['sessionId']) or any(type(body[k]) is not int or body[k]<0 for k in ('executorEpoch','policyRevision'))):raise web.HTTPBadRequest()
    if kind in ('click','scroll') and any(type(body[k]) not in (int,float) or not 0 <= body[k] <= 1 for k in ('x','y')):
        raise web.HTTPBadRequest()
    if kind == 'scroll' and (type(body['deltaY']) is not int or not 0 < abs(body['deltaY']) <= 500):
        raise web.HTTPBadRequest()
    if kind == 'type':
        text = body['text']
        if not isinstance(text,str) or not text or len(text.encode('utf-16-le')) > 1024 or not text.isprintable():
            raise web.HTTPBadRequest()
    return hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()


class Gateway:
    def __init__(self, env=None, devices=None):
        self.env = dict(os.environ if env is None else env)
        if devices is None:
            devices = json.loads(Path(self.env['DEVICE_GATEWAY_DEVICES_FILE']).read_text())
        self.devices = {}
        for device, config in devices.items():
            if not ID.fullmatch(device) or not isinstance(config.get('key'),str) or len(config['key']) < 32:
                raise ValueError('Invalid helper binding')
            self.devices[device] = {'url':valid_origin(config['url']), 'key':config['key']}
        path = self.env.get('DEVICE_GATEWAY_DATABASE_PATH','.data/clawdtime-gateway.sqlite')
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path)
        os.chmod(path,0o600)
        self.db.executescript('''PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,device TEXT,body TEXT,fingerprint TEXT,state TEXT,frame TEXT,captured REAL);
          CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,lease TEXT,fingerprint TEXT,body TEXT,state TEXT,receipt TEXT);
          UPDATE leases SET state=CASE WHEN state IN ('creating','creating_unknown') THEN 'creating_unknown' ELSE 'stopped' END WHERE state!='stopped';
          UPDATE actions SET state='unknown' WHERE state IN ('accepted','dispatching');''')
        self.db.commit()
        self.relay_diagnostics = RelayDiagnostics(self.db)
        self.http = None

    def lease(self, lease_id):
        row = self.db.execute('SELECT body,state,frame,captured FROM leases WHERE id=?',(lease_id,)).fetchone()
        if not row:
            raise web.HTTPNotFound()
        body,state,frame,captured = row
        return json.loads(body),state,frame,captured

    def active(self, lease_id):
        body,state,frame,captured = self.lease(lease_id)
        if state != 'active' or timestamp(body['expiresAt']) <= time.time():
            self.stop(lease_id)
            raise web.HTTPGone()
        return body,frame,captured

    def stop(self, lease_id):
        self.db.execute("UPDATE leases SET state=CASE WHEN state IN ('creating','creating_unknown') THEN 'creating_unknown' ELSE 'stopped' END,frame=NULL,captured=NULL WHERE id=?",(lease_id,))
        self.db.commit()

    async def helper(self, body, method, suffix, payload=None, frame=False):
        started=time.monotonic()
        identity=request_id.get()
        self.relay_diagnostics.record(identity,'helper_request')
        try:
            result=await self._helper(body,method,suffix,payload,frame)
            self.relay_diagnostics.record(identity,'helper_response',duration=milliseconds(time.monotonic()-started))
            return result
        except asyncio.CancelledError:
            self.relay_diagnostics.record(identity,'helper_failed',duration=milliseconds(time.monotonic()-started),error='cancelled')
            raise
        except Exception as error:
            # Fixed categories only: never log a URL, body, token, typed input or exception message.
            category='timeout' if isinstance(error,TimeoutError) else 'http' if isinstance(error,web.HTTPException) else 'connection' if isinstance(error,ConnectionError) else 'other'
            self.relay_diagnostics.record(identity,'helper_failed',duration=milliseconds(time.monotonic()-started),
                status=error.status if isinstance(error,web.HTTPException) else None,error=category)
            logging.warning('helper_request_failed operation=%s error=%s status=%s duration_ms=%s',
                'frame' if frame else 'lease',category,error.status if isinstance(error,web.HTTPException) else 0,
                min(999999,max(0,round((time.monotonic()-started)*1000))))
            raise

    async def _helper(self, body, method, suffix, payload=None, frame=False):
        config = self.devices.get(body['deviceId'])
        if not config:
            raise web.HTTPForbidden()
        async with self.http.request(method,config['url']+'/v1/leases'+suffix,
                headers={'Authorization':'Bearer '+config['key']},
                **({'json':payload} if payload is not None else {}),allow_redirects=False) as response:
            limit = MAX_FRAME if frame else 16384
            chunks, size = [], 0
            async for chunk in response.content.iter_chunked(65536):
                size += len(chunk)
                if size > limit:raise web.HTTPBadGateway()
                chunks.append(chunk)
            raw = b''.join(chunks)
            if response.status >= 300:
                logging.warning('helper_response_refused operation=%s status=%s','frame' if frame else 'lease',response.status)
                if response.status in (403,404,409,410,423):
                    self.stop(body['id'])
                    raise web.HTTPGone(text='Device lease stopped; request a fresh lease explicitly.')
                raise web.HTTPServiceUnavailable()
            return raw,dict(response.headers)

    async def create(self, request):
        body = await request.json()
        fingerprint = validate_lease(body)
        if body['deviceId'] not in self.devices:
            raise web.HTTPForbidden()
        old = self.db.execute('SELECT fingerprint,state FROM leases WHERE id=?',(body['id'],)).fetchone()
        if old:
            if old[0] != fingerprint:raise web.HTTPConflict()
            self.active(body['id'])
            return web.json_response({'id':body['id'],'state':'active'})
        self.db.execute('INSERT INTO leases VALUES(?,?,?,?,?,NULL,NULL)',(body['id'],body['deviceId'],json.dumps(body),fingerprint,'creating'))
        self.db.commit()
        try:
            await self.helper(body,'POST','',body)
            if self.lease(body['id'])[1] != 'creating':
                await self.helper(body,'DELETE',f"/{body['id']}")
                raise web.HTTPGone()
            self.db.execute("UPDATE leases SET state='active' WHERE id=?",(body['id'],));self.db.commit()
        except BaseException:
            self.stop(body['id'])
            raise
        return web.json_response({'id':body['id'],'state':'active'})

    async def renew(self, request):
        lease_id = request.match_info['id']
        body = await request.json()
        fingerprint = validate_lease(body)
        old,_,_ = self.active(lease_id)
        row = self.db.execute('SELECT fingerprint FROM leases WHERE id=?',(lease_id,)).fetchone()
        transition=fingerprint!=row[0]
        if body['id'] != lease_id:raise web.HTTPConflict()
        if transition:
            mutable={'mode','executorEpoch','policyRevision','executor','expiresAt'}
            if old.get('protocolVersion')!=2 or body.get('protocolVersion')!=2 or body['executorEpoch']<=old['executorEpoch'] or any(body[k]!=v for k,v in old.items() if k not in mutable):raise web.HTTPConflict()
            if self.db.execute("SELECT id FROM actions WHERE lease=? AND state IN ('accepted','unknown','dispatching')",(lease_id,)).fetchone():raise web.HTTPConflict(text='Input outcome requires reconciliation.')
            # Persist the proposed authority before the helper effect. Lost replies
            # leave a tombstone; no old owner may continue dispatching.
            self.db.execute("UPDATE leases SET body=?,fingerprint=?,state='creating_unknown',frame=NULL,captured=NULL WHERE id=?",(json.dumps(body),fingerprint,lease_id));self.db.commit()
        await self.helper(old,'POST',f'/{lease_id}/renew',body)
        # A prior renewal may return after Stop or a newer executor transition.
        # Its success cannot resurrect the retired or superseded authority.
        expected_state='creating_unknown' if transition else 'active'
        cursor=self.db.execute("UPDATE leases SET body=?,state='active' WHERE id=? AND fingerprint=? AND state=?",(json.dumps(body),lease_id,fingerprint,expected_state));self.db.commit()
        if cursor.rowcount!=1:raise web.HTTPConflict(text='Lease changed while renewal was in flight.')
        return web.json_response({'id':lease_id,'state':'active'})

    async def close(self, request):
        lease_id = request.match_info['id']
        body,prior_state,_,_ = self.lease(lease_id)
        self.stop(lease_id)
        released=False
        config=self.devices.get(body['deviceId'])
        if config:
            try:
                async with self.http.delete(config['url']+f'/v1/leases/{lease_id}',headers={'Authorization':'Bearer '+config['key']},allow_redirects=False) as response:
                    # Permission/auth failures and transport errors do not prove
                    # release. An absent/expired lease definitively cannot capture.
                    released=200<=response.status<300 or response.status in (404,410)
            except Exception:pass
        if prior_state in ('creating','creating_unknown') and timestamp(body['expiresAt'])>time.time():
            # DELETE may have beaten an earlier uncertain CREATE to the helper.
            # Preserve that uncertainty across process restarts until lease expiry.
            released=False
        return web.json_response({'stopped':True,'released':released})

    async def frame(self, request):
        lease_id = request.match_info['id']
        body,_,_ = self.active(lease_id)
        # The helper invalidates its preceding input frame before capture. Do
        # the same before yielding, including failures and oversized responses.
        self.db.execute('UPDATE leases SET frame=NULL,captured=NULL WHERE id=?',(lease_id,));self.db.commit()
        raw,headers = await self.helper(body,'GET',f'/{lease_id}/frame',frame=True)
        self.active(lease_id)  # local stop/expiry may have happened during the fetch
        normalized = {k.lower():v for k,v in headers.items()}
        try:
            frame_id = normalized['x-frame-id']
            captured = timestamp(normalized['x-captured-at'])
            width,height = int(normalized['x-frame-width']),int(normalized['x-frame-height'])
            if normalized.get('content-type','').split(';')[0]!='image/jpeg' or not ID.fullmatch(frame_id) or not -.5 <= time.time()-captured <= 2 or not 0 < width <= 1280 or not 0 < height <= 720 or not raw.startswith(b'\xff\xd8'):
                raise ValueError()
        except (KeyError,ValueError,TypeError):
            raise web.HTTPBadGateway(text='Invalid or stale device frame.')
        self.db.execute('UPDATE leases SET frame=?,captured=? WHERE id=?',(frame_id,captured,lease_id));self.db.commit()
        return web.Response(body=raw,content_type='image/jpeg',headers={k:normalized[k.lower()] for k in ('X-Frame-Id','X-Captured-At','X-Frame-Width','X-Frame-Height')})

    async def action(self, request):
        lease_id = request.match_info['id']
        action = await request.json()
        fingerprint = validate_action(action)
        prior = self.db.execute('SELECT lease,fingerprint FROM actions WHERE id=?',(action['id'],)).fetchone()
        if prior:
            if prior != (lease_id,fingerprint):raise web.HTTPConflict()
            return await self.action_receipt(lease_id,action['id'])
        body,frame,captured = self.active(lease_id)
        if body.get('protocolVersion')==2:
            if any(action.get(k)!=body[k] for k in ('sessionId','executorEpoch','policyRevision')) or body['executor']!='clawdtime':raise web.HTTPConflict(text='Stale input owner.')
        elif any(k in action for k in ('sessionId','executorEpoch','policyRevision')):raise web.HTTPConflict()
        if body['mode'] != 'control' or frame != action['frameId'] or captured is None or time.time()-captured > 2:
            raise web.HTTPConflict(text='A fresh control frame is required.')
        self.db.execute('INSERT INTO actions VALUES(?,?,?,?,?,NULL)',(action['id'],lease_id,fingerprint,'{}','accepted'));self.db.commit()
        try:
            raw,_ = await self.helper(body,'POST',f'/{lease_id}/actions',action)
            self.record_receipt(body,action['id'],json.loads(raw))
        except BaseException:
            self.db.execute("UPDATE actions SET state='unknown' WHERE id=?",(action['id'],));self.db.commit()
            raise
        return await self.action_receipt(lease_id,action['id'],refresh=False)

    def record_receipt(self, body, action_id, receipt):
        if any(receipt.get(k) != v for k,v in {'id':action_id,'leaseId':body['id'],'deviceId':body['deviceId'],'memberId':body['memberId'],'callId':body['callId']}.items()) or receipt.get('state') not in ('dispatching','submitted','unknown'):
            raise ValueError('Receipt ownership mismatch')
        self.db.execute('UPDATE actions SET state=?,receipt=? WHERE id=?',(receipt['state'],json.dumps(receipt),action_id));self.db.commit()

    async def action_receipt(self, lease_id, action_id, refresh=True):
        row = self.db.execute('SELECT state,receipt FROM actions WHERE id=? AND lease=?',(action_id,lease_id)).fetchone()
        if not row:raise web.HTTPNotFound()
        if refresh and row[0] in ('accepted','dispatching','unknown'):
            body,_,_,_ = self.lease(lease_id)
            try:
                raw,_ = await self.helper(body,'GET',f'/{lease_id}/actions/{action_id}')
                self.record_receipt(body,action_id,json.loads(raw))
            except Exception:pass
            row = self.db.execute('SELECT state,receipt FROM actions WHERE id=?',(action_id,)).fetchone()
        return web.json_response({**json.loads(row[1]),'state':row[0]} if row[1] else {'id':action_id,'leaseId':lease_id,'state':'unknown'})

    async def readiness(self, request):
        """Metadata only; fixed helper origin and exact registered device identity."""
        device_id=request.match_info['device']
        config=self.devices.get(device_id)
        if not ID.fullmatch(device_id) or not config:raise web.HTTPNotFound()
        async def read(path):
            async with self.http.get(config['url']+path,headers={'Authorization':'Bearer '+config['key']},allow_redirects=False) as response:
                if response.status!=200:raise web.HTTPServiceUnavailable(text='Helper metadata unavailable.')
                raw=await response.content.read(16385)
                if len(raw)>16384:raise web.HTTPBadGateway()
                return json.loads(raw)
        status=await read('/v1/status')
        if not isinstance(status,dict) or status.get('deviceId')!=device_id or any(type(status.get(k)) is not bool for k in ('armed','available','screenPermission','controlPermission')):
            raise web.HTTPBadGateway(text='Helper readiness identity mismatch.')
        displays=await read('/v1/displays')
        if not isinstance(displays,list) or len(displays)>32 or any(not isinstance(d,dict) or set(d)!={'id','width','height'} or type(d['id']) is not int or not 0<=d['id']<=0xffffffff or any(type(d[k]) is not int or not 0<d[k]<=32768 for k in ('width','height')) for d in displays):
            raise web.HTTPBadGateway(text='Helper display metadata invalid.')
        scoped={}
        member=request.match_info.get('member');display=request.match_info.get('display')
        if member is not None or display is not None:
            if not member or not ID.fullmatch(member) or not display or not display.isdecimal() or not 0<int(display)<=0xffffffff:raise web.HTTPBadRequest()
            permissions=await read('/v1/permissions')
            if not isinstance(permissions,list) or len(permissions)>32 or any(not isinstance(p,dict) or set(p)!={'displayId','viewers','controllers'} or type(p['displayId']) is not int or not isinstance(p['viewers'],list) or not isinstance(p['controllers'],list) or any(not isinstance(m,str) or not ID.fullmatch(m) for m in p['viewers']+p['controllers']) for p in permissions):
                raise web.HTTPBadGateway(text='Helper permission metadata invalid.')
            permission=next((p for p in permissions if p['displayId']==int(display)),None)
            viewing=bool(permission and member in permission['viewers'])
            scoped={'memberId':member,'displayId':display,'viewAllowed':viewing,
                'controlAllowed':viewing and member in permission['controllers'],
                'displayAttached':any(d['id']==int(display) for d in displays)}
        active_lease=status.get('activeLeaseId')
        if active_lease is not None and (not isinstance(active_lease,str) or not ID.fullmatch(active_lease)):
            raise web.HTTPBadGateway(text='Invalid active helper lease identity.')
        local={'activeLeaseId':active_lease} if active_lease is not None else {}
        if type(status.get('presentationVersion')) is int and status['presentationVersion']==1:
            local['presentationVersion']=1
        if 'controlPolicy' in status or 'policyRevision' in status:
            if status.get('controlPolicy') not in ('view_only','agent_tools_only','agent_tools_with_fallback') or type(status.get('policyRevision')) is not int or status['policyRevision']<1:raise web.HTTPBadGateway(text='Invalid local policy.')
            local.update(controlPolicy=status['controlPolicy'],policyRevision=status['policyRevision'])
            if type(status.get('unresolvedActionCount')) is int and status['unresolvedActionCount']>=0:local['unresolvedActionCount']=status['unresolvedActionCount']
            command=status.get('panelCommand')
            if command is not None:
                if not isinstance(command,dict) or set(command)!={'id','sessionId','callId','type'} or any(not isinstance(command[k],str) or not ID.fullmatch(command[k]) for k in ('id','sessionId','callId')) or command['type'] not in ('pause','mute','unmute','end'):raise web.HTTPBadGateway(text='Invalid local call control.')
                local['panelCommand']=command
        return web.json_response({**local,**{k:status[k] for k in ('deviceId','armed','available','screenPermission','controlPermission')},
            'activeLease':bool(status.get('activeLeaseId')),'displays':displays,**scoped},headers={'Cache-Control':'no-store'})

    async def panel(self, request):
        device_id=request.match_info['device']
        config=self.devices.get(device_id)
        if not ID.fullmatch(device_id) or not config:raise web.HTTPNotFound()
        body=await request.json()
        if not isinstance(body,dict):raise web.HTTPBadRequest()
        if 'activity' in body or 'presentationVersion' in body or 'readiness' in body:
            # A rolling upgrade must not send extensions to an old helper.
            helper=None
            try:
                async with self.http.get(config['url']+'/v1/status',headers={'Authorization':'Bearer '+config['key']},allow_redirects=False,timeout=ClientTimeout(total=1)) as status:
                    raw=await status.content.read(16385)
                    if status.status==200 and len(raw)<=16384:helper=json.loads(raw)
            except Exception:
                pass  # Optional presentation discovery cannot block baseline controls.
            if isinstance(helper,dict) and helper.get('deviceId')!=device_id:raise web.HTTPBadGateway()
            if not isinstance(helper,dict) or type(helper.get('presentationVersion')) is not int or helper['presentationVersion']!=1:
                body={key:value for key,value in body.items() if key not in ('activity','presentationVersion','readiness')}
        async with self.http.post(config['url']+'/v1/panel',json=body,headers={'Authorization':'Bearer '+config['key']},allow_redirects=False) as response:
            raw=await response.content.read(16385)
            if len(raw)>16384:raise web.HTTPBadGateway()
            return web.Response(status=response.status,body=raw,content_type='application/json',headers={'Cache-Control':'no-store'})

    def app(self):
        @web.middleware
        async def auth(request,handler):
            key=self.env.get('DEVICE_GATEWAY_KEY','')
            if len(key)<32 or not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+key):raise web.HTTPUnauthorized()
            identity=request.headers.get('X-ClawdTime-Relay-Request','')
            context=request_id.set(identity if re.fullmatch(r'[a-f0-9]{32}',identity) else None)
            try:
                try:return await handler(request)
                except web.HTTPException:raise
                except Exception:return web.json_response({'error':'Device operation uncertain; reconcile before retry.'},status=503)
            finally:request_id.reset(context)
        app=web.Application(middlewares=[auth],client_max_size=65536)
        app.router.add_get('/v1/devices/{device}/readiness',self.readiness)
        app.router.add_get('/v1/devices/{device}/readiness/{member}/{display}',self.readiness)
        app.router.add_post('/v1/devices/{device}/panel',self.panel)
        app.router.add_post('/v1/leases',self.create)
        app.router.add_post('/v1/leases/{id}/renew',self.renew)
        app.router.add_delete('/v1/leases/{id}',self.close)
        app.router.add_get('/v1/leases/{id}/frame',self.frame)
        app.router.add_post('/v1/leases/{id}/actions',self.action)
        async def receipt(request):return await self.action_receipt(request.match_info['id'],request.match_info['action'])
        app.router.add_get('/v1/leases/{id}/actions/{action}',receipt)
        async def start(app):self.http=ClientSession(timeout=ClientTimeout(total=1.5,connect=.7))
        async def stop(app):
            await self.http.close();self.db.close()
        app.on_startup.append(start);app.on_cleanup.append(stop)
        return app

if __name__ == '__main__':
    web.run_app(Gateway().app(),host=os.getenv('HOST','127.0.0.1'),port=int(os.getenv('PORT','4214')),access_log=None)
