import XCTest
@testable import TaskPanelCore

/// A browser shows the suggestions of its address bar in a small window of its own, in front of the browser
/// window. A card and a status line are windows like it. The focused window is then not the top one of the
/// window server's list. The hands' input must still have it as its surface: without it nothing can be sent
/// after the first key in an address bar.
final class OwnWindowsInFrontTests: XCTestCase {
  private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
  private let browser = CGRect(x: 60, y: 60, width: 1300, height: 860)
  private let suggestions = CGRect(x: 240, y: 112, width: 820, height: 380)
  private func row(_ id: Int, pid: Int = 10, title: String? = "Start", frame: CGRect, alpha: Double? = 1) -> DesktopWindowEvidence {
    .init(id: id, pid: pid, title: title, frame: frame, alpha: alpha)
  }
  /// The rule for a move to another app or desktop: it is not changed.
  private func strict(_ rows: [DesktopWindowEvidence], frame: CGRect? = nil) -> Int? {
    DesktopWindowVisibility.focusedWindowID(pid: 10, title: "Start - Browser", frame: frame ?? browser, fullScreenConfirmed: false,
      display: display, visible: rows, accessibleFrames: nil)
  }
  /// `listed` are the frames of all windows of the app in Accessibility; `standalone` the ones that stand alone.
  private func match(_ rows: [DesktopWindowEvidence], listed: [CGRect]? = nil, standalone: [CGRect]?, frame: CGRect? = nil,
                     confirmed: Bool = false) -> DesktopFocusedWindow? {
    DesktopWindowVisibility.focusedWindow(pid: 10, title: "Start - Browser", frame: frame ?? browser, fullScreenConfirmed: confirmed,
      display: display, visible: rows, accessibleFrames: listed ?? standalone, standaloneFrames: standalone)
  }
  private func cover(_ id: Int, _ frame: CGRect) -> DesktopCover { .init(id: id, frame: frame) }

  func testTheListOfAnAddressBarInFrontLeavesTheBrowserWindowAsTheSurface() {
    let rows = [row(7, title: nil, frame: suggestions), row(3, frame: browser), row(9, pid: 22, title: "Other", frame: display)]
    // The strict rule has no window for this. That was the defect, and it stays the rule for a move.
    XCTAssertNil(strict(rows))
    // Accessibility lists the list too, as a part; only the browser window stands alone.
    XCTAssertEqual(match(rows, listed: [suggestions, browser], standalone: [browser]),
      DesktopFocusedWindow(id: 3, covers: [cover(7, suggestions)], front: 1))
    // With nothing in front, the same window, no cover, and no list of windows needed.
    XCTAssertEqual(match([row(3, frame: browser)], standalone: [browser]), DesktopFocusedWindow(id: 3, covers: [], front: 0))
    XCTAssertEqual(match([row(3, frame: browser)], standalone: nil), DesktopFocusedWindow(id: 3, covers: [], front: 0))
  }

  func testAPlaceUnderAWindowInFrontIsHidden() {
    let found = DesktopFocusedWindow(id: 3, covers: [cover(7, suggestions)], front: 1)
    XCTAssertTrue(found.hides(CGPoint(x: 500, y: 300)))
    XCTAssertFalse(found.hides(CGPoint(x: 500, y: 600)))
    XCTAssertFalse(found.hides(CGPoint(x: 100, y: 300)))
    XCTAssertFalse(DesktopFocusedWindow(id: 3, covers: [], front: 1).hides(CGPoint(x: 500, y: 300)))
    // The panel holds the covers alone and asks the same rule.
    XCTAssertTrue(DesktopFocusedWindow.hides([cover(7, suggestions)], CGPoint(x: 500, y: 300)))
    XCTAssertFalse(DesktopFocusedWindow.hides([], CGPoint(x: 500, y: 300)))
    // A window that shows nothing hides nothing.
    let unseenOnly = DesktopFocusedWindow(id: 3, covers: [], front: 1, unseen: [DesktopUnseen(id: 7, frame: suggestions, alpha: 0)])
    XCTAssertFalse(unseenOnly.hides(CGPoint(x: 500, y: 300)))
  }

