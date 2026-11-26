import AppKit
import XCTest
@testable import ClawdTimeTaskPanel
import TaskPanelCore

/// The mascot and the guided cursor lie over the apps that the hands work in. They are built off screen here:
/// no window is shown and nothing moves on the screen.
@MainActor
final class OwnOverlayViewTests: XCTestCase {
  func testTheMascotAndTheCursorAreNeverWhatTheHandsJudgeTheScreenBy() {
    let pet = PetController(defaults: MemoryDefaults())
    let guide = GuidedCursor(pet: pet)
    let own = Int(getpid())
    for window in [pet.window, guide.window] {
      // Not at the level of ordinary windows, and of this process: never a surface or a cover.
      XCTAssertNotEqual(window.level.rawValue, 0)
      XCTAssertFalse(OwnWindows.judged(layer: window.level.rawValue, owner: own, own: own))
      // They never take the keyboard from the app in front.
      XCTAssertFalse(window.canBecomeKey); XCTAssertFalse(window.canBecomeMain)
    }
    // The cursor and its trail take no click, answer no hit test and are no element of the Accessibility tree.
    XCTAssertTrue(guide.window.ignoresMouseEvents)
    XCTAssertNil(guide.window.contentView?.hitTest(NSPoint(x: 10, y: 10)))
    XCTAssertEqual(guide.window.contentView?.isAccessibilityElement(), false)
    let trail = GuidedTrailView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
    XCTAssertNil(trail.hitTest(NSPoint(x: 10, y: 10)))
    XCTAssertFalse(trail.isAccessibilityElement())
    // A screen share shows the cursor: the shield of a run leaves it as it is.
    XCTAssertTrue(guide.isOverlay(guide.window)); XCTAssertFalse(guide.isOverlay(pet.window))
    XCTAssertEqual(guide.window.sharingType, .readOnly)
  }

  func testAMascotThatIsPutAwayNeverMovesForTheHands() {
    let pet = PetController(defaults: MemoryDefaults())
    let before = pet.window.frame
    XCTAssertFalse(pet.makeRoom(for: [before, CGRect(x: 0, y: 0, width: 4000, height: 4000)]))
    XCTAssertTrue(pet.roomMade)
    XCTAssertEqual(pet.window.frame, before)
  }
}
