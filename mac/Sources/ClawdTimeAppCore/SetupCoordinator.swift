import Combine
import Foundation

/// Drives one setup run: it starts the engine, turns its events into state,
/// sends the person's answers to its stdin, and hands the long-lived
/// processes to the owner when setup is finished.
@MainActor
public final class SetupCoordinator: ObservableObject {
  @Published public private(set) var state = SetupState()
  /// The step an answer was sent for, until the engine speaks about it again.
  @Published public private(set) var awaiting: StepID?
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

  public init(makeEngine: @escaping EngineFactory, owner: ProcessOwning?, open: @escaping (URL) -> Bool, helloTimeout: TimeInterval = 30) {
    self.makeEngine = makeEngine
    self.owner = owner
    self.open = open
    self.helloTimeout = helloTimeout
  }

  public var engineIsRunning: Bool { engine != nil }

  /// Starts (or starts again) the engine. A rerun resumes: ready steps are checked, not repeated.
  public func begin(local: Bool = false) {
    guard engine == nil else { return }
    run += 1
    let current = run
    state.begin()
    awaiting = nil
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
      self.awaiting = nil
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
    case .step(let step) where step.id == awaiting: awaiting = nil
    case .hello where state.phase != .running:
      // A protocol this app does not speak: leave before any step runs.
      engine?.cancel(grace: 2)
    case .done(let ready, _):
      awaiting = nil
      if ready && finishWhenReady { finish() }
    default: break
    }
  }

  /// Sends the answer for the step on screen.
  public func submit(_ value: InputValue) {
    guard state.phase == .running, let step = state.current, step.state == .needsInput, step.input != nil, awaiting == nil else { return }
    awaiting = step.id
    engine?.send(.input(id: step.id, value: value))
  }

  /// Retry, recheck or skip the step on screen. Only some steps may be skipped.
  public func perform(_ action: StepAction) {
    guard state.phase == .running, let step = state.current else { return }
    if action == .skip && !step.id.isSkippable { return }
    awaiting = step.id
    engine?.send(.action(id: step.id, action: action))
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
    guard let id = openedSettingsFor, state.phase == .running, state.focus == id, awaiting == nil,
      let step = state.current, step.state == .needsInput || step.state == .failed else { return }
    openedSettingsFor = nil
    perform(.recheck)
  }

  /// The local Stop: setup ends and the owner ends every process it started.
  public func stop(then done: (@MainActor () -> Void)? = nil) {
    run += 1
    engine?.cancel(grace: 2)
    engine = nil
    awaiting = nil
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
