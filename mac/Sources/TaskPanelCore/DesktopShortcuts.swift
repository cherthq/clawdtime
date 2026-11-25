import Foundation

/// One enabled system hotkey reported by Carbon or by the symbolic hotkeys
/// preference dictionary. When `id` is present, it is the macOS symbolic hotkey
/// identifier (for example 79 for Move Left a Space, or 64 for Spotlight).
public struct DesktopHotKey: Equatable, Sendable {
  public let id: Int?
  public let code: UInt16
  public let carbonModifiers: UInt64
  public init(id: Int? = nil, code: UInt16, carbonModifiers: UInt64) {
    self.id = id
    self.code = code
    self.carbonModifiers = carbonModifiers
  }
}

public enum DesktopShortcuts {
  /// Symbolic hotkey identifiers for Mission Control, Application Windows,
  /// Show Desktop, Move Left/Right a Space (and their slow variants), and
  /// Switch to Desktop 1 through 16.
  public static let reservedSymbolicHotKeyIDs: Set<Int> = Set(
    [32, 33, 34, 35, 36, 37, 79, 80, 81, 82] + Array(118...133)
  )

  private static let spaceArrowKeyCodes: Set<UInt16> = [123, 124, 125, 126]
  private static let digitKeyCodes: Set<UInt16> = [18, 19, 20, 21, 22, 23, 25, 26, 28, 29]
  private static let standardCarbonMask: UInt64 = 256 | 512 | 2048 | 4096

  public static func isReservedSymbolicHotKey(_ id: Int) -> Bool {
    reservedSymbolicHotKeyIDs.contains(id)
  }

  /// Converts Core Graphics / AppKit modifier flags (used in `com.apple.symbolichotkeys`
  /// and `KeyCombo`) into Carbon modifier bits for `DesktopHotKey`.
  public static func carbonModifiers(fromEventFlags flags: UInt64) -> UInt64 {
    var carbon: UInt64 = 0
    if flags & KeyCombo.command != 0 { carbon |= 256 }
    if flags & KeyCombo.shift != 0 { carbon |= 512 }
    if flags & KeyCombo.option != 0 { carbon |= 2048 }
    if flags & KeyCombo.control != 0 { carbon |= 4096 }
    return carbon
  }

  /// Default macOS bindings for reserved Mission Control, Space and Desktop hotkeys
  /// when `com.apple.symbolichotkeys` has no custom `value.parameters` override.
  private static func defaultReservedHotKey(for id: Int) -> (code: UInt16, carbonModifiers: UInt64)? {
    switch id {
    case 32: return (126, 4096)         // Mission Control: ctrl+up
    case 33: return (125, 4096)         // Application Windows: ctrl+down
    case 34: return (126, 4096 | 512)   // Mission Control (slow): ctrl+shift+up
    case 35: return (125, 4096 | 512)   // Application Windows (slow): ctrl+shift+down
    case 36: return (103, 0)            // Show Desktop: F11
    case 37: return (103, 512)          // Show Desktop (slow): shift+F11
    case 79: return (123, 4096)         // Move left a space: ctrl+left
    case 80: return (123, 4096 | 512)   // Move left a space (slow): ctrl+shift+left
    case 81: return (124, 4096)         // Move right a space: ctrl+right
    case 82: return (124, 4096 | 512)   // Move right a space (slow): ctrl+shift+right
    case 118: return (18, 4096)         // Switch to Desktop 1: ctrl+1
    case 119: return (19, 4096)         // Switch to Desktop 2: ctrl+2
    case 120: return (20, 4096)         // Switch to Desktop 3: ctrl+3
    case 121: return (21, 4096)         // Switch to Desktop 4: ctrl+4
    case 122: return (23, 4096)         // Switch to Desktop 5: ctrl+5
    case 123: return (22, 4096)         // Switch to Desktop 6: ctrl+6
    case 124: return (26, 4096)         // Switch to Desktop 7: ctrl+7
    case 125: return (28, 4096)         // Switch to Desktop 8: ctrl+8
    case 126: return (25, 4096)         // Switch to Desktop 9: ctrl+9
    case 127: return (29, 4096)         // Switch to Desktop 10: ctrl+0
    default: return nil
    }
  }

  private static func boolValue(_ raw: Any?) -> Bool? {
    if let flag = raw as? Bool { return flag }
    if let number = raw as? Int { return number != 0 }
    if let number = raw as? NSNumber { return number.boolValue }
    return nil
  }

