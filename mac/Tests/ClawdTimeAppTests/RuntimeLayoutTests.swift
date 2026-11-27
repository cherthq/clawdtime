import XCTest
@testable import ClawdTimeAppCore

final class RuntimeLayoutTests: XCTestCase {
  func testAWholeRuntimeLoadsAndVerifies() throws {
    let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("Contents/Resources/runtime"), engine: "exit 0\n")
    let layout = try RuntimeLayout.load(root)
    XCTAssertEqual(layout.manifest.version, "0.4.0")
    XCTAssertEqual(layout.launcher.lastPathComponent, "clawdtime")
    XCTAssertTrue(layout.launcher.path.contains("ClawdTime App Tests"), "a path with spaces")
    XCTAssertEqual(try layout.verify(), 5)
  }

  func testEachMissingPartIsNamed() throws {
    for part in ["bin/clawdtime", "node/bin/node", "app/package.json", "app/release.json", "manifest.json"] {
      let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
      try FileManager.default.removeItem(at: root.appendingPathComponent(part))
      XCTAssertThrowsError(try RuntimeLayout.load(root), part) { XCTAssertEqual($0 as? RuntimeProblem, .missing(part)) }
    }
    XCTAssertThrowsError(try RuntimeLayout.load(URL(fileURLWithPath: "/nonexistent/runtime"))) {
      XCTAssertEqual($0 as? RuntimeProblem, .missing("runtime folder"))
    }
  }

  func testALauncherThatCannotRunIsRefused() throws {
    let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: root.appendingPathComponent("bin/clawdtime").path)
    XCTAssertThrowsError(try RuntimeLayout.load(root)) { XCTAssertEqual($0 as? RuntimeProblem, .notExecutable("bin/clawdtime")) }
  }

  func testAManifestForAnotherMachineOrVersionIsRefused() throws {
    let intel = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n", arch: "x64")
    XCTAssertThrowsError(try RuntimeLayout.load(intel)) { XCTAssertEqual($0 as? RuntimeProblem, .badManifest("arch is x64")) }
    let prerelease = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n", version: "0.4.0-beta.1")
    XCTAssertThrowsError(try RuntimeLayout.load(prerelease)) { XCTAssertEqual($0 as? RuntimeProblem, .badManifest("version is 0.4.0-beta.1")) }
    XCTAssertTrue(RuntimeLayout.isReleaseVersion("12.0.3"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("1.2"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("1..2"))
  }

  func testAChangedFileFailsVerification() throws {
    let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
    try "{\"version\":\"9.9.9\"}".write(to: root.appendingPathComponent("app/release.json"), atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try RuntimeLayout.load(root).verify()) { XCTAssertEqual($0 as? RuntimeProblem, .hashMismatch("app/release.json")) }
  }

  func testASignedMachOFileIsCountedAsSignedNotHashed() throws {
    // Signing for the app embeds a signature, so a Mach-O file no longer matches
    // the manifest of the unsigned runtime. Its code signature stands in for the hash.
    let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
    let original = Data([0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01, 0x00, 0x00])
    try original.write(to: root.appendingPathComponent("app/native/ClawdTimeTaskCapture"))
    try FakeRuntime.writeManifest(root, extra: ["app/native/ClawdTimeTaskCapture": try XCTUnwrap(RuntimeLayout.sha256(of: root.appendingPathComponent("app/native/ClawdTimeTaskCapture")))])
    try (original + Data("signature".utf8)).write(to: root.appendingPathComponent("app/native/ClawdTimeTaskCapture"))
    let layout = try RuntimeLayout.load(root)
    XCTAssertEqual(try layout.verify(), 6)
    XCTAssertEqual(try layout.verification(), RuntimeLayout.Verification(hashed: 5, signed: 1))
    // A text file that changes still fails.
    try "changed".write(to: root.appendingPathComponent("app/package.json"), atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try layout.verify()) { XCTAssertEqual($0 as? RuntimeProblem, .hashMismatch("app/package.json")) }
  }

  func testAManifestPathOutsideTheRuntimeIsRefused() throws {
    let zero = String(repeating: "0", count: 64)
    for path in ["../outside", "/etc/hosts", "app/../../outside", "app//x", "./bin/clawdtime"] {
      let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
      try FakeRuntime.writeManifest(root, extra: [path: zero])
      XCTAssertThrowsError(try RuntimeLayout.load(root), path) { XCTAssertEqual($0 as? RuntimeProblem, .unsafePath(path)) }
    }
  }

  func testALinkThatLeavesTheRuntimeFailsVerification() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("runtime"), engine: "exit 0\n")
    try "outside".write(to: folder.appendingPathComponent("outside.txt"), atomically: true, encoding: .utf8)
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("app/link.txt"), withDestinationURL: folder.appendingPathComponent("outside.txt"))
    let hash = try XCTUnwrap(RuntimeLayout.sha256(of: folder.appendingPathComponent("outside.txt")))
    try FakeRuntime.writeManifest(root, extra: ["app/link.txt": hash])
    XCTAssertThrowsError(try RuntimeLayout.load(root).verify()) { XCTAssertEqual($0 as? RuntimeProblem, .unsafePath("app/link.txt")) }
  }

  func testAnUpperCaseHashIsRefused() throws {
    let root = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 0\n")
    try FakeRuntime.writeManifest(root, extra: ["bin/clawdtime": String(repeating: "A", count: 64)])
    XCTAssertThrowsError(try RuntimeLayout.load(root)) {
      XCTAssertEqual($0 as? RuntimeProblem, .badManifest("the hash of bin/clawdtime is not a lowercase SHA-256"))
    }
  }
}
