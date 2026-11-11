import argparse
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
import configure
import onboard


class OnboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.directory = self.root / 'setup'
        self.claim = {'pairing': {'deviceId': 'fixture_device', 'memberId': 'fixture_member',
                                 'displayId': '1', 'allowView': True, 'allowControl': True}}
        self.claim_path = self.root / 'claim.json'
        configure.private_write(self.claim_path, json.dumps(self.claim))
        self.app = self.root / onboard.APP_NAME
        (self.app / 'Contents/MacOS').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': onboard.BUNDLE, 'CFBundleExecutable': 'ClawdTimeCompanion'}))
        self.binary = self.app / 'Contents/MacOS/ClawdTimeCompanion'
        self.binary.write_text('fixture; never executed')
        self.binary.chmod(0o700)
        self.args = argparse.Namespace(claim=self.claim_path, directory=self.directory,
            app=self.app, relay_url='wss://fixture.example/device-gateway', pilot_installed=True,
            check_only=False, manifest=None, trusted_team_id=None, gateway_python=Path(sys.executable))
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def command(self, argv, **kwargs):
        self.calls.append(argv)
        output = '[{"id":1}]' if '--list-displays' in argv else ''
        return subprocess.CompletedProcess(argv, 0, output, 'TeamIdentifier=ABCDE12345\n')

    def ready(self, config):
        return {'readyForView': True, 'readyForControl': True, 'viewACLLoaded': True,
            'controlACLLoaded': True, 'screenPermission': True, 'controlPermission': True,
            'selectedDisplaysAttached': True, 'available': True, 'armed': True, 'nextSteps': []}

    def test_bootstrap_then_repeated_setup_preserves_secrets_and_receipts(self):
        configure.bootstrap('fixture_device', self.directory, self.args.relay_url)
        gateway = (self.directory / 'gateway.json').read_bytes()
        secret = configure.private_read(self.directory / 'helper.json')['secret']
        ledger = self.directory / 'gateway.sqlite'
        ledger.write_bytes(b'unknown-input-receipt-fixture')
        first = onboard.onboard(self.args, self.command, self.ready)
        helper = (self.directory / 'helper.json').read_bytes()
        second = onboard.onboard(self.args, self.command, self.ready)
        self.assertEqual(first['status'], 'ready')
        self.assertTrue(first['configurationChanged'])
        self.assertFalse(second['configurationChanged'])
        self.assertEqual((self.directory / 'helper.json').read_bytes(), helper)
        self.assertEqual((self.directory / 'gateway.json').read_bytes(), gateway)
        self.assertEqual(ledger.read_bytes(), b'unknown-input-receipt-fixture')
        self.assertNotIn(secret, json.dumps(first))
        self.assertFalse(any(c[0] in ('open', 'launchctl', 'tccutil') for c in self.calls))

    def test_missing_permissions_and_stop_are_never_success(self):
        for field, code in [('screenPermission', 'screen_recording_required'),
                            ('controlPermission', 'accessibility_required'),
                            ('armed', 'local_enable_required')]:
            state = self.ready({})
            state[field] = False
            state['readyForControl'] = False
            if field != 'controlPermission': state['readyForView'] = False
            state['nextSteps'] = ['Human must complete ' + field]
            answer = onboard.readiness_result(state, True)
            self.assertEqual(answer['status'], 'blocked')
            self.assertEqual(answer['code'], code)
            self.assertEqual(answer['nextAction'], 'ask_user')
        state = self.ready({}); state['readyForControl'] = False; state['controlPermission'] = False
        self.assertEqual(onboard.readiness_result(state, False)['status'], 'ready')

    def test_changed_member_or_control_grant_refused_without_config_changes(self):
        configure.prepare(self.claim, [{'id':1}], self.directory, self.args.relay_url)
        before = (self.directory / 'helper.json').read_bytes()
        for key, value in [('memberId', 'other_member'), ('allowControl', False)]:
            changed = json.loads(json.dumps(self.claim)); changed['pairing'][key] = value
            with self.assertRaises(ValueError):
                onboard.ensure_pairing(changed, [{'id':1}], self.directory)
            self.assertEqual((self.directory / 'helper.json').read_bytes(), before)

    def test_check_only_does_not_activate_or_prepare_launchagent(self):
        configure.bootstrap('fixture_device', self.directory, self.args.relay_url)
        before = {p.name:p.read_bytes() for p in self.directory.iterdir()}
        self.args.check_only = True
        answer = onboard.onboard(self.args, self.command, self.ready)
        self.assertEqual(answer['code'], 'pairing_activation_required')
        self.assertEqual({p.name:p.read_bytes() for p in self.directory.iterdir()}, before)

    def test_activation_crash_between_helper_and_binding_is_resumable(self):
        configure.bootstrap('fixture_device', self.directory, self.args.relay_url)
        actual_replace = os.replace
        def fail_second(source, destination):
            if Path(source).name == 'pairing.claimed.json': raise OSError('simulated crash')
            return actual_replace(source, destination)
        with patch.object(configure.os, 'replace', side_effect=fail_second):
            with self.assertRaises(OSError): configure.activate(self.claim, [{'id':1}], self.directory)
        secret = configure.private_read(self.directory / 'helper.json')['secret']
        configure.activate(self.claim, [{'id':1}], self.directory)
        self.assertEqual(configure.private_read(self.directory / 'helper.json')['secret'], secret)
        self.assertEqual(configure.private_read(self.directory / 'pairing-binding.json')['memberId'], 'fixture_member')

    def test_unreachable_helper_stays_blocked_no_secret_error(self):
        def unavailable(config): raise OSError('sensitive exception details')
        answer = onboard.onboard(self.args, self.command, unavailable)
        self.assertEqual(answer['code'], 'companion_launch_required')
        self.assertEqual(answer['status'], 'blocked')
        self.assertNotIn('sensitive', json.dumps(answer))

    def test_loaded_broader_acl_requires_reload_not_ready(self):
        configure.prepare(self.claim, [{'id':1}], self.directory, self.args.relay_url)
        config = configure.private_read(self.directory / 'helper.json')
        responses = {
            '/v1/status': {'deviceId':'fixture_device', 'armed':True, 'available':True, 'screenPermission':True, 'controlPermission':True},
            '/v1/displays': [{'id':1}],
            '/v1/permissions': [{'displayId':1, 'viewers':['fixture_member','unrelated_member'], 'controllers':['fixture_member']}]}
        class Opener:
            def open(self, request, timeout):
                route = request.full_url.removeprefix('http://127.0.0.1:4213')
                return io.BytesIO(json.dumps(responses[route]).encode())
        with patch.object(onboard, 'build_opener', return_value=Opener()):
            readiness = onboard.read_readiness(config)
        self.assertFalse(readiness['readyForView'])
        self.assertEqual(onboard.readiness_result(readiness, True)['code'], 'companion_reload_required')

    def test_existing_app_is_never_replaced_even_with_release_manifest(self):
        with self.assertRaises(ValueError): onboard.install_release(self.root / 'missing.json', self.app, 'ABCDE12345', self.command)
        self.assertEqual(self.binary.read_text(), 'fixture; never executed')
        self.assertEqual(self.calls, [])

    def test_release_needs_separate_trust_matching_hash_and_safe_zip(self):
        artifact = self.root / 'release.zip'
        with zipfile.ZipFile(artifact, 'w') as archive: archive.writestr('../escape', 'bad')
        manifest = {'schema':'clawdtime.companion-release/1', 'bundleId':onboard.BUNDLE,
            'artifact':str(artifact), 'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(), 'teamId':'ABCDE12345'}
        path = self.root / 'release.json'; path.write_text(json.dumps(manifest))
        for trusted in (None, 'OTHER12345', 'ABCDE12345'):
            with self.assertRaises(ValueError): onboard.install_release(path, self.root / 'new.app', trusted, self.command)
        self.assertFalse((self.root / 'new.app').exists())
        self.assertEqual(self.calls, [])

    def test_signature_and_team_verification_happen_before_execution(self):
        self.args.pilot_installed = False
        self.args.trusted_team_id = 'WRONG12345'
        with self.assertRaises(ValueError): onboard.onboard(self.args, self.command, self.ready)
        self.assertFalse(any('--list-displays' in c for c in self.calls))
        self.assertFalse(self.directory.exists())

    def test_signed_release_install_checks_checksum_team_and_gatekeeper(self):
        artifact = self.root / 'release.zip'
        with zipfile.ZipFile(artifact, 'w') as archive:
            for source in self.app.rglob('*'):
                if source.is_file(): archive.write(source, str(Path(onboard.APP_NAME) / source.relative_to(self.app)))
        manifest = {'schema':'clawdtime.companion-release/1', 'bundleId':onboard.BUNDLE,
            'artifact':str(artifact), 'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(), 'teamId':'ABCDE12345'}
        path = self.root / 'release.json'; path.write_text(json.dumps(manifest))
        def commands(argv, **kwargs):
            if argv[0] == '/usr/bin/ditto':
                with zipfile.ZipFile(artifact) as archive: archive.extractall(argv[-1])
                (Path(argv[-1]) / onboard.APP_NAME / 'Contents/MacOS/ClawdTimeCompanion').chmod(0o700)
            return self.command(argv, **kwargs)
        target = self.root / 'installed' / onboard.APP_NAME
        onboard.install_release(path, target, 'ABCDE12345', commands)
        self.assertTrue((target / 'Contents/MacOS/ClawdTimeCompanion').exists())
        self.assertEqual(sum(c[0] == '/usr/sbin/spctl' for c in self.calls), 2)
        self.assertFalse(any('--list-displays' in c for c in self.calls))

    def test_symlink_setup_or_claim_refused(self):
        configure.bootstrap('fixture_device', self.directory, self.args.relay_url)
        link = self.root / 'linked'; link.symlink_to(self.directory)
        with self.assertRaises(ValueError): onboard.ensure_pairing(self.claim, [{'id':1}], link)
        link_claim = self.root / 'link.json'; link_claim.symlink_to(self.claim_path)
        self.args.claim = link_claim
        with self.assertRaises(ValueError): onboard.onboard(self.args, self.command, self.ready)


if __name__ == '__main__': unittest.main()