  func testAnotherWindowAtTheSamePlaceIsAnotherCover() {
    let first = match([row(7, title: nil, frame: suggestions), row(3, frame: browser)], standalone: [browser])
    let second = match([row(8, title: nil, frame: suggestions), row(3, frame: browser)], standalone: [browser])
    XCTAssertNotNil(first)
    XCTAssertNotEqual(first, second)
  }

  func testSeveralSmallWindowsOfTheSameAppMayLieInFrontButNotMoreThanTheLimit() {
    let card = CGRect(x: 300, y: 96, width: 260, height: 120), tip = CGRect(x: 900, y: 70, width: 140, height: 28)
    let rows = [row(8, title: nil, frame: tip), row(7, title: nil, frame: card), row(6, title: nil, frame: suggestions), row(3, frame: browser)]
    XCTAssertEqual(match(rows, standalone: [browser]),
      DesktopFocusedWindow(id: 3, covers: [cover(8, tip), cover(7, card), cover(6, suggestions)], front: 3))
    var many = (0..<(DesktopWindowVisibility.coverLimit + 1)).map { row(20 + $0, title: nil, frame: CGRect(x: 100 + 40 * $0, y: 100, width: 60, height: 40)) }
    many.append(row(3, frame: browser))
    XCTAssertNil(match(many, standalone: [browser]))
    XCTAssertEqual(match(Array(many.dropFirst()), standalone: [browser])?.covers.count, DesktopWindowVisibility.coverLimit)
  }

  func testTheWindowsInFrontTogetherMayNotHideTheWholeWindow() {
    // Two windows of half the size each, side by side: nothing of the focused window shows.
    let left = CGRect(x: 60, y: 60, width: 650, height: 860), right = CGRect(x: 710, y: 60, width: 650, height: 860)
    XCTAssertNil(match([row(7, title: nil, frame: left), row(8, title: nil, frame: right), row(3, frame: browser)], standalone: [browser]))
    // One window over most of it, but not all: a long list in a small browser window.
    let small = CGRect(x: 100, y: 100, width: 600, height: 400), list = CGRect(x: 110, y: 150, width: 580, height: 330)
    XCTAssertEqual(match([row(7, title: nil, frame: list), row(3, frame: small)], standalone: [small], frame: small)?.covers, [cover(7, list)])
    // Only the part over the focused window counts.
    let hanging = CGRect(x: 60, y: 500, width: 1300, height: 800)
    XCTAssertEqual(match([row(7, title: nil, frame: hanging), row(3, frame: browser)], standalone: [browser])?.covers, [cover(7, hanging)])
    let all = browser.insetBy(dx: 10, dy: 10)
    XCTAssertNil(match([row(7, title: nil, frame: all), row(3, frame: browser)], standalone: [browser]))
  }

  func testAWindowInFrontThatIsNotAPartOfTheSameAppGivesNoSurface() {
    // A window of another app.
    XCTAssertNil(match([row(7, pid: 22, title: nil, frame: suggestions), row(3, frame: browser)], standalone: [browser]))
    // A window of the same app that stands alone in Accessibility: a second document, a dialog.
    XCTAssertNil(match([row(7, title: "Other page", frame: suggestions), row(3, frame: browser)], standalone: [browser, suggestions]))
    // A window that does not touch the focused one.
    let far = CGRect(x: 1380, y: 930, width: 100, height: 40)
    XCTAssertNil(match([row(7, title: nil, frame: far), row(3, frame: browser)], standalone: [browser]))
    // A window with no size.
    XCTAssertNil(match([row(7, title: nil, frame: CGRect(x: 300, y: 100, width: 0, height: 0)), row(3, frame: browser)], standalone: [browser]))
    // The list of the app's windows could not be read: nothing says what the window in front is.
    XCTAssertNil(match([row(7, title: nil, frame: suggestions), row(3, frame: browser)], standalone: nil))
    // Two windows that could both be the focused one.
    XCTAssertNil(match([row(7, title: nil, frame: suggestions), row(3, frame: browser), row(4, frame: browser)], standalone: [browser]))
    // The focused window is not in the list at all.
    XCTAssertNil(match([row(7, title: nil, frame: suggestions)], standalone: [browser]))
  }

