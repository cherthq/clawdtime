"""One no-audio GPT-Live session probe. Run only with lead-managed credentials.

This is provider access evidence, not a handset, delegation, or execution test.
No microphone, LiveKit room, broker, tool, transcript, or model audio is used.
"""
import asyncio
import json
import logging
import os
import re
import ssl
import time
from importlib.metadata import PackageNotFoundError, version

from conversational import sdk_readiness


def verified_tls_context():
    # Scope trust to this connection. Never disable hostname/certificate checks
    # or modify the host's trust store (macOS framework Python may lack a CA path).
    import certifi
    return ssl.create_default_context(cafile=certifi.where())


async def probe(api_key, *, startup_timeout=12., close_timeout=3., _fixture_url=None, audio_qualification=False):
    if not .05 <= startup_timeout <= 20 or not .05 <= close_timeout <= 5:
        raise ValueError('Probe deadlines exceed bounds')
    if _fixture_url is not None and (api_key != 'synthetic' or not _fixture_url.startswith('http://127.0.0.1:')):
        raise ValueError('Only synthetic loopback fixtures may override the endpoint')
    result = {'model': 'gpt-live-1', 'delegation': 'client', 'sdk': sdk_readiness(),
              'audioQualificationConfig': audio_qualification,
              'attempts': 0, 'started': False, 'finalized': False,
              'transport_closed': False, 'status': 'unavailable'}
    if not result['sdk']['available']:
        result['reason'] = result['sdk']['reason']
        return result
    if not api_key:
        result['reason'] = 'direct_api_key_missing'
        return result
    try:
        if version('websockets') != '15.0.1':
            result['reason'] = 'probe_websocket_version_mismatch'
            return result
    except PackageNotFoundError:
        result['reason'] = 'probe_websocket_dependency_missing'
        return result
    from openai import AsyncOpenAI
    # Explicit endpoint prevents OPENAI_BASE_URL from silently redirecting a real key.
    client = AsyncOpenAI(api_key=api_key, base_url=_fixture_url or 'https://api.openai.com/v1',
                         max_retries=0, timeout=startup_timeout)
    connection = None
    close_sent = False
    stage = 'connect'
    started_at = time.monotonic()

    def exception_metadata(exc):
        result['failure_stage'] = stage
        types = []
        current = exc
        for _ in range(4):
            if current is None or any(current is prior for prior in types):
                break
            types.append(current)
            code = getattr(current, 'status_code', None) or getattr(getattr(current, 'response', None), 'status_code', None)
            if type(code) is int and 400 <= code <= 599:
                result['http_status'] = code
            for attribute in ('errno', 'verify_code'):
                value = getattr(current, attribute, None)
                if type(value) is int and -100000 <= value <= 100000:
                    result[attribute] = value
            current = current.__cause__ or current.__context__
        result['error_types'] = [type(item).__name__ for item in types
                                if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', type(item).__name__)]

    def provider_error(event):
        result['status'] = 'provider_error'
        for field, pattern in [('code', r'[A-Za-z0-9_]{1,80}'),
                               ('param', r'[A-Za-z0-9_.]{1,100}')]:
            value = getattr(event.error, field, None)
            if isinstance(value, str) and re.fullmatch(pattern, value):
                result['error_' + field] = value

    async def close_session():
        nonlocal close_sent
        if not close_sent:
            close_sent = True  # Never replay a possibly accepted close.
            await connection.session.close()
        async for event in connection:
            if event.type == 'error':
                provider_error(event)
            if event.type == 'session.closed':
                result['finalized'] = True
                result['close_requested_confirmed'] = getattr(event, 'reason', None) == 'close_requested'
                return
            # Never retain event payloads, including audio, session IDs or errors.

    try:
        result['attempts'] = 1
        async with asyncio.timeout(startup_timeout):
            options = {'open_timeout': startup_timeout, 'close_timeout': 1,
                       'max_size': 262144, 'max_queue': 4}
            if _fixture_url is None:
                options['ssl'] = verified_tls_context()
            connection = await client.live.connect(max_retries=0,
                websocket_connection_options=options).enter()
            stage = 'session_start'
            config = {'model': 'gpt-live-1', 'delegation': {'type': 'client'},
                'store': False, 'instructions': 'This is a silent connection check. Do not speak or delegate.'}
            if audio_qualification:
                from acoustic import session_config
                config = session_config()
            await connection.session.start(session=config)
            stage = 'wait_session_started'
            async for event in connection:
                if event.type == 'session.started':
                    result['started'] = True
                    result['startup_ms'] = round((time.monotonic() - started_at) * 1000, 1)
                    result['status'] = 'session_started'
                    break
                if event.type == 'error':
                    provider_error(event)
                    break
                if event.type == 'session.closed':
                    result['finalized'] = True
                    result['status'] = 'closed_before_start'
                    break
            else:
                result['status'] = 'connection_ended_before_start'
    except asyncio.CancelledError:
        result['status'] = 'cancelled'
        raise
    except TimeoutError as exc:
        result['status'] = 'startup_timeout'
        exception_metadata(exc)
    except Exception as exc:
        # Error messages/bodies/URLs can contain secrets or arbitrary provider text.
        result['status'] = 'connection_failed'
        exception_metadata(exc)
    finally:
        if connection is not None:
            if not result['finalized']:
                try:
                    await asyncio.wait_for(close_session(), close_timeout)
                except (Exception, asyncio.CancelledError):
                    pass  # Report finalization unconfirmed; always release transport.
            try:
                await asyncio.wait_for(connection.close(), 2)
                result['transport_closed'] = True
            except (Exception, asyncio.CancelledError):
                pass
        try:
            await asyncio.wait_for(client.close(), 2)
        except (Exception, asyncio.CancelledError):
            pass
        result['elapsed_ms'] = round((time.monotonic() - started_at) * 1000, 1)
    result['ready_for_audio_test'] = (result['status'] == 'session_started' and result['started'] and result['finalized']
        and result['transport_closed'] and result.get('close_requested_confirmed') is True)
    return result


def main():
    # Standalone command deliberately suppresses SDK/debug HTTP logs and tracebacks.
    logging.disable(logging.CRITICAL)
    import argparse
    parser = argparse.ArgumentParser(description='No-input-audio Live session check; no handset or work.')
    parser.add_argument('--audio-qualification', action='store_true')
    args = parser.parse_args()
    try:
        result = asyncio.run(probe(os.environ.get('OPENAI_API_KEY'), audio_qualification=args.audio_qualification))
    except KeyboardInterrupt:
        result = {'status': 'cancelled', 'ready_for_audio_test': False}
    except Exception:
        result = {'status': 'probe_failed', 'ready_for_audio_test': False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get('ready_for_audio_test') else 1


if __name__ == '__main__':
    raise SystemExit(main())
