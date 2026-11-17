import XCTest
@testable import DeviceCore

final class TextControlGrantTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func policy() throws -> DevicePolicy {
    let p = try DevicePolicy(config: HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32),
      displays: [DisplayPermission(displayId: 7, viewers: ["member"], controllers: ["member"])]),
      preferences: ControlPreferences(deviceId: "device", policy: .agentToolsWithFallback))
    p.arm()
    return p
  }
  func grant(_ p: DevicePolicy) throws -> TextControlGrant {
    let body: [String: Any] = ["id":"grant", "kind":"text_session", "sessionId":"session", "pairingId":"pairing",
      "memberId":"member", "deviceId":"device", "displayId":"7", "projectRoot":"/tmp/synthetic-project",
      "surface":"display:7", "actions":["type"], "expiresAt": now.addingTimeInterval(300).timeIntervalSince1970 * 1000,
      "policyRevision":p.preferences.revision, "localEnableGeneration":p.localEnableGeneration, "state":"active"]
    return try JSONDecoder().decode(TextControlGrant.self, from: JSONSerialization.data(withJSONObject: body))
  }
  func lease() -> Lease {
    Lease(id: "lease", deviceId: "device", memberId: "member", callId: nil, displayId: 7, mode: "control",
      expiresAt: now.addingTimeInterval(20), protocolVersion: 3, sessionId: "session", executorEpoch: 1,
      policyRevision: 1, executor: "clawdtime", authority: TextLeaseAuthority(grantId: "grant", projectId: "/tmp/synthetic-project"))
  }
  func activate(_ p: DevicePolicy) throws {
    try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true)
    try p.approveTextGrant(id: "grant", now: now, sessionAvailable: true)
  }
  func testRemoteProposalCannotGrantAndNoFakeCallAllowed() throws {
    let p = try policy()
    try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true)
    XCTAssertNil(p.textGrant)
    XCTAssertThrowsError(try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true))
    try p.approveTextGrant(id: "grant", now: now, sessionAvailable: true)
    var wrong = lease(); wrong.callId = "fake-call"
    XCTAssertThrowsError(try p.begin(wrong, now: now, sessionAvailable: true, accessibility: true))
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    XCTAssertNil(p.lease?.callId)
  }
  func testExactProjectSessionAndGrantBindingCannotChange() throws {
    let p = try policy(); try activate(p)
    for field in ["session", "project", "grant", "display", "member"] {
      var wrong = lease()
      switch field {
      case "session": wrong.sessionId = "other"
      case "project": wrong.authority?.projectId = "/tmp/other"
      case "grant": wrong.authority?.grantId = "other"
      case "display": wrong.displayId = 8
      default: wrong.memberId = "other"
      }
      XCTAssertThrowsError(try p.begin(wrong, now: now, sessionAvailable: true, accessibility: true))
    }
  }
  func testStopLockRestartAndExpiryDoNotRearmGrant() throws {
    for unavailable in [false, true] {
      let p = try policy(); try activate(p)
      if unavailable { XCTAssertThrowsError(try p.check(now: now, sessionAvailable: false)) }
      else { p.stop(disarm: true) }
      XCTAssertNil(p.textGrant); XCTAssertNil(p.pendingTextGrant)
      p.arm()
      XCTAssertThrowsError(try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true))
      XCTAssertThrowsError(try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true))
    }
    let p = try policy(); try activate(p)
    try p.check(now: now.addingTimeInterval(301), sessionAvailable: true)
    XCTAssertNil(p.textGrant)
    let restarted = try policy()
    XCTAssertThrowsError(try restarted.begin(lease(), now: now, sessionAvailable: true, accessibility: true))
  }
  func testActionScopeFreshnessAndEpochRemainMandatory() throws {
    let p = try policy(); try activate(p)
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    try p.recordFrame(FrameStamp(id: "frame", leaseId: "lease", displayId: 7, capturedAt: now, width: 100, height: 100))
    let action = InputAction(id: "action", frameId: "frame", type: "type", text: "Synthetic", executorEpoch: 1, policyRevision: 1, sessionId: "session")
    XCTAssertNoThrow(try p.validateAction(action, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    XCTAssertThrowsError(try p.validateAction(action, leaseId: "lease", now: now.addingTimeInterval(3), sessionAvailable: true, accessibility: true))
    var wrong = action; wrong.executorEpoch = 0
    XCTAssertThrowsError(try p.validateAction(wrong, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    let click = InputAction(id: "click", frameId: "frame", type: "click", x: 0.5, y: 0.5, executorEpoch: 1, policyRevision: 1, sessionId: "session")
    XCTAssertThrowsError(try p.validateAction(click, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
  }
  func testNoAppScopeClaimAndRejectedGrantCannotReturn() throws {
    let p = try policy(); var g = try grant(p); g.surface = "Calculator"
    XCTAssertThrowsError(try p.proposeTextGrant(g, now: now, sessionAvailable: true))
    try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true)
    p.rejectTextGrant()
    XCTAssertThrowsError(try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true))
  }
  func testRemoteRevocationNarrowsOnlyAndRetiresExactGrant() throws {
    let p = try policy(); try activate(p)
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    p.revokeTextGrant(id: "grant")
    XCTAssertNil(p.textGrant); XCTAssertNil(p.lease)
    XCTAssertThrowsError(try p.proposeTextGrant(grant(p), now: now, sessionAvailable: true))
    XCTAssertThrowsError(try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true))
  }

}
