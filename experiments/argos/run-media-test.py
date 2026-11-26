"""Live cloud audio/video test with synthetic content. Never dials a phone."""
import asyncio
import json
import logging
import os
from pathlib import Path
import sys
import time
import httpx

LAB = Path(__file__).resolve().parent
os.environ['PYTHON_DOTENV_DISABLED'] = '1'
os.environ['ESCALATION_MODE'] = 'mock'
sys.path.insert(0, str(LAB / 'source'))
logging.disable(logging.CRITICAL)

from dotenv import dotenv_values
from escalation_mcp.config import Settings

def configuration():
    from private_config import private_env
    variables = private_env(LAB / '.private' / 'media.env')
    settings=Settings(mode='live', livekit_url=variables['LIVEKIT_URL'],
        livekit_api_key=variables['LIVEKIT_API_KEY'],livekit_api_secret=variables['LIVEKIT_API_SECRET'])
    credentials=private_env(LAB / '.private' / 'elevenlabs.env')
    response=httpx.get('https://api.elevenlabs.io/v1/convai/agents/'+credentials['ELEVENLABS_AGENT_ID'],
        headers={'xi-api-key':credentials['ELEVENLABS_API_KEY']},timeout=15)
    response.raise_for_status()
    agent=response.json(); conversation=agent['conversation_config']; platform=agent['platform_settings']
    prompt=conversation['agent']['prompt']; tools=prompt.get('tools',[])
    expected={'show_code':'client','show_full_screen':'client','end_call':'system'}
    if {t.get('name'):t.get('type') for t in tools} != expected:
        raise RuntimeError('Dedicated agent tool configuration changed')
    if prompt.get('mcp_server_ids') or prompt.get('native_mcp_server_ids') or prompt.get('knowledge_base'):
        raise RuntimeError('Dedicated agent external context changed')
    privacy=platform['privacy']
    if privacy.get('record_voice') is not False or privacy.get('retention_days') != 0:
        raise RuntimeError('Dedicated agent retention configuration changed')
    if platform['auth'].get('enable_auth') is not True or conversation['conversation']['max_duration_seconds'] > 180:
        raise RuntimeError('Dedicated agent lifecycle configuration changed')
    return settings,credentials

async def main():
    from media_trial import run_media
    settings,credentials=await asyncio.to_thread(configuration)
    print('Starting bounded synthetic ElevenLabs + LiveKit test; no phone dial, microphone or screen capture.',flush=True)
    result=await run_media(settings,credentials['ELEVENLABS_API_KEY'],
        credentials['ELEVENLABS_AGENT_ID'],smoke=True,seconds=45)
    path=LAB/'output'/('media-test-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'.json')
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
    print('Result:',path)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('Local stop received.')
    except Exception as error:
        print(json.dumps({'success':False,'error_type':type(error).__name__,'phone_dialed':False}))
        raise SystemExit(1)
