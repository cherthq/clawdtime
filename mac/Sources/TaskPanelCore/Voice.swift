import Foundation

/// The conversation with ClawdTime, as the task service reports it.
public struct ChatTranscript: Codable, Equatable {
  public struct Message: Codable, Equatable {
    public let role: String
    public let text: String
    public let at: Double
    public let via: String
    /// Answers that the person can pick with one click, when ClawdTime passes on a question. Absent for most messages.
    public let choices: [String]?
    public init(role: String, text: String, at: Double, via: String, choices: [String]? = nil) {
      self.role = role; self.text = text; self.at = at; self.via = via; self.choices = choices
    }
    public var mine: Bool { role == "user" }
    /// The choices to show as buttons: only on ClawdTime's own message, at most four short ones.
    public var offered: [String] {
      guard !mine, let choices, (1...4).contains(choices.count), choices.allSatisfy({ (1...80).contains($0.count) }) else { return [] }
      return choices
    }
  }
  public let version: Int
  /// A language model answers. Without one ClawdTime tells the state and takes a clear yes or no.
  public let model: Bool
  public let speech: Bool
  public let voiceDirectory: String
  /// The person turned memory on. A service that does not say counts as off.
  public let memory: Bool?
  public let messages: [Message]
  public let execution: ChatExecution?
  public init(version: Int, model: Bool, speech: Bool, voiceDirectory: String, messages: [Message], memory: Bool? = nil, execution: ChatExecution? = nil) {
    self.version = version; self.model = model; self.speech = speech; self.voiceDirectory = voiceDirectory; self.messages = messages
    self.memory = memory; self.execution = execution
  }
  /// True when the transcript already holds what the person just sent. The service writes the person's message
  /// down before it answers, so the message that is still being answered must not be drawn a second time.
  public static func holdsPending(_ messages: [Message], pending: String?) -> Bool {
    guard let pending, let last = messages.last, last.mine else { return false }
    let plain: (String) -> String = { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    return plain(last.text) == plain(pending)
  }
  public func validate() throws {
    try execution?.validate()
    guard version == 1, messages.count <= 400, voiceDirectory.hasPrefix("/"), voiceDirectory.count <= 4096,
      messages.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.text.count <= 2000 && ["chat", "voice", "call"].contains($0.via)
        && ($0.choices ?? []).count <= 4 && ($0.choices ?? []).allSatisfy { (1...80).contains($0.count) } })
    else { throw PanelFailure.response }
  }
}
/// Optional same-chat executor metadata. It grants no desktop or capture authority.
public struct ChatPendingAction: Codable, Equatable {
  public let id: String
  public let description: String
  public init(id: String, description: String) { self.id = id; self.description = description }
  public func validate() throws {
    guard id.range(of: "^[A-Za-z0-9_-]{1,160}$", options: .regularExpression) != nil,
      (1...2000).contains(description.count), !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw PanelFailure.response
    }
  }
}
public struct ChatExecution: Codable, Equatable {
  public let configured: Bool
  public let state: String
  public let canStop: Bool
  public let message: String
  public let mode: String?
  public let pendingAction: ChatPendingAction?
  public init(configured: Bool, state: String, canStop: Bool, message: String, pendingAction: ChatPendingAction? = nil, mode: String? = nil) {
    self.configured = configured; self.state = state; self.canStop = canStop; self.message = message; self.pendingAction = pendingAction; self.mode = mode
  }
  public func validate() throws {
    guard mode == nil || ["native", "browser"].contains(mode!) else { throw PanelFailure.response }
    try pendingAction?.validate()
    guard pendingAction == nil || configured else { throw PanelFailure.response }
    guard (1...80).contains(state.count), !state.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      state.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
      message.count <= 2000, configured || !canStop else { throw PanelFailure.response }
  }
}
public struct ChatExecutionReply: Codable, Equatable { public let execution: ChatExecution }

