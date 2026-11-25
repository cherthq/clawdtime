import Foundation

/// What the service says of a new chat: the chat was put aside, never deleted, and an empty one
/// started. Work that runs goes on. `ok` is false when the chat did not change, for example while
/// ClawdTime still answers a message; `text` then says why.
public struct NewChatResult: Codable, Equatable {
  public let ok: Bool
  public let text: String
  /// The time under which the chat before was put aside, or nil when it was empty.
  public let archived: String?
  public init(ok: Bool, text: String, archived: String?) { self.ok = ok; self.text = text; self.archived = archived }
  public func validate() throws {
    guard (1...600).contains(text.count),
      archived.map({ $0.range(of: "^[0-9]{8}T[0-9]{6}Z(-[0-9]{1,3})?$", options: .regularExpression) != nil }) ?? true
    else { throw PanelFailure.response }
  }
}

/// The button in the header of the chat, next to Close, that starts a new chat.
public enum NewChatButton {
  public static let symbol = "square.and.pencil"
  /// What VoiceOver says, and the tooltip.
  public static let label = "Start a new chat"
  /// A new chat starts only when no message waits for its answer and the service is there: the
  /// answer belongs with its question.
  public static func enabled(pending: Bool, connected: Bool) -> Bool { !pending && connected }
}
