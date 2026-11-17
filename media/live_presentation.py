"""Gated production presentation; remote helper can only resolve metadata.

Capture stays on the existing selected-display snapshot transport. No activation
or OS input is exposed here. Original helper timestamps cross the network intact.
"""
import asyncio
import json
import math
import time
from aiohttp import web
from devices import gateway_request
from preview_native import HASH, NativePreviewController, operation, valid_id
from preview_presentation import LivePresentationController, safe_reason


def resolve_request(value):
    if not isinstance(value,dict) or set(value)!={'commandId','window','expected','expiresAt'} or not valid_id(value['commandId']):raise ValueError('invalid_presentation')
    e=value['expected']
    if not isinstance(e,dict) or type(e.get('epoch')) is not int or e['epoch']<0:raise ValueError('invalid_presentation')
    operation({'version':1,'operationId':'resolve','sceneId':'resolve','generation':0,'action':'activate_app',
        'window':value['window'],'expected':{**e,'epoch':max(1,e['epoch'])}})
    expiry=value['expiresAt']
    if type(expiry) not in (int,float) or not math.isfinite(expiry) or not time.time()*1000<expiry<=time.time()*1000+2000:raise ValueError('presentation_authority_unavailable')
    return value


class RemoteResolver:
    def __init__(self,host):self.host=host;self.closed=False;self.lock=asyncio.Lock()
    async def resolve(self,presentation,authority,timeout=1.5):
        if self.closed or self.lock.locked():raise ValueError('presentation_resolver_unavailable')
        async with self.lock:
            self.host.guard(presentation)
            expected=presentation['expected'];selection=self.host.screen.selection
            body={'version':1,'window':presentation['window'],'expected':expected,'expiresAt':authority['expiresAt']}
            if 'processIdentity' in presentation:body['processIdentity']=presentation['processIdentity']
            try:
                async with asyncio.timeout(timeout):
                    status,raw,_=await gateway_request(self.host.owner,'POST',f"/v1/leases/{expected['leaseId']}/presentation/resolve",body,device=selection['deviceId'])
                self.host.guard(presentation)
                if self.closed or status!=200 or len(raw)>8192:raise ValueError('presentation_resolver_unavailable')
                result=NativePreviewController._observation(None,json.loads(raw),{'window':presentation['window']})
                if not HASH.fullmatch(result['processIdentity']) or not all(result[k] for k in ('appActive','windowFocused','windowOnScreen')):raise ValueError('presentation_target_changed')
                return result
            except BaseException:
                self.closed=True;raise
    async def close(self):self.closed=True


class ProductionPresentation:
    def __init__(self,session):
        self.session=session;self.screen=session.screen;self.owner=session.owner
        self.controller=LivePresentationController(self.screen,self,self.authority,self.guard,self.owner.db,
            resolver_factory=RemoteResolver,receipt_namespace=session.id)
    def guard(self,value):
        screen=self.screen;screen.expire();selected=screen.selection;e=value['expected']
        if (self.owner.env.get('CLAWDTIME_LIVE_PRESENTATION_ENABLED')!='true' or not self.session.active or self.session.closing
            or screen.closed or not selected or selected['leaseId'] in screen.stopped
            or selected.get('protocolVersion')!=2 or selected.get('cameraVersion')!=1 or selected.get('executor')!='none'
            or selected.get('mode')!='view' or selected.get('surface',{}).get('kind')!='display'
            or screen.applied_lease!=e['leaseId'] or screen.applied_epoch!=e['epoch']
            or any(type(selected.get(k)) is not type(e[v]) or selected[k]!=e[v] for k,v in
                (('sessionId','sessionId'),('leaseId','leaseId'),('executorEpoch','epoch'),('policyRevision','policyRevision'),('displayId','displayId')))
            or not screen.camera or screen.camera.status()['state']!='live' or screen.frame is None):
            raise ValueError('presentation_authority_unavailable')
    async def authority(self,value):
        self.guard(value)
        result=await self.owner.backend(f'/media/{self.session.id}/presentation-authority',{'presentation':value})
        self.guard(value)
        return result
    async def qualify(self,value):
        resolve_request(value);self.guard(value)
        # The callback binds request/cursor and the original short expiry. The
        # helper separately checks the lease fields it actually retains.
        authority=await self.owner.backend(f'/media/{self.session.id}/presentation-qualification',{'qualification':value})
        if (not isinstance(authority,dict) or any(type(authority.get(k)) is not type(v) or authority[k]!=v for k,v in value['expected'].items())
            or type(authority.get('expiresAt')) not in (int,float) or not time.time()*1000<authority['expiresAt']<=value['expiresAt']):
            raise ValueError('presentation_authority_unavailable')
        self.guard(value);source=RemoteResolver(self)
        try:
            observed=await source.resolve(value,authority)
            current=await self.owner.backend(f'/media/{self.session.id}/presentation-qualification',{'qualification':value})
            if current!=authority:raise ValueError('presentation_authority_unavailable')
            self.guard(value)
            return observed
        finally:await source.close()
    async def stop(self):await self.controller.stop()


def routes(service,app):
    def host(sid):
        session=service.sessions.get(sid)
        if service.env.get('CLAWDTIME_LIVE_PRESENTATION_ENABLED')!='true' or not session or not session.active or session.closing or not session.screen:
            raise web.HTTPConflict(text='presentation_authority_unavailable')
        if not getattr(session.screen,'presentation',None):session.screen.presentation=ProductionPresentation(session)
        return session.screen.presentation
    async def handle(request):
        try:
            instance=host(request.match_info['id']);data=await request.content.read(8193)
            if len(data)>8192:raise ValueError('invalid_presentation')
            value=json.loads(data)
            if request.path.endswith('/resolve'):result=await instance.qualify(value)
            else:
                if not isinstance(value,dict) or set(value)!={'presentation','fingerprint'}:raise ValueError('invalid_presentation')
                result=await instance.controller.present(value['presentation'],value['fingerprint'])
            return web.json_response(result,headers={'Cache-Control':'no-store'})
        except Exception as error:
            return web.json_response({'error':'presentation_unavailable','reason':safe_reason(error)},status=409)
    async def receipt(request):
        # Read-only reconciliation remains available after Stop/restart. Session
        # namespace is part of the durable key; another session cannot read it.
        sid=request.match_info['id'];command=request.match_info['command']
        row=service.db.execute('SELECT result FROM presentation_receipts WHERE id=?',(sid+'/'+command,)).fetchone()
        if not row:raise web.HTTPNotFound()
        return web.json_response(json.loads(row[0]),headers={'Cache-Control':'no-store'})
    service.db.execute('CREATE TABLE IF NOT EXISTS presentation_receipts (id TEXT PRIMARY KEY, arguments TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL)');service.db.commit()
    app.router.add_post('/sessions/{id}/screen/presentation',handle)
    app.router.add_post('/sessions/{id}/screen/presentation/resolve',handle)
    app.router.add_get('/sessions/{id}/screen/presentation/{command}',receipt)
