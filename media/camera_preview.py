"""Loopback-only, expiring local camera preview using the real gateway/controller.

Synthetic pixels are default. Actual mode requires an explicit surface and local
Start; it launches only the development binary's capture-only mode. Input always
terminates in a disposable fake sink; no app is edited.
"""
import argparse
import asyncio
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import html
import hmac
import io
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image, ImageDraw, ImageFont
from camera import ScreenCamera, surface
from camera_http import camera_request
from devices import ScreenController
from device_actions import DeviceActions
from preview_stream import NativeDisplaySource
from preview_native import NativePreviewController, qualification_reason
from preview_presentation import LivePresentationController, safe_reason as presentation_reason

sys.path.append(str(Path(__file__).resolve().parents[1]/'gateway'))
from service import Gateway, CameraGeometryChanged


def iso():return datetime.now(timezone.utc).isoformat()

def fixture(kind='coding'):
    image=Image.new('RGB',(2560,1440),'#192333');d=ImageDraw.Draw(image)
    font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc' if Path('/System/Library/Fonts/Menlo.ttc').is_file() else 'DejaVuSans.ttf',32)
    d.rectangle((0,0,2560,100),fill='#29394e');d.text((50,30),'CLAWDTIME · SYNTHETIC '+kind.upper()+' · no real app',font=font,fill='#a4e7cc')
    if kind=='finder':
        for n,name in enumerate(['Research','Drafts','Approved','Archive','Exports']):
            y=200+n*175;d.rounded_rectangle((140,y,270,y+95),radius=12,fill='#70b6ed');d.text((320,y+28),name+' · disposable fixture',font=font,fill='white')
    elif kind=='timeline':
        d.rectangle((450,150,2110,850),fill='#283e4d');d.ellipse((1100,260,1450,610),fill='#ecb16c')
        for row in range(3):
            for col in range(5):
                x=100+col*470;y=950+row*130;d.rectangle((x,y,x+435,y+100),fill=['#346f86','#72578a','#487d67'][row]);d.text((x+16,y+28),f'Clip {row+1}.{col+1}',font=font,fill='white')
    else:
        lines=['export function selectedRegion(frame) {','  if (!frame.authorized) return unavailable;','  const source = frame.nativePixels;','  const target = clamp(frame.focus);','  return cropBeforeResize(source, target);','}','','// Camera changes only the outgoing presentation.','// Native input still requires exclusive ownership.']
        for n,line in enumerate(lines):d.text((110,210+n*105),f'{n+1:02}   '+line,font=font,fill='#b4d8f5' if n<6 else '#88b6a1')
    return image

