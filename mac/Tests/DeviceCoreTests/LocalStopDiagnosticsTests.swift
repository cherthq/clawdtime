import XCTest
@testable import DeviceCore

final class LocalStopDiagnosticsTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func policy() throws -> DevicePolicy {
    try DevicePolicy(config: HelperConfig(deviceId: "device", secret: String(repeating: "x", count: 32),
      displays: [DisplayPermission(displayId: 7, viewers: ["person"], controllers: ["person"])]))
  }
  func testEveryFixedDisarmReasonReleasesOwnershipAndRecordsOnlyMetadata() throws {
    for reason in LocalStopReason.allCases {
      let p = try policy()
      XCTAssertNil(p.lastStopReason)
      XCTAssertNil(p.lastStopAt)
      p.arm()
      try p.claimLocal("local-owner")
      p.stop(disarm: true, reason: reason, now: now)
      XCTAssertFalse(p.armed)
      XCTAssertNil(p.localSessionOwner)
      XCTAssertEqual(p.lastStopReason, reason)
      XCTAssertEqual(p.lastStopAt, now)
      XCTAssertFalse(reason.rawValue.isEmpty)
      XCTAssertTrue(reason.rawValue.allSatisfy { $0.isLowercase || $0 == "_" })
    }
  }
  func testTimerFailureCannotOverwriteTheInitiatingNotification() throws {
    let p = try policy()
    p.arm()
    p.stop(disarm: true, reason: .screenParametersChanged, now: now)
    XCTAssertThrowsError(try p.check(now: now.addingTimeInterval(1), sessionAvailable: false,
      unavailableReason: .timerSessionUnavailable))
    XCTAssertEqual(p.lastStopReason, .screenParametersChanged)
    XCTAssertEqual(p.lastStopAt, now)
    p.arm()
    XCTAssertThrowsError(try p.check(now: now.addingTimeInterval(2), sessionAvailable: false,
      unavailableReason: .timerSessionUnavailable))
    XCTAssertEqual(p.lastStopReason, .timerSessionUnavailable)
    XCTAssertEqual(p.lastStopAt, now.addingTimeInterval(2))
  }
  func testLocalAvailabilityFailureKeepsSpecificConflictReason() throws {
    let p = try policy()
    let local = LocalExecutionPolicy(shared: p)
    p.arm()
    XCTAssertThrowsError(try local.check(now: now, available: false,
      unavailableReason: .timerHelperConflict))
    XCTAssertFalse(p.armed)
    XCTAssertEqual(p.lastStopReason, .timerHelperConflict)
    XCTAssertEqual(p.lastStopAt, now)
  }
  func testLeaseReleaseAndExpiryDoNotInventADisarm() throws {
    let p = try policy()
    let local = LocalExecutionPolicy(shared: p)
    p.arm()
    local.stop()
    XCTAssertTrue(p.armed)
    XCTAssertNil(p.lastStopReason)
    try p.begin(Lease(id: "lease", deviceId: "device", memberId: "person", callId: "call",
      displayId: 7, mode: "view", expiresAt: now.addingTimeInterval(1)), now: now,
      sessionAvailable: true, accessibility: true)
    XCTAssertThrowsError(try p.check(now: now.addingTimeInterval(2), sessionAvailable: true))
    XCTAssertTrue(p.armed)
    XCTAssertNil(p.lastStopReason)
    XCTAssertNil(p.lastStopAt)
  }
  func testPolicyUpdateRecordsItsCauseAndStillRequiresLocalEnable() throws {
    let p = try policy()
    p.arm()
    try p.updatePreferences(ControlPreferences(deviceId: "device", revision: 2, policy: .agentToolsWithFallback))
    XCTAssertFalse(p.armed)
    XCTAssertEqual(p.lastStopReason, .policyUpdated)
    XCTAssertNotNil(p.lastStopAt)
    XCTAssertThrowsError(try p.check(now: Date(), sessionAvailable: true))
  }
}
