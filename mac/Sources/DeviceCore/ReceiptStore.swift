import Darwin
import Foundation

private final class ReceiptLock {
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
}
public final class ReceiptStore {
  private let url: URL
  private let lock: ReceiptLock
  private var receipts: [String: ActionReceipt]
  public init(url: URL) throws {
    self.url = url
    lock = try ReceiptLock(folder: url.deletingLastPathComponent())
    if FileManager.default.fileExists(atPath: url.path) {
      receipts = try JSONDecoder().decode([String: ActionReceipt].self, from: Data(contentsOf: url))
    } else {
      receipts = [:]
    }
    for (id, var receipt) in receipts where receipt.state == "dispatching" {
      receipt.state = "unknown"
      receipt.updatedAt = Date()
      receipt.evidence = "process_interrupted"
      receipts[id] = receipt
    }
    try persist()
  }
  private func persist() throws {
    let folder = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = folder.appendingPathComponent(".receipts-" + UUID().uuidString)
    let data = try JSONEncoder().encode(receipts)
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
      updatedAt: now)
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
