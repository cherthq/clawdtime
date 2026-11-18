"""Explicit loopback controller for one preconfigured task audio attempt.

Startup does not prepare a room, open provider audio, or dial. Only the lead's
separate authenticated coordinator may invoke effects. No browser surface exists.
"""
import argparse
import hmac
import json
import re
import time

from aiohttp import ClientSession, ClientTimeout, web

from task_voice import ElevenLabsProvider, TaskVoiceAPI, VoiceError
from task_voice_local import private_json
from task_voice_livekit import LiveKitAudioPort, TaskAudioJournal, TaskVoiceLiveKit, validate_binding, fingerprint


def control_app(adapter, binding, token, port):
    if (not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,200}', token)
            or type(port) is not int or not 1024 <= port <= 65535):
        raise VoiceError('handset_controller_configuration_invalid')
    configured = dict(binding)
    fixed_status = {key: configured[key] for key in ('mediaSessionId', 'callAttemptId', 'roomName')}
    fixed_status['bindingFingerprint'] = fingerprint(configured)

    @web.middleware
    async def boundary(request, handler):
        if (request.host != f'127.0.0.1:{port}' or request.remote != '127.0.0.1'
                or request.headers.get('Origin') is not None):
            raise web.HTTPForbidden(text='Loopback coordinator required.')
        if not hmac.compare_digest(request.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
            raise web.HTTPUnauthorized(text='Controller credential required.')
        try:
            response = await handler(request)
        except web.HTTPException:
            raise
        except (ValueError, TypeError, KeyError):
            response = web.json_response({'error': 'invalid_request'}, status=400)
        except VoiceError:
            response = web.json_response({'error': 'operation_refused_or_unconfirmed'}, status=409)
        except Exception:
            response = web.json_response({'error': 'operation_unconfirmed'}, status=503)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    app = web.Application(middlewares=[boundary], client_max_size=16384)

    async def body(request):
        if request.query_string or request.content_type != 'application/json':
            raise web.HTTPBadRequest(text='Exact JSON request required.')
        value = await request.json()
        if not isinstance(value, dict):
            raise web.HTTPBadRequest(text='Object required.')
        return value

    async def prepare(request):
        value = await body(request)
        if value != configured or set(value) != set(configured):
            raise web.HTTPConflict(text='Configured binding required.')
        return web.json_response(await adapter.prepare(value))

    async def activate(request):
        return web.json_response(await adapter.activate(await body(request)))

    async def status(request):
        if request.query_string:
            raise web.HTTPBadRequest(text='Unexpected query.')
        value = adapter.status()
        if value['state'] == 'new':
            value = {**value, 'state': 'absent'}
        return web.json_response({**fixed_status, **value})

    async def close(request):
        if await body(request) != {'callAttemptId': configured['callAttemptId']}:
            raise web.HTTPConflict(text='Configured attempt required.')
        return web.json_response({**fixed_status, **await adapter.close()})

    async def cleanup(app):
        await adapter.close()

    app.router.add_post('/prepare', prepare)
    app.router.add_post('/activate', activate)
    app.router.add_get('/status', status)
    app.router.add_post('/close', close)
    app.on_cleanup.append(cleanup)
    return app


async def configured_app(args):
    # Read explicit owner-only files. No environment lookup, copied legacy config,
    # dynamic origin, enrollment, call dispatch or remote service configuration.
    binding = validate_binding(private_json(args.binding_file), time.time())
    voice = private_json(args.voice_file)
    provider = private_json(args.provider_file)
    livekit = private_json(args.livekit_file)
    control = private_json(args.control_file)
    if (set(voice) != {'version', 'taskOrigin', 'taskId', 'voiceSessionId', 'voiceToken'} or voice['version'] != 1
            or voice['taskId'] != binding['taskId'] or voice['voiceSessionId'] != binding['voiceSessionId']
            or set(provider) != {'elevenlabsAgentId', 'elevenlabsApiKey'}
            or set(livekit) != {'url', 'key', 'secret', 'allowedHosts'}
            or not isinstance(livekit['allowedHosts'], list) or len(livekit['allowedHosts']) != 1
            or any(not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host) for host in livekit['allowedHosts'])
            or set(control) != {'token'}):
        raise VoiceError('handset_private_configuration_invalid')
    http = ClientSession(timeout=ClientTimeout(total=5))
    journal = None
    try:
        api = TaskVoiceAPI(http, voice['taskOrigin'], voice['taskId'], voice['voiceSessionId'], voice['voiceToken'])
        eleven = ElevenLabsProvider(http, provider['elevenlabsApiKey'], provider['elevenlabsAgentId'])
        port = LiveKitAudioPort(livekit['url'], livekit['key'], livekit['secret'], allowed_hosts=set(livekit['allowedHosts']))
        journal = TaskAudioJournal(args.journal)
        adapter = TaskVoiceLiveKit(api, eleven, port, journal)
        app = control_app(adapter, binding, control['token'], args.port)
        async def release(app):
            journal.close()
            await http.close()
        app.on_cleanup.append(release)
        return app
    except BaseException:
        if journal:
            journal.close()
        await http.close()
        raise


def main():
    parser = argparse.ArgumentParser(description='One fixed task audio attempt; starts in standby, never dials.')
    for name in ('binding', 'voice', 'provider', 'livekit', 'control'):
        parser.add_argument('--' + name + '-file', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--port', type=int, default=3322)
    args = parser.parse_args()
    try:
        web.run_app(configured_app(args), host='127.0.0.1', port=args.port,
                    access_log=None, print=None, shutdown_timeout=20)
    except (Exception, KeyboardInterrupt):
        parser.exit(2, 'Task audio controller stopped or configuration unavailable. Reconcile existing attempts before retrying.\n')


if __name__ == '__main__':
    main()
