import Foundation
import CoreGraphics
import XCTest
@testable import TaskPanelCore

final class PanelLayoutTests: XCTestCase {
  func testToolbarAndBodyStayBelowMenuAndInsideVisibleScreen() {
    for visible in [CGRect(x: 0, y: 40, width: 1512, height: 880),
                    CGRect(x: -1440, y: 25, width: 1440, height: 785),
                    CGRect(x: 0, y: 0, width: 800, height: 500),
                    CGRect(x: 1512, y: -200, width: 1024, height: 700)] {
      let toolbar = PanelLayout.toolbar(in: visible), body = PanelLayout.body(in: visible)
      XCTAssertTrue(visible.contains(toolbar)); XCTAssertTrue(visible.contains(body))
      XCTAssertEqual(toolbar.midX, visible.midX, accuracy: 0.01)
      XCTAssertLessThanOrEqual(toolbar.maxY, visible.maxY - 10)
      XCTAssertEqual(body.maxY + 10, toolbar.minY)
      XCTAssertEqual(body.midX, visible.midX, accuracy: 0.01)
      XCTAssertEqual(toolbar.width, 430)
      XCTAssertEqual(body.width, 560)
      XCTAssertGreaterThanOrEqual(body.height, 300)
    }
  }
  func testBadgeClampsAfterDragAndRemovedDisplay() {
    let visible = CGRect(x: 0, y: 40, width: 1280, height: 760)
    for origin in [CGPoint(x: -1400, y: -900), CGPoint(x: 5000, y: 3000), CGPoint(x: 500, y: 500)] {
      let frame = PanelLayout.badge(in: visible, previous: CGRect(origin: origin, size: CGSize(width: 62, height: 62)))
      XCTAssertTrue(visible.contains(frame)); XCTAssertEqual(frame.size.width, 62)
      XCTAssertEqual(frame.size.height, 62)
    }
  }
  func testReactivatingVisibleToolbarDoesNotExpandButExplicitShowCan() {
    XCTAssertEqual(PanelDisplayMode.collapsed.reopened(hasVisibleWindows: true), .collapsed)
    XCTAssertEqual(PanelDisplayMode.collapsed.reopened(hasVisibleWindows: false), .expanded)
    XCTAssertEqual(PanelDisplayMode.badge.reopened(hasVisibleWindows: true), .expanded)
    XCTAssertEqual(PanelDisplayMode.expanded.reopened(hasVisibleWindows: true), .expanded)
  }
  func testDisplayChangesHaveNoTaskOrControlMeaning() {
    XCTAssertEqual(PanelDisplayMode.expanded.toggled, .collapsed)
    XCTAssertEqual(PanelDisplayMode.collapsed.toggled, .expanded)
    XCTAssertEqual(PanelDisplayMode.badge.toggled, .expanded)
    var state = PanelState()
    state.taskMutationBoundary(.decide)
    let generation = state.mutationGeneration
    _ = PanelDisplayMode.expanded.toggled
    XCTAssertEqual(state.mutationGeneration, generation)
    XCTAssertTrue(state.waitingForSnapshot)
  }
}
