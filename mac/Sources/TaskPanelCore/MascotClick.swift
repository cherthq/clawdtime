import Foundation

/// What a click on the mascot or on its bubble opens. ClawdTime is a computer use agent: the chat,
/// where the person gives it work, is the one sheet that opens. No list of coding sessions opens
/// from here. A bubble about one session that waits for the person still opens that session.
public enum MascotClick: Equatable, Sendable {
  /// The chat with ClawdTime.
  case openChat
  /// The terminal of one session.
  case openSession(String)
  /// A tucked mascot comes back out from the edge.
  case undock
  /// The person dragged the mascot: the drag was the whole action.
  case none

  /// The press on the mascot ended.
  public static func release(didDrag: Bool, docked: Bool) -> MascotClick {
    if didDrag { return .none }
    return docked ? .undock : .openChat
  }
  /// A click on the bubble. A bubble about one session opens that session. Every other one,
  /// a caption, a request, news of several sessions, opens the chat.
  public static func bubble(_ bubble: PetStatus.Bubble) -> MascotClick {
    if !bubble.caption, let session = bubble.sessionId { return .openSession(session) }
    return .openChat
  }
  /// The tooltip of the bubble: what a click on it does.
  public static func hint(_ bubble: PetStatus.Bubble) -> String {
    switch self.bubble(bubble) {
    case .openSession: return "Open this session's terminal"
    default: return bubble.decisionId != nil ? "Answer here, or click to open the chat" : "Open the chat"
    }
  }
}
