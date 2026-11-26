import XCTest
@testable import TaskPanelCore

/// The worker plans each input from a look. When the person moves the mouse or presses a key after that look,
/// between two commands, the screen may not be what the worker saw: the input waits for the person, as for one
/// during a command. These are rules only: no event is made here.
final class OwnerInputTests: XCTestCase {
  func testInputOfThePersonBetweenALookAndAClickHoldsTheClick() {
    var watch = HandsOwnerWatch()
    // A look at 10 s, and it gave the screen.
    watch.begin(at: 10, input: false)
    XCTAssertFalse(watch.acted)
    watch.looked(began: 10)
    // The worker plans; the person moves the mouse at 11 s, between the two commands.
    watch.saw(at: 11)
    // The click at 12 s rests on the look of 10 s: the person acted after it.
    watch.begin(at: 12, input: true)
    XCTAssertTrue(watch.acted)
  }

  func testAFreshLookClearsWhatThePersonDidBeforeIt() {
    var watch = HandsOwnerWatch()
    watch.saw(at: 3)
    // The look at 4 s starts clean and gives the screen as it is now.
    watch.begin(at: 4, input: false)
    XCTAssertFalse(watch.acted)
    watch.looked(began: 4)
    watch.begin(at: 6, input: true)
    XCTAssertFalse(watch.acted)
    // A key during the look: the next input rests on a look that may not show it.
    watch.begin(at: 8, input: false)
    watch.saw(at: 8.5)
    XCTAssertTrue(watch.acted)
    watch.looked(began: 8)
    watch.begin(at: 9, input: true)
    XCTAssertTrue(watch.acted)
  }

  func testALookThatGaveNoScreenClearsNothing() {
    var watch = HandsOwnerWatch()
    watch.begin(at: 1, input: false)
    watch.looked(began: 1)
    watch.saw(at: 2)
    // A look at 3 s that failed: the worker still plans from the look of 1 s.
    watch.begin(at: 3, input: false)
    XCTAssertFalse(watch.acted)
    watch.begin(at: 4, input: true)
    XCTAssertTrue(watch.acted)
  }

  func testACommandThatSendsNoInputSaysOnlyWhatHappenedDuringIt() {
    var watch = HandsOwnerWatch()
    watch.begin(at: 1, input: false)
    watch.looked(began: 1)
    watch.saw(at: 2)
    // A wait or a closer picture sends nothing: it says nothing of the time before it.
    watch.begin(at: 3, input: false)
    XCTAssertFalse(watch.acted)
    // The input after it still rests on the look of 1 s.
    watch.begin(at: 4, input: true)
    XCTAssertTrue(watch.acted)
  }

  func testWithNoLookAnyInputOfThePersonCounts() {
    var watch = HandsOwnerWatch()
    watch.begin(at: 1, input: true)
    XCTAssertFalse(watch.acted)
    watch.saw(at: 2)
    watch.begin(at: 3, input: true)
    XCTAssertTrue(watch.acted)
    // The tap stopped and started again: nothing from before counts.
    watch.forget()
    watch.begin(at: 5, input: true)
    XCTAssertFalse(watch.acted)
  }
}
