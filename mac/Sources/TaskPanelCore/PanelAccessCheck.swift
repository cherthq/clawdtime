import Foundation

/// Check mode must never fall through into GUI/configuration startup, even when
/// someone accidentally combines it with launch flags.
public enum PanelAccessCheck: Equatable {
  case notRequested, requested, invalid
  public static func parse(arguments: [String]) -> Self {
    guard arguments.dropFirst().contains("--check-access") else { return .notRequested }
    return arguments.count == 2 && arguments[1] == "--check-access" ? .requested : .invalid
  }
}

/// Facts about this executable's current access and configured combinations,
/// never a capture/input test or a claim that a desktop transition will succeed.
public struct PanelAccessSnapshot: Encodable {
  public let version = 1
  public let accessibility: Bool
  public let screenRecording: Bool
  public let desktopSwitchingEnabled: Bool
  public let desktopShortcutsAvailable: Bool
  public init(accessibility: Bool, screenRecording: Bool, desktopSwitchingEnabled: Bool, desktopShortcutsAvailable: Bool) {
    self.accessibility = accessibility; self.screenRecording = screenRecording
    self.desktopSwitchingEnabled = desktopSwitchingEnabled; self.desktopShortcutsAvailable = desktopShortcutsAvailable
  }
}
