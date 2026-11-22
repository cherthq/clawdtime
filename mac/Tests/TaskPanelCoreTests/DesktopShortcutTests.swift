import XCTest
@testable import TaskPanelCore

final class DesktopShortcutTests: XCTestCase {
  func testDefaultDesktopChordsAreNeverAnAlternateSwitchingPath() throws {
    for text in ["ctrl+left", "ctrl+right", "ctrl+1", "ctrl+9", "ctrl+shift+right"] {
      let key = try XCTUnwrap(KeyCombo.parse(text))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: []))
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
  }
  func testUnmodifiedConfiguredFunctionKeyIsReserved() throws {
    let key = try XCTUnwrap(KeyCombo.parse("f3"))
    XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: [.init(code: key.keyCode, carbonModifiers: 0)]))
    XCTAssertTrue(DesktopShortcuts.permits(key, resolvedCode: key.keyCode, configured: []))
  }
}
