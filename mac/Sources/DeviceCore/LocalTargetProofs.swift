import Foundation

/// Model-visible action fields only; ownership comes from the authenticated lease.
public struct LocalPlannedAction: Codable, Equatable {
  public var type: String
  public var targetId: String?
  public var x: Double?
  public var y: Double?
  public var text: String?
  public var deltaY: Int32?
  public init(_ action: InputAction) {
    type = action.type; targetId = action.targetId; x = action.x; y = action.y; text = action.text; deltaY = action.deltaY
  }
  public func validate() throws {
    try InputAction(id: "validate", frameId: "validate", type: type, x: x, y: y, text: text, deltaY: deltaY, targetId: targetId).validate()
  }
}
public struct LocalTargetPoint: Codable, Equatable {
  public let id: String
  public let role: String
  public let x: Double
  public let y: Double
  public init(id: String, role: String, x: Double, y: Double) {
    self.id = id; self.role = role; self.x = (x * 1_000_000).rounded() / 1_000_000
    self.y = (y * 1_000_000).rounded() / 1_000_000
  }
  public func matches(_ action: LocalPlannedAction) -> Bool {
    action.x == x && action.y == y
  }
}

/// Bounded, in-memory proof capabilities. Snapshots never enter the receipt journal.
public final class LocalTargetProofs<Snapshot> {
  public struct Catalog {
    public let frame: FrameStamp
    public let snapshot: Snapshot
  }
  private struct Proof {
    let leaseId: String
    let planned: String
    let current: String
    let actionHash: String
    let expiresAt: Date
  }
  private var catalogs: [String: Catalog] = [:]
  private var order: [String] = []
  private var proofs: [String: Proof] = [:]
  public private(set) var latestFrameId: String?
  public init() {}
  public func clear() { catalogs.removeAll(); order.removeAll(); proofs.removeAll(); latestFrameId = nil }
  public func register(_ frame: FrameStamp, snapshot: Snapshot) {
    if let latestFrameId, catalogs[latestFrameId]?.frame.leaseId != frame.leaseId { clear() }
    guard catalogs[frame.id] == nil else { return }
    catalogs[frame.id] = Catalog(frame: frame, snapshot: snapshot); order.append(frame.id); latestFrameId = frame.id
    while order.count > 8 { catalogs.removeValue(forKey: order.removeFirst()) }
    proofs = proofs.filter { catalogs[$0.value.planned] != nil && $0.value.current == frame.id }
  }
  public func pair(planned: String, current: String, lease: LocalExecutionLease, now: Date) -> (Catalog, Catalog)? {
    guard current == latestFrameId, planned != current, lease.expiresAt > now,
      let old = catalogs[planned], let fresh = catalogs[current],
      old.frame.leaseId == lease.id, fresh.frame.leaseId == lease.id,
      old.frame.displayId == lease.displayId, fresh.frame.displayId == lease.displayId,
      (0...30).contains(now.timeIntervalSince(old.frame.capturedAt)),
      fresh.frame.capturedAt >= old.frame.capturedAt,
      (0...2).contains(now.timeIntervalSince(fresh.frame.capturedAt)) else { return nil }
    return (old, fresh)
  }
  public func issue(planned: String, current: String, action: LocalPlannedAction, lease: LocalExecutionLease, now: Date) throws -> String? {
    try action.validate()
    guard let (_, fresh) = pair(planned: planned, current: current, lease: lease, now: now), proofs.count < 32 else { return nil }
    let id = UUID().uuidString
    proofs[id] = Proof(leaseId: lease.id, planned: planned, current: current, actionHash: try fingerprint(action),
      expiresAt: min(lease.expiresAt, fresh.frame.capturedAt.addingTimeInterval(2)))
    return id
  }
  public func consume(_ id: String, action: InputAction, lease: LocalExecutionLease, now: Date) throws -> (Catalog, Catalog) {
    guard let proof = proofs.removeValue(forKey: id), proof.leaseId == lease.id,
      proof.current == action.frameId, proof.expiresAt > now,
      proof.actionHash == (try fingerprint(LocalPlannedAction(action))),
      let pair = pair(planned: proof.planned, current: proof.current, lease: lease, now: now) else {
      throw HelperError(409, "Local target proof is missing, stale, consumed or mismatched.")
    }
    return pair
  }
}
