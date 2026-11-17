"""Independent general screen camera. Pixels and labels are memory-only.

The caller owns authorization. Every lifecycle loss must call clear(); freeze
never creates authority. This renderer never dispatches input or changes an app.
"""
import base64
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
    # A selected window must remain wholly on its authorized display.
    if (source['originX']<source['displayOriginX'] or source['originY']<source['displayOriginY'] or
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
        self.font=ImageFont.truetype(next((str(p) for p in [Path('/System/Library/Fonts/Supplemental/Arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.is_file()),'DejaVuSans.ttf'),22)

    def clear(self):
        self.image=None; self.meta=None; self.frame_id=None; self.captured=None
        self.paused=False; self.frozen=None; self.frozen_info=None
        self.annotations.clear(); self.context=None; self.pinned=False
        self.crop=dict(FULL); self.target=dict(FULL); self.duration=0; self.revision+=1

    def accept(self,image,frame_id,captured,metadata):
        metadata=frame_metadata(metadata,self.selected,*image.size)
        if not valid_id(frame_id) or not number(captured) or not -.5<=self.wall()-captured<2:
            raise CameraError('Stale source frame')
        if self.meta and self.meta['geometryGeneration']!=metadata['geometryGeneration']:
            self.clear()
        if self.meta and self.meta['contentRevision']!=metadata['contentRevision']:
            if self.annotations or self.context: self.revision+=1
            self.annotations.clear(); self.context=None
        self.image=image; self.meta=metadata; self.frame_id=frame_id; self.captured=captured

    def step(self):
        now=self.clock()
        t=1 if not self.duration else min(1,max(0,(now-self.motion_at)/self.duration))
        eased=t*t*(3-2*t)
        self.crop={k:self.start_crop[k]+(self.target[k]-self.start_crop[k])*eased for k in FULL}
        if t==1:self.duration=0
        expired=[k for k,v in self.annotations.items() if self.wall()*1000>=v['expiresAt']]
        for key in expired:del self.annotations[key]
        if self.context and self.wall()*1000>=self.context['expiresAt']: self.context=None; expired.append('context')
        if expired:self.revision+=1

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
        if not common<=set(cmd) or set(cmd)-common-extra or op not in ('focus_region','zoom_out','overview','pin','unpin','freeze','resume','clear','annotation_upsert','annotation_remove','context'):
            raise CameraError('Invalid camera command',400)
        if type(cmd['version']) is not int or cmd['version']!=1 or not valid_id(cmd['commandId']) or type(cmd['expectedRevision']) is not int or cmd['expectedRevision']<0 or not valid_id(cmd['sourceFrameId']) or not valid_id(cmd['geometryGeneration']):
            raise CameraError('Invalid camera envelope',400)
        fingerprint=hashlib.sha256(json.dumps(cmd,sort_keys=True).encode()).hexdigest()
        if cmd['commandId'] in self.receipts:
            prior,receipt=self.receipts[cmd['commandId']]
            if prior!=fingerprint:raise CameraError('Command identity reused')
            return dict(receipt)
        self.step(); current=self.current()
        if not current or not self.image or self.wall()-self.captured>=2:raise CameraError('Fresh source frame required')
        if (cmd['expectedRevision']!=self.revision or cmd['sourceFrameId']!=current[1] or cmd['geometryGeneration']!=current[0]['geometryGeneration']):
            raise CameraError('Presentation changed; observe again')
        self.rates=[at for at in self.rates if self.clock()-at<1]
        if len(self.rates)>=20:raise CameraError('Camera update rate exceeded',429)
        if self.paused and op not in ('resume','clear'):raise CameraError('Resume before changing paused camera')
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
        elif op=='clear':self.annotations.clear();self.context=None
        elif op=='annotation_upsert':
            item=annotation(cmd.get('annotation'))
            if item['id'] not in self.annotations and len(self.annotations)>=16:raise CameraError('Annotation count exceeded',429)
            self.annotations[item['id']]={**item,'expiresAt':self.wall()*1000+item['ttlMs']}
        elif op=='annotation_remove':
            if not valid_id(cmd.get('annotationId')):raise CameraError('Invalid annotation ID',400)
            self.annotations.pop(cmd['annotationId'],None)
        elif op=='context':self.context={'text':label(cmd.get('text')),'expiresAt':self.wall()*1000+ttl(cmd.get('ttlMs'))}
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

    def render(self):
        state=self.status();canvas=Image.new('RGBA',(1280,720),'#101722');draw=ImageDraw.Draw(canvas)
        if state['state']=='unavailable':
            draw.text((40,90),'Screen unavailable · select an authorized fresh surface',font=self.font,fill='white');return canvas
        image=self.frozen if self.paused else self.image
        crop=state['crop'];x0=round(crop['x']*image.width);y0=round(crop['y']*image.height)
        x1=max(x0+1,round((crop['x']+crop['width'])*image.width));y1=max(y0+1,round((crop['y']+crop['height'])*image.height))
        v=state['output']['viewport'];tile=image.crop((x0,y0,x1,y1)).resize((max(1,round(v['width'])),max(1,round(v['height']))),Image.Resampling.LANCZOS)
        canvas.paste(tile,(round(v['x']),round(v['y'])))
        layer=Image.new('RGBA',(1280,720));marks=ImageDraw.Draw(layer)
        def point(x,y):return (v['x']+(x-crop['x'])/crop['width']*v['width'],v['y']+(y-crop['y'])/crop['height']*v['height'])
        for item in self.annotations.values():
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
                while text and marks.textlength(text,font=self.font)>v['x']+v['width']-tx-5:text=text[:-1]
                marks.rectangle((tx-3,ty-2,tx+marks.textlength(text,font=self.font)+3,ty+28),fill='#101722');marks.text((tx,ty),text,font=self.font,fill='white')
        # Clip every overlay to the source viewport, never leak into labels/captions.
        clip=(round(v['x']),round(v['y']),round(v['x']+v['width']),round(v['y']+v['height']))
        canvas.alpha_composite(layer.crop(clip),dest=clip[:2]);draw=ImageDraw.Draw(canvas)
        age=max(0,int(self.wall()-state['capturedAt']/1000))
        title=f"{'Paused · '+str(age)+'s old' if self.paused else 'Live selected surface'} · {self.selected['kind']} {self.selected['id']}" + (' · Pinned' if self.pinned else '')
        draw.text((24,20),title,font=self.font,fill='#82e8bd')
        text=self.context['text'] if self.context else 'Camera only · native approvals and input ownership remain required'
        while text and draw.textlength(text,font=self.font)>1232:text=text[:-1]
        draw.text((24,654),text,font=self.font,fill='white')
        return canvas
