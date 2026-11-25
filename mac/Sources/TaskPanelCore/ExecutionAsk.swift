import Foundation

/// A question of the computer worker that waits for the person. The panel shows its small
/// window only while one waits: the question, Approve and No. It hides at once when none waits.
/// Nothing else of the work shows there: no status line and no running message.
public struct ExecutionAsk: Equatable, Sendable {
  /// How the answer goes back.
  public enum Route: Equatable, Sendable {
    /// One action that the engine holds for a yes. The answer goes to its decision route, for this id only.
    case action(id: String)
    /// A question of the worker in the chat. The answer goes as the person's own words, through the
    /// same gate as a typed "yes" or "no".
    case words
  }
  public let text: String
  public let route: Route
  /// Changes when the question changes, so that one question takes one answer.
  public let key: String

  /// The words that Approve and No send for a question of the worker.
  public static let yes = "yes", no = "no"

  /// The question that waits now, or nil. An approval or a question of the worker counts, and so
  /// does an action that the engine holds for a yes. A pause because the person took over the Mac
  /// is no question: the bar with Stop says "Waiting for you" then.
  public static func current(_ execution: ChatExecution?) -> ExecutionAsk? {
    guard let execution, execution.configured else { return nil }
    if let action = execution.pendingAction {
      return ExecutionAsk(text: action.description, route: .action(id: action.id), key: "action|" + action.id)
    }
    guard execution.state == "waiting_for_person", let waiting = execution.waiting, ["approval", "question"].contains(waiting) else { return nil }
    let text = execution.message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    return ExecutionAsk(text: text, route: .words, key: "words|" + waiting + "|" + text)
  }

  /// Approve and No work only while the panel is connected, nothing else of the person is on its way,
  /// and this question was not answered yet. An action that waits also needs the decision lane free.
  public static func canAnswer(_ ask: ExecutionAsk, control: ChatExecutionControl, answers: ExecutionAskAnswers,
                               chatBusy: Bool, connected: Bool) -> Bool {
    guard connected else { return false }
    switch ask.route {
    case .action(let id): return control.canDecide && control.execution?.pendingAction?.id == id
    case .words: return !chatBusy && !control.stopping && answers.canAnswer(ask)
    }
  }
}

/// One answer for each question that shows. A second click sends nothing, and neither does a read
/// that shows the same question again. A question that left and comes back can be answered again.
/// An answer whose result is not known is never sent a second time by the panel.
public struct ExecutionAskAnswers: Equatable, Sendable {
  private var answered: String?
  public init() {}
  /// The question that the newest read shows. An answer is forgotten once its question no longer shows.
  public mutating func observe(_ ask: ExecutionAsk?) { if ask?.key != answered { answered = nil } }
  public func canAnswer(_ ask: ExecutionAsk) -> Bool { answered != ask.key }
  @discardableResult public mutating func begin(_ ask: ExecutionAsk) -> Bool {
    guard canAnswer(ask) else { return false }
    answered = ask.key
    return true
  }
}

/// The bar with Stop shows during every run. The panel's own hands show their bar themselves. For any
/// other engine the panel shows the same bar while that engine reports work that can still stop, and
/// while a Stop of the person is on its way or not yet confirmed.
public enum ExecutionStopBar {
  public static func shows(_ control: ChatExecutionControl, ownHands: Bool, connected: Bool) -> Bool {
    guard !ownHands, connected else { return false }
    if control.stopping || control.awaitingRead { return true }
    guard let execution = control.execution, execution.configured else { return false }
    return execution.canStop || ["stopping", "stop_requested"].contains(execution.state)
  }
}
