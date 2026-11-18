import Foundation
import CoreGraphics

/// Exact-window view only. This grant has no display capture or input operation.
public struct TaskCaptureTarget: Codable, Equatable {
  public let appId: String, windowId: String, processIdentity: String, titleHash: String
  public let ownerPid: Int32
  public let displayId: UInt32
  public init(appId: String, windowId: String, processIdentity: String, titleHash: String, ownerPid: Int32, displayId: UInt32) {
    self.appId = appId; self.windowId = windowId; self.processIdentity = processIdentity
    self.titleHash = titleHash; self.ownerPid = ownerPid; self.displayId = displayId
  }
  public func validate() -> Bool {
    ownerPid > 0 && displayId > 0 && UInt32(windowId).map { $0 > 0 } == true
      && appId.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,159}$", options: .regularExpression) != nil
      && [processIdentity, titleHash].allSatisfy { $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
  }
}
public struct TaskCaptureGrant: Codable {
  public let presentationId: String
  public let expiresAt: Double
  public let targets: [TaskCaptureTarget]
  public init(presentationId: String, expiresAt: Double, targets: [TaskCaptureTarget]) {
    self.presentationId = presentationId; self.expiresAt = expiresAt; self.targets = targets
  }
  public func permits(_ target: TaskCaptureTarget, now: Double) -> Bool {
    validID(presentationId) && expiresAt.isFinite && expiresAt > now
      && expiresAt <= now + 900_000 && !targets.isEmpty && targets.count <= 12
      && targets.allSatisfy { $0.validate() } && targets.contains(target)
  }
}
public enum TaskCapturePolicy {
  public static func geometry(width: Int, height: Int, bounds: CGRect, display: CGRect) -> Bool {
    width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000
      && !bounds.isEmpty && !bounds.isInfinite && !bounds.isNull && display.contains(bounds)
  }
}
