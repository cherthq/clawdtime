import XCTest
@testable import DeviceCore

final class CaptureStopGateTests: XCTestCase {
  func testCaptureFailureWinsOverCleanupErrorWithoutPublishing() async {
    let finished = expectation(description: "original failure")
    let failure = CaptureFailure(.streamStart,
      underlying: NSError(domain: "private-native-domain", code: -3805,
        userInfo: [NSLocalizedDescriptionKey: "private screen or app detail"]))
    let gate = CaptureStopGate<Int>(result: .failure(failure)) { result in
      guard case .failure(let error) = result, let value = error as? CaptureFailure else {
        XCTFail("Failed start cannot publish an image"); finished.fulfill(); return
      }
      XCTAssertEqual(value.reason, .streamStart)
      XCTAssertEqual(value.headers, ["X-ClawdTime-Capture-Error": "stream_start",
        "X-ClawdTime-Capture-Code": "-3805"])
      finished.fulfill()
    }
    gate.acknowledged(error: NSError(domain: "stop", code: -999))
    await fulfillment(of: [finished], timeout: 1)
  }

  func testDiagnosticNativeCodeIsBounded() {
    let failure = CaptureFailure(.stopFailed, underlying: NSError(domain: "secret", code: Int.max))
    XCTAssertEqual(failure.headers, ["X-ClawdTime-Capture-Error": "stop_failed"])
  }

  func testSuccessfulStopPublishesExactlyOnce() async {
    let finished = expectation(description: "one completion")
    finished.assertForOverFulfill = true
    let gate = CaptureStopGate(result: Result<Int, Error>.success(42), timeout: 0.02) { result in
      XCTAssertEqual(try? result.get(), 42); finished.fulfill()
    }
    gate.acknowledged(error: nil)
    gate.acknowledged(error: HelperError(503, "late"))
    await fulfillment(of: [finished], timeout: 1)
    try? await Task.sleep(nanoseconds: 40_000_000)
  }

  func testStopFailureDiscardsCapturedValue() async {
    let finished = expectation(description: "failed stop")
    let gate = CaptureStopGate(result: Result<Int, Error>.success(42)) { result in
      if case .failure(let error) = result {
        XCTAssertEqual((error as? CaptureFailure)?.reason, .stopFailed)
      } else { XCTFail("Stop failure must not publish pixels") }; finished.fulfill()
    }
    gate.acknowledged(error: HelperError(503, "stop failed"))
    await fulfillment(of: [finished], timeout: 1)
  }

  func testMissingStopCallbackReleasesImageAndLateSuccessCannotPublish() async {
    final class Image {}
    weak var released: Image?
    let finished = expectation(description: "stop deadline")
    finished.assertForOverFulfill = true
    var gate: CaptureStopGate<Image>!
    do {
      let image = Image(); released = image
      gate = CaptureStopGate(result: .success(image), timeout: 0.01) { result in
        if case .failure(let error) = result {
          XCTAssertEqual((error as? CaptureFailure)?.reason, .stopDeadline)
        } else { XCTFail("Stop failure must not publish pixels") }; finished.fulfill()
      }
    }
    await fulfillment(of: [finished], timeout: 1)
    XCTAssertNil(released)
    gate.acknowledged(error: nil)
  }
}
