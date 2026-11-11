"""Ephemeral, policy-scoped captions on one Chert-facing video publication.

Only authenticated, backend-accepted final segments enter this scene. Pixels and
text are not persisted. A fresh backend policy lease is required for every frame.
"""
import asyncio
import contextlib
import logging
import re
import time
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from policy import capture_allowed

WIDTH, HEIGHT, FPS = 1280, 720, 5
POLICY_TTL = 2.0


def clean_text(value, limit):
    if not isinstance(value, str):
        return ''
    # Do not let control characters or directional overrides rearrange the scene.
    value = ''.join(c for c in value if not unicodedata.category(c).startswith('C'))
    return re.sub(r'\s+', ' ', value).strip()[:limit]


class CaptionScene:
    def __init__(self, meeting_id, clock=time.monotonic):
        self.meeting_id, self.clock = meeting_id, clock
        self.call_id = None
        self.title = 'ClawdTime attention'
        self.state = 'connecting'
        self.segments = []
        self.last_sequence = 0
        self.policy_at = None
        self.revision = 0
        self.epoch = 0

    def clear(self, state):
        if self.state != state or self.segments:
            self.revision += 1
            self.epoch += 1
        self.state = state
        self.segments.clear()
        self.policy_at = None

    def apply_policy(self, policy):
        call_id = policy.get('callId')
        if not isinstance(call_id, str) or not call_id:
            self.clear('reconnecting')
            return
        if self.call_id is not None and call_id != self.call_id:
            self.clear('unavailable')
            return
        self.call_id = call_id
        title = clean_text(policy.get('title'), 100) or 'ClawdTime attention'
        if self.title != title:
            self.title = title
            self.revision += 1
        if policy.get('captionsEnabled') is not True:
            self.clear('unavailable')
        elif policy.get('state') == 'ended':
            self.clear('ended')
        elif policy.get('state') == 'paused':
            self.clear('paused')
        elif capture_allowed(policy):
            if self.state != 'listening':
                self.segments.clear()
                self.revision += 1
                self.epoch += 1
            self.state = 'listening'
            self.policy_at = self.clock()
        else:
            self.clear('reconnecting')

    def snapshot(self):
        if self.state == 'listening' and (self.policy_at is None or self.clock() - self.policy_at >= POLICY_TTL):
            self.clear('reconnecting')
        return {'title': self.title, 'state': self.state,
                'segments': list(self.segments), 'revision': self.revision}

    def append(self, segment):
        raw_id = segment.get('id')
        if not isinstance(raw_id, str) or not re.fullmatch(r'[1-9][0-9]{0,7}', raw_id):
            return False
        sequence = int(raw_id)
        if sequence <= self.last_sequence:
            return False
        # Remember rejected sequences too: delayed delivery after a pause must
        # never redisplay older private text when capture resumes.
        self.last_sequence = sequence
        if self.snapshot()['state'] != 'listening':
            return False
        text = clean_text(segment.get('text'), 500)
        if not text:
            return False
        self.segments = (self.segments + [text])[-3:]
        self.revision += 1
        return True


