"""Fixed loopback operator boundary and separate local preview capability."""
import argparse
import asyncio
import base64
import hmac
import json
import os
from pathlib import Path
import re
import secrets

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web
from task_voice import VoiceError
from task_voice_local import private_json
from task_voice_deepgram import DeepgramProvider
from task_presentation import (NativeWindowSource, PresentationAuthority, PresentationJournal,
                               TaskPresentationRuntime, validate_prepare)
from task_presentation_narrator import PresentationNarrator


class AttachedSink:
    def __init__(self):
        self.delegate = None
    async def play(self, pcm, epoch):
        await (await self.enqueue(pcm, epoch))
    async def clear(self, epoch):
        if self.delegate:
            await self.delegate.clear(epoch)
    async def enqueue(self, pcm, epoch):
        if self.delegate is None:
            raise VoiceError('local_audio_unavailable')
        return await self.delegate.enqueue(pcm, epoch)


class PresentationBrowserSink:
    """Ordered admission; receipts mean onended, never merely scheduled."""
    def __init__(self, socket):
        self.socket, self.epoch, self.serial = socket, 0, 0
        self.pending = {}
        self.pending_bytes = 0
        self.lock = asyncio.Lock()

    async def enqueue(self, pcm, epoch):
        async with self.lock:
            if (epoch != self.epoch or self.socket.closed or not isinstance(pcm, bytes)
                    or not pcm or len(pcm) % 2 or len(pcm) > 960
                    or len(self.pending) >= 8 or self.pending_bytes + len(pcm) > 4480):
                raise VoiceError('presentation_audio_admission_refused')
            self.serial += 1
            identity = self.serial
            future = asyncio.get_running_loop().create_future()
            self.pending[identity] = (future, len(pcm), epoch)
            self.pending_bytes += len(pcm)
            try:
                await asyncio.wait_for(self.socket.send_json({'kind': 'audio', 'id': identity, 'epoch': epoch,
                    'pcm': base64.b64encode(pcm).decode('ascii')}), 1)
            except BaseException:
                record = self.pending.pop(identity, None)
                if record:
                    self.pending_bytes -= record[1]
                    future.cancel()
                raise
            return future

    def acknowledge(self, identity, epoch):
        if type(identity) is not int or identity <= 0 or type(epoch) is not int or epoch < 0:
            raise VoiceError('playback_ack_invalid')
        record = self.pending.get(identity)
        if record is None or record[2] != epoch or epoch != self.epoch:
            return
        self.pending.pop(identity)
        self.pending_bytes -= record[1]
        if not record[0].done():
            record[0].set_result(None)

    async def clear(self, epoch):
        self.epoch = epoch
        for future, _, _ in self.pending.values():
            future.cancel()
        self.pending.clear()
        self.pending_bytes = 0
        if not self.socket.closed:
            await asyncio.wait_for(self.socket.send_json({'kind': 'clear', 'epoch': epoch}), 1)


