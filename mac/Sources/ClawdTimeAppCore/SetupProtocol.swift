import Foundation

/// The setup protocol that `clawdtime onboard --json` speaks: one JSON object per
/// line, events on its stdout and commands on its stdin.
public enum SetupProtocol {
  /// The protocol version this app speaks. `hello` must carry it. In 2 each
  /// question has a one-time id, and every answer names it.
  public static let version = 2
  /// The engine is started with these arguments and no others. A secret never
  /// goes on a command line: the app writes every input to the engine's stdin.
  /// `--app` says that the app owns the long-lived processes: setup opens no
  /// panel and starts no background connection, and the app starts the one
  /// desktop and the one connection when setup ends.
  public static func arguments(local: Bool) -> [String] {
    local ? ["onboard", "--json", "--app", "--local"] : ["onboard", "--json", "--app"]
  }
}

/// A setup step. The ids are fixed by the protocol; an id the app does not know
/// is kept and drawn from its event, after the known ones.
public struct StepID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(stringLiteral value: String) { rawValue = value }
  public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
  public var description: String { rawValue }

  public static let preflight: StepID = "preflight"
  public static let model: StepID = "model"
  public static let desktop: StepID = "desktop"
  public static let computer: StepID = "computer"
  public static let permissions: StepID = "permissions"
  public static let phone: StepID = "phone"
  public static let pairing: StepID = "pairing"
  public static let connection: StepID = "connection"
  public static let ready: StepID = "ready"

  /// The steps in the order the engine runs them.
  public static let order: [StepID] = [.preflight, .model, .desktop, .computer, .permissions, .phone, .pairing, .connection, .ready]
  /// Only these steps accept `skip`.
  public static let skippable: Set<StepID> = [.phone, .pairing, .connection, .computer]
  public var isSkippable: Bool { Self.skippable.contains(self) }

  /// The title the app shows until the engine sends its own.
  public var fallbackTitle: String {
    switch self {
    case .preflight: "Check this Mac"
    case .model: "Model key"
    case .desktop: "Desktop"
    case .computer: "Computer use"
    case .permissions: "Permissions"
    case .phone: "Your phone"
    case .pairing: "Pair this Mac"
    case .connection: "Connection"
    case .ready: "Ready"
    default: rawValue.prefix(1).uppercased() + rawValue.dropFirst()
    }
  }
}

public enum StepState: String, Codable, Sendable {
  case pending
  case inProgress = "in_progress"
  case needsInput = "needs_input"
  case ready, failed, skipped

  /// The step is over, one way or the other.
  public var isSettled: Bool { self == .ready || self == .skipped }
}

public struct Recovery: Codable, Equatable, Sendable {
  public enum Action: String, Codable, Sendable {
    case retry
    case openSettings = "open_settings"
    case openURL = "open_url"
  }
  public var label: String
  public var action: Action
  public var url: String?
  public init(label: String, action: Action, url: String? = nil) {
    self.label = label; self.action = action; self.url = url
  }
}

public struct InputOption: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var label: String
  public var detail: String?
  public init(id: String, label: String, detail: String? = nil) {
    self.id = id; self.label = label; self.detail = detail
  }
}

public struct StepInput: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case secret, text, choice, confirm, phone, code }
  public var kind: Kind
  public var prompt: String?
  public var options: [InputOption]?
  public var multiple: Bool?
  /// The answer gives or refuses consent. Such a question has no default button.
  public var consent: Bool?
  public init(kind: Kind, prompt: String? = nil, options: [InputOption]? = nil, multiple: Bool? = nil, consent: Bool? = nil) {
    self.kind = kind; self.prompt = prompt; self.options = options; self.multiple = multiple; self.consent = consent
  }
  public var allowsMany: Bool { multiple ?? false }
}

