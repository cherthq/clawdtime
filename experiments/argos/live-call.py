"""Lead-controlled one-call trial. Defaults to read-only checks; never pauses an owner."""
from __future__ import annotations
import argparse
import asyncio
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
import httpx
from connector_preflight import scoped_cli_headers, connectors_idle

LAB=Path(__file__).resolve().parent
PRIVATE=LAB/'.private'
os.environ['PYTHON_DOTENV_DISABLED']='1'
os.environ['ESCALATION_MODE']='mock'
sys.path.insert(0,str(LAB/'source'))

def load_owner():
    from private_config import private_json
    config = private_json(PRIVATE / 'line.json')
    destination = config['destination']
    if (not isinstance(destination, str) or not destination.startswith('+')
        or not destination[1:].isdigit() or not 8 <= len(destination[1:]) <= 15
        or destination not in config['testerAllowlist']):
        raise RuntimeError('allowlisted_tester_unavailable')
    return config

async def preflight(config):
    n=config['native']; b=n['binding']; checks={}
    async with httpx.AsyncClient(timeout=15) as client:
        headers={'Authorization':'Bearer '+n['projectKey'],'X-Chert-Project-Id':n['projectId']}
        response=await client.get(n['callsOrigin']+'/api/v1/lines/'+b['lineId'],headers=headers)
        line=response.json().get('data',{}) if response.status_code==200 else {}
        health=line.get('session_health') or {}; ready=health.get('readiness') or {}
        checks['exact_selected_line']=(line.get('id')==b['lineId'] and line.get('phone_number')==b['phone']
            and line.get('worker_id')==b['workerId'] and line.get('shared_line') is False)
        checks['assignment_current']=(line.get('assignment_generation')==b['assignmentGeneration']
            and line.get('runtime_ack_generation')==b['assignmentGeneration'])
        checks['identity_confirmed']=(health.get('line_id')==b['lineId'] and health.get('identity_confirmed') is True)
        try:
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(health['last_heartbeat_at'])).total_seconds()
        except (KeyError,TypeError,ValueError):
            age=9999
        checks['worker_ready']=(0<=age<45 and health.get('status')=='accepting'
            and ready.get('production_media_ready') is True and ready.get('control_ready') is True)
        checks['line_idle']=(line.get('worker_occupied') is False and 'current_call_id' in line
            and line['current_call_id'] is None and line.get('status')=='available')
        integrations=await client.get(n['callsOrigin']+'/api/v1/integrations',headers=headers)
        raw=integrations.json().get('data',{}) if integrations.status_code==200 else {}
        items=raw if isinstance(raw,list) else raw.get('items',[])
        checks['no_existing_handler']=(integrations.status_code==200 and not items
            and line.get('default_assistant_id') is None and line.get('integration_id') is None
            and line.get('inbound_policy')=='customer_decides')
        # Project keys cannot inspect connectors. Use the separately approved,
        # project-scoped CLI login, and retain revoked historical bindings.
        cli_headers=scoped_cli_headers(PRIVATE/'cli'/'credentials.json',
            n['projectId'],n['callsOrigin'])
        checks['connector_ownership_verified']=False
        if cli_headers:
            connectors=await client.get(n['callsOrigin']+'/api/v1/connectors',headers=cli_headers)
            checks['connector_ownership_verified']=connectors_idle(connectors,n['projectId'],b['lineId'])
        calls=await client.get(n['callsOrigin']+'/api/v1/calls?limit=100&offset=0',headers=headers)
        data=calls.json().get('data',{}) if calls.status_code==200 else {}
        checks['no_active_project_calls']=(calls.status_code==200 and data.get('total',101)<=100
            and all(c.get('status') in ['ended','failed','rejected','canceled','cancelled','no_answer','busy'] for c in data.get('items',[])))
        return checks


async def main(args):
    config=await asyncio.to_thread(load_owner)
    checks=await preflight(config)
    print(json.dumps({'ready':all(checks.values()),'checks':checks,'dialAttempted':False},indent=2),flush=True)
    if not all(checks.values()) or not args.call:
        return 2 if not all(checks.values()) else 0
    # Local exclusive lock complements (does not replace) the paused owner and provider checks.
    PRIVATE.mkdir(mode=0o700,exist_ok=True)
    fd=os.open(PRIVATE/'live-call.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if (PRIVATE/'live-call-receipt.json').exists():
            raise RuntimeError('prior_attempt_requires_reconciliation')
        spec=importlib.util.spec_from_file_location('media_driver',LAB/'run-media-test.py')
        driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
        settings,credentials=await asyncio.to_thread(driver.configuration)
        from media_trial import run_media
        from call_guard import CallGuard
        from escalation_mcp.livekit_room import mint_token
        n=config['native']; b=n['binding']
        async with httpx.AsyncClient(base_url=n['callsOrigin'].rstrip('/'),headers={
            'Authorization':'Bearer '+n['projectKey'],'X-Chert-Project-Id':n['projectId']},timeout=20) as client:
            guard=CallGuard(client,PRIVATE/'live-call-receipt.json')

            async def ready(room,settings,stop):
                if stop.is_set() or not all((await preflight(config)).values()):
                    raise RuntimeError('readiness_changed_before_dial')
                body={'direction':'outbound','mode':'customer_managed','line_id':b['lineId'],
                    'destination':config['destination'],'destination_type':'phone',
                    'media':{'audio':True,'video':True},'livekit_url':settings.livekit_url,
                    'participant_token':mint_token(settings,identity='chert-bridge',room=room.room.name,ttl_hours=0.1),
                    'remote_participant_identity':'agent','when_busy':'fail'}
                result=await guard.place(body)
                print(json.dumps({'call':result}),flush=True)
                if result.get('state') != 'placed' or not result.get('call_id'):
                    raise RuntimeError('call_not_established')

            async def stopped(reason):
                result=await guard.end(timeout=20)
                print(json.dumps({'cleanup':result}),flush=True)
                if (result.get('state') != 'cleanup_complete' and result.get('error') != 'no_call'
                    and not (result.get('state') == 'rejected' and not result.get('call_id'))):
                    raise RuntimeError('provider_cleanup_unconfirmed')

            result=await run_media(settings,credentials['ELEVENLABS_API_KEY'],credentials['ELEVENLABS_AGENT_ID'],
                smoke=False,seconds=180,on_ready=ready,on_stop=stopped)
            print(json.dumps(result,indent=2),flush=True)
            # This program never enables, disables or resumes another application.
            return 0 if result['status'] in ['completed','stopped'] else 1
    finally:
        os.close(fd)

if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--call',action='store_true',help='Place one authorized test only after every handoff check passes')
    args=parser.parse_args()
    try:
        raise SystemExit(asyncio.run(main(args)))
    except KeyboardInterrupt:
        print('Local stop received; inspect any retained receipt before another attempt.')
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({'status':'blocked','error_type':type(error).__name__,'details':'No automatic retry; inspect retained receipts.'}))
        raise SystemExit(2)
