import Foundation

/// The panel's preferences that the Settings window of the app changes,
/// through `clawdtime settings set`. The runtime writes them with `defaults`
/// into the panel's own domain and then posts `notice`. A running panel
/// reads them again at once. A value that does not fit reads as the default.
public enum PanelPreferences {
  /// The Darwin notice of a change. `cli/settings.ts` posts it with notifyutil.
  public static let notice = "com.clawdtime.panel.settings"

  public enum Key {
    public static let voiceReplies = "voice.replies"
    public static let voiceRate = "voice.rate"
  }

  public static let voiceRateRange = 0.5...2.0

  /// ClawdTime speaks its answers unless the person turned that off.
  public static func voiceReplies(_ value: Any?) -> Bool {
    guard let value = value as? Bool else { return true }
    return value
  }

  /// The speed of the spoken answers: 1 is the speed of the voice itself.
  public static func voiceRate(_ value: Any?) -> Double {
    // A yes or no is no speed, also when it comes as a number.
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return 1 }
    let rate = number.doubleValue
    guard rate.isFinite else { return 1 }
    return min(voiceRateRange.upperBound, max(voiceRateRange.lowerBound, rate))
  }
}
