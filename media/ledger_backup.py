"""Encrypted media-ledger snapshots and in-memory offline verification. No restore."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import struct
import sys
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b'CTMED001'
MAX_DATABASE = 64 * 1024 * 1024
MAX_METADATA = 4096
MAX_ENVELOPE = MAX_DATABASE + MAX_METADATA + 40
TIMEOUT = 15.0
TABLES = {
    'sessions': {'id', 'fingerprint', 'state'},
    'speech': {'id', 'session', 'fingerprint', 'state', 'updated_at', 'reason'},
    'device_actions': {'id', 'session', 'lease', 'fingerprint', 'state', 'receipt'},
}


class BackupError(Exception):
    """A deliberately non-sensitive operator error."""


def key_bytes(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        raise BackupError('BACKUP_ENCRYPTION_KEY must contain 64 hexadecimal characters.')
    return bytes.fromhex(value)


def identity_value(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/_.-]{0,159}', value):
        raise BackupError('Use a stable nonsecret ledger identity (1–160 characters).')
    return value


def memory_database(deadline):
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA temp_store=MEMORY')
    db.execute('PRAGMA trusted_schema=OFF')
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    return db


def inspect_database(db):
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise BackupError('Ledger integrity check failed.')
    # Reject views masquerading as receipt tables, and never initialize/migrate a ledger.
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not TABLES.keys() <= tables:
        raise BackupError('Expected media ledger tables are missing.')
    for table, required in TABLES.items():
        if not required <= {r[1] for r in db.execute(f'PRAGMA table_info({table})')}:
            raise BackupError('Media ledger schema is incompatible.')
    return {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in TABLES}


def snapshot(source, deadline):
    source = Path(source).absolute()
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise BackupError('Source must be an existing regular SQLite file, not a symlink.')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=0.1)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA temp_store=MEMORY')
        db.execute('PRAGMA trusted_schema=OFF')
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        if db.execute('PRAGMA page_count').fetchone()[0] * page_size > MAX_DATABASE:
            raise BackupError('Ledger exceeds the 64 MiB snapshot limit.')
        with closing(memory_database(deadline)) as copy:
            def progress(_status, _remaining, total):
                if time.monotonic() > deadline:
                    raise BackupError('Snapshot deadline exceeded; retry during a quiet interval.')
                if total * page_size > MAX_DATABASE:
                    raise BackupError('Ledger exceeds the 64 MiB snapshot limit.')
            # The online backup API includes committed WAL pages and takes a consistent
            # snapshot without checkpointing or changing receipt states in the source.
            db.backup(copy, pages=128, progress=progress, sleep=0.05)
            counts = inspect_database(copy)
            data = copy.serialize()
    if len(data) > MAX_DATABASE:
        raise BackupError('Ledger exceeds the 64 MiB snapshot limit.')
    # SQLite documents this normalization for an in-memory deserialized WAL image.
    # Only the completed snapshot changes; no source bytes or logical rows change.
    data = data[:18] + b'\x01\x01' + data[20:]
    return data, counts


def private_directory(path):
    path = Path(path).absolute()
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd)
        raise BackupError('Output directory must be owned by this user and mode 0700.')
    return fd


def write_encrypted(output, envelope):
    output = Path(output).absolute()
    directory = private_directory(output.parent)
    temporary = '.media-backup-' + secrets.token_hex(16)
    created = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        created = True
        with os.fdopen(fd, 'wb') as stream:
            stream.write(envelope)
            stream.flush()
            os.fsync(stream.fileno())
        # Hard-link publication is atomic and never replaces an existing destination.
        os.link(temporary, output.name, src_dir_fd=directory, dst_dir_fd=directory,
                follow_symlinks=False)
        os.fsync(directory)
    finally:
        try:
            if created:
                os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def encrypted_snapshot(source, key, identity):
    key = key_bytes(key)
    identity = identity_value(identity)
    data, counts = snapshot(source, time.monotonic() + TIMEOUT)
    metadata = json.dumps({
        'identity': identity,
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'sha256': hashlib.sha256(data).hexdigest(),
    }, sort_keys=True, separators=(',', ':')).encode()
    payload = struct.pack('>I', len(metadata)) + metadata + data
    nonce = os.urandom(12)
    envelope = MAGIC + nonce + AESGCM(key).encrypt(nonce, payload, MAGIC)
    return envelope, counts


def create_backup(source, output, key, identity):
    # Check the destination before taking a potentially expensive snapshot.
    directory = private_directory(Path(output).absolute().parent)
    try:
        if os.path.lexists(output):
            raise BackupError('Output already exists; choose a new backup filename.')
    finally:
        os.close(directory)
    envelope, counts = encrypted_snapshot(source, key, identity)
    write_encrypted(output, envelope)
    return {'ok': True, 'operation': 'backup', 'tables': counts,
            'bytes': len(envelope), 'sha256': hashlib.sha256(envelope).hexdigest()}


def verify_backup(input_path, key, identity):
    key = key_bytes(key)
    identity = identity_value(identity)
    fd = os.open(input_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 40 < info.st_size <= MAX_ENVELOPE:
            raise BackupError('Invalid encrypted media backup size or file type.')
        envelope = stream.read(MAX_ENVELOPE + 1)
    if len(envelope) > MAX_ENVELOPE or envelope[:8] != MAGIC:
        raise BackupError('Invalid encrypted media backup format.')
    payload = AESGCM(key).decrypt(envelope[8:20], envelope[20:], MAGIC)
    if len(payload) < 4:
        raise BackupError('Invalid encrypted media backup payload.')
    metadata_size = struct.unpack('>I', payload[:4])[0]
    if not 0 < metadata_size <= MAX_METADATA or metadata_size + 104 > len(payload):
        raise BackupError('Invalid encrypted media backup metadata.')
    metadata = json.loads(payload[4:4 + metadata_size])
    data = payload[4 + metadata_size:]
    if (not isinstance(metadata, dict) or metadata.get('identity') != identity or
            len(data) > MAX_DATABASE or data[:16] != b'SQLite format 3\x00' or
            metadata.get('sha256') != hashlib.sha256(data).hexdigest()):
        raise BackupError('Media backup identity or content does not match.')
    with closing(memory_database(time.monotonic() + TIMEOUT)) as db:
        db.deserialize(data)
        db.execute('PRAGMA query_only=ON')
        counts = inspect_database(db)
    return {'ok': True, 'operation': 'verify', 'tables': counts,
            'bytes': len(envelope), 'sha256': hashlib.sha256(envelope).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('backup', 'verify'))
    parser.add_argument('--identity', required=True, help='Expected nonsecret ledger identity')
    parser.add_argument('--source', help='Existing media SQLite database (backup only)')
    parser.add_argument('--output', help='New encrypted filename in an existing 0700 directory')
    parser.add_argument('--input', help='Encrypted backup (verify only)')
    args = parser.parse_args()
    try:
        # Prevent this administrative process from writing a plaintext core dump.
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        key = os.environ.get('BACKUP_ENCRYPTION_KEY')
        if args.operation == 'backup':
            if not args.source or not args.output or args.input:
                raise BackupError('Backup requires --source and --output only.')
            result = create_backup(args.source, args.output, key, args.identity)
        else:
            if not args.input or args.source or args.output:
                raise BackupError('Verify requires --input only; it never restores a database.')
            result = verify_backup(args.input, key, args.identity)
        print(json.dumps(result, sort_keys=True))
        return 0
    except BackupError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Library/OS errors may include paths or content; never echo them or a traceback.
        print('Media ledger operation failed; check key, input integrity, limits and permissions.',
              file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
