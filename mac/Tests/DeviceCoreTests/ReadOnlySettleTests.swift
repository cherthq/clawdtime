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
  @MainActor func testGeometryTransitionCanSettleAfterExactlyOneEffect() async {
    var effects = 0; var reads = 0; var now = 10.0
    XCTAssertEqual(NativeFrontmostRequest.perform(capability: { true }, authorized: { true },
      setFrontmost: { effects += 1; return true }), .attempted(true))
    let result: ReadOnlySettleResult<String> = await ReadOnlySettle.observations(now: { now }, allowed: { true }, observe: {
      reads += 1
      return reads < 4 ? .pending : .observed("same_original_target_all_three_true", verified: true)
    }, sleep: { now += $0 })
    if case .verified(let value) = result { XCTAssertEqual(value,"same_original_target_all_three_true") }
    else { XCTFail("Restored exact target should verify") }
    XCTAssertEqual(effects,1); XCTAssertEqual(reads,4); XCTAssertLessThan(now,10.6)
  }
  @MainActor func testPendingDeadlineDiscardsEarlierObservation() async {
    var reads = 0; var now = 10.0
    let result: ReadOnlySettleResult<String> = await ReadOnlySettle.observations(now: { now }, allowed: { true }, observe: {
      reads += 1
      return reads == 1 ? .observed("old_geometry", verified: false) : .pending
    }, sleep: { now += $0 })
    if case .unavailable = result {} else { XCTFail("Pending deadline must not return an old sample") }
    XCTAssertEqual(now,10.6,accuracy:0.00001); XCTAssertLessThanOrEqual(reads,12)
  }
  @MainActor func testIdentityLossDuringTransitionNeverWaitsForReappearance() async {
    var reads = 0; var now = 10.0
    let result: ReadOnlySettleResult<Int> = await ReadOnlySettle.observations(now: { now }, allowed: { true }, observe: {
      reads += 1
      if reads == 1 { return .pending }
      if reads == 2 { return .unavailable }
      return .observed(3,verified:true)
    }, sleep: { now += $0 })
    if case .unavailable = result {} else { XCTFail("Lost retained identity must terminate") }
    XCTAssertEqual(reads,2)
  }
  @MainActor func testOriginalAuthorityLossBetweenPendingSamplesStopsReads() async {
    var reads = 0; var now = 10.0
    let result: ReadOnlySettleResult<Int> = await ReadOnlySettle.observations(now: { now }, allowed: { now < 10.1 }, observe: {
      reads += 1; return .pending
    }, sleep: { now += $0 })
    if case .unavailable = result {} else { XCTFail("Original deadline/Stop must terminate") }
    XCTAssertEqual(reads,1)
  }
  @MainActor func testLateGeometryRestorationCannotExtendSettleDeadline() async {
    var reads = 0; var now = 10.0
    let result: ReadOnlySettleResult<Int> = await ReadOnlySettle.observations(now: { now }, allowed: { true }, observe: {
      reads += 1
      if reads == 1 { return .pending }
      now += 0.6; return .observed(2,verified:true)
    }, sleep: { now += $0 })
    if case .unavailable = result {} else { XCTFail("Late restoration must remain unknown") }
  }
}
