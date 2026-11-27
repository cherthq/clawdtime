import Combine
import Foundation

/// Drives one setup run: it starts the engine, turns its events into state,
/// sends the person's answers to its stdin, and hands the long-lived
/// processes to the owner when setup is finished.
@MainActor
public final class SetupCoordinator: ObservableObject {
  @Published public private(set) var state = SetupState()
  /// The question an answer was sent for, until the engine asks another one
  /// or moves on. One answer goes out for each question.
  @Published public private(set) var answered: String?
  /// The buttons of each new question work only this long after it appears,
  /// so that the second click of a double click never answers the next
  /// question. The window uses the same time to show them disabled.
  public let answerDelay: TimeInterval
  private let now: () -> TimeInterval
  /// The question on screen and when it appeared.
  private var shown: (question: String, at: TimeInterval)?
  /// True from Finish until the next setup run: the owner holds the processes.
  @Published public private(set) var handedOff = false

  public typealias EngineFactory = @MainActor (_ local: Bool) throws -> EngineControlling
  private let makeEngine: EngineFactory
  private let owner: ProcessOwning?
  private let open: (URL) -> Bool
  private let helloTimeout: TimeInterval
  private var engine: EngineControlling?
  private var run = 0
  private var openedSettingsFor: StepID?
  /// Set for a launch after setup was done once: a ready result finishes by itself.
  public var finishWhenReady = false
  public var onFinish: (() -> Void)?

  public init(makeEngine: @escaping EngineFactory, owner: ProcessOwning?, open: @escaping (URL) -> Bool, helloTimeout: TimeInterval = 30,
              answerDelay: TimeInterval = SetupCoordinator.defaultAnswerDelay, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.makeEngine = makeEngine
    self.owner = owner
    self.open = open
    self.helloTimeout = helloTimeout
    self.answerDelay = max(0, answerDelay)
    self.now = now
  }

  /// Longer than the double-click time of macOS by default.
  nonisolated public static let defaultAnswerDelay: TimeInterval = 0.6

  /// The step on screen asks this question, and its buttons work now.
  public func accepts(_ question: String) -> Bool {
    guard let shown, shown.question == question, answered == nil else { return false }
    return now() - shown.at >= answerDelay
  }

  public var engineIsRunning: Bool { engine != nil }

  /// Starts (or starts again) the engine. A rerun resumes: ready steps are checked, not repeated.
  public func begin(local: Bool = false) {
    guard engine == nil else { return }
    run += 1
    let current = run
    state.begin()
    answered = nil
    shown = nil
    handedOff = false
    let engine: EngineControlling
    do { engine = try makeEngine(local) } catch {
      state.fail(.engineDidNotStart())
      return
    }
    engine.onEvent = { [weak self] event in
      guard let self, current == self.run else { return }
      self.receive(event)
    }
    engine.onUnreadableLine = { [weak self] in
      guard let self, current == self.run else { return }
      self.state.unreadableLine()
    }
    engine.onExit = { [weak self] code, details in
      guard let self, current == self.run else { return }
      self.engine = nil
      self.answered = nil
      self.state.engineExited(code: code, details: details)
    }
    self.engine = engine
    do { try engine.start() } catch {
      self.engine = nil
      state.fail(.engineDidNotStart())
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + helloTimeout) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, current == self.run, self.state.phase == .connecting else { return }
        self.state.noHello()
        self.engine?.cancel(grace: 2)
      }
    }
  }

  private func receive(_ event: EngineEvent) {
    state.apply(event)
    switch event {
    case .step(let step):
      // A new question, or any other news from the engine, ends the wait.
      if step.question != answered { answered = nil }
      if let question = step.question, question != shown?.question { shown = (question, now()) }
    case .hello where state.phase != .running:
      // A protocol this app does not speak: leave before any step runs.
      engine?.cancel(grace: 2)
    case .done(let ready, _):
      answered = nil
      if ready && finishWhenReady { finish() }
    default: break
    }
  }

  /// Sends the one answer to the question on screen.
  public func submit(_ value: InputValue) {
    guard state.phase == .running, let step = state.current, step.state == .needsInput, step.input != nil,
      let question = step.question, accepts(question) else { return }
    answered = question
    engine?.send(.input(id: step.id, question: question, value: value))
  }

  /// Retry, recheck or skip the question on screen. Only some steps may be skipped.
  public func perform(_ action: StepAction) {
    guard state.phase == .running, let step = state.current, let question = step.question, accepts(question) else { return }
    if action == .skip && !step.id.isSkippable { return }
    answered = question
    engine?.send(.action(id: step.id, question: question, action: action))
  }

  /// Follows the step's recovery: Retry, or a System Settings pane or https page.
  @discardableResult
  public func followRecovery() -> Bool {
    guard let step = state.current, let recovery = step.recovery else { return false }
    switch recovery.action {
    case .retry:
      perform(.retry)
      return true
    case .openSettings, .openURL:
      guard let url = InputRules.recoveryURL(recovery), open(url) else { return false }
      if recovery.action == .openSettings { openedSettingsFor = step.id }
      return true
    }
  }

  /// The person came back to the app: check again a step that sent them to System Settings.
  public func applicationDidBecomeActive() {
    guard let id = openedSettingsFor, state.phase == .running, state.focus == id, answered == nil,
      let step = state.current, step.state == .needsInput || step.state == .failed else { return }
    openedSettingsFor = nil
    perform(.recheck)
  }

  /// The local Stop: setup ends and the owner ends every process it started.
  public func stop(then done: (@MainActor () -> Void)? = nil) {
    run += 1
    engine?.cancel(grace: 2)
    engine = nil
    answered = nil
    handedOff = false
    state.stopped()
    guard let owner else { done?(); return }
    owner.stop { done?() }
  }

  /// Setup is done: start what the report says is ready.
  public func finish() {
    guard case .finished = state.phase else { return }
    let desktopReady = state.reported(.desktop) == .ready
    let connectionReady = state.reported(.connection) == .ready
    if desktopReady { owner?.start(connection: connectionReady) }
    handedOff = true
    onFinish?()
  }

  /// The bundled runtime is missing or damaged: setup cannot run at all.
  public func reportRuntimeProblem(_ problem: String) {
    run += 1
    engine = nil
    state.fail(.runtimeMissing(problem))
  }

  /// Quit: ends the engine and every owned process, then calls `done`.
  public func shutdown(then done: @escaping @MainActor () -> Void) {
    run += 1
    engine?.cancel(grace: 2)
    engine = nil
    guard let owner else { done(); return }
    owner.stop(completion: done)
  }
}