  private static func uint64Value(_ raw: Any?) -> UInt64? {
    if let value = raw as? UInt64 { return value }
    if let value = raw as? Int, value >= 0 { return UInt64(value) }
    if let value = raw as? NSNumber, value.int64Value >= 0 { return UInt64(value.int64Value) }
    return nil
  }

  /// Extracts only enabled Mission Control, Space and Desktop switching hotkeys
  /// from `com.apple.symbolichotkeys` and the Carbon enabled-hotkey inventory.
  /// Non-space system shortcuts (such as Spotlight, Screenshot and keyboard
  /// navigation hotkeys) are not included. Returns nil if the Carbon inventory
  /// itself is unavailable.
  public static func reservedHotKeys(appleSymbolicHotKeys: [String: Any]?,
                                     enabled: [DesktopHotKey]?,
                                     configuredPair: DesktopShortcutPair? = nil) -> [DesktopHotKey]? {
    guard let enabled else { return nil }
    func enabledInCarbon(code: UInt16, modifiers: UInt64) -> Bool {
      enabled.contains { $0.code == code && ($0.carbonModifiers & standardCarbonMask) == modifiers }
    }
    var reserved: [DesktopHotKey] = []
    for id in reservedSymbolicHotKeyIDs.sorted() {
      if let entry = appleSymbolicHotKeys?[String(id)] as? [String: Any] {
        let isEnabled = boolValue(entry["enabled"])
        if isEnabled == false { continue }
        if let value = entry["value"] as? [String: Any],
           let params = value["parameters"] as? [Any], params.count >= 3,
           let rawCode = uint64Value(params[1]),
           let rawFlags = uint64Value(params[2]) {
          if rawCode < 65535 {
            let code = UInt16(rawCode)
            let mods = carbonModifiers(fromEventFlags: rawFlags)
            if isEnabled == true || enabledInCarbon(code: code, modifiers: mods) {
              reserved.append(DesktopHotKey(id: id, code: code, carbonModifiers: mods))
            }
          }
          continue
        }
        if isEnabled == true, let fallback = defaultReservedHotKey(for: id) {
          reserved.append(DesktopHotKey(id: id, code: fallback.code, carbonModifiers: fallback.carbonModifiers))
          continue
        }
      }
      if let fallback = defaultReservedHotKey(for: id),
         enabledInCarbon(code: fallback.code, modifiers: fallback.carbonModifiers) {
        reserved.append(DesktopHotKey(id: id, code: fallback.code, carbonModifiers: fallback.carbonModifiers))
      }
    }
    if let pair = configuredPair {
      reserved.append(DesktopHotKey(id: 79, code: pair.left.code, carbonModifiers: carbonModifiers(fromEventFlags: pair.left.flags)))
      reserved.append(DesktopHotKey(id: 81, code: pair.right.code, carbonModifiers: carbonModifiers(fromEventFlags: pair.right.flags)))
    }
    return reserved
  }

  public static func permits(_ combo: KeyCombo, resolvedCode: UInt16, configured: [DesktopHotKey]?) -> Bool {
    // App switching has its own single-dispatch transition command.
    if resolvedCode == 48 && combo.flags & KeyCombo.command != 0 { return false }
    // Default Space, Desktop and Mission Control chords are never sent as generic keys.
    if combo.flags & KeyCombo.control != 0,
      spaceArrowKeyCodes.contains(combo.keyCode) || spaceArrowKeyCodes.contains(resolvedCode)
        || digitKeyCodes.contains(resolvedCode)
        || combo.character.map({ "0123456789".contains($0) }) == true { return false }
    // Without a trustworthy inventory, plain editing keys remain available;
    // modified/function shortcuts do not become a blind Space-switching path.
    guard let configured else { return combo.flags == 0 && (combo.printing || [36, 48, 51, 53, 117, 123, 124, 125, 126].contains(resolvedCode)) }
    let mask = KeyCombo.command | KeyCombo.shift | KeyCombo.option | KeyCombo.control
    for key in configured where key.code == resolvedCode {
      if let id = key.id, !isReservedSymbolicHotKey(id) { continue }
      var flags: UInt64 = 0
      if key.carbonModifiers & 256 != 0 { flags |= KeyCombo.command }
      if key.carbonModifiers & 512 != 0 { flags |= KeyCombo.shift }
      if key.carbonModifiers & 2048 != 0 { flags |= KeyCombo.option }
      if key.carbonModifiers & 4096 != 0 { flags |= KeyCombo.control }
      // Unknown modifier bits cannot make a matching reserved key safe.
      if flags == combo.flags & mask { return false }
    }
    return true
  }
}
