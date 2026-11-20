import Foundation

/// How the panel was started: `--config PATH`, with `--tucked` optional.
/// Tucked starts as the mascot and takes no focus from the window in use.
public struct PanelLaunch: Equatable {
  public let configPath: String
  public let tucked: Bool
  public init?(arguments: [String]) {
    var rest = arguments
    var tucked = false
    if let index = rest.firstIndex(of: "--tucked") { rest.remove(at: index); tucked = true }
    guard !rest.contains("--tucked"), let index = rest.firstIndex(of: "--config"), index >= 1,
      rest.count == index + 2, rest[index + 1].hasPrefix("/") else { return nil }
    configPath = rest[index + 1]; self.tucked = tucked
  }
}
