"""Print a reviewable dedicated-agent creation body. No environment reads/network.

This does not create or modify an agent. The operator must create a new dedicated
agent, retain its ID privately, and separately qualify the real audio path.
"""
import argparse
import json
import re

from elevenlabs_frontend import MIN_CONVERSATION_SECONDS, PROMPT, client_tool_definitions, validate_agent


def configuration(voice_id):
    if not isinstance(voice_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', voice_id):
        raise ValueError('An explicit provider voice ID is required')
    value = {
        'name': 'ClawdTime same-chat voice',
        'conversation_config': {
            'asr': {'user_input_audio_format': 'pcm_16000'},
            'tts': {'model_id': 'eleven_flash_v2', 'voice_id': voice_id, 'agent_output_audio_format': 'pcm_16000'},
            'turn': {'turn_timeout': 10, 'turn_eagerness': 'normal', 'silence_end_call_timeout': -1},
            'conversation': {'max_duration_seconds': MIN_CONVERSATION_SECONDS, 'client_events': [
                'audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction']},
            'agent': {'language': 'en', 'first_message': '',
                'prompt': {'prompt': PROMPT, 'llm': 'gemini-2.5-flash', 'temperature': .3,
                           'tools': client_tool_definitions(), 'built_in_tools': {}}}},
        'platform_settings': {
            'auth': {'enable_auth': True},
            'queueing_config': {'enabled': False},
            'call_limits': {'agent_concurrency_limit': 1, 'daily_limit': 10, 'bursting_enabled': False},
            'privacy': {'record_voice': False, 'retention_days': 0, 'delete_transcript_and_pii': True, 'delete_audio': True},
            'overrides': {'conversation_config_override': {'agent': {'prompt': {'prompt': True}, 'first_message': True}}}},
    }
    validate_agent(value, value['conversation_config']['agent']['prompt']['tools'])
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--voice-id', required=True, help='Explicit ElevenLabs voice ID; no credentials are used.')
    args = parser.parse_args()
    try:
        print(json.dumps(configuration(args.voice_id), indent=2))
    except ValueError:
        parser.error('Invalid voice ID or agent configuration')
