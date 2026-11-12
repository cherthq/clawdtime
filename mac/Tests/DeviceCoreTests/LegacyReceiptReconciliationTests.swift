import XCTest
@testable import DeviceCore

final class LegacyReceiptReconciliationTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  var folder: URL!
  var journal: URL { folder.appendingPathComponent("action-receipts.json") }
  var snapshot: URL { folder.appendingPathComponent("before-upgrade.json") }
  var audit: URL { folder.appendingPathComponent("audit.json") }
  var sidecar: URL { folder.appendingPathComponent("receipts-reconciliation.json") }

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var records: [String: ActionReceipt] = [:]
    for id in ["observed", "unverified", "omitted"] {
      records[id] = ActionReceipt(id: id, leaseId: "lease-" + id, deviceId: "device", memberId: "person",
        callId: "call-" + id, fingerprint: String(repeating: "a", count: 64), state: "submitted",
        updatedAt: now.addingTimeInterval(-60), evidence: "cg_event_posted_not_application_verified")
    }
    let data = try JSONEncoder().encode(records)
    try save(data, at: journal); try save(data, at: snapshot)
    try saveAudit()
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: folder) }
  func save(_ data: Data, at path: URL) throws {
    try data.write(to: path)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
  }
  func entry(_ id: String, observed: Bool = false, expired: Bool = false) -> LegacyReceiptAuditEntry {
    LegacyReceiptAuditEntry(id: id, leaseId: "lease-" + id, deviceId: "device", memberId: "person",
      callId: "call-" + id, fingerprint: String(repeating: "a", count: 64),
      ownership: LegacyOwnershipEvidence(leaseState: expired ? "expired" : "released", callState: "ended",
        executorState: "none", releaseEvidenceId: "release-" + id, callEndEvidenceId: "end-" + id,
        evidenceSHA256: String(repeating: "b", count: 64),
        leaseExpiresAt: expired ? now.addingTimeInterval(-30).timeIntervalSince1970 * 1000 : nil),
      observation: observed ? LegacyObservationEvidence(actionId: id, leaseId: "lease-" + id,
        afterFrameId: "frame-after", capturedAt: now.addingTimeInterval(-40).timeIntervalSince1970 * 1000) : nil)
  }
  func saveAudit(entries: [LegacyReceiptAuditEntry]? = nil) throws {
    let value = LegacyReceiptAudit(schemaVersion: 1, auditId: "audit-fixture", deviceId: "device",
      sourceSnapshotProtocol: 1, preUpgradeSnapshotSHA256: LegacyReceiptReconciliation.sha256(try Data(contentsOf: snapshot)),
      expectedCurrentJournalSHA256: LegacyReceiptReconciliation.sha256(try Data(contentsOf: journal)),
      createdAt: now.timeIntervalSince1970 * 1000, helperStopped: true, conflictingActorsStopped: true,
      currentOwnershipIdle: true, receipts: entries ?? [entry("observed", observed: true), entry("unverified", expired: true)])
    try save(JSONEncoder().encode(value), at: audit)
  }
  func modifyJSON(_ path: URL, _ edit: (inout [String: Any]) -> Void) throws {
    var raw = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
    edit(&raw)
    try save(JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys]), at: path)
  }
  @discardableResult func migrate(dryRun: Bool = false, at: Date? = nil) throws -> LegacyReceiptReconciliationReport {
    try ReceiptStore.reconcileLegacy(journal: journal, snapshot: snapshot, audit: audit,
      deviceId: "device", dryRun: dryRun, now: at ?? now)
  }

  func testDryRunAndPartialApplyPreserveOriginalBytesAndTruthfulCounts() throws {
    let before = try Data(contentsOf: journal)
    let planned = try migrate(dryRun: true)
    XCTAssertEqual(planned.reconciledCount, 2)
    XCTAssertEqual(planned.historicalObservedCount, 1)
    XCTAssertEqual(planned.historicalUnverifiedCount, 1)
    XCTAssertEqual(planned.remainingBlockingCount, 1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    XCTAssertEqual(try Data(contentsOf: journal), before)
    let applied = try migrate()
    XCTAssertTrue(applied.originalJournalUnchanged)
    XCTAssertEqual(try Data(contentsOf: journal), before)
    let persisted = try Data(contentsOf: sidecar)
    let repeatResult = try migrate(at: now.addingTimeInterval(3600))
    XCTAssertTrue(repeatResult.alreadyApplied)
    XCTAssertEqual(try Data(contentsOf: sidecar), persisted)
    do {
      let ledger = try ReceiptStore(url: journal)
      XCTAssertEqual(ledger.unresolvedActionCount, 1)
      XCTAssertEqual(ledger.historicalObservedActionCount, 1)
      XCTAssertEqual(ledger.historicalUnverifiedActionCount, 1)
      XCTAssertTrue(ledger.isHistoricallyRetiredLease("lease-unverified"))
      XCTAssertFalse(ledger.isHistoricallyRetiredLease("lease-omitted"))
      XCTAssertEqual(try ledger.get("observed", leaseId: "lease-observed").state, "submitted")
      XCTAssertEqual(try ledger.get("observed", leaseId: "lease-observed").evidence, "cg_event_posted_not_application_verified")
      // A new observation must not rewrite a frozen historical receipt.
      try ledger.observedFrame(leaseId: "lease-unverified", capturedAt: now)
      XCTAssertEqual(ledger.historicalUnverifiedActionCount, 1)
    }
    XCTAssertEqual(try Data(contentsOf: journal), before)
    XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: sidecar.path)[.posixPermissions] as! NSNumber).intValue, 0o600)
  }

  func testNoReplayAndFrozenRawFieldsSurviveNewV2WritesAndRestart() throws {
    for path in [journal, snapshot] {
      try modifyJSON(path) { value in
        var receipt = value["observed"] as! [String: Any]
        receipt["historicalExtension"] = ["retained": true, "detail": "synthetic"]
        value["observed"] = receipt
      }
    }
    try saveAudit()
    try migrate()
    let originalHashes = try LegacyReceiptReconciliation.recordDigests(Data(contentsOf: journal))
    do {
      let ledger = try ReceiptStore(url: journal)
      let action = InputAction(id: "new-v2", frameId: "new-frame", type: "click", x: 0.4, y: 0.3,
        executorEpoch: 1, policyRevision: 1, sessionId: "new-session")
      let lease = Lease(id: "new-lease", deviceId: "device", memberId: "person", callId: "new-call", displayId: 1,
        mode: "control", expiresAt: now.addingTimeInterval(20), protocolVersion: 2,
        sessionId: "new-session", executorEpoch: 1, policyRevision: 1, executor: "clawdtime")
      XCTAssertThrowsError(try ledger.begin(InputAction(id: "observed", frameId: "different", type: "click", x: 0, y: 0), lease: lease, now: now))
      _ = try ledger.begin(action, lease: lease, now: now)
      _ = try ledger.finish(action.id, state: "submitted", evidence: "cg_event_posted_not_application_verified", now: now)
      XCTAssertEqual(try ledger.get(action.id, leaseId: lease.id).protocolVersion, 2)
    }
    let afterHashes = try LegacyReceiptReconciliation.recordDigests(Data(contentsOf: journal))
    XCTAssertEqual(afterHashes["observed"], originalHashes["observed"])
    XCTAssertEqual(afterHashes["unverified"], originalHashes["unverified"])
    let restarted = try ReceiptStore(url: journal)
    XCTAssertEqual(restarted.unresolvedActionCount, 2)
    XCTAssertEqual(restarted.historicalObservedActionCount, 1)
    XCTAssertEqual(restarted.historicalUnverifiedActionCount, 1)
  }

  func testLiveHelperLockRefusesOfflineMigration() throws {
    let ledger = try ReceiptStore(url: journal)
    try withExtendedLifetime(ledger) { XCTAssertThrowsError(try migrate()) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
  }

  func testCurrentOrUnknownInputCannotBeRetired() throws {
    let original = try Data(contentsOf: journal)
    for state in ["dispatching", "unknown"] {
      try save(original, at: journal)
      try modifyJSON(journal) { value in
        var receipt = value["omitted"] as! [String: Any]; receipt["state"] = state; value["omitted"] = receipt
      }
      try saveAudit()
      XCTAssertThrowsError(try migrate())
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    }
    try save(original, at: journal)
    for path in [journal, snapshot] {
      try modifyJSON(path) { value in
        var receipt = value["observed"] as! [String: Any]; receipt["protocolVersion"] = 2; value["observed"] = receipt
      }
    }
    try saveAudit()
    XCTAssertThrowsError(try migrate())
  }

  func testExactSnapshotAndFullReceiptFieldsAreRequired() throws {
    let original = try Data(contentsOf: journal)
    try save(original + Data("\n".utf8), at: journal)
    XCTAssertThrowsError(try migrate()) // even whitespace changes the exact journal digest
    for field in ["evidence", "updatedAt", "memberId", "unexpected"] {
      try save(original, at: journal)
      try modifyJSON(journal) { value in
        var receipt = value["observed"] as! [String: Any]
        receipt[field] = field == "updatedAt" ? NSNumber(value: 1) : "changed"
        value["observed"] = receipt
      }
      try saveAudit() // a new current digest cannot hide a baseline receipt mismatch
      XCTAssertThrowsError(try migrate())
    }
  }

  func testAuditCannotAssertActiveOwnershipOrFalseIdleAttestation() throws {
    for flag in ["helperStopped", "conflictingActorsStopped", "currentOwnershipIdle"] {
      try saveAudit(); try modifyJSON(audit) { $0[flag] = false }
      XCTAssertThrowsError(try migrate())
    }
    for (field, state) in [("leaseState", "active"), ("callState", "connected"), ("executorState", "native")] {
      try saveAudit()
      try modifyJSON(audit) { value in
        var entries = value["receipts"] as! [[String: Any]]
        var ownership = entries[0]["ownership"] as! [String: Any]
        ownership[field] = state; entries[0]["ownership"] = ownership; value["receipts"] = entries
      }
      XCTAssertThrowsError(try migrate())
    }
  }

  func testMissingClosureOrWrongObservationCannotInventSuccess() throws {
    for change in ["missingEvidence", "futureExpiry", "wrongAction", "oldFrame", "wrongMember", "duplicate"] {
      try saveAudit()
      try modifyJSON(audit) { value in
        var entries = value["receipts"] as! [[String: Any]]
        if change == "missingEvidence" {
          var ownership = entries[0]["ownership"] as! [String: Any]
          ownership.removeValue(forKey: "evidenceSHA256"); entries[0]["ownership"] = ownership
        } else if change == "futureExpiry" {
          var ownership = entries[1]["ownership"] as! [String: Any]
          ownership["leaseExpiresAt"] = self.now.addingTimeInterval(10).timeIntervalSince1970 * 1000
          entries[1]["ownership"] = ownership
        } else if change == "wrongMember" { entries[0]["memberId"] = "someone-else" }
        else if change == "duplicate" { entries.append(entries[0]) }
        else {
          var observation = entries[0]["observation"] as! [String: Any]
          if change == "wrongAction" { observation["actionId"] = "other" }
          else { observation["capturedAt"] = self.now.addingTimeInterval(-90).timeIntervalSince1970 * 1000 }
          entries[0]["observation"] = observation
        }
        value["receipts"] = entries
      }
      XCTAssertThrowsError(try migrate())
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    }
  }

  func testStaleFirstAuditAndConflictingAppliedAuditAreRefused() throws {
    XCTAssertThrowsError(try migrate(at: now.addingTimeInterval(901)))
    try migrate()
    let saved = try Data(contentsOf: sidecar)
    try modifyJSON(audit) { $0["createdAt"] = self.now.addingTimeInterval(-1).timeIntervalSince1970 * 1000 }
    XCTAssertThrowsError(try migrate())
    XCTAssertEqual(try Data(contentsOf: sidecar), saved)
  }

  func testPrivatePathsAndChangedRetiredRecordsFailClosed() throws {
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: audit.path)
    XCTAssertThrowsError(try migrate())
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: audit.path)
    let savedSnapshot = folder.appendingPathComponent("saved-snapshot.json")
    try FileManager.default.moveItem(at: snapshot, to: savedSnapshot)
    try FileManager.default.createSymbolicLink(at: snapshot, withDestinationURL: savedSnapshot)
    XCTAssertThrowsError(try migrate())
    try FileManager.default.removeItem(at: snapshot)
    try FileManager.default.moveItem(at: savedSnapshot, to: snapshot)
    try migrate()
    try modifyJSON(journal) { value in
      var receipt = value["observed"] as! [String: Any]; receipt["state"] = "unknown"; value["observed"] = receipt
    }
    XCTAssertThrowsError(try ReceiptStore(url: journal))
  }
}
