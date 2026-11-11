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


def prepare(claim, displays, destination, relay_url):
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
    url = urlsplit(relay_url)
    if url.scheme != 'wss' or not url.hostname or url.path != '/device-gateway' or url.query or url.fragment or url.username or url.password:
        raise ValueError('Relay URL must be wss://MEDIA-HOST/device-gateway without credentials.')
    destination = Path(destination).absolute()
    if destination.exists():
        raise ValueError('Destination already exists; preserve existing credentials and receipts. Use a new private directory.')
    destination.mkdir(parents=True, mode=0o700)
    helper_key = secrets.token_urlsafe(36)
    gateway_key = secrets.token_urlsafe(36)
    helper = {'deviceId': pairing['deviceId'], 'bind': '127.0.0.1', 'port': 4213,
              'secret': helper_key, 'displays': [{'displayId': display,
              'viewers': [pairing['memberId']],
              'controllers': [pairing['memberId']] if pairing.get('allowControl') is True else []}]}
    mapping = {pairing['deviceId']: {'url': 'http://127.0.0.1:4213', 'key': helper_key}}
    private_write(destination / 'helper.json', json.dumps(helper, indent=2) + '\n')
    private_write(destination / 'devices.json', json.dumps(mapping, indent=2) + '\n')
    private_write(destination / 'gateway.env', '\n'.join([
        'DEVICE_GATEWAY_KEY=' + shlex.quote(gateway_key),
        'DEVICE_GATEWAY_DEVICES_FILE=' + shlex.quote(str(destination / 'devices.json')),
        'DEVICE_GATEWAY_DATABASE_PATH=' + shlex.quote(str(destination / 'gateway.sqlite')),
        'DEVICE_GATEWAY_RELAY_URL=' + shlex.quote(relay_url), '']))
    # A separate operator provisioning file is deliberately not printed to stdout.
    private_write(destination / 'media-gateway-secret.json', json.dumps({'DEVICE_GATEWAY_KEY': gateway_key}) + '\n')
    private_write(destination / 'pairing-binding.json', json.dumps({key: pairing[key] for key in ('deviceId', 'memberId', 'displayId', 'allowView', 'allowControl') if key in pairing}) + '\n')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claim', type=Path, required=True, help='Private downloaded pairing receipt JSON')
    parser.add_argument('--app', type=Path, default=Path(__file__).resolve().parents[1] / 'build/ClawdTime Companion.app')
    parser.add_argument('--directory', type=Path, required=True, help='New owner-only ClawdTime configuration directory')
    parser.add_argument('--relay-url', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    info = args.claim.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Pairing receipt must be your regular file with mode 0600. Run chmod 600 on the downloaded file.')
    binary = args.app.resolve() / 'Contents/MacOS/ClawdTimeCompanion'
    observed = subprocess.run([str(binary), '--list-displays'], check=True, capture_output=True, text=True, timeout=10)
    displays = json.loads(observed.stdout)
    destination = prepare(json.loads(args.claim.read_text()), displays, args.directory, args.relay_url)
    subprocess.run([str(binary), '--config', str(destination / 'helper.json'), '--check-config'], check=True)
    print('Prepared private ClawdTime configuration; sharing remains off.')
    print('Launch companion: ' + shlex.join(['open', str(args.app.resolve()), '--args', '--config', str(destination / 'helper.json')]))
    print('Grant Screen Recording, optionally Accessibility, and Enable locally in the companion.')
    print('Provision the media service with media-gateway-secret.json through its protected operator configuration; never paste it in chat.')
    print('Gateway launch: set -a; source ' + shlex.quote(str(destination / 'gateway.env')) + '; set +a; ' +
          shlex.join([str(Path(__file__).resolve().parents[2] / 'media/.venv/bin/python'), str(Path(__file__).resolve().parents[2] / 'gateway/relay.py')]))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print('Setup refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
