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
    XCTAssertTrue(RuntimeLayout.isReleaseVersion("0.4.0"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("1.2"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("1..2"))
    // The same rule as the runtime builder and package-app.sh: no leading zero, at most four digits.
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("01.4.0"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("0.4.00"))
    XCTAssertFalse(RuntimeLayout.isReleaseVersion("10000.0.0"))
  }

  /// The contract between the runtime builder and the app: a manifest that
  /// scripts/release/manifest.mjs writes loads and verifies here.
  func testAManifestOfTheRuntimeBuilderLoadsAndVerifies() throws {
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
      ?? ProcessInfo.processInfo.environment["PATH"]?.split(separator: ":").map { "\($0)/node" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    let nodePath = try XCTUnwrap(node, "Node is needed to run the manifest writer of the runtime builder")
    let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scripts/release/manifest.mjs").standardizedFileURL
    let root = try temporaryFolder(self).appendingPathComponent("Application Support/runtime")
    let files = FileManager.default
    for folder in ["bin", "node/bin", "app/native/ClawdTimeCompanion_ClawdTimeTaskPanel.bundle/Fonts", "app/dist/cli", "app/node_modules/made-up"] {
      try files.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
    }
    for (path, text) in [
      ("bin/clawdtime", "#!/bin/sh\nexit 0\n"), ("node/bin/node", "#!/bin/sh\nexit 0\n"),
      ("app/package.json", "{\"version\":\"0.4.1\"}"), ("app/release.json", "{}"),
      ("app/dist/cli/main.js", "console.log(1)"), ("app/dist/read me.txt", "spaces"),
      ("app/native/ClawdTimeCompanion_ClawdTimeTaskPanel.bundle/Fonts/Made Up.ttf", "font"),
      ("app/node_modules/made-up/index.js", "module.exports = 1"),
    ] {
      try text.write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
    }
    for executable in ["bin/clawdtime", "node/bin/node"] {
      try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent(executable).path)
    }
    let writer = Process()
    writer.executableURL = URL(fileURLWithPath: nodePath)
    writer.arguments = [script.path, root.path, "0.4.1", String(repeating: "c", count: 40), "v24.22.3"]
    writer.standardOutput = FileHandle.nullDevice
    try writer.run()
    writer.waitUntilExit()
    XCTAssertEqual(writer.terminationStatus, 0)
    let layout = try RuntimeLayout.load(root)
    XCTAssertEqual(layout.manifest.version, "0.4.1")
    XCTAssertEqual(layout.manifest.node, "v24.22.3")
    XCTAssertEqual(try layout.verification(), RuntimeLayout.Verification(hashed: 8, signed: 0))
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
