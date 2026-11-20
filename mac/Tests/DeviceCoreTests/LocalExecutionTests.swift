import Foundation
import XCTest
@testable import DeviceCore

final class LocalExecutionTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func config() -> HelperConfig {
    HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32),
      displays: [.init(displayId: 7, viewers: ["member"], controllers: ["member"])],
      localExecutors: [.init(executorId: "owned", displayId: 7)])
  }
  func lease(_ id: String = "local") -> LocalExecutionLease {
    .init(id: id, deviceId: "device", sessionId: "chat", taskId: "task", executorId: "owned",
      executorEpoch: 2, policyRevision: 1, displayId: 7, expiresAt: now.addingTimeInterval(25))
  }
  func policies() throws -> (DevicePolicy, LocalExecutionPolicy) {
    let shared = try DevicePolicy(config: config())
    return (shared, LocalExecutionPolicy(shared: shared))
  }
  func action(_ id: String = "action") -> InputAction {
    .init(id: id, frameId: "frame", type: "click", x: 0.5, y: 0.5, executorEpoch: 2, policyRevision: 1, sessionId: "chat")
  }
  func folder() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  func testLocalOptInIsSeparateAndLoopbackOnly() throws {
    var value = config(); try value.validate()
    value.bind = "100.64.0.1"; XCTAssertThrowsError(try value.validate())
    value = config(); let duplicate = value.localExecutors![0]; value.localExecutors?.append(duplicate); XCTAssertThrowsError(try value.validate())
    value = config(); value.localExecutors = nil
    let shared = try DevicePolicy(config: value); shared.arm()
    XCTAssertThrowsError(try LocalExecutionPolicy(shared: shared).begin(lease(), now: now, available: true, accessibility: true))
    let encoded = try JSONEncoder().encode(lease())
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertNil(object["callId"]); XCTAssertNil(object["memberId"])
  }
  func testLocalEnablePermissionsAndPolicyAreIndependent() throws {
    let (shared, local) = try policies()
    XCTAssertThrowsError(try local.begin(lease(), now: now, available: true, accessibility: true))
    shared.arm()
    XCTAssertThrowsError(try local.begin(lease(), now: now, available: true, accessibility: false))
    var wrong = lease(); wrong.executorId = "other"
    XCTAssertThrowsError(try local.begin(wrong, now: now, available: true, accessibility: true))
    wrong = lease(); wrong.displayId = 8
    XCTAssertThrowsError(try local.begin(wrong, now: now, available: true, accessibility: true))
    wrong = lease(); wrong.expiresAt = now.addingTimeInterval(31)
    XCTAssertThrowsError(try local.begin(wrong, now: now, available: true, accessibility: true))
    try shared.updatePreferences(.init(deviceId: "device", revision: 2, policy: .viewOnly)); shared.arm()
    wrong = lease(); wrong.policyRevision = 2
    XCTAssertThrowsError(try local.begin(wrong, now: now, available: true, accessibility: true))
  }
  func testLegacyAndLocalHaveOneExclusiveOwnershipSlot() throws {
    let (shared, local) = try policies(); shared.arm()
    let remote = Lease(id: "remote", deviceId: "device", memberId: "member", callId: "call", displayId: 7, mode: "view", expiresAt: now.addingTimeInterval(25))
    try shared.begin(remote, now: now, sessionAvailable: true, accessibility: true)
    XCTAssertThrowsError(try local.begin(lease(), now: now, available: true, accessibility: true))
    shared.stop(); try local.begin(lease(), now: now, available: true, accessibility: true)
    XCTAssertThrowsError(try shared.begin(remote, now: now, sessionAvailable: true, accessibility: true))
    local.stop(); XCTAssertNil(shared.localSessionOwner)
    var next = remote; next.id = "newremote"
    try shared.begin(next, now: now, sessionAvailable: true, accessibility: true)
  }
  func testSharedStopAndLockRetireLocalOwnerAndNeverResume() throws {
    let (shared, local) = try policies(); shared.arm()
    try local.begin(lease(), now: now, available: true, accessibility: true)
    shared.stop(disarm: true)
    XCTAssertThrowsError(try local.require("local", now: now, available: true))
    XCTAssertNil(local.lease); shared.arm()
    XCTAssertThrowsError(try local.begin(lease(), now: now, available: true, accessibility: true))
    try local.begin(lease("next"), now: now, available: true, accessibility: true)
    XCTAssertThrowsError(try local.require("next", now: now, available: false))
    XCTAssertFalse(shared.armed); XCTAssertNil(local.lease)
  }
  func testRenewalCannotChangeBindingOrResurrectExpiry() throws {
    let (shared, local) = try policies(); shared.arm()
    try local.begin(lease(), now: now, available: true, accessibility: true)
    for field in ["task", "session", "executor", "epoch", "policy", "display", "device"] {
      var changed = lease()
      switch field {
      case "task": changed.taskId = "other"
      case "session": changed.sessionId = "other"
      case "executor": changed.executorId = "other"
      case "epoch": changed.executorEpoch += 1
      case "policy": changed.policyRevision += 1
      case "display": changed.displayId = 8
      default: changed.deviceId = "other"
      }
      XCTAssertThrowsError(try local.renew(changed, now: now, available: true, accessibility: true))
    }
    var renewed = lease(); renewed.expiresAt = now.addingTimeInterval(30)
    try local.renew(renewed, now: now, available: true, accessibility: true)
    renewed.expiresAt = now.addingTimeInterval(55)
    XCTAssertThrowsError(try local.renew(renewed, now: now.addingTimeInterval(31), available: true, accessibility: true))
    XCTAssertNil(local.lease)
  }
  func testInputNeedsExactFreshFrameEpochAndSessionAndStopFencesLateFrame() throws {
    let (shared, local) = try policies(); shared.arm()
    try local.begin(lease(), now: now, available: true, accessibility: true)
    XCTAssertThrowsError(try local.validateAction(action(), id: "local", now: now, available: true, accessibility: true))
    let frame = FrameStamp(id: "frame", leaseId: "local", displayId: 7, capturedAt: now, width: 100, height: 100)
    try local.recordFrame(frame)
    _ = try local.validateAction(action(), id: "local", now: now.addingTimeInterval(1), available: true, accessibility: true)
    XCTAssertThrowsError(try local.validateAction(action(), id: "local", now: now.addingTimeInterval(2.01), available: true, accessibility: true))
    var changed = action(); changed.sessionId = "different"
    XCTAssertThrowsError(try local.validateAction(changed, id: "local", now: now, available: true, accessibility: true))
    changed = action(); changed.executorEpoch = 3
    XCTAssertThrowsError(try local.validateAction(changed, id: "local", now: now, available: true, accessibility: true))
    local.invalidateFrame()
    XCTAssertThrowsError(try local.validateAction(action(), id: "local", now: now, available: true, accessibility: true))
    local.stop(); XCTAssertThrowsError(try local.recordFrame(frame))
  }
  func testReceiptsSurviveRestartWithoutReplayingOrClaimingUISuccess() throws {
    let path = try folder()
    var store: LocalExecutionStore? = try LocalExecutionStore(folder: path)
    try store!.reserve(lease()); try store!.begin(action(), lease: lease(), now: now)
    XCTAssertEqual(try store!.get("action", leaseId: "local").state, "dispatching")
    store = nil
    store = try LocalExecutionStore(folder: path)
    XCTAssertTrue(store!.used("local"))
    XCTAssertThrowsError(try store!.reserve(lease()))
    XCTAssertEqual(try store!.existing(action(), leaseId: "local")?.state, "unknown")
    XCTAssertEqual(store!.unresolvedActions, 1)
    try store!.observedFrame(leaseId: "local", capturedAt: now.addingTimeInterval(2))
    XCTAssertEqual(store!.unresolvedActions, 1, "Unknown dispatch is not silently cleared by another frame")
    XCTAssertThrowsError(try store!.begin(action("second"), lease: lease(), now: now))
    var changed = action(); changed.x = 0.7
    XCTAssertThrowsError(try store!.existing(changed, leaseId: "local"))
    let saved = try String(contentsOf: path.appendingPathComponent("journal.json"), encoding: .utf8)
    XCTAssertFalse(saved.contains("frameId")); XCTAssertFalse(saved.contains("callId"))
  }
  func testSubmittedInputOnlyClearsAfterFreshPostInputObservation() throws {
    let store = try LocalExecutionStore(folder: folder())
    try store.reserve(lease()); try store.begin(action(), lease: lease(), now: now)
    let result = try store.finish("action", submitted: true, now: now.addingTimeInterval(0.1))
    XCTAssertEqual(result.evidence, "cg_event_posted_not_application_verified")
    XCTAssertEqual(store.unresolvedActions, 1)
    try store.observedFrame(leaseId: "local", capturedAt: now)
    XCTAssertEqual(store.unresolvedActions, 1)
    try store.observedFrame(leaseId: "local", capturedAt: now.addingTimeInterval(0.2))
    XCTAssertEqual(store.unresolvedActions, 0)
    XCTAssertEqual(try store.get("action", leaseId: "local").state, "submitted")
    XCTAssertEqual(try store.get("action", leaseId: "local").evidence, "post_input_frame_available_not_application_verified")
    XCTAssertThrowsError(try store.begin(action(), lease: lease(), now: now))
  }
  func testPrivateStoreRefusesSymlinkAndConcurrentOwner() throws {
    let path = try folder()
    let first = try LocalExecutionStore(folder: path)
    XCTAssertThrowsError(try LocalExecutionStore(folder: path))
    XCTAssertEqual(first.unresolvedActions, 0)
    let unsafe = try folder()
    try FileManager.default.createSymbolicLink(at: unsafe.appendingPathComponent("journal.json"), withDestinationURL: path.appendingPathComponent("journal.json"))
    XCTAssertThrowsError(try LocalExecutionStore(folder: unsafe))
  }
  func testHTTPParserRecognizesOnlyExactLocalPrefixAndRetainsBodyLimits() throws {
    let parsed = try HTTPRequest.parse(Data("POST /local/v1/sessions/local/stop HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}".utf8))
    XCTAssertEqual(parsed?.path, "/local/v1/sessions/local/stop")
    for path in ["/local/v2/sessions", "/local/v1/sessions?x=y", "/local/v1/%2f"] {
      XCTAssertThrowsError(try HTTPRequest.parse(Data("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8)))
    }
  }
  func testExcludedUIAndMissingHitWitnessCannotReceiveInput() throws {
    XCTAssertTrue(LocalInputExclusion.isOwned(bundleId: "com.clawdtime.task-panel", pid: 12, helperPID: 11))
    XCTAssertTrue(LocalInputExclusion.isOwned(bundleId: "com.clawdtime.supervisor.anish", pid: 13, helperPID: 11))
    XCTAssertTrue(LocalInputExclusion.isOwned(bundleId: "com.clawdtime.companion", pid: 10, helperPID: 11))
    XCTAssertTrue(LocalInputExclusion.isOwned(bundleId: nil, pid: 11, helperPID: 11))
    XCTAssertFalse(LocalInputExclusion.isOwned(bundleId: "com.example.editor", pid: 12, helperPID: 11))
    XCTAssertThrowsError(try LocalInputExclusion.validate(witnessKnown: false, targetOwned: false, coveredByOwnedWindow: false))
    XCTAssertThrowsError(try LocalInputExclusion.validate(witnessKnown: true, targetOwned: true, coveredByOwnedWindow: false))
    XCTAssertThrowsError(try LocalInputExclusion.validate(witnessKnown: true, targetOwned: false, coveredByOwnedWindow: true))
    XCTAssertNoThrow(try LocalInputExclusion.validate(witnessKnown: true, targetOwned: false, coveredByOwnedWindow: false))
  }

}
