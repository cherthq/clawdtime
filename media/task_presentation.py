"""Independent task presentation. Exact window pixels stay in memory.

No calls, OS input, foreground activation, automatic retry or capture on prepare.
"""
import asyncio
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import time
import uuid

from PIL import Image, ImageDraw, ImageFont
from task_voice import VoiceError, bounded_body
from task_presentation_diagnostics import PresentationDiagnostics

ID = re.compile(r'[A-Za-z0-9_-]{1,200}')
HASH = re.compile(r'[a-f0-9]{64}')
WIDTH, HEIGHT, FPS = 1280, 720, 15


def fail():
    raise VoiceError('presentation_refused')


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def identity(value):
    return isinstance(value, str) and ID.fullmatch(value)


def target(value):
    exact(value, ('appId', 'windowId', 'ownerPid', 'processIdentity', 'displayId', 'titleHash'))
    if (not isinstance(value['appId'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,159}', value['appId'])
            or not isinstance(value['windowId'], str) or not re.fullmatch(r'[1-9][0-9]{0,9}', value['windowId'])
            or not 0 < int(value['windowId']) <= 0xffffffff
            or type(value['ownerPid']) is not int or not 0 < value['ownerPid'] <= 0x7fffffff
            or type(value['displayId']) is not int or not 0 < value['displayId'] <= 0xffffffff
            or any(not isinstance(value[k], str) or not HASH.fullmatch(value[k]) for k in ('processIdentity', 'titleHash'))):
        fail()
    return value


def validate_prepare(value):
    exact(value, ('presentationId', 'manifest', 'grant', 'fingerprint'))
    manifest, grant = value['manifest'], value['grant']
    exact(manifest, ('version', 'id', 'sessionId', 'taskId', 'runId', 'taskRevision', 'verificationId', 'kind', 'opening', 'fps', 'scenes'))
    exact(grant, {'version', 'id', 'manifestFingerprint', 'sessionId', 'taskId', 'runId', 'taskRevision', 'hostId', 'authorizedAt', 'expiresAt', 'localOnly', 'capture', 'presentation', 'control', 'nativeActivation', 'calls'}
          | ({'continuity'} if 'continuity' in grant else set()))
    if 'continuity' in grant and grant['continuity'] != 'call':
        fail()
    if (not identity(value['presentationId']) or manifest['id'] != value['presentationId']
            or manifest['version'] != 1 or type(manifest['version']) is not int or manifest['fps'] != 15
            or type(grant['version']) is not int or grant['version'] != 1
            or not isinstance(value['fingerprint'], str) or not HASH.fullmatch(value['fingerprint'])
            or grant['manifestFingerprint'] != value['fingerprint']
            or any(not identity(manifest[k]) for k in ('sessionId', 'taskId', 'runId', 'verificationId'))
            or any(grant[k] != manifest[k] for k in ('sessionId', 'taskId', 'runId', 'taskRevision'))
            or not identity(grant['id']) or not identity(grant['hostId'])
            or type(manifest['taskRevision']) is not int or not 0 <= manifest['taskRevision'] <= 9007199254740991
            or manifest['kind'] not in ('decision', 'review')
            or any(grant[k] is not True for k in ('localOnly', 'capture', 'presentation'))
            or any(grant[k] is not False for k in ('control', 'nativeActivation', 'calls'))
            or not all(number(grant[k]) for k in ('authorizedAt', 'expiresAt'))
            or not 0 < grant['expiresAt'] - grant['authorizedAt'] <= 900000
            or not isinstance(manifest['scenes'], list) or not 1 <= len(manifest['scenes']) <= 12):
        fail()
    def prose(text, bound):
        if not isinstance(text, str) or not 0 < len(text.strip()) <= bound or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', text):
            fail()
    prose(manifest['opening'], 2000)
    seen = set()
    for scene in manifest['scenes']:
        exact(scene, {'id', 'kind', 'title', 'narration', 'expectedOutcome', 'target', 'focus', 'transitionMs'}
              | ({'artifact'} if 'artifact' in scene else set()) | ({'overview'} if 'overview' in scene else set())
              | ({'annotation'} if 'annotation' in scene else set()))
        if not identity(scene['id']) or scene['id'] in seen or scene['kind'] not in ('code', 'preview', 'verification'):
            fail()
        seen.add(scene['id'])
        target(scene['target'])
        for key, bound in (('title', 160), ('narration', 1600), ('expectedOutcome', 500)):
            prose(scene[key], bound)
        for key in ('focus', 'overview') if 'overview' in scene else ('focus',):
            rect = scene[key]
            exact(rect, ('x', 'y', 'width', 'height'))
            if (not all(number(v) for v in rect.values()) or not 0 <= rect['x'] <= 1 or not 0 <= rect['y'] <= 1
                    or not 0 < rect['width'] <= 1 or not 0 < rect['height'] <= 1
                    or rect['x'] + rect['width'] > 1 or rect['y'] + rect['height'] > 1):
                fail()
        if 'overview' in scene:
            focus, overview = scene['focus'], scene['overview']
            if (focus['x'] < overview['x'] or focus['y'] < overview['y']
                    or focus['x'] + focus['width'] > overview['x'] + overview['width']
                    or focus['y'] + focus['height'] > overview['y'] + overview['height']):
                fail()
        if 'annotation' in scene:
            annotation = scene['annotation']
            exact(annotation, ('rect', 'label'))
            prose(annotation['label'], 100)
            rect, focus = annotation['rect'], scene['focus']
            exact(rect, ('x', 'y', 'width', 'height'))
            if (not all(number(v) for v in rect.values()) or not 0 <= rect['x'] <= 1 or not 0 <= rect['y'] <= 1
                    or not 0 < rect['width'] <= 1 or not 0 < rect['height'] <= 1
                    or rect['x'] + rect['width'] > 1 or rect['y'] + rect['height'] > 1
                    or rect['x'] < focus['x'] or rect['y'] < focus['y']
                    or rect['x'] + rect['width'] > focus['x'] + focus['width']
                    or rect['y'] + rect['height'] > focus['y'] + focus['height']):
                fail()
        if type(scene['transitionMs']) is not int or not 450 <= scene['transitionMs'] <= 650:
            fail()
        if 'artifact' in scene:
            exact(scene['artifact'], ('relativePath', 'sha256'))
            prose(scene['artifact']['relativePath'], 1000)
            if not isinstance(scene['artifact']['sha256'], str) or not HASH.fullmatch(scene['artifact']['sha256']):
                fail()
    if manifest['scenes'][0]['narration'] != manifest['opening']:
        fail()
    return copy.deepcopy(value)


class PresentationAuthority:
    def __init__(self, http, origin, token, configured):
        from urllib.parse import urlsplit
        parsed = urlsplit(origin)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path not in ('', '/')
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or not isinstance(token, str) or not 32 <= len(token) <= 4096):
            fail()
        self.http, self.origin, self.token, self.configured = http, origin.rstrip('/'), token, configured

    async def check(self, generation=None):
        from aiohttp import ClientTimeout
        binding = self.configured
        grant = binding['grant']
        path = '/tasks/' + grant['taskId'] + '/presentations/' + binding['presentationId'] + '/authority'
        try:
            async with self.http.get(self.origin + path, headers={'Authorization': 'Bearer ' + self.token},
                    allow_redirects=False, timeout=ClientTimeout(total=1.5)) as response:
                if response.status != 200:
                    fail()
                value = json.loads(await bounded_body(response, 16384))
            expected = {k: grant[k] for k in ('sessionId', 'taskId', 'runId', 'taskRevision', 'hostId', 'expiresAt',
                         'localOnly', 'capture', 'presentation', 'control', 'nativeActivation', 'calls')}
            expected.update(presentationId=binding['presentationId'], manifestFingerprint=binding['fingerprint'], active=True)
            if (any(type(value.get(k)) is not type(v) or value[k] != v for k, v in expected.items())
                    or not time.time() * 1000 < value['expiresAt']
                    or (grant.get('continuity') == 'call' and type(value.get('sceneEvidenceCurrent')) is not bool)
                    or (generation is not None and value.get('generation') != generation)):
                fail()
            return value
        except Exception:
            raise VoiceError('presentation_authority_unavailable') from None


