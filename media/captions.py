"""Ephemeral, policy-scoped captions on one Chert-facing video publication.

Provisional hearing, confirmed delivery and agent speech are distinct. Pixels and
text are transient and are never persisted or treated as executable instructions.
A fresh backend policy lease is required for every frame.
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
        self.preview = ''
        self.feedback = 'listening'
        self.pending_sequence = None
        self.agent_text = ''
        self.subtitle_at = self.clock()

    def clear(self, state):
        if self.state != state or self.segments or self.preview or self.agent_text:
            self.revision += 1
            self.epoch += 1
        self.state = state
        self.segments.clear()
        self.preview = self.agent_text = ''
        self.feedback = 'listening'
        self.pending_sequence = None
        self.policy_at = None

    def apply_policy(self, policy, speaking=False):
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
        elif policy.get('state') == 'paused' or policy.get('muted') is True:
            self.clear('paused')
        elif capture_allowed(policy):
            target = 'speaking' if speaking else 'listening'
            if self.state not in ('listening', 'speaking'):
                self.segments.clear()
                self.preview = self.agent_text = ''
                self.feedback = 'listening'
                self.epoch += 1
            if self.state != target:
                self.revision += 1
            self.state = target
            self.policy_at = self.clock()
        else:
            self.clear('reconnecting')

    def snapshot(self):
        if self.state in ('listening', 'speaking') and (self.policy_at is None or self.clock() - self.policy_at >= POLICY_TTL):
            self.clear('reconnecting')
        return {'title': self.title, 'state': self.state,
                'segments': list(self.segments), 'revision': self.revision,
                'preview': self.preview, 'feedback': self.feedback, 'agentText': self.agent_text,
                'page': max(0, int((self.clock() - self.subtitle_at) / 5))}

    def hearing(self, text):
        if self.snapshot()['state'] != 'listening':
            return
        text = clean_text(text, 8000)[-500:]
        if self.preview != text or self.feedback != 'hearing':
            self.preview, self.feedback = text, 'hearing'
            self.agent_text = ''
            self.pending_sequence = None
            self.revision += 1
            self.subtitle_at = self.clock()

    def silence(self):
        if self.feedback == 'hearing' and not self.preview:
            self.feedback = 'listening'
            self.revision += 1

    def delivery(self, state, segment=None):
        if state not in ('sending', 'received', 'unconfirmed', 'incomplete'):
            raise ValueError('Unknown caption delivery state')
        if self.snapshot()['state'] != 'listening':
            return
        sequence = segment.get('id') if segment else None
        if state == 'sending':
            self.preview = clean_text(segment.get('text'), 8000)[-500:]
            self.pending_sequence = sequence
            self.agent_text = ''
        elif segment and sequence != self.pending_sequence:
            return  # An older callback must not replace a newer spoken continuation.
        if state == 'incomplete':
            self.preview = ''
        self.feedback = state
        self.subtitle_at = self.clock()
        self.revision += 1

    def speaking(self, text):
        if self.snapshot()['state'] not in ('listening', 'speaking'):
            return
        self.state = 'speaking'
        self.epoch += 1  # An in-flight pre-playback callback cannot repopulate captions.
        self.agent_text = clean_text(text, 1640)
        self.preview = ''
        self.subtitle_at = self.clock()
        self.revision += 1

    def finish_speaking(self, completed):
        if self.snapshot()['state'] != 'speaking':
            return
        self.state = 'listening'
        if not completed:
            self.agent_text = ''
        self.revision += 1

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

    def lines(self, segments, limit=9):
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
        return lines[-limit:] if limit is not None else lines

    def subtitle(self, snapshot, line_count=4):
        state = snapshot['state']
        feedback = snapshot.get('feedback', 'listening')
        if state not in ('listening', 'speaking'):
            label, text = {
                'connecting':('Connecting', 'Your agent will be here shortly.'),
                'reconnecting':('Reconnecting audio', 'Waiting for a fresh connection.'),
                'paused':('Microphone paused', 'Audio capture and captions are paused.'),
                'ended':('Call ended', 'Audio capture has stopped.'),
                'unavailable':('Captions unavailable', 'Check this chat to continue.')
            }.get(state, ('Captions unavailable', 'Check this chat to continue.'))
            return label, self.lines([text], limit=line_count)
        if snapshot.get('agentText'):
            label = 'Agent speaking · mic paused' if state == 'speaking' else 'Listening · your turn'
            lines = self.lines([snapshot['agentText']], limit=None)
            pages = max(1, (len(lines) + line_count - 1) // line_count)
            page = snapshot.get('page', 0) % pages
            return label, lines[page*line_count:(page+1)*line_count]
        labels = {'listening':'Listening · your turn', 'hearing':'You · hearing (partial)',
                  'sending':'You · sending', 'received':'You · received',
                  'unconfirmed':'Delivery unconfirmed', 'incomplete':'Please repeat that'}
        text = snapshot.get('preview')
        if not text and feedback == 'received' and snapshot['segments']:
            text = snapshot['segments'][-1]
        if not text:
            text = {'hearing':'Hearing audio. Waiting for words…',
                    'unconfirmed':'Check this chat before asking again.',
                    'incomplete':'I could not capture a complete request.'}.get(feedback,
                    'Say what you need. Your words will appear here.')
        return labels.get(feedback, labels['listening']), self.lines([text], limit=line_count)

    def overlay(self, image, snapshot):
        # Keep the desktop visible; essential captions remain inside a portrait crop.
        label, lines = self.subtitle(snapshot)
        if not label:
            return image
        image = image.convert('RGBA').copy()
        layer = Image.new('RGBA', image.size)
        draw = ImageDraw.Draw(layer)
        draw.rounded_rectangle((438, 396, 842, 664), radius=18, fill=(12,16,23,238))
        draw.text((472,410), label, font=self.label_font, fill='#64dfaa')
        for index, line in enumerate(lines):
            draw.text((472,442+43*index),line,font=self.body_font,fill='white')
        footer = ('Mic resumes after reply' if snapshot['state'] == 'speaking' else
                  'Say Stop to stop sharing' if snapshot['state'] == 'listening' else 'Check this chat to continue')
        draw.text((472,633),footer,font=self.label_font,fill='#b5c3d7')
        return Image.alpha_composite(image,layer)

    def render(self, snapshot):
        # Center-safe for a 9:16 phone crop of the 16:9 transport. All essential
        # text stays within 336 px and the top/bottom call-control safe insets.
        image = Image.new('RGBA', (WIDTH, HEIGHT), '#0c1017')
        draw = ImageDraw.Draw(image)
        state = snapshot['state']
        active = state in ('listening', 'speaking')
        draw.rounded_rectangle((438, 56, 842, 664), radius=24, fill='#161d28')
        def centered(text, y, font, color):
            while text and draw.textlength(text, font=font)>336:
                text=text[:-1]
            draw.text((640-draw.textlength(text,font=font)/2,y),text,font=font,fill=color)
        centered('CLAWDTIME', 78, self.label_font, '#b5c3d7')
        labels = {'listening': 'Listening', 'speaking': 'Agent speaking · mic paused', 'connecting': 'Connecting', 'paused': 'Paused',
                  'reconnecting': 'Reconnecting', 'ended': 'Call ended', 'unavailable': 'Unavailable'}
        label, spoken_lines = self.subtitle(snapshot, 9)
        centered(label or labels.get(state,'Unavailable'),104,self.label_font,'#46d28d' if active else '#b5c3d7')
        centered(snapshot['title'] if active else 'ClawdTime attention', 134,self.title_font,'#ffffff')
        draw.line((472,174,808,174),fill='#344154',width=2)
        if active:
            lines=spoken_lines
        else:
            lines={'connecting':['Connecting to your','agent…'],
                   'speaking':['Please wait until','listening resumes.'],
                   'paused':['Audio capture and','captions are paused.'],
                   'reconnecting':['Waiting for a fresh','connection.'],
                   'ended':['Your agent’s result will','arrive in Messages.'],
                   'unavailable':['Live captions are','not available.']}.get(state,['Unavailable.'])
        for index,line in enumerate(lines):
            draw.text((472,191+43*index),line,font=self.body_font,fill='#ffffff' if active else '#b5c3d7')
        centered('FaceTime audio',605,self.label_font,'#9aa7ba')
        centered('Say Stop to stop sharing',630,self.label_font,'#9aa7ba')
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
        revision = (snapshot['revision'], snapshot['page'], self.screen.revision if self.screen else None, use_screen)
        if revision != self.last_revision:
            image = self.renderer.overlay(self.screen.render(), snapshot) if use_screen else self.renderer.render(snapshot)
            self.frame = self.sdk.VideoFrame(WIDTH, HEIGHT, self.sdk.VideoBufferType.RGBA, image.tobytes())
            self.last_revision = revision
        self.source.capture_frame(self.frame)
        if self.screen:
            self.screen.diagnostics.emitted(screen=bool(self.screen.frame))

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
