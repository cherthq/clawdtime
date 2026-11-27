"""Checks package-app.sh, sign-and-notarize.sh and make-dmg.sh with a fake runtime.

The app binary is a tiny stub, so no Swift build runs. Nothing is installed,
opened or notarized: every file stays in a temporary folder.
"""

import os
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def run(*arguments, env=None):
    environment = dict(os.environ)
    environment.pop("CLAWDTIME_SIGN_IDENTITY", None)
    environment.pop("CLAWDTIME_NOTARY_PROFILE", None)
    environment.update(env or {})
    return subprocess.run([str(a) for a in arguments], capture_output=True, text=True, env=environment, timeout=300)


@unittest.skipUnless(shutil.which("cc") and shutil.which("codesign") and shutil.which("hdiutil"), "needs the Xcode command line tools")
class PackageAppTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="ClawdTime package "))
        self.addCleanup(shutil.rmtree, self.folder, True)
        made = run(SCRIPTS / "make-fake-runtime.sh", "--out", self.folder / "fake")
        self.assertEqual(made.returncode, 0, made.stderr)
        self.runtime = self.folder / "fake" / "runtime"
        stub = self.folder / "stub.c"
        stub.write_text("int main(void) { return 0; }\n")
        self.binary = self.folder / "ClawdTime"
        built = run("cc", "-arch", "arm64", "-o", self.binary, stub)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.out = self.folder / "out dir"

    def package(self):
        return run(SCRIPTS / "package-app.sh", "--runtime", self.runtime, "--out", self.out, "--binary", self.binary, "--no-self-test")

    def test_the_app_holds_the_runtime_and_its_info_and_is_signed(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        app = self.out / "ClawdTime.app"
        with open(app / "Contents" / "Info.plist", "rb") as handle:
            info = plistlib.load(handle)
        self.assertEqual(info["CFBundleIdentifier"], "com.clawdtime.app")
        self.assertEqual(info["CFBundleExecutable"], "ClawdTime")
        self.assertEqual(info["CFBundleShortVersionString"], "0.4.0")
        self.assertEqual(info["LSMinimumSystemVersion"], "14.0")
        self.assertEqual(info["LSArchitecturePriority"], ["arm64"])
        self.assertIn("NSMicrophoneUsageDescription", info)
        runtime = app / "Contents" / "Resources" / "runtime"
        for path in ["bin/clawdtime", "node/bin/node", "app/native/ClawdTimeTaskPanel", "app/native/ClawdTimeTaskCapture", "manifest.json", "app/dist/read me.txt"]:
            self.assertTrue((runtime / path).exists(), path)
        self.assertTrue(os.access(runtime / "bin" / "clawdtime", os.X_OK))
        link = runtime / "app" / "node_modules" / ".bin" / "example-cli"
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), "../example-cli/cli.js")
        self.assertEqual(run("codesign", "--verify", "--deep", "--strict", app).returncode, 0)
        self.assertRegex(run("codesign", "-dv", app).stderr, r"flags=0x[0-9a-f]+\([^)]*runtime", "the app runs with the hardened runtime")
        addon = runtime / "app" / "node_modules" / "example-addon" / "build" / "Release" / "example.node"
        self.assertEqual(run("codesign", "--verify", "--strict", addon).returncode, 0, "the native addon is signed too")

    def entitlements(self, path):
        shown = run("codesign", "-d", "--entitlements", "-", "--xml", path)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        start = shown.stdout.find("<?xml")
        return plistlib.loads(shown.stdout[start:].encode()) if start >= 0 else {}

    def test_every_mach_o_file_of_the_runtime_is_signed_and_node_may_compile(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        runtime = self.out / "ClawdTime.app" / "Contents" / "Resources" / "runtime"
        machos = [
            "node/bin/node",
            "app/native/ClawdTimeTaskPanel",
            "app/native/ClawdTimeTaskCapture",
            "app/node_modules/example-addon/build/Release/example.node",
            "app/node_modules/example-sdk/libexample.dylib",
        ]
        for path in machos:
            shown = run("codesign", "-dv", runtime / path)
            self.assertEqual(shown.returncode, 0, path)
            # Signed by the app's signing, not left with the linker's own signature.
            self.assertNotIn("linker-signed", shown.stderr, path)
            # The hardened runtime, also ad hoc, so no DYLD_INSERT_LIBRARIES library loads into it.
            self.assertRegex(shown.stderr, r"flags=0x[0-9a-f]+\([^)]*runtime", path)
            self.assertEqual(run("codesign", "--verify", "--strict", runtime / path).returncode, 0, path)
        node = self.entitlements(runtime / "node" / "bin" / "node")
        for key in ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory",
                    "com.apple.security.cs.disable-library-validation"]:
            self.assertIs(node.get(key), True, key)
        self.assertNotIn("com.apple.security.get-task-allow", node)
        self.assertIs(self.entitlements(runtime / "app" / "native" / "ClawdTimeTaskPanel").get("com.apple.security.device.audio-input"), True)
        # The panel finds its fonts next to it.
        self.assertTrue((runtime / "app" / "native" / "ClawdTimeCompanion_ClawdTimeTaskPanel.bundle" / "Fonts" / "MadeUp.ttf").is_file())

    def test_a_runtime_without_the_panel_fonts_is_refused(self):
        shutil.rmtree(self.runtime / "app" / "native" / "ClawdTimeCompanion_ClawdTimeTaskPanel.bundle")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("font bundle", result.stderr)

    def test_a_changed_runtime_file_is_refused(self):
        (self.runtime / "app" / "package.json").write_text('{"name":"changed"}\n')
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app/package.json differs from its hash", result.stderr)
        self.assertFalse((self.out / "ClawdTime.app").exists())

    def test_a_link_that_leaves_the_runtime_is_refused(self):
        os.symlink("/etc/hosts", self.runtime / "app" / "hosts")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("points outside the runtime", result.stderr)

    def test_a_runtime_without_its_engine_is_refused(self):
        (self.runtime / "bin" / "clawdtime").unlink()
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bin/clawdtime", result.stderr)

    def test_without_release_credentials_the_dmg_is_ad_hoc_and_named_unsigned(self):
        self.assertEqual(self.package().returncode, 0)
        result = run(SCRIPTS / "sign-and-notarize.sh", "--app", self.out / "ClawdTime.app", "--out", self.out,
                     env={"CLAWDTIME_SIGN_IDENTITY": "Developer ID Application: Stonepad (EXAMPLE123)"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Both CLAWDTIME_SIGN_IDENTITY and CLAWDTIME_NOTARY_PROFILE are needed", result.stderr)
        dmg = self.out / "ClawdTime-0.4.0-arm64-unsigned.dmg"
        self.assertTrue(dmg.exists())
        self.assertTrue((self.out / "ClawdTime-0.4.0-arm64-unsigned.dmg.sha256").read_text().endswith("ClawdTime-0.4.0-arm64-unsigned.dmg\n"))
        self.assertFalse((self.out / "ClawdTime-0.4.0-arm64.dmg").exists())
        self.assertEqual(run("hdiutil", "imageinfo", dmg).returncode, 0)

    def test_a_release_identity_missing_from_the_keychain_stops_before_signing(self):
        self.assertEqual(self.package().returncode, 0)
        result = run(SCRIPTS / "sign-and-notarize.sh", "--app", self.out / "ClawdTime.app", "--out", self.out,
                     env={"CLAWDTIME_SIGN_IDENTITY": "Developer ID Application: Stonepad (EXAMPLE123)", "CLAWDTIME_NOTARY_PROFILE": "stonepad-notary"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no valid signing identity", result.stderr)
        self.assertEqual(list(self.out.glob("*.dmg")), [])


if __name__ == "__main__":
    unittest.main()
