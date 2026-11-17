/// Fixed metadata-only reasons; no session dictionary values leave the process.
public enum LocalSessionRefusal: String, Codable {
  case forcedUnavailable = "session_forced_unavailable"
  case missing = "session_missing"
  case offConsole = "session_off_console"
  case loginIncomplete = "session_login_incomplete"
  case locked = "session_locked"
  public static func evaluate(present: Bool, forcedUnavailable: Bool = false,
      onConsole: Bool?, loginDone: Bool?, locked: Bool?) -> Self? {
    if forcedUnavailable { return .forcedUnavailable }
    if !present { return .missing }
    if onConsole != true { return .offConsole }
    if loginDone != true { return .loginIncomplete }
    if locked == true { return .locked }
    return nil
  }
}