HTML='''<!doctype html><meta charset="utf-8"><title>ClawdTime screen camera preview</title>
<style>[hidden]{display:none!important}body{background:#101722;color:#e5edf8;font:16px system-ui;margin:24px}button,select{font:inherit;padding:9px;margin:4px;border-radius:7px;border:0}button.stop{background:#dd5151;color:white}img{width:min(100%,1280px);display:block;border:1px solid #334558;border-radius:12px}#status{max-width:1100px;min-height:25px}input{font:inherit;width:340px;padding:9px}</style>
<h1 id="heading">ClawdTime screen camera</h1><p id="description">Local preview · camera only · IDE support optional · input uses a disposable fake sink.</p>
<p id="source"></p><p id="guidance"></p>
<button id="start">Start selected surface</button><button class="stop" id="stop">STOP sharing</button><select id="fixture"><option value="coding">Synthetic coding</option><option value="finder">Synthetic Finder</option><option value="timeline">Synthetic paused timeline</option></select>
<div><button data-op="focus_region">Focus region</button><button data-op="zoom_out">Zoom out</button><button data-op="overview">Overview</button><button data-op="pin">Pin</button><button data-op="unpin">Unpin</button><button data-op="freeze">Freeze</button><button data-op="resume">Resume</button><button data-op="clear">Clear marks</button></div>
<div><select id="kind"><option>rectangle</option><option>highlight</option><option>pointer</option><option>arrow</option><option>label</option></select><input id="label" maxlength="160" value="Review this selected region"><button id="mark">Add / update mark</button><button id="remove">Remove mark</button><button id="context">Context card</button><button id="click">Test mapped fake click</button></div>
<p id="status">Connecting…</p><p id="feedback" role="status"></p><div id="native-panel" hidden><p id="native-status"></p><button id="native-execute" disabled>Execute prepared operation</button></div><img id="frame" alt="Selected surface preview" hidden><pre id="receipt"></pre>
<script>
const credentialKey='clawdtime.camera.preview.credential.v1';
const maximumCredentialAge=15*60*1000;
let token='',credentialExpiresAt=0,sid,latest,stopped=false,halted=false,starting=false,startError='',pollTimer,imageTimer,imageEnabled=false,renderTargetFps=10;
let nativeEnabled=false,nativePrepared=null,nativeBusy=false,nativeTimer;
const status=document.getElementById('status'),frame=document.getElementById('frame');
function forgetCredential(){try{sessionStorage.removeItem(credentialKey)}catch{}token='';credentialExpiresAt=0}
function clearImage(){const old=frame.src;frame.hidden=true;frame.removeAttribute('src');if(old.startsWith('blob:'))URL.revokeObjectURL(old)}
function halt(message){document.getElementById('feedback').textContent='';halted=true;imageEnabled=false;clearTimeout(pollTimer);clearTimeout(imageTimer);forgetCredential();clearImage();document.querySelectorAll('button,select,input').forEach(el=>el.disabled=true);status.textContent=message}
function saveCredential(){if(halted||stopped||!token)return;try{sessionStorage.setItem(credentialKey,JSON.stringify({token,expiresAt:credentialExpiresAt}))}catch{}}
function validCredential(value){return value&&typeof value.token==='string'&&/^[A-Za-z0-9_-]{32,512}$/.test(value.token)&&Number.isFinite(value.expiresAt)&&value.expiresAt>Date.now()&&value.expiresAt<=Date.now()+maximumCredentialAge}
const fragment=location.hash.slice(1);
history.replaceState(null,'',location.pathname+location.search);
if(fragment){
  forgetCredential();
  const candidate={token:fragment,expiresAt:Date.now()+maximumCredentialAge};
  if(validCredential(candidate)){token=candidate.token;credentialExpiresAt=candidate.expiresAt;saveCredential()}
}else{
  try{const candidate=JSON.parse(sessionStorage.getItem(credentialKey)||'null');if(validCredential(candidate)){token=candidate.token;credentialExpiresAt=candidate.expiresAt}else forgetCredential()}catch{forgetCredential()}
}
function requireCredential(){
  if(halted||!token)throw Error(status.textContent);
  if(Date.now()>=credentialExpiresAt){halt('Preview access expired. Start a new preview session.');throw Error(status.textContent)}
  return token;
}
async function response(path,body){
  const requestToken=requireCredential();
  const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+requestToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(halted||stopped)throw Error(status.textContent);
  if(r.status===401||r.status===403){halt('Preview access is invalid or expired. Reopen the full preview URL, or start a new preview session.');throw Error(status.textContent)}
  if(r.status===410){halt('Preview session expired or stopped. Start a new preview session.');throw Error(status.textContent)}
  if(!r.ok)throw Error(await r.text());
  return r;
}
async function api(path,body){return (await response(path,body)).json()}
function showError(error){if(!halted&&!stopped)status.textContent=error.message}
function presentationControls(enabled,paused=false){document.querySelectorAll('[data-op],#mark,#remove,#context,#kind,#label').forEach(el=>el.disabled=!enabled||(paused&&!['resume','clear'].includes(el.dataset.op)))}
async function refresh(){
  if(halted||stopped)return;
  let delay=100;
  try{
    const info=await api('/preview/info');
    if(halted||stopped)return;
    if(info.stopped){halt('Preview stopped. Start a new preview session.');return}
    if(Number.isFinite(info.expiresAt)){credentialExpiresAt=Math.min(credentialExpiresAt,info.expiresAt);saveCredential();requireCredential()}
    sid=info.sessionId;
    nativeEnabled=info.nativePresentation===true;
    document.getElementById('native-panel').hidden=!nativeEnabled;
    renderTargetFps=info.renderTargetFps||10;
    if(info.mode==='actual'){
      document.getElementById('start').disabled=starting||info.started||Boolean(info.unavailableReason);
      if(info.unavailableReason){imageEnabled=false;presentationControls(false);clearImage();status.textContent='Actual '+info.surface.kind+' sharing unavailable. '+info.unavailableReason+' Start a new preview session.';pollTimer=setTimeout(refresh,1000);return}
      document.getElementById('guidance').textContent=info.started?'Sharing only the selected '+info.surface.kind+'. Stop immediately clears capture.':'Capture is off. Press Start sharing to share only this '+info.surface.kind+'.';
      if(!info.started){presentationControls(false);clearImage();status.textContent=starting?'Starting selected '+info.surface.kind+' sharing…':startError?'Cannot start sharing. '+startError:'Ready to share the selected '+info.surface.kind+'. Capture is off.';pollTimer=setTimeout(refresh,500);return}
    }
    latest=await api('/sessions/'+sid+'/screen/camera');
    if(halted||stopped)return;
    if(info.mode==='actual'){presentationControls(latest.state!=='unavailable',latest.state==='paused');if(latest.state==='unavailable'){clearImage();status.textContent='Starting selected '+info.surface.kind+' sharing… Waiting for its first authorized frame.';pollTimer=setTimeout(refresh,200);return}}
    status.textContent=info.mode==='actual'?(latest.state==='paused'?'Paused':'Live')+(latest.moving?' · adjusting view':''):info.mode+' · '+latest.state+' · revision '+latest.revision+(latest.moving?' · moving':'')+' · '+latest.surface.kind+' '+latest.surface.id;
    const diagnostics=document.getElementById('camera-details');if(diagnostics)diagnostics.textContent=JSON.stringify({revision:latest.revision,state:latest.state,source:latest.source},null,2);
    imageEnabled=true;
  }catch(e){imageEnabled=false;presentationControls(false);clearImage();showError(e);delay=1000}
  if(!halted&&!stopped)pollTimer=setTimeout(refresh,delay);
}
async function refreshImage(){
  if(halted||stopped)return;
  const began=performance.now();
  if(imageEnabled)try{
    const blob=await (await response('/preview/image')).blob();
    if(halted||stopped)return;
    if(imageEnabled){const url=URL.createObjectURL(blob);const old=frame.src;frame.src=url;frame.hidden=false;if(old.startsWith('blob:'))URL.revokeObjectURL(old)}
  }catch(e){clearImage();showError(e)}
  if(!halted&&!stopped)imageTimer=setTimeout(refreshImage,Math.max(0,1000/renderTargetFps-(performance.now()-began)));
}
async function command(op,extra={}){const feedback=document.getElementById('feedback'),receipt=document.getElementById('receipt');receipt.textContent='';feedback.textContent='Applying camera change…';try{latest=await api('/sessions/'+sid+'/screen/camera');const value=await api('/sessions/'+sid+'/screen/camera',{version:1,commandId:crypto.randomUUID(),expectedRevision:latest.revision,sourceFrameId:latest.sourceFrameId,geometryGeneration:latest.geometryGeneration,contentRevision:latest.contentRevision,op,...extra});if(!halted&&!stopped){receipt.textContent=JSON.stringify(value);feedback.textContent=value.state==='superseded'?'Automatic focus skipped while pinned.':'Camera change accepted.';}}catch(e){if(!halted&&!stopped)feedback.textContent=e.message}}
document.querySelectorAll('[data-op]').forEach(b=>b.onclick=()=>command(b.dataset.op,b.dataset.op==='focus_region'?{rect:{x:.16,y:.2,width:.55,height:.38},durationMs:450}:{}));
document.getElementById('mark').onclick=()=>command('annotation_upsert',{annotation:{id:'preview_mark',kind:document.getElementById('kind').value,rect:{x:.2,y:.25,width:.35,height:.15},text:document.getElementById('label').value,ttlMs:8000}});
document.getElementById('remove').onclick=()=>command('annotation_remove',{annotationId:'preview_mark'});
document.getElementById('context').onclick=()=>command('context',{text:document.getElementById('label').value,ttlMs:8000});
document.getElementById('start').onclick=async()=>{if(starting||halted||stopped)return;starting=true;startError='';document.getElementById('start').disabled=true;try{await api('/preview/start',{});}catch(e){startError=e.message;showError(e)}finally{starting=false}};
document.getElementById('stop').onclick=async()=>{
  const stopToken=token;stopped=true;
  halt('Stopping sharing…');
  try{
    const r=await fetch('/preview/stop',{method:'POST',headers:{Authorization:'Bearer '+stopToken,'Content-Type':'application/json'},body:'{}'});
    status.textContent=r.ok?'Stopped. Restart requires a new preview session.':'Stop was not confirmed. Close the preview process before starting another session.';
  }catch{status.textContent='Stop was not confirmed. Close the preview process before starting another session.'}
};
document.getElementById('fixture').onchange=async e=>{try{await api('/preview/fixture',{kind:e.target.value})}catch(error){showError(error)}};
document.getElementById('click').onclick=async()=>{try{const value=await api('/preview/fake-input',{x:.5,y:.5});if(!halted&&!stopped)document.getElementById('receipt').textContent=JSON.stringify(value)}catch(e){showError(e)}};
async function refreshNative(){
  if(halted||stopped)return;
  if(nativeEnabled&&!nativeBusy)try{
    const value=await api('/preview/native/status');
    nativePrepared=value.prepared||null;
    document.getElementById('native-status').textContent=nativePrepared?(nativePrepared.action==='activate_app'?'Activate ':'Raise ')+(nativePrepared.window.appId==='com.apple.finder'?'Finder':'TextEdit')+' · '+value.state:'No prepared operation.';
    document.getElementById('native-execute').disabled=!nativePrepared||value.state!=='prepared';
  }catch(e){nativePrepared=null;document.getElementById('native-execute').disabled=true;document.getElementById('native-status').textContent='Native operation unavailable.'}
  if(!halted&&!stopped)nativeTimer=setTimeout(refreshNative,500);
}
document.getElementById('native-execute').onclick=async()=>{
  if(!nativeEnabled||nativeBusy||!nativePrepared||halted||stopped)return;
  const operationId=nativePrepared.operationId;nativePrepared=null;nativeBusy=true;document.getElementById('native-execute').disabled=true;
  try{const value=await api('/preview/native/execute',{operationId});document.getElementById('native-status').textContent='Operation '+(value.phase||value.state)+'.';}
  catch(e){document.getElementById('native-status').textContent='Operation outcome unavailable. Do not repeat it.';}
  finally{nativeBusy=false;}
};
if(token)refreshNative();
if(token){refresh();refreshImage()}else halt('Preview access is missing. Reopen the full URL printed by the preview command, or start a new preview session.');
</script>'''

