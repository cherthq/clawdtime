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

  func testThePaintedBoundsHoldTheArrowItsRaysAndTheWholeClick() {
    let tip = CGPoint(x: 400, y: 300)
    let layout = GuidedLayout(tip: tip, pillWidth: 0, screen: screen)
    let pad = GuidedCursorArt.glowPad
    // The arrow with its glow, under the tip and to its right.
    XCTAssertTrue(layout.paintedBounds.contains(GuidedCursorArt.arrowBounds.insetBy(dx: -pad, dy: -pad).offsetBy(dx: tip.x, dy: tip.y)))
    // The copy of the rays at the end of a click, with its glow, over the tip and to its left.
    let click = GuidedCursorArt.raysBounds.insetBy(dx: -pad, dy: -pad)
      .applying(CGAffineTransform(scaleX: CGFloat(GuidedClick.spread), y: CGFloat(GuidedClick.spread))).offsetBy(dx: tip.x, dy: tip.y)
    XCTAssertTrue(layout.paintedBounds.contains(click))
    // All of that is inside the window, and the window is the square that the pictures need.
    XCTAssertTrue(layout.window.contains(layout.paintedBounds))
    XCTAssertEqual(GuidedLayout.reach, GuidedCursorArt.side / 2)
  }

  func testTheArrowAndTheLettersAreClearOnAPhoneThatShowsTheScreen() {
    XCTAssertGreaterThan(GuidedLook.pill, GuidedLook.letters)
    // A screen of 1512 by 982 points, shown as a picture of 1280 by 720 pixels, fits by its height.
    func shown(_ points: Double) -> Double { GuidedLook.pixels(points, screenHeight: 982, shownHeight: 720) }
    XCTAssertGreaterThanOrEqual(shown(Double(GuidedCursorArt.arrowPath.boundingBoxOfPath.height)), 16)
    XCTAssertGreaterThanOrEqual(shown(GuidedCursorArt.rayLine), 1.6)
    XCTAssertGreaterThanOrEqual(shown(GuidedLook.letters), 14)
    // The same on a screen of 1440 by 900 points.
    XCTAssertGreaterThanOrEqual(GuidedLook.pixels(GuidedLook.letters, screenHeight: 900, shownHeight: 720), 14)
    XCTAssertEqual(GuidedLook.pixels(28, screenHeight: 982, shownHeight: 720), 28 * 720 / 982, accuracy: 0.000_001)
    XCTAssertEqual(GuidedLook.pixels(28, screenHeight: 0, shownHeight: 720), 0)
    XCTAssertEqual(GuidedLook.pixels(.nan, screenHeight: 982, shownHeight: 720), 0)
    XCTAssertEqual(GuidedLook.pixels(-5, screenHeight: 982, shownHeight: 720), 0)
  }

  func testWithReduceMotionNothingMoves() {
    // No glide: the cursor is at the target at once, on no curve.
    let way = GuidedPath.glide(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 900, y: 600), still: true)
    XCTAssertEqual(way.duration, 0); XCTAssertEqual(way.bend, 0)
    XCTAssertEqual(way.point(at: 0), CGPoint(x: 900, y: 600))
    // No pulse at a click.
    XCTAssertTrue(GuidedClick.frames(still: true).isEmpty)
    XCTAssertNil(GuidedClick.frame(at: 0, still: true))
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

  /// Points inside the arrow, every half point, around its tip.
  static let arrowPoints: [CGPoint] = {
    let path = GuidedCursorArt.arrowPath, box = path.boundingBoxOfPath
    var points: [CGPoint] = []
    for x in stride(from: box.minX, through: box.maxX, by: 0.5) {
      for y in stride(from: box.minY, through: box.maxY, by: 0.5) where path.contains(CGPoint(x: x, y: y)) { points.append(CGPoint(x: x, y: y)) }
    }
    return points
  }()
  /// The pill lies on no part of the arrow, its edge or its rays, as they are painted around `tip`.
  func clear(_ pill: CGRect, of tip: CGPoint) -> Bool {
    let near = pill.insetBy(dx: -(GuidedCursorArt.edgeLine / 2 + 0.5), dy: -(GuidedCursorArt.edgeLine / 2 + 0.5))
    guard near.intersection(GuidedCursorArt.raysBounds.offsetBy(dx: tip.x, dy: tip.y)).isNull else { return false }
    return !Self.arrowPoints.contains { near.contains(CGPoint(x: $0.x + tip.x, y: $0.y + tip.y)) }
  }

  func testThePillIsJustBelowAndToTheRightOfTheArrow() {
    let tip = CGPoint(x: 600, y: 500)
    let layout = GuidedLayout(tip: tip, pillWidth: 180, screen: screen)
    XCTAssertEqual(layout.side, .right); XCTAssertTrue(layout.under)
    let shown = onScreen(layout)
    XCTAssertEqual(shown.tip, tip)
    XCTAssertEqual(shown.pill.width, 180); XCTAssertEqual(shown.pill.height, GuidedLook.pill)
    // Its leading edge to the right of the tip, its top edge under it: in the space between the two wings.
    XCTAssertEqual(shown.pill.minX, tip.x + GuidedLook.ahead)
    XCTAssertEqual(shown.pill.maxY, tip.y - GuidedLook.below)
    // It does not lie on the arrow, its edge or its rays.
    XCTAssertGreaterThan(Self.arrowPoints.count, 200)
    XCTAssertTrue(clear(shown.pill, of: tip))
    // The check finds a pill that would lie on the arrow.
    XCTAssertFalse(clear(shown.pill.offsetBy(dx: -8, dy: 8), of: tip))
    // It is near the arrow: its corner is within a few points of the notch.
    XCTAssertLessThanOrEqual(shown.pill.minX - tip.x, GuidedCursorArt.arrowBounds.maxX)
    XCTAssertLessThanOrEqual(tip.y - shown.pill.maxY, -GuidedCursorArt.arrowBounds.minY)
    // The window holds the arrow and its rays, and the pill with its shadow.
    XCTAssertTrue(layout.window.contains(CGRect(x: tip.x - GuidedLayout.reach, y: tip.y - GuidedLayout.reach,
                                                width: GuidedLayout.reach * 2, height: GuidedLayout.reach * 2)))
    XCTAssertTrue(layout.window.contains(shown.pill.insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade)))
  }

  func testNearTheRightEdgeThePillGoesToTheLeftAndNearTheBottomItGoesOver() {
    let right = GuidedLayout(tip: CGPoint(x: 1480, y: 500), pillWidth: 180, screen: screen)
    XCTAssertEqual(right.side, .left); XCTAssertTrue(right.under)
    XCTAssertEqual(onScreen(right).tip, CGPoint(x: 1480, y: 500))
    XCTAssertEqual(onScreen(right).pill.maxX, 1480 - GuidedLook.behind)
    let bottom = GuidedLayout(tip: CGPoint(x: 600, y: 20), pillWidth: 180, screen: screen)
    XCTAssertEqual(bottom.side, .right); XCTAssertFalse(bottom.under)
    XCTAssertEqual(onScreen(bottom).pill.minY, 20 + GuidedLook.above)
    let corner = GuidedLayout(tip: CGPoint(x: 1500, y: 10), pillWidth: 180, screen: screen)
    XCTAssertEqual(corner.side, .left); XCTAssertFalse(corner.under)
    // A screen too narrow for the pill on either side keeps the usual side.
    let narrow = GuidedLayout(tip: CGPoint(x: 100, y: 300), pillWidth: 180, screen: CGRect(x: 0, y: 0, width: 220, height: 600))
    XCTAssertEqual(narrow.side, .right)
  }

  func testAtEveryEdgeAndCornerOfTheScreenThePillIsWholeAndOffTheArrow() {
    // The four edges and the four corners, at the very edge and a little inside it.
    let xs: [CGFloat] = [0, 1, 30, 756, 1482, 1511, 1512], ys: [CGFloat] = [0, 1, 30, 491, 952, 981, 982]
    for width in [60.0, 180, GuidedLook.pillMax] {
      for x in xs {
        for y in ys {
          let tip = CGPoint(x: x, y: y)
          let layout = GuidedLayout(tip: tip, pillWidth: width, screen: screen)
          let shown = onScreen(layout), at = "x \(x) y \(y) width \(width)"
          XCTAssertEqual(shown.tip, tip, at)
          XCTAssertTrue(screen.insetBy(dx: GuidedLook.margin - 0.000_001, dy: GuidedLook.margin - 0.000_001).contains(shown.pill), at)
          XCTAssertTrue(clear(shown.pill, of: tip), at)
          // The usual place is below and to the right. The pill leaves it only at the right or the bottom edge.
          XCTAssertEqual(layout.side == .right, x + GuidedLook.ahead + width <= screen.maxX - GuidedLook.margin, at)
          XCTAssertEqual(layout.under, y - GuidedLook.below - GuidedLook.pill >= screen.minY + GuidedLook.margin, at)
        }
      }
    }
  }

  func testTheWholeLabelIsOnTheScreenWhereverTheHandsAct() {
    for width in [60.0, 180, 320, GuidedLook.pillMax] {
      for x in stride(from: 0.0, through: 1512, by: 36) {
        for y in stride(from: 0.0, through: 982, by: 49) {
          let tip = CGPoint(x: x, y: y)
          let layout = GuidedLayout(tip: tip, pillWidth: width, screen: screen)
          let shown = onScreen(layout)
          // The tip of the arrow is exactly where the hands act.
          XCTAssertEqual(shown.tip.x, tip.x, accuracy: 0.000_001); XCTAssertEqual(shown.tip.y, tip.y, accuracy: 0.000_001)
          XCTAssertGreaterThanOrEqual(shown.pill.minX, screen.minX + GuidedLook.margin - 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertLessThanOrEqual(shown.pill.maxX, screen.maxX - GuidedLook.margin + 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertGreaterThanOrEqual(shown.pill.minY, screen.minY + GuidedLook.margin - 0.000_001, "x \(x) y \(y) width \(width)")
          XCTAssertLessThanOrEqual(shown.pill.maxY, screen.maxY, "x \(x) y \(y) width \(width)")
          XCTAssertFalse(shown.pill.contains(tip))
          XCTAssertTrue(clear(shown.pill, of: tip), "x \(x) y \(y) width \(width)")
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
    // That holds to the last digit at every place of a glide, also at places with a long fraction.
    let way = GuidedPath.glide(from: CGPoint(x: 301.37, y: 399.91), to: CGPoint(x: 977.13, y: 641.07), still: false)
    for frame in 0...108 {
      let layout = GuidedLayout(tip: way.point(at: way.duration * Double(frame) / 108), pillWidth: 180, screen: screen)
      XCTAssertEqual(layout.window.size, first.window.size); XCTAssertEqual(layout.tip, first.tip); XCTAssertEqual(layout.pill, first.pill)
    }
  }

  func testWithNoLabelThereIsOnlyTheArrowAndItsRays() {
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

  func testPresentationRegionIncludesTheLongestCentralLabelBeyondAnActionCentredCrop() throws {
    let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let tip = CGPoint(x: 720, y: 450)
    let layout = GuidedLayout(tip: tip, pillWidth: GuidedLook.pillMax, screen: display)
    let pill = onScreen(layout).pill
    let painted = layout.paintedBounds.intersection(display)
    XCTAssertTrue(painted.contains(pill.insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade)))
    XCTAssertTrue(painted.contains(tip))
    // This is the regression: a 1.8x action-centred crop loses the far end.
    let oldCrop = CGRect(x: tip.x - 1440 / 1.8 / 2, y: 0, width: 1440 / 1.8, height: 900)
    XCTAssertFalse(oldCrop.contains(pill))
    XCTAssertGreaterThan(painted.maxX, oldCrop.maxX)
    // Use only painted geometry, not the slightly larger transparent window.
    XCTAssertLessThan(painted.width, layout.window.width)
    let map = try XCTUnwrap(ScreenMap(width: 1440, height: 900, scale: 2))
    let region = map.flip(painted)
    XCTAssertEqual(region.width, painted.width)
    XCTAssertTrue(region.contains(map.flip(pill)))
    XCTAssertTrue(region.contains(map.flip(tip)))
  }

  func testPresentationRegionKeepsTheLongestLabelArrowAndClickInsideEveryScreenEdge() {
    let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
    for point in [CGPoint(x: 0, y: 0), CGPoint(x: 1439, y: 0), CGPoint(x: 0, y: 899),
                  CGPoint(x: 1439, y: 899), CGPoint(x: 1400, y: 450)] {
      let layout = GuidedLayout(tip: point, pillWidth: GuidedLook.pillMax, screen: display)
      let painted = layout.paintedBounds.intersection(display)
      XCTAssertTrue(display.contains(painted))
      XCTAssertTrue(painted.contains(onScreen(layout).pill))
      let click = GuidedCursorArt.raysBounds.applying(CGAffineTransform(scaleX: CGFloat(GuidedClick.spread), y: CGFloat(GuidedClick.spread)))
      XCTAssertTrue(painted.contains(click.offsetBy(dx: point.x, dy: point.y).intersection(display)))
      XCTAssertTrue(painted.contains(GuidedCursorArt.arrowBounds.offsetBy(dx: point.x, dy: point.y).intersection(display)))
    }
  }

  func testTypingPresentationIncludesFreshFieldAndPlannedLabelInOriginalPoints() throws {
    let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let map = try XCTUnwrap(ScreenMap(width: 1440, height: 900, scale: 2))
    for field in [CGRect(x: 400, y: 100, width: 280, height: 24), CGRect(x: 1050, y: 850, width: 360, height: 30)] {
      let tip = GuidedFocus.place(focus: map.flip(field), shown: nil, pointer: .zero, screen: display)
      let layout = GuidedLayout(tip: tip, pillWidth: GuidedLook.pillMax, screen: display)
      let region = field.union(map.flip(layout.paintedBounds.intersection(display)))
      XCTAssertTrue(region.contains(field))
      XCTAssertTrue(region.contains(map.flip(onScreen(layout).pill)))
      XCTAssertTrue(region.contains(map.flip(tip)))
      XCTAssertTrue(display.contains(region))
      // Retina scaling is metadata only, never applied to input or these hints.
      XCTAssertEqual(map.flip(map.flip(field)), field)
    }
  }
}
