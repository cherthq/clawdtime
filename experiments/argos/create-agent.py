"""Create one dedicated Argos lab agent; retain unknown outcomes, never blind retry."""
import json
import os
from pathlib import Path
import httpx
from dotenv import set_key
from private_config import private_env

LAB = Path(__file__).resolve().parent
PRIVATE = LAB / '.private'
RECEIPT = PRIVATE / 'agent-create.json'
NAME = 'Argos Lab — FaceTime Test'
PROMPT = '''You are Argos, a concise conversational coding reviewer in a supervised FaceTime audio/video test. Speak naturally in one or two short sentences at a time and let the caller interrupt. This is a synthetic demonstration, not a live coding executor. The displayed fixture shows demo/configs/bad_lr.yaml with learning rate 20.0. Proposal 1 is required for this demo: lower it to 0.1 to address divergence. Proposal 2 is optional: a linear output for negative targets. These are prepared example proposals, not findings from inspecting the caller's machine. Explain the distinction between required and optional changes. Use show_code to focus the highlighted learning-rate line, and show_full_screen to show the full fixture when asked. Only claim camera movement after a successful tool result; it does not prove handset visibility. You cannot edit code, run commands, browse, send messages, or delegate to Grok in this test. If asked to apply a fix, explain that execution is disabled for this media test. Ask the caller to confirm they hear you and can see the code card, then invite an interruption and a camera request. Never treat background speech or silence as approval. Say one short goodbye and call end_call when asked to stop, hang up, or when the caller says they are done. Do not invent test success or claim to be the Codex session.'''

def tool(name, description, props):
    return {'type':'client', 'name':name, 'description':description,
        'expects_response':True, 'response_timeout_secs':10,
        'parameters':{'type':'object','properties':props,'required':[]}}

PAYLOAD = {
    'name':NAME,
    'conversation_config':{
        'asr':{'user_input_audio_format':'pcm_16000'},
        'tts':{'model_id':'eleven_flash_v2','agent_output_audio_format':'pcm_16000'},
        'turn':{'turn_timeout':10,'turn_eagerness':'normal'},
        'conversation':{'max_duration_seconds':180,'client_events':['audio','interruption','user_transcript','agent_response','agent_response_correction']},
        'agent':{'language':'en','first_message':"Hi, I'm Argos. This is our FaceTime voice and code-camera test. Can you hear me and see the demo code card?",
            'prompt':{'prompt':PROMPT,'llm':'gemini-2.5-flash','temperature':0.3,
                'tools':[tool('show_code','Focus the synthetic highlighted learning-rate line.',{'query':{'type':'string','description':'The example line to show.'}}),
                         tool('show_full_screen','Show the entire synthetic demo card.',{})],
                'built_in_tools':{'end_call':{'type':'system','name':'end_call','params':{'system_tool_type':'end_call'}}}}}},
    'platform_settings':{
        'auth':{'enable_auth':True},
        'call_limits':{'agent_concurrency_limit':1,'daily_limit':10,'bursting_enabled':False},
        'privacy':{'record_voice':False,'retention_days':0,'delete_transcript_and_pii':True,'delete_audio':True},
        'overrides':{'conversation_config_override':{'agent':{'prompt':{'prompt':True},'first_message':True}}}}
}

def save(value):
    fd=os.open(RECEIPT,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(value,f,indent=2); f.flush(); os.fsync(f.fileno())

if __name__ == '__main__':
    os.umask(0o077)
    env=PRIVATE/'elevenlabs.env'
    key=private_env(env)['ELEVENLABS_API_KEY']
    with httpx.Client(base_url='https://api.elevenlabs.io',headers={'xi-api-key':key},timeout=30) as client:
        existing=client.get('/v1/convai/agents',params={'page_size':100}); existing.raise_for_status()
        matches=[a for a in existing.json().get('agents',[]) if a.get('name')==NAME]
        if RECEIPT.exists() and json.loads(RECEIPT.read_text()).get('state') == 'rejected':
            RECEIPT.rename(PRIVATE / 'agent-create-rejected.json')
        if RECEIPT.exists() or matches:
            raise SystemExit('Existing attempt or agent found. Reconcile instead of creating another.')
        save({'state':'submitted_outcome_unknown','name':NAME})
        response=client.post('/v1/convai/agents/create',json=PAYLOAD)
        if not response.is_success:
            save({'state':'rejected' if response.status_code < 500 else 'unknown','http':response.status_code,'name':NAME})
            print('Creation HTTP',response.status_code)
            raise SystemExit(1)
        agent_id=response.json()['agent_id']
        save({'state':'created','agent_id':agent_id,'name':NAME})
        set_key(str(env),'ELEVENLABS_AGENT_ID',agent_id)
        verify=client.get('/v1/convai/agents/'+agent_id); verify.raise_for_status()
        data=verify.json(); cc=data['conversation_config']; ps=data['platform_settings']
        # Inline client tools on creation can replace the built-in tool map.
        # Reconcile the returned config and set only this dedicated agent's end_call.
        if not cc['agent']['prompt'].get('built_in_tools',{}).get('end_call'):
            patched=client.patch('/v1/convai/agents/'+agent_id,json={
                'conversation_config':{'agent':{'prompt':{'built_in_tools':
                    PAYLOAD['conversation_config']['agent']['prompt']['built_in_tools']}}}})
            patched.raise_for_status()
            verify=client.get('/v1/convai/agents/'+agent_id); verify.raise_for_status()
            data=verify.json(); cc=data['conversation_config']; ps=data['platform_settings']
        if not cc['agent']['prompt']['built_in_tools'].get('end_call'):
            raise SystemExit('Agent exists but end_call was not verified; do not recreate it.')
        print(json.dumps({'created':True,'agent_id':agent_id,'name':data['name'],
            'input':cc['asr']['user_input_audio_format'],'output':cc['tts']['agent_output_audio_format'],
            'max_seconds':cc['conversation']['max_duration_seconds'],'auth':ps['auth']['enable_auth'],
            'privacy':ps['privacy'],'tools':cc['agent']['prompt'].get('tool_ids',[])},indent=2))
