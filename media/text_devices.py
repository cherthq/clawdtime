"""Distinct text-session device path. Never constructs a call or media room.

The companion alone approves grants; gateway/helper retain action receipts.
This layer retains dispatch tombstones so lost effects are never posted again.
"""
import base64
import hashlib
import json
import re

from aiohttp import web
from devices import gateway_request

ID = re.compile(r'^[A-Za-z0-9_-]{1,160}$')


class TextDevices:
    def __init__(self, owner):
        self.owner, self.db = owner, owner.db
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS text_leases(id TEXT PRIMARY KEY,device TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS text_actions(id TEXT PRIMARY KEY,lease TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL);
          UPDATE text_leases SET state='unknown' WHERE state IN ('dispatching','active','releasing');
          UPDATE text_actions SET state='unknown' WHERE state='dispatching';
        ''')
        self.db.commit()

    def enabled(self):
        if self.owner.env.get('MEDIA_TEXT_CONTROL_ENABLED') != 'true':
            raise web.HTTPServiceUnavailable(text='Text device control is disabled.')

    def lease(self, identity):
        if not isinstance(identity, str) or not ID.fullmatch(identity):raise web.HTTPBadRequest()
        row=self.db.execute('SELECT state FROM text_leases WHERE id=?',(identity,)).fetchone()
        if not row:raise web.HTTPNotFound()
        return row[0]

    def device(self, identity):
        return self.db.execute('SELECT device FROM text_leases WHERE id=?',(identity,)).fetchone()[0]

    async def grant(self, request):
        if request.method=='POST':self.enabled()
        device=request.match_info['device'];grant=request.match_info.get('grant')
        if not ID.fullmatch(device) or (grant is not None and not ID.fullmatch(grant)):raise web.HTTPBadRequest()
        body=await request.json() if request.method=='POST' else None
        if body is not None and (not isinstance(body,dict) or body.get('deviceId')!=device):raise web.HTTPBadRequest()
        path=f'/v1/devices/{device}/text-grants'+('/'+grant if grant else '')
        status,raw,_=await gateway_request(self.owner,request.method,path,body)
        return web.Response(status=status,body=raw,content_type='application/json',headers={'Cache-Control':'no-store'})

    async def create(self, request):
        self.enabled()
        body=await request.json()
        if (not isinstance(body,dict) or body.get('protocolVersion')!=3 or 'callId' in body
                or not isinstance(body.get('id'),str) or not ID.fullmatch(body['id'])
                or not isinstance(body.get('deviceId'), str) or not ID.fullmatch(body['deviceId'])
                or not isinstance(body.get('authority'),dict) or body['authority'].get('kind')!='text_session'):
            raise web.HTTPBadRequest()
        identity=body['id']
        fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
        old=self.db.execute('SELECT fingerprint,state FROM text_leases WHERE id=?',(identity,)).fetchone()
        if old:
            if old[0]!=fingerprint:raise web.HTTPConflict()
            return web.json_response({'id':identity,'state':old[1]})
        self.db.execute('INSERT INTO text_leases VALUES(?,?,?,?)',(identity,body['deviceId'],fingerprint,'dispatching'));self.db.commit()
        try:
            status,raw,_=await gateway_request(self.owner,'POST','/v1/leases',body)
            if status!=200:raise web.HTTPServiceUnavailable(text='Text lease unconfirmed; reconcile before retrying.')
            result=json.loads(raw)
            if result.get('id')!=identity or result.get('state')!='active':raise web.HTTPBadGateway()
            changed=self.db.execute("UPDATE text_leases SET state='active' WHERE id=? AND state='dispatching'",(identity,));self.db.commit()
            if changed.rowcount!=1:raise web.HTTPConflict(text='Lease changed while creation was in flight.')
            return web.json_response(result)
        except BaseException:
            self.db.execute("UPDATE text_leases SET state='unknown' WHERE id=?",(identity,));self.db.commit()
            raise

    async def frame(self, request):
        self.enabled()
        identity=request.match_info['id']
        if self.lease(identity)!='active':raise web.HTTPConflict()
        status,raw,headers=await gateway_request(self.owner,'GET',f'/v1/leases/{identity}/frame',frame=True,device=self.device(identity))
        if status!=200:raise web.HTTPConflict(text='Fresh text-control observation unavailable.')
        lower={k.lower():v for k,v in headers.items()}
        return web.json_response({'frameId':lower['x-frame-id'],'capturedAt':lower['x-captured-at'],
            'width':int(lower['x-frame-width']),'height':int(lower['x-frame-height']),
            'jpegBase64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()},headers={'Cache-Control':'no-store'})

    async def action(self, request):
        self.enabled()
        identity=request.match_info['id']
        if self.lease(identity)!='active':raise web.HTTPConflict()
        body=await request.json()
        if not isinstance(body,dict) or not isinstance(body.get('id'),str) or not ID.fullmatch(body['id']):raise web.HTTPBadRequest()
        action_id=body['id'];fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
        old=self.db.execute('SELECT lease,fingerprint,state FROM text_actions WHERE id=?',(action_id,)).fetchone()
        if old:
            if old[:2]!=(identity,fingerprint):raise web.HTTPConflict()
            return await self.receipt_value(identity,action_id)
        if self.db.execute("SELECT id FROM text_actions WHERE lease=? AND state IN ('unknown','dispatching')",(identity,)).fetchone():raise web.HTTPConflict()
        self.db.execute('INSERT INTO text_actions VALUES(?,?,?,?)',(action_id,identity,fingerprint,'dispatching'));self.db.commit()
        try:
            status,raw,_=await gateway_request(self.owner,'POST',f'/v1/leases/{identity}/actions',body,device=self.device(identity))
            if status!=200:raise web.HTTPServiceUnavailable(text='Input unconfirmed; reconcile original action.')
            value=json.loads(raw)
            if value.get('id')!=action_id or value.get('leaseId')!=identity or value.get('state') not in ('submitted','unknown','dispatching'):raise web.HTTPBadGateway()
            self.db.execute('UPDATE text_actions SET state=? WHERE id=?',(value['state'],action_id));self.db.commit()
            return web.json_response(value)
        except BaseException:
            self.db.execute("UPDATE text_actions SET state='unknown' WHERE id=?",(action_id,));self.db.commit()
            raise

    async def receipt_value(self, identity, action):
        status,raw,_=await gateway_request(self.owner,'GET',f'/v1/leases/{identity}/actions/{action}',device=self.device(identity))
        if status!=200:return web.json_response({'id':action,'leaseId':identity,'state':'unknown'})
        value=json.loads(raw)
        if value.get('id')!=action or value.get('leaseId')!=identity or value.get('state') not in ('submitted','unknown','dispatching'):raise web.HTTPBadGateway()
        self.db.execute('UPDATE text_actions SET state=? WHERE id=?',(value['state'],action));self.db.commit()
        return web.json_response(value)

    async def receipt(self, request):
        identity,action=request.match_info['id'],request.match_info['action']
        self.lease(identity)
        if not ID.fullmatch(action) or not self.db.execute('SELECT id FROM text_actions WHERE id=? AND lease=?',(action,identity)).fetchone():raise web.HTTPNotFound()
        return await self.receipt_value(identity,action)

    async def release(self, request):
        identity=request.match_info['id'];prior=self.lease(identity)
        if prior=='released':return web.json_response({'stopped':True,'released':True})
        self.db.execute("UPDATE text_leases SET state='releasing' WHERE id=?",(identity,));self.db.commit()
        # Preserve unknown creation even after DELETE: it may race the earlier CREATE.
        status,raw,_=await gateway_request(self.owner,'DELETE',f'/v1/leases/{identity}',device=self.device(identity))
        if status!=200:raise web.HTTPServiceUnavailable(text='Release unconfirmed.')
        value=json.loads(raw)
        if prior in ('dispatching','unknown','releasing'):
            value={**value,'released':False}
            self.db.execute("UPDATE text_leases SET state='unknown' WHERE id=?",(identity,));self.db.commit()
        if value.get('released') is True:
            self.db.execute("UPDATE text_leases SET state='released' WHERE id=?",(identity,));self.db.commit()
        return web.json_response(value)

    def routes(self, app):
        app.router.add_post('/devices/{device}/text-grants',self.grant)
        app.router.add_get('/devices/{device}/text-grants/{grant}',self.grant)
        app.router.add_delete('/devices/{device}/text-grants/{grant}',self.grant)
        app.router.add_post('/text-leases',self.create)
        app.router.add_get('/text-leases/{id}/frame',self.frame)
        app.router.add_post('/text-leases/{id}/actions',self.action)
        app.router.add_get('/text-leases/{id}/actions/{action}',self.receipt)
        app.router.add_delete('/text-leases/{id}',self.release)
