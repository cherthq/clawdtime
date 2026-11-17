import Foundation

/// Separate capability: no activation verbs, input payloads or native action tokens.
public struct PresentationResolveRequest: Codable, PreviewTargetRequest {
  public let v: Int, requestId: String, op: String, sessionId: String, leaseId: String
  public let authorityRequestId: String, processIdentity: String
  public let epoch: Int, cursor: Int, policyRevision: Int, displayId: UInt32, expiresAt: Double
  public let target: PreviewNativeTarget
  public var allowsUnqualifiedBounds: Bool { true }
  public func valid(now: Double) -> Bool {
    v == 1 && op == "resolve" && epoch >= 0 && cursor >= 0 && policyRevision > 0 && displayId > 0 && target.valid
      && [requestId,sessionId,leaseId,authorityRequestId,processIdentity].allSatisfy(PreviewNativeRequest.identifier)
      && expiresAt.isFinite && expiresAt > now && expiresAt <= now + 2000
  }
  public static func decode(_ data: Data, now: Double) throws -> Self {
    let expected: Set<String> = ["v","requestId","op","sessionId","leaseId","authorityRequestId","processIdentity","epoch","cursor","policyRevision","displayId","expiresAt","target"]
    guard data.count <= 8192, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(raw.keys) == expected,
      let target = raw["target"] as? [String: Any], Set(target.keys) == ["pid","bundleId","windowId"] else { throw HelperError(400, "Invalid read-only resolver request.") }
    let request = try JSONDecoder().decode(Self.self, from: data)
    guard request.valid(now: now) else { throw HelperError(400, "Invalid read-only resolver request.") }
    return request
  }
  public func resolving(titleHash: String, bounds: PreviewNativeBounds) -> Self {
    Self(v: v, requestId: requestId, op: op, sessionId: sessionId, leaseId: leaseId,
      authorityRequestId: authorityRequestId, processIdentity: processIdentity, epoch: epoch, cursor: cursor,
      policyRevision: policyRevision, displayId: displayId, expiresAt: expiresAt,
      target: PreviewNativeTarget(pid: target.pid, bundleId: target.bundleId, windowId: target.windowId, titleHash: titleHash, bounds: bounds))
  }
  public func sameBinding(_ other: Self) -> Bool {
    sessionId == other.sessionId && leaseId == other.leaseId && authorityRequestId == other.authorityRequestId
      && epoch == other.epoch && cursor == other.cursor && policyRevision == other.policyRevision
      && displayId == other.displayId && processIdentity == other.processIdentity && target == other.target
  }
}
