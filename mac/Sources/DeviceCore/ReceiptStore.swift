import Darwin
import Foundation

final class ReceiptLock {
  let descriptor: Int32
  init(folder: URL) throws {
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let candidate = open(
      folder.appendingPathComponent("receipts.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard candidate >= 0 else { throw HelperError(503, "Unable to lock the action ledger.") }
    guard flock(candidate, LOCK_EX | LOCK_NB) == 0 else {
      close(candidate)
      throw HelperError(409, "Another helper already owns this device's action ledger.")
    }
    descriptor = candidate
  }
  deinit {
    flock(descriptor, LOCK_UN)
    close(descriptor)
  }
}

public struct ActionReceipt: Codable {
  public var id: String
  public var leaseId: String
  public var deviceId: String
  public var memberId: String
  public var callId: String
  public var fingerprint: String
  public var state: String
  public var updatedAt: Date
  public var evidence: String?
  public var protocolVersion: Int? = nil
}
public final class ReceiptStore {
  private let url: URL
  private let lock: ReceiptLock
  private var receipts: [String: ActionReceipt]
  private var reconciliation: LegacyReceiptReconciliationLedger?
  private var frozenReceipts: [String: Any] = [:]
  public init(url: URL) throws {
    self.url = url
    lock = try ReceiptLock(folder: url.deletingLastPathComponent())
    let original = FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
    if let original {
      receipts = try JSONDecoder().decode([String: ActionReceipt].self, from: original)
      reconciliation = try LegacyReceiptReconciliation.load(journal: url, data: original)
      if let reconciliation {
        let raw = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        frozenReceipts = raw.filter { reconciliation.retirements[$0.key] != nil }
      }
    } else {
      receipts = [:]
      reconciliation = nil
      guard try LegacyReceiptReconciliation.privateData(LegacyReceiptReconciliation.url(for: url), optional: true) == nil else {
        throw HelperError(409, "Reconciliation exists without its original receipt journal.")
      }
    }
    var recovered = false
    for (id, var receipt) in receipts where receipt.state == "dispatching" {
      receipt.state = "unknown"
      receipt.updatedAt = Date()
      receipt.evidence = "process_interrupted"
      receipts[id] = receipt
      recovered = true
    }
    // Reading an unchanged historical ledger must preserve its original bytes.
    if original == nil || recovered { try persist() }
  }
  private func persist() throws {
    let folder = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = folder.appendingPathComponent(".receipts-" + UUID().uuidString)
    var data = try JSONEncoder().encode(receipts)
    if !frozenReceipts.isEmpty {
      var raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      for (id, original) in frozenReceipts { raw[id] = original }
      data = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
    }
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw HelperError(503, "Unable to open durable action ledger.") }
    defer {
      close(fd)
      unlink(temporary.path)
    }
    try data.withUnsafeBytes { raw in
      var offset = 0
      while offset < data.count {
        let count = write(fd, raw.baseAddress!.advanced(by: offset), data.count - offset)
        guard count > 0 else { throw HelperError(503, "Unable to persist action ledger.") }
        offset += count
      }
    }
    guard fsync(fd) == 0, rename(temporary.path, url.path) == 0 else {
      throw HelperError(503, "Unable to commit action ledger.")
    }
    let directory = open(folder.path, O_RDONLY)
    if directory >= 0 {
      defer { close(directory) }
      guard fsync(directory) == 0 else {
        throw HelperError(503, "Unable to sync action ledger directory.")
      }
    }
  }
  public var unresolvedActionCount: Int {
    receipts.values.filter {
      $0.state == "dispatching" || $0.state == "unknown"
        || ($0.state == "submitted" && $0.evidence != "post_input_frame_available_not_application_verified"
            && reconciliation?.retirements[$0.id] == nil)
    }.count
  }
  public var historicalObservedActionCount: Int {
    reconciliation?.retirements.values.filter { $0.receipt.observation != nil }.count ?? 0
  }
  public var historicalUnverifiedActionCount: Int {
    reconciliation?.retirements.values.filter { $0.receipt.observation == nil }.count ?? 0
  }
  public func isHistoricallyRetiredLease(_ id: String) -> Bool {
    reconciliation?.retirements.values.contains { $0.receipt.leaseId == id } ?? false
  }
  /// A fresh post-input frame establishes observation availability, never UI success.
  public func observedFrame(leaseId: String, capturedAt: Date) throws {
    var changed = false
    for (id, var receipt) in receipts where receipt.leaseId == leaseId
      && receipt.state == "submitted" && receipt.updatedAt <= capturedAt
      && reconciliation?.retirements[id] == nil
      && receipt.evidence != "post_input_frame_available_not_application_verified" {
      receipt.evidence = "post_input_frame_available_not_application_verified"
      receipts[id] = receipt
      changed = true
    }
    if changed { try persist() }
  }
  public func get(_ id: String, leaseId: String) throws -> ActionReceipt {
    guard let result = receipts[id], result.leaseId == leaseId else {
      throw HelperError(404, "Receipt not found for this lease.")
    }
    return result
  }
  public func existing(_ action: InputAction, leaseId: String) throws -> ActionReceipt? {
    guard let result = receipts[action.id] else { return nil }
    guard result.leaseId == leaseId, result.fingerprint == (try fingerprint(action)) else {
      throw HelperError(409, "Action ID conflicts with a retained receipt.")
    }
    return result
  }
  public func begin(_ action: InputAction, lease: Lease, now: Date) throws -> ActionReceipt {
    guard receipts[action.id] == nil else {
      throw HelperError(409, "Action already has a receipt; reconcile without replay.")
    }
    guard receipts.count < 10000 else {
      throw HelperError(
        503, "Action ledger is full. Preserve and archive receipts before accepting more input.")
    }
    let receipt = ActionReceipt(
      id: action.id, leaseId: lease.id, deviceId: lease.deviceId, memberId: lease.memberId,
      callId: lease.callId, fingerprint: try fingerprint(action), state: "dispatching",
      updatedAt: now, protocolVersion: lease.protocolVersion)
    receipts[action.id] = receipt
    try persist()
    return receipt
  }
  public func finish(_ id: String, state: String, evidence: String, now: Date) throws
    -> ActionReceipt
  {
    guard var receipt = receipts[id], receipt.state == "dispatching",
      ["submitted", "unknown"].contains(state)
    else { throw HelperError(409, "Receipt cannot transition.") }
    receipt.state = state
    receipt.updatedAt = now
    receipt.evidence = evidence
    receipts[id] = receipt
    try persist()
    return receipt
  }
}
