import CryptoKit
import Darwin
import Foundation

struct LegacyOwnershipEvidence: Codable, Equatable {
  let leaseState: String
  let callState: String
  let executorState: String
  let releaseEvidenceId: String
  let callEndEvidenceId: String
  let evidenceSHA256: String
  let leaseExpiresAt: Double?
}
struct LegacyObservationEvidence: Codable, Equatable {
  let actionId: String
  let leaseId: String
  let afterFrameId: String
  let capturedAt: Double
}
struct LegacyReceiptAuditEntry: Codable, Equatable {
  let id: String
  let leaseId: String
  let deviceId: String
  let memberId: String
  let callId: String
  let fingerprint: String
  let ownership: LegacyOwnershipEvidence
  let observation: LegacyObservationEvidence?
}
struct LegacyReceiptAudit: Codable {
  let schemaVersion: Int
  let auditId: String
  let deviceId: String
  let sourceSnapshotProtocol: Int
  let preUpgradeSnapshotSHA256: String
  let expectedCurrentJournalSHA256: String
  let createdAt: Double
  let helperStopped: Bool
  let conflictingActorsStopped: Bool
  let currentOwnershipIdle: Bool
  let receipts: [LegacyReceiptAuditEntry]
}
struct LegacyReceiptRetirement: Codable, Equatable {
  let receipt: LegacyReceiptAuditEntry
  let recordSHA256: String
  let auditId: String
  let auditSHA256: String
  let snapshotSHA256: String
  let journalSHA256: String
  let reconciledAt: Double
}
struct LegacyReceiptReconciliationLedger: Codable {
  var schemaVersion = 1
  var deviceId: String
  var audits: [String: String] = [:]
  var retirements: [String: LegacyReceiptRetirement] = [:]
}
public struct LegacyReceiptReconciliationReport: Codable {
  public let dryRun: Bool
  public let alreadyApplied: Bool
  public let reconciledCount: Int
  public let historicalObservedCount: Int
  public let historicalUnverifiedCount: Int
  public let remainingBlockingCount: Int
  public let originalJournalUnchanged: Bool
}

