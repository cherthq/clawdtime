import importlib.util
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

configure = module('configure_readiness', ROOT / 'mac/scripts/configure.py')
doctor = module('doctor', ROOT / 'mac/scripts/doctor.py')
launch = module('launch', ROOT / 'mac/scripts/prepare_launchagent.py')
startup = module('gateway_start', ROOT / 'gateway/start.py')


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.directory = self.root / 'setup'
        configure.prepare({'pairing':{'deviceId':'device_fixture','memberId':'member_fixture','displayId':'1','allowView':True,'allowControl':True}}, [{'id':1}], self.directory, 'wss://independent.example/device-gateway')

    def tearDown(self):
        self.tmp.cleanup()

    def test_readiness_never_creates_a_lease_or_captures_and_reports_grants(self):
        paths = []
        config = doctor.private_config(self.directory / 'helper.json')
        def get(path):
            paths.append(path)
            return {'deviceId':'device_fixture','armed':False,'available':True,'screenPermission':False,'controlPermission':False} if path == '/v1/status' else config['displays'] if path == '/v1/permissions' else [{'id':1}]
        result = doctor.inspect(config, get)
        self.assertEqual(paths, ['/v1/status','/v1/displays','/v1/permissions'])
        self.assertFalse(result['readyForView']); self.assertFalse(result['readyForControl'])
        self.assertEqual(len(result['nextSteps']), 3)
        self.assertNotIn(config['secret'], json.dumps(result))

    def test_gateway_json_scoping_and_single_process_lock(self):
        config, folder = startup.load_config(self.directory / 'gateway.json')
        self.assertEqual(config['DEVICE_GATEWAY_DATABASE_PATH'], str(self.directory / 'gateway.sqlite'))
        first = startup.acquire_lock(folder)
        try:
            with self.assertRaises(ValueError): startup.acquire_lock(folder)
        finally: os.close(first)
        second = startup.acquire_lock(folder); os.close(second)
        self.assertFalse((folder / 'gateway.sqlite').exists())

    def test_launchagent_contains_paths_not_secrets_and_refuses_overwrite(self):
        target = self.root / 'LaunchAgents/com.clawdtime.gateway.plist'
        definition = launch.prepare(self.directory / 'gateway.json', Path(sys.executable), ROOT / 'gateway/start.py', target)
        self.assertEqual(definition['Label'], 'com.clawdtime.gateway')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        secret = json.loads((self.directory / 'gateway.json').read_text())['DEVICE_GATEWAY_KEY']
        self.assertNotIn(secret, target.read_text())
        with target.open('rb') as f: self.assertEqual(plistlib.load(f), definition)
        with self.assertRaises(ValueError): launch.prepare(self.directory / 'gateway.json', Path(sys.executable), ROOT / 'gateway/start.py', target)

    def test_missing_app_refuses_bootstrap_before_writing_any_configuration(self):
        destination = self.root / 'must-not-exist'
        result = subprocess.run([sys.executable, str(ROOT / 'mac/scripts/configure.py'),
            '--bootstrap-device', 'fixture', '--directory', str(destination),
            '--relay-url', 'wss://independent.example/device-gateway',
            '--app', str(self.root / 'Missing.app')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(destination.exists())
        self.assertIn('No configuration was written', result.stderr)

    def test_bootstrap_grants_nothing_and_verified_activation_preserves_credentials(self):
        empty = self.root / 'bootstrap'
        configure.bootstrap('fresh_device', empty, 'wss://independent.example/device-gateway')
        before = json.loads((empty / 'helper.json').read_text())
        gateway = (empty / 'gateway.json').read_bytes()
        self.assertEqual(before['displays'], [])
        claim = {'pairing': {'deviceId':'fresh_device','memberId':'verified_member','displayId':'1','allowView':True,'allowControl':True}}
        configure.activate(claim, [{'id':1}], empty)
        after = json.loads((empty / 'helper.json').read_text())
        self.assertEqual(after['secret'], before['secret'])
        self.assertEqual((empty / 'gateway.json').read_bytes(), gateway)
        self.assertEqual(after['displays'][0]['controllers'], ['verified_member'])
        self.assertEqual(json.loads((empty / 'helper.pre-pair.json').read_text()), before)
        with self.assertRaises(ValueError): configure.activate(claim, [{'id':1}], empty)

    def test_legacy_helper_target_or_symlink_ledger_is_refused(self):
        mapping = self.directory / 'devices.json'
        saved = mapping.read_text()
        value = json.loads(saved); value['device_fixture']['url'] = 'http://127.0.0.1:3213'
        mapping.write_text(json.dumps(value))
        with self.assertRaises(ValueError): startup.load_config(self.directory / 'gateway.json')
        mapping.write_text(saved)
        other = self.root / 'other.sqlite';other.write_text('preserved')
        (self.directory / 'gateway.sqlite').symlink_to(other)
        with self.assertRaises(ValueError): startup.load_config(self.directory / 'gateway.json')
        self.assertEqual(other.read_text(), 'preserved')


if __name__ == '__main__': unittest.main()
