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
  func testReactivatingVisibleCompactModeDoesNotExpandButExplicitShowCan() {
    XCTAssertEqual(PanelDisplayMode.collapsed.reopened(hasVisibleWindows: true), .collapsed)
    XCTAssertEqual(PanelDisplayMode.collapsed.reopened(hasVisibleWindows: false), .expanded)
    XCTAssertEqual(PanelDisplayMode.badge.reopened(hasVisibleWindows: true), .badge)
    XCTAssertEqual(PanelDisplayMode.badge.reopened(hasVisibleWindows: false), .expanded)
    XCTAssertEqual(PanelDisplayMode.expanded.reopened(hasVisibleWindows: true), .expanded)
  }
  func testCircleAndBarKeepTheSameDraggedAnchor() {
    let visible = CGRect(x: -1440, y: 40, width: 1440, height: 860)
    let dragged = CGPoint(x: -700, y: 730)
    let expanded = PanelLayout.placement(in: visible, anchor: dragged, mode: .expanded)
    let minimized = PanelLayout.placement(in: visible, anchor: expanded.anchor, mode: .badge)
    let restored = PanelLayout.placement(in: visible, anchor: minimized.anchor, mode: .expanded)
    XCTAssertEqual(expanded.anchor, dragged)
    XCTAssertEqual(minimized.badge.midX, expanded.toolbar.midX)
    XCTAssertEqual(minimized.badge.maxY, expanded.toolbar.maxY)
    XCTAssertEqual(restored.toolbar, expanded.toolbar)
    XCTAssertEqual(restored.body, expanded.body)
  }
  func testExpandingNearBottomMovesGroupOnlyEnoughForUsableBody() {
    let visible = CGRect(x: 1000, y: -200, width: 1024, height: 700)
    let circle = PanelLayout.placement(in: visible, anchor: CGPoint(x: 1005, y: -100), mode: .badge)
    let expanded = PanelLayout.placement(in: visible, anchor: circle.anchor, mode: .expanded)
    XCTAssertGreaterThan(expanded.anchor.y, circle.anchor.y)
    XCTAssertEqual(expanded.body.height, 300, accuracy: 0.01)
    XCTAssertTrue(visible.contains(expanded.body)); XCTAssertTrue(visible.contains(expanded.toolbar))
    XCTAssertEqual(expanded.body.maxY + 10, expanded.toolbar.minY)
    let removedDisplay = PanelLayout.placement(in: CGRect(x: 0, y: 20, width: 800, height: 600), anchor: expanded.anchor, mode: .expanded)
    XCTAssertTrue(CGRect(x: 0, y: 20, width: 800, height: 600).contains(removedDisplay.body))
  }
  func testRestoreAtDisplayEdgeStaysOnVisibleBadgeDisplay() {
    let sourceDisplay = CGRect(x: 1000, y: 0, width: 1000, height: 800)
    let badge = PanelLayout.placement(in: sourceDisplay, anchor: CGPoint(x: 1010, y: 700), mode: .badge)
    // The hidden wide toolbar overlaps the neighbouring screen. It must not select the target screen.
    XCTAssertLessThan(badge.toolbar.minX, sourceDisplay.minX)
    let restored = PanelLayout.placement(in: sourceDisplay, anchor: badge.anchor, mode: .expanded)
    XCTAssertTrue(sourceDisplay.contains(restored.toolbar))
    XCTAssertTrue(sourceDisplay.contains(restored.body))
    XCTAssertEqual(restored.anchor.y, badge.anchor.y)
  }
  func testRapidTransitionsOnlyAcceptLastGenerationAndDragInvalidatesCallbacks() {
    var transition = PanelTransition()
    let first = transition.request(.badge)
    let second = transition.request(.expanded)
    let last = transition.request(.collapsed)
    XCTAssertFalse(transition.accepts(first)); XCTAssertFalse(transition.accepts(second))
    XCTAssertTrue(transition.accepts(last)); XCTAssertEqual(transition.target, .collapsed)
    let dragSettled = transition.request(.collapsed)
    XCTAssertFalse(transition.accepts(last)); XCTAssertTrue(transition.accepts(dragSettled))
  }
  func testMorphKeepsAnchorAndRevealTopFixedWithoutOvershoot() {
    let visible = CGRect(x: 0, y: 40, width: 1512, height: 860)
    let layout = PanelLayout.placement(in: visible, mode: .expanded)
    let closed = CGRect(x: layout.body.minX, y: layout.body.maxY - 1, width: layout.body.width, height: 1)
    var priorWidth: CGFloat = 0, priorHeight: CGFloat = 0
    for tick in 0...30 {
      let progress = Double(tick) / 30
      let shell = PanelLayout.interpolate(layout.badge, layout.toolbar, progress: progress)
      XCTAssertEqual(shell.midX, layout.anchor.x, accuracy: 0.01)
      XCTAssertEqual(shell.maxY, layout.anchor.y, accuracy: 0.01)
      XCTAssertGreaterThanOrEqual(shell.width, priorWidth); priorWidth = shell.width
      let reveal = PanelLayout.interpolate(closed, layout.body, progress: progress)
      XCTAssertEqual(reveal.width, layout.body.width)
      XCTAssertEqual(reveal.maxY, layout.body.maxY, accuracy: 0.01)
      XCTAssertGreaterThanOrEqual(reveal.height, priorHeight); priorHeight = reveal.height
    }
    XCTAssertEqual(PanelLayout.interpolate(closed, layout.body, progress: 2), layout.body)
  }
  func testOwnedMouseDragUsesGlobalDeltaAndNeverClicksAfterMovement() {
    var click = PanelDrag(pointer: CGPoint(x: -300, y: 700), window: CGPoint(x: -350, y: 660))
    XCTAssertNil(click.move(to: CGPoint(x: -299, y: 701)))
    XCTAssertFalse(click.didDrag)
    var drag = PanelDrag(pointer: CGPoint(x: -300, y: 700), window: CGPoint(x: -350, y: 660))
    XCTAssertEqual(drag.move(to: CGPoint(x: 20, y: 600)), CGPoint(x: -30, y: 560))
    XCTAssertTrue(drag.didDrag)
    // Returning to the press location is still a drag, not a mascot restore click.
    XCTAssertEqual(drag.move(to: CGPoint(x: -300, y: 700)), CGPoint(x: -350, y: 660))
    XCTAssertTrue(drag.didDrag)
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
