import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// A window of another app above the ordinary ones, such as a notification banner, can come up at the place of a
/// click after the look. The click would land on it. The window list that judges the surface reads only ordinary
/// windows, so such a window is read on its own and counts as a cover when it is new at the place.
final class FloatingWindowCoverTests: XCTestCase {
  private let own = 501
  private let banner = CGRect(x: 1100, y: 40, width: 360, height: 80)
  private let menuBar = CGRect(x: 0, y: 0, width: 1512, height: 33)

  func testAWindowOfAnotherProcessAboveTheOrdinaryOnesIsFloating() {
    // A notification banner, the menu bar, the Dock, a floating panel of the app in front.
    for layer in [3, 20, 23, 24, 25, 101] { XCTAssertTrue(OwnWindows.floating(layer: layer, owner: 400, own: own), "\(layer)") }
    // An ordinary window is judged by the rule of the surface, not here.
    XCTAssertFalse(OwnWindows.floating(layer: 0, owner: 400, own: own))
    // ClawdTime's own windows are never covers: its own check is separate.
    XCTAssertFalse(OwnWindows.floating(layer: 25, owner: own, own: own))
    XCTAssertFalse(OwnWindows.judged(layer: 25, owner: 400, own: own))
    // A row that does not say its level or its owner counts.
    XCTAssertTrue(OwnWindows.floating(layer: nil, owner: 400, own: own))
    XCTAssertTrue(OwnWindows.floating(layer: 23, owner: nil, own: own))
  }

  func testABannerThatCameUpAtThePlaceAfterTheLookIsACover() {
    let place = CGPoint(x: 1200, y: 70)
    let look = [DesktopCover(id: 3, frame: menuBar)]
    // The banner was not in the look.
    XCTAssertTrue(OwnWindows.floatingCover(at: place, observed: look, current: look + [DesktopCover(id: 77, frame: banner)]))
    // A banner that was in the look, the same window at the same place: the worker saw it.
    let seen = look + [DesktopCover(id: 77, frame: banner)]
    XCTAssertFalse(OwnWindows.floatingCover(at: place, observed: seen, current: seen))
    // The same window, moved over the place.
    XCTAssertTrue(OwnWindows.floatingCover(at: place, observed: [DesktopCover(id: 77, frame: banner.offsetBy(dx: 0, dy: 300))],
                                           current: [DesktopCover(id: 77, frame: banner)]))
    // A new banner elsewhere takes no click at the place.
    XCTAssertFalse(OwnWindows.floatingCover(at: CGPoint(x: 300, y: 500), observed: look, current: look + [DesktopCover(id: 77, frame: banner)]))
    // The menu bar of the look stays where it was: a click on a menu goes.
    XCTAssertFalse(OwnWindows.floatingCover(at: CGPoint(x: 40, y: 12), observed: look, current: look))
    // A banner that went away is no cover.
    XCTAssertFalse(OwnWindows.floatingCover(at: place, observed: seen, current: look))
  }
}
