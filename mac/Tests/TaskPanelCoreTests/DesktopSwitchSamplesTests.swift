import XCTest
@testable import TaskPanelCore

final class DesktopSwitchSamplesTests: XCTestCase {
  func testAbsentCandidatesNeverLookStableAndEmptySamplesAreSeparate() {
    var trace = DesktopSwitchSamples<String>()
    trace.record(nil, epoch: 1, isEmpty: false)
    trace.record(nil, epoch: 2, isEmpty: true)
    XCTAssertEqual(trace.total, 2); XCTAssertEqual(trace.candidates, 0)
    XCTAssertEqual(trace.empty, 1); XCTAssertEqual(trace.consecutive, 0)
  }
  func testChangedEpochSurfaceOrMissingSampleBreaksConsecutiveEvidence() {
    var trace = DesktopSwitchSamples<String>()
    trace.record("A", epoch: 1, isEmpty: false)
    trace.record("A", epoch: 1, isEmpty: false)
    XCTAssertEqual(trace.consecutive, 2)
    trace.record("A", epoch: 2, isEmpty: false)
    XCTAssertEqual(trace.consecutive, 1)
    trace.record("B", epoch: 2, isEmpty: false)
    XCTAssertEqual(trace.consecutive, 1)
    trace.record(nil, epoch: 2, isEmpty: false)
    trace.record("B", epoch: 2, isEmpty: false)
    XCTAssertEqual(trace.consecutive, 1)
    XCTAssertEqual(trace.total, 6); XCTAssertEqual(trace.candidates, 5)
  }
}
