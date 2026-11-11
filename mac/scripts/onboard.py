#!/usr/bin/env python3
"""Resumable local setup. Never launch/arm/reset TCC or replace an installed app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from urllib.request import Request, build_opener

import configure
import doctor
import prepare_launchagent

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = 'com.clawdtime.companion'
APP_NAME = 'ClawdTime Companion.app'


def result(status, code, instructions=(), **fields):
    return {'schema': 'clawdtime.onboarding/1', 'status': status,
            'scope': 'local_companion',
            'nextAction': 'continue' if status == 'ready' else 'ask_user',
            'code': code, 'instructions': list(instructions),
            'physicalAcceptance': False, 'remoteVerificationRequired': True, **fields}


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Private setup directory is unsafe.')
    if path.resolve() != path.absolute():
        raise ValueError('Setup directory may not traverse symlinks.')


def verify_app(app, pilot=False, team=None, run=subprocess.run):
    if app.is_symlink() or not app.is_dir():
        raise ValueError('Companion bundle is unavailable or unsafe.')
    with (app / 'Contents/Info.plist').open('rb') as handle:
        info = plistlib.load(handle)
    if info.get('CFBundleIdentifier') != BUNDLE or info.get('CFBundleExecutable') != 'ClawdTimeCompanion':
        raise ValueError('Companion bundle identity differs.')
    binary = app / 'Contents/MacOS/ClawdTimeCompanion'
    if binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('Companion executable unavailable.')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True, timeout=15)
    signed = run(['/usr/bin/codesign', '-dv', str(app)], check=True, capture_output=True, text=True, timeout=15)
    if not pilot:
        if not team or not re.fullmatch(r'[A-Z0-9]{10}', team) or ('TeamIdentifier=' + team) not in signed.stderr.splitlines():
            raise ValueError('A separately trusted signing team is required.')
        run(['/usr/sbin/spctl', '--assess', '--type', 'execute', str(app)], check=True, capture_output=True, timeout=30)
    return binary


def install_release(manifest_path, app, trusted_team, run=subprocess.run):
    """Local verified artifact only; caller supplies trust anchor, never manifest alone."""
    if app.exists() or app.is_symlink():
        raise ValueError('An installed app is never replaced during onboarding.')
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('schema') != 'clawdtime.companion-release/1'
            or manifest.get('bundleId') != BUNDLE
            or not trusted_team or manifest.get('teamId') != trusted_team):
        raise ValueError('Release manifest or independent signing trust is invalid.')
    artifact = Path(manifest.get('artifact', ''))
    if not artifact.is_absolute() or artifact.is_symlink() or not artifact.is_file():
        raise ValueError('A local verified release ZIP is required.')
    expected = manifest.get('sha256', '')
    if not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('Release checksum is invalid.')
    with artifact.open('rb') as handle:
        if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
            raise ValueError('Release checksum differs.')
    # Reject traversal, links and oversized archives before the native extractor.
    with zipfile.ZipFile(artifact) as archive:
        entries = archive.infolist()
        if len(entries) > 20000 or sum(i.file_size for i in entries) > 512 * 1024 * 1024:
            raise ValueError('Release archive exceeds installation limits.')
        for item in entries:
            p = Path(item.filename)
            if p.is_absolute() or '..' in p.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('Release archive contains unsafe paths.')
    app.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.clawdtime-install-', dir=app.parent) as temporary:
        staging = Path(temporary)
        run(['/usr/bin/ditto', '-x', '-k', str(artifact), str(staging)], check=True, capture_output=True, timeout=60)
        candidate = staging / APP_NAME
        verify_app(candidate, team=trusted_team, run=run)
        # No overwrite: another setup winning this race is preserved.
        app.mkdir(mode=0o755)
        try:
            for item in candidate.iterdir():
                shutil.move(str(item), str(app / item.name))
            verify_app(app, team=trusted_team, run=run)
        except Exception:
            # Retain the failed installation for inspection, never silently retry.
            raise ValueError('Installation incomplete; preserve installed path for operator inspection.') from None


def binding_matches(binding, expected):
    return binding == expected


def ensure_pairing(claim, displays, directory, relay_url=None, check_only=False):
    pairing, acl, binding = configure.paired_acl(claim, displays)
    if not directory.exists():
        if directory.is_symlink() or directory.resolve() != directory.absolute():
            raise ValueError('New setup directory may not traverse symlinks.')
        if check_only:
            return False
        if not relay_url:
            raise ValueError('Fresh configuration requires its operator-provisioned relay URL.')
        configure.prepare(claim, displays, directory, relay_url)
        return True
    private_directory(directory)
    helper = doctor.private_config(directory / 'helper.json')
    old = configure.private_read(directory / 'pairing-binding.json')
    if helper.get('deviceId') != pairing['deviceId']:
        raise ValueError('Existing companion belongs to another device.')
    if helper.get('displays') == acl and binding_matches(old, binding):
        return False
    if check_only:
        if helper.get('displays') == [] and old == {'deviceId': pairing['deviceId'], 'paired': False}:
            return False
        raise ValueError('Existing pairing differs; preserve its authorization.')
    configure.activate(claim, displays, directory)
    return True


def prepare_gateway(directory, python):
    """Prepare a definition beside config; never load a job or replace a definition."""
    configure.private_read(directory / 'gateway.json')
    target = directory / (prepare_launchagent.LABEL + '.plist')
    script = ROOT / 'gateway/start.py'
    arguments = [str(python.absolute()), str(script), '--config', str(directory / 'gateway.json')]
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Existing gateway definition is unsafe.')
        with target.open('rb') as handle:
            existing = plistlib.load(handle)
        if existing.get('Label') != prepare_launchagent.LABEL or existing.get('ProgramArguments') != arguments:
            raise ValueError('Existing gateway definition differs; operator review required.')
        return target
    prepare_launchagent.prepare(directory / 'gateway.json', python, script, target)
    return target


def read_readiness(config):
    opener = build_opener(doctor.NoRedirect())
    runtime_permissions = None
    def get(path):
        nonlocal runtime_permissions
        request = Request('http://127.0.0.1:4213' + path, headers={'Authorization': 'Bearer ' + config['secret']})
        with opener.open(request, timeout=3) as response:
            data = response.read(16385)
            if len(data) > 16384:
                raise ValueError('Helper metadata exceeds limit.')
            value = json.loads(data)
            if path == '/v1/permissions':
                runtime_permissions = value
            return value
    readiness = doctor.inspect(config, get)
    # Onboarding must verify the exact newly loaded scope, not merely membership
    # in an old or broader ACL accepted by a generic readiness probe.
    def scope(rows):
        return sorted((row['displayId'], tuple(sorted(row['viewers'])), tuple(sorted(row['controllers']))) for row in rows)
    if scope(runtime_permissions) != scope(config['displays']):
        readiness.update(viewACLLoaded=False, controlACLLoaded=False, readyForView=False, readyForControl=False)
        readiness['nextSteps'].append('Running helper grants differ from the exact paired configuration. Stop and relaunch only ClawdTime Companion to load this claim.')
    return readiness


def readiness_result(readiness, needs_control):
    if readiness['readyForView'] and (not needs_control or readiness['readyForControl']):
        return result('ready', 'local_ready', ['Local companion checks passed. Verify the paired backend and gateway with agent doctor before completing setup.'], readiness=readiness)
    if not readiness['viewACLLoaded'] or (needs_control and not readiness['controlACLLoaded']):
        code = 'companion_reload_required'
    elif not readiness['screenPermission']:
        code = 'screen_recording_required'
    elif needs_control and not readiness['controlPermission']:
        code = 'accessibility_required'
    elif not readiness['selectedDisplaysAttached']:
        code = 'paired_display_unavailable'
    elif not readiness['available']:
        code = 'console_unavailable'
    else:
        code = 'local_enable_required'
    return result('blocked', code, readiness['nextSteps'], readiness=readiness)


def onboard(args, run=subprocess.run, inspect=read_readiness):
    claim = configure.private_read(args.claim)
    if not isinstance(claim, dict) or not isinstance(claim.get('pairing', claim), dict):
        raise ValueError('Pairing receipt is malformed.')
    pairing = claim.get('pairing', claim)
    app = args.app.absolute()
    directory = args.directory.absolute()
    if not app.exists():
        if args.manifest and not args.check_only:
            install_release(args.manifest, app, args.trusted_team_id, run)
        else:
            return result('blocked', 'companion_install_required', ['Install the verified ClawdTime Companion release at ' + str(app) + '. No public release URL is configured; the pilot operator must supply an approved app.'], nextAction='operator')
    binary = verify_app(app, pilot=args.pilot_installed, team=args.trusted_team_id, run=run)
    observed = run([str(binary), '--list-displays'], check=True, capture_output=True, text=True, timeout=10)
    displays = json.loads(observed.stdout)
    if not isinstance(displays, list):
        raise ValueError('Invalid display discovery response.')
    changed = ensure_pairing(claim, displays, directory, args.relay_url, args.check_only)
    if not directory.exists():
        return result('blocked', 'configuration_required', ['Run setup without --check-only to prepare this verified claim.'])
    config = doctor.private_config(directory / 'helper.json')
    if not config.get('displays'):
        return result('blocked', 'pairing_activation_required', ['Run setup without --check-only to activate the verified claim.'])
    run([str(binary), '--config', str(directory / 'helper.json'), '--check-config'], check=True, capture_output=True, timeout=10)
    gateway_prepared = False
    if not args.check_only and args.gateway_python.is_file():
        prepare_gateway(directory, args.gateway_python)
        gateway_prepared = True
    try:
        readiness = inspect(config)
    except (OSError, ValueError):
        return result('blocked', 'companion_launch_required',
            ['Open ' + str(app) + ' with --config ' + str(directory / 'helper.json') + '; complete its local Setup window, then run setup again.'],
            configurationChanged=changed, gatewayPrepared=gateway_prepared)
    answer = readiness_result(readiness, pairing.get('allowControl') is True)
    answer.update(configurationChanged=changed, gatewayPrepared=gateway_prepared)
    if not args.gateway_python.is_file():
        answer['instructions'].append('The pilot operator must prepare the gateway Python environment and provision the independent media device mapping; local readiness alone does not establish remote readiness.')
    return answer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claim', type=Path, required=True)
    parser.add_argument('--directory', type=Path, default=Path.home() / 'Library/Application Support/ClawdTimeCompanion/setup')
    parser.add_argument('--app', type=Path, default=Path.home() / 'Applications' / APP_NAME)
    parser.add_argument('--relay-url')
    parser.add_argument('--pilot-installed', action='store_true', help='Explicitly trust the existing local pilot bundle after strict signature verification; no replacement')
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--manifest', type=Path, help='Local release manifest plus ZIP; never a download URL')
    parser.add_argument('--trusted-team-id', help='Publisher team identifier obtained independently from the release manifest')
    parser.add_argument('--gateway-python', type=Path, default=ROOT / 'gateway/.venv/bin/python')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        answer = onboard(args)
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError, zipfile.BadZipFile, plistlib.InvalidFileException):
        answer = result('error', 'setup_refused', ['Configuration, pairing or release verification failed. Preserve the existing installation and receipts; ask the pilot operator to inspect the private setup.'], nextAction='operator')
    print(json.dumps(answer))
    return 0 if answer['status'] == 'ready' else 2 if answer['status'] == 'blocked' else 1


if __name__ == '__main__':
    sys.exit(main())
