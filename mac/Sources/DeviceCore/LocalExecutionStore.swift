import Darwin
import Foundation

public struct LocalActionReceipt: Codable, Equatable {
  public let id: String
  public let leaseId: String
  public let deviceId: String
  public let sessionId: String
  public let taskId: String
  public let executorId: String
  public let executorEpoch: Int
  public let policyRevision: Int
  public let fingerprint: String
  public var state: String
  public var updatedAt: Date
  public var evidence: String
}

/// Private metadata only: hashes and receipts, never screenshots or typed text.
/// A session ID is durably reserved before use and cannot be resurrected on restart.
public final class LocalExecutionStore {
  private struct Journal: Codable {
    var sessions: [String: String] = [:]
    var actions: [String: LocalActionReceipt] = [:]
  }
  private var journal: Journal
  private let lock: ReceiptLock
  private let directory: Int32
  private var failed = false
  public init(folder: URL) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let descriptor = open(folder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError(403, "Local receipt directory unavailable.") }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
      close(descriptor); throw HelperError(403, "Local receipt directory must be private.")
    }
    do {
      lock = try ReceiptLock(folder: folder)
      let file = openat(descriptor, "journal.json", O_RDONLY | O_NOFOLLOW)
      if file >= 0 {
        defer { close(file) }
        var metadata = stat()
        guard fstat(file, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_mode & 0o777 == 0o600, metadata.st_size <= 16 * 1024 * 1024 else {
          throw HelperError(403, "Local journal must be a bounded private regular file.")
        }
        let data = try FileHandle(fileDescriptor: file, closeOnDealloc: false).readToEnd() ?? Data()
        guard data.count <= 16 * 1024 * 1024 else { throw HelperError(413, "Local journal exceeds its limit.") }
        journal = try JSONDecoder().decode(Journal.self, from: data)
      } else {
        guard errno == ENOENT else { throw HelperError(403, "Local journal unavailable.") }
        journal = Journal()
      }
      let sessionIds = Set(journal.sessions.keys)
      guard journal.sessions.count <= 10000, journal.actions.count <= 10000,
        journal.sessions.keys.allSatisfy(validID), journal.actions.allSatisfy({ id, receipt in
          id == receipt.id && validID(id) && sessionIds.contains(receipt.leaseId) &&
            ["dispatching", "submitted", "unknown"].contains(receipt.state)
        }) else { throw HelperError(409, "Local journal is invalid.") }
    } catch { close(descriptor); throw error }
    directory = descriptor
    for (id, var receipt) in journal.actions where receipt.state == "dispatching" {
      receipt.state = "unknown"; receipt.evidence = "process_interrupted"; receipt.updatedAt = Date()
      journal.actions[id] = receipt
    }
    try persist()
  }
  deinit { close(directory) }
  private func persist() throws {
    guard !failed else { throw HelperError(503, "Local receipt storage needs reconciliation.") }
    do {
      let data = try JSONEncoder().encode(journal)
      guard data.count <= 16 * 1024 * 1024 else { throw HelperError(503, "Local journal is full.") }
      let temporary = ".journal-" + UUID().uuidString
      let file = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      guard file >= 0 else { throw HelperError(503, "Cannot reserve local receipt.") }
      defer { close(file); unlinkat(directory, temporary, 0) }
      try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < data.count {
          let count = write(file, bytes.baseAddress!.advanced(by: offset), data.count - offset)
          guard count > 0 else { throw HelperError(503, "Cannot persist local receipt.") }
          offset += count
        }
      }
      guard fsync(file) == 0, renameat(directory, temporary, directory, "journal.json") == 0,
        fsync(directory) == 0 else { throw HelperError(503, "Cannot commit local receipt.") }
    } catch { failed = true; throw error }
  }
  public var unresolvedActions: Int {
    max(failed ? 1 : 0, journal.actions.values.filter {
      $0.state != "submitted" || $0.evidence != "post_input_frame_available_not_application_verified"
    }.count)
  }
  public func used(_ id: String) -> Bool { journal.sessions[id] != nil }
  public func reserve(_ lease: LocalExecutionLease) throws {
    guard !failed, journal.sessions[lease.id] == nil, journal.sessions.count < 10000 else {
      throw HelperError(409, "Local session was already reserved or storage is unavailable.")
    }
    journal.sessions[lease.id] = try fingerprint(lease)
    try persist()
  }
  public func get(_ id: String, leaseId: String) throws -> LocalActionReceipt {
    guard !failed else { throw HelperError(503, "Local receipt storage needs reconciliation.") }
    guard let receipt = journal.actions[id], receipt.leaseId == leaseId else { throw HelperError(404, "Local receipt not found.") }
    return receipt
  }
  public func existing(_ action: InputAction, leaseId: String) throws -> LocalActionReceipt? {
    guard !failed else { throw HelperError(503, "Local receipt storage needs reconciliation.") }
    guard let receipt = journal.actions[action.id] else { return nil }
    guard receipt.leaseId == leaseId, receipt.fingerprint == (try fingerprint(action)) else {
      throw HelperError(409, "Action ID conflicts with its retained local receipt.")
    }
    return receipt
  }
  public func begin(_ action: InputAction, lease: LocalExecutionLease, now: Date) throws {
    guard !failed, journal.sessions[lease.id] != nil, journal.actions[action.id] == nil,
      unresolvedActions == 0, journal.actions.count < 10000 else { throw HelperError(409, "Reconcile prior input before dispatching local work.") }
    journal.actions[action.id] = LocalActionReceipt(id: action.id, leaseId: lease.id, deviceId: lease.deviceId,
      sessionId: lease.sessionId, taskId: lease.taskId, executorId: lease.executorId,
      executorEpoch: lease.executorEpoch, policyRevision: lease.policyRevision, fingerprint: try fingerprint(action),
      state: "dispatching", updatedAt: now, evidence: "reserved_before_input")
    try persist()
  }
  public func finish(_ id: String, submitted: Bool, now: Date) throws -> LocalActionReceipt {
    guard !failed, var receipt = journal.actions[id], receipt.state == "dispatching" else { throw HelperError(409, "Local receipt cannot transition.") }
    receipt.state = submitted ? "submitted" : "unknown"
    receipt.evidence = submitted ? "cg_event_posted_not_application_verified" : "input_outcome_unconfirmed"
    receipt.updatedAt = now; journal.actions[id] = receipt
    try persist(); return receipt
  }
  public func observedFrame(leaseId: String, capturedAt: Date) throws {
    var changed = false
    for (id, var receipt) in journal.actions where receipt.leaseId == leaseId && receipt.state == "submitted"
      && receipt.updatedAt <= capturedAt && receipt.evidence != "post_input_frame_available_not_application_verified" {
      receipt.evidence = "post_input_frame_available_not_application_verified"
      journal.actions[id] = receipt; changed = true
    }
    if changed { try persist() }
  }
}
