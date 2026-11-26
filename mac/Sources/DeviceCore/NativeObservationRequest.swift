import Foundation

/// Local metadata diagnostic only. It has no session/lease claims, operation
/// verbs, action tokens, capture configuration or input coordinates.
public struct NativeObservationRequest: PreviewTargetRequest {
  public let target: PreviewNativeTarget
  public let displayId: UInt32
  private let expiresAt: Double
  public var allowsUnqualifiedBounds: Bool { true }
  private struct Window: Decodable {
    let appId: String, windowId: String
    let ownerPid: Int32, displayId: UInt32
  }
  public static func decode(_ data: Data, now: Double) throws -> Self {
    guard data.count <= 1024, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(raw.keys) == ["appId","windowId","ownerPid","displayId"] else {
      throw HelperError(400, "Invalid read-only observation target.")
    }
    let window = try JSONDecoder().decode(Window.self, from: data)
    guard let id = UInt32(window.windowId), String(id) == window.windowId else {
      throw HelperError(400, "Invalid read-only observation target.")
    }
    let request = Self(target: PreviewNativeTarget(pid: window.ownerPid, bundleId: window.appId,
      windowId: id, titleHash: nil, bounds: nil), displayId: window.displayId, expiresAt: now + 2000)
    guard request.valid(now: now) else { throw HelperError(400, "Invalid read-only observation target.") }
    return request
  }
  public func valid(now: Double) -> Bool {
    now.isFinite && expiresAt.isFinite && now < expiresAt && expiresAt <= now + 2000 && displayId > 0 && target.valid
  }
  public func resolving(titleHash: String, bounds: PreviewNativeBounds) -> Self {
    Self(target: PreviewNativeTarget(pid: target.pid, bundleId: target.bundleId, windowId: target.windowId,
      titleHash: titleHash, bounds: bounds), displayId: displayId, expiresAt: expiresAt)
  }
}
