import Foundation

/// Why setup cannot go on. The text is for the person at the Mac.
public struct SetupFailure: Equatable, Sendable {
  public enum Kind: Equatable, Sendable { case runtimeMissing, engineDidNotStart, noHello, incompatible, engineStopped }
  public var kind: Kind
  public var title: String
  public var detail: String
  public var details: [String]
  public init(kind: Kind, title: String, detail: String, details: [String] = []) {
    self.kind = kind; self.title = title; self.detail = detail; self.details = details
  }

  public static func runtimeMissing(_ problem: String) -> SetupFailure {
    SetupFailure(kind: .runtimeMissing, title: "This copy of ClawdTime is incomplete",
                 detail: "Download ClawdTime again and drag it to Applications.", details: [problem])
  }
  public static func engineDidNotStart() -> SetupFailure {
    SetupFailure(kind: .engineDidNotStart, title: "Setup could not start",
                 detail: "Download ClawdTime again and drag it to Applications, then open it.")
  }
  public static func noHello() -> SetupFailure {
    SetupFailure(kind: .noHello, title: "Setup did not answer",
                 detail: "Try again. If it happens again, download ClawdTime again.")
  }
  public static func incompatible(_ version: Int) -> SetupFailure {
    SetupFailure(kind: .incompatible, title: "This app and its setup do not match",
                 detail: "Download the latest ClawdTime and drag it to Applications.",
                 details: ["The setup engine speaks protocol \(version). This app speaks protocol \(SetupProtocol.version)."])
  }
  public static func engineStopped(code: Int32, details: [String]) -> SetupFailure {
    SetupFailure(kind: .engineStopped, title: "Setup stopped",
                 detail: "Your answers so far are kept. Try again to go on from here.",
                 details: details + ["Exit status \(code)."])
  }
}

/// Everything the setup window draws, built from the engine's events.
public struct SetupState: Equatable, Sendable {
  public enum Phase: Equatable, Sendable {
    /// Nothing runs yet.
    case idle
    /// The engine is starting and has not said hello.
    case connecting
    case running
    case finished(ready: Bool)
    case failed(SetupFailure)
    /// The person chose Stop.
    case stopped
  }

  public var phase: Phase = .idle
  public var engineVersion: String?
  /// The latest event of each step.
  public private(set) var steps: [StepID: StepEvent] = [:]
  /// The known steps in order, then any others in the order they came.
  public private(set) var order: [StepID] = StepID.order
  /// The step on screen: the latest one that is not pending.
  public private(set) var focus: StepID?
  public private(set) var report: [ReportEntry] = []
  public private(set) var warnings: [String] = []
  public private(set) var unreadableLines = 0

  public init() {}

  public var current: StepEvent? { focus.flatMap { steps[$0] } }
  public func state(of id: StepID) -> StepState { steps[id]?.state ?? .pending }
  public var settledCount: Int { order.filter { state(of: $0).isSettled }.count }
  /// From 0 to 1: the share of steps that are ready or skipped.
  public var progress: Double { order.isEmpty ? 0 : Double(settledCount) / Double(order.count) }
  /// The 1-based place of the focused step, for "Step 3 of 9".
  public var position: Int? { focus.flatMap { order.firstIndex(of: $0) }.map { $0 + 1 } }
  public var isActive: Bool { phase == .connecting || phase == .running }

  public mutating func begin() {
    self = SetupState()
    phase = .connecting
  }

  public mutating func apply(_ event: EngineEvent) {
    guard isActive else { return }
    switch event {
    case .hello(let version, let engine):
      engineVersion = engine
      if version != SetupProtocol.version {
        phase = .failed(.incompatible(version))
      } else {
        phase = .running
      }
    case .step(let step):
      phase = .running
      if !order.contains(step.id) { order.append(step.id) }
      steps[step.id] = step
      if step.state != .pending { focus = step.id }
    case .log(let level, let message):
      if level == "warn" { warn(message) }
    case .done(let ready, let report):
      self.report = report
      for entry in report where steps[entry.id] == nil || steps[entry.id]?.state != entry.state {
        var step = steps[entry.id] ?? StepEvent(id: entry.id, state: entry.state)
        step.state = entry.state
        if let detail = entry.detail { step.detail = detail }
        step.input = nil
        if !order.contains(entry.id) { order.append(entry.id) }
        steps[entry.id] = step
      }
      phase = .finished(ready: ready)
    case .unknown:
      break
    }
  }

  public mutating func unreadableLine() { unreadableLines += 1 }

  public mutating func noHello() {
    if phase == .connecting { phase = .failed(.noHello()) }
  }

  /// The engine ended. Before `done` that is a failure; after it, or after Stop, it is expected.
  public mutating func engineExited(code: Int32, details: [String]) {
    switch phase {
    case .connecting:
      phase = .failed(code == 126 || code == 127 ? .engineDidNotStart() : .engineStopped(code: code, details: details))
    case .running:
      phase = .failed(.engineStopped(code: code, details: details))
    default: break
    }
  }

  public mutating func fail(_ failure: SetupFailure) { phase = .failed(failure) }
  public mutating func stopped() { phase = .stopped }

  private mutating func warn(_ message: String) {
    let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    warnings.append(String(text.prefix(300)))
    if warnings.count > 5 { warnings.removeFirst(warnings.count - 5) }
  }

  /// The report, or, before `done`, each step's latest state.
  public var summary: [ReportEntry] {
    if !report.isEmpty { return report }
    return order.compactMap { id in steps[id].map { ReportEntry(id: id, state: $0.state, detail: $0.detail) } }
  }
  /// What the final report says about one step.
  public func reported(_ id: StepID) -> StepState? { report.first { $0.id == id }?.state }
}
