import Foundation

/// Production read-only metadata capability. No action verbs or input tokens.
public struct LeasePresentationRequest: Decodable {
  public struct Window: Decodable { public let appId: String, windowId: String; public let ownerPid: Int32, displayId: UInt32 }
  public struct Expected: Decodable { public let requestId: String, sessionId: String, leaseId: String; public let epoch: Int, cursor: Int, policyRevision: Int; public let displayId: UInt32 }
  public let version: Int, window: Window, expected: Expected, expiresAt: Double
  public let processIdentity: String?
  public static func decode(_ data: Data, now: Double) throws -> Self {
    guard data.count <= 8192, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(raw.keys).subtracting(["processIdentity"]) == ["version","window","expected","expiresAt"],
      raw["processIdentity"] == nil || raw["processIdentity"] is String,
      let w = raw["window"] as? [String: Any], Set(w.keys) == ["appId","windowId","ownerPid","displayId"],
      let e = raw["expected"] as? [String: Any], Set(e.keys) == ["requestId","sessionId","leaseId","epoch","cursor","policyRevision","displayId"]
      else { throw HelperError(400, "Invalid read-only presentation request.") }
    let value = try JSONDecoder().decode(Self.self, from: data)
    guard value.version == 1, value.window.displayId == value.expected.displayId,
      value.processIdentity.map({ $0.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }) ?? true,
      value.window.windowId == UInt32(value.window.windowId).map(String.init),
      value.nativeRequest(now: now) != nil else { throw HelperError(400, "Invalid read-only presentation request.") }
    return value
  }
  public func matches(_ lease: Lease, now: Date) -> Bool {
    lease.id == expected.leaseId && lease.sessionId == expected.sessionId && lease.protocolVersion == 2
      && lease.executorEpoch == expected.epoch && lease.policyRevision == expected.policyRevision
      && lease.executor == "none" && lease.mode == "view" && lease.cameraVersion == 1
      && lease.surface?.kind == "display" && lease.surface?.displayId == expected.displayId
      && lease.displayId == expected.displayId && lease.expiresAt > now
      && now.timeIntervalSince1970 * 1000 < expiresAt
  }
  public func nativeRequest(now: Double) -> PresentationResolveRequest? {
    let raw: [String: Any] = ["v":1,"requestId":UUID().uuidString,"op":"resolve","sessionId":expected.sessionId,
      "leaseId":expected.leaseId,"authorityRequestId":expected.requestId,"processIdentity":processIdentity ?? "unqualified",
      "epoch":expected.epoch,"cursor":expected.cursor,"policyRevision":expected.policyRevision,"displayId":expected.displayId,
      "expiresAt":expiresAt,"target":["pid":window.ownerPid,"bundleId":window.appId,"windowId":UInt32(window.windowId) ?? 0]]
    guard let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
    return try? PresentationResolveRequest.decode(data, now: now)
  }
}
