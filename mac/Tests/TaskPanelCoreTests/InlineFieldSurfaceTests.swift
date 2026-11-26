import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// Finder opens the name of a file for editing: a new folder, or Return on a selected file. Read on a real Mac with
/// macOS 26: Accessibility names no focused window; the element with the keyboard is a text field whose parent is the
/// app itself, listed among the app's windows; the window list shows it as a small window of the app at the ordinary
/// level, in front of the window of the folder, 3 points larger on each side. A look then found no surface, and every
/// typed letter and key was refused. The window of the folder must be the surface with the field as a cover in front
/// of it, while a window of another process in front still leaves no surface and ClawdTime's own windows never count.
final class InlineFieldSurfaceTests: XCTestCase {
  private let own = 501, finder = 300, other = 400
  private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
  private let main = CGRect(x: 116, y: 150, width: 920, height: 436)
  /// The field as Accessibility gives it, and its window as the window list gives it.
  private let field = CGRect(x: 582, y: 275.5, width: 87, height: 16.5)
  private let fieldWindow = CGRect(x: 579, y: 272, width: 93, height: 23)

  private func evidence(_ rows: [(Int, Int, String?, CGRect)]) -> [DesktopWindowEvidence] {
    rows.map { DesktopWindowEvidence(id: $0.0, pid: $0.1, title: $0.2, frame: $0.3, alpha: 1) }
  }
  /// The frames of the app's windows that stand alone, as the reader takes them from the app's list of windows.
  private func standalone(_ windows: [(String?, String?, CGRect)]) -> [CGRect] {
    windows.filter { DesktopWindowVisibility.standsAlone(role: $0.0, subrole: $0.1) }.map(\.2)
  }