  func testOnlyTheNamedKindsArePartsOfAnotherWindow() {
    // The two kinds that the real windows had: a list or a card, and a status line.
    XCTAssertFalse(DesktopWindowVisibility.standsAlone(role: "AXWindow", subrole: "AXUnknown"))
    XCTAssertFalse(DesktopWindowVisibility.standsAlone(role: "AXHelpTag", subrole: "AXUnknown"))
    XCTAssertFalse(DesktopWindowVisibility.standsAlone(role: "AXHelpTag", subrole: nil))
    // Every other kind stands alone, also one that this code never heard of, and a window with no kind.
    for subrole in ["AXStandardWindow", "AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow", "AXDocumentWindow", "AXSomethingNew", ""] {
      XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXWindow", subrole: subrole), subrole)
    }
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXWindow", subrole: nil))
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: nil, subrole: nil))
    // A sheet stands alone whatever its kind.
    XCTAssertTrue(DesktopWindowVisibility.standsAlone(role: "AXSheet", subrole: "AXUnknown"))
  }

  func testASheetStaysTheTopWindow() {
    // A sheet is matched by the app and the frame alone, so nothing may lie in front of it.
    let sheet = CGRect(x: 400, y: 200, width: 500, height: 240)
    func find(_ rows: [DesktopWindowEvidence]) -> DesktopFocusedWindow? {
      DesktopWindowVisibility.focusedWindow(pid: 10, title: "", frame: sheet, fullScreenConfirmed: false, display: display,
        visible: rows, accessibleFrames: [browser], standaloneFrames: [browser], sheet: true)
    }
    XCTAssertEqual(find([row(5, title: "Save", frame: sheet), row(3, frame: browser)]), DesktopFocusedWindow(id: 5, covers: [], front: 0))
    XCTAssertNil(find([row(7, title: nil, frame: CGRect(x: 420, y: 210, width: 100, height: 60)), row(5, title: "Save", frame: sheet), row(3, frame: browser)]))
  }

  func testTheStripOfAFullScreenAppIsNoCoverAloneOrWithAListInFront() {
    let full = CGRect(x: 0, y: 37, width: 1512, height: 945), strip = CGRect(x: 0, y: 37, width: 1512, height: 44)
    let list = CGRect(x: 200, y: 80, width: 900, height: 300)
    // Accessibility does not list the strip. Its controls are parts of the focused window: they stay reachable.
    XCTAssertEqual(match([row(1, title: nil, frame: strip), row(2, frame: full)], listed: [full], standalone: [full], frame: full, confirmed: true),
      DesktopFocusedWindow(id: 2, covers: [], front: 1))
    XCTAssertEqual(match([row(5, title: nil, frame: list), row(1, title: nil, frame: strip), row(2, frame: full)],
      listed: [list, full], standalone: [full], frame: full, confirmed: true), DesktopFocusedWindow(id: 2, covers: [cover(5, list)], front: 2))
    // Two strips are not a strip.
    XCTAssertNil(match([row(6, title: nil, frame: strip), row(1, title: nil, frame: strip), row(2, frame: full)],
      listed: [full], standalone: [full], frame: full, confirmed: true))
    // Without the word of Accessibility that the app is full screen, a strip is a cover like any other.
    XCTAssertEqual(match([row(1, title: nil, frame: strip), row(2, frame: full)], listed: [full], standalone: [full], frame: full)?.covers, [cover(1, strip)])
  }

  func testALookWithAnotherSetOfWindowsInFrontIsAnotherLook() {
    // The panel's lease holds the window together with the windows in front of it, as this pair does. A list
    // that opened, closed or changed is another look, and the same list at the next look is the same one.
    struct Look: Equatable { let window: Int; let covers: [DesktopCover] }
    var lease = DesktopObservationLease<Look>()
    XCTAssertNil(lease.held)
    lease.record(Look(window: 3, covers: []), at: 10)
    let first = lease.epoch
    XCTAssertEqual(lease.held, Look(window: 3, covers: []))
    XCTAssertTrue(lease.permits(Look(window: 3, covers: []), at: 11))
    XCTAssertFalse(lease.permits(Look(window: 3, covers: [cover(7, suggestions)]), at: 11))
    lease.record(Look(window: 3, covers: [cover(7, suggestions)]), at: 12)
    XCTAssertEqual(lease.epoch, first + 1)
    lease.record(Look(window: 3, covers: [cover(7, suggestions)]), at: 13)
    XCTAssertEqual(lease.epoch, first + 1)
    XCTAssertTrue(lease.permits(Look(window: 3, covers: [cover(7, suggestions)]), at: 14))
    XCTAssertFalse(lease.permits(Look(window: 3, covers: [cover(8, suggestions)]), at: 14))
    lease.invalidate()
    XCTAssertNil(lease.held)
  }
}

