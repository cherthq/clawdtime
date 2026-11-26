"""Isolated no-call rehearsal. Uses production helper, gateway, camera and native routes.

Never imported by server.py. Requires fresh synthetic configuration on stdin and
an explicitly locally enabled helper; no live credentials, provider or call API.
Receipts remain in the supplied private directory. Pixels exist only in memory.
"""
import asyncio
import hmac
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time
from types import SimpleNamespace
from urllib.parse import urlsplit
from aiohttp import web, ClientSession, ClientTimeout
from camera import ScreenCamera
from camera_http import camera_request
from devices import ScreenController, gateway_request
from live_presentation import routes as presentation_routes
from native_activation import routes as native_routes
sys.path.append(str(Path(__file__).resolve().parents[1] / 'gateway'))
from service import Gateway

HTML = '''<!doctype html><meta charset="utf-8"><title>ClawdTime isolated walkthrough</title>
<style>body{background:#111827;color:#fff;font:18px system-ui;margin:20px}img{max-width:100%;max-height:80vh}button{font:inherit;padding:12px}</style>
<h1>Isolated walkthrough · no call</h1><button id="stop">Stop rehearsal</button><p id="state">Connecting</p><img id="frame" alt="Transient selected-display presentation">
<script>let token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let stopped=false;
const headers={Authorization:'Bearer '+token};const frame=document.querySelector('#frame'),state=document.querySelector('#state');
document.querySelector('#stop').onclick=async()=>{stopped=true;await fetch('/stop',{method:'POST',headers});frame.removeAttribute('src');state.textContent='Stopped';};
async function poll(){if(stopped)return;try{let r=await fetch('/image',{headers});if(!r.ok)throw Error();let old=frame.src;frame.src=URL.createObjectURL(await r.blob());if(old.startsWith('blob:'))URL.revokeObjectURL(old);state.textContent='Synthetic authority · actual helper pixels';}catch{frame.removeAttribute('src');state.textContent='View unavailable';}setTimeout(poll,100);}poll();</script>'''

def loopback_origin(value):
    if not isinstance(value, str): raise ValueError('Exact isolated loopback origin required')
    parsed = urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or
        parsed.username is not None or parsed.password is not None or
        parsed.path or parsed.query or parsed.fragment or
        parsed.port is None or not 1 <= parsed.port <= 65535 or
        value != 'http://127.0.0.1:' + str(parsed.port)):
        raise ValueError('Exact isolated loopback origin required')
    return value

def screen_diagnostics_snapshot(screen):
    """Metadata-only producer snapshot; never serializes camera frames or exceptions."""
    selected=screen.selection or {}
    task=screen.task
    return {
        'version':1,'state':screen.state,'closed':screen.closed,
        'selected':{key:selected.get(key) for key in ('leaseId','executorEpoch','executor','mode')},
        'appliedLeaseId':screen.applied_lease,'appliedEpoch':screen.applied_epoch,
        'frameAvailable':screen.frame is not None,
        'policyAgeMs':min(999999,max(0,round((time.monotonic()-screen.policy_at)*1000))),
        'captureTask':{'present':task is not None,'done':task.done() if task else None,'cancelled':task.cancelled() if task else None},
        'diagnostics':dict(screen.diagnostics.data),
    }

async def release_screen_selection(screen, lease_id):
    """Mirror the production Stop receipt contract; wait for committed cleanup."""
    # update({}) removes selection before its async DELETE finishes. A second
    # caller must join that exact work, never mistake an empty selection for ACK.
    terminal=screen.terminal_tasks.get(lease_id)
    if terminal is not None:await asyncio.shield(terminal)
    transition=screen.transition_task
    if transition is not None:await asyncio.shield(transition)
    selected=screen.selection
    if not selected or selected['leaseId']!=lease_id:
        if lease_id in screen.stopped and time.time()>=screen.release_blocked_until:
            return {'released':True,'leaseId':lease_id}
        raise web.HTTPConflict()
    screen.update({})
    if screen.transition_task is not None:await asyncio.shield(screen.transition_task)
    if time.time()<screen.release_blocked_until:raise web.HTTPServiceUnavailable()
    return {'released':True,'leaseId':lease_id}

