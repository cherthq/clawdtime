import asyncio
from datetime import datetime, timezone, timedelta
import hashlib
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from PIL import Image

from captions import CaptionScene, CaptionPublisher
from document_preview import DocumentPreview
from server import Service, Session


class DocumentPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 10.
        self.raw = io.BytesIO()
        Image.new('RGB',(100,140),'white').save(self.raw,format='PNG')
        self.raw = self.raw.getvalue()
        self.response = self.raw
        self.requests = []
        self.release = None
        async def image(request):
            self.requests.append((request.path, request.headers.get('Authorization')))
            if self.release: await self.release.wait()
            return web.Response(body=self.response,content_type='image/png')
        app = web.Application();app.router.add_get('/media/{sid}/document-preview/{preview}',image)
        self.remote = TestServer(app);await self.remote.start_server()
        self.http = ClientSession()
        self.session = SimpleNamespace(id='ct_'+'a'*40,call_id='call',audio_qualification=False,
            active=True,closing=False,pause_latched=False,
            owner=SimpleNamespace(http=self.http,env={'BACKEND_URL':str(self.remote.make_url('')).rstrip('/'),
                                                     'MEDIA_API_KEY':'synthetic-secret'}))
        self.preview = DocumentPreview(self.session,clock=lambda:self.now)
        self.policy = {'protocolVersion':2,'sessionId':'session','callId':'call','state':'listening',
            'documentPreview':{'version':1,'previewId':'preview','artifactId':'artifact','sessionId':'session',
            'callId':'call','sha256':'a'*64,'imageSha256':hashlib.sha256(self.raw).hexdigest(),
            'label':'Selected resume.docx','page':1,'pageCount':1,
            'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=90)).isoformat()}}

    async def asyncTearDown(self):
        if self.release:self.release.set()
        await self.preview.close();await self.http.close();await self.remote.close()

    async def load(self, policy=None):
        self.preview.update(policy or self.policy)
        if self.preview.task: await self.preview.task

    async def test_exact_authenticated_bounded_image_and_real_video_composition(self):
        await self.load()
        self.assertEqual(len(self.requests),1)
        self.assertEqual(self.requests[0][1],'Bearer synthetic-secret')
        self.assertLessEqual(self.preview.image.height,620)
        self.assertEqual(self.preview.render().size,(1280,720))
        self.assertEqual(self.preview.render().getpixel((640,100)),(255,255,255,255))
        scene=CaptionScene('request')
        publisher=CaptionPublisher(scene,SimpleNamespace(),document=self.preview,sdk=SimpleNamespace(
            VideoFrame=lambda *args:args,VideoBufferType=SimpleNamespace(RGBA=1)))
        publisher.source=Mock();publisher.emit()
        self.assertIn(self.preview.render().tobytes(),publisher.frame)
        self.session.pause_latched=True
        publisher.emit()
        self.assertIsNone(self.preview.image)
        self.assertNotEqual(publisher.frame[-1],self.preview.render().tobytes())
        self.assertEqual(len(self.requests),1)

    async def test_call_session_grant_policy_and_acoustic_restrictions_before_fetch(self):
        for changes in ({'callId':'other'},{'sessionId':'other'},{'state':'paused'},
                        {'muted':True},{'screenSelection':{}},{'audioQualification':{}},
                        {'protocolVersion':1}):
            await self.load({**self.policy,**changes})
            self.assertIsNone(self.preview.image)
        self.assertEqual(self.requests,[])
        for changes in ({'page':2},{'pageCount':2},{'imageSha256':'x'},{'label':'x'*121},
                        {'previewId':'../escape'},{'version':True}):
            await self.load({**self.policy,'documentPreview':{**self.policy['documentPreview'],**changes}})
            self.assertIsNone(self.preview.image)
        self.assertEqual(self.requests,[])

    async def test_expiry_staleness_replacement_stop_clear_without_automatic_reacquire(self):
        await self.load()
        self.now+=2.01;self.preview.expire()
        self.assertIsNone(self.preview.image)
        await self.load();self.assertEqual(len(self.requests),1)
        new={**self.policy,'documentPreview':{**self.policy['documentPreview'],'previewId':'next'}}
        await self.load(new);self.assertIsNotNone(self.preview.image)
        self.session.closing=True;self.preview.expire()
        self.assertIsNone(self.preview.image)

    async def test_late_fetch_cannot_restore_revoked_or_replaced_pixels(self):
        self.release=asyncio.Event()
        self.preview.update(self.policy)
        task=self.preview.task
        await asyncio.sleep(.02)
        self.preview.update({});self.release.set()
        await asyncio.gather(task,return_exceptions=True)
        self.assertIsNone(self.preview.image)
        self.assertIsNone(self.preview.spec)

    async def test_hash_size_dimensions_and_identity_mutation_rejected(self):
        self.response=b'bad image'
        await self.load();self.assertIsNone(self.preview.image)
        self.response=b'x'*(2*1024*1024+1)
        policy={**self.policy,'documentPreview':{**self.policy['documentPreview'],'previewId':'oversize'}}
        await self.load(policy);self.assertIsNone(self.preview.image)
        self.response=self.raw
        await self.load({**self.policy,'documentPreview':{**self.policy['documentPreview'],'previewId':'valid'}})
        self.assertIsNotNone(self.preview.image)
        mutated={**self.policy,'documentPreview':{**self.policy['documentPreview'],'previewId':'valid','sha256':'b'*64}}
        await self.load(mutated);self.assertIsNone(self.preview.image)

    async def test_exact_expiry_and_oversized_dimensions_are_refused(self):
        future={**self.policy,'documentPreview':{**self.policy['documentPreview'],
            'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=121)).isoformat()}}
        await self.load(future);self.assertEqual(self.requests,[])
        raw=io.BytesIO();Image.new('RGB',(5000,1),'white').save(raw,format='PNG')
        self.response=raw.getvalue()
        oversized={**self.policy,'documentPreview':{**self.policy['documentPreview'],
            'imageSha256':hashlib.sha256(self.response).hexdigest()}}
        await self.load(oversized);self.assertIsNone(self.preview.image)
        self.response=self.raw
        fresh={**self.policy,'documentPreview':{**self.policy['documentPreview'],'previewId':'fresh'}}
        await self.load(fresh)
        self.now=self.preview.deadline
        self.preview.policy_at=self.now  # Fresh policy cannot extend original expiry.
        self.preview.expire();self.assertIsNone(self.preview.image)

    async def test_document_only_prepare_never_constructs_screen_controller(self):
        with tempfile.TemporaryDirectory() as tmp:
            service=Service({'MEDIA_DATABASE_PATH':str(Path(tmp)/'test.sqlite'),
                'MEDIA_DEVICES_ENABLED':'true','DEVICE_GATEWAY_URL':'http://127.0.0.1',
                'DEVICE_GATEWAY_KEY':'x'*32,'MEDIA_CAPTIONS_ENABLED':'true'})
            service.ready=lambda:True
            try:
                spec={'id':'ct_'+'b'*40,'meetingId':'request','lineId':'line',
                      'captions':True,'screen':False,'documentOnly':True,'documentSessionId':'session'}
                session=Session(service,spec)
                self.assertIsNone(session.screen)
                self.assertIsNotNone(session.document_preview)
                for invalid in ({'documentOnly':False},{'screen':True},{'captions':False},{'audioQualification':True},{'documentSessionId':None}):
                    request=SimpleNamespace(json=AsyncMock(return_value={**spec,**invalid}))
                    with self.assertRaises(web.HTTPBadRequest):await service.prepare(request)
                with patch.object(Session,'prepare',new=AsyncMock()):
                    await service.prepare(SimpleNamespace(json=AsyncMock(return_value=spec)))
                    with self.assertRaises(web.HTTPConflict):
                        await service.prepare(SimpleNamespace(json=AsyncMock(return_value={**spec,'documentSessionId':'other'})))
            finally:service.db.close()