public struct StepEvent: Codable, Equatable, Sendable {
  public var id: StepID
  public var state: StepState
  public var title: String?
  /// Plain words for the person, with no file path.
  public var detail: String?
  /// Lines shown only when the person opens Details, such as the full path of a binary.
  public var details: [String]?
  public var recovery: Recovery?
  public var input: StepInput?
  /// The one-time id of the question this event asks. An answer must name it.
  public var question: String?
  public init(id: StepID, state: StepState, title: String? = nil, detail: String? = nil, details: [String]? = nil, recovery: Recovery? = nil, input: StepInput? = nil, question: String? = nil) {
    self.id = id; self.state = state; self.title = title; self.detail = detail; self.details = details; self.recovery = recovery; self.input = input; self.question = question
  }
  public var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? id.fallbackTitle }
}

public struct ReportEntry: Codable, Equatable, Sendable, Identifiable {
  public var id: StepID
  public var state: StepState
  public var detail: String?
  public init(id: StepID, state: StepState, detail: String? = nil) { self.id = id; self.state = state; self.detail = detail }
}

/// One event from the engine.
public enum EngineEvent: Equatable, Sendable {
  case hello(protocol: Int, version: String)
  case step(StepEvent)
  case log(level: String, message: String)
  /// `setupDesktop`: a desktop service that setup started still runs and no
  /// owner holds it. The owner takes it on Finish; Stop and Quit end it.
  case done(ready: Bool, report: [ReportEntry], setupDesktop: Bool)
  /// A type this app does not know. It is ignored.
  case unknown(type: String)

  public enum DecodeError: Error, Equatable { case notJSON, missingType, invalid(String) }

  private struct Envelope: Decodable { var type: String }
  private struct Hello: Decodable { var `protocol`: Int; var version: String }
  private struct Log: Decodable { var level: String; var message: String }
  private struct Done: Decodable { var ready: Bool; var report: [ReportEntry]?; var setupDesktop: Bool? }

  public static func decode(line: String) throws -> EngineEvent {
    guard let data = line.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
      throw DecodeError.notJSON
    }
    let decoder = JSONDecoder()
    guard let envelope = try? decoder.decode(Envelope.self, from: data) else { throw DecodeError.missingType }
    do {
      switch envelope.type {
      case "hello":
        let hello = try decoder.decode(Hello.self, from: data)
        return .hello(protocol: hello.protocol, version: hello.version)
      case "step": return .step(try decoder.decode(StepEvent.self, from: data))
      case "log":
        let log = try decoder.decode(Log.self, from: data)
        return .log(level: log.level, message: log.message)
      case "done":
        let done = try decoder.decode(Done.self, from: data)
        return .done(ready: done.ready, report: done.report ?? [], setupDesktop: done.setupDesktop ?? false)
      default: return .unknown(type: envelope.type)
      }
    } catch {
      throw DecodeError.invalid(envelope.type)
    }
  }
}

public enum StepAction: String, Sendable { case retry, recheck, skip }

/// The value of an input: a string, a boolean or a list of strings.
public enum InputValue: Equatable, Sendable {
  case string(String), bool(Bool), strings([String])
  var json: Any {
    switch self {
    case .string(let value): value
    case .bool(let value): value
    case .strings(let value): value
    }
  }
}

/// One command to the engine. Its description never shows an input's value,
/// so a command can never put a key in a log by accident.
/// An input or an action names the question it answers: the engine refuses
/// one for an earlier, repeated or unknown question.
public enum EngineCommand: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  case input(id: StepID, question: String, value: InputValue)
  case action(id: StepID, question: String, action: StepAction)
  case cancel

  /// The command as one line of JSON, with its newline. JSON escapes every
  /// newline inside a value, so the command is always exactly one line.
  public func line() -> Data {
    let object: [String: Any]
    switch self {
    case .input(let id, let question, let value): object = ["type": "input", "id": id.rawValue, "question": question, "value": value.json]
    case .action(let id, let question, let action): object = ["type": "action", "id": id.rawValue, "question": question, "action": action.rawValue]
    case .cancel: object = ["type": "cancel"]
    }
    var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{\"type\":\"cancel\"}".utf8)
    data.append(0x0A)
    return data
  }

  public var description: String {
    switch self {
    case .input(let id, _, _): "input(\(id.rawValue), <redacted>)"
    case .action(let id, _, let action): "action(\(id.rawValue), \(action.rawValue))"
    case .cancel: "cancel"
    }
  }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["command": description]) }
}
