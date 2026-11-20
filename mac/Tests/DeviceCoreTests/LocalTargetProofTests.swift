import Foundation
import XCTest
@testable import DeviceCore

final class LocalTargetProofTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func lease() -> LocalExecutionLease {
    .init(id: "lease", deviceId: "device", sessionId: "session", taskId: "task", executorId: "executor",
      executorEpoch: 1, policyRevision: 1, displayId: 7, expiresAt: now.addingTimeInterval(25))
  }
  func frame(_ id: String, at: Double) -> FrameStamp {
    .init(id: id, leaseId: "lease", displayId: 7, capturedAt: now.addingTimeInterval(at), width: 1280, height: 720)
  }
  func action(frame: String = "new", text: String = "hello") -> InputAction {
    .init(id: "action", frameId: frame, type: "type", text: text, executorEpoch: 1, policyRevision: 1, sessionId: "session")
  }
  func testExactCanonicalPointDoesNotSilentlySnapModelCoordinates() {
    let point = LocalTargetPoint(id: "target", role: "AXButton", x: 0.12345678, y: 0.5)
    XCTAssertEqual(point.x, 0.123457)
    XCTAssertNotEqual(point, LocalTargetPoint(id: "target", role: "AXButton", x: point.x, y: 0.6), "Same target ID cannot renew a moved canonical point")
    var input = InputAction(id: "action", frameId: "frame", type: "click", x: 0.123457, y: 0.5)
    XCTAssertTrue(point.matches(LocalPlannedAction(input)))
    input.x = 0.12345678
    XCTAssertFalse(point.matches(LocalPlannedAction(input)))
  }
  func testProofIsBoundToOriginalAndCurrentFramesActionAndSingleUse() throws {
    let proofs = LocalTargetProofs<String>()
    proofs.register(frame("old", at: 0), snapshot: "original")
    proofs.register(frame("new", at: 0.2), snapshot: "current")
    let id = try XCTUnwrap(proofs.issue(planned: "old", current: "new", action: LocalPlannedAction(action()), lease: lease(), now: now.addingTimeInterval(0.3)))
    let pair = try proofs.consume(id, action: action(), lease: lease(), now: now.addingTimeInterval(0.4))
    XCTAssertEqual(pair.0.snapshot, "original"); XCTAssertEqual(pair.1.snapshot, "current")
    XCTAssertThrowsError(try proofs.consume(id, action: action(), lease: lease(), now: now.addingTimeInterval(0.4)))
    let changed = try XCTUnwrap(proofs.issue(planned: "old", current: "new", action: LocalPlannedAction(action()), lease: lease(), now: now.addingTimeInterval(0.3)))
    XCTAssertThrowsError(try proofs.consume(changed, action: action(text: "other"), lease: lease(), now: now.addingTimeInterval(0.4)))
    XCTAssertThrowsError(try proofs.consume(changed, action: action(), lease: lease(), now: now.addingTimeInterval(0.4)), "Even a mismatched use consumes the capability")
  }
  func testStaleFutureWrongLeaseAndNotLatestFramesCannotIssueProof() throws {
    let proofs = LocalTargetProofs<String>()
    proofs.register(frame("old", at: 0), snapshot: "old")
    proofs.register(frame("new", at: 0.2), snapshot: "new")
    XCTAssertNil(proofs.pair(planned: "old", current: "new", lease: lease(), now: now.addingTimeInterval(2.21)))
    XCTAssertNil(proofs.pair(planned: "old", current: "new", lease: lease(), now: now))
    XCTAssertNil(proofs.pair(planned: "new", current: "new", lease: lease(), now: now.addingTimeInterval(0.3)))
    var wrong = lease(); wrong.id = "wrong"
    XCTAssertNil(proofs.pair(planned: "old", current: "new", lease: wrong, now: now.addingTimeInterval(0.3)))
    proofs.register(frame("latest", at: 0.4), snapshot: "latest")
    XCTAssertNil(proofs.pair(planned: "old", current: "new", lease: lease(), now: now.addingTimeInterval(0.5)))
  }
  func testStopEvictionAndNewCaptureInvalidateProofs() throws {
    let proofs = LocalTargetProofs<Int>()
    proofs.register(frame("old", at: 0), snapshot: 0)
    proofs.register(frame("new", at: 0.2), snapshot: 1)
    let id = try XCTUnwrap(proofs.issue(planned: "old", current: "new", action: LocalPlannedAction(action()), lease: lease(), now: now.addingTimeInterval(0.3)))
    proofs.register(frame("latest", at: 0.4), snapshot: 2)
    XCTAssertThrowsError(try proofs.consume(id, action: action(), lease: lease(), now: now.addingTimeInterval(0.5)))
    for index in 3...10 { proofs.register(frame("f\(index)", at: Double(index) / 10), snapshot: index) }
    XCTAssertNil(proofs.pair(planned: "old", current: "f10", lease: lease(), now: now.addingTimeInterval(1.1)))
    proofs.clear()
    XCTAssertNil(proofs.latestFrameId)
    XCTAssertNil(proofs.pair(planned: "f9", current: "f10", lease: lease(), now: now.addingTimeInterval(1.1)))
  }
  func testOptionalProofDoesNotAlterPlannedActionButDoesBindDispatchReceipt() throws {
    var input = action()
    let plain = try fingerprint(input)
    let plan = LocalPlannedAction(input)
    input.localProofId = "proof"
    XCTAssertNotEqual(try fingerprint(input), plain)
    XCTAssertEqual(LocalPlannedAction(input), plan)
    try input.validate()
    input.localProofId = "../bad"
    XCTAssertThrowsError(try input.validate())
  }
}