/// The numbers of real apps on this Mac, read from the window server and from Accessibility on 23 November 2026
/// while a person used them. No title and no text was read.
extension OwnWindowsInFrontTests {
  private var realWindow: CGRect { CGRect(x: 0, y: 33, width: 1512, height: 865) }
  private func real(_ front: [(CGRect, Double?)], listed: [CGRect]) -> DesktopFocusedWindow? {
    let rows = front.enumerated().map { row(100 + $0.offset, title: nil, frame: $0.element.0, alpha: $0.element.1) }
      + [row(3, frame: realWindow), row(9, pid: 22, title: "Other", frame: display)]
    return match(rows, listed: listed + [realWindow], standalone: [realWindow], frame: realWindow)
  }

  func testTheRealListOfAnAddressBarAtItsThreeSizes() {
    // Accessibility listed the list as a window of the kind "unknown", and the browser window as a standard one.
    for height in [178.0, 338.0, 458.0] {
      let list = CGRect(x: 99, y: 58, width: 1188, height: height)
      XCTAssertEqual(real([(list, 1)], listed: [list]), DesktopFocusedWindow(id: 3, covers: [cover(100, list)], front: 1))
    }
    // One second lay between two of the sizes: they are two looks, and each one is steady by itself.
    XCTAssertNotEqual(real([(CGRect(x: 99, y: 58, width: 1188, height: 178), 1)], listed: []),
      real([(CGRect(x: 99, y: 58, width: 1188, height: 338), 1)], listed: []))
  }

  func testTheRealStatusBubbleAndCardOfTheBrowser() {
    // At the lower left corner, one point outside the window: 343 by 22 with alpha 0.47 while it says something.
    // Accessibility lists it as a help tag. Before, it alone took the surface away.
    let bubble = CGRect(x: -1, y: 877, width: 343, height: 22)
    XCTAssertEqual(real([(bubble, 0.46939167380332947)], listed: [bubble]), DesktopFocusedWindow(id: 3, covers: [cover(100, bubble)], front: 1))
    let list = CGRect(x: 99, y: 58, width: 1188, height: 458)
    XCTAssertEqual(real([(bubble, 0.47), (list, 1)], listed: [bubble, list])?.covers, [cover(100, bubble), cover(101, list)])
    // A small card, 270 by 100, of the kind "unknown".
    let card = CGRect(x: 1060, y: 68, width: 270, height: 100)
    XCTAssertEqual(real([(card, 1)], listed: [card])?.covers, [cover(100, card)])
  }

