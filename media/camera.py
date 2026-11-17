"""Independent general screen camera. Pixels and labels are memory-only.

The caller owns authorization. Every lifecycle loss must call clear(); freeze
never creates authority. This renderer never dispatches input or changes an app.
"""
import base64
import copy
import hashlib
import json
import math
import re
import time
import unicodedata
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ID = re.compile(r'[A-Za-z0-9_-]{1,160}')
FULL = {'x': 0., 'y': 0., 'width': 1., 'height': 1.}
SOURCE_KEYS = {'width','height','originX','originY','pointWidth','pointHeight',
               'displayOriginX','displayOriginY','displayPointWidth','displayPointHeight'}

class CameraError(ValueError):
    def __init__(self, reason, status=409):
        super().__init__(reason); self.status = status

def number(value):
    return type(value) in (int, float) and math.isfinite(value)

def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None

def surface(value, display=None):
    if not isinstance(value, dict): raise CameraError('Invalid camera surface',400)
    keys={'kind','id','displayId'} | ({'ownerPid'} if value.get('kind')=='window' else set())
    if (set(value)!=keys or value.get('kind') not in ('display','window') or
            not isinstance(value.get('id'),str) or not re.fullmatch(r'[1-9][0-9]{0,9}',value['id']) or
            not 0<int(value['id'])<=0xffffffff or type(value.get('displayId')) is not int or not 0<value['displayId']<=0xffffffff or
            (display is not None and value['displayId']!=display) or
            (value['kind']=='display' and int(value['id'])!=value['displayId']) or
            (value['kind']=='window' and (type(value.get('ownerPid')) is not int or not 0<value['ownerPid']<=0x7fffffff))):
        raise CameraError('Invalid camera surface',400)
    return dict(value)

def frame_metadata(value, selected, width, height):
    if not isinstance(value,dict) or set(value)!={'version','surface','geometryGeneration','contentRevision','source'} or type(value['version']) is not int or value['version']!=1:
        raise CameraError('Invalid camera frame',400)
    if surface(value['surface']) != selected or not valid_id(value['geometryGeneration']) or not valid_id(value['contentRevision']):
        raise CameraError('Camera frame binding mismatch')
    source=value['source']
    if (not isinstance(source,dict) or set(source)!=SOURCE_KEYS or
            any(not number(v) for v in source.values()) or
            any(type(source[k]) is not int or not 0<source[k]<=8192 for k in ('width','height')) or
            source['width']*source['height']>32_000_000 or (source['width'],source['height'])!=(width,height) or
            any(not 0<source[k]<=32768 for k in ('pointWidth','pointHeight','displayPointWidth','displayPointHeight')) or
            any(abs(source[k])>100000 for k in ('originX','originY','displayOriginX','displayOriginY'))):
        raise CameraError('Invalid camera geometry',400)
    # Display pixels remain contained. Window identity is the capture boundary;
    # its display is an active anchor, not a crop (native rejects another display).
    if selected['kind']=='display' and (source['originX']<source['displayOriginX'] or source['originY']<source['displayOriginY'] or
            source['originX']+source['pointWidth']>source['displayOriginX']+source['displayPointWidth']+.01 or
            source['originY']+source['pointHeight']>source['displayOriginY']+source['displayPointHeight']+.01):
        raise CameraError('Camera surface outside authorized display')
    return json.loads(json.dumps(value))

def decode_header(value, selected, width, height):
    if not isinstance(value,str) or len(value)>2048: raise CameraError('Missing camera metadata')
    return frame_metadata(json.loads(base64.b64decode(value,validate=True)),selected,width,height)

def rect(value):
    if (not isinstance(value,dict) or set(value)!=set(FULL) or any(not number(v) for v in value.values()) or
            any(not 0<=value[k]<=1 for k in ('x','y')) or any(not .01<=value[k]<=1 for k in ('width','height')) or
            value['x']+value['width']>1.000000001 or value['y']+value['height']>1.000000001):
        raise CameraError('Invalid source rectangle',400)
    return {k:float(v) for k,v in value.items()}

def label(value):
    if not isinstance(value,str) or not 0<len(value)<=160 or any(unicodedata.category(c) in ('Cc','Cs') for c in value) or len(value.encode('utf-16-le'))>320:
        raise CameraError('Invalid camera label',400)
    return value