async def main(config):
    if not isinstance(config['deviceId'], str) or not config['deviceId'].startswith('synthetic_'):
        raise ValueError('Explicit isolated synthetic authority required')
    loopback_origin(config['helperOrigin']);loopback_origin(config['backendOrigin'])
    if not isinstance(config['token'], str) or len(config['token']) < 32 or not isinstance(config['helperKey'], str) or len(config['helperKey']) < 32:
        raise ValueError('Fresh isolated credentials required')
    directory = Path(config['directory'])
    if not directory.is_absolute() or directory.is_symlink(): raise ValueError('Private directory required')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata=directory.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError('Owner-only isolated directory required')
    runners=[]
    async def listen(app):
        runner=web.AppRunner(app,access_log=None);runners.append(runner);await runner.setup()
        site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        return 'http://127.0.0.1:'+str(site._server.sockets[0].getsockname()[1])
    token=config['token'];sid=config['sessionId'];done=asyncio.Event();closed=False
    gateway=None;http=None;db=None;screen=None;task=None
    async def stop():
        nonlocal closed
        if closed or screen is None:return
        lease_id=screen.selection['leaseId'] if screen.selection else None
        closed=True;session.active=False;screen.update({})
        try:await backend('/media/'+sid+'/screen-stopped',{'leaseId':lease_id,'reason':'local_stop'})
        except Exception:pass
        await screen.close()
    for sig in (signal.SIGINT,signal.SIGTERM):asyncio.get_running_loop().add_signal_handler(sig,done.set)
    try:
        gateway=Gateway({'DEVICE_GATEWAY_KEY':token,'DEVICE_GATEWAY_DATABASE_PATH':str(directory/'gateway.sqlite')},
          {config['deviceId']:{'url':config['helperOrigin'],'key':config['helperKey']}})
        gateway_origin=await listen(gateway.app())
        http=ClientSession(timeout=ClientTimeout(total=4))
        async def backend(path,body=None):
            async with http.request('GET' if body is None else 'POST',config['backendOrigin']+path,
              headers={'Authorization':'Bearer '+token,'X-ClawdTime-Camera':'1'},
              **({'json':body} if body is not None else {}),allow_redirects=False) as response:
                if response.status!=200:raise ValueError('Synthetic backend authority unavailable')
                return await response.json()
        db=sqlite3.connect(directory/'media.sqlite')
        env={'DEVICE_GATEWAY_URL':gateway_origin,'DEVICE_GATEWAY_KEY':token,'CLAWDTIME_SCREEN_CAMERA_ENABLED':'true',
          'CLAWDTIME_LIVE_PRESENTATION_ENABLED':'true','CLAWDTIME_NATIVE_ACTIVATION_ENABLED':'true'}
        owner=SimpleNamespace(env=env,http=http,backend=backend,db=db,sessions={})
        session=SimpleNamespace(id=sid,owner=owner,active=True,closing=False,spec={'screen':True},call_id=config['callId'])
        screen=ScreenController(session);session.screen=screen;owner.sessions[sid]=session
        @web.middleware
        async def auth(request,handler):
            if request.host.split(':')[0]!='127.0.0.1':raise web.HTTPForbidden()
            if request.path!='/' and not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+token):raise web.HTTPUnauthorized()
            if request.path.startswith('/sessions/') and request.match_info.get('id')!=sid:raise web.HTTPNotFound()
            if request.headers.get('Origin') not in (None,origin):raise web.HTTPForbidden()
            response=await handler(request);response.headers['Cache-Control']='no-store';response.headers['Referrer-Policy']='no-referrer';return response
        app=web.Application(middlewares=[auth],client_max_size=16384)
        async def home(request):return web.Response(text=HTML,content_type='text/html',headers={'Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'"})
        async def image(request):
            if closed or not screen.camera:raise web.HTTPGone()
            screen.expire();snapshot=screen.camera.render_snapshot()
            def render():
                frame=ScreenCamera.render_from_snapshot(snapshot);data=io.BytesIO();frame.convert('RGB').save(data,'JPEG',quality=88);return data.getvalue()
            data=await asyncio.to_thread(render)
            screen.expire()
            if closed or screen.camera.status()['state']!='live' or time.time()*1000-snapshot[0]['capturedAt']>2000:raise web.HTTPConflict()
            return web.Response(body=data,content_type='image/jpeg')
        async def diagnostics(request):return web.json_response(screen_diagnostics_snapshot(screen))
        async def status(request):return await camera_request(screen,request)
        async def frame(request):return web.json_response(await screen.observed(include_frame=True))
        async def lease(request):
            body=await request.json();policy=await backend('/media/'+sid+'/policy');selected=screen.valid_selection(policy)
            if closed or not selected or selected['leaseId']!=body['leaseId'] or selected['executorEpoch']!=body['executorEpoch']:raise web.HTTPConflict()
            screen.update(policy);until=time.monotonic()+3
            while screen.applied_epoch!=selected['executorEpoch'] and time.monotonic()<until:await asyncio.sleep(.02)
            if screen.applied_epoch!=selected['executorEpoch']:raise web.HTTPConflict()
            return web.json_response({'accepted':True,'leaseId':selected['leaseId'],'executorEpoch':selected['executorEpoch']})
        async def readiness(request):
            path='/v1/devices/'+request.match_info['device']+'/readiness/'+request.match_info['member']+'/'+request.match_info['display']
            status,body,_=await gateway_request(owner,'GET',path)
            return web.Response(body=body,status=status,content_type='application/json')
        async def stopped(request):
            if request.path == '/stop':
                await stop();return web.json_response({'stopped':True})
            body=await request.json()
            if not isinstance(body,dict) or set(body)!={'leaseId'} or not isinstance(body['leaseId'],str):raise web.HTTPBadRequest()
            return web.json_response(await release_screen_selection(screen,body['leaseId']))
        app.router.add_get('/',home);app.router.add_get('/image',image);app.router.add_post('/stop',stopped)
        app.router.add_get('/devices/{device}/readiness/{member}/{display}',readiness)
        app.router.add_get('/sessions/{id}/screen/diagnostics',diagnostics)
        app.router.add_get('/sessions/{id}/screen/camera',status);app.router.add_post('/sessions/{id}/screen/camera',status)
        app.router.add_get('/sessions/{id}/screen/frame',frame);app.router.add_post('/sessions/{id}/screen/lease',lease)
        app.router.add_post('/sessions/{id}/screen/stop',stopped)
        presentation_routes(owner,app);native_routes(owner,app)
        origin=await listen(app)
        if done.is_set():return
        print(json.dumps({'origin':origin,'previewUrl':origin+'/#'+token,'syntheticAuthority':True}),flush=True)
        async def heartbeat():
            while not closed:
                try:screen.update(await backend('/media/'+sid+'/policy'))
                except Exception:screen.update({})
                await asyncio.sleep(.2)
        task=asyncio.create_task(heartbeat())
        if not done.is_set():
            try:await asyncio.wait_for(done.wait(),900)
            except TimeoutError:pass
    finally:
        failures=[]
        try:await stop()
        except Exception:failures.append('screen_cleanup')
        if task is not None:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
        for runner in reversed(runners):
            try:await runner.cleanup()
            except Exception:failures.append('listener_cleanup')
        if http is not None:await http.close()
        if gateway is not None:
            peer_http=getattr(gateway,'http',None)
            if peer_http is not None and not peer_http.closed:await peer_http.close()
            gateway.db.close()
        if db is not None:db.close()
        print(json.dumps({'closed':not failures,'pixelsCleared':screen is None or screen.frame is None,
            'cleanupFailures':failures,'receiptsRetained':True}),flush=True)

if __name__=='__main__':
    asyncio.run(main(json.loads(sys.stdin.readline())))