/// Offline-only operator migration. It adds provenance; it never rewrites an input
/// receipt, infers UI success, replays input, changes policy or arms the device.
enum LegacyReceiptReconciliation {
  static let maximumBytes = 16 * 1024 * 1024
  static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  static func validDigest(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
  }
  static func url(for journal: URL) -> URL {
    journal.deletingLastPathComponent().appendingPathComponent("receipts-reconciliation.json")
  }
  /// Read the exact validated descriptor. Neither links nor permissive files are accepted.
  static func privateData(_ url: URL, optional: Bool = false) throws -> Data? {
    let parent = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parent >= 0 else { throw HelperError(403, "Private reconciliation directory unavailable.") }
    defer { close(parent) }
    var folder = stat()
    guard fstat(parent, &folder) == 0, folder.st_uid == getuid(), folder.st_mode & 0o777 == 0o700 else {
      throw HelperError(403, "Reconciliation directories must be owner-only with mode 0700.")
    }
    let file = openat(parent, url.lastPathComponent, O_RDONLY | O_NOFOLLOW)
    if file < 0 && optional && errno == ENOENT { return nil }
    guard file >= 0 else { throw HelperError(403, "Private reconciliation file unavailable.") }
    defer { close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
      info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= maximumBytes else {
      throw HelperError(403, "Reconciliation files must be bounded owner-only regular files.")
    }
    let data = try FileHandle(fileDescriptor: file, closeOnDealloc: false).readToEnd() ?? Data()
    guard data.count <= maximumBytes else { throw HelperError(413, "Reconciliation data exceeds its limit.") }
    return data
  }
  static func recordDigests(_ data: Data) throws -> [String: String] {
    guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any], raw.count <= 10000 else {
      throw HelperError(400, "Receipt snapshot is not a bounded journal.")
    }
    var digests: [String: String] = [:]
    for (id, record) in raw {
      guard validID(id), record is [String: Any] else { throw HelperError(400, "Invalid receipt snapshot record.") }
      digests[id] = sha256(try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]))
    }
    return digests
  }
  static func load(journal: URL, data: Data, deviceId: String? = nil) throws -> LegacyReceiptReconciliationLedger? {
    guard let saved = try privateData(url(for: journal), optional: true) else { return nil }
    let ledger = try JSONDecoder().decode(LegacyReceiptReconciliationLedger.self, from: saved)
    let records = try JSONDecoder().decode([String: ActionReceipt].self, from: data)
    let digests = try recordDigests(data)
    guard ledger.schemaVersion == 1, validID(ledger.deviceId), deviceId == nil || deviceId == ledger.deviceId,
      ledger.retirements.count <= 10000, ledger.audits.count <= 10000 else {
      throw HelperError(409, "Reconciliation ledger binding is invalid.")
    }
    for (id, retirement) in ledger.retirements {
      guard let receipt = records[id], retirement.receipt.id == id,
        retirement.recordSHA256 == digests[id], receipt.deviceId == ledger.deviceId,
        receipt.state == "submitted", receipt.protocolVersion == nil || receipt.protocolVersion == 1,
        ledger.audits[retirement.auditId] == retirement.auditSHA256,
        validDigest(retirement.auditSHA256), validDigest(retirement.snapshotSHA256),
        validDigest(retirement.journalSHA256) else {
        throw HelperError(409, "A reconciled receipt changed; preserve evidence and review it.")
      }
      try validateEntry(retirement.receipt, receipt: receipt, auditTime: retirement.reconciledAt)
    }
    return ledger
  }
  static func validateEntry(_ entry: LegacyReceiptAuditEntry, receipt: ActionReceipt, auditTime: Double) throws {
    let ownership = entry.ownership
    guard [entry.id, entry.leaseId, entry.deviceId, entry.memberId, entry.callId,
           ownership.releaseEvidenceId, ownership.callEndEvidenceId].allSatisfy(validID),
      entry.id == receipt.id, entry.leaseId == receipt.leaseId, entry.deviceId == receipt.deviceId,
      entry.memberId == receipt.memberId, entry.callId == receipt.callId, entry.fingerprint == receipt.fingerprint,
      validDigest(entry.fingerprint), validDigest(ownership.evidenceSHA256),
      receipt.state == "submitted", receipt.protocolVersion == nil || receipt.protocolVersion == 1,
      receipt.updatedAt.timeIntervalSince1970 * 1000 <= auditTime,
      ownership.callState == "ended", ownership.executorState == "none",
      ["released", "expired"].contains(ownership.leaseState) else {
      throw HelperError(409, "Receipt or ownership evidence is not eligible for legacy reconciliation.")
    }
    if ownership.leaseState == "expired" {
      guard let expiry = ownership.leaseExpiresAt, expiry.isFinite, expiry > 0, expiry <= auditTime else {
        throw HelperError(409, "Expired ownership requires its exact past lease expiry.")
      }
    }
    if let observation = entry.observation {
      guard observation.actionId == entry.id, observation.leaseId == entry.leaseId,
        validID(observation.afterFrameId), observation.capturedAt.isFinite,
        observation.capturedAt >= receipt.updatedAt.timeIntervalSince1970 * 1000,
        observation.capturedAt <= auditTime else {
        throw HelperError(409, "Backend observation does not match this submitted input.")
      }
    }
  }
  static func persist(_ ledger: LegacyReceiptReconciliationLedger, at url: URL) throws {
    let parent = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parent >= 0 else { throw HelperError(503, "Cannot open reconciliation directory.") }
    defer { close(parent) }
    let temporary = ".reconciliation-" + UUID().uuidString
    let file = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard file >= 0 else { throw HelperError(503, "Cannot save reconciliation audit.") }
    defer { close(file); unlinkat(parent, temporary, 0) }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(ledger)
    guard data.count <= maximumBytes else { throw HelperError(413, "Reconciliation ledger exceeds its limit.") }
    try data.withUnsafeBytes { raw in
      var offset = 0
      while offset < data.count {
        let count = write(file, raw.baseAddress!.advanced(by: offset), data.count - offset)
        guard count > 0 else { throw HelperError(503, "Cannot persist reconciliation audit.") }
        offset += count
      }
    }
    guard fsync(file) == 0, renameat(parent, temporary, parent, url.lastPathComponent) == 0,
      fsync(parent) == 0 else { throw HelperError(503, "Cannot commit reconciliation audit.") }
  }
}

