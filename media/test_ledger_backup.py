import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ledger_backup import (BackupError, MAGIC, create_backup, encrypted_snapshot,
                           verify_backup, write_encrypted)
from server import Service

KEY = 'ab' * 32
IDENTITY = 'clawdtime-media-ledger-v1'


class LedgerBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.source = self.directory / 'media.sqlite'
        self.output = self.directory / 'backup.enc'
        self.service = Service({'MEDIA_DATABASE_PATH': str(self.source)})
        self.db = self.service.db
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)', ('session-private', 'fp', 'active'))
        self.db.execute('INSERT INTO speech VALUES(?,?,?,?,?,?)',
                        ('speech-private', 'session-private', 'fp', 'playing', 'now', None))
        self.db.execute('INSERT INTO device_actions VALUES(?,?,?,?,?,?)',
                        ('input-private', 'session-private', 'lease', 'fp', 'unknown', None))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        self.tmp.cleanup()

    def logical_state(self):
        return {table: self.db.execute(f'SELECT * FROM {table}').fetchall()
                for table in ('sessions', 'speech', 'device_actions')}

    def test_online_wal_round_trip_preserves_source_states_and_excludes_uncommitted_rows(self):
        original = self.logical_state()
        self.assertTrue(Path(str(self.source) + '-wal').exists())
        before = {p.name: p.read_bytes() for p in (self.source, Path(str(self.source) + '-wal'))}
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)', ('pending', 'fp', 'prepared'))
        result = create_backup(self.source, self.output, KEY, IDENTITY)
        verified = verify_backup(self.output, KEY, IDENTITY)
        self.assertEqual(result['tables'], {'sessions': 1, 'speech': 1, 'device_actions': 1})
        self.assertEqual(result['sha256'], verified['sha256'])
        encrypted = self.output.read_bytes()
        plaintext = AESGCM(bytes.fromhex(KEY)).decrypt(encrypted[8:20], encrypted[20:], MAGIC)
        offset = 4 + struct.unpack('>I', plaintext[:4])[0]
        restored = sqlite3.connect(':memory:')
        try:
            restored.deserialize(plaintext[offset:])
            self.assertEqual({table: restored.execute(f'SELECT * FROM {table}').fetchall()
                              for table in original}, original)
        finally:
            restored.close()
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(before, {p.name: p.read_bytes() for p in
                                 (self.source, Path(str(self.source) + '-wal'))})
        self.db.rollback()
        self.assertEqual(self.logical_state(), original)
        self.assertNotIn(b'session-private', self.output.read_bytes())
        self.assertEqual({p.name for p in self.directory.iterdir()},
                         {'media.sqlite', 'media.sqlite-wal', 'media.sqlite-shm', 'backup.enc'})

    def test_corruption_wrong_key_truncation_and_identity_fail_without_plaintext_output(self):
        create_backup(self.source, self.output, KEY, IDENTITY)
        data = self.output.read_bytes()
        with self.assertRaises(InvalidTag):
            verify_backup(self.output, 'cd' * 32, IDENTITY)
        with self.assertRaises(BackupError):
            verify_backup(self.output, KEY, 'wrong-ledger')
        for corrupt in (data[:-1], data[:20], b'WRONG001' + data[8:],
                        data[:30] + bytes([data[30] ^ 1]) + data[31:]):
            self.output.write_bytes(corrupt)
            with self.assertRaises((BackupError, InvalidTag)):
                verify_backup(self.output, KEY, IDENTITY)
        self.assertFalse(any('snapshot' in p.name or 'restor' in p.name
                             for p in self.directory.iterdir()))

    def test_existing_output_symlink_and_insecure_directory_are_refused(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(BackupError):
            create_backup(self.source, self.output, KEY, IDENTITY)
        with self.assertRaises(FileExistsError):
            write_encrypted(self.output, b'encrypted-only')
        self.assertEqual(self.output.read_bytes(), b'keep')
        self.output.unlink()
        self.output.symlink_to(self.source)
        with self.assertRaises(BackupError):
            create_backup(self.source, self.output, KEY, IDENTITY)
        with self.assertRaises(OSError):
            verify_backup(self.output, KEY, IDENTITY)
        self.output.unlink()
        self.directory.chmod(0o755)
        with self.assertRaises(BackupError):
            create_backup(self.source, self.output, KEY, IDENTITY)
        self.directory.chmod(0o700)
        self.assertFalse(any(p.name.startswith('.media-backup-') for p in self.directory.iterdir()))

    def test_size_deadline_invalid_key_and_missing_schema_fail_without_output(self):
        with patch('ledger_backup.MAX_DATABASE', 1024):
            with self.assertRaises(BackupError):
                create_backup(self.source, self.output, KEY, IDENTITY)
        with patch('ledger_backup.TIMEOUT', -1):
            with self.assertRaises(BackupError):
                create_backup(self.source, self.output, KEY, IDENTITY)
        with self.assertRaises(BackupError):
            create_backup(self.source, self.output, 'bad', IDENTITY)
        other = self.directory / 'unrelated.sqlite'
        with sqlite3.connect(other) as db:
            db.execute('CREATE TABLE unrelated(secret TEXT)')
        with self.assertRaises(BackupError):
            create_backup(other, self.output, KEY, IDENTITY)
        self.assertFalse(self.output.exists())

    def test_failed_encrypted_write_cleans_temp_and_cli_errors_do_not_echo_secret(self):
        with patch('ledger_backup.os.fsync', side_effect=OSError('private-error')):
            with self.assertRaises(OSError):
                create_backup(self.source, self.output, KEY, IDENTITY)
        self.assertFalse(self.output.exists())
        self.assertFalse(any(p.name.startswith('.media-backup-') for p in self.directory.iterdir()))
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('ledger_backup.py')),
                                 'verify', '--identity', IDENTITY, '--input', str(self.source)],
                                env={**os.environ, 'BACKUP_ENCRYPTION_KEY': KEY},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(KEY, result.stderr + result.stdout)
        self.assertNotIn('session-private', result.stderr + result.stdout)
        self.assertNotIn('Traceback', result.stderr)


class LedgerBackupEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name) / 'media.sqlite'
        self.service = Service({'MEDIA_DATABASE_PATH': str(self.source), 'MEDIA_API_KEY': 'm' * 32})
        self.client = TestClient(TestServer(self.service.app()))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer ' + 'm' * 32}

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_auth_disabled_fixed_identity_valid_export_and_rate_limit(self):
        response = await self.client.get('/internal/ledger-backup')
        self.assertEqual(response.status, 401)
        response = await self.client.get('/internal/ledger-backup', headers=self.headers)
        self.assertEqual(response.status, 404)
        self.service.env['BACKUP_ENCRYPTION_KEY'] = KEY
        response = await self.client.get('/internal/ledger-backup?identity=other', headers=self.headers)
        self.assertEqual(response.status, 400)
        response = await self.client.get('/internal/ledger-backup', headers=self.headers)
        self.assertEqual(response.status, 200)
        encrypted = await response.read()
        self.assertTrue(encrypted.startswith(MAGIC))
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['X-Content-SHA256'], hashlib.sha256(encrypted).hexdigest())
        output = Path(self.tmp.name) / 'download.enc'
        write_encrypted(output, encrypted)
        self.assertEqual(verify_backup(output, KEY, IDENTITY)['tables'],
                         {'sessions': 0, 'speech': 0, 'device_actions': 0})
        self.assertEqual((await self.client.get('/internal/ledger-backup', headers=self.headers)).status, 429)

    async def test_busy_snapshot_does_not_block_health_or_start_another_worker(self):
        self.service.env['BACKUP_ENCRYPTION_KEY'] = KEY
        entered, release = threading.Event(), threading.Event()
        def slow(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test worker timed out')
            return encrypted_snapshot(*args)
        with patch('server.encrypted_snapshot', side_effect=slow) as work:
            first = asyncio.create_task(self.client.get('/internal/ledger-backup', headers=self.headers))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set())
                self.assertEqual((await self.client.get('/health')).status, 200)
                self.assertEqual((await self.client.get('/internal/ledger-backup', headers=self.headers)).status, 429)
                self.assertEqual(work.call_count, 1)
            finally:
                release.set()
            self.assertEqual((await first).status, 200)

    async def test_cancelled_export_keeps_worker_reserved_until_actual_completion(self):
        self.service.env['BACKUP_ENCRYPTION_KEY'] = KEY
        entered, release = threading.Event(), threading.Event()
        def slow(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test worker timed out')
            return encrypted_snapshot(*args)
        with patch('server.encrypted_snapshot', side_effect=slow) as work:
            request = SimpleNamespace(query_string='')
            first = asyncio.create_task(self.service.ledger_backup(request))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set())
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                self.service.last_ledger_backup = float('-inf')
                with self.assertRaises(web.HTTPTooManyRequests):
                    await self.service.ledger_backup(request)
                self.assertEqual(work.call_count, 1)
                worker = self.service.ledger_backup_task
            finally:
                release.set()
            await worker
            await asyncio.sleep(0)
            self.assertIsNone(self.service.ledger_backup_task)

    async def test_invalid_key_fails_with_generic_response(self):
        self.service.env['BACKUP_ENCRYPTION_KEY'] = 'private-invalid-key'
        response = await self.client.get('/internal/ledger-backup', headers=self.headers)
        self.assertEqual(response.status, 503)
        self.assertNotIn('private-invalid-key', await response.text())
        self.assertIsNone(self.service.ledger_backup_task)


if __name__ == '__main__':
    unittest.main()
