import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// Two states of the app in front in which every click and key of the hands was refused as a stale look, read on a
/// real Mac with macOS 26. A context menu or a menu of the menu bar is open: Accessibility names no focused window at
/// all, and the window list shows the menu as a window of the app at the level of menus. The Quick Look of a file is
/// open: Accessibility names it as the focused window, and the window list shows it as a window of the app above the
/// ordinary ones, with no name. In both, a look found no surface. The window under the menu and the Quick Look panel
/// must be surfaces of the input, while a window of another process stays a cover and ClawdTime's own windows never
/// count. The places and levels are the ones that the window list gave.
final class MenuAndPanelSurfaceTests: XCTestCase {
  private let own = 501, finder = 300, other = 400
  private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
  private let window = ListedWindow(id: 40, layer: 0, owner: 300, frame: CGRect(x: 58, y: 92, width: 920, height: 436))
  private let menuBar = ListedWindow(id: 3, layer: 24, owner: 88, frame: CGRect(x: 0, y: 0, width: 1512, height: 33))
  private let dock = ListedWindow(id: 8, layer: 20, owner: 89, frame: CGRect(x: 0, y: 0, width: 1512, height: 982))
  private let statusItem = ListedWindow(id: 26, layer: 25, owner: 87, frame: CGRect(x: 1120, y: 0, width: 38, height: 33))
  private let menu = ListedWindow(id: 91, layer: 101, owner: 300, frame: CGRect(x: 350, y: 184, width: 216, height: 461))
  private let quickLook = ListedWindow(id: 60, layer: 3, owner: 300, frame: CGRect(x: 571, y: 324, width: 370, height: 283))
  private let mascot = ListedWindow(id: 5, layer: 3, owner: 501, frame: CGRect(x: 1436, y: 267, width: 189, height: 189))
  /// The close button at the top left of the Quick Look panel.
  private let close = CGPoint(x: 586, y: 340)

  private func panel(_ frame: CGRect, _ rows: [ListedWindow], pid: Int = 300) -> DesktopFocusedWindow? {
    DesktopWindowVisibility.panelWindow(pid: pid, frame: frame, rows: rows, display: display, own: own)
  }

