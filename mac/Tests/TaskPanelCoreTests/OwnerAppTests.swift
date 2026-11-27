import XCTest
@testable import TaskPanelCore

/// The panel knows that the Mac app runs it only from the app's own variable.
final class OwnerAppTests: XCTestCase {
  func testOnlyAnAbsolutePathToAnAppBundleCountsAsTheApp() {
    XCTAssertEqual(OwnerApp(environment: ["CLAWDTIME_APP_BUNDLE": "/Applications/ClawdTime.app"])?.bundle.path, "/Applications/ClawdTime.app")
    XCTAssertEqual(OwnerApp(environment: ["CLAWDTIME_APP_BUNDLE": "/Users/example/My Apps/ClawdTime.app/"])?.bundle.path, "/Users/example/My Apps/ClawdTime.app")
    for value in ["", "1", "true", "ClawdTime.app", "~/Applications/ClawdTime.app", "/Applications/ClawdTime", "/Applications/ClawdTime.app/Contents",
                  "/Applications/Clawd\nTime.app", String(repeating: "a", count: 1100) + ".app"] {
      XCTAssertNil(OwnerApp(environment: ["CLAWDTIME_APP_BUNDLE": value]), value)
    }
    XCTAssertNil(OwnerApp(environment: [:]), "a start from Terminal has no app")
    XCTAssertNil(OwnerApp(environment: ["CLAWDTIME_APP": "/Applications/ClawdTime.app"]), "only the one variable counts")
  }

  func testTheMenuAddsSettingsAndStopAndTheLinksAreTheOnesTheAppAnswers() {
    XCTAssertEqual(OwnerApp.menu.map(\.title), ["Settings…", "Stop ClawdTime"])
    XCTAssertEqual(OwnerApp.menu.map(\.key), [",", ""])
    XCTAssertEqual(OwnerApp.menu.map(\.link), [.settings, .stop])
    XCTAssertEqual(OwnerAppLink.allCases.map(\.url.absoluteString), ["clawdtime://open", "clawdtime://settings", "clawdtime://stop"])
    XCTAssertEqual(OwnerAppLink.allCases.map(\.activates), [true, true, false])
  }
}
