#!/usr/bin/env python3
"""Start only ClawdTime's independently configured relay, holding one process lock."""
import argparse
import asyncio
import fcntl
import json
import os
import re
from pathlib import Path
import stat

KEYS = {'DEVICE_GATEWAY_KEY', 'DEVICE_GATEWAY_DEVICES_FILE', 'DEVICE_GATEWAY_DATABASE_PATH', 'DEVICE_GATEWAY_RELAY_URL'}


def load_config(path):
    path = Path(path).absolute()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Gateway configuration must be your regular mode-0600 file.')
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or stat.S_IMODE(directory.st_mode) != 0o700:
        raise ValueError('Gateway configuration directory must be owner-only mode 0700.')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != KEYS or any(not isinstance(v, str) for v in value.values()):
        raise ValueError('Gateway configuration fields are invalid.')
    if len(value['DEVICE_GATEWAY_KEY']) < 32:
        raise ValueError('Gateway-only credential is missing.')
    for key in ('DEVICE_GATEWAY_DEVICES_FILE', 'DEVICE_GATEWAY_DATABASE_PATH'):
        target = Path(value[key])
        if not target.is_absolute() or target.parent != path.parent:
            raise ValueError('Gateway device map and ledger must remain in this independent configuration directory.')
    mapping = Path(value['DEVICE_GATEWAY_DEVICES_FILE'])
    m = mapping.lstat()
    if not stat.S_ISREG(m.st_mode) or m.st_uid != os.getuid() or stat.S_IMODE(m.st_mode) != 0o600:
        raise ValueError('Gateway device map must be your mode-0600 regular file.')
    devices = json.loads(mapping.read_text())
    if not isinstance(devices, dict) or not devices or any(not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', key) or not isinstance(d, dict) or set(d) != {'url', 'key'} or d.get('url') != 'http://127.0.0.1:4213' or not isinstance(d.get('key'), str) or len(d['key']) < 32 for key, d in devices.items()):
        raise ValueError('This pilot startup targets only the independent loopback ClawdTime helper.')
    ledger = Path(value['DEVICE_GATEWAY_DATABASE_PATH'])
    if ledger.exists() or ledger.is_symlink():
        info = ledger.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Existing gateway ledger must be your mode-0600 regular file; never replace receipts.')
    return value, path.parent


def acquire_lock(directory):
    descriptor = os.open(directory / 'gateway-process.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(descriptor)
        raise ValueError('Another ClawdTime gateway owns this configuration; do not start a duplicate.')
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--check-config', action='store_true', help='Validate without opening the ledger or connecting')
    args = parser.parse_args()
    os.umask(0o077)
    config, directory = load_config(args.config)
    from urllib.parse import urlsplit
    target = urlsplit(config['DEVICE_GATEWAY_RELAY_URL'])
    if target.scheme != 'wss' or not target.hostname or target.path != '/device-gateway' or target.query or target.fragment or target.username or target.password:
        raise ValueError('Use the independent media wss://HOST/device-gateway endpoint.')
    if args.check_config:
        print('Independent ClawdTime gateway configuration is valid; no ledger, relay or helper request opened.')
        return
    descriptor = acquire_lock(directory)
    try:
        # Delay dependencies and SQLite construction until after the ownership lock.
        from service import Gateway
        from relay import relay
        asyncio.run(relay(Gateway(config), config['DEVICE_GATEWAY_RELAY_URL']))
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError):
        raise SystemExit('ClawdTime gateway startup refused. Check private configuration, file modes, independent target and process ownership; credentials were not printed.')
