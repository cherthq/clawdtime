#!/usr/bin/env python3
"""Prepare only ClawdTime's local files. Never launch, arm, overwrite or grant TCC."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
from urllib.parse import urlsplit

ID = re.compile(r'^[A-Za-z0-9_-]{1,160}$')


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def paired_acl(claim, displays):
    if not isinstance(claim, dict) or not isinstance(displays, list) or any(not isinstance(item, dict) for item in displays):
        raise ValueError('Pairing receipt or display metadata is malformed.')
    pairing = claim.get('pairing', claim)
    if not isinstance(pairing, dict):
        raise ValueError('Pairing receipt is malformed.')
    for key in ('deviceId', 'memberId'):
        if not isinstance(pairing.get(key), str) or not ID.fullmatch(pairing[key]):
            raise ValueError('Pairing receipt has an invalid device or member identifier.')
    if pairing.get('revokedAt') is not None or pairing.get('allowView') is not True:
        raise ValueError('Pairing must currently permit viewing.')
    display = str(pairing.get('displayId', ''))
    if not display.isdecimal() or len(display) > 10:
        raise ValueError('Pairing display must be a macOS numeric display identifier.')
    display = int(display)
    if not any(type(item.get('id')) is int and item['id'] == display for item in displays):
        raise ValueError('The paired display is not attached. Select an observed display during pairing.')
    acl = [{'displayId': display, 'viewers': [pairing['memberId']],
            'controllers': [pairing['memberId']] if pairing.get('allowControl') is True else []}]
    binding = {key: pairing[key] for key in ('deviceId', 'memberId', 'displayId', 'allowView', 'allowControl') if key in pairing}
    return pairing, acl, binding


def write_configuration(device_id, acl, binding, destination, relay_url):
    if not isinstance(device_id, str) or not ID.fullmatch(device_id):
        raise ValueError('Invalid independent device identifier.')
    url = urlsplit(relay_url)
    if url.scheme != 'wss' or not url.hostname or url.path != '/device-gateway' or url.query or url.fragment or url.username or url.password:
        raise ValueError('Relay URL must be wss://MEDIA-HOST/device-gateway without credentials.')
    destination = Path(destination).absolute()
    if destination.exists():
        raise ValueError('Destination already exists; preserve existing credentials and receipts. Use a new private directory.')
    destination.mkdir(parents=True, mode=0o700)
    helper_key = secrets.token_urlsafe(36)
    gateway_key = secrets.token_urlsafe(36)
    helper = {'deviceId': device_id, 'bind': '127.0.0.1', 'port': 4213,
              'secret': helper_key, 'displays': acl}
    mapping = {device_id: {'url': 'http://127.0.0.1:4213', 'key': helper_key}}
    private_write(destination / 'helper.json', json.dumps(helper, indent=2) + '\n')
    private_write(destination / 'devices.json', json.dumps(mapping, indent=2) + '\n')
    gateway = {'DEVICE_GATEWAY_KEY': gateway_key,
        'DEVICE_GATEWAY_DEVICES_FILE': str(destination / 'devices.json'),
        'DEVICE_GATEWAY_DATABASE_PATH': str(destination / 'gateway.sqlite'),
        'DEVICE_GATEWAY_RELAY_URL': relay_url}
    private_write(destination / 'gateway.env', '\n'.join(k + '=' + shlex.quote(v) for k, v in gateway.items()) + '\n')
    private_write(destination / 'gateway.json', json.dumps(gateway, indent=2) + '\n')
    private_write(destination / 'media-gateway-secret.json', json.dumps({'DEVICE_GATEWAY_KEY': gateway_key}) + '\n')
    private_write(destination / 'pairing-binding.json', json.dumps(binding) + '\n')
    return destination


def prepare(claim, displays, destination, relay_url):
    pairing, acl, binding = paired_acl(claim, displays)
    return write_configuration(pairing['deviceId'], acl, binding, destination, relay_url)


def bootstrap(device_id, destination, relay_url):
    # A local installation identity is not a messaging pairing or a capture grant.
    return write_configuration(device_id, [], {'deviceId': device_id, 'paired': False}, destination, relay_url)


def private_read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Configuration and pairing receipt must be your regular mode-0600 files.')
    return json.loads(path.read_text())


def activate(claim, displays, destination):
    pairing, acl, binding = paired_acl(claim, displays)
    destination = Path(destination).absolute()
    folder = destination.lstat()
    if not stat.S_ISDIR(folder.st_mode) or folder.st_uid != os.getuid() or stat.S_IMODE(folder.st_mode) != 0o700:
        raise ValueError('Existing bootstrap directory must be yours with mode 0700.')
    helper_path = destination / 'helper.json'
    helper = private_read(helper_path)
    if helper.get('deviceId') != pairing['deviceId'] or helper.get('bind') != '127.0.0.1' or helper.get('port') != 4213 or not isinstance(helper.get('secret'), str) or len(helper['secret']) < 32:
        raise ValueError('Pairing differs from the independent bootstrap identity.')
    old_binding = private_read(destination / 'pairing-binding.json')
    if helper.get('displays') == acl and old_binding == binding:
        return destination
    bootstrap_binding = {'deviceId': pairing['deviceId'], 'paired': False}
    if helper.get('displays') not in ([], acl) or old_binding != bootstrap_binding:
        raise ValueError('Only a never-paired empty-ACL bootstrap may be activated; preserve existing grants/configuration.')
    original = {**helper, 'displays': []}
    backup = destination / 'helper.pre-pair.json'
    if backup.exists() or backup.is_symlink():
        if private_read(backup) != original:
            raise ValueError('Bootstrap backup differs; preserve interrupted setup for review.')
    elif helper.get('displays') == []:
        private_write(backup, json.dumps(original, indent=2) + '\n')
    else:
        raise ValueError('Interrupted activation has no original bootstrap evidence.')
    new_helper = destination / 'helper.claimed.json'
    new_binding = destination / 'pairing.claimed.json'
    for path, value in ((new_helper, {**helper, 'displays': acl}), (new_binding, binding)):
        if path.exists() or path.is_symlink():
            if private_read(path) != value:
                raise ValueError('Interrupted activation differs; preserve staged files for review.')
        else:
            private_write(path, json.dumps(value, indent=2) + '\n')
    os.replace(new_helper, helper_path)
    os.replace(new_binding, destination / 'pairing-binding.json')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--claim', type=Path, help='Private downloaded verified messaging-pairing receipt JSON')
    source.add_argument('--bootstrap-device', help='Prepare local identity with empty ACL before messaging pairing')
    parser.add_argument('--app', type=Path, default=Path(__file__).resolve().parents[1] / 'build/ClawdTime Companion.app')
    destination_args = parser.add_mutually_exclusive_group(required=True)
    destination_args.add_argument('--directory', type=Path, help='New owner-only ClawdTime configuration directory')
    destination_args.add_argument('--activate-existing', type=Path, help='Bind a verified claim to an existing never-paired bootstrap; preserves secrets and ledgers')
    parser.add_argument('--relay-url')
    args = parser.parse_args()
    os.umask(0o077)
    binary = args.app.resolve() / 'Contents/MacOS/ClawdTimeCompanion'
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('Install/build the exact ClawdTime Companion app first; its executable is unavailable. No configuration was written.')
    if args.bootstrap_device:
        if args.activate_existing or not args.relay_url:
            raise ValueError('Bootstrap requires a new directory and relay URL.')
        destination = bootstrap(args.bootstrap_device, args.directory, args.relay_url)
    else:
        observed = subprocess.run([str(binary), '--list-displays'], check=True, capture_output=True, text=True, timeout=10)
        displays = json.loads(observed.stdout)
        claim = private_read(args.claim)
        if args.activate_existing:
            destination = activate(claim, displays, args.activate_existing)
        else:
            if not args.relay_url:
                raise ValueError('New paired configuration requires its independent relay URL.')
            destination = prepare(claim, displays, args.directory, args.relay_url)
    subprocess.run([str(binary), '--config', str(destination / 'helper.json'), '--check-config'], check=True)
    print('Prepared private ClawdTime configuration; sharing remains off.')
    if args.bootstrap_device:
        print('Bootstrap has no display/viewer/controller grants. Messaging pairing and explicit claim activation are still required.')
    if args.activate_existing:
        print('Verified claim bound while preserving secrets and ledgers. Quit and relaunch only ClawdTime Companion to load its ACL; it starts locally stopped.')
    print('Launch companion: ' + shlex.join(['open', str(args.app.resolve()), '--args', '--config', str(destination / 'helper.json')]))
    print('Grant Screen Recording, optionally Accessibility, and Enable locally in the companion.')
    print('Provision the media service with media-gateway-secret.json through its protected operator configuration; never paste it in chat.')
    print('Gateway launch: ' + shlex.join([str(Path(__file__).resolve().parents[2] / 'media/.venv/bin/python'), str(Path(__file__).resolve().parents[2] / 'gateway/start.py'), '--config', str(destination / 'gateway.json')]))



if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print('Setup refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
