"""Private loopback controller for one explicitly granted handset walkthrough.

Construction writes metadata journals only. No capture, room, provider session or
call begins on startup. This process never dials or controls desktop applications.
"""
import argparse
import copy
import os
import json
from pathlib import Path
import re
import time

from aiohttp import ClientSession, ClientTimeout, web
from task_voice import TaskVoiceAPI, VoiceError
from task_voice_deepgram import DeepgramProvider
from task_voice_local import private_json
from task_voice_livekit import TaskAudioJournal
from task_voice_livekit_local import control_app as audio_control_app
from task_presentation import (validate_prepare, PresentationAuthority, PresentationJournal,
                               NativeWindowSource, TaskPresentationRuntime)
from task_walkthrough_livekit import validate_walkthrough_binding, LiveKitWalkthroughPort, TaskWalkthroughLiveKit


def validate_export(value, binding, prepared, now):
    fields = {'version', 'mode', 'id', 'planFingerprint', 'authorizationId', 'sourcePairingId', 'projectRoot',
        'authorizedAt', 'dispatchExpiresAt', 'expiresAt', 'exportPreparedWindows', 'instructions', 'control',
        'nativeActivation', 'maxCalls'}
    if (not isinstance(value, dict) or set(value) != fields or type(value['version']) is not int or value['version'] != 1
            or value['mode'] != 'handset_walkthrough' or value['id'] != binding['exportGrantId']
            or value['planFingerprint'] != binding['planFingerprint']
            or value['dispatchExpiresAt'] != binding['dispatchExpiresAt'] or value['expiresAt'] != binding['expiresAt']
            or any(type(value[key]) is not int for key in ('authorizedAt', 'dispatchExpiresAt', 'expiresAt'))
            or not value['authorizedAt'] <= now * 1000 < value['dispatchExpiresAt'] <= value['authorizedAt'] + 300000
            or not value['dispatchExpiresAt'] <= value['expiresAt'] <= value['authorizedAt'] + 1800000
            or any(value[key] is not True for key in ('exportPreparedWindows', 'instructions'))
            or any(value[key] is not False for key in ('control', 'nativeActivation'))
            or type(value['maxCalls']) is not int or value['maxCalls'] != 1
            or any(not isinstance(value[key], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', value[key])
                   for key in ('authorizationId', 'sourcePairingId'))
            or not isinstance(value['projectRoot'], str) or not Path(value['projectRoot']).is_absolute()
            or len(value['projectRoot']) > 4096
            or prepared['grant']['expiresAt'] < binding['dispatchExpiresAt']):
        raise VoiceError('walkthrough_export_grant_refused')
    return copy.deepcopy(value)


def control_app(adapter, binding, token, port):
    app = audio_control_app(adapter, binding, token, port)
    app._client_max_size = 65536

    async def body(request):
        if request.query_string or request.content_type != 'application/json':
            raise web.HTTPBadRequest()
        value = await request.json()
        if not isinstance(value, dict):
            raise web.HTTPBadRequest()
        return value

    async def prepare(request):
        return web.json_response(await adapter.presentation_prepare(await body(request)))

    async def show(request):
        return web.json_response(await adapter.show_scene(await body(request)))

    async def observe(request):
        if set(request.query) != {'callAttemptId', 'presentationId'} or len(request.query) != 2:
            raise web.HTTPBadRequest()
        return web.json_response(await adapter.observe_scene(request.query['callAttemptId'], request.query['presentationId']))

    async def stop(request):
        if await body(request) != {'callAttemptId': binding['callAttemptId'],
                                  'presentationId': binding['presentationBinding']['presentationId']}:
            raise web.HTTPConflict()
        # Root owns durable retirement. Never synchronously call it back here.
        return web.json_response(await adapter.stop_sharing())

    app.router.add_post('/presentation/prepare', prepare)
    app.router.add_post('/presentation/show', show)
    app.router.add_get('/presentation/observe', observe)
    app.router.add_post('/stop-sharing', stop)
    return app


async def configured_app(args):
    binding = validate_walkthrough_binding(private_json(args.binding_file), time.time())
    voice, provider = private_json(args.voice_file), private_json(args.provider_file)
    livekit, control = private_json(args.livekit_file), private_json(args.control_file)
    presentation = private_json(args.presentation_file)
    if (set(voice) != {'version', 'taskOrigin', 'taskId', 'voiceSessionId', 'voiceToken'} or voice['version'] != 1
            or voice['taskId'] != binding['taskId'] or voice['voiceSessionId'] != binding['voiceSessionId']
            or set(provider) != {'provider', 'deepgramApiKey'} or provider['provider'] != 'deepgram'
            or set(livekit) != {'url', 'key', 'secret', 'allowedHosts'}
            or not isinstance(livekit['allowedHosts'], list) or len(livekit['allowedHosts']) != 1
            or any(not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host) for host in livekit['allowedHosts'])
            or set(control) != {'token'}
            or set(presentation) != {'prepare', 'taskOrigin', 'taskToken', 'helperBinary', 'exportGrant'}
            or presentation['taskOrigin'] != voice['taskOrigin']):
        raise VoiceError('walkthrough_private_configuration_invalid')
    prepared = validate_prepare(presentation['prepare'])
    grant = validate_export(presentation['exportGrant'], binding, prepared, time.time())
    root = Path(args.presentation_file).resolve().parent
    if root.stat().st_mode & 0o077 or root.is_relative_to(Path(grant['projectRoot']).resolve()):
        raise VoiceError('walkthrough_private_directory_required')
    helper = Path(presentation['helperBinary'])
    if not helper.is_absolute() or not helper.is_file():
        raise VoiceError('walkthrough_helper_unavailable')
    helper_file = root / ('capture-' + prepared['presentationId'] + '.json')
    helper_value = {'presentationId': prepared['presentationId'], 'expiresAt': prepared['grant']['expiresAt'],
                    'targets': [scene['target'] for scene in prepared['manifest']['scenes']]}
    if helper_file.exists():
        if private_json(helper_file) != helper_value:
            raise VoiceError('walkthrough_capture_configuration_conflict')
    else:
        descriptor = os.open(helper_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(helper_value, stream)
    http = ClientSession(timeout=ClientTimeout(total=5))
    journal = presentation_journal = None
    try:
        api = TaskVoiceAPI(http, voice['taskOrigin'], voice['taskId'], voice['voiceSessionId'], voice['voiceToken'])
        voice_provider = DeepgramProvider(http, provider['deepgramApiKey'])
        port = LiveKitWalkthroughPort(livekit['url'], livekit['key'], livekit['secret'], allowed_hosts=set(livekit['allowedHosts']))
        journal = TaskAudioJournal(args.journal)
        presentation_journal = PresentationJournal(str(args.journal) + '.presentation.sqlite')
        authority = PresentationAuthority(http, presentation['taskOrigin'], presentation['taskToken'], prepared)
        source = NativeWindowSource(helper, helper_file)
        runtime = TaskPresentationRuntime(prepared, authority, source, presentation_journal)
        adapter = TaskWalkthroughLiveKit(api, voice_provider, port, journal, binding, runtime)
        app = control_app(adapter, binding, control['token'], args.port)
        async def release(app):
            journal.close()
            presentation_journal.close()
            await http.close()
        app.on_cleanup.append(release)
        return app
    except BaseException:
        if journal:
            journal.close()
        if presentation_journal:
            presentation_journal.close()
        await http.close()
        raise


def main():
    parser = argparse.ArgumentParser(description='One fixed task walkthrough; starts in standby and never dials.')
    for name in ('binding', 'voice', 'provider', 'livekit', 'control', 'presentation'):
        parser.add_argument('--' + name + '-file', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--port', type=int, default=3322)
    args = parser.parse_args()
    try:
        web.run_app(configured_app(args), host='127.0.0.1', port=args.port,
                    access_log=None, print=None, shutdown_timeout=20)
    except (Exception, KeyboardInterrupt):
        parser.exit(2, 'Task walkthrough stopped or unavailable. Reconcile the original attempt before retrying.\n')


if __name__ == '__main__':
    main()
