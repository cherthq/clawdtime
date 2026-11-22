import Foundation
import XCTest
@testable import DeviceCore

final class BackgroundExecutionStoreTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func lease() -> LocalExecutionLease { .init(id: "lease", deviceId: "device", sessionId: "session", taskId: "task", executorId: "executor", executorEpoch: 3, policyRevision: 1, displayId: 1, expiresAt: now.addingTimeInterval(25)) }
  func reservation(_ id: String = "controller") -> BackgroundControllerReservation { .init(id: id, fingerprint: String(repeating: "a", count: 64), driverGeneration: "generation", driverPid: 42, driverProcessStart: String(repeating: "b", count: 64), observedAt: now) }
  func resolution(_ at: Date? = nil) -> BackgroundControllerResolution { .init(fingerprint: reservation().fingerprint, driverGeneration: "generation", driverPid: 42, driverProcessStart: reservation().driverProcessStart, driverQuiescent: true, allActionsReconciled: true, observationId: "observed", observedAt: at ?? now.addingTimeInterval(1), outcome: "observed_completed") }
  func folder() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }; return url
  }
  func testReservationFencesLegacyLocalStoreBeforeReturningAndDuplicatesNeverReplay() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local.reserve(lease()); let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    let first = try store.reserve(reservation(), lease: lease(), now: now)
    XCTAssertEqual(first.state, "reserved"); XCTAssertEqual(local.unresolvedActions, 1); XCTAssertEqual(store.unresolvedActions, 1)
    XCTAssertEqual(try store.reserve(reservation(), lease: lease(), now: now), first)
    XCTAssertThrowsError(try store.reserve(reservation("second"), lease: lease(), now: now))
    let action = InputAction(id: "old-native", frameId: "frame", type: "click", x: 0.5, y: 0.5)
    XCTAssertThrowsError(try local.begin(action, lease: lease(), now: now))
    var changed = reservation(); changed.driverPid = 99
    XCTAssertThrowsError(try store.existing(changed, leaseId: "lease"))
    try local.observedFrame(leaseId: "lease", capturedAt: now.addingTimeInterval(1))
    XCTAssertEqual(local.unresolvedActions, 1, "An unrelated frame cannot clear an external controller")
  }
  func testRestartRetainsUnknownFenceAndOldLocalReaderBlocksInput() throws {
    let root = try folder()
    var local: LocalExecutionStore? = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local!.reserve(lease())
    var store: BackgroundExecutionStore? = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    _ = try store!.reserve(reservation(), lease: lease(), now: now); store = nil; local = nil
    // The previous helper knows only LocalExecutionStore and still fails closed.
    local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    XCTAssertEqual(local!.unresolvedActions, 1)
    XCTAssertThrowsError(try local!.begin(InputAction(id: "old", frameId: "f", type: "click", x: 0.1, y: 0.1), lease: lease(), now: now.addingTimeInterval(60)))
    store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    XCTAssertEqual(try store!.get("controller", leaseId: "lease").state, "unknown")
    XCTAssertEqual(store!.unresolvedActions, 1)
  }
  func testStopExpiryDoNotResolveButExactQuiescentCleanupAfterExpiryDoes() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    let config = HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32), displays: [.init(displayId: 1, viewers: [], controllers: [])], localExecutors: [.init(executorId: "executor", displayId: 1)])
    let shared = try DevicePolicy(config: config); shared.arm(); let policy = LocalExecutionPolicy(shared: shared)
    try policy.begin(lease(), now: now, available: true, accessibility: true); try local.reserve(lease())
    let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    _ = try store.reserve(reservation(), lease: lease(), now: now); policy.stop(); shared.stop(disarm: true)
    XCTAssertNil(policy.lease); XCTAssertEqual(local.unresolvedActions, 1); XCTAssertEqual(store.unresolvedActions, 1)
    let later = now.addingTimeInterval(60), proof = resolution(now.addingTimeInterval(59))
    _ = try store.resolve("controller", leaseId: "lease", value: proof, now: later)
    XCTAssertEqual(local.unresolvedActions, 0); XCTAssertEqual(store.unresolvedActions, 0)
    XCTAssertEqual(try store.resolve("controller", leaseId: "lease", value: proof, now: later).state, "resolved")
    XCTAssertThrowsError(try store.resolve("controller", leaseId: "wrong", value: proof, now: later))
  }
  func testUnknownOutcomesOrWrongDriverCannotClearFence() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local.reserve(lease()); let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    _ = try store.reserve(reservation(), lease: lease(), now: now)
    var proofs: [BackgroundControllerResolution] = []
    var p = resolution(); p.driverQuiescent = false; proofs.append(p)
    p = resolution(); p.allActionsReconciled = false; proofs.append(p)
    p = resolution(); p.driverPid = 99; proofs.append(p)
    p = resolution(); p.driverProcessStart = String(repeating: "c", count: 64); proofs.append(p)
    p = resolution(); p.driverGeneration = "other"; proofs.append(p)
    p = resolution(); p.fingerprint = String(repeating: "c", count: 64); proofs.append(p)
    p = resolution(); p.outcome = "unknown"; proofs.append(p)
    p = resolution(); p.observedAt = now.addingTimeInterval(-1); proofs.append(p)
    p = resolution(); p.observedAt = now.addingTimeInterval(10); proofs.append(p)
    for proof in proofs { XCTAssertThrowsError(try store.resolve("controller", leaseId: "lease", value: proof, now: now.addingTimeInterval(2))) }
    XCTAssertEqual(local.unresolvedActions, 1); XCTAssertEqual(store.unresolvedActions, 1)
  }
  func testInterruptedSentinelWriteRepairsTowardUnresolvedOnRestart() throws {
    let root = try folder(), localPath = root.appendingPathComponent("local")
    var local: LocalExecutionStore? = try LocalExecutionStore(folder: localPath); try local!.reserve(lease())
    var store: BackgroundExecutionStore? = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    _ = try store!.reserve(reservation(), lease: lease(), now: now); store = nil; local = nil
    let path = localPath.appendingPathComponent("journal.json")
    var object = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
    object["actions"] = [String: Any]()
    try JSONSerialization.data(withJSONObject: object).write(to: path)
    local = try LocalExecutionStore(folder: localPath)
    store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    XCTAssertEqual(store!.unresolvedActions, 1); XCTAssertEqual(local!.unresolvedActions, 1)
  }
  func testResolutionCrashBeforeSentinelClearRecoversOnlyFromExactDurableProof() throws {
    let root = try folder(), localPath = root.appendingPathComponent("local")
    var local: LocalExecutionStore? = try LocalExecutionStore(folder: localPath); try local!.reserve(lease())
    var store: BackgroundExecutionStore? = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    _ = try store!.reserve(reservation(), lease: lease(), now: now)
    let unresolved = try Data(contentsOf: localPath.appendingPathComponent("journal.json"))
    _ = try store!.resolve("controller", leaseId: "lease", value: resolution(), now: now.addingTimeInterval(2)); store = nil; local = nil
    try unresolved.write(to: localPath.appendingPathComponent("journal.json"))
    local = try LocalExecutionStore(folder: localPath); XCTAssertEqual(local!.unresolvedActions, 1)
    store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local!)
    XCTAssertEqual(store!.unresolvedActions, 0); XCTAssertEqual(local!.unresolvedActions, 0)
  }
  func testStaleInvalidAndConflictingReservationsFailClosed() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local.reserve(lease()); let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    XCTAssertThrowsError(try store.reserve(reservation(), lease: lease(), now: now.addingTimeInterval(3)))
    var v = reservation(); v.driverProcessStart = "pid-only"; XCTAssertThrowsError(try store.reserve(v, lease: lease(), now: now))
    v = reservation(); v.kind = "shell"; XCTAssertThrowsError(try store.reserve(v, lease: lease(), now: now))
    v = reservation(); v.observedAt = now.addingTimeInterval(1); XCTAssertThrowsError(try store.reserve(v, lease: lease(), now: now))
    XCTAssertEqual(local.unresolvedActions, 0)
  }
  func retirement(_ at: Date? = nil) -> BackgroundControllerNavigationRetirement {
    .init(fingerprint: reservation().fingerprint, driverGeneration: "generation", driverPid: 42,
      driverProcessStart: reservation().driverProcessStart, driverQuiescent: true,
      observationId: "retirement-observation", observedAt: at ?? now.addingTimeInterval(1),
      evidence: .init(kind: "codex_new_chat_navigation", sessionId: lease().sessionId, taskId: lease().taskId,
        actionReceiptId: "navigation-action", actionFingerprint: String(repeating: "d", count: 64),
        originalOutcome: "unknown", noReplay: true, noTextOrSubmissionDispatched: true))
  }
  func testOperatorRetirementPreservesUnknownAndDoesNotRearmOrReplay() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local.reserve(lease()); let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    let shared = try DevicePolicy(config: HelperConfig(deviceId: "device", secret: String(repeating: "x", count: 32),
      displays: [.init(displayId: 1, viewers: [], controllers: [])],
      localExecutors: [.init(executorId: "executor", displayId: 1)]))
    let policy = LocalExecutionPolicy(shared: shared); shared.arm()
    try policy.begin(lease(), now: now, available: true, accessibility: true)
    let original = try store.reserve(reservation(), lease: lease(), now: now)
    policy.stop(); shared.stop(disarm: true)
    let later = now.addingTimeInterval(60), proof = retirement(now.addingTimeInterval(59))
    let retired = try store.retireNavigation("controller", leaseId: "lease", value: proof, now: later)
    XCTAssertEqual(retired.state, "retired_unknown_navigation")
    XCTAssertNil(retired.resolution)
    XCTAssertEqual(retired.reservation, original.reservation)
    XCTAssertEqual(retired.retirement?.evidence.originalOutcome, "unknown")
    XCTAssertEqual(local.unresolvedActions, 0); XCTAssertEqual(store.unresolvedActions, 0)
    let sentinel = try local.get(retired.sentinelId, leaseId: "lease")
    XCTAssertEqual(sentinel.state, "unknown")
    XCTAssertEqual(sentinel.evidence, "background_controller_quiescent_retired_unknown_navigation")
    // This is precisely the old helper's unresolved predicate: rollback blocks.
    XCTAssertTrue((sentinel.state != "rejected" || sentinel.evidence != "input_not_dispatched") &&
      (sentinel.state != "submitted" || sentinel.evidence != "post_input_frame_available_not_application_verified"))
    XCTAssertEqual(try store.retireNavigation("controller", leaseId: "lease", value: proof, now: later.addingTimeInterval(90)), retired)
    XCTAssertEqual(try store.existing(reservation(), leaseId: "lease"), retired)
    XCTAssertThrowsError(try store.resolve("controller", leaseId: "lease", value: resolution(later), now: later))
    var changed = proof; changed.evidence.actionReceiptId = "different-action"
    XCTAssertThrowsError(try store.retireNavigation("controller", leaseId: "lease", value: changed, now: later))
    XCTAssertFalse(shared.armed); XCTAssertNil(shared.localSessionOwner); XCTAssertNil(policy.lease)
    XCTAssertThrowsError(try policy.begin(lease(), now: later, available: true, accessibility: true))
  }
  func testRetirementRejectsWrongContextActionClassOrMissingAssurances() throws {
    let root = try folder(), local = try LocalExecutionStore(folder: root.appendingPathComponent("local"))
    try local.reserve(lease()); let store = try BackgroundExecutionStore(folder: root.appendingPathComponent("background"), local: local)
    _ = try store.reserve(reservation(), lease: lease(), now: now)
    var proofs: [BackgroundControllerNavigationRetirement] = []
    var p = retirement(); p.driverQuiescent = false; proofs.append(p)
    p = retirement(); p.evidence.kind = "codex_type"; proofs.append(p)
    p = retirement(); p.evidence.originalOutcome = "completed"; proofs.append(p)
    p = retirement(); p.evidence.noReplay = false; proofs.append(p)
    p = retirement(); p.evidence.noTextOrSubmissionDispatched = false; proofs.append(p)
    p = retirement(); p.evidence.sessionId = "other-session"; proofs.append(p)
    p = retirement(); p.evidence.taskId = "other-task"; proofs.append(p)
    p = retirement(); p.evidence.actionReceiptId = ""; proofs.append(p)
    p = retirement(); p.evidence.actionFingerprint = "invalid"; proofs.append(p)
    p = retirement(); p.driverPid = 99; proofs.append(p)
    p = retirement(); p.driverGeneration = "replacement"; proofs.append(p)
    p = retirement(); p.driverProcessStart = String(repeating: "c", count: 64); proofs.append(p)
    p = retirement(); p.fingerprint = String(repeating: "c", count: 64); proofs.append(p)
    p = retirement(); p.observedAt = now.addingTimeInterval(-1); proofs.append(p)
    p = retirement(); p.observedAt = now.addingTimeInterval(10); proofs.append(p)
    for proof in proofs { XCTAssertThrowsError(try store.retireNavigation("controller", leaseId: "lease", value: proof, now: now.addingTimeInterval(2))) }
    XCTAssertThrowsError(try store.retireNavigation("controller", leaseId: "other-lease", value: retirement(), now: now.addingTimeInterval(2)))
    XCTAssertThrowsError(try store.retireNavigation("other-controller", leaseId: "lease", value: retirement(), now: now.addingTimeInterval(2)))
    var fakeResolution = resolution(); fakeResolution.outcome = "retired_unknown_navigation"
    XCTAssertThrowsError(try store.resolve("controller", leaseId: "lease", value: fakeResolution, now: now.addingTimeInterval(2)))
    XCTAssertEqual(store.unresolvedActions, 1); XCTAssertEqual(local.unresolvedActions, 1)
  }
  func testRetirementCrashRecoveryNeedsDurableProofBeforeLocalExemption() throws {
    let root = try folder(), localPath = root.appendingPathComponent("local"), backgroundPath = root.appendingPathComponent("background")
    var local: LocalExecutionStore? = try LocalExecutionStore(folder: localPath); try local!.reserve(lease())
    var store: BackgroundExecutionStore? = try BackgroundExecutionStore(folder: backgroundPath, local: local!)
    let receipt = try store!.reserve(reservation(), lease: lease(), now: now)
    let unresolved = try Data(contentsOf: localPath.appendingPathComponent("journal.json"))
    _ = try store!.retireNavigation("controller", leaseId: "lease", value: retirement(), now: now.addingTimeInterval(2))
    store = nil; local = nil
    // Simulate crash after background disposition commits, before sentinel changes.
    try unresolved.write(to: localPath.appendingPathComponent("journal.json"))
    local = try LocalExecutionStore(folder: localPath); XCTAssertEqual(local!.unresolvedActions, 1)
    store = try BackgroundExecutionStore(folder: backgroundPath, local: local!)
    XCTAssertEqual(store!.unresolvedActions, 0); XCTAssertEqual(local!.unresolvedActions, 0)
    XCTAssertEqual(try local!.get(receipt.sentinelId, leaseId: "lease").state, "unknown")
    store = nil; local = nil
    // Even the new local reader alone cannot trust the sentinel evidence string.
    local = try LocalExecutionStore(folder: localPath); XCTAssertEqual(local!.unresolvedActions, 1)
    store = try BackgroundExecutionStore(folder: backgroundPath, local: local!)
    XCTAssertEqual(local!.unresolvedActions, 0)
  }
  func testRetiredSentinelCannotOverrideUnresolvedBackgroundJournal() throws {
    let root = try folder(), localPath = root.appendingPathComponent("local"), backgroundPath = root.appendingPathComponent("background")
    var local: LocalExecutionStore? = try LocalExecutionStore(folder: localPath); try local!.reserve(lease())
    var store: BackgroundExecutionStore? = try BackgroundExecutionStore(folder: backgroundPath, local: local!)
    _ = try store!.reserve(reservation(), lease: lease(), now: now)
    let unresolvedBackground = try Data(contentsOf: backgroundPath.appendingPathComponent("journal.json"))
    _ = try store!.retireNavigation("controller", leaseId: "lease", value: retirement(), now: now.addingTimeInterval(2))
    store = nil; local = nil
    try unresolvedBackground.write(to: backgroundPath.appendingPathComponent("journal.json"))
    local = try LocalExecutionStore(folder: localPath)
    XCTAssertThrowsError(try BackgroundExecutionStore(folder: backgroundPath, local: local!))
    XCTAssertEqual(local!.unresolvedActions, 1)
  }

}
