import Foundation
import XCTest
@testable import TaskPanelCore

final class TaskPanelTests: XCTestCase {
  var root: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
  func config() -> PanelConfiguration {
    PanelConfiguration(version: 1, desktopId: "desktop_fixture", origin: "http://127.0.0.1:13326",
      token: String(repeating: "synthetic", count: 8), projectRoot: root.appendingPathComponent("worker").path,
      receiptDirectory: root.path, configurationFingerprint: String(repeating: "a", count: 64))
  }
  func snapshot(taskState: String = "review_ready", worker: String = "codex", canSubmit: Bool = false,
                expiry: Double = Date().timeIntervalSince1970 * 1000 + 60000) -> PanelSnapshot {
    let c = config()
    return PanelSnapshot(version: 1, desktopId: c.desktopId, instanceId: "instance_fixture",
      configurationFingerprint: c.configurationFingerprint, projectRoot: c.projectRoot, projectLabel: "Fixture",
      worker: worker, mode: worker == "simulation" ? "simulation" : "standby", sessionExpiresAt: expiry,
      sessionActive: true, notice: nil, canSubmit: canSubmit,
      task: PanelTask(id: "task_fixture", runId: "run_fixture", revision: 4, goal: "A synthetic goal", state: taskState,
        summary: "An authoritative summary", decision: nil,
        checks: [.init(name: "Fixture check", state: "failed", summary: "A real failure")],
        canDecide: true, canAccept: true, canCancel: true, updatedAt: 1),
      controls: .init(controlId: "control_fixture", sharingActive: true, callActive: true, canStopSharing: true, canStopCall: true), operations: [])
  }
  func operation(_ id: String, action: PanelAction? = .submit, state: String) -> PanelOperation {
    PanelOperation(eventId: id, action: action, state: state, message: "Synthetic receipt", taskId: nil, resultRevision: nil)
  }
  func payload(_ id: String = "event_fixture") throws -> Data {
    try JSONSerialization.data(withJSONObject: ["eventId": id, "action": "submit", "goal": "SENSITIVE TEST GOAL"], options: [.sortedKeys])
  }
  func testWorkerChoicesFillOnlyAndRemainExplicitlySubmitted() throws {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot(taskState: "needs_decision"))) as! [String: Any]
    var task = object["task"] as! [String: Any]
    task["decision"] = ["question": "Which wording?", "options": ["Keep the exact text", "Use the supplied replacement"]]
    object["task"] = task
    let decoded = try JSONDecoder().decode(PanelSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    try decoded.validate(configuration: config())
    var state = PanelState(); state.snapshot = decoded; state.connected = true
    XCTAssertEqual(state.decisionOption(at: 1), "Use the supplied replacement")
    XCTAssertTrue(state.pending.isEmpty)
    XCTAssertNil(state.decisionOption(at: 3))
    let payload = try state.payload(.decide, text: state.decisionOption(at: 1)!, eventId: "choice_event")
    XCTAssertEqual(payload["instruction"] as? String, "Use the supplied replacement")
    state.taskMutationBoundary(.decide)
    XCTAssertNil(state.decisionOption(at: 0))
    for invalid in [[], ["only one"], [""], [" \n"], [String(repeating: "a", count: 501)], ["a", "b", "c", "d"]] {
      XCTAssertThrowsError(try PanelTask.Decision(question: "Which?", options: invalid).validate())
    }
    try PanelTask.Decision(question: "Free text?", options: nil).validate()
  }
  func testPendingTaskDoesNotDisableIndependentStopControls() throws {
    var state = PanelState(); state.snapshot = snapshot(); state.connected = true
    state.pending = [.init(eventId: "pending", digest: String(repeating: "b", count: 64), action: .decide, state: "unknown", createdAt: 1)]
    XCTAssertFalse(state.allows(.accept)); XCTAssertFalse(state.allows(.decide)); XCTAssertFalse(state.allows(.cancel))
    XCTAssertTrue(state.allows(.stopSharing)); XCTAssertTrue(state.allows(.stopCall))
    state.pending.append(.init(eventId: "stop", digest: String(repeating: "b", count: 64), action: .stopSharing, state: "pending", createdAt: 1))
    XCTAssertFalse(state.allows(.stopSharing)); XCTAssertTrue(state.allows(.stopCall))
  }
  func testDoneReceiptCannotReenableStaleSnapshotButStopStaysReachable() throws {
    var state = PanelState(); state.snapshot = snapshot(); state.connected = true
    let oldRead = state.mutationGeneration
    state.taskMutationBoundary(.accept)
    state.taskMutationBoundary(.accept) // response done, before next state read
    XCTAssertFalse(state.allows(.accept)); XCTAssertTrue(state.allows(.stopCall))
    state.receive(snapshot(), readGeneration: oldRead)
    XCTAssertFalse(state.allows(.accept))
    state.receive(snapshot(), readGeneration: state.mutationGeneration)
    XCTAssertTrue(state.allows(.accept))
  }
  func testExpiredOrDisconnectedTaskAuthorityDoesNotHideOwnedStop() throws {
    var state = PanelState(); state.snapshot = snapshot(expiry: 1); state.connected = false
    XCTAssertFalse(state.allows(.accept)); XCTAssertFalse(state.allows(.decide))
    XCTAssertTrue(state.allows(.stopCall)); XCTAssertTrue(state.allows(.stopSharing))
  }
  func testPayloadBindsExactCurrentTaskAndDoesNotRewriteInput() throws {
    var state = PanelState(); state.snapshot = snapshot(); state.connected = true
    let text = "  Change only this exact text.\n"
    let value = try state.payload(.decide, text: text, eventId: "event_fixture")
    XCTAssertEqual(value["taskId"] as? String, "task_fixture")
    XCTAssertEqual(value["runId"] as? String, "run_fixture")
    XCTAssertEqual(value["expectedRevision"] as? Int, 4)
    XCTAssertEqual(value["instruction"] as? String, text)
    XCTAssertThrowsError(try state.payload(.decide, text: "   ", eventId: "blank"))
    let stop = try state.payload(.stopCall, eventId: "stop")
    XCTAssertEqual(Set(stop.keys), Set(["eventId", "action", "controlId"]))
  }
  func testSimulationAndAdmissionReceiptNeverBecomeWorkerSuccess() throws {
    var state = PanelState(); state.snapshot = snapshot(taskState: "queued", worker: "simulation"); state.connected = true
    XCTAssertEqual(state.stage, "Queued · simulation")
    XCTAssertEqual(state.snapshot?.task?.checks.first?.state, "failed")
    let journal = try PanelReceiptStore(directory: root.path)
    try journal.reserve(action: .submit, eventId: "event_fixture", payload: payload())
    try journal.observe(operation("event_fixture", state: "done"))
    state.pending = journal.entries
    XCTAssertFalse(state.hasTaskRequest)
    XCTAssertEqual(state.stage, "Queued · simulation")
  }
  func testReceiptIsDurableBeforePostAndContainsNoGoalOrToken() throws {
    let journal = try PanelReceiptStore(directory: root.path)
    let body = try payload()
    try journal.reserve(action: .submit, eventId: "event_fixture", payload: body)
    let data = try Data(contentsOf: root.appendingPathComponent("panel-operations.json"))
    let saved = try JSONDecoder().decode([PendingPanelOperation].self, from: data)
    XCTAssertEqual(saved.first?.digest, PrivatePanelFiles.digest(body))
    XCTAssertEqual(saved.first?.state, "pending")
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("SENSITIVE TEST GOAL"))
    let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("panel-operations.json").path)[.posixPermissions] as? NSNumber
    XCTAssertEqual(mode?.intValue, 0o600)
    XCTAssertThrowsError(try journal.reserve(action: .submit, eventId: "event_fixture", payload: body))
  }
  func testRestartAndNotFoundPreserveUnknownWithoutReplay() throws {
    do {
      let journal = try PanelReceiptStore(directory: root.path)
      try journal.reserve(action: .submit, eventId: "event_fixture", payload: payload())
    }
    let restored = try PanelReceiptStore(directory: root.path)
    XCTAssertEqual(restored.entries.first?.state, "unknown")
    try restored.observe(operation("event_fixture", action: nil, state: "not_found"))
    XCTAssertTrue(restored.entries.first!.unresolved)
    try restored.observe(operation("event_fixture", state: "done"))
    try restored.observe(operation("event_fixture", state: "unknown"))
    XCTAssertEqual(restored.entries.first?.state, "done")
  }
  func testReceiptMismatchCannotClearPending() throws {
    let journal = try PanelReceiptStore(directory: root.path)
    try journal.reserve(action: .submit, eventId: "event_fixture", payload: payload())
    XCTAssertThrowsError(try journal.observe(operation("event_fixture", action: .cancel, state: "done")))
    XCTAssertTrue(journal.entries.first!.unresolved)
  }
  func testExclusiveLockChecksExactReopenBinding() throws {
    let journal = try PanelReceiptStore(directory: root.path, binding: "same")
    XCTAssertThrowsError(try PanelReceiptStore(directory: root.path, binding: "same")) { error in
      guard case PanelFailure.alreadyOpen = error else { return XCTFail("Wrong error") }
    }
    XCTAssertThrowsError(try PanelReceiptStore(directory: root.path, binding: "different")) { error in
      guard case PanelFailure.differentPanel = error else { return XCTFail("Wrong error") }
    }
    withExtendedLifetime(journal) {}
  }
  func testPrivateConfigRejectsSymlinkUnsafeModeAndProjectStorage() throws {
    let url = root.appendingPathComponent("panel.json")
    try JSONEncoder().encode(config()).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    XCTAssertEqual(try PrivatePanelFiles.configuration(at: url), config())
    let link = root.appendingPathComponent("link.json")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
    XCTAssertThrowsError(try PrivatePanelFiles.configuration(at: link))
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    XCTAssertThrowsError(try PrivatePanelFiles.configuration(at: url))
    XCTAssertThrowsError(try config().validate(configPath: URL(fileURLWithPath: config().projectRoot).appendingPathComponent("unsafe.json")))
  }
  func testSnapshotRejectsDifferentDesktopOrProjectIdentity() throws {
    let good = snapshot(); try good.validate(configuration: config())
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(good)) as! [String: Any]
    object["desktopId"] = "other"
    let wrong = try JSONDecoder().decode(PanelSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    XCTAssertThrowsError(try wrong.validate(configuration: config()))
  }
}
