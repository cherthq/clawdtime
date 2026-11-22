import Foundation
import XCTest
@testable import TaskPanelCore

/// A request after which nothing happened is not a request with an unknown result.
/// Both cases here are known, so neither may lock computer use.
final class DesktopNothingHappenedTests: XCTestCase {
  // MARK: Command+Tab with no other app

  func testNoOtherRegularAppMeansNothingToGoBackTo() {
    let finder = 100, panel = 300
    // Only the app in front runs.
    XCTAssertFalse(DesktopAppSwitch.hasPrevious(regular: [finder], front: finder, own: panel))
    XCTAssertFalse(DesktopAppSwitch.hasPrevious(regular: [], front: nil, own: panel))
    // ClawdTime itself is never a place to go back to.
    XCTAssertFalse(DesktopAppSwitch.hasPrevious(regular: [finder, panel], front: finder, own: panel))
    XCTAssertFalse(DesktopAppSwitch.hasPrevious(regular: [panel], front: nil, own: panel))
  }

  func testAnotherRegularAppIsAPlaceToGoBackTo() {
    let finder = 100, notes = 200, panel = 300
    XCTAssertTrue(DesktopAppSwitch.hasPrevious(regular: [finder, notes], front: notes, own: panel))
    XCTAssertTrue(DesktopAppSwitch.hasPrevious(regular: [finder, notes, panel], front: finder, own: panel))
    // The app in front is not in the switcher: every regular app is another one.
    XCTAssertTrue(DesktopAppSwitch.hasPrevious(regular: [finder], front: 999, own: panel))
  }

  func testTheRefusalComesBeforeAnythingIsSentSoItKeepsItsName() {
    XCTAssertEqual(DesktopEffectOutcome.failure(.notFound, dispatched: false), .notFound)
    XCTAssertEqual(DesktopInputOutcome.failure(.notFound, submitted: false, interrupted: false), .notFound)
  }

  // MARK: a desktop switch that did not move

  /// Looks every 0.4 seconds for the whole wait of five seconds, then the look that ends it.
  private func wait(_ settling: inout DesktopSwitchSettlement<String>, surface: (Double) -> String?, spaceChanges: (Double) -> Int = { _ in 0 }) {
    var at = 0.0
    while at < 5 {
      XCTAssertEqual(settling.sample(surface(at), spaceChanges: spaceChanges(at), epoch: 1, at: at), .waiting)
      at += 0.4
    }
    XCTAssertEqual(settling.sample(surface(5), spaceChanges: spaceChanges(5), epoch: 1, at: 5), .expired)
  }

  func testNoSpaceChangeAndTheSameSurfaceForTheWholeWaitIsNotMoved() {
    var settling = DesktopSwitchSettlement(origin: "A", at: 0)
    wait(&settling) { _ in "A" }
    XCTAssertTrue(settling.notMoved)
  }

  func testOneLookThatShowsNothingOrAnotherSurfaceStaysUnknown() {
    for odd in [String?.none, "B"] {
      var settling = DesktopSwitchSettlement(origin: "A", at: 0)
      wait(&settling) { at in abs(at - 2.0) < 0.01 ? odd : "A" }
      XCTAssertFalse(settling.notMoved)
    }
    // The look that ends the wait counts too.
    var late = DesktopSwitchSettlement(origin: "A", at: 0)
    wait(&late) { at in at >= 5 ? nil : "A" }
    XCTAssertFalse(late.notMoved)
  }

  func testASpaceChangeIsNeverNotMoved() {
    // The Space changed and the same surface stayed in view: that can be another
    // desktop that looks alike. It stays unknown.
    var pinned = DesktopSwitchSettlement(origin: "A", at: 0)
    wait(&pinned, surface: { _ in "A" }, spaceChanges: { at in at >= 1 ? 1 : 0 })
    XCTAssertFalse(pinned.notMoved)
    // The Space changed and no window is there: an empty desktop or a slow one. Unknown.
    var empty = DesktopSwitchSettlement(origin: "A", at: 0)
    wait(&empty, surface: { at in at >= 1 ? nil : "A" }, spaceChanges: { at in at >= 1 ? 1 : 0 })
    XCTAssertFalse(empty.notMoved)
  }

  func testNotMovedNeedsThreeLooksAndIsNeverSaidOfAnArrival() {
    var few = DesktopSwitchSettlement(origin: "A", at: 0)
    XCTAssertEqual(few.sample("A", spaceChanges: 0, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(few.sample("A", spaceChanges: 0, epoch: 1, at: 5), .expired)
    XCTAssertFalse(few.notMoved)
    var arrived = DesktopSwitchSettlement(origin: "A", at: 0)
    XCTAssertEqual(arrived.sample("B", spaceChanges: 1, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(arrived.sample("B", spaceChanges: 1, epoch: 1, at: 0.3), .waiting)
    XCTAssertEqual(arrived.sample("B", spaceChanges: 1, epoch: 1, at: 0.7), .ready)
    XCTAssertFalse(arrived.notMoved)
  }

  func testNotMovedKeepsItsNameAfterTheKeyWentOut() throws {
    // The key of the shortcut was sent, so `submitted` is true. The verdict is still known.
    XCTAssertEqual(DesktopInputOutcome.failure(.desktopUnchanged, submitted: true, interrupted: false), .desktopUnchanged)
    XCTAssertEqual(DesktopInputOutcome.failure(.desktopUnchanged, submitted: true, interrupted: true), .desktopUnchanged)
    XCTAssertEqual(HandError.desktopUnchanged.rawValue, "desktop_unchanged")
    let json = try JSONEncoder().encode(HandResult.failure(4, .desktopUnchanged))
    let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    XCTAssertEqual(object["error"] as? String, "desktop_unchanged")
    XCTAssertEqual(object["ok"] as? Bool, false)
  }

  func testWhatMayHaveTypedOrClickedStaysUnknown() {
    // Nothing here is weakened: a failure after input began is unknown, whatever its name was.
    for error in [HandError.refused, .failed, .stoppedByPerson, .staleObservation, .notFound, .targetNotVisible, .noAccessibility] {
      XCTAssertEqual(DesktopInputOutcome.failure(error, submitted: true, interrupted: false), .inputUnknown)
      XCTAssertEqual(DesktopEffectOutcome.failure(error, dispatched: true), .transitionUnknown)
    }
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .switchDesktop(direction: .right), submitted: true), .transitionUnknown)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .type(text: "x"), submitted: true), .inputUnknown)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .click(x: 1, y: 1, button: .left, count: 1), submitted: true), .inputUnknown)
  }
}
