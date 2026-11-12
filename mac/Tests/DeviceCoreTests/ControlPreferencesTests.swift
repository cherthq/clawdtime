import XCTest
@testable import DeviceCore

final class ControlPreferencesTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func config() -> HelperConfig {
    HelperConfig(deviceId: "device", secret: String(repeating: "x", count: 32),
      displays: [DisplayPermission(displayId: 7, viewers: ["person"], controllers: ["person"])])
  }
  func lease(epoch: Int = 0, executor: String = "none", mode: String = "view", revision: Int = 1) -> Lease {
    Lease(id: "lease", deviceId: "device", memberId: "person", callId: "call", displayId: 7,
      mode: mode, expiresAt: now.addingTimeInterval(25), protocolVersion: 2, sessionId: "session",
      executorEpoch: epoch, policyRevision: revision, executor: executor)
  }
  func testControlACLDoesNotEnableFallbackAndPreferenceDoesNotArm() throws {
    let policy = try DevicePolicy(config: config())
    XCTAssertEqual(policy.preferences.policy, .agentToolsOnly)
    XCTAssertFalse(policy.armed)
    policy.arm()
    XCTAssertThrowsError(try policy.begin(lease(epoch: 1, executor: "clawdtime", mode: "control"), now: now, sessionAvailable: true, accessibility: true))
    try policy.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    try policy.updatePreferences(ControlPreferences(deviceId: "device", revision: 2, policy: .agentToolsWithFallback))
    XCTAssertFalse(policy.armed)
    XCTAssertNil(policy.lease)
    XCTAssertThrowsError(try policy.updatePreferences(ControlPreferences(deviceId: "device", revision: 1)))
  }
  func testNativeAndFallbackHandoffKeepsLeaseButInvalidatesOldFrameAndOwner() throws {
    let policy = try DevicePolicy(config: config(), preferences: ControlPreferences(deviceId: "device", policy: .agentToolsWithFallback))
    policy.arm()
    try policy.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    try policy.renew(lease(epoch: 1, executor: "native"), now: now, sessionAvailable: true, accessibility: true)
    try policy.recordFrame(FrameStamp(id: "old", leaseId: "lease", displayId: 7, capturedAt: now, width: 100, height: 100))
    try policy.renew(lease(epoch: 2, executor: "clawdtime", mode: "control"), now: now, sessionAvailable: true, accessibility: true)
    XCTAssertNil(policy.frame)
    XCTAssertEqual(policy.lease?.id, "lease")
    XCTAssertThrowsError(try policy.renew(lease(epoch: 1, executor: "native"), now: now, sessionAvailable: true, accessibility: true))
    try policy.recordFrame(FrameStamp(id: "fresh", leaseId: "lease", displayId: 7, capturedAt: now, width: 100, height: 100))
    let stale = InputAction(id: "action", frameId: "fresh", type: "click", x: 0.5, y: 0.5, executorEpoch: 1, policyRevision: 1, sessionId: "session")
    XCTAssertThrowsError(try policy.validateAction(stale, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    var current = stale; current.executorEpoch = 2
    XCTAssertNoThrow(try policy.validateAction(current, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    XCTAssertThrowsError(try policy.renew(lease(epoch: 3, executor: "native", revision: 2), now: now, sessionAvailable: true, accessibility: true))
  }
  func testNativeExecutorNeedsLocalControllerACLWithoutRequiringFallbackAccessibility() throws {
    var viewOnly = config(); viewOnly.displays[0].controllers = []
    let viewer = try DevicePolicy(config: viewOnly); viewer.arm()
    try viewer.begin(lease(), now: now, sessionAvailable: true, accessibility: false)
    XCTAssertThrowsError(try viewer.renew(lease(epoch: 1, executor: "native"), now: now, sessionAvailable: true, accessibility: false))
    let controller = try DevicePolicy(config: config()); controller.arm()
    XCTAssertNoThrow(try controller.begin(lease(epoch: 1, executor: "native"), now: now, sessionAvailable: true, accessibility: false))
  }
  func testPrivatePreferencesRetainRevisionAndRejectForeignDeviceOrUnsafeFile() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("policy.json")
    let store = try ControlPreferenceStore(url: url, deviceId: "device")
    XCTAssertEqual(store.value.policy, .agentToolsOnly)
    try store.set(.agentToolsWithFallback)
    XCTAssertEqual(store.value.revision, 2)
    try store.set(.agentToolsWithFallback)
    XCTAssertEqual(store.value.revision, 2)
    XCTAssertEqual(try ControlPreferenceStore(url: url, deviceId: "device").value.policy, .agentToolsWithFallback)
    XCTAssertThrowsError(try ControlPreferenceStore(url: url, deviceId: "another"))
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    XCTAssertThrowsError(try ControlPreferenceStore(url: url, deviceId: "device"))
  }
  func testPanelPersonLabelIsOptionalBoundedAndTransient() throws {
    let panel = ControlPanelState()
    func status(_ label: String?) throws -> PanelTelemetry {
      let body: [String: Any] = ["sessionId":"session","callId":"call","memberId":"person","displayId":7,
        "expiresAt":now.addingTimeInterval(20).timeIntervalSinceReferenceDate,"agent":"codex",
        "callState":"speaking","executionState":"working","executor":"none","executorEpoch":0,
        "policyRevision":1,"personLabel":label as Any? ?? NSNull()]
      return try JSONDecoder().decode(PanelTelemetry.self, from: JSONSerialization.data(withJSONObject: body))
    }
    try panel.update(status(nil), lease: lease(), now: now)
    try panel.update(status("Paired fixture contact"), lease: lease(), now: now)
    XCTAssertEqual(panel.current(now: now)?.personLabel, "Paired fixture contact")
    XCTAssertEqual(panel.current(now: now)?.callState, "speaking")
    for invalid in ["", String(repeating: "x", count: 81), "fixture\ncontact", "fixture\u{0000}contact"] {
      XCTAssertThrowsError(try panel.update(status(invalid), lease: lease(), now: now))
    }
    XCTAssertNil(panel.current(now: now.addingTimeInterval(21)))
  }
  func testPanelControlsRequireExactFreshSessionAndAckIsSeparate() throws {
    let panel = ControlPanelState()
    func telemetry(session: String = "session", epoch: Int = 0, ack: String? = nil) throws -> PanelTelemetry {
      let body: [String: Any] = ["sessionId":session,"callId":"call","memberId":"person","displayId":7,
        "expiresAt":now.addingTimeInterval(20).timeIntervalSinceReferenceDate,"agent":"codex",
        "callState":"listening","executionState":"working","executor":"none","executorEpoch":epoch,
        "policyRevision":1,"acknowledgedCommandId":ack as Any? ?? NSNull()]
      return try JSONDecoder().decode(PanelTelemetry.self, from: JSONSerialization.data(withJSONObject: body))
    }
    XCTAssertThrowsError(try panel.request("end", now: now))
    XCTAssertThrowsError(try panel.update(telemetry(session: "foreign"), lease: lease(), now: now))
    try panel.update(telemetry(), lease: lease(), now: now)
    try panel.request("mute", now: now)
    let command = panel.command!
    XCTAssertEqual(command.type, "mute")
    XCTAssertThrowsError(try panel.request("end", now: now))
    try panel.update(telemetry(ack: "wrong"), lease: lease(), now: now)
    XCTAssertEqual(panel.command, command)
    try panel.update(telemetry(ack: command.id), lease: lease(), now: now)
    XCTAssertNil(panel.command)
    // Ending sharing does not end this exact call or its local controls.
    try panel.update(telemetry(epoch: 1), lease: nil, now: now)
    try panel.request("end", now: now)
    XCTAssertEqual(panel.command?.type, "end")
    XCTAssertThrowsError(try panel.update(telemetry(session: "foreign", epoch: 2), lease: nil, now: now))
    XCTAssertNil(panel.current(now: now.addingTimeInterval(21)))
    // A previous call's unacknowledged end request cannot block or affect a new call.
    var nextLease = lease(); nextLease.sessionId = "new-session"
    try panel.update(telemetry(session: "new-session"), lease: nextLease, now: now)
    XCTAssertNil(panel.command)
    XCTAssertEqual(panel.retiredCommands.count, 1)
    try panel.request("mute", now: now)
    XCTAssertEqual(panel.command?.sessionId, "new-session")
  }
}