class PresentationJournal:
    def __init__(self, path):
        import fcntl
        import stat
        path = Path(path)
        parent = path.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077
                or path.is_symlink()):
            fail()
        def private_descriptor(filename):
            fd = os.open(filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                os.close(fd)
                fail()
            return fd
        self.lock = os.fdopen(private_descriptor(str(path) + '.lock'), 'r+b')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.close(private_descriptor(path))
            self.db = sqlite3.connect(path)
            self.db.executescript('CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,fingerprint TEXT,state TEXT);'
                'CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,fingerprint TEXT,state TEXT,result TEXT);')
            self.prior = self.db.execute('SELECT id FROM session').fetchone() is not None
        except BaseException:
            if hasattr(self, 'db'):
                self.db.close()
            self.lock.close()
            raise

    def prepare(self, binding):
        if self.prior:
            raise VoiceError('presentation_restart_refused')
        self.db.execute('INSERT INTO session VALUES(?,?,?)', (binding['presentationId'], binding['fingerprint'], 'prepared'))
        self.db.commit()

    def reserve(self, operation, body):
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        previous = self.db.execute('SELECT fingerprint,state,result FROM effects WHERE id=?', (operation,)).fetchone()
        if previous:
            if previous[0] == digest and previous[1] == 'done':
                return json.loads(previous[2])
            raise VoiceError('presentation_effect_unknown')
        self.db.execute('INSERT INTO effects VALUES(?,?,?,NULL)', (operation, digest, 'running'))
        self.db.commit()
        return None

    def finish(self, operation, result):
        self.db.execute('UPDATE effects SET state=?,result=? WHERE id=?', ('done', json.dumps(result), operation))
        self.db.commit()

    def unknown(self, operation):
        self.db.execute('UPDATE effects SET state=? WHERE id=?', ('unknown', operation))
        self.db.commit()

    def close(self):
        self.db.close()
        self.lock.close()


class NativeWindowSource:
    def __init__(self, binary, config_path):
        self.binary, self.config_path = str(binary), str(config_path)
        self.process = None
        self.spawn_task = None
        self.lock = asyncio.Lock()
        self.closed = False
        self.close_task = None

    async def start(self):
        if self.process or self.closed:
            fail()
        self.spawn_task = asyncio.create_task(asyncio.create_subprocess_exec(self.binary, '--config', self.config_path,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=16384))
        self.process = await asyncio.shield(self.spawn_task)
        if self.closed:
            await self.close()
            fail()

    async def request(self, op, selected):
        async with self.lock:
            if not self.process or self.closed or self.process.returncode is not None:
                fail()
            identity = uuid.uuid4().hex
            async with asyncio.timeout(2):
                self.process.stdin.write(json.dumps({'id': identity, 'op': op, 'target': selected}).encode() + b'\n')
                await self.process.stdin.drain()
                header = await self.process.stdout.readline()
                if not header or len(header) > 8192:
                    fail()
                value = json.loads(header)
                if value.get('id') != identity or value.get('ok') is not True or value.get('target') != selected:
                    fail()
                size = value.get('bytes')
                if type(size) is not int or not 0 <= size <= 2 * 1024 * 1024:
                    fail()
                raw = await self.process.stdout.readexactly(size)
                if self.closed:
                    fail()
                if op == 'capture':
                    if not raw or hashlib.sha256(raw).hexdigest() != value.get('contentRevision'):
                        fail()
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.format != 'JPEG' or image.size != (value.get('width'), value.get('height')) or image.width * image.height > 32000000:
                            fail()
                        value['image'] = image.convert('RGB')
                elif raw:
                    fail()
                return value

    async def close(self):
        self.closed = True
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close())
        return await asyncio.shield(self.close_task)

    async def _close(self):
        process = await asyncio.shield(self.spawn_task) if self.spawn_task else self.process
        if process and process.returncode is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await asyncio.wait_for(process.wait(), 2)
        return True


