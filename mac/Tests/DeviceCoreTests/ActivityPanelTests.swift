import XCTest
import AppKit
@testable import DeviceCore

final class ActivityPanelTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func lease() -> Lease {
    Lease(id: "lease", deviceId: "device", memberId: "member", callId: "call", displayId: 7,
      mode: "view", expiresAt: now.addingTimeInterval(25), protocolVersion: 2, sessionId: "session",
      executorEpoch: 0, policyRevision: 1, executor: "none")
  }
  func telemetry(sequence: Int = 1, summary: String = "Checking café 確認 ✅", work: String = "executing",
    verification: String? = nil, overrides: [String: Any] = [:]) throws -> PanelTelemetry {
    var activity: [String: Any] = ["version":1,"sequence":sequence,"delivery":"acknowledged","work":work,
      "currentSummary":summary,
      "entries":[["activityId":"activity_1","sequence":sequence,"kind":"status","summary":summary]],
      "expiresAt":now.addingTimeInterval(verification == nil ? 600 : 60).timeIntervalSinceReferenceDate]
    if let verification {
      activity["outcome"] = ["outcomeId":"outcome_1","status":work,"verification":verification,"summary":summary]
    }
    var body: [String: Any] = ["sessionId":"session","callId":"call","memberId":"member","displayId":7,
      "expiresAt":now.addingTimeInterval(5).timeIntervalSinceReferenceDate,"agent":"codex",
      "projectLabel":"Synthetic café project · Chat 12ab34","callState":"connected","executionState":"working",
      "executor":"none","executorEpoch":0,"policyRevision":1,"presentationVersion":1,"activity":activity]
    body.merge(overrides) { _, new in new }
    return try JSONDecoder().decode(PanelTelemetry.self, from: JSONSerialization.data(withJSONObject: body))
  }
  func testExpiryStopAndWrongBindingEraseTextWithoutRearmingOrLosingCommand() throws {
    let panel = ControlPanelState()
    try panel.update(telemetry(), lease: lease(), now: now)
    try panel.request("mute", now: now)
    let command = panel.command
    XCTAssertNotNil(panel.current(now: now)?.activity)
    XCTAssertNil(panel.current(now: now.addingTimeInterval(6)))
    XCTAssertNil(panel.telemetry?.activity)
    try panel.update(telemetry(overrides:["expiresAt":now.addingTimeInterval(12).timeIntervalSinceReferenceDate]), lease: lease(), now: now.addingTimeInterval(7))
    XCTAssertNil(panel.current(now: now.addingTimeInterval(7))?.activity, "Replay cannot repopulate expired text")
    XCTAssertEqual(panel.command, command)
    try panel.update(telemetry(sequence:2), lease: lease(), now: now)
    panel.clearActivity(stop: true)
    try panel.update(telemetry(sequence:3), lease: nil, now: now)
    XCTAssertNil(panel.current(now: now)?.activity)
    XCTAssertEqual(panel.command, command)
    XCTAssertThrowsError(try panel.update(telemetry(overrides:["sessionId":"foreign"]), lease: lease(), now: now))
    XCTAssertNil(panel.telemetry?.activity)
    XCTAssertThrowsError(try panel.update(telemetry(overrides:["expiresAt":now.addingTimeInterval(20).timeIntervalSinceReferenceDate]),lease:lease(),now:now))
  }
  func testOptionalVersionsMalformedFieldsAndBoundsCannotBlockAcknowledgement() throws {
    for invalid: Any in ["bad", ["version":99], ["version":1,"entries":Array(repeating: "bad", count:21)]] {
      let panel = ControlPanelState()
      try panel.update(telemetry(), lease: lease(), now: now)
      try panel.request("end", now: now)
      try panel.update(telemetry(overrides:["activity":invalid,"acknowledgedCommandId":panel.command!.id]), lease: lease(), now: now)
      XCTAssertNil(panel.command)
      XCTAssertNil(panel.current(now: now)?.activity)
    }
    for invalid in [String(repeating: "😀", count:161), "line\nbreak", ""] {
      let panel = ControlPanelState()
      try panel.update(telemetry(summary:invalid), lease: lease(), now: now)
      XCTAssertNil(panel.current(now: now)?.activity)
    }
    let panel = ControlPanelState()
    try panel.update(telemetry(overrides:["presentationVersion":2]), lease: lease(), now: now)
    XCTAssertNil(panel.current(now: now)?.activity)
  }
  func testOutOfOrderAndSameSequenceCannotReplaceTextOrRenewOutcomeExpiry() throws {
    let panel = ControlPanelState()
    try panel.update(telemetry(sequence:3, work:"completed", verification:"agent_observed"), lease: lease(), now: now)
    try panel.update(telemetry(sequence:3, summary:"Changed", work:"completed", verification:"agent_observed"), lease: lease(), now: now)
    XCTAssertNotEqual(panel.current(now:now)?.activity?.entries.first?.summary, "Changed")
    try panel.update(telemetry(sequence:2), lease: lease(), now: now)
    XCTAssertEqual(panel.current(now:now)?.activity?.sequence, 3)
    try panel.update(telemetry(sequence:4, work:"completed", verification:"not_verified", overrides:["expiresAt":now.addingTimeInterval(64).timeIntervalSinceReferenceDate]), lease: lease(), now:now.addingTimeInterval(59))
    XCTAssertNotNil(panel.current(now:now.addingTimeInterval(59))?.activity)
    XCTAssertNil(panel.current(now:now.addingTimeInterval(61))?.activity)
  }
  func testHonestLabelsAndNoControlsForStaleStatus() throws {
    let stale = PanelPresentation(telemetry:nil, pending:nil, sharing:"Stopped locally")
    XCTAssertFalse(stale.controlsEnabled)
    XCTAssertTrue(stale.status.contains("unavailable"))
    for (verification, label) in [("agent_observed","Agent reports completed"),("not_verified","Outcome unverified"),("unknown","Outcome unresolved")] {
      let model = PanelPresentation(telemetry:try telemetry(work:"completed", verification:verification), pending:nil, sharing:"Viewing")
      XCTAssertTrue(model.status.contains(label))
      XCTAssertTrue(model.status.contains("Received by agent"))
    }
    let panel = ControlPanelState(); try panel.update(telemetry(work:"pending_approval"), lease:lease(), now:now)
    try panel.request("pause", now:now)
    let model = PanelPresentation(telemetry:panel.current(now:now), pending:panel.command, sharing:"Viewing")
    XCTAssertTrue(model.status.contains("native approval"))
    XCTAssertTrue(model.status.contains("pending acknowledgement"))
    XCTAssertFalse(model.controlsEnabled)
  }
  func testReadinessAllowlistAndTimestampCannotSmugglePresentationText() throws {
    let panel = ControlPanelState()
    let ready: [String: Any] = ["reason":"gateway_unavailable","checkedAt":now.timeIntervalSinceReferenceDate,"nextAction":"SECRET path /private/not-allowed"]
    try panel.update(telemetry(overrides:["readiness":ready]), lease:lease(), now:now)
    let model = PanelPresentation(telemetry:panel.current(now:now), pending:nil, sharing:"Viewing")
    XCTAssertTrue(model.detail.contains("Check the paired gateway connection"))
    XCTAssertTrue(model.detail.contains("Checked:"))
    XCTAssertFalse(model.detail.contains("SECRET"))
    try panel.update(telemetry(overrides:["readiness":["reason":"unknown-secret","checkedAt":now.timeIntervalSinceReferenceDate]]), lease:lease(), now:now)
    XCTAssertNil(panel.current(now:now)?.readiness)
  }
  func testCurrentSummaryNeverFallsBackToHistoricalOutcome() throws {
    let projection: [String:Any] = ["version":1,"sequence":5,"delivery":"acknowledged","work":"executing",
      "currentSummary":"Working on the new turn 👩‍💻", "entries":[["activityId":"old","sequence":2,"kind":"outcome","summary":"Old task completed"]]]
    let panel = ControlPanelState()
    try panel.update(telemetry(overrides:["activity":projection]), lease:lease(), now:now)
    let current = PanelPresentation(telemetry:panel.current(now:now), pending:nil, sharing:"Viewing")
    XCTAssertEqual(current.currentSummary,"Working on the new turn 👩‍💻")
    XCTAssertTrue(current.detail.contains("Old task completed"))
    var noCurrent = projection; noCurrent.removeValue(forKey:"currentSummary"); noCurrent["sequence"] = 6
    try panel.update(telemetry(overrides:["activity":noCurrent]), lease:lease(), now:now)
    XCTAssertEqual(PanelPresentation(telemetry:panel.current(now:now), pending:nil, sharing:"Viewing").currentSummary, "")
  }
  func testSharedTypeScriptPythonSwiftPresentationFixtures() throws {
    struct Fixtures: Decodable { let version: Int; let valid: [PanelActivity]; let invalid: [PanelActivity] }
    let fixtureURL = URL(fileURLWithPath:#filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/presentation-v1.json").standardizedFileURL
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    let fixtures = try decoder.decode(Fixtures.self, from:Data(contentsOf:fixtureURL))
    XCTAssertEqual(fixtures.version,1)
    XCTAssertEqual(fixtures.valid.count,3)
    XCTAssertEqual(fixtures.invalid.count,4)
    for fixture in fixtures.valid { XCTAssertTrue(fixture.valid, "Valid shared fixture rejected") }
    for fixture in fixtures.invalid { XCTAssertFalse(fixture.valid, "Invalid shared fixture accepted") }
    XCTAssertTrue(fixtures.valid[0].currentSummary?.contains("👨‍👩‍👧‍👦") == true)
  }
  func testFocusedOutcomeListeningAndStaleConnectionPrecedence() throws {
    var projection: [String: Any] = ["version":1,"sequence":5,"delivery":"acknowledged","work":"completed","entries":[],
      "outcome":["outcomeId":"current-result","status":"completed","verification":"agent_observed","summary":"Current result observed"]]
    var t = try telemetry(overrides:["activity":projection,"callState":"listening"])
    var model = PanelPresentation(telemetry:t,pending:nil,sharing:"Viewing")
    XCTAssertEqual(model.currentSummary,"Current result observed")
    XCTAssertTrue(model.status.contains("Microphone listening"))
    for reason in ["agent_stale", "gateway_unavailable"] {
      t = try telemetry(overrides:["activity":projection,"readiness":["reason":reason,"checkedAt":now.timeIntervalSinceReferenceDate]])
      model = PanelPresentation(telemetry:t,pending:nil,sharing:"Viewing")
      XCTAssertTrue(model.status.contains("unavailable"))
      XCTAssertFalse(model.status.contains("completed"))
      XCTAssertFalse(model.detail.contains("Current result observed"))
      XCTAssertFalse(model.controlsEnabled)
      let panel = ControlPanelState(); try panel.update(t,lease:lease(),now:now)
      XCTAssertNil(panel.current(now:now)?.activity)
    }
    projection["work"] = "executing"; projection.removeValue(forKey:"outcome")
    t = try telemetry(overrides:["activity":projection])
    XCTAssertEqual(PanelPresentation(telemetry:t,pending:nil,sharing:"Viewing").currentSummary, "")
  }
  func testPanelMetadataAllows64KiBWithoutWideningInputBodies() throws {
    func request(_ path:String,_ count:Int) -> Data {
      Data(("POST \(path) HTTP/1.1\r\nContent-Length: \(count)\r\n\r\n" + String(repeating:"x",count:count)).utf8)
    }
    XCTAssertEqual(try HTTPRequest.parse(request("/v1/panel",65536))?.body.count,65536)
    XCTAssertThrowsError(try HTTPRequest.parse(request("/v1/panel",65537)))
    XCTAssertThrowsError(try HTTPRequest.parse(request("/v1/leases",16385)))
    XCTAssertEqual(try HTTPRequest.parse(request("/v1/leases",16384))?.body.count,16384)
  }
  func testWindowBoundsForTwoDisplaysAndSmallScreen() {
    for bounds in [NSRect(x:0,y:0,width:1280,height:720),NSRect(x:-1920,y:80,width:1920,height:1080),NSRect(x:0,y:0,width:360,height:640)] {
      let clipped = ActivityPanelView.constrained(NSRect(x:2000,y:-500,width:480,height:480),to:bounds)
      XCTAssertTrue(bounds.contains(clipped)); XCTAssertGreaterThanOrEqual(clipped.width,360)
    }
  }
}