/// Stop has its own lane, independent of a pending chat/voice answer. Reads
/// started before Stop or its response cannot restore an old execution affordance.
public struct ChatExecutionControl: Equatable {
  public private(set) var execution: ChatExecution?
  public private(set) var generation: UInt64 = 0
  public private(set) var stopping = false
  public private(set) var awaitingRead = false
  public private(set) var notice: String?
  public private(set) var deciding: String?
  private var decisionGeneration: UInt64?
  private var attemptedDecisions = Set<String>()
  public init() {}
  public var canDecide: Bool {
    guard let action = execution?.pendingAction else { return false }
    return !stopping && !awaitingRead && deciding == nil && !attemptedDecisions.contains(action.id) && attemptedDecisions.count < 10000
  }
  @discardableResult public mutating func beginDecision(_ id: String) -> Bool {
    guard canDecide, execution?.pendingAction?.id == id else { return false }
    generation &+= 1; decisionGeneration = generation; deciding = id
    attemptedDecisions.insert(id); notice = "Sending your decision."
    return true
  }
  public mutating func finishDecision(_ id: String, value: ChatExecution?) {
    guard deciding == id else { return }
    deciding = nil
    let admitted = decisionGeneration; decisionGeneration = nil
    // Stop is independent and always wins over a late decision response.
    guard admitted == generation else { return }
    generation &+= 1
    if let value { execution = value; notice = nil }
    else { notice = "Action decision could not be confirmed. Checking status without sending it again." }
  }
  public var canStop: Bool { execution?.canStop == true && !stopping && !awaitingRead }
  public mutating func receive(_ value: ChatExecution?, readGeneration: UInt64) {
    guard generation == readGeneration, !stopping, deciding == nil else { return }
    execution = value; awaitingRead = false; notice = nil
  }
  @discardableResult public mutating func beginStop() -> Bool {
    guard canStop else { return false }
    generation &+= 1; stopping = true
    notice = "Requesting stop; an action already underway may finish."
    return true
  }
  public mutating func finishStop(_ value: ChatExecution?) {
    guard stopping else { return }
    generation &+= 1; stopping = false
    if let value {
      execution = value; awaitingRead = false
      notice = "Stop requested; an action already underway may finish."
    } else {
      awaitingRead = true
      notice = "Stop could not be confirmed. An action already underway may finish."
    }
  }
}

public struct ChatReply: Codable, Equatable { public let reply: ChatTranscript.Message }
public struct VoiceReply: Codable, Equatable {
  public let heard: String
  public let reply: ChatTranscript.Message?
  public let audio: String?
  /// The spoken answer is one file the service wrote, never a path from elsewhere.
  public var audioName: String? {
    guard let audio, audio.range(of: "^reply-[a-z0-9]{1,20}\\.mp3$", options: .regularExpression) != nil else { return nil }
    return audio
  }
}

/// The loudness of the voice as one smooth number from 0 to 1, for the level bars and the mascot.
public struct VoiceMeter: Equatable, Sendable {
  public private(set) var level = 0.0
  public init() {}
  /// `rms` is the root mean square of one buffer of samples between -1 and 1.
  public mutating func feed(rms: Double) {
    let decibels = 20 * log10(max(rms, 0.000_001))
    let target = max(0, min(1, (decibels + 50) / 40))
    // It rises fast and falls slowly, as a meter does.
    level += (target - level) * (target > level ? 0.55 : 0.14)
  }
  public mutating func rest() { level = 0 }
  /// Bar heights from 0 to 1. The middle bars are the tallest, and they move a little on their own.
  public func bars(_ count: Int, phase: Double) -> [Double] {
    (0..<max(1, count)).map { index in
      let center = 1 - abs(Double(index) - Double(count - 1) / 2) / max(1, Double(count) / 2)
      let wave = 0.72 + 0.28 * sin(phase * 7 + Double(index) * 1.7)
      return max(0.14, min(1, 0.14 + level * (0.45 + 0.55 * center) * wave))
    }
  }
}

/// Finds one spoken sentence in a stream of levels: when the person starts, and when they are done.
public struct VoiceActivity: Equatable, Sendable {
  public enum Event: Equatable, Sendable { case none, started, ended, discard }
  public private(set) var speaking = false
  private var loud = 0.0, quiet = 0.0, total = 0.0
  public init() {}
  public mutating func reset() { self = VoiceActivity() }
  public mutating func feed(level: Double, seconds: Double) -> Event {
    total += seconds
    if !speaking {
      loud = level > 0.30 ? loud + seconds : 0
      if loud >= 0.12 { speaking = true; quiet = 0; return .started }
      // Nothing was said: the recording so far is thrown away and a new one starts.
      return total > 6 ? .discard : .none
    }
    quiet = level < 0.20 ? quiet + seconds : 0
    // A pause of a little more than a second ends the sentence. So does half a minute of talk.
    return quiet >= 1.1 || total > 30 ? .ended : .none
  }
}

/// UI-only handoff policy: withdrawing our editor never activates another app.
public enum NativeExecutionPresentation {
  public static func releasesEditor(_ execution: ChatExecution?) -> Bool {
    execution?.configured == true && execution?.mode == "native"
  }
  public static func visible(_ execution: ChatExecution?, submissionPending: Bool, stopping: Bool) -> Bool {
    releasesEditor(execution) && (submissionPending || stopping || execution?.canStop == true || execution?.pendingAction != nil)
  }
}
