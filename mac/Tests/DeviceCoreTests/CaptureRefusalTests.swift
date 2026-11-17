import XCTest
@testable import DeviceCore

final class CaptureRefusalTests: XCTestCase {
  let frame = CGRect(x: 130, y: 229, width: 920, height: 436)

  func testLifecycleReasonsPreserveOffSpaceAndFailClosedDecisions() {
    func reason(hidden: Bool = false, active: Bool = false, count: Int = 1,
      witnesses: [WindowLifecycleWitness] = []) -> CaptureRefusal.Reason? {
      WindowCapturePolicy.unavailableReason(frame: frame, onScreen: false, active: active,
        appHidden: hidden, witnesses: witnesses, matchingCaptureWindows: count)
    }
    let valid = WindowLifecycleWitness(frame: frame, minimized: false)
    XCTAssertNil(reason(witnesses: [valid]))
    XCTAssertNil(reason(active: true))
    XCTAssertEqual(reason(hidden: true, active: true), .appHidden)
    XCTAssertEqual(reason(count: 2, witnesses: [valid]), .captureWindowAmbiguous)
    XCTAssertEqual(reason(), .lifecycleWitnessUnavailable)
    XCTAssertEqual(reason(witnesses: [valid, valid]), .lifecycleWitnessAmbiguous)
    XCTAssertEqual(reason(witnesses: [.init(frame: frame, minimized: nil)]), .lifecycleWitnessUnreadable)
    XCTAssertEqual(reason(witnesses: [.init(frame: frame, minimized: true)]), .windowMinimized)
  }

  func testRefusalWireContainsOnlyFixedCodeAndRetains409() {
    for reason in CaptureRefusal.Reason.allCases {
      let error = CaptureRefusal(reason)
      XCTAssertEqual(error.status, 409)
      XCTAssertEqual(error.headers, ["X-ClawdTime-Camera-Refusal": reason.rawValue])
      XCTAssertNotNil(reason.rawValue.range(of: "^[a-z_]+$", options: .regularExpression))
    }
  }
}