  func testWithNoFocusedWindowAnInlineFieldLeavesTheMainWindowAsTheSurface() {
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: true,
                                                       menuShown: false, inlineField: true), .field)
    // An open menu wins: it has the keyboard.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: true,
                                                       menuShown: true, inlineField: true), .main)
    // A move to another app or desktop never starts from it, and with no main window there is no surface.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: false,
                                                       menuShown: false, inlineField: true), .none)
    for mainRole in ["AXScrollArea", nil] as [String?] {
      XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: mainRole, input: true,
                                                         menuShown: false, inlineField: true), .none, "\(mainRole ?? "nil")")
    }
    // No field and no menu: no surface, as before. A focused window keeps its own rule.
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: false, focusedRole: nil, mainRole: "AXWindow", input: true,
                                                       menuShown: false), .none)
    XCTAssertEqual(DesktopWindowVisibility.inputWindow(focused: true, focusedRole: "AXWindow", mainRole: "AXWindow", input: true,
                                                       menuShown: false, inlineField: true), .focused)
  }

  func testOnlyATextFieldOfTheAppItselfInsideTheMainWindowIsAnInlineField() {
    XCTAssertTrue(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: "AXApplication", frame: field, main: main))
    XCTAssertTrue(DesktopWindowVisibility.inlineField(role: "AXTextArea", parentRole: "AXApplication", frame: field, main: main))
    // A field inside a window, a search field of the toolbar for one, has that window's parts as parents.
    for parent in ["AXWindow", "AXGroup", "AXToolbar", nil] as [String?] {
      XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: parent, frame: field, main: main),
                     "\(parent ?? "nil")")
    }
    // Another kind of element, a field with no place or no size, one outside the main window, or no main window.
    XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXButton", parentRole: "AXApplication", frame: field, main: main))
    XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: "AXApplication", frame: nil, main: main))
    XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: "AXApplication",
                                                       frame: CGRect(x: 582, y: 275, width: 0, height: 16), main: main))
    XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: "AXApplication",
                                                       frame: CGRect(x: 1100, y: 600, width: 87, height: 16), main: main))
    XCTAssertFalse(DesktopWindowVisibility.inlineField(role: "AXTextField", parentRole: "AXApplication", frame: field, main: nil))
  }

  func testATextFieldThatTheAppListsAsAWindowIsAPartOfAnotherWindow() {
    XCTAssertFalse(DesktopWindowVisibility.standsAlone(role: "AXTextField", subrole: nil))
    XCTAssertFalse(DesktopWindowVisibility.standsAlone(role: "AXTextArea", subrole: nil))
    // Windows, dialogs and sheets still stand alone.
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXWindow", subrole: "AXStandardWindow"))
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXWindow", subrole: "AXDialog"))
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXSheet", subrole: nil))
  }

  func testTheWindowOfTheFolderIsTheSurfaceWithTheFieldAsACover() {
    let visible = evidence([(77, finder, nil, fieldWindow), (40, finder, "untitled folder", main),
                            (41, finder, "Desktop", CGRect(x: 0, y: 34, width: 856, height: 545))])
    let alone = standalone([("AXTextField", nil, field), ("AXWindow", "AXStandardWindow", main),
                            ("AXWindow", "AXStandardWindow", CGRect(x: 0, y: 34, width: 856, height: 545))])
    let matched = DesktopWindowVisibility.focusedWindow(pid: finder, title: "untitled folder", frame: main, fullScreenConfirmed: false,
      display: display, visible: visible, accessibleFrames: nil, standaloneFrames: alone)
    XCTAssertEqual(matched, DesktopFocusedWindow(id: 40, covers: [DesktopCover(id: 77, frame: fieldWindow)], front: 1))
    // Keys and typed letters go to the field. A click on the field itself lies under the cover: it goes only when the
    // command names that cover and it did not change.
    XCTAssertTrue(matched?.hides(CGPoint(x: 600, y: 283)) == true)
    XCTAssertFalse(matched?.hides(CGPoint(x: 300, y: 400)) == true)
  }

  func testAFieldWindowAtTheExactPlaceOfTheFieldIsACoverToo() {
    // An app may list the field with the very place of its window. As a window in its own right it would leave no surface.
    let visible = evidence([(78, finder, nil, field), (40, finder, "Notes", main)])
    let alone = standalone([("AXTextField", nil, field), ("AXWindow", "AXStandardWindow", main)])
    XCTAssertEqual(DesktopWindowVisibility.focusedWindow(pid: finder, title: "Notes", frame: main, fullScreenConfirmed: false,
      display: display, visible: visible, accessibleFrames: nil, standaloneFrames: alone)?.covers, [DesktopCover(id: 78, frame: field)])
  }

  func testAWindowOfAnotherProcessInFrontStillLeavesNoSurfaceAndClawdTimeNeverCounts() {
    let banner = (90, other, "Riverchat", CGRect(x: 500, y: 200, width: 400, height: 200))
    let visible = evidence([banner, (77, finder, nil, fieldWindow), (40, finder, "Notes", main)])
    let alone = standalone([("AXTextField", nil, field), ("AXWindow", "AXStandardWindow", main)])
    XCTAssertNil(DesktopWindowVisibility.focusedWindow(pid: finder, title: "Notes", frame: main, fullScreenConfirmed: false,
      display: display, visible: visible, accessibleFrames: nil, standaloneFrames: alone))
    // ClawdTime's own windows are left out of the rows that the reader judges the screen by.
    XCTAssertFalse(OwnWindows.judged(layer: 0, owner: own, own: own))
    XCTAssertTrue(OwnWindows.judged(layer: 0, owner: finder, own: own))
  }

  func testAFieldThatClosedOrOpenedSinceTheLookEndsTheInput() {
    XCTAssertTrue(DesktopWindowVisibility.sameField(looked: true, now: true))
    XCTAssertTrue(DesktopWindowVisibility.sameField(looked: false, now: false))
    // Return gave the name, or a click elsewhere ended the edit: the next letters would pick a file of the folder.
    XCTAssertFalse(DesktopWindowVisibility.sameField(looked: true, now: false))
    // A field opened since: the letters would go into a name that the look did not see.
    XCTAssertFalse(DesktopWindowVisibility.sameField(looked: false, now: true))
  }
}