extension ReceiptStore {
  /// Requires a trusted lead-prepared audit and exact private pre-upgrade snapshot.
  /// The ledger lock is the same one held by the running helper, so this cannot
  /// migrate a live helper. Attestations describe externally verified ownership;
  /// this offline tool does not independently query any backend or native client.
  public static func reconcileLegacy(
    journal: URL, snapshot: URL, audit: URL, deviceId: String, dryRun: Bool = false, now: Date = Date()
  ) throws -> LegacyReceiptReconciliationReport {
    guard validID(deviceId), Set([journal.standardizedFileURL.path, snapshot.standardizedFileURL.path,
                                 audit.standardizedFileURL.path, LegacyReceiptReconciliation.url(for: journal).path]).count == 4 else {
      throw HelperError(400, "Use distinct journal, snapshot and audit paths.")
    }
    let lock = try ReceiptLock(folder: journal.deletingLastPathComponent())
    return try withExtendedLifetime(lock) {
      let current = try LegacyReceiptReconciliation.privateData(journal)!
      let baseline = try LegacyReceiptReconciliation.privateData(snapshot)!
      let auditData = try LegacyReceiptReconciliation.privateData(audit)!
      let plan = try JSONDecoder().decode(LegacyReceiptAudit.self, from: auditData)
      let digest = LegacyReceiptReconciliation.sha256
      guard plan.schemaVersion == 1, validID(plan.auditId), plan.deviceId == deviceId,
        plan.sourceSnapshotProtocol == 1, plan.helperStopped, plan.conflictingActorsStopped,
        plan.currentOwnershipIdle, plan.createdAt.isFinite, plan.createdAt > 0,
        plan.createdAt <= now.timeIntervalSince1970 * 1000 + 1000,
        plan.preUpgradeSnapshotSHA256 == digest(baseline), plan.expectedCurrentJournalSHA256 == digest(current),
        !plan.receipts.isEmpty, plan.receipts.count <= 10000,
        Set(plan.receipts.map(\.id)).count == plan.receipts.count else {
        throw HelperError(409, "Legacy audit or exact snapshot binding is invalid.")
      }
      let receipts = try JSONDecoder().decode([String: ActionReceipt].self, from: current)
      let old = try JSONDecoder().decode([String: ActionReceipt].self, from: baseline)
      let currentHashes = try LegacyReceiptReconciliation.recordDigests(current)
      let oldHashes = try LegacyReceiptReconciliation.recordDigests(baseline)
      guard receipts.values.allSatisfy({ $0.state != "dispatching" && $0.state != "unknown" }) else {
        throw HelperError(409, "Pending or unknown input must be reconciled separately; no migration performed.")
      }
      var ledger = try LegacyReceiptReconciliation.load(journal: journal, data: current, deviceId: deviceId)
        ?? LegacyReceiptReconciliationLedger(deviceId: deviceId)
      let auditHash = digest(auditData)
      let alreadyApplied = ledger.audits[plan.auditId] != nil
      guard alreadyApplied || now.timeIntervalSince1970 * 1000 - plan.createdAt <= 15 * 60 * 1000 else {
        throw HelperError(409, "Ownership audit is stale; inspect current ownership and prepare a fresh audit.")
      }
      if let prior = ledger.audits[plan.auditId], prior != auditHash {
        throw HelperError(409, "Audit identity already belongs to different evidence.")
      }
      for entry in plan.receipts {
        guard let receipt = receipts[entry.id], old[entry.id] != nil,
          currentHashes[entry.id] == oldHashes[entry.id], entry.deviceId == deviceId else {
          throw HelperError(409, "Selected receipt differs from the pre-upgrade snapshot.")
        }
        try LegacyReceiptReconciliation.validateEntry(entry, receipt: receipt, auditTime: plan.createdAt)
        let retirement = LegacyReceiptRetirement(receipt: entry, recordSHA256: currentHashes[entry.id]!,
          auditId: plan.auditId, auditSHA256: auditHash, snapshotSHA256: plan.preUpgradeSnapshotSHA256,
          journalSHA256: plan.expectedCurrentJournalSHA256, reconciledAt: plan.createdAt)
        if let prior = ledger.retirements[entry.id], prior != retirement {
          throw HelperError(409, "Receipt already has a different reconciliation; preserve its audit.")
        }
        ledger.retirements[entry.id] = retirement
      }
      ledger.audits[plan.auditId] = auditHash
      // Detect a changed input even if an external editor ignored the helper lock.
      guard try LegacyReceiptReconciliation.privateData(journal) == current,
        try LegacyReceiptReconciliation.privateData(snapshot) == baseline,
        try LegacyReceiptReconciliation.privateData(audit) == auditData else {
        throw HelperError(409, "Evidence changed during reconciliation.")
      }
      if !dryRun && !alreadyApplied {
        try LegacyReceiptReconciliation.persist(ledger, at: LegacyReceiptReconciliation.url(for: journal))
      }
      let blocking = receipts.values.filter {
        $0.state == "dispatching" || $0.state == "unknown"
          || ($0.state == "submitted" && $0.evidence != "post_input_frame_available_not_application_verified"
              && ledger.retirements[$0.id] == nil)
      }.count
      return LegacyReceiptReconciliationReport(dryRun: dryRun, alreadyApplied: alreadyApplied,
        reconciledCount: plan.receipts.count,
        historicalObservedCount: ledger.retirements.values.filter { $0.receipt.observation != nil }.count,
        historicalUnverifiedCount: ledger.retirements.values.filter { $0.receipt.observation == nil }.count,
        remainingBlockingCount: blocking, originalJournalUnchanged: true)
    }
  }
}
