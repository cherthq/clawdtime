"""Bounded, ephemeral device frames. A local stop never silently reacquires a lease."""
import asyncio
import contextlib
from datetime import datetime
import io
import ipaddress
import re
import time
from urllib.parse import urlsplit

from PIL import Image, ImageOps, ImageDraw

from captions import WIDTH, HEIGHT, CaptionRenderer
from policy import capture_allowed
from screen_diagnostics import ScreenDiagnostics
from device_relay import RelayFailure


def timestamp(value):
    parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Time requires an offset')
    return parsed.timestamp()


def gateway_origin(value):
    url=urlsplit(value)
    if url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        raise ValueError('Use a bare gateway origin')
    if url.scheme=='https' and url.hostname:return value.rstrip('/')
    if url.scheme=='http':
        ip=ipaddress.ip_address(url.hostname)
        if ip.is_loopback or ip in ipaddress.ip_network('100.64.0.0/10'):return value.rstrip('/')
    raise ValueError('Gateway must use HTTPS or a loopback/Tailscale IP')


async def gateway_request(owner,method,path,body=None,frame=False,device=None):
    # GET receipt reconciliation is also available after Session objects are
    # lost on restart; persisted lease/action identities remain the authority.
    if owner.env.get('DEVICE_GATEWAY_RELAY')=='true':
        return await owner.device_relay.request(method,path,body,device=device)
    origin=gateway_origin(owner.env['DEVICE_GATEWAY_URL'])
    key=owner.env['DEVICE_GATEWAY_KEY']
    if len(key)<32:raise ValueError('Gateway credential too short')
    async with owner.http.request(method,origin+path,headers={'Authorization':'Bearer '+key},
            **({'json':body} if body is not None else {}),allow_redirects=False,timeout=1.5) as response:
        chunks=[];size=0;limit=2*1024*1024 if frame else 16384
        async for chunk in response.content.iter_chunked(65536):
            size+=len(chunk)
            if size>limit:raise ValueError('Gateway payload exceeds bound')
            chunks.append(chunk)
        return response.status,b''.join(chunks),{k.lower():v for k,v in response.headers.items()}


