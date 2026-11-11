import XCTest

@testable import DeviceCore

final class FrameTimestampTests: XCTestCase {
  func testCaptureStartRetainsSubsecondsAcrossFreshnessBoundary() throws {
    let start = Date(timeIntervalSince1970: 1_794_423_424.900)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let encoded = frameCaptureTimestamp(start)
    XCTAssertEqual(encoded, "2026-11-11T18:57:04.900Z")
    let decoded = try XCTUnwrap(formatter.date(from: encoded))
    // The old whole-second header made this 1.2-second capture look 2.1 seconds old.
    XCTAssertLessThan(start.addingTimeInterval(1.2).timeIntervalSince(decoded), 2)
    XCTAssertLessThan(start.addingTimeInterval(1.999).timeIntervalSince(decoded), 2)
    XCTAssertGreaterThan(start.addingTimeInterval(2.001).timeIntervalSince(decoded), 2)
    XCTAssertEqual(decoded.timeIntervalSince1970, start.timeIntervalSince1970, accuracy: 0.001)
  }

  func testTimestampNeverRoundsCaptureStartIntoTheFuture() throws {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    for fraction in [0.0001, 0.4999, 0.9009, 0.9999] {
      let start = Date(timeIntervalSince1970: 1_794_423_424 + fraction)
      let decoded = try XCTUnwrap(formatter.date(from: frameCaptureTimestamp(start)))
      XCTAssertLessThanOrEqual(decoded, start)
      XCTAssertLessThan(start.timeIntervalSince(decoded), 0.0011)
    }
  }
}
