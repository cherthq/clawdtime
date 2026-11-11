#!/usr/bin/env python3
"""Read-only companion readiness. Never prompts, arms, leases, captures or inputs."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Helper redirects are refused.')


def private_config(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Configuration must be your regular mode-0600 file.')
    config = json.loads(path.read_text())
    if config.get('bind') != '127.0.0.1' or config.get('port') != 4213:
        raise ValueError('This internal pilot doctor only accesses the independent 127.0.0.1:4213 helper.')
    if not isinstance(config.get('secret'), str) or len(config['secret']) < 32:
        raise ValueError('Invalid helper credential.')
    return config


def inspect(config, get):
    status = get('/v1/status')
    if not isinstance(status, dict) or status.get('deviceId') != config.get('deviceId'):
        raise ValueError('Connected helper identity differs from ClawdTime configuration.')
    if any(type(status.get(k)) is not bool for k in ('armed', 'available', 'screenPermission', 'controlPermission')):
        raise ValueError('Malformed helper readiness.')
    displays = get('/v1/displays')
    if not isinstance(displays, list):
        raise ValueError('Malformed display metadata.')
    observed = {d.get('id') for d in displays if isinstance(d, dict) and type(d.get('id')) is int}
    selected = config.get('displays', [])
    attached = bool(selected) and all(d.get('displayId') in observed for d in selected)
    control_configured = bool(selected) and all(bool(d.get('controllers')) for d in selected)
    permissions = get('/v1/permissions')
    if not isinstance(permissions, list):
        raise ValueError('Malformed runtime permission metadata.')
    loaded = {p.get('displayId'): p for p in permissions if isinstance(p, dict)}
    view_acl = bool(selected) and all(d.get('displayId') in loaded and set(d.get('viewers', [])) <= set(loaded[d['displayId']].get('viewers', [])) for d in selected)
    control_acl = view_acl and control_configured and all(set(d.get('controllers', [])) <= set(loaded[d['displayId']].get('controllers', [])) for d in selected)
    ready_view = status['armed'] and status['available'] and status['screenPermission'] and attached and view_acl
    steps = []
    if not status['screenPermission']:
        steps.append('In ClawdTime Companion Setup choose Grant Screen Recording; allow this installed app in macOS Settings and relaunch if requested.')
    if control_configured and not status['controlPermission']:
        steps.append('In ClawdTime Companion Setup choose Grant Accessibility; allow this installed app in macOS Settings.')
    if not attached:
        steps.append('The explicitly paired display is not attached; recheck display selection rather than selecting another screen automatically.')
    if not selected:
        steps.append('Bootstrap has no pairing grants. Complete verified messaging pairing, activate that claim, then relaunch only ClawdTime Companion.')
    elif not view_acl or (control_configured and not control_acl):
        steps.append('Running helper ACL differs from the paired configuration. Stop and relaunch only ClawdTime Companion with its exact configuration.')
    if not status['available']:
        steps.append('The intended Mac console session must be awake, unlocked and active.')
    if not status['armed']:
        steps.append('When ready for the supervised test, choose Enable locally in ClawdTime Companion Setup. This enables authorized requests without capturing immediately.')
    return {'deviceId': status['deviceId'], 'armed': status['armed'], 'available': status['available'],
        'screenPermission': status['screenPermission'], 'controlPermission': status['controlPermission'],
        'selectedDisplaysAttached': attached, 'viewACLLoaded': view_acl, 'controlACLLoaded': control_acl, 'controlACLConfigured': control_configured,
        'activeLease': bool(status.get('activeLeaseId')), 'readyForView': ready_view,
        'readyForControl': ready_view and control_acl and status['controlPermission'],
        'physicalAcceptance': False, 'nextSteps': steps}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = private_config(args.config)
    opener = build_opener(NoRedirect())
    def get(path):
        request = Request('http://127.0.0.1:4213' + path, headers={'Authorization': 'Bearer ' + config['secret']})
        with opener.open(request, timeout=3) as response:
            data = response.read(16385)
            if len(data) > 16384:
                raise ValueError('Helper metadata exceeds bound.')
            return json.loads(data)
    result = inspect(config, get)
    print(json.dumps(result, indent=2))
    return 0 if result['readyForView'] else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, HTTPError, URLError, json.JSONDecodeError):
        print(json.dumps({'reachable': False, 'physicalAcceptance': False,
            'error': 'ClawdTime helper readiness unavailable or invalid. Launch the exact installed app with its private configuration; inspect port 4213 and its permission window. No capture was attempted.'}))
        sys.exit(1)
