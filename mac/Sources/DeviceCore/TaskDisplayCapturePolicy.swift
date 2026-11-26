import Foundation

/// Explicit display viewing, separate from the exact-window grant. No input authority.
public struct TaskDisplayCaptureTarget: Codable, Equatable {
  public let displayId: UInt32
  public let displayUUID: String
  public let x: Double, y: Double, width: Double, height: Double
  public init(displayId: UInt32, displayUUID: String, x: Double, y: Double, width: Double, height: Double) {
    self.displayId = displayId; self.displayUUID = displayUUID
    self.x = x; self.y = y; self.width = width; self.height = height
  }
  public func validate() -> Bool {
    displayId > 0 && UUID(uuidString: displayUUID) != nil
      && [x, y, width, height].allSatisfy { $0.isFinite && abs($0) <= 65536 }
      && width >= 1 && height >= 1
  }
  /// The whole display fits in the video budget. Never crop or upscale it.
  public var outputSize: (width: Int, height: Int)? {
    guard validate() else { return nil }
    let scale = min(1, min(1920 / width, 1080 / height))
    return (max(1, Int((width * scale).rounded(.down))), max(1, Int((height * scale).rounded(.down))))
  }
}
public struct TaskDisplayCaptureGrant: Codable {
  public let presentationId: String
  public let expiresAt: Double
  public let target: TaskDisplayCaptureTarget
  public init(presentationId: String, expiresAt: Double, target: TaskDisplayCaptureTarget) {
    self.presentationId = presentationId; self.expiresAt = expiresAt; self.target = target
  }
  public func permits(_ requested: TaskDisplayCaptureTarget, now: Double) -> Bool {
    validID(presentationId) && now.isFinite && expiresAt.isFinite && expiresAt > now
      && expiresAt <= now + 900_000 && target.validate() && requested == target
  }
}
