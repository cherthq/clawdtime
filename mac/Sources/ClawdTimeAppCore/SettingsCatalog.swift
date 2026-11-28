import Foundation

/// The sections of the Settings window, in their order.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
  case general, assistant, models, computer, permissions, phone, privacy, about
  public var id: String { rawValue }
  public var title: String {
    switch self {
    case .general: "General"
    case .assistant: "Assistant"
    case .models: "Models"
    case .computer: "Computer use"
    case .permissions: "Permissions"
    case .phone: "Phone"
    case .privacy: "Privacy"
    case .about: "About"
    }
  }
  public var subtitle: String {
    switch self {
    case .general: "The mascot, the cursor and how ClawdTime starts."
    case .assistant: "How ClawdTime talks, what it keeps, and what it does while you are away."
    case .models: "The keys and the models that ClawdTime thinks with."
    case .computer: "What ClawdTime may do on this Mac, and when it asks first."
    case .permissions: "What macOS lets ClawdTime do. This page checks again by itself."
    case .phone: "Calls and texts with ClawdTime on your phone."
    case .privacy: "What ClawdTime keeps on this Mac, and where."
    case .about: "The version, updates and uninstall."
    }
  }
  /// The SF Symbol of the sidebar.
  public var symbol: String {
    switch self {
    case .general: "gearshape.fill"
    case .assistant: "waveform"
    case .models: "cpu"
    case .computer: "cursorarrow.click.2"
    case .permissions: "lock.shield.fill"
    case .phone: "iphone"
    case .privacy: "hand.raised.fill"
    case .about: "info.circle.fill"
    }
  }
}

/// Every row that the search field finds: its section, the id of the row on
/// the page, its title, and other words that a person may type for it.
public struct SettingsEntry: Equatable, Identifiable, Sendable {
  public var section: SettingsSection
  public var anchor: String
  public var title: String
  public var words: [String]
  public var id: String { anchor }
}

public enum SettingsCatalog {
  public static let entries: [SettingsEntry] = [
    .init(section: .general, anchor: "mascot", title: "Mascot", words: ["style", "look", "stone", "size", "eye", "flint", "jet", "jade", "pet", "character"]),
    .init(section: .general, anchor: "cursor", title: "Cursor pace", words: ["pointer", "mouse", "calm", "fast", "speed", "hands"]),
    .init(section: .general, anchor: "login", title: "Open at login", words: ["login", "startup", "start", "launch", "boot"]),
    .init(section: .general, anchor: "shortcuts", title: "Talk and chat", words: ["keyboard", "shortcut", "hotkey", "keys", "command"]),
    .init(section: .general, anchor: "setup", title: "Setup and stop", words: ["setup", "onboarding", "stop", "restart", "start"]),
    .init(section: .assistant, anchor: "voiceReplies", title: "Speak replies", words: ["voice", "sound", "mute", "audio", "answers", "out loud"]),
    .init(section: .assistant, anchor: "voice", title: "Voice", words: ["voice", "alloy", "coral", "marin", "speaker", "tts"]),
    .init(section: .assistant, anchor: "voiceSpeed", title: "Speaking speed", words: ["voice", "speed", "rate", "slow", "fast", "faster"]),
    .init(section: .assistant, anchor: "vocabulary", title: "Names to hear right", words: ["voice", "vocabulary", "names", "words", "transcription", "speech", "dictation"]),
    .init(section: .assistant, anchor: "memory", title: "Memory", words: ["remember", "facts", "learn", "recall"]),
    .init(section: .assistant, anchor: "forget", title: "Forget everything", words: ["forget", "erase", "delete", "clear", "memory"]),
    .init(section: .assistant, anchor: "away", title: "Away: answer by phone", words: ["away", "phone", "call", "absent", "agents", "questions"]),
    .init(section: .models, anchor: "speed", title: "Speed", words: ["fast", "balanced", "best", "preset", "quick", "quality", "latency"]),
    .init(section: .models, anchor: "keys", title: "Model keys", words: ["key", "api", "openai", "anthropic", "provider", "token"]),
    .init(section: .models, anchor: "planner", title: "Planner model", words: ["planner", "model", "advanced", "computer", "vision"]),
    .init(section: .models, anchor: "chat", title: "Chat model", words: ["chat", "model", "advanced", "conversation", "reply"]),
    .init(section: .computer, anchor: "computer", title: "Computer use", words: ["control", "hands", "click", "type", "on", "off", "use this mac"]),
    .init(section: .computer, anchor: "ask", title: "Ask before acting", words: ["ask", "confirm", "trust", "approval", "risky", "question", "pay", "delete", "send"]),
    .init(section: .computer, anchor: "browser", title: "Browser", words: ["browser", "chrome", "safari", "web", "page", "tabs"]),
    .init(section: .permissions, anchor: "permissions", title: "Accessibility and Screen Recording", words: ["permission", "accessibility", "screen", "recording", "privacy", "allow"]),
    .init(section: .phone, anchor: "pairing", title: "Pair or unpair", words: ["pair", "unpair", "phone", "iphone", "number", "facetime", "imessage", "line"]),
    .init(section: .phone, anchor: "number", title: "Your number", words: ["number", "phone", "consent", "owner"]),
    .init(section: .phone, anchor: "reach", title: "Calls when a question waits", words: ["call", "text", "reach", "wait", "seconds", "question"]),
    .init(section: .privacy, anchor: "stored", title: "What ClawdTime keeps", words: ["data", "files", "storage", "folder", "stored", "logs"]),
    .init(section: .privacy, anchor: "history", title: "Delete history", words: ["delete", "history", "chat", "clear", "erase", "trash"]),
    .init(section: .about, anchor: "version", title: "Version", words: ["version", "build", "commit", "runtime"]),
    .init(section: .about, anchor: "update", title: "Check for updates", words: ["update", "upgrade", "release", "download", "new", "latest"]),
    .init(section: .about, anchor: "uninstall", title: "Uninstall ClawdTime", words: ["uninstall", "remove", "trash", "delete"]),
  ]

  /// The rows that hold every word of the text, at the start of a word of
  /// their title, their section or their other words. Case does not count.
  public static func search(_ text: String) -> [SettingsEntry] {
    let wanted = text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    guard !wanted.isEmpty else { return [] }
    return entries.filter { entry in
      let words = ([entry.title, entry.section.title] + entry.words)
        .flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init) }
      return wanted.allSatisfy { part in words.contains { $0.hasPrefix(part) } }
    }
  }
}
