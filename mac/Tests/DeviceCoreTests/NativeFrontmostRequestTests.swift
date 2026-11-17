import XCTest
@testable import DeviceCore

final class NativeFrontmostRequestTests: XCTestCase {
  @MainActor func testOneSetterForSuccessOrErrorWithoutFallback() {
    for acknowledged in [true, false] {
      var events = [String]()
      let result = NativeFrontmostRequest.perform(capability: { events.append("inspect"); return true },
        authorized: { events.append("recheck"); return true },
        setFrontmost: { events.append("setter"); return acknowledged })
      XCTAssertEqual(result, .attempted(acknowledged))
      XCTAssertEqual(events, ["inspect", "recheck", "setter"])
    }
  }
  @MainActor func testUnsupportedAttributeOrWrongPIDNeverDispatches() {
    for (pid, settable): (Int32?, Bool?) in [(nil, true), (43, true), (42, nil), (42, false), (0, true)] {
      var effects = 0; var checks = 0
      let result = NativeFrontmostRequest.perform(capability: {
        NativeFrontmostRequest.available(expectedPID:42, observedPID:pid, attributeSettable:settable)
      },
        authorized: { checks += 1; return true }, setFrontmost: { effects += 1; return true })
      XCTAssertEqual(result, .unavailable); XCTAssertEqual(effects, 0); XCTAssertEqual(checks, 0)
    }
    XCTAssertTrue(NativeFrontmostRequest.available(expectedPID:42, observedPID:42, attributeSettable:true))
    XCTAssertFalse(NativeFrontmostRequest.available(expectedPID:0, observedPID:0, attributeSettable:true))
  }
  @MainActor func testAuthorityLossDuringCapabilityReadPreventsEffect() {
    var current = true; var effects = 0
    let result = NativeFrontmostRequest.perform(capability: { current = false; return true },
      authorized: { current }, setFrontmost: { effects += 1; return true })
    XCTAssertEqual(result, .authorityChanged); XCTAssertEqual(effects, 0)
  }
}
