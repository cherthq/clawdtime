import XCTest
@testable import DeviceCore

final class LocalSessionPolicyTests: XCTestCase {
  func testFixedStagesPreserveOriginalEligibility() {
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: false, onConsole: nil, loginDone: nil, locked: nil), .missing)
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, onConsole: nil, loginDone: true, locked: false), .offConsole)
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, onConsole: false, loginDone: true, locked: false), .offConsole)
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, onConsole: true, loginDone: nil, locked: false), .loginIncomplete)
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, onConsole: true, loginDone: false, locked: false), .loginIncomplete)
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, onConsole: true, loginDone: true, locked: true), .locked)
    XCTAssertNil(LocalSessionRefusal.evaluate(present: true, onConsole: true, loginDone: true, locked: nil))
    XCTAssertNil(LocalSessionRefusal.evaluate(present: true, onConsole: true, loginDone: true, locked: false))
    XCTAssertEqual(LocalSessionRefusal.evaluate(present: true, forcedUnavailable: true, onConsole: true, loginDone: true, locked: false), .forcedUnavailable)
  }
}