class ScreenController:
    def __init__(self, session):
        self.session=session
        self.owner=session.owner
        self.use_relay=self.owner.env.get('DEVICE_GATEWAY_RELAY')=='true'
        self.origin=None if self.use_relay else gateway_origin(self.owner.env['DEVICE_GATEWAY_URL'])
        self.key=self.owner.env['DEVICE_GATEWAY_KEY']
        if len(self.key)<32:raise ValueError('Gateway credential too short')
        self.selection=None
        self.generation=0
        self.applied_epoch=None
        self.applied_lease=None
        self.policy_at=0
        self.frame=None
        self.frame_id=None
        self.captured_at=None
        self.received_at=0
        self.revision=0
        self.state='stopped'
        self.stopped=set()
        self.created=set()
        self.task=None
        self.cleanup_tasks=set()
        self.terminal_tasks={}
        self.closed=False
        self.frame_lock=asyncio.Lock()
        self.hold_until=0
        # Presentation intent survives release/revocation; it is never capture
        # authority. A screen-origin call must not silently become a notes view.
        self.screen_call=getattr(session,'spec',{}).get('screen') is True
        self.starting=self.screen_call
        self.startup_renderer=None
        self.transition_task=None
        self.release_blocked_until=0
        self.requested_expiry={}
        persist=getattr(self.owner,'record_screen_diagnostic',None)
        self.diagnostics=ScreenDiagnostics((lambda data: persist(self.session.id,data)) if callable(persist) else None)

    def clear(self,state):
        self.frame=None;self.frame_id=None;self.captured_at=None
        self.state=state;self.revision+=1

    def invalidate_input(self,frame_id,lease_id):
        # An ordinary action consumes its input frame. Keep its still-fresh
        # pixels only for continuous video until the next capture; it cannot
        # authorize another input or be returned as a post-action observation.
        if (not self.selection or self.selection['leaseId']!=lease_id or
                self.frame_id!=frame_id): return
        self.frame_id=None
        self.state='awaiting_frame'
        self.hold_until=0

    def expire(self):
        if self.selection and (time.monotonic()-self.policy_at>=2 or timestamp(self.selection['expiresAt'])<=time.time()):
            self.clear('unavailable')
        if self.frame and (time.monotonic()-self.received_at>=2 or time.time()-timestamp(self.captured_at)>=2):
            self.clear('unavailable')

    def status(self):
        self.expire()
        return {'executorEpoch':self.applied_epoch,'leaseId':self.selection['leaseId'] if self.selection else None,
                'deviceId':self.selection['deviceId'] if self.selection else None,
                'displayId':self.selection['displayId'] if self.selection else None,
                'mode':self.selection['mode'] if self.selection else None,
                'frameId':self.frame_id,'capturedAt':self.captured_at,'state':self.state}

    async def observed(self, include_frame=False):
        async with self.frame_lock:
            current=self.status()
            if self.frame and self.frame_id and self.state=='viewing':
                # The helper validates inputs against its most recent frame.
                # Freeze polling briefly while the backend submits one explicit
                # action, rather than racing a new capture against that action.
                self.hold_until=time.monotonic()+min(1.5,max(0,2-(time.time()-timestamp(self.captured_at))))
                if include_frame:
                    import base64,hashlib
                    data=io.BytesIO();self.frame.save(data,'JPEG',quality=85)
                    raw=data.getvalue()
                    if len(raw)>2*1024*1024:raise ValueError('Frame exceeds bound')
                    current.update(width=self.frame.width,height=self.frame.height,
                        sha256=hashlib.sha256(raw).hexdigest(),jpegBase64=base64.b64encode(raw).decode())
            elif include_frame:
                raise ValueError('No current device frame')
            return current

    def valid_selection(self, policy):
        selection=policy.get('screenSelection')
        if not isinstance(selection,dict) or not self.session.active or self.session.closing or policy.get('callId')!=self.session.call_id or not capture_allowed(policy):return None
        required={'leaseId','deviceId','alias','memberId','callId','displayId','mode','expiresAt'}
        authority={'protocolVersion','sessionId','executorEpoch','policyRevision','executor'}
        if set(selection) not in (required,required|authority) or selection.get('callId')!=self.session.call_id or selection.get('mode') not in ('view','control'):return None
        if 'protocolVersion' in selection:
            if selection['protocolVersion']!=2 or not isinstance(selection['sessionId'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',selection['sessionId']) or any(type(selection[k]) is not int or selection[k]<0 for k in ('executorEpoch','policyRevision')) or selection['policyRevision']<1 or selection['executor'] not in ('none','native','clawdtime') or (selection['mode']=='control' and selection['executor']!='clawdtime'):return None
        if any(not isinstance(selection[k],str) or not 0<len(selection[k])<=160 for k in ('leaseId','deviceId','alias','memberId','callId')):return None
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',selection[k]) for k in ('leaseId','deviceId','memberId','callId')):return None
        if type(selection['displayId']) is not int or not 0<=selection['displayId']<=0xffffffff:return None
        try:
            if not 0<timestamp(selection['expiresAt'])-time.time()<=30:return None
        except (ValueError,TypeError):return None
        if selection['leaseId'] in self.stopped:return None
        return dict(selection)

    def update(self,policy):
        selected=self.valid_selection(policy)
        if selected and not self.selection:
            self.diagnostics.phase('selection_received')
        elif not selected and not self.selection and self.session.active:
            self.diagnostics.phase('waiting_selection')
        if self.starting and selected:
            self.starting=False
            self.revision+=1
        binding=lambda s: {k:v for k,v in s.items() if k not in ('expiresAt','alias')} if s else None
        if selected and self.selection and selected.get('protocolVersion')==2 and self.selection.get('protocolVersion')==2 and selected['leaseId']==self.selection['leaseId']:
            stable=('leaseId','deviceId','memberId','callId','displayId','sessionId')
            if any(selected[k]!=self.selection[k] for k in stable):selected=None
            elif selected['executorEpoch']<self.selection['executorEpoch']:
                return  # stale policy cannot renew or restore an old executor
            elif selected['executorEpoch']>self.selection['executorEpoch']:
                self.selection=selected
                self.frame_id=None  # keep video pixels only while still fresh
                self.state='awaiting_frame';self.hold_until=0
                self.policy_at=time.monotonic()
                return  # same capture loop renews authority, then captures a new frame
        if binding(selected)!=binding(self.selection):
            self.applied_epoch=None
            self.applied_lease=None
            old=self.selection
            old_task=self.task
            previous_transition=self.transition_task
            self.generation+=1
            generation=self.generation
            self.selection=selected
            self.clear('unavailable' if selected else 'stopped')
            if old_task:old_task.cancel()
            self.task=None
            if old:
                self.stopped.add(old['leaseId'])
            async def transition():
                # Transitions themselves are serialized, including rapid source
                # changes while an earlier DELETE is still unresolved.
                if previous_transition:
                    await asyncio.shield(previous_transition)
                if old_task:
                    await asyncio.gather(old_task,return_exceptions=True)
                if old and old['leaseId'] in self.created:
                    terminal=self.terminal_tasks.get(old['leaseId'])
                    released=await asyncio.shield(terminal) if terminal else await self.release(old)
                    if released is not True:
                        self.release_blocked_until=max(self.release_blocked_until,timestamp(old['expiresAt']),self.requested_expiry.get(old['leaseId'],0))
                if self.closed or generation!=self.generation or not selected:return
                if time.time()<self.release_blocked_until:
                    await self.terminal(selected,'previous_release_unconfirmed')
                    return
                self.task=asyncio.create_task(self.poll(generation))
            self.transition_task=self.cleanup(transition())
        elif selected:self.selection=selected
        self.policy_at=time.monotonic()

    def cleanup(self,coro):
        task=asyncio.create_task(coro);self.cleanup_tasks.add(task)
        task.add_done_callback(self.cleanup_tasks.discard)
        return task

    async def request(self,method,path,body=None,frame=False,device=None):
        phase='frame_request' if frame else 'lease_renew' if path.endswith('/renew') else 'lease_create' if method=='POST' else None
        started=time.monotonic()
        try:
            result=await gateway_request(self.owner,method,path,body,frame,device=device or (self.selection or {}).get('deviceId'))
        except Exception as error:
            if phase:
                category='timeout' if isinstance(error,TimeoutError) else 'connection' if isinstance(error,ConnectionError) else 'invalid_response' if isinstance(error,ValueError) else 'other'
                self.diagnostics.request_result(phase,started,error=category,relay=error.diagnostic if isinstance(error,RelayFailure) else None)
            raise
        if phase: self.diagnostics.request_result(phase,started,http_status=result[0])
        return result

    async def release(self,selection):
        try:
            import json
            status,raw,_=await self.request('DELETE','/v1/leases/'+selection['leaseId'],device=selection.get('deviceId'))
            return status==200 and json.loads(raw).get('released') is True
        except Exception:
            return False

    async def terminal(self,selection,reason,http_status=None):
        lease_id=selection['leaseId']
        if lease_id not in self.terminal_tasks:
            self.diagnostics.phase('stopped',reason,http_status)
            self.stopped.add(lease_id)
            self.clear('stopped')
            async def finish():
                released=await self.release(selection) if lease_id in self.created else True
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.owner.backend(f'/media/{self.session.id}/screen-stopped',{'leaseId':lease_id,'reason':reason}),2)
                return released
            self.terminal_tasks[lease_id]=self.cleanup(finish())
        # Policy updates cancel the capture task. They must not cancel its
        # already-committed release/notification, nor dispatch either twice.
        await asyncio.shield(self.terminal_tasks[lease_id])

    async def poll(self,generation):
        waiting_policy=False
        try:
            while not self.closed and self.selection and generation==self.generation:
                selection=dict(self.selection)
                expiry=timestamp(selection['expiresAt'])
                # A fresh policy cannot revive a helper grant that expired while
                # policy delivery was delayed. Existing Stop/generation checks
                # still own removal; never create a replacement lease here.
                granted_expiry=self.requested_expiry.get(selection['leaseId'],expiry)
                if min(expiry,granted_expiry)<=time.time():
                    await self.terminal(selection,'authorization_expired');return
                if time.monotonic()-self.policy_at>=2:
                    if self.frame is not None or self.state!='unavailable':self.clear('unavailable')
                    if not waiting_policy:
                        self.diagnostics.phase('policy_unavailable','authorization_expired')
                        waiting_policy=True
                    # Keep this single poll task idle, with no capture or renewal,
                    # until fresh same-lease authority arrives or the grant ends.
                    await asyncio.sleep(.05);continue
                waiting_policy=False
                if self.hold_until>time.monotonic():
                    await asyncio.sleep(.05);continue
                body={k:v for k,v in selection.items() if k not in ('leaseId','alias')};body['id']=selection['leaseId']
                route='/v1/leases'
                if selection['leaseId'] in self.created:route+='/'+selection['leaseId']+'/renew'
                else:self.created.add(selection['leaseId'])  # never repeat uncertain creation
                self.diagnostics.phase('lease_renew' if route.endswith('/renew') else 'lease_create')
                # Keep the longest expiry we sent, including an in-flight renew
                # whose response is lost/cancelled or a later shorter policy.
                self.requested_expiry[selection['leaseId']]=max(self.requested_expiry.get(selection['leaseId'],0),timestamp(selection['expiresAt']))
                status,_,_=await self.request('POST',route,body)
                if self.closed or generation!=self.generation:return
                if selection.get('executorEpoch')!=self.selection.get('executorEpoch'):continue
                if status>=300:
                    await self.terminal(selection,'helper_stopped',status);return
                self.applied_epoch=selection.get('executorEpoch')
                self.applied_lease=selection['leaseId']
                async with self.frame_lock:
                    if self.closed or generation!=self.generation:return
                    # Renewal and lock acquisition may outlive the policy that
                    # authorized them. Do not dispatch a new capture under it.
                    if time.monotonic()-self.policy_at>=2 or min(timestamp(selection['expiresAt']),timestamp(self.selection['expiresAt']))<=time.time():
                        self.clear('unavailable');continue
                    if self.hold_until>time.monotonic():continue
                    self.diagnostics.phase('frame_request',http_status=status)
                    status,raw,headers=await self.request('GET','/v1/leases/'+selection['leaseId']+'/frame',frame=True)
                    if generation!=self.generation:return
                    if selection.get('executorEpoch')!=self.selection.get('executorEpoch'):continue
                    if status in (403,404,409,410,423):
                        await self.terminal(selection,'helper_stopped',status);return
                    if status!=200:
                        self.diagnostics.phase('frame_request','frame_unavailable',status)
                        raise ValueError('Device frame unavailable')
                    captured=headers['x-captured-at'];frame_id=headers['x-frame-id']
                    if headers.get('content-type','').split(';')[0]!='image/jpeg' or not -.5<=time.time()-timestamp(captured)<2 or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',frame_id):raise ValueError('Stale frame')
                    width,height=int(headers['x-frame-width']),int(headers['x-frame-height'])
                    if not 0<width<=1280 or not 0<height<=720:raise ValueError('Invalid frame dimensions')
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.format!='JPEG' or image.size!=(width,height):raise ValueError('Invalid frame')
                        image.load();frame=image.convert('RGB')
                    if generation!=self.generation:return
                    self.expire()
                    # Discard a successful frame if authority expired in flight.
                    # Returning here used to strand a completed task forever:
                    # same-binding policy refreshes do not spawn another poller.
                    if time.monotonic()-self.policy_at>=2 or min(timestamp(selection['expiresAt']),timestamp(self.selection['expiresAt']))<=time.time():continue
                    if self.frame_id!=frame_id:
                        self.frame=frame;self.frame_id=frame_id;self.captured_at=captured;self.received_at=time.monotonic();self.revision+=1
                        self.diagnostics.frame(captured)
                    self.state='viewing'
                await asyncio.sleep(.2)
        except asyncio.CancelledError:raise
        except Exception:
            if generation==self.generation and self.selection:
                await self.terminal(dict(self.selection),'gateway_unavailable')

    def render(self):
        self.expire()
        canvas=Image.new('RGBA',(WIDTH,HEIGHT),'#0c1017')
        if not self.frame:
            if self.startup_renderer is None:self.startup_renderer=CaptionRenderer()
            draw=ImageDraw.Draw(canvas)
            draw.rounded_rectangle((510,154,770,314),radius=14,outline='#a6c3e6',width=5)
            draw.line((640,314,640,346),fill='#a6c3e6',width=5)
            draw.line((597,347,683,347),fill='#a6c3e6',width=5)
            title = 'Connecting your screen' if self.starting else 'Screen sharing stopped' if self.state=='stopped' else 'Screen unavailable'
            guidance = ('Your agent is connecting.','Subtitles appear here.') if self.starting else ('Enable sharing on the Mac,','then request a new session.')
            if self.closed:
                title='Screen sharing ended'
                guidance=('No device screen is being shared.','')
            for text,y,font,color in [('CLAWDTIME',100,self.startup_renderer.label_font,'#b5c3d7'),
                    (title,384,self.startup_renderer.title_font,'#ffffff'),
                    (guidance[0],442,self.startup_renderer.label_font,'#b5c3d7'),
                    (guidance[1],468,self.startup_renderer.label_font,'#b5c3d7')]:
                draw.text((640-draw.textlength(text,font=font)/2,y),text,font=font,fill=color)
            return canvas
        if self.frame:
            fitted=ImageOps.contain(self.frame,(WIDTH,HEIGHT-64))
            canvas.paste(fitted,((WIDTH-fitted.width)//2,64+(HEIGHT-64-fitted.height)//2))
        draw=ImageDraw.Draw(canvas)
        alias=self.selection['alias'] if self.selection else 'Device screen'
        draw.text((24,20),f'{alias} · {"Sharing screen" if self.frame else "Screen unavailable"}',fill='white')
        return canvas

    async def close(self):
        self.closed=True;self.starting=False;self.clear('stopped');self.generation+=1
        if self.task:
            self.task.cancel();await asyncio.gather(self.task,return_exceptions=True)
        if self.selection:
            terminal=self.terminal_tasks.get(self.selection['leaseId'])
            if terminal: await asyncio.shield(terminal)
            else: await self.release(self.selection)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.gather(*list(self.cleanup_tasks),return_exceptions=True),4.5)
        self.diagnostics.phase('closed')
