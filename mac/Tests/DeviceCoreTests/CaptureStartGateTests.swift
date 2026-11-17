import XCTest
@testable import DeviceCore

final class CaptureStartGateTests: XCTestCase {
  func testEarlyFrameWaitsForSuccessfulStartAndResolvesOnce() {
    let gate = CaptureStartGate<Int>()
    XCTAssertNil(gate.receive(1))
    XCTAssertNil(gate.receive(2))
    XCTAssertEqual(gate.started(), 1)
    XCTAssertNil(gate.started())
    XCTAssertNil(gate.receive(3))
  }

  func testSuccessfulStartWaitsForCompleteFrame() {
    let gate = CaptureStartGate<Int>()
    XCTAssertNil(gate.started())
    XCTAssertEqual(gate.receive(1), 1)
    XCTAssertNil(gate.receive(2))
  }

  func testFailureDiscardsEarlyFrameAndRejectsLateStart() {
    final class Image {}
    let gate = CaptureStartGate<Image>()
    weak var released: Image?
    do { let image = Image(); released = image; XCTAssertNil(gate.receive(image)) }
    XCTAssertNotNil(released)
    gate.cancel()
    XCTAssertNil(released)
    XCTAssertNil(gate.started())
    XCTAssertNil(gate.receive(Image()))
  }
}
