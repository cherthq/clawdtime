#!/usr/bin/env python3
"""Write a ClawdTime-only LaunchAgent definition. Does not bootstrap or launch it."""
import argparse
import os
from pathlib import Path
import plistlib
import shlex
import stat

LABEL = 'com.clawdtime.gateway'


def prepare(config, python, script, output):
    config, python, script, output = (Path(p).absolute() for p in (config, python, script, output))
    if output.name != LABEL + '.plist' or output.exists() or output.is_symlink():
        raise ValueError('Use a new com.clawdtime.gateway.plist; existing LaunchAgents are preserved.')
    if not config.is_file() or stat.S_IMODE(config.stat().st_mode) != 0o600:
        raise ValueError('A private gateway.json configuration is required.')
    if not python.is_file() or not os.access(python, os.X_OK) or not script.is_file():
        raise ValueError('Gateway Python environment and startup script must already exist.')
    logs = config.parent / 'logs'
    logs.mkdir(mode=0o700, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    definition = {'Label': LABEL,
        'ProgramArguments': [str(python), str(script), '--config', str(config)],
        'WorkingDirectory': str(script.parent), 'RunAtLoad': True, 'KeepAlive': True,
        'ThrottleInterval': 10, 'ProcessType': 'Background',
        'StandardOutPath': str(logs / 'gateway.stdout.log'),
        'StandardErrorPath': str(logs / 'gateway.stderr.log'), 'Umask': 0o077}
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        plistlib.dump(definition, handle)
        handle.flush(); os.fsync(handle.fileno())
    return definition


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--python', type=Path, default=Path(__file__).resolve().parents[2] / 'media/.venv/bin/python')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    prepare(args.config, args.python, Path(__file__).resolve().parents[2] / 'gateway/start.py', args.output)
    print('Prepared only com.clawdtime.gateway. Nothing was loaded or started.')
    print('Lead launch command: ' + shlex.join(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(args.output.absolute())]))
    print('Read status: ' + shlex.join(['launchctl', 'print', f'gui/{os.getuid()}/{LABEL}']))
    print('Stop only this gateway: ' + shlex.join(['launchctl', 'bootout', f'gui/{os.getuid()}/{LABEL}']))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError):
        raise SystemExit('LaunchAgent preparation refused; check new ClawdTime output path and private configuration. Nothing was started.')