  func testAWindowInFrontThatShowsNothingIsNoCover() {
    // The browser's status bubble while it is empty: 233 by 22 with alpha 0, not in Accessibility. It is kept
    // with its alpha, so that one that starts to show before a click is noticed.
    let empty = CGRect(x: -1, y: 877, width: 233, height: 22)
    XCTAssertEqual(real([(empty, 0)], listed: []),
      DesktopFocusedWindow(id: 3, covers: [], front: 1, unseen: [DesktopUnseen(id: 100, frame: empty, alpha: 0)]))
    // A chat app kept a window of 1482 by 453 with alpha 0.0002 over the upper half of its window, not in
    // Accessibility. A person works through it, so no place under it is hidden.
    let layer = CGRect(x: 15, y: 37, width: 1482, height: 453)
    let found = real([(layer, 0.00022774934768676758)], listed: [])
    XCTAssertEqual(found?.covers, [])
    XCTAssertEqual(found?.unseen, [DesktopUnseen(id: 100, frame: layer, alpha: 0.00022774934768676758)])
    XCTAssertEqual(found?.hides(CGPoint(x: 700, y: 200)), false)
    // The same layer as it starts to show is another state: a steady input compares the two.
    XCTAssertNotEqual(real([(layer, 0.03)], listed: [])?.unseen, found?.unseen)
    // A window that shows nothing may be as large as the focused one, and it need not touch it.
    XCTAssertEqual(real([(realWindow.insetBy(dx: 2, dy: 2), 0)], listed: [])?.covers, [])
    XCTAssertEqual(real([(CGRect(x: 1400, y: 940, width: 60, height: 20), 0)], listed: [])?.covers, [])
    // The same large window with a part of its picture showing, or with no word on it, hides the whole window.
    XCTAssertNil(real([(realWindow.insetBy(dx: 2, dy: 2), 0.5)], listed: []))
    XCTAssertNil(real([(realWindow.insetBy(dx: 2, dy: 2), nil)], listed: []))
    XCTAssertEqual(real([(layer, DesktopWindowVisibility.unseenAlpha)], listed: [])?.covers, [cover(100, layer)])
    // An alpha that is no number between 0 and 1 says nothing: the window counts as shown.
    XCTAssertEqual(real([(layer, -.infinity)], listed: [])?.covers, [cover(100, layer)])
    XCTAssertEqual(real([(layer, .nan)], listed: [])?.covers, [cover(100, layer)])
    // Shown or not: never a window of another app, and never a window that stands alone.
    let other = [row(100, pid: 22, title: nil, frame: layer, alpha: 0), row(3, frame: realWindow)]
    XCTAssertNil(match(other, standalone: [realWindow], frame: realWindow))
    XCTAssertNil(match([row(100, title: nil, frame: layer, alpha: 0), row(3, frame: realWindow)], standalone: [realWindow, layer], frame: realWindow))
  }

  func testOnlySoManyWindowsMayLieInFrontShownOrNot() {
    func rows(shown: Int, unseen: Int) -> DesktopFocusedWindow? {
      var front: [DesktopWindowEvidence] = []
      for n in 0..<shown { front.append(row(200 + n, title: nil, frame: CGRect(x: 100 + 40 * n, y: 100, width: 60, height: 40))) }
      for n in 0..<unseen { front.append(row(300 + n, title: nil, frame: CGRect(x: 100, y: 300 + 10 * n, width: 60, height: 8), alpha: 0)) }
      return match(front + [row(3, frame: realWindow)], standalone: [realWindow], frame: realWindow)
    }
    XCTAssertEqual(rows(shown: DesktopWindowVisibility.coverLimit, unseen: 0)?.covers.count, DesktopWindowVisibility.coverLimit)
    XCTAssertNil(rows(shown: DesktopWindowVisibility.coverLimit + 1, unseen: 0))
    XCTAssertEqual(rows(shown: 2, unseen: DesktopWindowVisibility.frontLimit - 2)?.front, DesktopWindowVisibility.frontLimit)
    XCTAssertNil(rows(shown: 2, unseen: DesktopWindowVisibility.frontLimit - 1))
  }

  func testAMoveToAnotherAppOrDesktopKeepsTheStrictRule() {
    // With the list of windows that stand alone withheld, as the panel does for a move, a window in front
    // gives no surface: exactly what `focusedWindowID` says.
    let list = CGRect(x: 99, y: 58, width: 1188, height: 338)
    let rows = [row(100, title: nil, frame: list), row(3, frame: realWindow)]
    XCTAssertNil(strict(rows, frame: realWindow))
    XCTAssertNil(match(rows, listed: [list, realWindow], standalone: nil, frame: realWindow))
    XCTAssertNotNil(match(rows, listed: [list, realWindow], standalone: [realWindow], frame: realWindow))
  }
}