def ttl(value):
    if type(value) is not int or not 100<=value<=10000: raise CameraError('Invalid annotation lifetime',400)
    return value

def annotation(value):
    if not isinstance(value,dict) or set(value)-{'id','kind','rect','text','ttlMs'} or not {'id','kind','rect','ttlMs'}<=set(value):
        raise CameraError('Invalid annotation',400)
    if not valid_id(value['id']) or value['kind'] not in ('pointer','arrow','rectangle','highlight','label'):
        raise CameraError('Invalid annotation',400)
    if value['kind']=='label' and 'text' not in value:raise CameraError('Label annotation requires text',400)
    result={**value,'rect':rect(value['rect']),'ttlMs':ttl(value['ttlMs'])}
    if 'text' in value: result['text']=label(value['text'])
    return result

class ScreenCamera:
    def __init__(self, binding, clock=time.monotonic, wall=time.time):
        self.binding=dict(binding); self.clock=clock; self.wall=wall
        self.selected=surface(binding['surface'],binding['displayId'])
        self.revision=0; self.receipts={}; self.rates=[]
        self.image=None; self.meta=None; self.frame_id=None; self.captured=None
        self.paused=False; self.frozen=None; self.frozen_info=None; self.pinned=False
        self.crop=dict(FULL); self.start_crop=dict(FULL); self.target=dict(FULL)
        self.motion_at=0.; self.duration=0.; self.annotations={}; self.context=None
        self.recent_frames={}
        self.reset_frames={}
        self.target_scope=None
        self.font=ImageFont.truetype(next((str(p) for p in [Path('/System/Library/Fonts/Supplemental/Arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.is_file()),'DejaVuSans.ttf'),22)

    def clear(self):
        self.target_scope=None
        self.image=None; self.meta=None; self.frame_id=None; self.captured=None
        self.paused=False; self.frozen=None; self.frozen_info=None
        self.annotations.clear(); self.context=None; self.pinned=False
        self.crop=dict(FULL); self.target=dict(FULL); self.duration=0; self.revision+=1
        self.recent_frames.clear()
        self.reset_frames.clear()

    def prune_references(self):
        wall=self.wall();now=self.clock()
        self.recent_frames={key:value for key,value in self.recent_frames.items()
            if -.5<=wall-value['captured']<2 and 0<=now-value['received']<2}
        self.reset_frames={key:value for key,value in self.reset_frames.items()
            if -.5<=wall-value['captured']<2 and 0<=now-value['received']<2}

    def accept(self,image,frame_id,captured,metadata):
        metadata=frame_metadata(metadata,self.selected,*image.size)
        if not valid_id(frame_id) or not number(captured) or not -.5<=self.wall()-captured<2:
            raise CameraError('Stale source frame')
        if self.meta and any(self.meta[k]!=metadata[k] for k in ('geometryGeneration','contentRevision','source')):
            self.recent_frames.clear()
        if self.meta and any(self.meta[k]!=metadata[k] for k in ('geometryGeneration','source')):
            self.reset_frames.clear()
            self.invalidate_target_scope()
        if self.meta and self.meta['geometryGeneration']!=metadata['geometryGeneration']:
            before=self.meta['source'];after=metadata['source'];origins={'originX','originY'}
            translated=(self.selected['kind']=='window' and any(before[k]!=after[k] for k in origins)
                and all(before[k]==after[k] for k in SOURCE_KEYS-origins))
            if translated:
                # Desktop translation changes input metadata, but not the window's
                # normalized presentation. Keep zoom/easing and any frozen pixels;
                # invalidate old-generation marks and command/input references.
                self.annotations.clear();self.context=None;self.revision+=1
            else:self.clear()
        if self.meta and self.meta['contentRevision']!=metadata['contentRevision']:
            self.expire_target_scope()
            kept={key:value for key,value in self.annotations.items() if self.target_scope and key in self.target_scope['annotationIds']}
            if len(kept)!=len(self.annotations) or self.context: self.revision+=1
            self.annotations=kept; self.context=None
        self.image=image; self.meta=metadata; self.frame_id=frame_id; self.captured=captured
        self.prune_references()
        # Metadata only: no prior pixels. Repeated sample IDs cannot extend age.
        if frame_id not in self.reset_frames:
            self.reset_frames[frame_id]={'captured':captured,'received':self.clock(),
                'geometry':metadata['geometryGeneration'],'content':metadata['contentRevision'],'source':dict(metadata['source'])}
        if frame_id not in self.recent_frames:self.recent_frames[frame_id]=self.reset_frames[frame_id]
        # Both indexes share the same <=32 metadata records; targeting entries
        # are always a subset of reset entries, and contain no prior pixels.
        while len(self.reset_frames)>32:
            expired=next(iter(self.reset_frames));self.reset_frames.pop(expired);self.recent_frames.pop(expired,None)

    def step(self):
        self.expire_target_scope()
        now=self.clock()
        t=1 if not self.duration else min(1,max(0,(now-self.motion_at)/self.duration))
        eased=t*t*(3-2*t)
        self.crop={k:self.start_crop[k]+(self.target[k]-self.start_crop[k])*eased for k in FULL}
        if t==1:self.duration=0
        expired=[k for k,v in self.annotations.items() if self.wall()*1000>=v['expiresAt']]
        for key in expired:del self.annotations[key]
        if self.context and self.wall()*1000>=self.context['expiresAt']: self.context=None; expired.append('context')
        if expired:self.revision+=1

    def invalidate_target_scope(self, command_id=None):
        if not self.target_scope or (command_id is not None and self.target_scope['commandId']!=command_id):return False
        self.target_scope=None;self.annotations.clear();self.context=None
        self.crop=dict(FULL);self.start_crop=dict(FULL);self.target=dict(FULL);self.duration=0.;self.revision+=1
        return True

    def expire_target_scope(self):
        scope=self.target_scope
        if scope and (self.clock()>=scope['deadline'] or not 0<=self.clock()-scope['confirmedAt']<=.25
            or self.paused or not self.meta or scope['geometryGeneration']!=self.meta['geometryGeneration']
            or scope['source']!=self.meta['source']):self.invalidate_target_scope()

    def renew_target_scope(self, command_id, confirmed_at):
        self.expire_target_scope()
        if not self.target_scope or self.target_scope['commandId']!=command_id or not 0<=self.clock()-confirmed_at<=.25:return False
        if confirmed_at<self.target_scope['confirmedAt']:return False
        self.target_scope['confirmedAt']=confirmed_at
        return True

    def present_target(self, command_id, target_rect, mark, duration, confirmed_at):
        """Internal atomic presentation transaction; no externally supplied frame references."""
        self.step()
        if self.pinned or self.paused or not 0<=self.clock()-confirmed_at<=.25:raise CameraError('Target presentation unavailable')
        staged=copy.copy(self)
        staged.__dict__={key:value if key in ('image','font','frozen','clock','wall') else copy.deepcopy(value) for key,value in self.__dict__.items()}
        prefix=hashlib.sha256(command_id.encode()).hexdigest()
        operations=[{'op':'clear'},{'op':'focus_region','rect':target_rect,'durationMs':duration,'automatic':True}]
        if mark is not None:operations.append({'op':'annotation_upsert','annotation':{**mark,'id':prefix+'_mark','rect':target_rect,'ttlMs':3000}})
        for index,extra in enumerate(operations):
            current=staged.status()
            result=staged.command({'version':1,'commandId':prefix+'_'+str(index),'expectedRevision':current['revision'],
                'sourceFrameId':current['sourceFrameId'],'geometryGeneration':current['geometryGeneration'],
                'contentRevision':current['contentRevision'],**extra})
            if result['state']!='accepted':raise CameraError('Target presentation superseded')
        if not 0<=self.clock()-confirmed_at<=.25:raise CameraError('Target witness expired')
        staged.target_scope={'commandId':command_id,'confirmedAt':confirmed_at,'deadline':self.clock()+3,
            'geometryGeneration':staged.meta['geometryGeneration'],'source':dict(staged.meta['source']),
            'annotationIds':[prefix+'_mark'] if mark is not None else []}
        self.__dict__.update(staged.__dict__)
        return self.status()

    def aim(self,target,duration):
        self.step(); self.start_crop=dict(self.crop); self.target=rect(target)
        self.duration=duration/1000; self.motion_at=self.clock()
        if not self.duration:self.crop=dict(self.target)

    def current(self):
        if self.paused:return self.frozen_info
        return (self.meta,self.frame_id,self.captured) if self.meta else None

    def effective_crop(self):
        info=self.current()
        if not info:return dict(self.crop)
        source=info[0]['source'];w=source['width'];h=source['height']
        x0=math.floor(self.crop['x']*w);y0=math.floor(self.crop['y']*h)
        x1=min(w,math.ceil((self.crop['x']+self.crop['width'])*w));y1=min(h,math.ceil((self.crop['y']+self.crop['height'])*h))
        return {'x':x0/w,'y':y0/h,'width':(x1-x0)/w,'height':(y1-y0)/h}

    def viewport(self):
        info=self.current()
        if not info:return {'x':0.,'y':64.,'width':1280.,'height':560.}
        source=info[0]['source'];crop=self.effective_crop();w=source['width']*crop['width'];h=source['height']*crop['height']
        scale=min(1280/w,560/h)
        return {'x':(1280-w*scale)/2,'y':64+(560-h*scale)/2,'width':w*scale,'height':h*scale}

    def status(self):
        self.step(); info=self.current(); meta,fid,at=info if info else (None,None,None)
        return {'version':1,'sessionId':self.binding['sessionId'],'deviceId':self.binding['deviceId'],'leaseId':self.binding['leaseId'],
            'revision':self.revision,'state':'paused' if self.paused and self.image else 'live' if self.image else 'unavailable',
            'surface':dict(self.selected),'sourceFrameId':fid,'capturedAt':at*1000 if at is not None else None,
            'geometryGeneration':meta['geometryGeneration'] if meta else None,'contentRevision':meta['contentRevision'] if meta else None,
            'crop':self.effective_crop(),'source':dict(meta['source']) if meta else None,
            'output':{'width':1280,'height':720,'viewport':self.viewport()},'pinned':self.pinned,'moving':bool(self.duration),
            'annotations':list(self.annotations.values()),'context':self.context}

    def command(self,cmd):
        if not isinstance(cmd,dict) or len(json.dumps(cmd))>8192:raise CameraError('Invalid camera command',400)
        common={'version','commandId','expectedRevision','sourceFrameId','geometryGeneration','op'}
        op=cmd.get('op'); extra={'focus_region':{'rect','durationMs','automatic'},'zoom_out':{'factor','durationMs'},
            'annotation_upsert':{'annotation'},'annotation_remove':{'annotationId'},'context':{'text','ttlMs'}}.get(op,set())
        if not common<=set(cmd) or set(cmd)-common-extra-{'contentRevision'} or op not in ('focus_region','zoom_out','overview','pin','unpin','freeze','resume','clear','annotation_upsert','annotation_remove','context'):
            raise CameraError('Invalid camera command',400)
        if type(cmd['version']) is not int or cmd['version']!=1 or not valid_id(cmd['commandId']) or type(cmd['expectedRevision']) is not int or cmd['expectedRevision']<0 or not valid_id(cmd['sourceFrameId']) or not valid_id(cmd['geometryGeneration']):
            raise CameraError('Invalid camera envelope',400)
        if 'contentRevision' in cmd and not valid_id(cmd['contentRevision']):raise CameraError('Invalid content revision',400)
        fingerprint=hashlib.sha256(json.dumps(cmd,sort_keys=True).encode()).hexdigest()
        if cmd['commandId'] in self.receipts:
            prior,receipt=self.receipts[cmd['commandId']]
            if prior!=fingerprint:raise CameraError('Command identity reused')
            return dict(receipt)
        self.step(); current=self.current()
        if not current or not self.image or self.wall()-self.captured>=2:raise CameraError('Fresh source frame required')
        self.prune_references()
        same_frame=cmd['sourceFrameId']==current[1]
        if 'contentRevision' in cmd:
            reset=self.reset_frames.get(cmd['sourceFrameId'])
            reset_matches=(op in ('clear','overview') and not self.paused and reset is not None
                and reset['content']==cmd['contentRevision']
                and reset['geometry']==current[0]['geometryGeneration'] and reset['source']==current[0]['source'])
            if cmd['contentRevision']!=current[0]['contentRevision'] and not reset_matches:
                raise CameraError('Source content changed; observe again')
            reference=self.recent_frames.get(cmd['sourceFrameId'])
            same_frame=same_frame or reset_matches or (not self.paused and reference is not None
                and reference['geometry']==current[0]['geometryGeneration']
                and reference['content']==current[0]['contentRevision']
                and reference['source']==current[0]['source'])
        if (cmd['expectedRevision']!=self.revision or not same_frame or cmd['geometryGeneration']!=current[0]['geometryGeneration']):
            raise CameraError('Presentation changed; observe again')
        self.rates=[at for at in self.rates if self.clock()-at<1]
        if len(self.rates)>=20:raise CameraError('Camera update rate exceeded',429)
        if self.paused and op not in ('resume','clear'):raise CameraError('Resume before changing paused camera')
        owned_scope=self.target_scope
        superseded=False
        if op=='focus_region':
            target=rect(cmd.get('rect')); duration=cmd.get('durationMs',450); automatic=cmd.get('automatic',False)
            if type(duration) is not int or not 0<=duration<=1500 or type(automatic) is not bool:raise CameraError('Invalid camera motion',400)
            superseded=self.pinned and automatic
            if not superseded:self.aim(target,duration)
        elif op=='zoom_out':
            factor=cmd.get('factor',2);duration=cmd.get('durationMs',450)
            if not number(factor) or not 1<=factor<=8 or type(duration) is not int or not 0<=duration<=1500:raise CameraError('Invalid zoom',400)
            w=min(1,self.crop['width']*factor);h=min(1,self.crop['height']*factor)
            self.aim({'x':max(0,min(1-w,self.crop['x']+(self.crop['width']-w)/2)), 'y':max(0,min(1-h,self.crop['y']+(self.crop['height']-h)/2)),'width':w,'height':h},duration)
        elif op=='overview':self.aim(FULL,450)
        elif op=='pin':self.pinned=True
        elif op=='unpin':self.pinned=False
        elif op=='freeze':
            self.paused=True;self.frozen=self.image.copy();self.frozen_info=(self.meta,self.frame_id,self.captured)
            self.aim(self.crop,0)
        elif op=='resume':self.paused=False;self.frozen=None;self.frozen_info=None;self.annotations.clear();self.context=None
        elif op=='clear':
            self.annotations.clear();self.context=None
            # Clearing overlays does not invalidate the current source. Retain
            # only its original metadata/ages so a following overview can race
            # an identical new frame without reviving earlier references.
            reference=self.recent_frames.get(current[1])
            self.recent_frames={current[1]:reference} if reference else {}
            reset=self.reset_frames.get(current[1])
            self.reset_frames={current[1]:reset} if reset else {}
        elif op=='annotation_upsert':
            item=annotation(cmd.get('annotation'))
            if item['id'] not in self.annotations and len(self.annotations)>=16:raise CameraError('Annotation count exceeded',429)
            self.annotations[item['id']]={**item,'expiresAt':self.wall()*1000+item['ttlMs']}
        elif op=='annotation_remove':
            if not valid_id(cmd.get('annotationId')):raise CameraError('Invalid annotation ID',400)
            self.annotations.pop(cmd['annotationId'],None)
        elif op=='context':self.context={'text':label(cmd.get('text')),'expiresAt':self.wall()*1000+ttl(cmd.get('ttlMs'))}
        if owned_scope and self.target_scope is owned_scope:
            # Only a successfully validated ordinary command takes ownership.
            for key in owned_scope['annotationIds']:
                if op!='annotation_upsert' or item['id']!=key:self.annotations.pop(key,None)
            self.target_scope=None
        self.revision+=1;self.rates.append(self.clock())
        receipt={'version':1,'commandId':cmd['commandId'],'revision':self.revision,'state':'superseded' if superseded else 'accepted'}
        self.receipts[cmd['commandId']]=(fingerprint,receipt)
        while len(self.receipts)>256:self.receipts.pop(next(iter(self.receipts)))
        return dict(receipt)

    def map_input(self,reference,x,y):
        state=self.status()
        if (not isinstance(reference,dict) or set(reference)!={'revision','sourceFrameId','geometryGeneration'} or
            any(reference[k]!=state[k] for k in reference) or state['state']!='live' or state['moving'] or
            not self.image or self.wall()-self.captured>=2 or not number(x) or not number(y) or not 0<=x<=1 or not 0<=y<=1):
            raise CameraError('Fresh stable unpaused presentation required')
        v=state['output']['viewport'];px=x*1280;py=y*720
        if not v['x']-1e-9<=px<=v['x']+v['width']+1e-9 or not v['y']-1e-9<=py<=v['y']+v['height']+1e-9:raise CameraError('Input is outside source viewport')
        crop=state['crop']
        return max(0,min(1,crop['x']+(px-v['x'])/v['width']*crop['width'])),max(0,min(1,crop['y']+(py-v['y'])/v['height']*crop['height']))

    def render_snapshot(self):
        # Source Images are immutable after accept; the snapshot retains only one
        # reference while mutable presentation dictionaries are detached.
        return (copy.deepcopy(self.status()),self.frozen if self.paused else self.image,self.font,self.wall())

    def render(self):return self.render_from_snapshot(self.render_snapshot())

    @staticmethod
    def render_from_snapshot(snapshot):
        state,image,font,wall=snapshot
        canvas=Image.new('RGBA',(1280,720),'#101722');draw=ImageDraw.Draw(canvas)
        if state['state']=='unavailable':
            draw.text((40,90),'Screen unavailable · select an authorized fresh surface',font=font,fill='white');return canvas
        crop=state['crop'];x0=round(crop['x']*image.width);y0=round(crop['y']*image.height)
        x1=max(x0+1,round((crop['x']+crop['width'])*image.width));y1=max(y0+1,round((crop['y']+crop['height'])*image.height))
        v=state['output']['viewport'];tile=image.crop((x0,y0,x1,y1)).resize((max(1,round(v['width'])),max(1,round(v['height']))),Image.Resampling.LANCZOS)
        canvas.paste(tile,(round(v['x']),round(v['y'])))
        layer=Image.new('RGBA',(1280,720));marks=ImageDraw.Draw(layer)
        def point(x,y):return (v['x']+(x-crop['x'])/crop['width']*v['width'],v['y']+(y-crop['y'])/crop['height']*v['height'])
        for item in state['annotations']:
            r=item['rect'];a=point(r['x'],r['y']);b=point(r['x']+r['width'],r['y']+r['height'])
            if item['kind'] in ('rectangle','highlight'):marks.rectangle((*a,*b),outline='#ffca62',width=4,fill=(255,202,98,40) if item['kind']=='highlight' else None)
            elif item['kind'] in ('pointer','arrow'):
                marks.line((*a,*b),fill='#ffca62',width=4)
                if item['kind']=='arrow':
                    angle=math.atan2(b[1]-a[1],b[0]-a[0]);length=16
                    marks.polygon([b,(b[0]-length*math.cos(angle-.45),b[1]-length*math.sin(angle-.45)),
                        (b[0]-length*math.cos(angle+.45),b[1]-length*math.sin(angle+.45))],fill='#ffca62')
                else:marks.ellipse((b[0]-6,b[1]-6,b[0]+6,b[1]+6),fill='#ffca62')
            if item.get('text'):
                text=item['text'];tx=max(v['x']+5,min(a[0],v['x']+v['width']-10));ty=max(v['y']+5,min(a[1]-30,v['y']+v['height']-30))
                while text and marks.textlength(text,font=font)>v['x']+v['width']-tx-5:text=text[:-1]
                marks.rectangle((tx-3,ty-2,tx+marks.textlength(text,font=font)+3,ty+28),fill='#101722');marks.text((tx,ty),text,font=font,fill='white')
        # Clip every overlay to the source viewport, never leak into labels/captions.
        clip=(round(v['x']),round(v['y']),round(v['x']+v['width']),round(v['y']+v['height']))
        canvas.alpha_composite(layer.crop(clip),dest=clip[:2]);draw=ImageDraw.Draw(canvas)
        age=max(0,int(wall-state['capturedAt']/1000))
        title=('Paused · '+str(age)+'s old' if state['state']=='paused' else 'Live view') + (' · Pinned' if state['pinned'] else '')
        draw.text((24,20),title,font=font,fill='#82e8bd')
        text=state['context']['text'] if state['context'] else 'Ask to focus on a detail.'
        while text and draw.textlength(text,font=font)>1232:text=text[:-1]
        draw.text((24,654),text,font=font,fill='white')
        return canvas
