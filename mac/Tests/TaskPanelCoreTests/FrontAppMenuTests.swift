import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// A right click on a file opens the context menu of the app in front. The window list shows the menu as a window
/// above the ordinary ones, owned by the app in front, with no title. While it is open, Accessibility names the menu
/// as the app's focused window. A look then found no surface, and every click on an item and every key was refused.
/// The menu that the look saw must take the click and the keys. A window that came up at the click point after the
/// look still takes no click, whoever owns it, and ClawdTime's own windows never take one.
final class FrontAppMenuTests: XCTestCase {
  private let own = 501, front = 300, other = 400
  private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
  private let window = ListedWindow(id: 40, layer: 0, owner: 300, frame: CGRect(x: 58, y: 92, width: 920, height: 436))
  private let menuBar = ListedWindow(id: 3, layer: 24, owner: 88, frame: CGRect(x: 0, y: 0, width: 1512, height: 33))
  private let menu = ListedWindow(id: 91, layer: 101, owner: 300, frame: CGRect(x: 350, y: 184, width: 232, height: 485))
  /// An item of the context menu, such as Copy.
  private let item = CGPoint(x: 400, y: 220)

  private func floating(_ rows: [ListedWindow]) -> [DesktopCover] {
    OwnWindows.floatingCovers(rows, own: own, display: display)
  }

  func testAnOpenMenuThatAccessibilityNamesAsTheFocusedWindowLeavesItsWindowAsTheSurface() {
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focusedRole: "AXMenu", mainRole: "AXWindow", input: true), .main)
    // A move to another app or desktop never starts from an open menu.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focusedRole: "AXMenu", mainRole: "AXWindow", input: false), .none)
    // With no main window, or a main window that is no window, there is no surface.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focusedRole: "AXMenu", mainRole: nil, input: true), .none)
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focusedRole: "AXMenu", mainRole: "AXMenu", input: true), .none)
    // Every other focused window stays the surface, as before: a window, a sheet, one that names no role.
    for role in ["AXWindow", "AXSheet", nil] as [String?] {
      XCTAssertEqual(DesktopWindowVisibility.inputWindow(focusedRole: role, mainRole: "AXWindow", input: true), .focused, "\(role ?? "nil")")
    }
  }

  func testAMenuThatOpenedOrClosedSinceTheLookEndsTheInput() {
    // The look saw the menu open, and it is still open: Escape, an arrow key or a click on an item goes to it.
    XCTAssertTrue(DesktopWindowVisibility.sameMenu(looked: true, now: true))
    XCTAssertTrue(DesktopWindowVisibility.sameMenu(looked: false, now: false))
    // A Tab or a Space in typed text opened a pop-up menu: the next letters and Return would pick its items.
    XCTAssertFalse(DesktopWindowVisibility.sameMenu(looked: false, now: true))
    // The menu that the look saw closed: the keys would go to the window, not to the menu.
    XCTAssertFalse(DesktopWindowVisibility.sameMenu(looked: true, now: false))
  }

  func testAMenuOfTheAppInFrontThatTheLookSawTakesTheClick() {
    let open = floating([menu, menuBar, window])
    XCTAssertTrue(open.contains(DesktopCover(id: 91, frame: menu.frame!)))
    XCTAssertFalse(OwnWindows.floatingCover(at: item, observed: open, current: open))
  }

  func testAMenuOrSubmenuThatCameUpAtTheClickPointAfterTheLookIsACover() {
    // The menu opened during the look or after it: the picture may not show it, so its item is no target.
    XCTAssertTrue(OwnWindows.floatingCover(at: item, observed: floating([menuBar, window]), current: floating([menu, menuBar, window])))
    // A submenu that opened as the pointer went across its parent item, over the place of the click.
    let open = floating([menu, menuBar, window])
    let submenu = ListedWindow(id: 92, layer: 101, owner: front, frame: CGRect(x: 582, y: 300, width: 200, height: 120))
    let target = CGPoint(x: 600, y: 320)
    XCTAssertTrue(OwnWindows.floatingCover(at: target, observed: open, current: floating([submenu, menu, menuBar, window])))
    // The same submenu in the look: a click on its item goes.
    let seen = floating([submenu, menu, menuBar, window])
    XCTAssertFalse(OwnWindows.floatingCover(at: target, observed: seen, current: seen))
  }

  func testANotificationBannerOfAnotherAppAtTheClickPointIsStillACover() {
    let banner = ListedWindow(id: 77, layer: 23, owner: other, frame: CGRect(x: 1100, y: 40, width: 360, height: 80))
    XCTAssertTrue(OwnWindows.floatingCover(at: CGPoint(x: 1200, y: 70), observed: floating([menuBar, window]),
                                           current: floating([banner, menuBar, window])))
    // A floating panel of another app that came up over an item of the open menu takes the click too.
    let open = floating([menu, menuBar, window])
    let panel = ListedWindow(id: 79, layer: 3, owner: other, frame: CGRect(x: 360, y: 190, width: 120, height: 60))
    XCTAssertTrue(OwnWindows.floatingCover(at: item, observed: open, current: floating([panel, menu, menuBar, window])))
    // A row that names no owner or no level counts; a row with no place cannot be placed.
    XCTAssertEqual(floating([ListedWindow(id: 80, layer: 101, owner: nil, frame: menu.frame)]).count, 1)
    XCTAssertEqual(floating([ListedWindow(id: 81, layer: nil, owner: other, frame: menu.frame)]).count, 1)
    XCTAssertEqual(floating([ListedWindow(id: 82, layer: 101, owner: other, frame: nil)]).count, 0)
  }

  func testClawdTimeOwnWindowsNeverCountAndStillTakeNoClick() {
    // The guided cursor and a bubble with Approve: the window list of the hands never counts them.
    let cursor = ListedWindow(id: 5, layer: 1000, owner: own, frame: CGRect(x: 380, y: 200, width: 60, height: 60))
    let bubble = ListedWindow(id: 6, layer: 3, owner: own, frame: CGRect(x: 360, y: 190, width: 220, height: 90))
    XCTAssertEqual(floating([cursor, bubble, menu, menuBar, window]), floating([menu, menuBar, window]))
    // Their own check, read right before each press, still keeps the press off one that takes clicks.
    let shown = OwnWindowState(frame: CGRect(x: 360, y: 702, width: 220, height: 90), visible: true, takesClicks: true)
    XCTAssertTrue(OwnWindows.takePointer(at: CGPoint(x: 400, y: 740), [shown]))
  }
}
