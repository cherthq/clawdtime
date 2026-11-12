"""Durable, non-replaying receipts for explicit authenticated device inputs."""
import hashlib
import json
import re
import time
from aiohttp import web
from devices import gateway_request


class DeviceActions:
    def __init__(self,owner):
        self.owner=owner
        self.db=owner.db
        self.db.executescript('''CREATE TABLE IF NOT EXISTS device_actions(id TEXT PRIMARY KEY,session TEXT,lease TEXT,fingerprint TEXT,state TEXT,receipt TEXT);
          UPDATE device_actions SET state='unknown' WHERE state='accepted';''')
        self.db.commit()

    def lookup(self,sid,action_id):
        row=self.db.execute('SELECT lease,fingerprint,state,receipt FROM device_actions WHERE id=? AND session=?',(action_id,sid)).fetchone()
        if not row:raise web.HTTPNotFound()
        return row

    def receipt(self,sid,action_id):
        lease,_,state,raw=self.lookup(sid,action_id)
        return {'id':action_id,'sessionId':sid,'leaseId':lease,'state':state,
                **({'evidence':'os_event_posted'} if state=='submitted' else {})}

    def store(self,sid,action_id,raw):
        lease,_,_,_=self.lookup(sid,action_id)
        if raw.get('id')!=action_id or raw.get('leaseId')!=lease or raw.get('state') not in ('submitted','dispatching','unknown'):
            raise ValueError('Control receipt mismatch')
        state='accepted' if raw['state']=='dispatching' else raw['state']
        self.db.execute('UPDATE device_actions SET state=?,receipt=? WHERE id=?',(state,json.dumps(raw),action_id));self.db.commit()

    async def get(self,request):
        sid,action_id=request.match_info['id'],request.match_info['action_id']
        lease,_,state,_=self.lookup(sid,action_id)
        session=self.owner.sessions.get(sid)
        if state in ('accepted','unknown'):
            try:
                path=f'/v1/leases/{lease}/actions/{action_id}'
                status,raw,_=await session.screen.request('GET',path) if session and session.screen else await gateway_request(self.owner,'GET',path)
                if status==200:self.store(sid,action_id,json.loads(raw))
            except Exception:pass
        return web.json_response(self.receipt(sid,action_id))

    async def post(self,request):
        sid=request.match_info['id'];body=await request.json()
        required={'id','leaseId','callId','memberId','deviceId','displayId','frameId','type'}
        if not isinstance(body,dict) or not required.issubset(body) or not set(body).issubset(required|{'x','y','text','deltaY','sessionId','executorEpoch','policyRevision'}):raise web.HTTPBadRequest()
        if any(not isinstance(body[k],str) or not 0<len(body[k])<=160 for k in required-{'displayId'}):raise web.HTTPBadRequest()
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',body[k]) for k in ('id','leaseId','callId','memberId','deviceId','frameId')):raise web.HTTPBadRequest()
        action={k:v for k,v in body.items() if k not in ('leaseId','callId','memberId','deviceId','displayId')}
        kind=action['type'];keys={'id','frameId','type'}|({'x','y'} if kind=='click' else {'x','y','deltaY'} if kind=='scroll' else {'text'} if kind=='type' else set())
        if kind not in ('click','scroll','type') or set(action) not in (keys,keys|{'sessionId','executorEpoch','policyRevision'}):raise web.HTTPBadRequest()
        if kind in ('click','scroll') and any(type(action[k]) not in (int,float) or not 0<=action[k]<=1 for k in ('x','y')):raise web.HTTPBadRequest()
        if kind=='scroll' and (type(action['deltaY']) is not int or not 0<abs(action['deltaY'])<=500):raise web.HTTPBadRequest()
        if kind=='type' and (not isinstance(action['text'],str) or not action['text'] or len(action['text'].encode('utf-16-le'))>1024 or not action['text'].isprintable()):raise web.HTTPBadRequest()
        fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
        previous=self.db.execute('SELECT session,fingerprint FROM device_actions WHERE id=?',(body['id'],)).fetchone()
        if previous:
            if previous!=(sid,fingerprint):raise web.HTTPConflict()
            return web.json_response(self.receipt(sid,body['id']))
        session=self.owner.sessions.get(sid)
        if not session or not session.screen:raise web.HTTPConflict()
        policy=await self.owner.backend(f'/media/{sid}/policy')
        session.screen.update(policy)
        current=session.screen.status();selection=session.screen.selection
        if not selection or current['state']!='viewing' or selection['mode']!='control' or current['frameId']!=body['frameId'] or any(selection[k]!=body[k] for k in ('leaseId','callId','memberId','deviceId','displayId')):
            raise web.HTTPConflict(text='Fresh authorized control frame required.')
        if selection.get('protocolVersion')==2:
            if any(body.get(k)!=selection[k] for k in ('sessionId','executorEpoch','policyRevision')) or selection['executor']!='clawdtime':raise web.HTTPConflict(text='Stale input owner.')
        elif any(k in body for k in ('sessionId','executorEpoch','policyRevision')):raise web.HTTPConflict()
        # Recheck after authorization await; never dispatch a duplicate concurrently.
        previous=self.db.execute('SELECT session,fingerprint FROM device_actions WHERE id=?',(body['id'],)).fetchone()
        if previous:
            if previous!=(sid,fingerprint):raise web.HTTPConflict()
            return web.json_response(self.receipt(sid,body['id']))
        if self.db.execute("SELECT id FROM device_actions WHERE session=? AND lease=? AND state IN ('accepted','unknown')",(sid,body['leaseId'])).fetchone():
            raise web.HTTPConflict(text='The previous input requires reconciliation before another action.')
        self.db.execute('INSERT INTO device_actions VALUES(?,?,?,?,?,NULL)',(body['id'],sid,body['leaseId'],fingerprint,'accepted'));self.db.commit()
        try:
            status,raw,_=await session.screen.request('POST',f"/v1/leases/{body['leaseId']}/actions",action)
            if status!=200:raise ValueError('Input outcome uncertain')
            self.store(sid,body['id'],json.loads(raw))
        except BaseException:
            self.db.execute("UPDATE device_actions SET state='unknown' WHERE id=?",(body['id'],));self.db.commit()
            raise
        finally:
            session.screen.invalidate_input(body['frameId'],body['leaseId'])
        return web.json_response(self.receipt(sid,body['id']))
