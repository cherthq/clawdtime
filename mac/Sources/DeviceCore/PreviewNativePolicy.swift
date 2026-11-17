import Foundation

/// Shared read-only target metadata contract; conforming does not grant input.
public protocol PreviewTargetRequest {
  var target: PreviewNativeTarget { get }
  var displayId: UInt32 { get }
  var allowsUnqualifiedBounds: Bool { get }
  func valid(now: Double) -> Bool
  func resolving(titleHash: String, bounds: PreviewNativeBounds) -> Self
}

/// Development-only wire contract. This does not grant a production control lease.
public struct PreviewNativeBounds: Codable, Equatable {
  public let x: Double, y: Double, width: Double, height: Double
  public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
  public var valid: Bool { [x,y,width,height].allSatisfy(\.isFinite) && width > 0 && height > 0 && width <= 32768 && height <= 32768 && abs(x) <= 65536 && abs(y) <= 65536 }
}
public struct PreviewNativeTarget: Codable, Equatable {
  public let pid: Int32, bundleId: String, windowId: UInt32
  public let titleHash: String?
  public let bounds: PreviewNativeBounds?
  public var valid: Bool {
    pid > 0 && windowId > 0 && ["com.apple.finder", "com.apple.TextEdit"].contains(bundleId)
      && ((titleHash == nil && bounds == nil) || (titleHash.map { $0.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } } == true && bounds?.valid == true))
  }
}
public struct PreviewNativeRequest: Codable, PreviewTargetRequest {
  public let v: Int, requestId: String, op: String, effect: String, sessionId: String, leaseId: String
  public let authorityRequestId: String
  public let executorEpoch: Int, cursor: Int, policyRevision: Int, displayId: UInt32, expiresAt: Double
  public let target: PreviewNativeTarget
  public let targetToken: String?
  public var allowsUnqualifiedBounds: Bool { op == "qualify" }
  public func valid(now: Double) -> Bool {
    v == 1 && ["activate", "raise"].contains(effect) && (op == "qualify" || op == effect)
      && [requestId,authorityRequestId,sessionId,leaseId].allSatisfy(Self.identifier)
      && executorEpoch > 0 && cursor >= 0 && policyRevision > 0 && displayId > 0 && target.valid
      && expiresAt.isFinite && expiresAt > now && expiresAt <= now + 2000
      && (op == "qualify" ? targetToken == nil : targetToken.map(Self.identifier) == true && target.bounds != nil)
  }
  public static func identifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 160 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  public func sameAuthority(_ other: Self) -> Bool {
    authorityRequestId == other.authorityRequestId && cursor == other.cursor
      && sessionId == other.sessionId && leaseId == other.leaseId && executorEpoch == other.executorEpoch
      && policyRevision == other.policyRevision && displayId == other.displayId
  }
  public func resolving(titleHash: String, bounds: PreviewNativeBounds) -> Self {
    Self(v: v, requestId: requestId, op: op, effect: effect, sessionId: sessionId, leaseId: leaseId,
      authorityRequestId: authorityRequestId, executorEpoch: executorEpoch, cursor: cursor, policyRevision: policyRevision, displayId: displayId, expiresAt: expiresAt,
      target: PreviewNativeTarget(pid: target.pid, bundleId: target.bundleId, windowId: target.windowId, titleHash: titleHash, bounds: bounds), targetToken: targetToken)
  }
}

/// One-use, original-age qualification; rejected effects also consume the token.
public struct PreviewNativeAdmission {
  private var witness: (request: PreviewNativeRequest, token: String, uptime: Double)?
  private var requests = Set<String>()
  public init() {}
  public mutating func begin(_ request: PreviewNativeRequest, now: Double) -> Bool {
    guard request.valid(now: now), requests.count < 256, requests.insert(request.requestId).inserted else { clear(); return false }
    return true
  }
  public mutating func qualify(_ request: PreviewNativeRequest, token: String, uptime: Double) {
    witness = (request, token, uptime)
  }
  public mutating func consume(_ request: PreviewNativeRequest, now: Double, uptime: Double) -> Bool {
    let old = witness; witness = nil
    guard let old, request.op != "qualify", request.targetToken == old.token,
      request.sameAuthority(old.request), request.effect == old.request.effect, request.target == old.request.target,
      request.expiresAt <= old.request.expiresAt, now < old.request.expiresAt,
      uptime >= old.uptime, uptime - old.uptime < 2 else { return false }
    return true
  }
  public mutating func clear() { witness = nil }
}
