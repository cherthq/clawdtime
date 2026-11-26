import XCTest
@testable import TaskPanelCore

/// Nothing that the hands send puts text into a password field. Typed text never goes there, and a key with
/// Command or Control does not either: Command V pastes the clipboard and Control Y yanks the text that a field
/// cut before. A drag that drops on a password field would put its text there too.
final class SecureFieldTests: XCTestCase {
  func testNoKeyGoesIntoAPasswordField() throws {
    for name in ["cmd+v", "ctrl+y", "cmd+shift+v", "cmd+option+shift+v", "ctrl+k", "a", "shift+a", "option+a", "space",
                 "return", "tab", "shift+tab", "delete", "left", "escape", "f5"] {
      let combo = try XCTUnwrap(KeyCombo.parse(name), name)
      XCTAssertFalse(SecureField.permitsKey(combo, focusSecure: true), name)
      // Outside a password field every key that the hands may send goes.
      XCTAssertTrue(SecureField.permitsKey(combo, focusSecure: false), name)
    }
  }

  func testADragThatPressesOrDropsOnAPasswordFieldIsRefused() {
    XCTAssertFalse(SecureField.permitsDrag(source: false, target: true))
    XCTAssertFalse(SecureField.permitsDrag(source: nil, target: true))
    XCTAssertFalse(SecureField.permitsDrag(source: true, target: false))
    XCTAssertFalse(SecureField.permitsDrag(source: true, target: nil))
    // A tree that says nothing refuses nothing here: macOS's own guard of the keyboard covers such an app.
    XCTAssertTrue(SecureField.permitsDrag(source: false, target: false))
    XCTAssertTrue(SecureField.permitsDrag(source: nil, target: nil))
  }
}
