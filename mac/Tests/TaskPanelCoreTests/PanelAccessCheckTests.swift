import Foundation
import XCTest
@testable import TaskPanelCore

final class PanelAccessCheckTests: XCTestCase {
  func testCheckRequiresExactStandaloneFlag() {
    XCTAssertEqual(PanelAccessCheck.parse(arguments: ["panel", "--check-access"]), .requested)
    for arguments in [["panel", "--check-access", "--config", "/private/config.json"],
                      ["panel", "--tucked", "--check-access"],
                      ["panel", "--check-access", "--check-access"],
                      ["panel", "--config", "--check-access"]] {
      XCTAssertEqual(PanelAccessCheck.parse(arguments: arguments), .invalid)
    }
  }
  func testOrdinaryLaunchIsNotIntercepted() {
    for arguments in [[], ["panel"], ["panel", "--config", "/private/config.json", "--tucked"]] {
      XCTAssertEqual(PanelAccessCheck.parse(arguments: arguments), .notRequested)
    }
  }
  func testOutputHasOnlyVersionAndIndependentPermissionConfigurationFacts() throws {
    let value = PanelAccessSnapshot(accessibility: false, screenRecording: true,
      desktopSwitchingEnabled: false, desktopShortcutsAvailable: true)
    let encoded = try JSONEncoder().encode(value)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["version", "accessibility", "screenRecording", "desktopSwitchingEnabled", "desktopShortcutsAvailable"])
    XCTAssertEqual(object["version"] as? Int, 1)
    XCTAssertEqual(object["accessibility"] as? Bool, false)
    XCTAssertEqual(object["screenRecording"] as? Bool, true)
    XCTAssertEqual(object["desktopSwitchingEnabled"] as? Bool, false)
    XCTAssertEqual(object["desktopShortcutsAvailable"] as? Bool, true)
  }
}
