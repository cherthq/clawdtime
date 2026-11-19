import XCTest
@testable import DeviceCore

final class TaskCaptureTimingTests: XCTestCase {
  func testRefusalMarkersContainNoValuesAndKeepTimingWire() throws {
    let refusals = TaskCaptureTiming.Phase.allCases.filter { $0.rawValue.hasPrefix("refused_") }
    XCTAssertEqual(refusals.count, 23)
    for phase in refusals {
      let data = try JSONEncoder().encode(TaskCaptureTiming(phase: phase, elapsedMilliseconds: 200, sequence: 9))
      let record = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(Set(record.keys), ["phase", "elapsedMs", "sequence"])
      XCTAssertTrue(try JSONDecoder().decode(TaskCaptureTiming.self, from: data).phase.rawValue.hasPrefix("refused_"))
    }
  }
  func testClosedNumericWireAndBounds() throws {
    for phase in TaskCaptureTiming.Phase.allCases {
      let value = TaskCaptureTiming(phase: phase, elapsedMilliseconds: 42.3)
      let data = try JSONEncoder().encode(value)
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(Set(object.keys), ["phase", "elapsedMs", "sequence"])
      XCTAssertEqual(object["phase"] as? String, phase.rawValue)
      XCTAssertEqual(object["elapsedMs"] as? Int, 42)
      XCTAssertEqual(object["sequence"] as? Int, 0)
      XCTAssertLessThan(data.count, 128)
      let saturated = TaskCaptureTiming(phase: phase, elapsedMilliseconds: 9e12, sequence: Int.max)
      let maximum = try JSONEncoder().encode(saturated)
      XCTAssertLessThan(maximum.count + 1, 128)
      XCTAssertEqual(saturated.sequence, 1_000_000)
    }
    XCTAssertEqual(TaskCaptureTiming(phase: .idle, elapsedMilliseconds: -.infinity).elapsedMs, 0)
    XCTAssertEqual(TaskCaptureTiming(phase: .idle, elapsedMilliseconds: -2).elapsedMs, 0)
    XCTAssertEqual(TaskCaptureTiming(phase: .idle, elapsedMilliseconds: 9e12).elapsedMs, 1_800_000)
    XCTAssertThrowsError(try JSONDecoder().decode(TaskCaptureTiming.self, from: Data("{\"phase\":\"PRIVATE_OS_ERROR\",\"elapsedMs\":1}".utf8)))
  }
}
