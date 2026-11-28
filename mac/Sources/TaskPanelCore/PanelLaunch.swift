import Foundation

/// How the panel was started: `--config PATH`, with `--tucked` or `--chat`
/// optional. Tucked starts as the mascot and takes no focus from the window in
/// use. Chat opens the chat with the keys and one suggested first request: the
/// end of setup asks for it. A panel that is open already opens its chat too.
public struct PanelLaunch: Equatable {
  public let configPath: String
  public let tucked: Bool
  public let chat: Bool
  public init?(arguments: [String]) {
    var rest = arguments
    var tucked = false, chat = false
    if let index = rest.firstIndex(of: "--tucked") { rest.remove(at: index); tucked = true }
    if let index = rest.firstIndex(of: "--chat") { rest.remove(at: index); chat = true }
    guard !(tucked && chat), !rest.contains("--tucked"), !rest.contains("--chat"), let index = rest.firstIndex(of: "--config"), index >= 1,
      rest.count == index + 2, rest[index + 1].hasPrefix("/") else { return nil }
    configPath = rest[index + 1]; self.tucked = tucked; self.chat = chat
  }

  /// The notification that a second start with `--chat` posts to the panel
  /// that is open already: open the chat with the keys and the first request.
  public static func chatNotification(show name: String) -> String { name + ".chat" }
}