class CaptionRenderer:
    def __init__(self):
        paths = [Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
                 Path('/System/Library/Fonts/Supplemental/Arial.ttf')]
        font = next((str(p) for p in paths if p.is_file()), 'DejaVuSans.ttf')
        # Fail explicitly if the image lacks the font; tiny bitmap fallback is
        # not usable for live captions. The container installs DejaVu Sans.
        self.body_font = ImageFont.truetype(font, 34)
        self.title_font = ImageFont.truetype(font, 24)
        self.label_font = ImageFont.truetype(font, 18)
        self.measure_draw = ImageDraw.Draw(Image.new('RGB', (1, 1)))

    def measure(self, text):
        return self.measure_draw.textlength(text, font=self.body_font)

    def lines(self, segments):
        lines = []
        for text in segments:
            line = ''
            for word in text.split():
                # Split a pathological no-space token without ever drawing out
                # of bounds. Normal words remain intact.
                pieces, piece = [], ''
                for char in word:
                    if piece and self.measure(piece + char) > 336:
                        pieces.append(piece)
                        piece = char
                    else:
                        piece += char
                if piece:
                    pieces.append(piece)
                for piece in pieces:
                    candidate = (line + ' ' + piece).strip()
                    if line and self.measure(candidate) > 336:
                        lines.append(line)
                        line = piece
                    else:
                        line = candidate
            if line:
                lines.append(line)
        return lines[-9:]

    def render(self, snapshot):
        # Center-safe for a 9:16 phone crop of the 16:9 transport. All essential
        # text stays within 336 px and the top/bottom call-control safe insets.
        image = Image.new('RGBA', (WIDTH, HEIGHT), '#0c1017')
        draw = ImageDraw.Draw(image)
        state = snapshot['state']
        active = state == 'listening'
        draw.rounded_rectangle((438, 56, 842, 664), radius=24, fill='#161d28')
        def centered(text, y, font, color):
            while text and draw.textlength(text, font=font)>336:
                text=text[:-1]
            draw.text((640-draw.textlength(text,font=font)/2,y),text,font=font,fill=color)
        centered('CLAWDTIME', 78, self.label_font, '#b5c3d7')
        labels = {'listening': 'Live captions', 'connecting': 'Connecting', 'paused': 'Paused',
                  'reconnecting': 'Reconnecting', 'ended': 'Call ended', 'unavailable': 'Unavailable'}
        centered(labels.get(state,'Unavailable'),104,self.label_font,'#46d28d' if active else '#b5c3d7')
        centered(snapshot['title'] if active else 'ClawdTime attention', 134,self.title_font,'#ffffff')
        draw.line((472,174,808,174),fill='#344154',width=2)
        if active:
            lines=self.lines(snapshot['segments']) or ['Listening for the', 'next sentence.']
        else:
            lines={'connecting':['Captions begin after','the recording notice.'],
                   'paused':['Audio capture and','captions are paused.'],
                   'reconnecting':['Waiting for a fresh','connection.'],
                   'ended':['Your agent’s result will','arrive in Messages.'],
                   'unavailable':['Live captions are','not available.']}.get(state,['Unavailable.'])
        for index,line in enumerate(lines):
            draw.text((472,191+43*index),line,font=self.body_font,fill='#ffffff' if active else '#b5c3d7')
        centered('FaceTime audio',605,self.label_font,'#9aa7ba')
        centered('Speaker identities unverified',630,self.label_font,'#9aa7ba')
        return image


class CaptionPublisher:
    def __init__(self, scene, room, sdk=None, screen=None):
        if sdk is None:
            from livekit import rtc
            sdk = rtc
        self.scene, self.room, self.sdk = scene, room, sdk
        self.screen = screen
        self.renderer = CaptionRenderer()
        self.source = None
        self.publication = None
        self.task = None
        self.closed = False
        self.failed = False
        self.last_revision = None
        self.frame = None
        self.dispose_lock = asyncio.Lock()

    def emit(self):
        snapshot = self.scene.snapshot()
        if self.screen:
            self.screen.expire()
        use_screen = bool(self.screen and (self.screen.screen_call or self.screen.selection or self.screen.starting))
        revision = (snapshot['revision'], self.screen.revision if self.screen else None, use_screen)
        if revision != self.last_revision:
            image = self.screen.render() if use_screen else self.renderer.render(snapshot)
            self.frame = self.sdk.VideoFrame(WIDTH, HEIGHT, self.sdk.VideoBufferType.RGBA, image.tobytes())
            self.last_revision = revision
        self.source.capture_frame(self.frame)

    async def start(self):
        if self.source or self.closed:
            raise RuntimeError('Caption publisher cannot restart')
        self.source = self.sdk.VideoSource(WIDTH, HEIGHT)
        try:
            track = self.sdk.LocalVideoTrack.create_video_track('clawdtime-screen', self.source)
            options = self.sdk.TrackPublishOptions(source=self.sdk.TrackSource.SOURCE_CAMERA,
                simulcast=False, video_encoding=self.sdk.VideoEncoding(max_framerate=FPS, max_bitrate=1500000),
                video_codec=self.sdk.VideoCodec.H264)
            self.publication = await self.room.local_participant.publish_track(track, options)
            self.emit()
            self.task = asyncio.create_task(self.run())
        except BaseException:
            await self.dispose()
            raise

    async def run(self):
        try:
            while not self.closed:
                await asyncio.sleep(1 / FPS)
                self.emit()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            self.scene.clear('unavailable')
            logging.error('caption_video_failed')
            # Caption rendering failure must not discard the independently
            # functioning audio call; remove the video publication instead.
            with contextlib.suppress(Exception):
                self.emit()
            await self.dispose()
            if self.screen:
                if self.screen.selection:
                    await self.screen.terminal(dict(self.screen.selection), 'video_unavailable')
                await self.screen.close()

    async def dispose(self):
        async with self.dispose_lock:
            if self.publication:
                publication, self.publication = self.publication, None
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.room.local_participant.unpublish_track(publication.sid), 3)
            if self.source:
                source, self.source = self.source, None
                await source.aclose()
            self.frame = None

    async def close(self):
        self.closed = True
        self.scene.clear('ended')
        if self.source:
            with contextlib.suppress(Exception):
                self.emit()
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.dispose()
