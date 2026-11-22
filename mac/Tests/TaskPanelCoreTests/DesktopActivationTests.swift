import Foundation
import XCTest
@testable import TaskPanelCore

/// A request that names only an app ("open Chrome") must work as people expect:
/// the app comes forward and chooses its own window. Only a request that names a
/// window can be ambiguous or need one display.
final class DesktopActivationTests: XCTestCase {
  func testAnAppAloneRunsWithAnyNumberOfDisplays() {
    for displays in [1, 2, 3] {
      XCTAssertNil(DesktopActivationRule.refusal(windowNamed: false, displays: displays))
    }
    // The list of displays could not be read: an app alone still needs none of it.
    XCTAssertNil(DesktopActivationRule.refusal(windowNamed: false, displays: 0))
  }

  func testANamedWindowNeedsExactlyOneDisplay() {
    XCTAssertNil(DesktopActivationRule.refusal(windowNamed: true, displays: 1))
    for displays in [0, 2, 3] {
      XCTAssertEqual(DesktopActivationRule.refusal(windowNamed: true, displays: displays), .unsupportedDesktop)
    }
  }

  func testOnlyANamedTitleThatFitsTwoWindowsIsAmbiguous() throws {
    let titles: [String?] = ["Inbox", "Budget 2026", nil, "Budget 2027"]
    XCTAssertEqual(try DesktopWindowChoice.index(titled: "Budget 2026", among: titles).get(), 1)
    XCTAssertEqual(try DesktopWindowChoice.index(titled: "Inbox", among: titles).get(), 0)
    // Several windows are no problem for a title that fits one of them.
    XCTAssertEqual(try DesktopWindowChoice.index(titled: "Budget 2027", among: titles).get(), 3)
    XCTAssertThrowsError(try DesktopWindowChoice.index(titled: "Budget 2026", among: titles + ["Budget 2026"]).get()) { error in
      XCTAssertEqual(error as? HandError, .ambiguousTarget)
    }
    for (title, among) in [("Budget 2028", titles), ("Budget", titles), ("Inbox", [String?]()), ("Inbox", [nil])] {
      XCTAssertThrowsError(try DesktopWindowChoice.index(titled: title, among: among).get()) { error in
        XCTAssertEqual(error as? HandError, .targetNotVisible)
      }
    }
  }

  func testATitleFitsTheWindowWhoseTitleCleansToTheSameLine() throws {
    // The window has a no-break space. The person said, and the worker saw, a plain space.
    let titles: [String?] = ["Budget\u{00A0}2026", "Notes"]
    XCTAssertEqual(try DesktopWindowChoice.index(titled: "Budget 2026", among: titles).get(), 0)
    XCTAssertEqual(try DesktopWindowChoice.index(titled: "Budget\u{00A0}2026", among: titles).get(), 0)
    // Two windows that clean to the same line are two windows: never the first of them.
    XCTAssertThrowsError(try DesktopWindowChoice.index(titled: "Budget 2026", among: titles + ["Budget  2026"]).get()) { error in
      XCTAssertEqual(error as? HandError, .ambiguousTarget)
    }
  }

  func testTheAppInFrontCountsAtAnyMomentOfTheWait() {
    let wait = DesktopAppWait(at: 100)
    XCTAssertEqual(wait.sample(inFront: true, at: 100), .inFront)
    XCTAssertEqual(wait.sample(inFront: false, at: 100.2), .waiting)
    // A cold start takes longer than the two seconds that the first version gave it.
    XCTAssertEqual(wait.sample(inFront: false, at: 102.5), .waiting)
    XCTAssertEqual(wait.sample(inFront: true, at: 104.9), .inFront)
    XCTAssertEqual(wait.sample(inFront: false, at: 105.9), .waiting)
    // In front at the very end is in front all the same.
    XCTAssertEqual(wait.sample(inFront: true, at: 106), .inFront)
    XCTAssertEqual(wait.sample(inFront: true, at: 107), .inFront)
  }

  func testOnlyAnAppThatIsNotInFrontAfterTheWaitEndsIt() {
    let wait = DesktopAppWait(at: 100)
    XCTAssertEqual(DesktopAppWait.limit, 6)
    XCTAssertFalse(wait.over(at: 105.99))
    XCTAssertEqual(wait.sample(inFront: false, at: 106), .expired)
    XCTAssertEqual(wait.sample(inFront: false, at: 200), .expired)
    XCTAssertTrue(wait.over(at: 106))
    // A clock that makes no sense never extends the wait.
    for at in [Double.nan, .infinity, 99] {
      XCTAssertEqual(wait.sample(inFront: false, at: at), .expired)
      XCTAssertEqual(wait.sample(inFront: true, at: at), .expired)
      XCTAssertTrue(wait.over(at: at))
    }
  }

  func testWhatFailsAfterTheOpenRequestIsUnknownAndWhatFailsBeforeItIsARefusal() {
    for error in [HandError.stoppedByPerson, .refused, .noAccessibility, .noScreenRecording, .targetNotVisible] {
      XCTAssertEqual(DesktopEffectOutcome.failure(error, dispatched: true), .transitionUnknown)
      XCTAssertEqual(DesktopEffectOutcome.failure(error, dispatched: false), error)
    }
  }
}
