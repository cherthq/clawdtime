import Foundation
import XCTest

@testable import DeviceCore

final class ConfigurationTests: XCTestCase {
  var root: URL!
  var support: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    support = root.appendingPathComponent("Application Support")
    try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: root)
  }
  func write(_ url: URL, device: String = "bootstrap", displays: [DisplayPermission] = []) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.deletingLastPathComponent().path)
    let config = HelperConfig(deviceId: device, secret: String(repeating: "s", count: 32), displays: displays)
    try JSONEncoder().encode(config).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  func testNormalRelaunchLoadsOnlyKnownPrivateDefaultAndStaysStopped() throws {
    let expected = support.appendingPathComponent("ClawdTimeCompanion/setup/helper.json")
    XCTAssertEqual(try configurationURL(arguments: ["ClawdTimeCompanion"], applicationSupport: support), expected)
    try write(expected)
    let loaded = try loadConfiguration(arguments: ["ClawdTimeCompanion"], applicationSupport: support)
    XCTAssertEqual(loaded.deviceId, "bootstrap")
    XCTAssertTrue(loaded.displays.isEmpty)
    let policy = try DevicePolicy(config: loaded)
    XCTAssertFalse(policy.armed)
    XCTAssertNil(policy.lease)
  }
  func testExplicitPathOverridesDefaultAndNeverFallsBackAfterFailure() throws {
    let standard = try configurationURL(arguments: [], applicationSupport: support)
    let explicit = root.appendingPathComponent("explicit/helper.json")
    try write(standard, device: "standard")
    try write(explicit, device: "explicit")
    let loaded = try loadConfiguration(arguments: ["--config", explicit.path], applicationSupport: support)
    XCTAssertEqual(loaded.deviceId, "explicit")
    XCTAssertThrowsError(try loadConfiguration(arguments: ["--config", root.appendingPathComponent("missing.json").path], applicationSupport: support))
    XCTAssertThrowsError(try loadConfiguration(arguments: ["--config"], applicationSupport: support))
    XCTAssertThrowsError(try loadConfiguration(arguments: ["--config", "relative.json"], applicationSupport: support))
  }
  func testUnsafePermissionsAndFileSymlinkAreRejected() throws {
    let url = try configurationURL(arguments: [], applicationSupport: support)
    try write(url)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    XCTAssertThrowsError(try loadConfiguration(arguments: [], applicationSupport: support))
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.deletingLastPathComponent().path)
    XCTAssertThrowsError(try loadConfiguration(arguments: [], applicationSupport: support))
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.deletingLastPathComponent().path)
    let original = url.deletingLastPathComponent().appendingPathComponent("original.json")
    try FileManager.default.moveItem(at: url, to: original)
    try FileManager.default.createSymbolicLink(at: url, withDestinationURL: original)
    XCTAssertThrowsError(try loadConfiguration(arguments: [], applicationSupport: support))
  }
  func testLoadedPairingACLIsPreservedWithoutAutomaticallyArming() throws {
    let url = try configurationURL(arguments: [], applicationSupport: support)
    try write(url, displays: [DisplayPermission(displayId: 7, viewers: ["verified_member"], controllers: [])])
    let loaded = try loadConfiguration(arguments: [], applicationSupport: support)
    XCTAssertEqual(loaded.displays.count, 1)
    XCTAssertEqual(loaded.displays[0].viewers, ["verified_member"])
    XCTAssertTrue(loaded.displays[0].controllers.isEmpty)
    XCTAssertFalse(try DevicePolicy(config: loaded).armed)
  }
  func testLocalOnlyConflictingHelperIsIndependentOfArmedState() {
    XCTAssertTrue(LocalInputExclusion.conflictingHelper(bundleId: "com.clawdtime.companion", pid: 20, helperPID: 10))
    XCTAssertTrue(LocalInputExclusion.conflictingHelper(bundleId: "com.clawdtime.local-control", pid: 20, helperPID: 10))
    XCTAssertFalse(LocalInputExclusion.conflictingHelper(bundleId: "com.clawdtime.local-control", pid: 10, helperPID: 10))
    XCTAssertFalse(LocalInputExclusion.conflictingHelper(bundleId: "com.clawdtime.task-panel", pid: 20, helperPID: 10))
    XCTAssertTrue(LocalInputExclusion.isOwned(bundleId: "com.clawdtime.local-control", pid: 20, helperPID: 10))
  }
  func testLocalOnlyBundleUsesSeparateFailClosedSetup() throws {
    let legacy = try configurationURL(arguments: [], applicationSupport: support)
    try write(legacy, device: "legacy")
    let local = try configurationURL(arguments: [], applicationSupport: support, localOnly: true)
    XCTAssertEqual(local, support.appendingPathComponent("ClawdTimeLocalControl/setup/helper.json"))
    XCTAssertThrowsError(try loadConfiguration(arguments: [], applicationSupport: support, localOnly: true))
    try write(local, device: "local")
    let config = try loadConfiguration(arguments: [], applicationSupport: support, localOnly: true)
    XCTAssertEqual(config.deviceId, "local")
    XCTAssertFalse(try DevicePolicy(config: config).armed)
    try write(local, displays: [.init(displayId: 7, viewers: ["member"], controllers: [])])
    XCTAssertThrowsError(try loadConfiguration(arguments: [], applicationSupport: support, localOnly: true))
    var remote = config; remote.bind = "100.64.0.2"
    XCTAssertThrowsError(try validateLocalOnlyConfiguration(remote, localOnly: true))
    try validateLocalOnlyConfiguration(remote, localOnly: false)
  }

}
