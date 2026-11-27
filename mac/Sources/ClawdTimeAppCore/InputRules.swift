import Foundation

/// Small rules for the fields and the recovery buttons of the setup window.
public enum InputRules {
  /// A phone number as typed: digits, a leading plus, spaces, dots, dashes and brackets.
  public static func phone(_ typed: String) -> String {
    var result = ""
    for character in typed {
      if character.isASCII && character.isNumber { result.append(character) }
      else if character == "+" && result.isEmpty { result.append(character) }
      else if " .-()".contains(character) && !result.isEmpty { result.append(character) }
    }
    return String(result.prefix(24))
  }

  /// What goes to the engine: the plus and the digits only.
  public static func phoneValue(_ typed: String) -> String {
    phone(typed).filter { $0 == "+" || ($0.isASCII && $0.isNumber) }
  }

  public static func isPlausiblePhone(_ typed: String) -> Bool {
    let digits = phoneValue(typed).filter(\.isNumber)
    return (7...15).contains(digits.count)
  }

  /// A verification code: digits only, at most ten.
  public static func code(_ typed: String) -> String {
    String(typed.filter { $0.isASCII && $0.isNumber }.prefix(10))
  }

  public static func isPlausibleCode(_ typed: String) -> Bool { (4...10).contains(code(typed).count) }

  /// The engine may only send the app to a System Settings pane or to an https page.
  public static func recoveryURL(_ recovery: Recovery) -> URL? {
    guard let text = recovery.url, let url = URL(string: text), let scheme = url.scheme?.lowercased() else { return nil }
    switch recovery.action {
    case .openSettings: return scheme == "x-apple.systempreferences" ? url : nil
    case .openURL: return scheme == "https" && url.host?.isEmpty == false ? url : nil
    case .retry: return nil
    }
  }

  /// The value a field sends, or nil while it cannot be sent yet.
  public static func value(for input: StepInput, text: String, selection: Set<String>) -> InputValue? {
    switch input.kind {
    case .secret:
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : .string(trimmed)
    case .text:
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : .string(trimmed)
    case .phone:
      return isPlausiblePhone(text) ? .string(phoneValue(text)) : nil
    case .code:
      return isPlausibleCode(text) ? .string(code(text)) : nil
    case .choice:
      let known = Set((input.options ?? []).map(\.id))
      let chosen = (input.options ?? []).map(\.id).filter { selection.contains($0) && known.contains($0) }
      if input.allowsMany { return .strings(chosen) }
      return chosen.count == 1 ? .string(chosen[0]) : nil
    case .confirm:
      return nil
    }
  }
}
