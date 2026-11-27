import AppKit
import XCTest
@testable import ClawdTimeTaskPanel
import TaskPanelCore

/// The rows that the panel's menu adds while ClawdTime.app runs it. The menu is built off screen.
@MainActor
final class OwnerMenuTests: XCTestCase {
  func testWithoutTheAppThePanelMenuAddsNothing() {
    XCTAssertTrue(TaskPanelApp.ownerItems(nil, target: NSObject()).isEmpty)
  }

  func testWithTheAppThePanelMenuOffersSettingsWithCommandCommaAndStop() throws {
    let app = try XCTUnwrap(OwnerApp(environment: ["CLAWDTIME_APP_BUNDLE": "/Applications/ClawdTime.app"]))
    let target = NSObject()
    let items = TaskPanelApp.ownerItems(app, target: target)
    XCTAssertTrue(items.first?.isSeparatorItem == true, "the rows stand apart from the rest of the menu")
    let rows = items.filter { !$0.isSeparatorItem }
    XCTAssertEqual(rows.map(\.title), ["Settings…", "Stop ClawdTime"])
    XCTAssertEqual(rows.map(\.keyEquivalent), [",", ""])
    XCTAssertEqual(rows[0].keyEquivalentModifierMask, .command)
    XCTAssertEqual(rows.map { $0.representedObject as? String }, ["clawdtime://settings", "clawdtime://stop"])
    XCTAssertTrue(rows.allSatisfy { $0.target === target && $0.action == #selector(TaskPanelApp.openOwnerLink(_:)) })
  }
}