def preview_html(mode, selected, label=None, native_control=False, native_presentation=False):
    if mode!='actual':return HTML
    kind=selected['kind']
    owner=' · process '+str(selected['ownerPid']) if 'ownerPid' in selected else ''
    identity=kind.capitalize()+' '+selected['id']+' · display '+str(selected['displayId'])+owner
    control_note='prepared app activation and window raise' if native_presentation else 'native control coordinated separately; no preview input' if native_control else 'view only · no OS input'
    label=html.escape(label[:160]) if isinstance(label,str) and label.strip() else 'Selected '+kind
    identity=html.escape(identity)
    return (HTML.replace('ClawdTime screen camera</h1>', 'Actual '+kind+' sharing</h1>',1)
        .replace('Local preview · camera only · IDE support optional · input uses a disposable fake sink.',
                 'Live pixels from one explicitly selected '+kind+' · '+control_note+'.',1)
        .replace('<p id="source"></p>','<p id="source">'+label+'</p>',1)
        .replace('<pre id="receipt"></pre>','<details><summary>Diagnostics</summary><p>'+identity+'</p><pre id="camera-details"></pre><pre id="receipt"></pre></details>',1)
        .replace('<p id="guidance"></p>','<p id="guidance">Capture is off until you press Start sharing. Keep this exact window open. Moving it onto another display requires a new selection.</p>',1)
        .replace('<button id="start">Start selected surface</button>','<button id="start">Start sharing</button>',1)
        .replace('<button data-op=', '<button disabled data-op=')
        .replace('<select id="kind">','<select id="kind" disabled>',1)
        .replace('<input id="label"','<input id="label" disabled',1)
        .replace('<button id="mark">','<button id="mark" disabled>',1)
        .replace('<button id="remove">','<button id="remove" disabled>',1)
        .replace('<button id="context">','<button id="context" disabled>',1)
        .replace('<select id="fixture">','<select id="fixture" hidden disabled>',1)
        .replace('<button id="click">','<button id="click" hidden disabled>',1))

