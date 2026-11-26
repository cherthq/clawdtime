import Foundation

/// AX is a lifecycle witness only; the ScreenCaptureKit ID still chooses pixels.
public struct WindowLifecycleWitness {
  public let frame: CGRect
  public let minimized: Bool?
  public init(frame: CGRect, minimized: Bool?) { self.frame = frame; self.minimized = minimized }
}
public enum WindowCapturePolicy {
  public static func placementAllowed(frame: CGRect, selectedDisplay: CGRect, otherDisplays: [CGRect], initial: Bool) -> Bool {
    guard frame.width > 0, frame.height > 0 else { return false }
    if initial && !selectedDisplay.contains(frame) { return false }
    return !otherDisplays.contains { frame.intersects($0) }
  }

  public static func available(frame: CGRect, onScreen: Bool, active: Bool, appHidden: Bool,
    witnesses: [WindowLifecycleWitness], matchingCaptureWindows: Int = 1) -> Bool {
    unavailableReason(frame: frame, onScreen: onScreen, active: active, appHidden: appHidden,
      witnesses: witnesses, matchingCaptureWindows: matchingCaptureWindows) == nil
  }

  public static func unavailableReason(frame: CGRect, onScreen: Bool, active: Bool, appHidden: Bool,
    witnesses: [WindowLifecycleWitness], matchingCaptureWindows: Int = 1) -> CaptureRefusal.Reason? {
    guard !appHidden else { return .appHidden }
    guard frame.width > 0, frame.height > 0 else { return .windowGeometry }
    if onScreen || active { return nil }
    guard matchingCaptureWindows == 1 else { return .captureWindowAmbiguous }
    let matches = witnesses.filter { $0.frame == frame }
    guard !matches.isEmpty else { return .lifecycleWitnessUnavailable }
    guard matches.count == 1 else { return .lifecycleWitnessAmbiguous }
    guard let minimized = matches[0].minimized else { return .lifecycleWitnessUnreadable }
    return minimized ? .windowMinimized : nil
  }
}
