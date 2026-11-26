import XCTest
@testable import DeviceCore

final class CameraProbeLimitsTests: XCTestCase {
  func testDefaultAndExtendedBounds() throws {
    let standard = try CameraProbeLimits(arguments: ["helper", "--camera-probe"])
    XCTAssertEqual(standard.seconds, 30)
    XCTAssertEqual(standard.maxFrames, 120)
    XCTAssertEqual(standard.processDeadlineSeconds, 35)
    let extended = try CameraProbeLimits(arguments: ["helper", "--camera-probe", "--probe-seconds", "120"])
    XCTAssertEqual(extended.seconds, 120)
    XCTAssertEqual(extended.maxFrames, 480)
    XCTAssertEqual(extended.processDeadlineSeconds, 125)
  }

  func testMalformedAndUnboundedDurationsRefuseBeforeCapture() {
    for value in ["0", "-1", "121", "1.5", "NaN", "inf", "999999999999999999999", " 30", "+30", "030"] {
      XCTAssertThrowsError(try CameraProbeLimits(arguments: ["helper", "--camera-probe", "--probe-seconds", value]))
    }
    XCTAssertThrowsError(try CameraProbeLimits(arguments: ["helper", "--camera-probe", "--probe-seconds"]))
    XCTAssertThrowsError(try CameraProbeLimits(arguments: ["helper", "--camera-probe", "--probe-seconds", "60", "--probe-seconds", "60"]))
    XCTAssertThrowsError(try CameraProbeLimits(arguments: ["helper", "--camera-frame", "--probe-seconds", "60"]))
  }
}
