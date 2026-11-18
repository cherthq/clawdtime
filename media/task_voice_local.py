"""Local microphone/speaker entry point; never dials or captures a screen.

The provider configuration template subcommand is offline. Running audio requires
explicit private voice/provider files and an explicit browser Start click.
"""
import argparse
import asyncio
import base64
import json
import html
import os
from pathlib import Path
import secrets
import stat
import tempfile

from task_voice import (ElevenLabsProvider, TaskVoiceAPI, TaskVoiceRuntime,
                        VoiceError, provider_configuration)


def private_json(path):
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
        raise VoiceError('private_file_required')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(descriptor)
        if ((actual.st_ino, actual.st_dev) != (before.st_ino, before.st_dev) or actual.st_size > 16384
                or actual.st_uid != os.getuid() or actual.st_mode & 0o077 or not stat.S_ISREG(actual.st_mode)):
            raise VoiceError('private_file_changed')
        raw = os.read(descriptor, 16385)
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise VoiceError('private_file_invalid')
        return value
    finally:
        os.close(descriptor)


class BrowserSink:
    def __init__(self, socket):
        self.socket = socket
        self.serial = 0
        self.pending = {}
        self.epoch = 0

    async def play(self, pcm, epoch):
        self.serial += 1
        identity = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        try:
            await self.socket.send_json({'kind': 'audio', 'id': identity, 'epoch': epoch,
                                        'pcm': base64.b64encode(pcm).decode('ascii')})
            await future  # Browser scheduling/backpressure only, not audibility proof.
        finally:
            self.pending.pop(identity, None)

    async def clear(self, epoch):
        self.epoch = epoch
        for future in list(self.pending.values()):
            if not future.done():
                future.set_result(None)
        self.pending.clear()
        if not self.socket.closed:
            await self.socket.send_json({'kind': 'clear', 'epoch': epoch})

    def acknowledge(self, identity):
        if type(identity) is not int:
            raise VoiceError('playback_ack_invalid')
        future = self.pending.get(identity)
        if future and not future.done():
            future.set_result(None)


