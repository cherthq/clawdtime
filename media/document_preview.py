"""Transient first-page preview from an authenticated, selected local artifact.

No desktop capture/control authority is created. The backend binds the immutable
source artifact and local grant; this layer verifies policy, bytes and lifetime.
"""
import asyncio
from datetime import datetime
import hashlib
import io
import re
import time

from aiohttp import ClientTimeout
from PIL import Image, ImageDraw, ImageOps
from captions import WIDTH, HEIGHT, CaptionRenderer, clean_text

MAX_BYTES = 2 * 1024 * 1024


class DocumentPreview:
    def __init__(self, session, *, clock=time.monotonic, utc=time.time):
        self.session, self.clock, self.utc = session, clock, utc
        self.spec = None
        self.image = None
        self.task = None
        self.revision = 0
        self.policy_at = self.deadline = 0.
        self.retired = set()
        self.renderer = None

    def clear(self):
        if self.spec:
            self.retired.add(self.spec['previewId'])
        self.spec = None
        self.image = None
        self.revision += 1
        if self.task and not self.task.done() and self.task is not asyncio.current_task():
            self.task.cancel()
        self.task = None

    def valid(self, policy):
        value = policy.get('documentPreview')
        if (not isinstance(value, dict) or value.get('version') != 1
                or type(value.get('version')) is not int or policy.get('protocolVersion') != 2
                or self.session.audio_qualification or policy.get('audioQualification') is not None
                or policy.get('callId') != self.session.call_id or value.get('callId') != self.session.call_id
                or value.get('sessionId') != policy.get('sessionId')
                or (getattr(self.session,'document_only',False) and
                    value.get('sessionId') != self.session.spec.get('documentSessionId'))
                or policy.get('screenSelection') is not None or policy.get('state') != 'listening'
                or policy.get('muted') is True or self.session.pause_latched or self.session.closing):
            return None
        for key in ('previewId', 'artifactId', 'sessionId'):
            if not isinstance(value.get(key), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', value[key]):
                return None
        if (value['previewId'] in self.retired or len(self.retired) >= 128
                or type(value.get('page')) is not int or value['page'] != 1
                or type(value.get('pageCount')) is not int or value['pageCount'] != 1):
            return None
        for key in ('sha256', 'imageSha256'):
            if not isinstance(value.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', value[key]):
                return None
        if not isinstance(value.get('label'), str) or not 0 < len(value['label']) <= 120:
            return None
        try:
            expiry = datetime.fromisoformat(value['expiresAt'].replace('Z','+00:00'))
            if expiry.tzinfo is None or not 0 < expiry.timestamp()-self.utc() <= 120:
                return None
        except (ValueError, TypeError, KeyError, AttributeError):
            return None
        return dict(value)

    def update(self, policy):
        spec = self.valid(policy)
        if spec is None:
            if self.spec: self.clear()
            return
        if self.spec == spec:
            self.policy_at = self.clock()
            return
        if self.spec and self.spec['previewId'] == spec['previewId']:
            self.clear()  # Identity cannot be reused with different source/image/expiry.
            return
        self.clear()
        self.spec = spec
        self.policy_at = self.clock()
        self.deadline = self.clock()+datetime.fromisoformat(spec['expiresAt'].replace('Z','+00:00')).timestamp()-self.utc()
        self.task = asyncio.create_task(self.load(spec))

    def expire(self):
        if self.spec and (self.clock() >= self.deadline or self.clock()-self.policy_at >= 2
                or not self.session.active or self.session.closing or self.session.pause_latched):
            self.clear()

    async def load(self, spec):
        try:
            owner = self.session.owner
            path = f"/media/{self.session.id}/document-preview/{spec['previewId']}"
            async with owner.http.get(owner.env['BACKEND_URL']+path,
                    headers={'Authorization':'Bearer '+owner.env['MEDIA_API_KEY']},
                    allow_redirects=False, timeout=ClientTimeout(total=1.5)) as response:
                if response.status != 200 or response.headers.get('Content-Type','').split(';')[0] != 'image/png':
                    raise ValueError('Preview unavailable')
                parts, size = [], 0
                async for part in response.content.iter_chunked(65536):
                    size += len(part)
                    if size > MAX_BYTES: raise ValueError('Preview exceeds byte bound')
                    parts.append(part)
                raw = b''.join(parts)
            if hashlib.sha256(raw).hexdigest() != spec['imageSha256']:
                raise ValueError('Preview digest mismatch')
            with Image.open(io.BytesIO(raw)) as original:
                if original.format != 'PNG' or original.width > 4096 or original.height > 4096 or original.width*original.height > 8_000_000:
                    raise ValueError('Preview exceeds image bound')
                original.load()
                image = ImageOps.contain(original.convert('RGBA'), (WIDTH-48, HEIGHT-100))
            self.expire()
            if self.spec == spec:
                self.image = image
                self.revision += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.spec == spec: self.clear()

    def render(self):
        self.expire()
        canvas = Image.new('RGBA', (WIDTH, HEIGHT), '#0b1220')
        if not self.image or not self.spec: return canvas
        if self.renderer is None: self.renderer = CaptionRenderer()
        draw = ImageDraw.Draw(canvas)
        draw.text((24,18), clean_text(self.spec['label'],120), font=self.renderer.label_font, fill='white')
        draw.text((24,HEIGHT-36), 'First page preview', font=self.renderer.label_font, fill='#b5c3d7')
        canvas.alpha_composite(self.image, ((WIDTH-self.image.width)//2, 60))
        return canvas

    async def close(self):
        task = self.task
        self.clear()
        if task: await asyncio.gather(task, return_exceptions=True)
