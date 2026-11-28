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
  /// True from Stop or Quit until every stopped engine has left. An engine
  /// first ends the desktop that it was starting, which can take a while.
  @Published public private(set) var isStopping = false
  /// A desktop service that setup started may still run with no owner: the
  /// last report said so, or the engine left before its report. Stop and
  /// Quit then end it; Finish hands it to the owner.
  @Published public private(set) var holdsSetupDesktop = false
  /// Stop has something to end: a running engine or a desktop that setup started.
  public var canStop: Bool { engine != nil || holdsSetupDesktop }
  private var draining = 0
  private var afterDrain: [@MainActor () -> Void] = []
  private var beginQueued = false

  /// Which setup runs now: the first run, or the later phone run.
  @Published public private(set) var setupRun = SetupRun.first

  public typealias EngineFactory = @MainActor (_ run: SetupRun) throws -> EngineControlling
  private let makeEngine: EngineFactory
  private let owner: ProcessOwning?
  private let open: (URL) -> Bool
  private let helloTimeout: TimeInterval
  private var engine: EngineControlling?
  private var run = 0
  private var openedSettingsFor: StepID?
  /// Asks macOS once in a run for each permission that the engine says is missing.
  private let permissionRequests: PermissionRequests?
  /// Runs the reset of ClawdTime's own permissions when the person clicks it.
  private let resetRunner: CommandRunning?
  @Published public private(set) var permissionReset = PermissionResetState.idle
  /// Set for a launch after setup was done once: a ready result finishes by itself.
  public var finishWhenReady = false
  public var onFinish: (() -> Void)?

  public init(makeEngine: @escaping EngineFactory, owner: ProcessOwning?, open: @escaping (URL) -> Bool, helloTimeout: TimeInterval = 30,
              answerDelay: TimeInterval = SetupCoordinator.defaultAnswerDelay, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
              permissions: PermissionRequests? = nil, resetRunner: CommandRunning? = nil) {
    self.makeEngine = makeEngine
    self.permissionRequests = permissions
    self.resetRunner = resetRunner
    self.owner = owner
    self.open = open
    self.helloTimeout = helloTimeout
    self.answerDelay = max(0, answerDelay)
    self.now = now
  }

  /// Longer than the double-click time of macOS by default.
  nonisolated public static let defaultAnswerDelay: TimeInterval = 0.6
  /// After Stop the engine ends the desktop that it was starting: a cold
  /// first start, then the stop of its service. SIGTERM comes only after this
  /// time and SIGKILL after twice it.
  nonisolated public static let stopGrace: TimeInterval = 20

  /// The step on screen asks this question, and its buttons work now.
  public func accepts(_ question: String) -> Bool {
    guard let shown, shown.question == question, answered == nil else { return false }
    return now() - shown.at >= answerDelay
  }

  public var engineIsRunning: Bool { engine != nil }

  /// Starts (or starts again) the engine. A rerun resumes: ready steps are checked, not repeated.
  public func begin(local: Bool = false) { begin(SetupRun(local: local)) }

  /// Get calls on your phone: the later, optional run. It verifies the phone,
  /// pairs this Mac and connects it, each with its own consent.
  public func beginPhone() { begin(.phone) }

  public func begin(_ requested: SetupRun) {
    guard engine == nil else { return }
    // Two engines never run at once: a stopped one leaves first.
    guard draining == 0 else {
      if !beginQueued {
        beginQueued = true
        afterDrain.append { [weak self] in
          self?.beginQueued = false
          self?.begin(requested)
        }
      }
      return
    }
    run += 1
    let current = run
    setupRun = requested
    state.begin()
    // Each run asks macOS once more for a permission that is still missing.
    permissionRequests?.rearmAll()
    permissionReset = .idle
    answered = nil
    shown = nil
    handedOff = false
    let engine: EngineControlling
    do { engine = try makeEngine(requested) } catch {
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
      // An engine that left before its report may have left a desktop.
      if self.state.isActive { self.holdsSetupDesktop = true }
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
      // macOS shows its own dialog and lists this build: once in a run.
      if step.id == .permissions, step.state == .needsInput, let needs = step.permissions {
        permissionRequests?.ask(needs.kinds)
      }
    case .hello where state.phase != .running:
      // A protocol this app does not speak: leave before any step runs.
      engine?.cancel(grace: 2)
    case .done(let ready, _, let setupDesktop):
      answered = nil
      holdsSetupDesktop = setupDesktop
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

  /// The step on screen says that macOS holds the permission of an older
  /// build, and this app can reset ClawdTime's own permissions.
  public var offersPermissionReset: Bool {
    guard resetRunner != nil, state.phase == .running, let step = state.current,
      step.id == .permissions, step.state == .needsInput, let needs = step.permissions else { return false }
    return needs.stale && !needs.kinds.isEmpty
  }
  /// The reset is offered and does not run now.
  public var canResetPermissions: Bool { offersPermissionReset && permissionReset != .running }

  /// Reset ClawdTime permissions: removes only ClawdTime's own entries of
  /// the permissions that are still off, then asks macOS again, so that the
  /// list shows this build. The engine checks again by itself.
  @discardableResult
  public func resetPermissions() -> Task<Void, Never>? {
    guard canResetPermissions, let runner = resetRunner, let kinds = state.current?.permissions?.kinds else { return nil }
    let current = run
    permissionReset = .running
    return Task { [weak self] in
      let worked = await PermissionReset.run(kinds, runner: runner)
      guard let self, current == self.run else { return }
      self.permissionReset = worked ? .done : .failed
      guard worked else { return }
      self.permissionRequests?.rearm(kinds)
      self.permissionRequests?.ask(kinds)
    }
  }

  /// Cancels an engine and counts it until it has left.
  private func drain(_ engine: EngineControlling) {
    draining += 1
    isStopping = true
    engine.cancel(grace: Self.stopGrace) { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.draining -= 1
        guard self.draining == 0 else { return }
        self.isStopping = false
        let waiting = self.afterDrain
        self.afterDrain = []
        waiting.forEach { $0() }
      }
    }
  }

  /// No engine runs, but a desktop that setup started may: an engine that
  /// is cancelled at once ends it (only that one, checked by its process).
  private func endSetupDesktop() {
    guard holdsSetupDesktop else { return }
    holdsSetupDesktop = false
    guard let cleanup = try? makeEngine(.first) else { return }
    do { try cleanup.start() } catch { return }
    drain(cleanup)
  }

  private func whenDrained(_ action: @escaping @MainActor () -> Void) {
    if draining == 0 { action() } else { afterDrain.append(action) }
  }

  /// The local Stop: setup ends and the owner ends every process it started.
  /// `done` runs when the owner has stopped and the engine has left.
  public func stop(then done: (@MainActor () -> Void)? = nil) {
    run += 1
    // A running engine ends what setup started when it reads the cancel.
    if let engine { drain(engine); holdsSetupDesktop = false } else { endSetupDesktop() }
    engine = nil
    answered = nil
    handedOff = false
    state.stopped()
    let finish: @MainActor () -> Void = { [weak self] in
      guard let self else { done?(); return }
      self.whenDrained { done?() }
    }
    guard let owner else { finish(); return }
    owner.stop { finish() }
  }

  /// Setup is done: start what the report says is ready. `chat`: the panel
  /// opens with the chat in focus and one first request (Start talking).
  public func finish(chat: Bool = false) {
    guard case .finished = state.phase else { return }
    let desktopReady = state.reported(.desktop) == .ready
    let connectionReady = state.reported(.connection) == .ready
    // The owner takes over the desktop that setup started.
    if desktopReady, let owner { owner.start(connection: connectionReady, chat: chat); holdsSetupDesktop = false }
    handedOff = true
    onFinish?()
  }

  /// The bundled runtime is missing or damaged: setup cannot run at all.
  public func reportRuntimeProblem(_ problem: String) {
    run += 1
    engine = nil
    state.fail(.runtimeMissing(problem))
  }

  /// Quit: ends the engine and every owned process, then calls `done` once
  /// the engine has left.
  public func shutdown(then done: @escaping @MainActor () -> Void) {
    run += 1
    if let engine { drain(engine); holdsSetupDesktop = false } else { endSetupDesktop() }
    engine = nil
    let finish: @MainActor () -> Void = { [weak self] in
      guard let self else { done(); return }
      self.whenDrained(done)
    }
    guard let owner else { finish(); return }
    owner.stop { finish() }
  }
}
