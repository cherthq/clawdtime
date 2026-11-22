import Foundation

/// Public CopySymbolicHotKeys reports enabled key combinations, but deliberately
/// provides no action identifier. Reserve all of them instead of guessing which
/// combination changes Spaces. No settings are changed and no shortcut is tried.
public struct DesktopHotKey: Equatable, Sendable {
  public let code: UInt16
  public let carbonModifiers: UInt64
  public init(code: UInt16, carbonModifiers: UInt64) { self.code = code; self.carbonModifiers = carbonModifiers }
}
public enum DesktopShortcuts {
  public static func permits(_ combo: KeyCombo, resolvedCode: UInt16, configured: [DesktopHotKey]?) -> Bool {
    // App switching has its own single-dispatch transition command.
    if resolvedCode == 48 && combo.flags & KeyCombo.command != 0 { return false }
    if combo.flags & KeyCombo.control != 0,
      [123, 124].contains(combo.keyCode) || combo.character.map({ "0123456789".contains($0) }) == true { return false }
    // Without a trustworthy inventory, plain editing keys remain available;
    // modified/function shortcuts do not become a blind Space-switching path.
    guard let configured else { return combo.flags == 0 && (combo.printing || [36, 48, 51, 53, 117, 123, 124, 125, 126].contains(resolvedCode)) }
    let mask = KeyCombo.command | KeyCombo.shift | KeyCombo.option | KeyCombo.control
    for key in configured where key.code == resolvedCode {
      var flags: UInt64 = 0
      if key.carbonModifiers & 256 != 0 { flags |= KeyCombo.command }
      if key.carbonModifiers & 512 != 0 { flags |= KeyCombo.shift }
      if key.carbonModifiers & 2048 != 0 { flags |= KeyCombo.option }
      if key.carbonModifiers & 4096 != 0 { flags |= KeyCombo.control }
      // Unknown modifier bits cannot make a matching configured key safe.
      if flags == combo.flags & mask { return false }
    }
    return true
  }
}
