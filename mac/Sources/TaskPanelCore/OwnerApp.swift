import Foundation

/// The ClawdTime Mac app that runs this panel. The app says so on purpose:
/// it sets `CLAWDTIME_APP_BUNDLE` to its own bundle for `clawdtime start
/// --foreground`, which passes it to the panel alone. The app then shows no
/// menu bar item of its own, so the panel's menu adds Settings and Stop
/// ClawdTime, and opens them in that app with a `clawdtime://` link. Without
/// the variable (a start from Terminal or a source checkout) the panel's menu
/// is as it always was.
public struct OwnerApp: Equatable, Sendable {
  public static let variable = "CLAWDTIME_APP_BUNDLE"
  /// The running app, for example /Applications/ClawdTime.app.
  public let bundle: URL

  /// Only an absolute path to an `.app` bundle counts. Anything else is no app.
  public init?(environment: [String: String]) {
    guard let value = environment[Self.variable], value.hasPrefix("/"), value.count <= 1024,
      !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
    let bundle = URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
    guard bundle.pathExtension == "app" else { return nil }
    self.bundle = bundle
  }

  /// The rows the panel's menu adds while the app runs it, in order.
  public static let menu: [(title: String, key: String, link: OwnerAppLink)] = [
    ("Settings…", ",", .settings),
    ("Stop ClawdTime", "", .stop),
  ]
}

/// The links the app answers. None of them starts anything or changes a setting.
public enum OwnerAppLink: String, CaseIterable, Sendable {
  /// The setup window, with the readiness of each step.
  case open
  /// The Settings window.
  case settings
  /// The same Stop as in the app: the connection first, then the desktop.
  case stop

  public var url: URL { URL(string: "clawdtime://" + rawValue)! }
  /// The app comes to the front for a window. Stop opens none.
  public var activates: Bool { self != .stop }
}
