import XCTest
@testable import DeviceCore

final class LatestCaptureTests: XCTestCase {
  func testReplacementNeverRestampsOrAcceptsLateOrFutureSamples() {
    let slot = LatestCapture<String>()
    slot.put("first", capturedAt: 10)
    slot.put("latest", capturedAt: 11)
    slot.put("late", capturedAt: 10.5)
    XCTAssertEqual(slot.latest(now: 11.5, maximumAge: 1), "latest")
    XCTAssertNil(slot.latest(now: 10, maximumAge: 2))
    XCTAssertNil(slot.latest(now: 12, maximumAge: 1))
    XCTAssertNil(slot.latest(now: 13, maximumAge: 1))
  }
  func testStopClearsAndCannotBeRevivedByLateCallback() {
    let slot = LatestCapture<String>()
    slot.put("pixels", capturedAt: 10)
    slot.close()
    slot.put("late pixels", capturedAt: 11)
    XCTAssertNil(slot.latest(now: 11.1, maximumAge: 2))
  }
}
