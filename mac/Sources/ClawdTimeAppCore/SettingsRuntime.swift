import Foundation

/// A value of one setting, as `clawdtime settings --json` prints it.
public enum SettingValue: Decodable, Equatable, Sendable {
  case bool(Bool)
  case number(Double)
  case text(String)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Bool.self) { self = .bool(value); return }
    if let value = try? container.decode(Double.self) { self = .number(value); return }
    self = .text(try container.decode(String.self))
  }

  public var bool: Bool? { if case .bool(let value) = self { value } else { nil } }
  public var number: Double? { if case .number(let value) = self { value } else { nil } }
  public var text: String? { if case .text(let value) = self { value } else { nil } }

  /// The value as `clawdtime settings set NAME VALUE` takes it.
  public var argument: String {
    switch self {
    case .bool(let value): value ? "on" : "off"
    case .number(let value):
      value.rounded() == value && abs(value) < 1e9 ? String(Int(value)) : String(format: "%.2f", value)
        .replacingOccurrences(of: #"0+$"#, with: "", options: .regularExpression)
    case .text(let value): value
    }
  }
}

/// One setting of `clawdtime settings --json`. It never holds a key.
public struct RuntimeSetting: Decodable, Equatable, Identifiable, Sendable {
  public enum Source: String, Decodable, Sendable { case store, environment, `default` }
  /// When a change works: now, or when the desktop starts again.
  public enum Applies: String, Decodable, Sendable { case now, restart }
  public var id: String
  public var kind: String
  public var value: SettingValue
  public var `default`: SettingValue
  public var from: Source
  public var applies: Applies
  /// The variable of the environment that wins over a choice here.
  public var variable: String?
  public var choices: [String]?
  public var min: Double?
  public var max: Double?
}

/// A preset of the Speed setting: a planner and a chat model, from the evals.
public struct SpeedPreset: Decodable, Equatable, Identifiable, Sendable {
  public var id: String
  public var planner: String
  public var chat: String
  public var summary: String
}

/// `clawdtime settings --json`.
public struct RuntimeSettingsReport: Decodable, Equatable, Sendable {
  public struct Speed: Decodable, Equatable, Sendable {
    public var provider: String
    public var presets: [SpeedPreset]
  }
  public var version: Int
  public var store: String
  public var problem: String?
  public var settings: [RuntimeSetting]
  public var speed: Speed

  public func setting(_ id: String) -> RuntimeSetting? { settings.first { $0.id == id } }
}

/// `clawdtime settings set NAME VALUE --json` and `settings reset NAME --json`.
public struct SettingChange: Decodable, Equatable, Sendable {
  public var version: Int
  public var ok: Bool
  public var id: String
  public var value: SettingValue
  public var applies: RuntimeSetting.Applies
  public var shadowed: String?
}

/// `clawdtime settings privacy --json`: what ClawdTime keeps, where, and how much.
public struct PrivacyReport: Decodable, Equatable, Sendable {
  public struct Item: Decodable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var what: String
    public var path: String
    public var exists: Bool
    public var count: Int?
    public var bytes: Int
    /// Delete history moves it to the Trash.
    public var removable: Bool
  }
  public var version: Int
  public var folder: String
  public var items: [Item]
}

/// `clawdtime settings delete-history --yes --json`.
public struct HistoryResult: Decodable, Equatable, Sendable {
  public var version: Int
  public var ok: Bool
  public var moved: [String]
}

/// `clawdtime settings forget-memory --yes --json`.
public struct ForgetResult: Decodable, Equatable, Sendable {
  public var version: Int
  public var removed: Int
}

/// `clawdtime settings update --json`.
public struct UpdateReport: Decodable, Equatable, Sendable {
  public var version: Int
  public var current: String
  public var latest: String
  public var commit: String
  /// Nil: this runtime does not know its own version.
  public var newer: Bool?
  /// The release page, an https address. Nil for a release of another base.
  public var page: String?
}

/// `clawdtime settings phone --json`. It never holds a credential or a whole number.
public struct PhoneReport: Decodable, Equatable, Sendable {
  public enum Pairing: String, Decodable, Sendable { case none, paired, unusable }
  public struct Owner: Decodable, Equatable, Sendable {
    /// "ends in 00": the only part of the number that ClawdTime shows.
    public var ending: String
    public var consent: String?
  }
  public var version: Int
  public var pairing: Pairing
  public var origin: String?
  public var view: Bool?
  public var control: Bool?
  /// running, off, or unknown when its lock cannot be read.
  public var connection: String
  public var owner: Owner?
  /// Plain sentences of the desktop's reach: can it call or text you now.
  public var calls: String
  public var texts: String
}

/// `clawdtime settings phone unpair --yes --json`.
public struct UnpairOutcome: Decodable, Equatable, Sendable {
  public var version: Int
  /// unpaired, refused, pending or none.
  public var result: String
  public var sentence: String
}