class TaskPresentationRuntime:
    def __init__(self, configured, authority, source, journal, *, narrator=None, wall=time.time, clock=time.monotonic):
        self.binding = validate_prepare(configured)
        self.authority, self.source, self.journal, self.narrator = authority, source, journal, narrator
        self.wall, self.clock = wall, clock
        self.prepared = self.armed = self.stopping = False
        self.state = 'absent'
        self.generation = 0
        self.scene = self.frame = self.source_frame = self.output = None
        self.operation_id = None
        self.transition_at = self.transition_completed = None
        self.tasks = set()
        self.effect_lock = asyncio.Lock()
        self.close_task = None
        self.start_task = None
        self.authority_at = None
        self.authority_generation = None
        self.frames_changed = asyncio.Event()
        self.counts = {'sourceFrames': 0, 'renderedFrames': 0}
        self.emitted = {}
        self.output_metadata = None
        self.output_token = None
        self.paint_tokens = {}
        self.painted = None
        self.paint_changed = asyncio.Event()
        self.diagnostics = PresentationDiagnostics()
        self.call_continuity = self.binding['grant'].get('continuity') == 'call'
        if self.call_continuity and narrator is not None:
            fail()
        self.scene_evidence_current = not self.call_continuity
        self.scene_evidence_invalidated = False
        self.pending_scene = None
        self.font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 24)

    async def check(self, generation=None):
        if self.stopping or self.wall() * 1000 >= self.binding['grant']['expiresAt']:
            fail()
        value = await self.authority.check(generation)
        if self.stopping or self.wall() * 1000 >= self.binding['grant']['expiresAt']:
            fail()
        self.authority_at = self.clock()
        self.authority_generation = value.get('generation')
        if self.call_continuity:
            if type(value.get('sceneEvidenceCurrent')) is not bool:
                fail()
            self.set_scene_evidence(value['sceneEvidenceCurrent'])
        return value

    def set_scene_evidence(self, current):
        if type(current) is not bool:
            fail()
        if self.call_continuity:
            self.scene_evidence_invalidated |= not current
            current = current and not self.scene_evidence_invalidated
        if self.call_continuity and current != self.scene_evidence_current:
            self.scene_evidence_current = current
            # Do not export a cached prepared overlay after authority changes.
            # The existing SDK view remains only until the next fresh render.
            self.output = self.output_metadata = self.output_token = self.frame = None

    async def prepare(self, value):
        if value != self.binding or self.stopping:
            fail()
        self.diagnostics.phase('prepare_authority')
        await self.check()
        if not self.prepared:
            self.journal.prepare(self.binding)
            self.prepared = True
            self.state = 'prepared'
        return {'ready': True}

    async def local_start(self):
        if not self.prepared or self.stopping or self.start_task:
            fail()
        self.start_task = asyncio.create_task(self._start())
        await asyncio.shield(self.start_task)

    async def _start(self):
        try:
            self.diagnostics.phase('local_start')
            await self.check()
            await self.source.start()
            for scene in self.binding['manifest']['scenes']:
                self.diagnostics.phase('native_inspect')
                await self.source.request('inspect', scene['target'])
                await self.check()
            self.armed = True
            self.spawn(self.capture_loop(), 'source_capture')
            self.spawn(self.render_loop(), 'frame_render')
            self.diagnostics.phase('ready')
        except BaseException as error:
            self.diagnostics.fail(error)
            asyncio.create_task(self.stop())
            raise

    def spawn(self, coro, phase):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        def done(item):
            self.tasks.discard(item)
            if not item.cancelled() and item.exception() and not self.stopping:
                self.diagnostics.fail(item.exception(), phase)
                self.state = 'unknown'
                asyncio.create_task(self.stop())
        task.add_done_callback(done)
        return task

    async def show(self, value):
        exact(value, ('presentationId', 'operationId', 'manifestFingerprint', 'sceneId', 'generation'))
        if (not self.armed or value['presentationId'] != self.binding['presentationId']
                or value['manifestFingerprint'] != self.binding['fingerprint'] or not identity(value['operationId'])
                or type(value['generation']) is not int or value['generation'] <= self.generation):
            fail()
        scene = next((item for item in self.binding['manifest']['scenes'] if item['id'] == value['sceneId']), None)
        if not scene or self.effect_lock.locked():
            fail()
        async with self.effect_lock:
            previous = self.journal.reserve(value['operationId'], value)
            if previous is not None:
                return previous
            try:
                self.diagnostics.phase('show_authority')
                await self.check(value['generation'])
                if self.narrator:
                    await self.narrator.interrupt()
                    await self.check(value['generation'])
                if self.call_continuity and self.scene and self.source_frame and self.output:
                    self.pending_scene = {'scene': scene, 'generation': value['generation'], 'operationId': value['operationId']}
                else:
                    self.generation = value['generation']
                    self.operation_id = value['operationId']
                    self.scene = scene
                    self.frame = self.source_frame = self.output = None
                    self.output_metadata = self.output_token = self.painted = None
                    self.paint_tokens.clear()
                    self.transition_at = self.transition_completed = None
                self.state = 'presenting'
                self.diagnostics.phase('await_source')
                async with asyncio.timeout(6):
                    while not self.frame or self.frame['generation'] != value['generation'] or self.frame['sceneId'] != scene['id']:
                        self.frames_changed.clear()
                        await self.frames_changed.wait()
                        await self.check(value['generation'])
                self.state = 'visible'
                self.diagnostics.phase('ready')
                result = copy.deepcopy(self.frame)
                self.journal.finish(value['operationId'], result)
                return result
            except BaseException as error:
                self.diagnostics.fail(error)
                self.journal.unknown(value['operationId'])
                self.state = 'unknown'
                asyncio.create_task(self.stop())
                raise

    async def capture_loop(self):
        while not self.stopping:
            policy = await self.check()
            pending = self.pending_scene
            scene, generation = (pending['scene'], pending['generation']) if pending else (self.scene, self.generation)
            if scene and policy.get('generation') != generation and not (
                    self.call_continuity and not pending and type(policy.get('generation')) is int and policy['generation'] > generation):
                self.frame = self.output = None
                await asyncio.sleep(.05)
                continue
            if scene:
                value = await self.source.request('capture', scene['target'])
                policy = await self.check()
                if ((pending is not None and pending is not self.pending_scene)
                        or (pending is None and (generation != self.generation or scene is not self.scene))):
                    continue
                if policy.get('generation') != generation and not (
                        self.call_continuity and not pending and type(policy.get('generation')) is int and policy['generation'] > generation):
                    self.frame = self.output = None
                    continue
                if (value.get('target') != scene['target'] or not identity(value.get('sourceFrameId'))
                        or not isinstance(value.get('contentRevision'), str) or not HASH.fullmatch(value['contentRevision'])
                        or not identity(value.get('geometryGeneration')) or not number(value.get('capturedAt'))
                        or not 0 <= self.wall() * 1000 - value['capturedAt'] < 1500
                        or not isinstance(value.get('image'), Image.Image)):
                    fail()
                if self.source_frame and not pending and value['geometryGeneration'] != self.source_frame['geometryGeneration']:
                    fail()
                if pending:
                    self.scene, self.generation, self.operation_id = scene, generation, pending['operationId']
                    self.pending_scene = None
                    self.frame = self.painted = None
                    self.paint_tokens.clear()
                    self.transition_at = self.transition_completed = None
                self.source_frame = value
                self.counts['sourceFrames'] = min(1000000, self.counts['sourceFrames'] + 1)
                if self.transition_at is None:
                    self.transition_at = self.clock()
                self.frames_changed.set()
            await asyncio.sleep(.2)

    def render(self):
        source, scene = self.source_frame, self.scene
        if (self.stopping or not source or not scene or self.authority_at is None
                or self.clock() - self.authority_at >= 1.5
                or (self.authority_generation != self.generation and not
                    (self.call_continuity and type(self.authority_generation) is int and self.authority_generation > self.generation))
                or not 0 <= self.wall() * 1000 - source['capturedAt'] < 2000):
            self.frame = self.output = None
            return
        elapsed = self.clock() - self.transition_at
        t = min(1, max(0, elapsed / (scene['transitionMs'] / 1000)))
        eased = t * t * (3 - 2 * t)
        focus = scene['focus']
        overview = scene.get('overview', {'x': 0, 'y': 0, 'width': 1, 'height': 1})
        crop = {k: base + (focus[k] - base) * eased for k, base in overview.items()}
        image = source['image']
        # Round the permitted overview inward so fractional edge pixels never
        # expose UI outside the prepared crop, including the first transition.
        left_bound, top_bound = math.ceil(overview['x'] * image.width), math.ceil(overview['y'] * image.height)
        right_bound = math.floor((overview['x'] + overview['width']) * image.width)
        bottom_bound = math.floor((overview['y'] + overview['height']) * image.height)
        x, y = max(left_bound, int(crop['x'] * image.width)), max(top_bound, int(crop['y'] * image.height))
        right = min(right_bound, max(x + 1, math.ceil((crop['x'] + crop['width']) * image.width)))
        bottom = min(bottom_bound, max(y + 1, math.ceil((crop['y'] + crop['height']) * image.height)))
        if right <= x or bottom <= y:
            fail()
        tile = image.crop((x, y, right, bottom))
        scale = min(WIDTH / tile.width, 640 / tile.height)
        tile = tile.resize((max(1, int(tile.width * scale)), max(1, int(tile.height * scale))), Image.Resampling.LANCZOS)
        canvas = Image.new('RGB', (WIDTH, HEIGHT), '#101722')
        if 'annotation' in scene and self.scene_evidence_current:
            rect = scene['annotation']['rect']
            # Project from source pixels through the actual integer crop and
            # resized tile dimensions, never through idealized floating sizes.
            ax = max(0, min(tile.width - 1, round((rect['x'] * image.width - x) * tile.width / (right - x))))
            ay = max(0, min(tile.height - 1, round((rect['y'] * image.height - y) * tile.height / (bottom - y))))
            ar = max(ax, min(tile.width - 1, round(((rect['x'] + rect['width']) * image.width - x) * tile.width / (right - x))))
            ab = max(ay, min(tile.height - 1, round(((rect['y'] + rect['height']) * image.height - y) * tile.height / (bottom - y))))
            ImageDraw.Draw(tile).rectangle((ax, ay, ar, ab), outline='#ffd166', width=3)
            label = ' '.join(scene['annotation']['label'].split())
            draw = ImageDraw.Draw(canvas)
            caption_font = self.font
            while caption_font.size > 12 and draw.textlength(label, font=caption_font) > WIDTH - 48:
                caption_font = ImageFont.truetype(self.font.path, caption_font.size - 1)
            draw.text((24, 686), label, fill='#ffd166', font=caption_font)
        canvas.paste(tile, ((WIDTH - tile.width) // 2, 40 + (640 - tile.height) // 2))
        title = scene['title'] if self.scene_evidence_current else 'Live view · prepared result evidence is no longer current'
        ImageDraw.Draw(canvas).text((24, 8), title, fill='#e5edf8', font=self.font)
        output = io.BytesIO(); canvas.save(output, 'JPEG', quality=85)
        if self.stopping or not 0 <= self.wall() * 1000 - source['capturedAt'] < 2000:
            self.frame = self.output = None
            return
        self.output = output.getvalue()
        rendered_at = self.wall() * 1000
        self.output_metadata = {'sourceFrameId': source['sourceFrameId'], 'capturedAt': source['capturedAt'],
            'geometryGeneration': source['geometryGeneration'], 'sceneId': scene['id'], 'generation': self.generation,
            'renderedAt': rendered_at}
        self.output_token = uuid.uuid4().hex
        self.counts['renderedFrames'] = min(1000000, self.counts['renderedFrames'] + 1)
        if t == 1 and self.transition_completed is None:
            self.transition_completed = self.wall() * 1000
        if self.transition_completed is not None and source['capturedAt'] >= self.transition_completed:
            self.frame = {'presentationId': self.binding['presentationId'], 'manifestFingerprint': self.binding['fingerprint'],
                'operationId': self.operation_id, 'sceneId': scene['id'], 'generation': self.generation,
                'target': copy.deepcopy(scene['target']), 'sourceFrameId': source['sourceFrameId'],
                'geometryGeneration': source['geometryGeneration'], 'contentRevision': source['contentRevision'],
                'capturedAt': source['capturedAt'], 'renderedAt': rendered_at,
                'transitionCompletedAt': self.transition_completed, 'evidence': 'local_frame_rendered_not_human_seen'}
            self.emitted = {key: frame for key, frame in self.emitted.items() if self.wall() * 1000 - frame['capturedAt'] < 2000}
            key = json.dumps(self.frame, sort_keys=True, separators=(',', ':'))
            self.emitted[key] = copy.deepcopy(self.frame)
            self.paint_tokens[self.output_token] = copy.deepcopy(self.frame)
            while len(self.paint_tokens) > 64:
                self.paint_tokens.pop(next(iter(self.paint_tokens)))
            while len(self.emitted) > 64:
                self.emitted.pop(next(iter(self.emitted)))
        self.frames_changed.set()

    def acknowledge_paint(self, token):
        value = self.paint_tokens.get(token) if isinstance(token, str) else None
        if (not self.stopping and value and self.scene and value['sceneId'] == self.scene['id']
                and value['generation'] == self.generation and 0 <= self.wall() * 1000 - value['capturedAt'] < 2000):
            self.painted = value
            self.diagnostics.increment('paintAccepted')
            self.paint_changed.set()
        else:
            self.diagnostics.increment('paintRefused')

    async def render_loop(self):
        deadline = self.clock()
        while not self.stopping:
            self.render()
            # Account for render work; never add a second frame period after it.
            # An overrun skips idle time, without accumulating catch-up frames.
            deadline = max(deadline + 1 / FPS, self.clock())
            await asyncio.sleep(max(0, deadline - self.clock()))

    async def observe(self, presentation_id):
        if presentation_id != self.binding['presentationId']:
            fail()
        await self.check(self.generation)
        if not self.frame or not 0 <= self.wall() * 1000 - self.frame['capturedAt'] < 2000:
            fail()
        return copy.deepcopy(self.frame)

    async def narrate(self, value):
        if self.call_continuity:
            fail()
        exact(value, ('presentationId', 'operationId', 'sceneId', 'generation', 'frame', 'text'))
        if (not self.narrator or not self.scene or value['sceneId'] != self.scene['id']
                or value['generation'] != self.generation or value['text'] != self.scene['narration']
                or not identity(value['operationId']) or self.effect_lock.locked()):
            fail()
        async with self.effect_lock:
            previous = self.journal.reserve(value['operationId'], value)
            if previous is not None:
                return previous
            try:
                self.diagnostics.phase('narrate_frame')
                frame = await self.observe(value['presentationId'])
                supplied = value['frame']
                if (not isinstance(supplied, dict) or json.dumps(supplied, sort_keys=True, separators=(',', ':')) not in self.emitted
                        or any(supplied.get(k) != frame[k] for k in
                        ('presentationId', 'manifestFingerprint', 'operationId', 'sceneId', 'generation', 'target', 'geometryGeneration'))
                        or not number(supplied.get('capturedAt')) or not 0 <= self.wall() * 1000 - supplied['capturedAt'] < 2000):
                    fail()
                self.state = 'narrating'
                self.diagnostics.phase('await_paint')
                async with asyncio.timeout(2):
                    while (not self.painted or self.painted['sceneId'] != value['sceneId']
                            or self.painted['generation'] != value['generation']
                            or self.painted['geometryGeneration'] != frame['geometryGeneration']
                            or not 0 <= self.wall() * 1000 - self.painted['capturedAt'] < 1000):
                        self.paint_changed.clear()
                        await self.paint_changed.wait()
                        await self.check(value['generation'])
                async def authorize_narration():
                    await self.check(value['generation'])
                    if (not self.frame or not self.painted or self.painted['generation'] != value['generation']
                            or self.painted['sceneId'] != value['sceneId']
                            or self.painted['geometryGeneration'] != frame['geometryGeneration']
                            or not 0 <= self.wall() * 1000 - self.painted['capturedAt'] < 2000
                            or not 0 <= self.wall() * 1000 - self.frame['capturedAt'] < 2000):
                        fail()
                self.diagnostics.phase('narration')
                result = await self.narrator.speak(value['text'], authorize_narration)
                await self.check(value['generation'])
                if result != {'completed': True, 'evidence': 'playback_completed_not_audibility'}:
                    fail()
                self.journal.finish(value['operationId'], result)
                self.state = 'visible'
                self.diagnostics.phase('ready')
                return result
            except BaseException as error:
                self.diagnostics.fail(error)
                self.journal.unknown(value['operationId'])
                self.state = 'unknown'
                asyncio.create_task(self.stop())
                raise

    def status(self):
        narrator_diagnostics = getattr(self.narrator, 'diagnostics', None)
        return {'presentationId': self.binding['presentationId'], 'state': self.state,
            'localStarted': self.armed, 'generation': self.generation,
            'sceneId': self.scene['id'] if self.scene else None, 'fps': FPS,
            'evidence': 'local_rendering_not_physical_acceptance', 'counts': dict(self.counts),
            'diagnostics': {'runtime': self.diagnostics.snapshot(),
                'narrator': narrator_diagnostics.snapshot() if narrator_diagnostics else None}}

    async def stop(self):
        self.stopping = True
        self.pending_scene = None
        self.armed = False
        self.frame = self.output = self.source_frame = None
        self.emitted.clear()
        self.output_metadata = self.output_token = self.painted = None
        self.paint_tokens.clear()
        self.paint_changed.set()
        self.frames_changed.set()
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._stop())
        return await asyncio.shield(self.close_task)

    async def _stop(self):
        self.diagnostics.phase('stop')
        if self.start_task and not self.start_task.done():
            self.start_task.cancel()
            await asyncio.gather(self.start_task, return_exceptions=True)
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        results = await asyncio.gather(self.source.close(), *([self.narrator.close()] if self.narrator else []), return_exceptions=True)
        if any(isinstance(value, BaseException) for value in results):
            self.diagnostics.fail(VoiceError('presentation_cleanup_unconfirmed'))
            self.state = 'unknown'
            raise VoiceError('presentation_cleanup_unconfirmed')
        self.scene = None
        self.state = 'stopped'
        self.diagnostics.phase('closed')
        return {'captureStopped': True, 'narrationStopped': True, 'outputCleared': True, 'childrenJoined': True}
