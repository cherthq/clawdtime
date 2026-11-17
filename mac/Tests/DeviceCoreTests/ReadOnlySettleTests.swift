import XCTest
@testable import DeviceCore

final class ReadOnlySettleTests: XCTestCase {
  @MainActor func testWaitsForIndependentPostconditionWithoutAnyEffectCallback() async {
    var now = 10.0; var reads = 0
    let result = await ReadOnlySettle.run(now: { now }, allowed: { true }, observe: {
      reads += 1; return (reads, reads == 4)
    }, sleep: { now += $0 })
    if case .verified(let value) = result { XCTAssertEqual(value, 4) } else { XCTFail("Expected observed target") }
    XCTAssertEqual(reads, 4); XCTAssertLessThan(now, 10.6)
  }
  @MainActor func testDeadlineReturnsLastUnverifiedObservationAndStopsPolling() async {
    var now = 10.0; var reads = 0
    let result = await ReadOnlySettle.run(now: { now }, allowed: { true }, observe: {
      reads += 1; return (reads, false)
    }, sleep: { now += $0 })
    if case .unverified(let value) = result { XCTAssertEqual(value, reads) } else { XCTFail("Expected unverified result") }
    XCTAssertLessThanOrEqual(reads, 12); XCTAssertEqual(now, 10.6, accuracy: 0.00001)
  }
  @MainActor func testStopDuringWaitPreventsAnySubsequentRead() async {
    var now = 10.0; var enabled = true; var reads = 0
    let result = await ReadOnlySettle.run(now: { now }, allowed: { enabled }, observe: {
      reads += 1; return (reads, false)
    }, sleep: { now += $0; enabled = false })
    if case .unavailable = result {} else { XCTFail("Stop must fail closed") }
    XCTAssertEqual(reads, 0)
  }
  @MainActor func testIdentityLossAndOverdueReadCannotVerify() async {
    var now = 10.0
    let missing: ReadOnlySettleResult<Int> = await ReadOnlySettle.run(now: { now }, allowed: { true }, observe: { nil }, sleep: { now += $0 })
    if case .unavailable = missing {} else { XCTFail("Lost identity must refuse") }
    let late = await ReadOnlySettle.run(now: { now }, allowed: { true }, observe: { now += 0.7; return (1, true) }, sleep: { now += $0 })
    if case .unavailable = late {} else { XCTFail("Late successful read must not verify") }
  }
}
