import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('configure', Path(__file__).with_name('configure.py'))
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class ConfigureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'new-config'
        self.claim = {'pairing': {'deviceId': 'device_a', 'memberId': 'member_a',
            'displayId': '123', 'allowView': True, 'allowControl': True}}
        self.displays = [{'id': 123, 'width': 1920, 'height': 1080}]
        self.url = 'wss://media.example/device-gateway'

    def tearDown(self):
        self.tmp.cleanup()

    def test_configuration_is_private_scoped_and_never_overwritten(self):
        configure.prepare(self.claim, self.displays, self.path, self.url)
        helper = json.loads((self.path / 'helper.json').read_text())
        self.assertEqual(helper['port'], 4213)
        self.assertEqual(helper['bind'], '127.0.0.1')
        self.assertEqual(helper['displays'][0]['controllers'], ['member_a'])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o700)
        for file in self.path.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        with self.assertRaises(ValueError):
            configure.prepare(self.claim, self.displays, self.path, self.url)
        self.assertEqual(json.loads((self.path / 'helper.json').read_text())['secret'], helper['secret'])

    def test_missing_display_revoked_pairing_and_public_relay_are_rejected(self):
        for displays, claim, url in [([], self.claim, self.url),
                (self.displays, {'pairing': {**self.claim['pairing'], 'revokedAt': 1}}, self.url),
                (self.displays, self.claim, 'ws://public.example/device-gateway'),
                (self.displays, self.claim, 'wss://secret@media.example/device-gateway')]:
            with self.assertRaises(ValueError):
                configure.prepare(claim, displays, self.path, url)
            self.assertFalse(self.path.exists())

    def test_viewing_does_not_grant_control_and_secrets_are_distinct(self):
        self.claim['pairing']['allowControl'] = False
        configure.prepare(self.claim, self.displays, self.path, self.url)
        helper = json.loads((self.path / 'helper.json').read_text())
        media = json.loads((self.path / 'media-gateway-secret.json').read_text())
        self.assertEqual(helper['displays'][0]['controllers'], [])
        self.assertNotEqual(helper['secret'], media['DEVICE_GATEWAY_KEY'])
        self.assertNotIn('token', (self.path / 'pairing-binding.json').read_text())


if __name__ == '__main__':
    unittest.main()
