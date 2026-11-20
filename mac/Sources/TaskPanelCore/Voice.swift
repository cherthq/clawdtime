import Foundation

/// The conversation with ClawdTime, as the task service reports it.
public struct ChatTranscript: Codable, Equatable {
  public struct Message: Codable, Equatable {
    public let role: String
    public let text: String
    public let at: Double
    public let via: String
    public init(role: String, text: String, at: Double, via: String) { self.role = role; self.text = text; self.at = at; self.via = via }
    public var mine: Bool { role == "user" }
  }
  public let version: Int
  /// A language model answers. Without one ClawdTime tells the state and takes a clear yes or no.
  public let model: Bool
  public let speech: Bool
  public let voiceDirectory: String
  public let messages: [Message]
  public init(version: Int, model: Bool, speech: Bool, voiceDirectory: String, messages: [Message]) {
    self.version = version; self.model = model; self.speech = speech; self.voiceDirectory = voiceDirectory; self.messages = messages
  }
  public func validate() throws {
    guard version == 1, messages.count <= 400, voiceDirectory.hasPrefix("/"), voiceDirectory.count <= 4096,
      messages.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.text.count <= 2000 && ["chat", "voice", "call"].contains($0.via) })
    else { throw PanelFailure.response }
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
