"""Explicit provider-only synthetic probe; no call, microphone, speaker or backend.

Uses ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID from the invoking environment.
Never prints provider bodies, URLs, transcripts, audio or exception text. Audio
is discarded after a paced 20 ms in-memory consumer. No files are written.
"""
import argparse
import asyncio
import base64
import json
import logging
import os
import time
from types import SimpleNamespace

from aiohttp import ClientSession
import elevenlabs_frontend as module


async def probe(legacy=False, seconds=30):
    if legacy:
        module.AUDIO_QUEUE_BYTES = 64000
        module.AUDIO_QUEUE_EVENTS = 32
        module.AUDIO_EVENT_ENCODED = 88000
        module.WS_MESSAGE_BYTES = 256 * 1024
    started = time.monotonic()
    result = {'legacyBound': legacy, 'failure': None, 'publishedFrames': 0,
              'peakQueuedBytes': 0, 'peakQueuedEvents': 0, 'toolEffects': 0}
    class SafeFaultHandler(logging.Handler):
        def emit(self, record):
            if (record.msg == 'voice_frontend_failed stage=%s code=%s queuedBytes=%d queuedEvents=%d publicationQueueDepth=%d'
                    and isinstance(record.args, tuple) and len(record.args) == 5
                    and record.args[1] in module.FAULT_CODES):
                result['failure'] = record.args[1]
                result['failureStage'] = record.args[0]
                result['peakQueuedBytes'] = max(result['peakQueuedBytes'], record.args[2])
                result['peakQueuedEvents'] = max(result['peakQueuedEvents'], record.args[3])
                result['failurePublicationQueueDepth'] = record.args[4]
    handler = SafeFaultHandler()
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.ERROR)
    failed = asyncio.Event()
    context = {'sequence': 0, 'context': 'Synthetic fixture: Research holds notes; Drafts holds unfinished documents.',
               'updates': [], 'cameraTargets': []}
    async def backend(path, body=None):
        if body is None and '/voice/context?' in path:
            return context
        return {'accepted': False, 'reply': 'Synthetic probe refuses every effect.'}
    def failure(*args):
        result['failure'] = result['failure'] or 'frontend_task_failed'
        failed.set()
    async with ClientSession() as http:
        owner = SimpleNamespace(http=http, env={
            'MEDIA_ELEVENLABS_ENABLED': 'true', 'MEDIA_TWO_WAY_VOICE_ENABLED': 'true',
            'ELEVENLABS_API_KEY': os.environ.get('ELEVENLABS_API_KEY', ''),
            'ELEVENLABS_AGENT_ID': os.environ.get('ELEVENLABS_AGENT_ID', '')}, backend=backend)
        parent = SimpleNamespace(id='synthetic_burst_probe', call_id='synthetic_call', owner=owner, active=True, allowed=True,
            closing=False, pause_latched=False, two_way=True, policy_at=time.monotonic(),
            speaking=False, playback_generation=0, conversation_revision=0, first_audio_published=False,
            audio=asyncio.Queue(maxsize=100), playback_event=lambda *_: None,
            request_failure=failure, observe_audio_activity=lambda *_: None, stream=None)
        frontend = module.ElevenLabsFrontend(parent)
        original_handle = frontend.handle
        async def observed_handle(value):
            if isinstance(value, dict) and value.get('type') == 'audio':
                event = value.get('audio_event')
                event = event if isinstance(event, dict) else {}
                identity, encoded = event.get('event_id'), event.get('audio_base_64')
                metadata = {'identityType': type(identity).__name__ if type(identity) in (int, str, bool, float, type(None)) else 'other',
                            'identityNonnegative': type(identity) is int and identity >= 0,
                            'encodedIsString': isinstance(encoded, str),
                            'encodedCharacters': len(encoded) if isinstance(encoded, str) else 0}
                if isinstance(encoded, str) and len(encoded) <= module.WS_MESSAGE_BYTES:
                    try:
                        decoded = base64.b64decode(encoded, validate=True)
                        metadata.update(base64Valid=True, decodedBytes=len(decoded), pcmEven=len(decoded) % 2 == 0)
                        del decoded
                    except ValueError:
                        metadata['base64Valid'] = False
                result['lastAudioEvent'] = metadata
                result['largestAudioEncodedCharacters'] = max(result.get('largestAudioEncodedCharacters', 0), metadata['encodedCharacters'])
            await original_handle(value)
        frontend.handle = observed_handle
        def cancel(*args, **kwargs):
            frontend.cutoff()
            parent.playback_generation += 1
            while not parent.audio.empty():
                item = parent.audio.get_nowait()[1]
                if isinstance(item, asyncio.Future): item.cancel()
        owner.cancel_speech = cancel
        async def consume():
            while True:
                generation, value = await parent.audio.get()
                if generation != parent.playback_generation:
                    if isinstance(value, asyncio.Future): value.cancel()
                    continue
                if isinstance(value, asyncio.Future):
                    if not value.done(): value.set_result(None)
                else:
                    await asyncio.sleep(.02)
                    result['publishedFrames'] += 1
        async def monitor():
            while True:
                parent.policy_at = time.monotonic()
                result['peakQueuedBytes'] = max(result['peakQueuedBytes'], frontend.audio_bytes)
                result['peakQueuedEvents'] = max(result['peakQueuedEvents'], frontend.audio_events.qsize())
                await asyncio.sleep(.005)
        tasks = [asyncio.create_task(consume()), asyncio.create_task(monitor())]
        try:
            await frontend.start()
            await frontend.send({'type': 'user_message', 'text': 'Briefly explain Research and Drafts folders.'})
            try:
                await asyncio.wait_for(failed.wait(), seconds)
            except TimeoutError:
                pass
        except Exception as error:
            result['failure'] = module.failure_code(error)
        finally:
            parent.closing = True
            cancel()
            await frontend.close()
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        result['queuedBytesAfterStop'] = frontend.audio_bytes
        result['queuedEventsAfterStop'] = frontend.audio_events.qsize()
    result['elapsedMs'] = round((time.monotonic() - started) * 1000)
    logging.getLogger().removeHandler(handler)
    print(json.dumps(result, sort_keys=True))
    return 1 if result['failure'] or not result['publishedFrames'] else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-bound', action='store_true')
    parser.add_argument('--seconds', type=int, choices=range(5, 61), default=30)
    args = parser.parse_args()
    # Only the frontend's explicitly sanitized failure record is emitted.
    logging.getLogger().handlers.clear()
    raise SystemExit(asyncio.run(probe(args.legacy_bound, args.seconds)))