def control_app(runtime, token, browser_token, port, sink):
    if (type(port) is not int or not 1024 <= port <= 65535
            or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,200}', value) for value in (token, browser_token))):
        raise VoiceError('presentation_configuration_invalid')
    origin = f'http://127.0.0.1:{port}'
    cookie = secrets.token_urlsafe(32)
    used_audio = False
    audio_socket = None

    def same(a, b):
        return hmac.compare_digest(a.encode(), b.encode())

    @web.middleware
    async def boundary(request, handler):
        if request.host != f'127.0.0.1:{port}' or request.remote != '127.0.0.1':
            raise web.HTTPForbidden()
        browser = request.path in ('/', '/bootstrap', '/preview/status', '/preview/paint', '/frame', '/audio', '/local/start', '/local/stop')
        if browser:
            if request.headers.get('Origin') not in (None, origin):
                raise web.HTTPForbidden()
            if request.path not in ('/', '/bootstrap') and not same(request.cookies.get('clawdtime_presentation', ''), cookie):
                raise web.HTTPUnauthorized()
            if request.method != 'GET' or request.path == '/audio':
                if request.headers.get('Origin') != origin:
                    raise web.HTTPForbidden()
        elif request.headers.get('Origin') is not None or not same(request.headers.get('Authorization', ''), 'Bearer ' + token):
            raise web.HTTPUnauthorized()
        try:
            response = await handler(request)
        except web.HTTPException:
            raise
        except (VoiceError, ValueError, KeyError, TypeError):
            response = web.json_response({'error': 'presentation_refused'}, status=409)
        except (TimeoutError, RuntimeError):
            response = web.json_response({'error': 'presentation_outcome_unconfirmed'}, status=503)
        response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'})
        return response

    app = web.Application(middlewares=[boundary], client_max_size=128 * 1024)
    async def index(request):
        return web.Response(text=Path(__file__).with_name('task_presentation_local.html').read_text(), content_type='text/html')
    async def bootstrap(request):
        body = await request.json()
        if not isinstance(body, dict) or set(body) != {'token'} or not isinstance(body['token'], str) or not same(body['token'], browser_token):
            raise web.HTTPUnauthorized()
        response = web.json_response({'ready': True})
        response.set_cookie('clawdtime_presentation', cookie, httponly=True, samesite='Strict', path='/')
        return response
    async def status(request):
        return web.json_response(runtime.status())
    async def prepare(request):
        return web.json_response(await runtime.prepare(await request.json()))
    async def show(request):
        return web.json_response(await runtime.show(await request.json()))
    async def narrate(request):
        return web.json_response(await runtime.narrate(await request.json()))
    async def observe(request):
        if set(request.query) != {'presentationId'}:
            raise web.HTTPBadRequest()
        return web.json_response(await runtime.observe(request.query['presentationId']))
    async def stop(request):
        body = await request.json()
        if body != {'presentationId': runtime.binding['presentationId']}:
            raise web.HTTPConflict()
        return web.json_response(await runtime.stop())
    async def local_start(request):
        if await request.json() != {} or sink.delegate is None:
            raise web.HTTPConflict()
        await runtime.local_start()
        return web.json_response({'started': True})
    async def local_stop(request):
        if await request.json() != {}:
            raise web.HTTPBadRequest()
        return web.json_response(await runtime.stop())
    async def frame(request):
        # Recheck authorization even when capture is between samples. Never
        # return an old image from an independently cached browser route.
        await runtime.check(runtime.generation)
        if runtime.output is None or runtime.output_metadata is None or runtime.wall() * 1000 - runtime.output_metadata['capturedAt'] >= 2000:
            raise web.HTTPGone()
        return web.Response(body=runtime.output, content_type='image/jpeg',
            headers={'X-Captured-At-Ms': str(runtime.output_metadata['capturedAt']), 'X-Frame-Token': runtime.output_token})
    async def paint(request):
        value = await request.json()
        if not isinstance(value, dict) or set(value) != {'frameToken'}:
            raise web.HTTPBadRequest()
        runtime.acknowledge_paint(value['frameToken'])
        return web.json_response({'received': True})
    async def audio(request):
        nonlocal used_audio, audio_socket
        if used_audio or runtime.stopping:
            raise web.HTTPConflict()
        used_audio = True
        audio_socket = web.WebSocketResponse(max_msg_size=2048, heartbeat=10)
        await audio_socket.prepare(request)
        sink.delegate = PresentationBrowserSink(audio_socket)
        try:
            async for message in audio_socket:
                if message.type != WSMsgType.TEXT:
                    raise VoiceError('playback_message_invalid')
                value = json.loads(message.data)
                if not isinstance(value, dict) or set(value) != {'kind', 'id', 'epoch'} or value['kind'] != 'played':
                    raise VoiceError('playback_message_invalid')
                sink.delegate.acknowledge(value['id'], value['epoch'])
        finally:
            await runtime.stop()
            sink.delegate = None
            await audio_socket.close()
        return audio_socket
    for path, handler in (('/', index), ('/status', status), ('/preview/status', status), ('/observe', observe), ('/frame', frame), ('/audio', audio)):
        app.router.add_get(path, handler)
    for path, handler in (('/bootstrap', bootstrap), ('/prepare', prepare), ('/show', show), ('/narrate', narrate), ('/stop', stop), ('/local/start', local_start), ('/local/stop', local_stop), ('/preview/paint', paint)):
        app.router.add_post(path, handler)
    async def cleanup(app):
        await runtime.stop()
        if audio_socket:
            await audio_socket.close()
    app.on_shutdown.append(cleanup)
    return app


async def configured_app(args):
    config = private_json(args.config_file)
    expected = {'prepare', 'taskOrigin', 'taskToken', 'helperBinary', 'controlToken', 'browserToken'}
    if set(config) != expected:
        raise VoiceError('presentation_configuration_invalid')
    binding = validate_prepare(config['prepare'])
    provider_config = private_json(args.provider_file)
    if set(provider_config) != {'provider', 'deepgramApiKey'} or provider_config['provider'] != 'deepgram':
        raise VoiceError('presentation_provider_refused')
    root = Path(args.config_file).resolve().parent
    if root.stat().st_mode & 0o077:
        raise VoiceError('presentation_private_directory_required')
    helper_file = root / ('capture-' + binding['presentationId'] + '.json')
    helper_value = {'presentationId': binding['presentationId'], 'expiresAt': binding['grant']['expiresAt'],
                    'targets': [scene['target'] for scene in binding['manifest']['scenes']]}
    # Only metadata is written. The child itself starts after the local gesture.
    if helper_file.exists():
        if private_json(helper_file) != helper_value:
            raise VoiceError('presentation_config_conflict')
    else:
        descriptor = os.open(helper_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(helper_value, stream)
    journal = PresentationJournal(args.journal)
    http = ClientSession(timeout=ClientTimeout(total=5))
    try:
        sink = AttachedSink()
        provider = DeepgramProvider(http, provider_config['deepgramApiKey'])
        narrator = PresentationNarrator(provider, sink)
        authority = PresentationAuthority(http, config['taskOrigin'], config['taskToken'], binding)
        source = NativeWindowSource(config['helperBinary'], helper_file)
        runtime = TaskPresentationRuntime(binding, authority, source, journal, narrator=narrator)
        app = control_app(runtime, config['controlToken'], config['browserToken'], args.port, sink)
    except BaseException:
        journal.close()
        await http.close()
        raise
    async def release(app):
        try:
            journal.close()
        finally:
            await http.close()
    app.on_cleanup.append(release)
    return app


def main():
    parser = argparse.ArgumentParser(description='Local exact-window task walkthrough; never calls or controls apps.')
    parser.add_argument('--config-file', required=True)
    parser.add_argument('--provider-file', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--port', type=int, default=3323)
    args = parser.parse_args()
    try:
        web.run_app(configured_app(args), host='127.0.0.1', port=args.port, access_log=None, print=None, shutdown_timeout=10)
    except (Exception, KeyboardInterrupt):
        parser.exit(2, 'Presentation stopped or unavailable. Reconcile the original receipt before another session.\n')


if __name__ == '__main__':
    main()
