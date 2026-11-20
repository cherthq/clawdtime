import Foundation
import XCTest
@testable import DeviceCore

final class LocalWindowPolicyTests: XCTestCase {
  let applications = ["com.clawdtime.fixture.alpha", "com.clawdtime.fixture.beta"]
  func testActivationRetainsNativeSecurityPreconditions() throws {
    try LocalWindowPolicy.requireNativeActivation(accessibility: true, secureInput: false, displayActive: true)
    XCTAssertThrowsError(try LocalWindowPolicy.requireNativeActivation(accessibility: false, secureInput: false, displayActive: true))
    XCTAssertThrowsError(try LocalWindowPolicy.requireNativeActivation(accessibility: true, secureInput: true, displayActive: true))
    XCTAssertThrowsError(try LocalWindowPolicy.requireNativeActivation(accessibility: true, secureInput: false, displayActive: false))
  }
  func testActivationIsExplicitExistingApplicationOptIn() throws {
    XCTAssertTrue(LocalWindowPolicy.validApplications([]))
    XCTAssertFalse(LocalWindowPolicy.allowed(applications[0], applications: []))
    XCTAssertTrue(LocalWindowPolicy.allowed(applications[0], applications: applications))
    XCTAssertFalse(LocalWindowPolicy.allowed("com.example.other", applications: applications))
    XCTAssertFalse(LocalWindowPolicy.validApplications([applications[0], applications[0]]))
    XCTAssertFalse(LocalWindowPolicy.validApplications(["../app"]))
    XCTAssertFalse(LocalWindowPolicy.validApplications((0..<21).map { "com.example.a\($0)" }))
    for denied in ["com.apple.Terminal", "com.apple.systempreferences", "com.apple.SecurityAgent", "com.clawdtime.task-panel", "com.clawdtime.local-control"] {
      XCTAssertFalse(LocalWindowPolicy.validApplications([denied]))
      XCTAssertFalse(LocalWindowPolicy.allowed(denied, applications: [denied]))
    }
    var config = HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32), displays: [],
      localExecutors: [.init(executorId: "owned", displayId: 7, allowedApplications: applications)])
    try config.validate()
    config.localExecutors?[0].allowedApplications = ["com.apple.Terminal"]
    XCTAssertThrowsError(try config.validate())
  }
  func testActivationShapeCannotCarryCoordinatesTextOrLaunchPath() throws {
    var input = InputAction(id: "action", frameId: "frame", type: "activate", targetId: "observed_window")
    try input.validate()
    let json = try JSONEncoder().encode(LocalPlannedAction(input))
    XCTAssertEqual(try JSONDecoder().decode(LocalPlannedAction.self, from: json).targetId, "observed_window")
    input.x = 0.5; XCTAssertThrowsError(try input.validate())
    input.x = nil; input.text = "open app"; XCTAssertThrowsError(try input.validate())
    input.text = nil; input.targetId = "/Applications/App.app"; XCTAssertThrowsError(try input.validate())
    input.targetId = nil; XCTAssertThrowsError(try input.validate())
    input = InputAction(id: "action", frameId: "frame", type: "click", x: 0.5, y: 0.5, targetId: "window")
    XCTAssertThrowsError(try input.validate())
  }
  func testLegacyCallLeaseCannotActivateEvenWithFreshFrame() throws {
    let now = Date()
    let config = HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32),
      displays: [.init(displayId: 7, viewers: ["member"], controllers: ["member"])])
    let policy = try DevicePolicy(config: config, preferences: .init(deviceId: "device", policy: .agentToolsWithFallback))
    policy.arm()
    try policy.begin(.init(id: "lease", deviceId: "device", memberId: "member", callId: "call", displayId: 7, mode: "control", expiresAt: now.addingTimeInterval(25)), now: now, sessionAvailable: true, accessibility: true)
    try policy.recordFrame(.init(id: "frame", leaseId: "lease", displayId: 7, capturedAt: now, width: 1280, height: 720))
    XCTAssertThrowsError(try policy.validateAction(.init(id: "action", frameId: "frame", type: "activate", targetId: "window"), leaseId: "lease", now: now, sessionAvailable: true, accessibility: true))
  }
  func testActivationProofBindsExactWindowAndReceiptNeedsObservation() throws {
    let now = Date(), path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    let store = try LocalExecutionStore(folder: path)
    let lease = LocalExecutionLease(id: "lease", deviceId: "device", sessionId: "session", taskId: "task", executorId: "executor", executorEpoch: 1, policyRevision: 1, displayId: 7, expiresAt: now.addingTimeInterval(25))
    var action = InputAction(id: "action", frameId: "current", type: "activate", executorEpoch: 1, policyRevision: 1, sessionId: "session", targetId: "alpha")
    let proofs = LocalTargetProofs<String>()
    proofs.register(.init(id: "planned", leaseId: "lease", displayId: 7, capturedAt: now, width: 1280, height: 720), snapshot: "alpha")
    proofs.register(.init(id: "current", leaseId: "lease", displayId: 7, capturedAt: now.addingTimeInterval(0.1), width: 1280, height: 720), snapshot: "alpha")
    let proof = try XCTUnwrap(proofs.issue(planned: "planned", current: "current", action: LocalPlannedAction(action), lease: lease, now: now.addingTimeInterval(0.2)))
    action.targetId = "beta"
    XCTAssertThrowsError(try proofs.consume(proof, action: action, lease: lease, now: now.addingTimeInterval(0.3)))
    action.targetId = "alpha"
    try store.reserve(lease); try store.begin(action, lease: lease, now: now)
    let receipt = try store.finish("action", submitted: true, now: now.addingTimeInterval(0.1), windowActivation: true)
    XCTAssertEqual(receipt.evidence, "window_activation_submitted_not_application_verified")
    XCTAssertEqual(store.unresolvedActions, 1)
    try store.observedFrame(leaseId: "lease", capturedAt: now.addingTimeInterval(0.2))
    XCTAssertEqual(store.unresolvedActions, 0)
    XCTAssertEqual(try store.get("action", leaseId: "lease").state, "submitted", "Observation does not assert that the requested window is actually frontmost")
  }
}
