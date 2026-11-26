import XCTest
@testable import TaskPanelCore

final class DesktopShortcutTests: XCTestCase {
  func testDefaultDesktopChordsAreNeverAnAlternateSwitchingPath() throws {
    for text in [
      "ctrl+left", "ctrl+right", "ctrl+up", "ctrl+down",
      "ctrl+shift+left", "ctrl+shift+right", "ctrl+shift+up", "ctrl+shift+down",
      "ctrl+0", "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
    ] {
      let key = try XCTUnwrap(KeyCombo.parse(text))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: []), text)
    }
  }
  func testConfiguredShortcutUsesActualLayoutCodeAndCarbonModifiers() throws {
    let key = try XCTUnwrap(KeyCombo.parse("cmd+shift+x"))
    let reserved = [DesktopHotKey(code: 42, carbonModifiers: 256 | 512)]
    XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: reserved))
    XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: 42, configured: reserved))
    let other = try XCTUnwrap(KeyCombo.parse("cmd+x"))
    XCTAssertTrue(DesktopShortcuts.permits(other, resolvedCode: 42, configured: reserved))
    let optionControl = try XCTUnwrap(KeyCombo.parse("ctrl+alt+f5"))
    XCTAssertFalse(DesktopShortcuts.permits(optionControl, resolvedCode: optionControl.keyCode,
      configured: [.init(code: optionControl.keyCode, carbonModifiers: UInt64(2048 | 4096))]))
  }
  func testMissingInventoryRefusesModifiedAndFunctionKeysButAllowsPlainEditing() throws {
    for text in ["cmd+s", "f3", "ctrl+a", "alt+left", "fn+a"] {
      let key = try XCTUnwrap(KeyCombo.parse(text))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: nil))
    }
    for text in ["a", "space", "return", "tab", "escape", "left", "delete"] {
      let key = try XCTUnwrap(KeyCombo.parse(text))
      XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: nil))
    }
    XCTAssertNil(DesktopShortcuts.reservedHotKeys(appleSymbolicHotKeys: [:], enabled: nil))
  }
  func testUnmodifiedConfiguredFunctionKeyIsReserved() throws {
    let key = try XCTUnwrap(KeyCombo.parse("f3"))
    XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: [.init(code: key.keyCode, carbonModifiers: 0)]))
    XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: []))
  }
  func testSystemShortcutsLikeSpotlightScreenshotAndKeyboardNavArePermittedWhenEnabled() throws {
    // Simulated Carbon CopySymbolicHotKeys inventory with Spotlight, Screenshot,
    // menu bar/Dock/status navigation, Mission Control, Show Desktop and Spaces all enabled.
    let carbonEnabled: [DesktopHotKey] = [
      .init(code: 49, carbonModifiers: 256),               // cmd+space (Spotlight, ID 64)
      .init(code: 20, carbonModifiers: 256 | 512),         // cmd+shift+3 (Screenshot, ID 28)
      .init(code: 21, carbonModifiers: 256 | 512),         // cmd+shift+4 (Screenshot, ID 30)
      .init(code: 23, carbonModifiers: 256 | 512),         // cmd+shift+5 (Screenshot bar, ID 184)
      .init(code: 120, carbonModifiers: 4096 | 131072),    // ctrl+f2 (Focus menu bar, ID 7)
      .init(code: 99, carbonModifiers: 4096 | 131072),     // ctrl+f3 (Focus Dock, ID 8)
      .init(code: 100, carbonModifiers: 4096 | 131072),    // ctrl+f8 (Focus status menus, ID 57)
      .init(code: 126, carbonModifiers: 4096 | 131072),    // ctrl+up (Mission Control, ID 32)
      .init(code: 125, carbonModifiers: 4096 | 131072),    // ctrl+down (Application Windows, ID 33)
      .init(code: 103, carbonModifiers: 131072),           // f11 (Show Desktop, ID 36)
      .init(code: 103, carbonModifiers: 512 | 131072),     // shift+f11 (Show Desktop slow, ID 37)
      .init(code: 123, carbonModifiers: 4096 | 131072),    // ctrl+left (Move left a space, ID 79)
      .init(code: 124, carbonModifiers: 4096 | 131072),    // ctrl+right (Move right a space, ID 81)
    ]
    let symbolicPrefs: [String: Any] = [
      "7": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 120, Int(KeyCombo.control | KeyCombo.function)]]],
      "8": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 99, Int(KeyCombo.control | KeyCombo.function)]]],
      "28": ["enabled": true, "value": ["type": "standard", "parameters": [51, 20, Int(KeyCombo.command | KeyCombo.shift)]]],
      "30": ["enabled": true, "value": ["type": "standard", "parameters": [52, 21, Int(KeyCombo.command | KeyCombo.shift)]]],
      "57": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 100, Int(KeyCombo.control | KeyCombo.function)]]],
      "64": ["enabled": true, "value": ["type": "standard", "parameters": [32, 49, Int(KeyCombo.command)]]],
      "184": ["enabled": true, "value": ["type": "standard", "parameters": [53, 23, Int(KeyCombo.command | KeyCombo.shift)]]],
      "79": ["enabled": true],
      "80": ["enabled": true],
      "81": ["enabled": true],
      "82": ["enabled": true],
    ]
    let reserved = try XCTUnwrap(DesktopShortcuts.reservedHotKeys(appleSymbolicHotKeys: symbolicPrefs, enabled: carbonEnabled))

    for allowed in ["cmd+space", "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "ctrl+f2", "ctrl+f3", "ctrl+f8"] {
      let key = try XCTUnwrap(KeyCombo.parse(allowed))
      XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: reserved), allowed)
    }
    for blocked in ["ctrl+left", "ctrl+right", "ctrl+up", "ctrl+down", "ctrl+1", "ctrl+9", "f11", "shift+f11"] {
      let key = try XCTUnwrap(KeyCombo.parse(blocked))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: reserved), blocked)
    }

    // Passing non-reserved IDs directly to permits still permits them.
    let direct = [
      DesktopHotKey(id: 64, code: 49, carbonModifiers: 256),
      DesktopHotKey(id: 28, code: 20, carbonModifiers: 256 | 512),
      DesktopHotKey(id: 30, code: 21, carbonModifiers: 256 | 512),
      DesktopHotKey(id: 184, code: 23, carbonModifiers: 256 | 512),
      DesktopHotKey(id: 7, code: 120, carbonModifiers: 4096),
      DesktopHotKey(id: 8, code: 99, carbonModifiers: 4096),
      DesktopHotKey(id: 57, code: 100, carbonModifiers: 4096),
    ]
    for allowed in ["cmd+space", "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "ctrl+f2", "ctrl+f3", "ctrl+f8"] {
      let key = try XCTUnwrap(KeyCombo.parse(allowed))
      XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: direct), allowed)
    }
  }
  func testCustomSpaceDesktopAndMissionControlHotKeysAreRefusedWhileDisabledOnesArePermitted() throws {
    let symbolicPrefs: [String: Any] = [
      // Custom Mission Control on unmodified F3 (ID 32).
      "32": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 99, 0]]],
      // Show Desktop explicitly disabled (ID 36, 37).
      "36": ["enabled": false],
      "37": ["enabled": false],
      // Custom Move Left a Space on cmd+shift+x (ID 79).
      "79": ["enabled": true, "value": ["type": "standard", "parameters": [120, 7, Int(KeyCombo.command | KeyCombo.shift)]]],
      // Custom Switch to Desktop 3 on ctrl+alt+f5 (ID 120).
      "120": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 96, Int(KeyCombo.control | KeyCombo.option)]]],
      // Custom Switch to Desktop 16 on alt+cmd+6 (ID 133).
      "133": ["enabled": true, "value": ["type": "standard", "parameters": [54, 22, Int(KeyCombo.option | KeyCombo.command)]]],
      // Disabled custom Desktop 2 on cmd+shift+y (ID 119): must not block.
      "119": ["enabled": false, "value": ["type": "standard", "parameters": [121, 16, Int(KeyCombo.command | KeyCombo.shift)]]],
      // Unbound Desktop 15 (keyCode 65535): must not block.
      "132": ["enabled": true, "value": ["type": "standard", "parameters": [65535, 65535, 0]]],
      // Custom Spotlight on alt+space (ID 64): non-reserved, must remain permitted.
      "64": ["enabled": true, "value": ["type": "standard", "parameters": [32, 49, Int(KeyCombo.option)]]],
    ]
    let carbonEnabled: [DesktopHotKey] = [
      .init(code: 103, carbonModifiers: 131072), // F11 in Carbon, but disabled in prefs for ID 36
    ]
    let pair = DesktopShortcutPair(
      left: DesktopResolvedShortcut(code: 33, flags: KeyCombo.command | KeyCombo.option),  // alt+cmd+[
      right: DesktopResolvedShortcut(code: 30, flags: KeyCombo.command | KeyCombo.option)  // alt+cmd+]
    )
    let reserved = try XCTUnwrap(DesktopShortcuts.reservedHotKeys(
      appleSymbolicHotKeys: symbolicPrefs, enabled: carbonEnabled, configuredPair: pair))

    for blocked in ["f3", "cmd+shift+x", "ctrl+alt+f5", "alt+cmd+6", "alt+cmd+[", "alt+cmd+]"] {
      let key = try XCTUnwrap(KeyCombo.parse(blocked))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: reserved), blocked)
    }
    for allowed in ["f11", "shift+f11", "cmd+shift+y", "alt+space", "cmd+space"] {
      let key = try XCTUnwrap(KeyCombo.parse(allowed))
      XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: reserved), allowed)
    }
  }
  func testReservedSymbolicHotKeyIDsCoverOnlyMissionControlSpacesAndDesktops() {
    let expected = Set([32, 33, 34, 35, 36, 37, 79, 80, 81, 82] + Array(118...133))
    XCTAssertEqual(DesktopShortcuts.reservedSymbolicHotKeyIDs, expected)
    for id in [7, 8, 28, 29, 30, 31, 57, 60, 61, 64, 65, 140, 160, 184] {
      XCTAssertFalse(DesktopShortcuts.isReservedSymbolicHotKey(id), "ID \(id) must not be reserved")
    }
  }
}
