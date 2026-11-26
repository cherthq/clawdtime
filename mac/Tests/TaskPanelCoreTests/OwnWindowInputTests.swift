import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// The hands never press a button, turn the wheel or type in a window of ClawdTime. The window list that they
/// judge the screen by leaves ClawdTime's windows out, so a window of its own that comes up during the glide or
/// a check of the service, such as the bubble with Approve on it, is read from AppKit's list right before the event.
final class OwnWindowInputTests: XCTestCase {
  private let bubble = CGRect(x: 1180, y: 120, width: 220, height: 96)
  private let mascot = CGRect(x: 1300, y: 20, width: 120, height: 120)

  func testAWindowOfClawdTimeThatCameUpAtThePlaceTakesThePress() {
    // The bubble of a request came up over the place after the hands let the mascot's clicks through.
    let windows = [OwnWindowState(frame: mascot, visible: true, takesClicks: false),
                   OwnWindowState(frame: bubble, visible: true, takesClicks: true)]
    XCTAssertTrue(OwnWindows.takePointer(at: CGPoint(x: 1200, y: 140), windows))
    // The mascot lets clicks through: a place under it alone is free.
    XCTAssertFalse(OwnWindows.takePointer(at: CGPoint(x: 1410, y: 30), windows))
    // A place under none of them is free.
    XCTAssertFalse(OwnWindows.takePointer(at: CGPoint(x: 400, y: 400), windows))
  }

  func testAWindowThatDoesNotShowOrLetsClicksThroughTakesNoPress() {
    let place = CGPoint(x: 1200, y: 140)
    XCTAssertFalse(OwnWindows.takePointer(at: place, [OwnWindowState(frame: bubble, visible: false, takesClicks: true)]))
    XCTAssertFalse(OwnWindows.takePointer(at: place, [OwnWindowState(frame: bubble, visible: true, takesClicks: false)]))
    XCTAssertFalse(OwnWindows.takePointer(at: place, []))
    // Several windows: one that shows and takes clicks is enough.
    XCTAssertTrue(OwnWindows.takePointer(at: place, [OwnWindowState(frame: bubble, visible: false, takesClicks: true),
                                                     OwnWindowState(frame: bubble.insetBy(dx: -4, dy: -4), visible: true, takesClicks: true)]))
  }

  func testTheKeyboardIsClawdTimesWhenItsWindowHasItOrClawdTimeIsInFront() {
    XCTAssertFalse(OwnWindows.holdKeyboard(keyWindow: false, active: false))
    // The chat has the keyboard.
    XCTAssertTrue(OwnWindows.holdKeyboard(keyWindow: true, active: true))
    XCTAssertTrue(OwnWindows.holdKeyboard(keyWindow: true, active: false))
    // ClawdTime is in front with no window that has the keyboard: a key with Command would go to its menu, Command Q quits it.
    XCTAssertTrue(OwnWindows.holdKeyboard(keyWindow: false, active: true))
  }
}