  func testAnAppThatNamesNoFocusedWindowUnderItsOpenMenuLeavesItsMainWindowAsTheSurface() {
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: true,
                                                       menuShown: true), .main)
    // A move to another app or desktop never starts from an open menu.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: false,
                                                       menuShown: true), .none)
    // No menu on the screen: an app with no focused window has no surface, as before.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: true,
                                                       menuShown: false), .none)
    // A menu over the desktop, or with no main window: there is no window under it.
    for main in ["AXScrollArea", nil] as [String?] {
      XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: main, input: true,
                                                         menuShown: true), .none, "\(main ?? "nil")")
    }
    // An app that names a focused window keeps the rule it had: a named menu, a window, a sheet.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: true, focusedRole: "AXMenu", mainRole: "AXWindow", input: true,
                                                       menuShown: true), .main)
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: true, focusedRole: "AXWindow", mainRole: "AXWindow", input: true,
                                                       menuShown: true), .focused)
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: true, focusedRole: "AXSheet", mainRole: "AXWindow", input: true,
                                                       menuShown: false), .focused)
  }

  func testOnlyAMenuOfTheAppInFrontAtTheLevelOfMenusIsAnOpenMenu() {
    XCTAssertTrue(DesktopWindowVisibility.menuShown([menuBar, menu, window], pid: finder, display: display))
    // The bar, the Dock, the icons of the menu bar, a panel and the windows of the app are no open menu.
    XCTAssertFalse(DesktopWindowVisibility.menuShown([menuBar, dock, statusItem, quickLook, window], pid: finder, display: display))
    // A menu of another process, such as the menu of an icon in the menu bar, is no menu of the app.
    let otherMenu = ListedWindow(id: 92, layer: 101, owner: other, frame: CGRect(x: 1000, y: 34, width: 280, height: 400))
    XCTAssertFalse(DesktopWindowVisibility.menuShown([otherMenu, window], pid: finder, display: display))
    // A row with no place, or one that lies off the display, shows nothing on it.
    XCTAssertFalse(DesktopWindowVisibility.menuShown([ListedWindow(id: 93, layer: 101, owner: finder, frame: nil)], pid: finder,
                                                     display: display))
    XCTAssertFalse(DesktopWindowVisibility.menuShown([ListedWindow(id: 94, layer: 101, owner: finder,
      frame: CGRect(x: 2000, y: 100, width: 200, height: 300))], pid: finder, display: display))
  }

  func testTheItemsOfTheMenuThatTheLookSawTakeTheClickAndEscapeGoesToIt() {
    let seen = OwnWindows.floatingCovers([mascot, menuBar, menu, window], own: own, display: display)
    XCTAssertFalse(OwnWindows.floatingCover(at: CGPoint(x: 380, y: 280), observed: seen, current: seen))
    // The look saw the menu open and it is still open: Escape goes to it.
    XCTAssertTrue(DesktopWindowVisibility.sameMenu(looked: true, now: true))
    // A submenu that came up at the place of the click after the look takes no click.
    let submenu = ListedWindow(id: 95, layer: 101, owner: finder, frame: CGRect(x: 566, y: 200, width: 220, height: 160))
    XCTAssertTrue(OwnWindows.floatingCover(at: CGPoint(x: 600, y: 250), observed: seen,
      current: OwnWindows.floatingCovers([submenu, mascot, menuBar, menu, window], own: own, display: display)))
  }

  func testTheQuickLookPanelOfTheAppInFrontIsTheSurface() {
    let rows = [statusItem, menuBar, dock, quickLook, mascot, window]
    XCTAssertEqual(panel(quickLook.frame!, rows), DesktopFocusedWindow(id: 60, covers: [], front: 0))
    // A place that differs by a point, as Accessibility and the window list may round it, is the same place.
    XCTAssertEqual(panel(quickLook.frame!.offsetBy(dx: 1, dy: -1), rows)?.id, 60)
    // Its close button takes the click: the look saw the panel, and nothing came up over it.
    let seen = OwnWindows.floatingCovers(rows, own: own, display: display)
    XCTAssertFalse(OwnWindows.floatingCover(at: close, observed: seen, current: seen))
  }

  func testAPanelOfAnotherProcessOrOfClawdTimeIsNeverTheSurface() {
    let foreign = ListedWindow(id: 61, layer: 3, owner: other, frame: quickLook.frame)
    XCTAssertNil(panel(quickLook.frame!, [foreign, window]))
    // ClawdTime's own windows: neither as the app in front nor as a row at the place of the panel.
    XCTAssertNil(panel(mascot.frame!, [mascot, window], pid: own))
    XCTAssertNil(panel(mascot.frame!, [mascot, window]))
    // A banner of another process that came up over the close button after the look still takes no click.
    let rows = [menuBar, quickLook, window]
    let banner = ListedWindow(id: 77, layer: 23, owner: other, frame: CGRect(x: 571, y: 324, width: 360, height: 80))
    XCTAssertTrue(OwnWindows.floatingCover(at: close, observed: OwnWindows.floatingCovers(rows, own: own, display: display),
      current: OwnWindows.floatingCovers([banner] + rows, own: own, display: display)))
  }

  func testOnlyOneWindowOfTheAppAboveTheOrdinaryOnesAndBelowTheMenusMatchesAPanel() {
    // Two windows of the app at the same place: the place does not say which one has the keyboard.
    let twin = ListedWindow(id: 62, layer: 3, owner: finder, frame: quickLook.frame)
    XCTAssertNil(panel(quickLook.frame!, [twin, quickLook, window]))
    // An ordinary window is matched by its name and place, never as a panel.
    XCTAssertNil(panel(window.frame!, [window]))
    // An open menu is never a panel, and a row with no level or no place matches nothing.
    XCTAssertNil(panel(menu.frame!, [menu, window]))
    XCTAssertNil(panel(quickLook.frame!, [ListedWindow(id: 63, layer: nil, owner: finder, frame: quickLook.frame)]))
    XCTAssertNil(panel(quickLook.frame!, [ListedWindow(id: 64, layer: 3, owner: finder, frame: nil)]))
    // Another place, or a row with no number, matches nothing.
    XCTAssertNil(panel(quickLook.frame!.offsetBy(dx: 12, dy: 0), [quickLook, window]))
    XCTAssertNil(panel(quickLook.frame!, [ListedWindow(id: nil, layer: 3, owner: finder, frame: quickLook.frame)]))
    // A panel off the display is no surface on it.
    let away = CGRect(x: 1600, y: 300, width: 370, height: 283)
    XCTAssertNil(panel(away, [ListedWindow(id: 65, layer: 3, owner: finder, frame: away)]))
  }
}
