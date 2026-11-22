import Foundation
import XCTest
@testable import TaskPanelCore

final class PanelDesktopCheckTests: XCTestCase {
  func testRequiresStandaloneFlagAndNeverFallsThroughOnMalformedDiagnostic() {
    XCTAssertEqual(PanelDesktopCheck.parse(arguments: ["panel", "--check-desktop"]), .requested)
    for arguments in [["panel", "--check-desktop", "--config", "/private/config.json"],
                      ["panel", "--check-access", "--check-desktop"],
                      ["panel", "--check-desktop", "--check-desktop"]] {
      XCTAssertEqual(PanelDesktopCheck.parse(arguments: arguments), .invalid)
    }
    XCTAssertEqual(PanelDesktopCheck.parse(arguments: ["panel", "--check-access"]), .notRequested)
    XCTAssertEqual(PanelDesktopCheck.parse(arguments: ["panel", "--config", "/private/config.json"]), .notRequested)
  }
  func testSnapshotContainsOnlyCountReasonAndBooleanFacts() throws {
    var snapshot = PanelDesktopSnapshot()
    snapshot.reason = "window_outside_main_display"
    snapshot.activeDisplays = 1
    snapshot.checks = ["ordinaryWindow": true, "containedInMainDisplay": false]
    let data = try JSONEncoder().encode(snapshot)
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(Set(value.keys), ["version", "reason", "activeDisplays", "checks"])
    XCTAssertEqual(value["checks"] as? [String: Bool], snapshot.checks)
    XCTAssertEqual(value["reason"] as? String, "window_outside_main_display")
    XCTAssertEqual(value["activeDisplays"] as? Int, 1)
  }
}
