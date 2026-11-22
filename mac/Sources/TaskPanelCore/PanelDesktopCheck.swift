import Foundation

/// A separate, metadata-only source diagnostic. Malformed flags never start the GUI.
public enum PanelDesktopCheck: Equatable {
  case notRequested, requested, invalid
  public static func parse(arguments: [String]) -> Self {
    guard arguments.dropFirst().contains("--check-desktop") else { return .notRequested }
    return arguments.count == 2 && arguments[1] == "--check-desktop" ? .requested : .invalid
  }
}

/// Deliberately has no app identity, title, content, image or input fields.
public struct PanelDesktopSnapshot: Encodable {
  public let version = 1
  public var reason = "not_checked"
  public var activeDisplays = 0
  public var checks: [String: Bool] = [:]
  public init() {}
}
