import XCTest

@testable import DeviceCore

final class PolicyTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func config(controllers: [String] = ["owner"]) -> HelperConfig {
    HelperConfig(
      deviceId: "device", secret: String(repeating: "s", count: 32),
      displays: [
        DisplayPermission(displayId: 7, viewers: ["owner", "viewer"], controllers: controllers)
      ])
  }
  func lease(mode: String = "view", member: String = "owner", id: String = "lease") -> Lease {
    Lease(
      id: id, deviceId: "device", memberId: member, callId: "call", displayId: 7, mode: mode,
      expiresAt: now.addingTimeInterval(25))
  }
  func testBindRejectsPublicAndWildcardAddresses() throws {
    for host in [
      "0.0.0.0", "::", "localhost", "192.168.1.2", "100.63.0.1", "100.128.0.1", "100.064.1.1",
    ] {
      var c = config()
      c.bind = host
      XCTAssertThrowsError(try c.validate())
    }
    var c = config()
    c.bind = "100.64.1.2"
    XCTAssertNoThrow(try c.validate())
    XCTAssertTrue(authenticated("Bearer " + c.secret, secret: c.secret))
    XCTAssertFalse(authenticated("bearer " + c.secret, secret: c.secret))
  }
  func testLocalStopExpiryAndOneSelectedDisplay() throws {
    let p = try DevicePolicy(config: config())
    XCTAssertThrowsError(
      try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false))
    p.arm()
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false)
    XCTAssertThrowsError(
      try p.begin(lease(id: "different"), now: now, sessionAvailable: true, accessibility: false))
    p.stop(disarm: true)
    XCTAssertFalse(p.armed)
    XCTAssertNil(p.lease)
    p.arm()
    XCTAssertThrowsError(
      try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false))
    try p.begin(lease(id: "fresh"), now: now, sessionAvailable: true, accessibility: false)
    XCTAssertThrowsError(
      try p.requireLease("fresh", now: now.addingTimeInterval(26), sessionAvailable: true))
    XCTAssertNil(p.lease)
  }
  func testRenewCannotUpgradeControlOrChangeOwnerCallDisplayAndCannotReviveExpiredLease() throws {
    let p = try DevicePolicy(config: config())
    p.arm()
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    for field in ["member", "call", "display", "mode"] {
      var changed = lease()
      changed.expiresAt = now.addingTimeInterval(30)
      if field == "member" { changed.memberId = "viewer" }
      if field == "call" { changed.callId = "another" }
      if field == "display" { changed.displayId = 8 }
      if field == "mode" { changed.mode = "control" }
      XCTAssertThrowsError(
        try p.renew(changed, now: now, sessionAvailable: true, accessibility: true))
    }
    var renewed = lease()
    renewed.expiresAt = now.addingTimeInterval(30)
    try p.renew(renewed, now: now, sessionAvailable: true, accessibility: true)
    renewed.expiresAt = now.addingTimeInterval(55)
    XCTAssertThrowsError(
      try p.renew(
        renewed, now: now.addingTimeInterval(31), sessionAvailable: true, accessibility: true))
  }
  func testControlNeedsIndependentPermissionCurrentFrameAndFreshSession() throws {
    let p = try DevicePolicy(config: config(), preferences: ControlPreferences(deviceId: "device", policy: .agentToolsWithFallback))
    p.arm()
    XCTAssertThrowsError(
      try p.begin(
        lease(mode: "control", member: "viewer"), now: now, sessionAvailable: true,
        accessibility: true))
    XCTAssertThrowsError(
      try p.begin(lease(mode: "control"), now: now, sessionAvailable: true, accessibility: false))
    try p.begin(lease(mode: "control"), now: now, sessionAvailable: true, accessibility: true)
    let action = InputAction(id: "click", frameId: "frame", type: "click", x: 0.5, y: 0.5)
    XCTAssertThrowsError(
      try p.validateAction(
        action, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    try p.recordFrame(
      FrameStamp(
        id: "frame", leaseId: "lease", displayId: 7, capturedAt: now, width: 100, height: 100))
    XCTAssertNoThrow(
      try p.validateAction(
        action, leaseId: "lease", now: now.addingTimeInterval(1), sessionAvailable: true,
        accessibility: true))
    XCTAssertThrowsError(
      try p.validateAction(
        action, leaseId: "lease", now: now.addingTimeInterval(3), sessionAvailable: true,
        accessibility: true))
    XCTAssertThrowsError(
      try p.validateAction(
        action, leaseId: "lease", now: now, sessionAvailable: false, accessibility: true))
    XCTAssertNil(p.frame)
    XCTAssertNil(p.lease)
    XCTAssertFalse(p.armed)
  }
  func testViewLeaseDoesNotGrantControlAndBoundsAreEnforced() throws {
    let p = try DevicePolicy(config: config())
    p.arm()
    try p.begin(lease(), now: now, sessionAvailable: true, accessibility: true)
    let action = InputAction(id: "input", frameId: "frame", type: "type", text: "hello")
    try p.recordFrame(
      FrameStamp(
        id: "frame", leaseId: "lease", displayId: 7, capturedAt: now, width: 100, height: 100))
    XCTAssertThrowsError(
      try p.validateAction(
        action, leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
    XCTAssertThrowsError(
      try InputAction(id: "a", frameId: "f", type: "click", x: 1.1, y: 0).validate())
    XCTAssertThrowsError(
      try InputAction(id: "a", frameId: "f", type: "type", text: "command\n").validate())
    XCTAssertThrowsError(
      try InputAction(id: "a", frameId: "f", type: "scroll", x: 0, y: 0, deltaY: 501).validate())
    XCTAssertThrowsError(
      try InputAction(id: "a", frameId: "f", type: "shell", text: "bad").validate())
    var invalid = lease()
    invalid.expiresAt = now.addingTimeInterval(31)
    p.stop()
    XCTAssertThrowsError(
      try p.begin(invalid, now: now, sessionAvailable: true, accessibility: true))
  }
  func testLedgerSurvivesRestartWithoutReplayingAndRejectsChangedPayload() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("receipts.json")
    let action = InputAction(id: "input", frameId: "frame", type: "type", text: "private text")
    do {
      let ledger = try ReceiptStore(url: url)
      _ = try ledger.begin(action, lease: lease(mode: "control"), now: now)
      XCTAssertThrowsError(try ReceiptStore(url: url))
      let submitted = InputAction(id: "submitted", frameId: "frame", type: "click", x: 0.5, y: 0.5)
      _ = try ledger.begin(submitted, lease: lease(mode: "control"), now: now)
      _ = try ledger.finish(
        submitted.id, state: "submitted", evidence: "cg_event_posted_not_application_verified",
        now: now)
    }
    let restarted = try ReceiptStore(url: url)
    XCTAssertEqual(try restarted.get("submitted", leaseId: "lease").state, "submitted")
    XCTAssertEqual(try restarted.get("input", leaseId: "lease").state, "unknown")
    XCTAssertEqual(try restarted.existing(action, leaseId: "lease")?.state, "unknown")
    XCTAssertThrowsError(try restarted.begin(action, lease: lease(mode: "control"), now: now))
    XCTAssertThrowsError(
      try restarted.existing(
        InputAction(id: "input", frameId: "frame", type: "type", text: "different"),
        leaseId: "lease"))
    XCTAssertThrowsError(try restarted.get("input", leaseId: "foreign"))
    XCTAssertFalse(
      String(data: try Data(contentsOf: url), encoding: .utf8)!.contains("private text"))
    let permissions =
      try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber
    XCTAssertEqual(permissions.intValue, 0o600)
  }
  func testHTTPRejectsSmugglingDuplicatesPipelinesAndOversizedBodies() throws {
    func parse(_ value: String) throws -> HTTPRequest? { try HTTPRequest.parse(Data(value.utf8)) }
    XCTAssertNotNil(try parse("GET /v1/status HTTP/1.1\r\nAuthorization: Bearer abc\r\n\r\n"))
    for header in [
      "Content-Length: 0\r\ncontent-length: 1", "Transfer-Encoding: chunked", "Content-Length: -1",
      "Content-Length: 20000", "Authorization: one\r\nauthorization: two",
    ] {
      XCTAssertThrowsError(try parse("POST /v1/leases HTTP/1.1\r\n\(header)\r\n\r\n"))
    }
    XCTAssertThrowsError(try parse("GET /v1/status HTTP/1.1\r\n\r\nextra"))
    XCTAssertNil(try parse("POST /v1/leases HTTP/1.1\r\nContent-Length: 2\r\n\r\n{"))
  }
}
