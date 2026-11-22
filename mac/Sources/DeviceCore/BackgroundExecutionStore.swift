import Darwin
import Foundation

public struct BackgroundControllerReservation: Codable, Equatable {
  public var kind: String
  public var id: String
  public var fingerprint: String
  public var driverGeneration: String
  public var driverPid: Int32
  public var driverProcessStart: String
  public var observedAt: Date
  public init(kind: String = "controller", id: String, fingerprint: String, driverGeneration: String,
      driverPid: Int32, driverProcessStart: String, observedAt: Date) {
    self.kind = kind; self.id = id; self.fingerprint = fingerprint; self.driverGeneration = driverGeneration
    self.driverPid = driverPid; self.driverProcessStart = driverProcessStart; self.observedAt = observedAt
  }
  public func validate() throws {
    guard kind == "controller", validID(id), validID(driverGeneration), driverPid > 0,
      backgroundDigest(fingerprint), backgroundDigest(driverProcessStart), observedAt.timeIntervalSince1970.isFinite else {
      throw HelperError(400, "Invalid background controller reservation.")
    }
  }
}
public struct BackgroundControllerResolution: Codable, Equatable {
  public var fingerprint: String
  public var driverGeneration: String
  public var driverPid: Int32
  public var driverProcessStart: String
  public var driverQuiescent: Bool
  public var allActionsReconciled: Bool
  public var observationId: String
  public var observedAt: Date
  public var outcome: String
  public init(fingerprint: String, driverGeneration: String, driverPid: Int32, driverProcessStart: String,
      driverQuiescent: Bool, allActionsReconciled: Bool, observationId: String, observedAt: Date, outcome: String) {
    self.fingerprint = fingerprint; self.driverGeneration = driverGeneration; self.driverPid = driverPid
    self.driverProcessStart = driverProcessStart; self.driverQuiescent = driverQuiescent
    self.allActionsReconciled = allActionsReconciled; self.observationId = observationId
    self.observedAt = observedAt; self.outcome = outcome
  }
}
/// A trusted operator's narrow disposition of one uncertain navigation. It
/// asserts no application success and never authorizes replay or future input.
public struct BackgroundUnknownNavigationEvidence: Codable, Equatable {
  public var kind: String
  public var sessionId: String
  public var taskId: String
  public var actionReceiptId: String
  public var actionFingerprint: String
  public var originalOutcome: String
  public var noReplay: Bool
  public var noTextOrSubmissionDispatched: Bool
}
public struct BackgroundControllerNavigationRetirement: Codable, Equatable {
  public var fingerprint: String
  public var driverGeneration: String
  public var driverPid: Int32
  public var driverProcessStart: String
  public var driverQuiescent: Bool
  public var observationId: String
  public var observedAt: Date
  public var evidence: BackgroundUnknownNavigationEvidence
}
public struct BackgroundControllerReceipt: Codable, Equatable {
  public let reservation: BackgroundControllerReservation
  public let lease: LocalExecutionLease
  public let requestHash: String
  public let sentinelId: String
  public var state: String
  public var updatedAt: Date
  public var resolution: BackgroundControllerResolution?
  public var retirement: BackgroundControllerNavigationRetirement?
}
private func backgroundDigest(_ value: String) -> Bool {
  value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

/// Durable metadata only. Root runtime retains encrypted action content/outcomes.
/// The old local ledger also contains an unresolved sentinel, so rollback to an
/// older helper cannot ignore a possibly running external controller.
public final class BackgroundExecutionStore {
  private var receipts: [String: BackgroundControllerReceipt]
  private let local: LocalExecutionStore
  private let lock: ReceiptLock
  private let directory: Int32
  private var failed = false
  public init(folder: URL, local: LocalExecutionStore) throws {
    self.local = local
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let descriptor = open(folder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError(403, "Background receipt directory unavailable.") }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
      close(descriptor); throw HelperError(403, "Background receipt directory must be private.")
    }
    do {
      lock = try ReceiptLock(folder: folder)
      let file = openat(descriptor, "journal.json", O_RDONLY | O_NOFOLLOW)
      if file >= 0 {
        defer { close(file) }
        var metadata = stat()
        guard fstat(file, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_mode & 0o777 == 0o600, metadata.st_size <= 16 * 1024 * 1024 else {
          throw HelperError(403, "Background journal must be a bounded private regular file.")
        }
        let data = try FileHandle(fileDescriptor: file, closeOnDealloc: false).readToEnd() ?? Data()
        guard data.count <= 16 * 1024 * 1024 else { throw HelperError(413, "Background journal exceeds its limit.") }
        receipts = try JSONDecoder().decode([String: BackgroundControllerReceipt].self, from: data)
      } else {
        guard errno == ENOENT else { throw HelperError(403, "Background journal unavailable.") }
        receipts = [:]
      }
      guard receipts.count <= 10000 else { throw HelperError(409, "Background journal is full.") }
      for (id, receipt) in receipts {
        try receipt.reservation.validate()
        guard id == receipt.reservation.id, validID(receipt.lease.id), local.used(receipt.lease.id),
          receipt.requestHash == (try fingerprint(receipt.reservation)),
          receipt.sentinelId == "background_" + receipt.requestHash,
          ["reserved", "unknown", "resolved", "retired_unknown_navigation"].contains(receipt.state),
          (receipt.state == "resolved") == (receipt.resolution != nil),
          (receipt.state == "retired_unknown_navigation") == (receipt.retirement != nil) else {
          throw HelperError(409, "Background journal is invalid.")
        }
      }
    } catch { close(descriptor); throw error }
    directory = descriptor
    for (id, var receipt) in receipts where receipt.state == "reserved" {
      receipt.state = "unknown"; receipt.updatedAt = Date(); receipts[id] = receipt
    }
    try persist()
    // Repair only toward a conservative fence. Resolution recovery also goes
    // through exact durable evidence, never expiry or an empty helper lease.
    for receipt in receipts.values {
      try local.ensureBackgroundFence(receipt.sentinelId, fingerprint: receipt.requestHash, lease: receipt.lease, now: Date(), allowResolved: receipt.state == "resolved", allowRetiredUnknown: receipt.state == "retired_unknown_navigation")
      if let retirement = receipt.retirement {
        try validateRetirement(retirement, receipt: receipt, now: retirement.observedAt, checkFreshness: false)
        try local.retireBackgroundFence(receipt.sentinelId, fingerprint: receipt.requestHash,
          leaseId: receipt.lease.id, now: receipt.updatedAt)
      }
      if let resolution = receipt.resolution {
        try validateResolution(resolution, receipt: receipt, now: resolution.observedAt, checkFreshness: false)
        try local.resolveBackgroundFence(receipt.sentinelId, fingerprint: receipt.requestHash,
          leaseId: receipt.lease.id, dispatched: resolution.outcome == "observed_completed", now: receipt.updatedAt)
      }
    }
  }
  deinit { close(directory) }
  private func persist() throws {
    guard !failed else { throw HelperError(503, "Background receipt storage needs reconciliation.") }
    do {
      let data = try JSONEncoder().encode(receipts)
      guard data.count <= 16 * 1024 * 1024 else { throw HelperError(503, "Background journal is full.") }
      let temporary = ".journal-" + UUID().uuidString
      let file = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      guard file >= 0 else { throw HelperError(503, "Cannot reserve background receipt.") }
      defer { close(file); unlinkat(directory, temporary, 0) }
      try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < data.count {
          let count = write(file, bytes.baseAddress!.advanced(by: offset), data.count - offset)
          guard count > 0 else { throw HelperError(503, "Cannot persist background receipt.") }; offset += count
        }
      }
      guard fsync(file) == 0, renameat(directory, temporary, directory, "journal.json") == 0, fsync(directory) == 0 else {
        throw HelperError(503, "Cannot commit background receipt.")
      }
    } catch { failed = true; throw error }
  }
  public var unresolvedActions: Int { max(failed ? 1 : 0, receipts.values.filter { !["resolved", "retired_unknown_navigation"].contains($0.state) }.count) }
  public func get(_ id: String, leaseId: String) throws -> BackgroundControllerReceipt {
    guard !failed else { throw HelperError(503, "Background receipt storage needs reconciliation.") }
    guard let receipt = receipts[id], receipt.lease.id == leaseId else { throw HelperError(404, "Background receipt not found.") }
    return receipt
  }
  public func existing(_ value: BackgroundControllerReservation, leaseId: String) throws -> BackgroundControllerReceipt? {
    guard !failed else { throw HelperError(503, "Background receipt storage needs reconciliation.") }
    guard let receipt = receipts[value.id] else { return nil }
    guard receipt.lease.id == leaseId, receipt.reservation == value else { throw HelperError(409, "Background reservation conflicts with retained receipt.") }
    return receipt
  }
  public func reserve(_ value: BackgroundControllerReservation, lease: LocalExecutionLease, now: Date) throws -> BackgroundControllerReceipt {
    try value.validate()
    if let receipt = try existing(value, leaseId: lease.id) { return receipt }
    guard !failed, unresolvedActions == 0, local.unresolvedActions == 0, local.used(lease.id), receipts.count < 10000,
      lease.expiresAt > now, (0...2).contains(now.timeIntervalSince(value.observedAt)) else {
      throw HelperError(409, "Background reservation needs fresh authority and reconciled input.")
    }
    let hash = try fingerprint(value)
    let receipt = BackgroundControllerReceipt(reservation: value, lease: lease, requestHash: hash,
      sentinelId: "background_" + hash, state: "reserved", updatedAt: now, resolution: nil)
    receipts[value.id] = receipt; try persist()
    // No caller may dispatch until BOTH journals are durable. An interrupted
    // response is a status-only reconciliation, never another start_session.
    do { try local.ensureBackgroundFence(receipt.sentinelId, fingerprint: hash, lease: lease, now: now) }
    catch { failed = true; throw error }
    return receipt
  }
  private func validateResolution(_ value: BackgroundControllerResolution, receipt: BackgroundControllerReceipt,
      now: Date, checkFreshness: Bool = true) throws {
    let request = receipt.reservation
    guard value.fingerprint == request.fingerprint, value.driverGeneration == request.driverGeneration,
      value.driverPid == request.driverPid, value.driverProcessStart == request.driverProcessStart,
      value.driverQuiescent, value.allActionsReconciled, validID(value.observationId),
      ["observed_completed", "not_dispatched"].contains(value.outcome),
      value.observedAt >= request.observedAt, value.observedAt.timeIntervalSince1970.isFinite,
      (!checkFreshness || (0...5).contains(now.timeIntervalSince(value.observedAt))) else {
      throw HelperError(409, "Exact quiescence and reconciled outcomes are required to clear a background fence.")
    }
  }
  public func resolve(_ id: String, leaseId: String, value: BackgroundControllerResolution, now: Date) throws -> BackgroundControllerReceipt {
    var receipt = try get(id, leaseId: leaseId)
    guard receipt.retirement == nil else { throw HelperError(409, "Retired unknown navigation cannot become a resolved outcome.") }
    if let old = receipt.resolution {
      guard old == value else { throw HelperError(409, "Background resolution conflicts with retained evidence.") }
    } else {
      try validateResolution(value, receipt: receipt, now: now)
      receipt.state = "resolved"; receipt.resolution = value; receipt.updatedAt = now
      receipts[id] = receipt; try persist()
    }
    try local.resolveBackgroundFence(receipt.sentinelId, fingerprint: receipt.requestHash,
      leaseId: leaseId, dispatched: value.outcome == "observed_completed", now: now)
    return receipt
  }
  private func validateRetirement(_ value: BackgroundControllerNavigationRetirement,
      receipt: BackgroundControllerReceipt, now: Date, checkFreshness: Bool = true) throws {
    let request = receipt.reservation, evidence = value.evidence
    guard value.fingerprint == request.fingerprint, value.driverGeneration == request.driverGeneration,
      value.driverPid == request.driverPid, value.driverProcessStart == request.driverProcessStart,
      value.driverQuiescent, validID(value.observationId), value.observedAt >= request.observedAt,
      value.observedAt.timeIntervalSince1970.isFinite,
      (!checkFreshness || (0...5).contains(now.timeIntervalSince(value.observedAt))),
      evidence.kind == "codex_new_chat_navigation", evidence.originalOutcome == "unknown",
      evidence.sessionId == receipt.lease.sessionId, evidence.taskId == receipt.lease.taskId,
      validID(evidence.actionReceiptId), backgroundDigest(evidence.actionFingerprint),
      evidence.noReplay, evidence.noTextOrSubmissionDispatched else {
      throw HelperError(409, "Exact quiescence and operator evidence for unknown navigation are required.")
    }
  }
  /// Operator-only cleanup. The trusted caller must independently match the
  /// linked action manifest; helper metadata cannot inspect its encrypted input.
  public func retireNavigation(_ id: String, leaseId: String,
      value: BackgroundControllerNavigationRetirement, now: Date) throws -> BackgroundControllerReceipt {
    var receipt = try get(id, leaseId: leaseId)
    guard receipt.resolution == nil else { throw HelperError(409, "Resolved controller cannot be reclassified as unknown.") }
    if let old = receipt.retirement {
      guard old == value else { throw HelperError(409, "Retirement conflicts with retained unknown evidence.") }
    } else {
      try validateRetirement(value, receipt: receipt, now: now)
      receipt.state = "retired_unknown_navigation"; receipt.retirement = value; receipt.updatedAt = now
      receipts[id] = receipt; try persist()
    }
    // Persist the honest disposition first. Only then release this binary's
    // exclusivity fence; the sentinel remains unknown for rollback binaries.
    try local.retireBackgroundFence(receipt.sentinelId, fingerprint: receipt.requestHash,
      leaseId: leaseId, now: receipt.updatedAt)
    return receipt
  }

}
