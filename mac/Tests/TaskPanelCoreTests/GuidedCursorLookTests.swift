import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// The look of the guided cursor, where its label sits, and what its window must be.
final class GuidedCursorLookTests: XCTestCase {
  let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)

  func testTheWindowIsAboveEverythingOnEverySpaceInAScreenShareAndTakesNoClick() {
    let rule = GuidedOverlay.cursor
    // Above the menu bar (24), the status items (25) and a menu that is open (101).
    XCTAssertGreaterThan(rule.level, 101)
    XCTAssertEqual(rule.level, 1000)
    XCTAssertTrue(rule.ignoresMouseEvents)
    XCTAssertTrue(rule.onEverySpace)
    XCTAssertTrue(rule.besideFullScreenApps)
    // A window that is kept out of captures would not be in a screen share.
    XCTAssertTrue(rule.inScreenShare)
  }

  func testThePointerTheRingAndTheLettersAreClearOnAPhoneThatShowsTheScreen() {
    XCTAssertEqual(GuidedLook.pointer, 28)
    XCTAssertGreaterThan(GuidedLook.ring, GuidedLook.pointer)
    XCTAssertGreaterThanOrEqual(GuidedLook.ringLine, 3)
    XCTAssertGreaterThan(GuidedLook.pill, GuidedLook.letters)
    // A screen of 1512 by 982 points, shown as a picture of 1280 by 720 pixels, fits by its height.
    func shown(_ points: Double) -> Double { GuidedLook.pixels(points, screenHeight: 982, shownHeight: 720) }
    XCTAssertGreaterThanOrEqual(shown(GuidedLook.pointer), 20)
    XCTAssertGreaterThanOrEqual(shown(GuidedLook.ring), 30)
    XCTAssertGreaterThanOrEqual(shown(GuidedLook.ringLine), 2.5)
    XCTAssertGreaterThanOrEqual(shown(GuidedLook.letters), 14)
    // The same on a screen of 1440 by 900 points.
    XCTAssertGreaterThanOrEqual(GuidedLook.pixels(GuidedLook.letters, screenHeight: 900, shownHeight: 720), 14)
    XCTAssertEqual(GuidedLook.pixels(28, screenHeight: 982, shownHeight: 720), 28 * 720 / 982, accuracy: 0.000_001)
    XCTAssertEqual(GuidedLook.pixels(28, screenHeight: 0, shownHeight: 720), 0)
    XCTAssertEqual(GuidedLook.pixels(.nan, screenHeight: 982, shownHeight: 720), 0)
    XCTAssertEqual(GuidedLook.pixels(-5, screenHeight: 982, shownHeight: 720), 0)
  }

  func testThePillIsAsWideAsItsLettersUpToALimit() {
    XCTAssertEqual(GuidedLook.pillWidth(text: 0), 0)
    XCTAssertEqual(GuidedLook.pillWidth(text: -3), 0)
    XCTAssertEqual(GuidedLook.pillWidth(text: .nan), 0)
    XCTAssertEqual(GuidedLook.pillWidth(text: 100), 130)
    XCTAssertEqual(GuidedLook.pillWidth(text: 100.2), 131)
    XCTAssertEqual(GuidedLook.pillWidth(text: 9000), GuidedLook.pillMax)
  }

  func testTheLabelIsOneCleanShortLine() {
    XCTAssertEqual(GuidedLook.label("Click \"Save\""), "Click \"Save\"")
    XCTAssertEqual(GuidedLook.label("  Type in\n\"Search\"\t field "), "Type in \"Search\" field")
    XCTAssertEqual(GuidedLook.label(""), "")
    let long = GuidedLook.label("Click \"" + String(repeating: "a very long name ", count: 20) + "\"")
    XCTAssertLessThanOrEqual(long.utf16.count, GuidedLook.labelLimit)
    XCTAssertTrue(long.hasSuffix("\u{2026}"))
    XCTAssertFalse(GuidedLook.label("Press\u{0007} cmd+s\u{202E}").unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x202E })
  }

  /// The parts of a layout, on the screen.
  func onScreen(_ layout: GuidedLayout) -> (tip: CGPoint, pill: CGRect) {
    (CGPoint(x: layout.window.minX + layout.tip.x, y: layout.window.minY + layout.tip.y),
     layout.pill.offsetBy(dx: layout.window.minX, dy: layout.window.minY))
  }

  func testThePillIsBesideThePointerToTheRightAndALittleUnderIt() {
    let tip = CGPoint(x: 600, y: 500)
    let layout = GuidedLayout(tip: tip, pillWidth: 180, screen: screen)
    XCTAssertEqual(layout.side, .right); XCTAssertTrue(layout.under)
    let shown = onScreen(layout)
    XCTAssertEqual(shown.tip, tip)
    XCTAssertEqual(shown.pill.width, 180); XCTAssertEqual(shown.pill.height, GuidedLook.pill)
    // Beside the ring, with a space between, and its middle under the tip.
    XCTAssertEqual(shown.pill.minX, tip.x + GuidedLook.ring / 2 + GuidedLook.gap)
    XCTAssertEqual(shown.pill.midY, tip.y - GuidedLook.drop)
    // The window holds the ring with its pulse, the pointer under the tip, and the pill with its shadow.
    XCTAssertTrue(layout.window.contains(CGRect(x: tip.x - GuidedLook.ring * GuidedLook.pulse / 2, y: tip.y - GuidedLook.ring * GuidedLook.pulse / 2,
                                                width: GuidedLook.ring * GuidedLook.pulse, height: GuidedLook.ring * GuidedLook.pulse)))
    XCTAssertTrue(layout.window.contains(CGPoint(x: tip.x + 18, y: tip.y - GuidedLook.pointer)))
    XCTAssertTrue(layout.window.contains(shown.pill.insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade)))
    // The pill does not lie on the tip or on the ring.
    XCTAssertFalse(shown.pill.contains(tip))
    XCTAssertGreaterThanOrEqual(shown.pill.minX - tip.x, GuidedLook.ring / 2)
  }

  func testNearTheRightEdgeThePillGoesToTheLeftAndNearTheBottomItGoesOver() {
    let right = GuidedLayout(tip: CGPoint(x: 1480, y: 500), pillWidth: 180, screen: screen)
    XCTAssertEqual(right.side, .left); XCTAssertTrue(right.under)
    XCTAssertEqual(onScreen(right).tip, CGPoint(x: 1480, y: 500))
    XCTAssertEqual(onScreen(right).pill.maxX, 1480 - GuidedLook.ring / 2 - GuidedLook.gap)
    let bottom = GuidedLayout(tip: CGPoint(x: 600, y: 20), pillWidth: 180, screen: screen)
    XCTAssertEqual(bottom.side, .right); XCTAssertFalse(bottom.under)
    XCTAssertEqual(onScreen(bottom).pill.midY, 20 + GuidedLook.drop)
    let corner = GuidedLayout(tip: CGPoint(x: 1500, y: 10), pillWidth: 180, screen: screen)
    XCTAssertEqual(corner.side, .left); XCTAssertFalse(corner.under)
    // A screen too narrow for the pill on either side keeps the usual side.
    let narrow = GuidedLayout(tip: CGPoint(x: 100, y: 300), pillWidth: 180, screen: CGRect(x: 0, y: 0, width: 220, height: 600))
    XCTAssertEqual(narrow.side, .right)
  }

  func testTheWholeLabelIsOnTheScreenWhereverTheHandsAct() {
    for width in [60.0, 180, 320, GuidedLook.pillMax] {
      for x in stride(from: 0.0, through: 1512, by: 36) {
        for y in stride(from: 0.0, through: 982, by: 49) {
          let tip = CGPoint(x: x, y: y)
          let layout = GuidedLayout(tip: tip, pillWidth: width, screen: screen)
          let shown = onScreen(layout)
          // The tip of the pointer is exactly where the hands act.
          XCTAssertEqual(shown.tip.x, tip.x, accuracy: 0.000_001); XCTAssertEqual(shown.tip.y, tip.y, accuracy: 0.000_001)
          XCTAssertGreaterThanOrEqual(shown.pill.minX, screen.minX + GuidedLook.margin - 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertLessThanOrEqual(shown.pill.maxX, screen.maxX - GuidedLook.margin + 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertGreaterThanOrEqual(shown.pill.minY, screen.minY + GuidedLook.margin - 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertLessThanOrEqual(shown.pill.maxY, screen.maxY, "x \(x) y \(y) width \(width)")
          XCTAssertFalse(shown.pill.contains(tip))
        }
      }
    }
  }

  func testTheWindowKeepsItsSizeWhileTheCursorGlidesOnOneSide() {
    // The same label on the same side: only the place of the window changes, so nothing is drawn again.
    let first = GuidedLayout(tip: CGPoint(x: 300, y: 400), pillWidth: 180, screen: screen)
    let second = GuidedLayout(tip: CGPoint(x: 640.5, y: 512.25), pillWidth: 180, screen: screen)
    XCTAssertEqual(first.window.size, second.window.size)
    XCTAssertEqual(first.tip, second.tip); XCTAssertEqual(first.pill, second.pill)
    XCTAssertEqual(second.window.origin.x - first.window.origin.x, 340.5, accuracy: 0.000_001)
    XCTAssertEqual(second.window.origin.y - first.window.origin.y, 112.25, accuracy: 0.000_001)
  }

  func testWithNoLabelThereIsOnlyThePointerAndItsRing() {
    let tip = CGPoint(x: 700, y: 300)
    for width in [0.0, -4, .nan] {
      let layout = GuidedLayout(tip: tip, pillWidth: width, screen: screen)
      XCTAssertTrue(layout.pill.isEmpty)
      XCTAssertEqual(onScreen(layout).tip, tip)
      XCTAssertEqual(layout.window.width, GuidedLayout.reach * 2); XCTAssertEqual(layout.window.height, GuidedLayout.reach * 2)
    }
    // A pill is never wider than its limit.
    XCTAssertEqual(GuidedLayout(tip: tip, pillWidth: 9000, screen: screen).pill.width, GuidedLook.pillMax)
    // A place with no meaning gives a window and no pill, and nothing stops.
    XCTAssertTrue(GuidedLayout(tip: CGPoint(x: CGFloat.nan, y: 0), pillWidth: 180, screen: screen).pill.isEmpty)
  }

  func testBeforeTypedKeysTheCursorGoesToTheFieldThatHasTheKeyboard() {
    let pointer = CGPoint(x: 30, y: 950), last = CGPoint(x: 900, y: 120)
    // A field of one line: the tip is at its lower edge, a little inside its leading edge, so the pointer is under the text.
    let field = CGRect(x: 400, y: 600, width: 300, height: 24)
    XCTAssertEqual(GuidedFocus.place(focus: field, shown: last, pointer: pointer, screen: screen), CGPoint(x: 418, y: 600))
    XCTAssertEqual(GuidedFocus.place(focus: field, shown: nil, pointer: pointer, screen: screen), CGPoint(x: 418, y: 600))
    // A field narrower than twice that distance: its middle.
    XCTAssertEqual(GuidedFocus.place(focus: CGRect(x: 400, y: 600, width: 20, height: 24), shown: nil, pointer: pointer, screen: screen), CGPoint(x: 410, y: 600))
    // An area of text: the cursor stays where the hands clicked inside it, or goes near its top leading corner.
    let area = CGRect(x: 200, y: 100, width: 900, height: 700)
    let clicked = CGPoint(x: 640, y: 420)
    XCTAssertEqual(GuidedFocus.place(focus: area, shown: clicked, pointer: pointer, screen: screen), clicked)
    XCTAssertEqual(GuidedFocus.place(focus: area, shown: CGPoint(x: 1300, y: 900), pointer: pointer, screen: screen), CGPoint(x: 218, y: 770))
    XCTAssertEqual(GuidedFocus.place(focus: area, shown: nil, pointer: pointer, screen: screen), CGPoint(x: 218, y: 770))
    // Only the part of a field that is on the screen counts.
    XCTAssertEqual(GuidedFocus.place(focus: CGRect(x: -100, y: 600, width: 300, height: 24), shown: nil, pointer: pointer, screen: screen), CGPoint(x: 18, y: 600))
    // No frame, a frame off the screen or one with no meaning: where it last pointed, or else the real pointer.
    for focus in [nil, CGRect(x: 3000, y: 600, width: 300, height: 24), CGRect.null, CGRect.infinite, CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: 0, height: 0)] as [CGRect?] {
      XCTAssertEqual(GuidedFocus.place(focus: focus, shown: last, pointer: pointer, screen: screen), last)
      XCTAssertEqual(GuidedFocus.place(focus: focus, shown: nil, pointer: pointer, screen: screen), pointer)
    }
    // A last place that is off the screen is not used.
    XCTAssertEqual(GuidedFocus.place(focus: nil, shown: CGPoint(x: 5000, y: 5), pointer: pointer, screen: screen), pointer)
    XCTAssertEqual(GuidedFocus.place(focus: nil, shown: CGPoint(x: CGFloat.nan, y: 5), pointer: pointer, screen: screen), pointer)
  }
}
