import Foundation

/// The app's own menu bar item. There is one ClawdTime item at a time: once
/// setup is done and the desktop runs with its panel, the panel's item holds
/// Settings and Stop ClawdTime too, and the app's item goes. It comes back as
/// soon as that desktop or its panel stops, so there is never none.
public enum OwnStatusItem {
  /// `panelHasAppMenu`: the app told the panel that it runs it, so the panel
  /// shows the app's rows.
  public static func shown(setupDone: Bool, desktop: OwnedStatus, panelOpen: Bool, panelHasAppMenu: Bool) -> Bool {
    !(setupDone && desktop == .running && panelOpen && panelHasAppMenu)
  }
}

/// The `clawdtime://` links that the app answers. The panel opens them from
/// its menu. A link only shows a window or stops: none starts anything or
/// changes a setting, so any program that opens one can do no harm.
public enum AppLink: String, CaseIterable, Sendable {
  public static let scheme = "clawdtime"
  /// The setup window, with the readiness of each step.
  case open
  /// The Settings window.
  case settings
  /// Stop: the connection first, then the desktop.
  case stop

  /// Exactly `clawdtime://NAME`, with no path, query, fragment, user or port.
  public init?(url: URL) {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme?.lowercased() == Self.scheme, let host = parts.host?.lowercased(),
      parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.fragment == nil,
      parts.user == nil, parts.password == nil, parts.port == nil,
      let link = AppLink(rawValue: host) else { return nil }
    self = link
  }

  /// The links in `urls` that the app answers, in order. Others are ignored.
  public static func links(in urls: [URL]) -> [AppLink] { urls.compactMap { AppLink(url: $0) } }
}
