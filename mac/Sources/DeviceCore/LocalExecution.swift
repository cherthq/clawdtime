import Foundation

/// App-owned desktop work has its own identity; it is never represented as a call.
public struct LocalExecutionLease: Codable, Equatable {
  public var id: String
  public var deviceId: String
  public var sessionId: String
  public var taskId: String
  public var executorId: String
  public var executorEpoch: Int
  public var policyRevision: Int
  public var displayId: UInt32
  public var expiresAt: Date
  public init(id: String, deviceId: String, sessionId: String, taskId: String, executorId: String,
              executorEpoch: Int, policyRevision: Int, displayId: UInt32, expiresAt: Date) {
    self.id = id; self.deviceId = deviceId; self.sessionId = sessionId; self.taskId = taskId
    self.executorId = executorId; self.executorEpoch = executorEpoch; self.policyRevision = policyRevision
    self.displayId = displayId; self.expiresAt = expiresAt
  }
}

/// Uses the same local arm, policy and ownership slot as the call helper.
public final class LocalExecutionPolicy {
  public let shared: DevicePolicy
  public private(set) var lease: LocalExecutionLease?
  public private(set) var frame: FrameStamp?
  public private(set) var generation = 0
  private var retired = Set<String>()
  public init(shared: DevicePolicy) { self.shared = shared }
  public func stop() {
    if let lease { retired.insert(lease.id); shared.releaseLocal(lease.id) }
    lease = nil; frame = nil; generation += 1
  }
  public func check(now: Date, available: Bool) throws {
    do { try shared.check(now: now, sessionAvailable: available) }
    catch { stop(); throw error }
    if let lease, lease.expiresAt <= now || shared.localSessionOwner != lease.id {
      stop(); throw HelperError(410, "Local session ended or expired.")
    }
  }
  private func authorize(_ value: LocalExecutionLease, now: Date, accessibility: Bool) throws {
    guard [value.id, value.deviceId, value.sessionId, value.taskId, value.executorId].allSatisfy(validID),
      value.deviceId == shared.config.deviceId, value.executorEpoch >= 0,
      value.policyRevision == shared.preferences.revision,
      value.expiresAt > now, value.expiresAt.timeIntervalSince(now) <= 30 else {
      throw HelperError(400, "Invalid local session binding or expiration.")
    }
    guard shared.config.bind == "127.0.0.1",
      (shared.config.localExecutors ?? []).contains(where: { $0.executorId == value.executorId && $0.displayId == value.displayId }),
      shared.preferences.policy != .viewOnly, accessibility else {
      throw HelperError(403, "Local executor, display, control policy and Accessibility must be authorized.")
    }
  }
  public func begin(_ value: LocalExecutionLease, now: Date, available: Bool, accessibility: Bool) throws {
    try check(now: now, available: available)
    try authorize(value, now: now, accessibility: accessibility)
    guard !retired.contains(value.id), lease == nil || lease == value else {
      throw HelperError(409, "Local session conflicts or was stopped.")
    }
    try shared.claimLocal(value.id)
    if lease == nil { lease = value; frame = nil; generation += 1 }
  }
  public func renew(_ value: LocalExecutionLease, now: Date, available: Bool, accessibility: Bool) throws {
    _ = try require(value.id, now: now, available: available)
    var expected = lease!
    expected.expiresAt = value.expiresAt
    guard expected == value else { throw HelperError(409, "Renewal cannot change local execution ownership.") }
    try authorize(value, now: now, accessibility: accessibility)
    lease = value
  }
  public func require(_ id: String, now: Date, available: Bool) throws -> LocalExecutionLease {
    try check(now: now, available: available)
    guard let lease, lease.id == id else { throw HelperError(404, "No matching local session.") }
    return lease
  }
  public func invalidateFrame() { frame = nil }
  public func recordFrame(_ value: FrameStamp) throws {
    guard let lease, shared.localSessionOwner == lease.id, value.leaseId == lease.id, value.displayId == lease.displayId else {
      throw HelperError(409, "Frame belongs to an old local session.")
    }
    frame = value
  }
  public func validateAction(_ action: InputAction, id: String, now: Date, available: Bool, accessibility: Bool) throws -> LocalExecutionLease {
    let lease = try require(id, now: now, available: available)
    try authorize(lease, now: now, accessibility: accessibility)
    try action.validate()
    guard action.sessionId == lease.sessionId, action.executorEpoch == lease.executorEpoch,
      action.policyRevision == lease.policyRevision else { throw HelperError(409, "Action belongs to another local owner.") }
    guard let frame, frame.id == action.frameId, frame.leaseId == id, frame.displayId == lease.displayId,
      (0...2).contains(now.timeIntervalSince(frame.capturedAt)) else {
      throw HelperError(409, "Local input needs the current frame captured within two seconds.")
    }
    return lease
  }
}