class Preview:
    def __init__(self,config):
        self.config=config; self.token=config.get('token') or secrets.token_urlsafe(32)
        self.sid=config.get('sessionId','ct_'+'a'*40);self.mode=config.get('mode','synthetic')
        if self.mode=='actual' and 'surface' not in config:raise ValueError('Actual capture requires an explicitly selected --surface JSON.')
        self.native_control=config.get('nativeControl') is True
        self.native_presentation=config.get('nativePresentation') is True
        if 'nativePresentation' in config and type(config['nativePresentation']) is not bool:raise ValueError('nativePresentation must be an explicit boolean.')
        if self.native_presentation and not self.native_control:raise ValueError('Native activation requires explicit native control.')
        self.native_presentation_token=config.get('nativePresentationToken')
        if self.native_presentation and (not isinstance(self.native_presentation_token,str) or not 32<=len(self.native_presentation_token)<=512 or self.native_presentation_token==self.token):raise ValueError('Native activation requires a separate backend-only capability.')
        if self.native_presentation and (not isinstance(config.get('nativeReceiptPath'),str) or not Path(config['nativeReceiptPath']).is_absolute()):raise ValueError('Native activation requires a persistent private receipt path.')
        if 'nativeControl' in config and type(config['nativeControl']) is not bool:raise ValueError('nativeControl must be an explicit boolean.')
        if self.native_control:
            try:
                backend=urlsplit(config.get('backendOrigin',''))
                valid=(self.mode=='actual' and backend.scheme=='http' and backend.hostname=='127.0.0.1'
                    and backend.port is not None and not backend.username and not backend.password
                    and backend.path in ('','/') and not backend.query and not backend.fragment
                    and isinstance(config.get('backendToken'),str) and len(config['backendToken'])>=32)
            except (ValueError,TypeError):valid=False
            if not valid:raise ValueError('Native review requires an actual selected surface and authenticated literal-loopback backend.')
        self.kind='coding';self.stopped=False;self.started=False;self.start_lock=asyncio.Lock();self.deadline=time.monotonic()+min(900,config.get('durationSeconds',900));self.expires_at=time.time()*1000+min(900,config.get('durationSeconds',900))*1000
        self.runners=[];self.frame_count=0;self.inputs=[];self.lease=None;self.last_frame=None;self.process=None
        self.surface=surface(config.get('surface',{'kind':'display','id':str(config.get('displayId',1)),'displayId':config.get('displayId',1)}))
        if self.native_presentation and (self.mode!='actual' or self.surface['kind']!='display'):raise ValueError('Native activation requires actual selected-display capture.')
        self.display_stream=config.get('displayStream') is True
        if 'displayStream' in config and type(config['displayStream']) is not bool:raise ValueError('displayStream must be an explicit boolean.')
        if self.display_stream and (self.mode!='actual' or self.surface['kind']!='display'):raise ValueError('Persistent preview requires actual selected-display capture.')
        self.source_fps=config.get('sourceFps',15 if self.display_stream else 5)
        self.render_fps=config.get('renderFps',30 if self.display_stream else 10)
        if type(self.source_fps) is not int or not 1<=self.source_fps<=(15 if self.display_stream else 5):raise ValueError('Invalid preview source cadence.')
        if type(self.render_fps) is not int or not 1<=self.render_fps<=30:raise ValueError('Invalid preview render cadence.')
        self.tmp=tempfile.TemporaryDirectory(prefix='clawdtime-camera-')
        self.native_source=None;self.render_count=0;self.render_ms=0;self.metrics_started=time.monotonic();self.stop_notice='not_sent';self.render_lock=asyncio.Lock()
        self.native_executor=None
        self.presentation_controller=None
        self.selection={'leaseId':config.get('leaseId','preview_lease'),'deviceId':config.get('deviceId','preview_device'),
          'memberId':config.get('memberId','preview_member'),'sessionId':config.get('agentSessionId','preview_session'),
          'callId':config.get('callId','preview_call'),'displayId':self.surface['displayId'],'mode':'view',
          'protocolVersion':2,'executorEpoch':0,'policyRevision':1,'executor':'none','cameraVersion':1,'surface':self.surface,'alias':'Local preview'}
    async def listen(self,app,port=0):
        runner=web.AppRunner(app,access_log=None);await runner.setup();site=web.TCPSite(runner,'127.0.0.1',port);await site.start();self.runners.append(runner)
        return 'http://127.0.0.1:'+str(site._server.sockets[0].getsockname()[1])
    def policy(self):
        expiry=(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat()
        return {'state':'listening','callId':self.selection['callId'],'expiresAt':expiry,'screenSelection':{**self.selection,'expiresAt':expiry}}
    async def native(self):
        if self.display_stream:
            if self.native_source is None:
                self.native_source=NativeDisplaySource(self.config.get('nativeBinary',str(Path(__file__).resolve().parents[1]/'mac/.build/debug/ClawdTimeCompanion')),self.surface)
            return await self.native_source.frame()
        return await self.native_command("--camera-frame")
    async def native_command(self,mode):
        binary=self.config.get('nativeBinary',str(Path(__file__).resolve().parents[1]/'mac/.build/debug/ClawdTimeCompanion'))
        self.process=await asyncio.create_subprocess_exec(binary,mode,'--surface',json.dumps(self.surface),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        try:
            raw,error=await asyncio.wait_for(self.process.communicate(),2.5)
            if self.process.returncode==75:raise CameraGeometryChanged(text='Selected camera geometry changed; pixels discarded.')
            if self.process.returncode!=0 or len(raw)>3*1024*1024:
                detail=error.decode('utf-8',errors='replace').strip()
                raise ValueError(detail if detail.startswith('Camera preview unavailable: ') and len(detail)<400 else 'Native capture unavailable; check selected surface and Screen Recording permission.')
            return json.loads(raw)
        finally:
            if self.process.returncode is None:self.process.kill();await self.process.wait()
            self.process=None
    async def begin_capture(self):
        async with self.start_lock:
            if self.stopped:raise web.HTTPGone(text='Stopped selections cannot resume; start a new preview process.')
            if self.started:return
            if self.mode=='actual':
                try:
                    metadata=await self.native_command('--camera-inspect')
                    if metadata.get('surface')!=self.surface:raise ValueError('Selected surface identity changed.')
                    x,y,w,h=metadata['windowFrame'];dx,dy,dw,dh=metadata['displayBounds']
                    if not (w>0 and h>0 and dx<=x and dy<=y and x+w<=dx+dw and y+h<=dy+dh):
                        raise ValueError('Place the selected window wholly on its chosen display before Start sharing.')
                except (ValueError,KeyError,TypeError) as error:raise web.HTTPConflict(text=str(error))
            if self.stopped:raise web.HTTPGone(text='Stopped selections cannot resume; start a new preview process.')
            policy=await self.backend('/media/'+self.sid+'/policy')
            if self.stopped:raise web.HTTPGone(text='Stopped selections cannot resume; start a new preview process.')
            self.metrics_started=time.monotonic();self.render_count=0;self.render_ms=0
            self.started=True;self.screen.update(policy)

    async def setup(self):
        @web.middleware
        async def helper_auth(request,handler):
            if request.headers.get('Authorization')!='Bearer '+self.token:raise web.HTTPUnauthorized()
            return await handler(request)
        helper=web.Application(middlewares=[helper_auth])
        async def helper_status(request):return web.json_response({'deviceId':self.selection['deviceId'],'cameraVersion':1})
        async def helper_lease(request):
            if request.method=='DELETE':
                self.lease=None
                if self.native_source:await self.native_source.stop()
                return web.json_response({'stopped':True})
            self.lease=await request.json();return web.json_response(self.lease)
        async def helper_frame(request):
            if self.stopped or not self.started or not self.lease:raise web.HTTPGone()
            self.frame_count+=1
            if self.mode=='actual':
                try:value=await self.native()
                except CameraGeometryChanged:raise
                except Exception as error:
                    if self.stopped or not self.lease:raise web.HTTPGone(text='Selected preview stopped.')
                    self.capture_error=str(error) if isinstance(error,ValueError) else 'Selected native capture unavailable.'
                    raise web.HTTPConflict(text='Explicit selected native surface unavailable.')
                raw=base64.b64decode(value['jpegBase64']);meta=value['camera'];fid=value['frameId'];captured=value['capturedAt']
            else:
                image=fixture(self.kind);data=io.BytesIO();image.save(data,'JPEG',quality=85);raw=data.getvalue();fid='preview_frame_'+str(self.frame_count);captured=iso()
                source={'width':2560,'height':1440,'originX':-1280,'originY':0,'pointWidth':1280,'pointHeight':720,
                  'displayOriginX':-1280,'displayOriginY':0,'displayPointWidth':1280,'displayPointHeight':720}
                meta={'version':1,'surface':self.surface,'geometryGeneration':'preview_geometry_1','contentRevision':hashlib.sha256(raw).hexdigest(),'source':source}
            if self.stopped or not self.lease:raise web.HTTPGone()
            self.last_frame=fid
            return web.Response(body=raw,content_type='image/jpeg',headers={'X-Frame-Id':fid,'X-Captured-At':captured,
                'X-Frame-Width':str(meta['source']['width']),'X-Frame-Height':str(meta['source']['height']),
                'X-Camera-Frame':base64.b64encode(json.dumps(meta,separators=(',',':')).encode()).decode()})
        async def helper_action(request):
            body=await request.json()
            if self.mode=='actual' or not self.lease or self.lease['mode']!='control' or body['frameId']!=self.last_frame:raise web.HTTPConflict()
            self.inputs.append({k:v for k,v in body.items() if k!='text'})
            return web.json_response({**{k:self.lease[k] for k in ('deviceId','memberId','callId')},'id':body['id'],'leaseId':self.lease['id'],'state':'submitted'})
        helper.router.add_get('/v1/status',helper_status);helper.router.add_post('/v1/leases',helper_lease)
        helper.router.add_post('/v1/leases/{id}/renew',helper_lease);helper.router.add_delete('/v1/leases/{id}',helper_lease)
        helper.router.add_get('/v1/leases/{id}/frame',helper_frame);helper.router.add_post('/v1/leases/{id}/actions',helper_action)
        helper_origin=await self.listen(helper)
        self.gateway=Gateway({'DEVICE_GATEWAY_KEY':self.token,'DEVICE_GATEWAY_DATABASE_PATH':self.tmp.name+'/gateway.sqlite'},
            {self.selection['deviceId']:{'url':helper_origin,'key':self.token}})
        gateway_origin=await self.listen(self.gateway.app())
        self.http=ClientSession(timeout=ClientTimeout(total=3))
        async def backend(path,body=None):
            if not self.config.get('backendOrigin'):return self.policy() if path.endswith('/policy') else {'stopped':True}
            origin=self.config['backendOrigin']
            if not origin.startswith('http://127.0.0.1:'):raise ValueError('Preview backend must use literal loopback.')
            async with self.http.request('GET' if body is None else 'POST',origin+path,
                headers={'Authorization':'Bearer '+self.config['backendToken'],'X-ClawdTime-Camera':'1'},
                timeout=ClientTimeout(total=8 if path.startswith('/local-native/') else 3),
                **({'json':body} if body is not None else {}),allow_redirects=False) as response:
                if response.status!=200:raise ValueError('Preview backend policy unavailable.')
                return await response.json()
        self.backend=backend
        owner=SimpleNamespace(env={'DEVICE_GATEWAY_URL':gateway_origin,'DEVICE_GATEWAY_KEY':self.token,'CLAWDTIME_SCREEN_CAMERA_ENABLED':'true'},http=self.http,backend=backend)
        self.session=SimpleNamespace(id=self.sid,owner=owner,active=True,closing=False,call_id=self.selection['callId'],spec={'screen':True})
        self.screen=ScreenController(self.session,preview_source_fps=self.source_fps)
        self.session.screen=self.screen
        if self.native_presentation:
            self.native_executor=NativePreviewController(self.config.get('nativeBinary',str(Path(__file__).resolve().parents[1]/'mac/.build/debug/ClawdTimeCompanion')),
                self.native_authority,self.config['nativeReceiptPath'])
            self.presentation_controller=LivePresentationController(self.screen,self.native_executor.binary,
                self.presentation_authority,self.presentation_local_guard,self.native_executor.db)
        self.db=sqlite3.connect(self.tmp.name+'/media.sqlite')
        self.owner=SimpleNamespace(db=self.db,sessions={self.sid:self.session},backend=backend,env=owner.env,http=self.http)
        self.actions=DeviceActions(self.owner)
        # Metadata-only unavailable state until explicit local Start in actual mode.
        self.screen.camera=ScreenCamera({**self.selection,'expiresAt':self.policy()['expiresAt']})
        @web.middleware
        async def auth(request,handler):
            if request.host.split(':')[0]!='127.0.0.1':raise web.HTTPForbidden()
            if request.path.startswith('/sessions/') and request.match_info.get('id')!=self.sid:raise web.HTTPNotFound()
            if time.monotonic()>=self.deadline:await self.stop();raise web.HTTPGone(text='Preview expired.')
            native_host=request.path.startswith('/sessions/') and '/native/' in request.path
            credential=self.native_presentation_token if native_host and self.native_presentation else self.token
            if request.path!='/' and not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+credential):raise web.HTTPUnauthorized()
            if native_host and request.headers.get('Origin') is not None:raise web.HTTPForbidden()
            if request.method=='POST' and request.headers.get('Origin') not in (None,self.origin):raise web.HTTPForbidden()
            response=await handler(request);response.headers['Cache-Control']='no-store';response.headers['Referrer-Policy']='no-referrer';return response
        app=web.Application(middlewares=[auth],client_max_size=16384)
        async def home(request):return web.Response(text=preview_html(self.mode,self.surface,self.config.get('surfaceLabel'),self.native_control,self.native_presentation),content_type='text/html',headers={'Content-Security-Policy':"default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"})
        async def info(request):
            retired=self.selection['leaseId'] in self.screen.stopped
            reason=(getattr(self,'capture_error',None) or 'Selected surface authorization or capture became unavailable.') if retired else None
            return web.json_response({'sessionId':self.sid,'mode':self.mode,'inputSink':'none' if self.mode=='actual' else 'fake_only',
                'surface':self.surface,'started':self.started,'stopped':self.stopped,'expiresAt':self.expires_at,'unavailableReason':reason,
                'renderTargetFps':self.render_fps,'sourceTargetFps':self.source_fps,'displayStream':self.display_stream,'nativePresentation':self.native_presentation})
        async def command(request):return await camera_request(self.screen,request)
        async def image(request):
            return web.Response(body=await self.render_image(),content_type='image/jpeg')
        async def metrics(request):return web.json_response(self.metrics())
        async def frame(request):
            try:return web.json_response(await self.screen.observed(include_frame=True))
            except ValueError:raise web.HTTPConflict()
        async def start(request):
            await self.begin_capture();return web.json_response({'started':True})
        async def stop(request):
            await self.stop()
            return web.json_response({'released':True,'leaseId':self.selection['leaseId'],'backendNotice':self.stop_notice})
        async def fixture_change(request):
            body=await request.json()
            if self.mode!='synthetic' or body.get('kind') not in ('coding','finder','timeline'):raise web.HTTPBadRequest()
            self.kind=body['kind'];return web.json_response({'changed':True})
        async def lease(request):
            body=await request.json()
            if body.get('leaseId')!=self.selection['leaseId'] or self.stopped:raise web.HTTPConflict()
            if not self.started:raise web.HTTPConflict(text='Use local Start for selected actual capture.')
            policy=await self.backend('/media/'+self.sid+'/policy');selected=self.screen.valid_selection(policy)
            if not selected or selected['leaseId']!=body['leaseId'] or selected['executorEpoch']!=body.get('executorEpoch',0):raise web.HTTPConflict()
            self.selection={k:v for k,v in selected.items() if k!='expiresAt'}
            self.screen.update(policy)
            until=time.monotonic()+2.5
            while self.screen.applied_epoch!=selected['executorEpoch'] and time.monotonic()<until:await asyncio.sleep(.025)
            if self.screen.applied_epoch!=selected['executorEpoch']:raise web.HTTPConflict(text='Fixture helper acknowledgment unavailable.')
            return web.json_response({'accepted':True,'leaseId':self.selection['leaseId'],'executorEpoch':self.selection['executorEpoch']})
        async def readiness(request):
            if request.match_info['device']!=self.selection['deviceId']:raise web.HTTPNotFound()
            return web.json_response({'deviceId':self.selection['deviceId'],'memberId':self.selection['memberId'],'displayId':str(self.selection['displayId']),
                'armed':not self.stopped,'available':not self.stopped,'screenPermission':True,'controlPermission':self.mode=='synthetic' or self.native_control,'viewAllowed':True,'controlAllowed':not self.stopped and (self.mode=='synthetic' or self.native_control),
                'displayAttached':True,'activeLease':bool(self.lease),'activeLeaseId':self.selection['leaseId'] if self.lease else None,
                'cameraVersion':1,'policyRevision':1,'controlPolicy':'agent_tools_with_fallback' if self.mode=='synthetic' else 'agent_tools_only' if self.native_control else 'view_only','unresolvedActionCount':0,'preview':True})
        async def fallback_input(request):
            if self.mode=='actual':raise web.HTTPConflict(text='Actual preview does not submit fallback input; use coordinated native tools.')
            return await self.actions.post(request)
        async def fake_input(request):
            if self.mode!='synthetic':raise web.HTTPForbidden(text='Actual sharing is view only; no fake or OS input is available.')
            body=await request.json();state=self.screen.camera.status()
            try:x,y=self.screen.camera.map_input({k:state[k] for k in ('revision','sourceFrameId','geometryGeneration')},body.get('x'),body.get('y'))
            except ValueError:raise web.HTTPConflict(text='Wait for a fresh stable live view; letterbox clicks are rejected.')
            # This diagnostic deliberately never calls Gateway/action or postInput.
            return web.json_response({'state':'mapped_only','sink':'disposable_fixture','source':{'x':x,'y':y},'osInputSubmitted':False})
        app.router.add_get('/',home);app.router.add_get('/preview/info',info);app.router.add_get('/preview/image',image);app.router.add_get('/preview/metrics',metrics)
        app.router.add_post('/preview/start',start);app.router.add_post('/preview/stop',stop);app.router.add_post('/preview/fixture',fixture_change);app.router.add_post('/preview/fake-input',fake_input)
        app.router.add_get('/sessions/{id}/screen/camera',command);app.router.add_post('/sessions/{id}/screen/camera',command)
        app.router.add_get('/sessions/{id}/screen/frame',frame);app.router.add_post('/sessions/{id}/screen/lease',lease);app.router.add_post('/sessions/{id}/screen/stop',stop)
        app.router.add_post('/sessions/{id}/screen/actions',fallback_input);app.router.add_get('/sessions/{id}/screen/actions/{action_id}',self.actions.get)
        async def native_route(request):
            if not self.native_executor:raise web.HTTPNotFound()
            if request.match_info.get('id',self.sid)!=self.sid:raise web.HTTPNotFound()
            kind=request.match_info['kind']
            try:
                if kind=='receipts':
                    return web.json_response(self.native_executor.receipt(request.match_info['operation_id'],request.query.get('fingerprint')))
                if kind=='presentations':
                    return web.json_response(self.presentation_controller.receipt(request.match_info['operation_id'],request.query.get('fingerprint')))
                if self.stopped:raise web.HTTPGone()
                body=await request.json() if request.method=='POST' else None
                if kind=='status':return web.json_response(await self.backend('/local-native/'+self.sid+'/status'))
                if kind=='qualify':
                    if not isinstance(body,dict) or set(body)!={'operation'}:raise web.HTTPBadRequest()
                    return web.json_response(await self.native_executor.qualify(body['operation']))
                if kind=='execute':
                    if not isinstance(body,dict) or set(body)!={'operation','fingerprint'}:raise web.HTTPBadRequest()
                    return web.json_response(await self.native_executor.execute(body['operation'],body['fingerprint']))
                if kind=='present':
                    if not isinstance(body,dict) or set(body)!={'presentation','fingerprint'}:raise web.HTTPBadRequest()
                    return web.json_response(await self.presentation_controller.present(body['presentation'],body['fingerprint']))
            except (ValueError,KeyError,TypeError,OSError,asyncio.TimeoutError) as error:
                if kind=='qualify':return web.json_response({'error':'native_qualification_unavailable','reason':qualification_reason(error)},status=409)
                if kind=='present':return web.json_response({'error':'live_presentation_unavailable','reason':presentation_reason(error)},status=409)
                raise web.HTTPConflict(text='Native operation unavailable.')
            raise web.HTTPNotFound()
        app.router.add_get('/preview/native/{kind:status}',native_route)
        # UI's fixed path never accepts a native payload, only the prepared ID.
        async def native_ui_execute(request):
            if not self.native_executor:raise web.HTTPNotFound()
            if self.stopped:raise web.HTTPGone()
            body=await request.json()
            if not isinstance(body,dict) or set(body)!={'operationId'}:raise web.HTTPBadRequest()
            try:return web.json_response(await self.backend('/local-native/'+self.sid+'/execute',body))
            except ValueError:raise web.HTTPConflict(text='Native operation unavailable.')
        app.router.add_post('/preview/native/execute',native_ui_execute)
        app.router.add_post('/sessions/{id}/native/{kind:qualify|execute|present}',native_route)
        app.router.add_get('/sessions/{id}/native/{kind:receipts|presentations}/{operation_id}',native_route)
        app.router.add_get('/devices/{device}/readiness',readiness);app.router.add_get('/devices/{device}/readiness/{member}/{display}',readiness)
        self.origin=await self.listen(app,self.config.get('port',0))
        if self.mode=='synthetic' or self.config.get('capture') is True:
            await self.begin_capture()
        self.task=asyncio.create_task(self.heartbeat())
        return {'origin':self.origin,'url':self.origin+'/#'+self.token,'token':self.token,'sessionId':self.sid,'leaseId':self.selection['leaseId']}
    def check_local_authority(self,operation,executor):
            self.screen.expire()
            selected=self.screen.selection;expected=operation['expected']
            if not self.native_presentation:raise ValueError('media_capability_disabled')
            if self.stopped:raise ValueError('media_stopped')
            if not self.started:raise ValueError('media_not_started')
            if not selected:raise ValueError('media_selection_missing')
            if self.selection['leaseId'] in self.screen.stopped:raise ValueError('media_lease_retired')
            if selected.get('executor')!=executor:raise ValueError('media_executor_mismatch')
            if selected.get('sessionId')!=expected['sessionId']:raise ValueError('media_session_mismatch')
            if selected.get('leaseId')!=expected['leaseId']:raise ValueError('media_lease_mismatch')
            if selected.get('executorEpoch')!=expected['epoch']:raise ValueError('media_epoch_mismatch')
            if self.screen.applied_epoch!=expected['epoch']:raise ValueError('media_epoch_unapplied')
            if selected.get('policyRevision')!=expected['policyRevision']:raise ValueError('media_policy_mismatch')
            if type(selected.get('displayId')) is not type(expected['displayId']):raise ValueError('media_display_type_mismatch')
            if selected.get('displayId')!=expected['displayId']:raise ValueError('media_display_mismatch')
            if not self.screen.camera:raise ValueError('media_camera_missing')
            if self.screen.camera.status()['state']!='live':raise ValueError('media_camera_not_live')
            if self.screen.frame is None:raise ValueError('media_frame_missing')
    async def native_authority(self,operation):
        self.check_local_authority(operation,'native')
        try:authority=await self.backend('/local-native/'+self.sid+'/authority',{'operation':operation})
        except (ValueError,OSError,asyncio.TimeoutError):raise ValueError('broker_authority_unavailable') from None
        self.check_local_authority(operation,'native')
        return authority
    def presentation_local_guard(self,presentation):self.check_local_authority(presentation,'none')
    async def presentation_authority(self,presentation):
        self.presentation_local_guard(presentation)
        try:authority=await self.backend('/local-native/'+self.sid+'/presentation-authority',{'presentation':presentation})
        except (ValueError,OSError,asyncio.TimeoutError):raise ValueError('presentation_authority_unavailable') from None
        self.presentation_local_guard(presentation)
        return authority

    async def heartbeat(self):
        while time.monotonic()<self.deadline:
            if self.started and not self.stopped:
                try:self.screen.update(await self.backend('/media/'+self.sid+'/policy'))
                except Exception:self.screen.update({})
            await asyncio.sleep(.2)
        await self.stop()
    async def stop(self):
        if self.stopped:return
        self.stopped=True;self.screen.update({})
        if self.presentation_controller:await self.presentation_controller.stop()
        if self.native_executor:await self.native_executor.stop()
        if self.process and self.process.returncode is None:self.process.kill()
        if self.native_source:await self.native_source.stop()
        if self.config.get('backendOrigin') and self.started:
            # One notification only. Timeout is unknown, never an automatic retry.
            self.stop_notice='unknown'
            try:
                await asyncio.wait_for(self.backend('/media/'+self.sid+'/screen-stopped',{'leaseId':self.selection['leaseId'],'reason':'local_stop'}),2)
                self.stop_notice='acknowledged'
            except Exception:pass
        if self.screen.transition_task:await asyncio.shield(self.screen.transition_task)
    def metrics(self):
        elapsed=max(.001,time.monotonic()-self.metrics_started)
        captured=self.screen.captured_at
        age=max(0,(time.time()-datetime.fromisoformat(captured.replace('Z','+00:00')).timestamp())*1000) if captured else None
        return {'source':self.native_source.metrics() if self.native_source else {'transport':'snapshot','requests':self.frame_count},
            'sourceAgeMs':round(age,2) if age is not None else None,'sourceTargetFps':self.source_fps,
            'renderTargetFps':self.render_fps,'renderedImages':self.render_count,'renderedFps':round(self.render_count/elapsed,2),
            'meanRenderMs':round(self.render_ms/self.render_count,2) if self.render_count else 0,
            'stopped':self.stopped,'backendStopNotice':self.stop_notice}
    async def render_image(self):
        if self.render_lock.locked():raise web.HTTPTooManyRequests(text='Preview renderer is busy.')
        async with self.render_lock:
            if self.stopped:raise web.HTTPGone()
            began=time.monotonic();self.screen.expire()
            camera=self.screen.camera;generation=self.screen.generation
            if camera:
                snapshot=camera.render_snapshot();revision=snapshot[0]['revision']
                def render():
                    image=ScreenCamera.render_from_snapshot(snapshot)
                    data=io.BytesIO();image.convert('RGB').save(data,'JPEG',quality=88);return data.getvalue()
            else:
                image=self.screen.render()
                def render():
                    data=io.BytesIO();image.convert('RGB').save(data,'JPEG',quality=88);return data.getvalue()
            worker=asyncio.create_task(asyncio.to_thread(render))
            try:raw=await asyncio.shield(worker)
            except asyncio.CancelledError:
                # Keep the sole slot until its worker drops the snapshot. A client
                # disconnect must not create an unbounded tail of render threads.
                while not worker.done():
                    try:await asyncio.shield(worker)
                    except asyncio.CancelledError:continue
                if not worker.cancelled():worker.exception()
                raise
            self.screen.expire()
            if self.stopped:raise web.HTTPGone()
            if self.screen.generation!=generation or self.screen.camera is not camera:
                raise web.HTTPConflict(text='Preview authority changed during render.')
            current=camera.status() if camera else None  # Expire overlays before publication, too.
            if camera and (current['revision']!=revision or (snapshot[0]['state']=='live'
                    and time.time()-snapshot[0]['capturedAt']/1000>=2)):
                raise web.HTTPConflict(text='Preview presentation changed during render.')
            self.render_count+=1;self.render_ms+=(time.monotonic()-began)*1000
            return raw
    async def close(self):
        await self.stop()
        if hasattr(self,'task'):self.task.cancel();await asyncio.gather(self.task,return_exceptions=True)
        if hasattr(self,'screen'):await self.screen.close()
        for runner in reversed(self.runners):await runner.cleanup()
        if self.native_executor:self.native_executor.db.close()
        if hasattr(self,'http'):await self.http.close()
        if hasattr(self,'db'):self.db.close()
        self.tmp.cleanup()

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config-stdin',action='store_true');parser.add_argument('--port',type=int,default=0);parser.add_argument('--mode',choices=['synthetic','actual'],default='synthetic');parser.add_argument('--surface');parser.add_argument('--capture',action='store_true');parser.add_argument('--native-binary')
    parser.add_argument('--display-stream',action='store_true');parser.add_argument('--source-fps',type=int);parser.add_argument('--render-fps',type=int)
    args=parser.parse_args();config=json.loads(sys.stdin.readline()) if args.config_stdin else {'port':args.port,'mode':args.mode,'capture':args.capture}
    if args.surface:config['surface']=json.loads(args.surface)
    if args.native_binary:config['nativeBinary']=args.native_binary
    if args.display_stream:config['displayStream']=True
    if args.source_fps is not None:config['sourceFps']=args.source_fps
    if args.render_fps is not None:config['renderFps']=args.render_fps
    preview=Preview(config)
    try:
        result=await preview.setup();print(json.dumps(result),flush=True)
        await asyncio.Event().wait()
    finally:await preview.close()
if __name__=='__main__':
    try:asyncio.run(main())
    except KeyboardInterrupt:pass