def local_app(voice_config, provider_config, port):
    from aiohttp import ClientSession, WSMsgType, web
    capability = secrets.token_urlsafe(32)
    expected_origin = f'http://127.0.0.1:{port}'
    used = False
    active = None

    @web.middleware
    async def boundary(request, handler):
        if request.host != f'127.0.0.1:{port}' or request.remote not in ('127.0.0.1', '::1'):
            raise web.HTTPForbidden(text='Local origin required.')
        if request.headers.get('Origin') not in (None, expected_origin):
            raise web.HTTPForbidden(text='Local origin required.')
        if request.query.get('session') != capability:
            raise web.HTTPForbidden(text='Local session required.')
        response = await handler(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    app = web.Application(middlewares=[boundary], client_max_size=65536)

    async def index(request):
        return web.Response(text=Path(__file__).with_name('task_voice_local.html').read_text(), content_type='text/html')

    async def audio(request):
        nonlocal used, active
        # A dropped local socket cannot reconnect/resume the old provider identity.
        if used or request.headers.get('Origin') != expected_origin:
            raise web.HTTPConflict(text='This local audio session cannot restart.')
        used = True
        socket = web.WebSocketResponse(max_msg_size=65536, heartbeat=10)
        await socket.prepare(request)
        runtime = None
        try:
            async with ClientSession() as http:
                api = TaskVoiceAPI(http, voice_config['taskOrigin'], voice_config['taskId'], voice_config['voiceSessionId'], voice_config['voiceToken'])
                provider = ElevenLabsProvider(http, provider_config['elevenlabsApiKey'], provider_config['elevenlabsAgentId'])
                sink = BrowserSink(socket)
                runtime = TaskVoiceRuntime(api, provider, sink)
                active = runtime
                # Socket reader remains available for playback acknowledgments during startup.
                startup = asyncio.create_task(runtime.start())
                async def finish_when_ended():
                    await runtime.ended.wait()
                    await socket.close()
                end_watch = asyncio.create_task(finish_when_ended())
                async def announce():
                    try:
                        await startup
                        await socket.send_json({'kind': 'ready'})
                    except Exception:
                        await socket.send_json({'kind': 'error', 'message': 'Voice startup unavailable. The task is preserved; no retry was made.'})
                        await runtime.close()
                announcement = asyncio.create_task(announce())
                try:
                    async for message in socket:
                        if message.type == WSMsgType.BINARY:
                            if runtime.ready.is_set() and runtime.conversation_id and not runtime.closed:
                                await runtime.input_audio(bytes(message.data))
                        elif message.type == WSMsgType.TEXT:
                            value = json.loads(message.data)
                            if value.get('kind') == 'played':
                                sink.acknowledge(value.get('id'))
                            elif value.get('kind') == 'stop':
                                await runtime.end()
                                break
                            else:
                                raise VoiceError('browser_message_invalid')
                        else:
                            break
                finally:
                    try:
                        await asyncio.wait_for(runtime.end(), 3)
                    except Exception:
                        pass  # Unknown cleanup does not authorize repeat or restart.
                    await runtime.close()
                    for task in (startup, announcement, end_watch):
                        task.cancel()
                    await asyncio.gather(startup, announcement, end_watch, return_exceptions=True)
        except Exception:
            if not socket.closed:
                await socket.send_json({'kind': 'error', 'message': 'Voice stopped. The task is preserved; do not repeat uncertain instructions.'})
        finally:
            if runtime:
                await runtime.close()
            active = None
            await socket.close()
        return socket

    async def cleanup(_):
        if active:
            try:
                await active.end()
            except Exception:
                pass
            await active.close()
    app.router.add_get('/', index)
    app.router.add_get('/audio', audio)
    app.on_cleanup.append(cleanup)
    return app, f'{expected_origin}/?session={capability}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    template = commands.add_parser('provider-template', help='Print offline provider configuration; never sends it.')
    template.add_argument('--voice-id', required=True)
    run = commands.add_parser('run', help='Start local mic/speaker UI; requires explicit browser Start.')
    run.add_argument('--voice-file', required=True)
    run.add_argument('--provider-file', required=True)
    run.add_argument('--port', type=int, default=3321)
    args = parser.parse_args()
    try:
        if args.command == 'provider-template':
            print(json.dumps(provider_configuration(args.voice_id), indent=2))
            return
        if not 1024 <= args.port <= 65535:
            raise VoiceError('local_port_invalid')
        voice = private_json(args.voice_file)
        provider = private_json(args.provider_file)
        if voice.get('version') != 1 or set(voice) != {'version', 'taskOrigin', 'taskId', 'voiceSessionId', 'voiceToken'}:
            raise VoiceError('voice_file_invalid')
        if set(provider) != {'elevenlabsAgentId', 'elevenlabsApiKey'}:
            raise VoiceError('provider_file_invalid')
        from aiohttp import web
        app, url = local_app(voice, provider, args.port)
        # The local capability is sensitive too: never print it or put it in an access log.
        with tempfile.TemporaryDirectory(prefix='clawdtime-local-voice-') as directory:
            launcher = Path(directory) / 'open-local-voice.html'
            descriptor = os.open(launcher, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                output.write('<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Local ClawdTime voice</title><a rel="noreferrer" href="' + html.escape(url, quote=True) + '">Open local voice</a>')
            print('Local voice only. No phone, screen capture or control. Open the private launcher file: ' + str(launcher), flush=True)
            web.run_app(app, host='127.0.0.1', port=args.port, access_log=None, print=None)
    except (VoiceError, KeyError, ValueError, OSError):
        parser.exit(2, 'Local voice configuration unavailable. Use owner-only configuration files; no operation retried.\n')


if __name__ == '__main__':
    main()
