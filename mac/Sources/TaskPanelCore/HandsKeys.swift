import Foundation

/// One key with its modifiers, as the keyboard sends it.
public struct KeyCombo: Equatable, Sendable {
  /// The virtual key code of the key on a United States keyboard.
  public let keyCode: UInt16
  /// The modifiers, with the values of the Core Graphics event flags.
  public let flags: UInt64
  /// The character that the key prints with no modifier, when it prints one. A
  /// keyboard of another country can have it on another key: the panel looks there.
  public let character: String?
  /// The key prints a character: a letter, a digit, a sign or a space.
  public let printing: Bool
  public init(keyCode: UInt16, flags: UInt64, character: String?, printing: Bool? = nil) {
    self.keyCode = keyCode; self.flags = flags; self.character = character
    self.printing = printing ?? (character != nil)
  }
  /// The combo puts a character into a field, as typed text does. With Command or
  /// Control it is a shortcut. No combo at all goes into a password field: `SecureField`.
  public var typesText: Bool { printing && flags & (KeyCombo.command | KeyCombo.control) == 0 }

  public static let shift: UInt64 = 0x0002_0000, control: UInt64 = 0x0004_0000, option: UInt64 = 0x0008_0000
  public static let command: UInt64 = 0x0010_0000, function: UInt64 = 0x0080_0000
  /// The Return key and the Tab key, which typed text also uses.
  public static let returnKey: UInt16 = 36, tabKey: UInt16 = 48, escapeKey: UInt16 = 53

  private static let modifiers: [String: UInt64] = [
    "cmd": command, "command": command, "meta": command,
    "shift": shift,
    "alt": option, "option": option, "opt": option,
    "ctrl": control, "control": control,
    "fn": function,
  ]
  private static let named: [String: UInt16] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "minus": 27,
  ]
  private static let printed: [String: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  ]

  /// Reads a combo such as "cmd+shift+4", "return" or "cmd+s": modifiers first,
  /// then one key. It refuses what it does not know: no key, two keys, a
  /// modifier twice or after the key, and any name outside its tables.
  public static func parse(_ combo: String) -> KeyCombo? {
    guard (1...40).contains(combo.utf16.count) else { return nil }
    var text = combo.lowercased()
    // The plus key shares its sign with the separator: "cmd++" is Command and plus.
    if text == "+" { text = "plus" } else if text.hasSuffix("++") { text = String(text.dropLast()) + "plus" }
    let parts = text.split(separator: "+", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let last = parts.last, !parts.contains(where: \.isEmpty) else { return nil }
    var flags: UInt64 = 0
    for part in parts.dropLast() {
      guard let flag = modifiers[part], flags & flag == 0 else { return nil }
      flags |= flag
    }
    guard modifiers[last] == nil else { return nil }
    if last == "plus" {
      // On a United States keyboard the plus sign is Shift and the equals key.
      return KeyCombo(keyCode: 24, flags: flags | shift, character: nil, printing: true)
    }
    if let code = printed[last] { return KeyCombo(keyCode: code, flags: flags, character: last) }
    let name = last.replacingOccurrences(of: "_", with: "").replacingOccurrences(of: " ", with: "")
    if let code = named[name] {
      return KeyCombo(keyCode: code, flags: flags, character: name == "minus" ? "-" : nil, printing: name == "minus" || name == "space")
    }
    return nil
  }
}

/// The hands and a password field. Nothing that the hands send may put text into one or take text out of it.
public enum SecureField {
  /// A key of the hands with the keyboard in a password field. `focusSecure`: the field that has the keyboard is
  /// one, as the Accessibility tree or macOS says. No key goes there: not a character, and not a shortcut either.
  /// Command V would paste the clipboard into it, Control Y would yank cut text into it, and Return would send
  /// what the person typed there. The person handles a password field.
  public static func permitsKey(_ combo: KeyCombo, focusSecure: Bool) -> Bool { !focusSecure }
  /// A drag of the hands. `source` and `target`: the element under the press and under the drop is a password
  /// field. Nil when the Accessibility tree does not say. A drop on one would put text into it, and a press on
  /// one would take text out of it.
  public static func permitsDrag(source: Bool?, target: Bool?) -> Bool { source != true && target != true }
}

/// One step of typed text.
public enum TypingStep: Equatable, Sendable {
  /// Characters that go as Unicode, whatever the keyboard layout is.
  case text(String)
  /// A key that text cannot carry: Return for a line break, Tab for a tab.
  case key(UInt16)
}

/// Typed text, cut into the steps that the keyboard events carry.
public enum TypingPlan {
  /// One keyboard event carries at most this many UTF-16 units.
  public static let unitsPerEvent = 20
  /// `perStep` is the number of characters in one event. One at a time is what
  /// every app accepts. A character is never cut, unless it alone is longer
  /// than one event holds; then it is cut between two code points.
  public static func steps(_ text: String, perStep: Int = 1) -> [TypingStep] {
    var steps: [TypingStep] = []
    var piece = "", held = 0
    func flush() {
      if !piece.isEmpty { steps.append(.text(piece)) }
      piece = ""; held = 0
    }
    for character in text {
      if character == "\n" || character == "\r\n" || character == "\r" { flush(); steps.append(.key(KeyCombo.returnKey)); continue }
      if character == "\t" { flush(); steps.append(.key(KeyCombo.tabKey)); continue }
      // Other control codes are not text that a person types.
      if character.unicodeScalars.allSatisfy({ $0.properties.generalCategory == .control }) { continue }
      let units = character.utf16.count
      if units > unitsPerEvent {
        flush()
        for scalar in character.unicodeScalars {
          let width = String(scalar).utf16.count
          if !piece.isEmpty && piece.utf16.count + width > unitsPerEvent { flush() }
          piece.unicodeScalars.append(scalar)
        }
        flush(); continue
      }
      if held >= max(1, perStep) || piece.utf16.count + units > unitsPerEvent { flush() }
      piece.append(character); held += 1
    }
    flush()
    return steps
  }

  /// Typed text reads the place of the keyboard again on its way, because a key or the app can move it: to
  /// ClawdTime's chat, or to a password field. The caller reads it before the first step. After that the full
  /// read comes before each Return and each Tab, after each of them, and after at most `checkEvery` characters.
  public static let checkEvery = 8
  /// For each step: true when the full read of the keyboard's place comes before it.
  public static func checks(_ steps: [TypingStep], every: Int = checkEvery) -> [Bool] {
    var unchecked = 0
    var checks: [Bool] = []
    for (index, step) in steps.enumerated() {
      var check = false
      if index > 0 {
        if case .key = step { check = true }
        if case .key = steps[index - 1] { check = true }
        if unchecked >= max(1, every) { check = true }
      }
      checks.append(check)
      if check { unchecked = 0 }
      if case .text(let piece) = step { unchecked += piece.count }
    }
    return checks
  }
}
