import XCTest
@testable import TaskPanelCore

final class AppNavigationTests: XCTestCase {
  private let display = CGRect(x: 0, y: 0, width: 1500, height: 1000)
  private let full = CGRect(x: 0, y: 37, width: 1500, height: 963)
  private let strip = CGRect(x: 0, y: 37, width: 1500, height: 44)
  private func row(_ id: Int, pid: Int = 10, title: String? = "Fixture", frame: CGRect) -> DesktopWindowEvidence {
    .init(id: id, pid: pid, title: title, frame: frame)
  }
  private func match(_ rows: [DesktopWindowEvidence], confirmed: Bool = true, frames: [CGRect]? = []) -> Int? {
    DesktopWindowVisibility.focusedWindowID(pid: 10, title: "Fixture", frame: full,
      fullScreenConfirmed: confirmed, display: display, visible: rows, accessibleFrames: frames)
  }

  func testFullScreenRequiresAffirmativeEvidenceAndSoleDisplayGeometry() {
    XCTAssertTrue(DesktopSurfaceScope.permits(window: full, display: display, ordinary: true,
      fullScreen: true, activeDisplays: 1, transition: true, fullScreenConfirmed: true))
    XCTAssertFalse(DesktopSurfaceScope.permits(window: full, display: display, ordinary: true,
      fullScreen: true, activeDisplays: 1, transition: true))
    for (window, ordinary, displays) in [(CGRect(x: 0, y: 37, width: 750, height: 963), true, 1),
      (CGRect(x: 0, y: 160, width: 1500, height: 840), true, 1), (full, false, 1), (full, true, 2)] {
      XCTAssertFalse(DesktopSurfaceScope.permits(window: window, display: display, ordinary: ordinary,
        fullScreen: true, activeDisplays: displays, transition: true, fullScreenConfirmed: true))
    }
  }

  func testFullScreenAuxiliaryStripStillResolvesExactFocusedWindow() {
    let windows = [row(1, title: nil, frame: strip), row(2, frame: full)]
    XCTAssertEqual(match(windows, frames: [full]), 2)
    XCTAssertNil(match(windows, confirmed: false, frames: [full]))
    XCTAssertNil(match(windows, frames: nil))
    XCTAssertEqual(match([row(2, frame: full)], confirmed: false), 2)
  }

  func testDialogsOtherAppsAndMultipleOverlaysNeverBecomeIgnoredChrome() {
    XCTAssertNil(match([row(1, title: "Dialog", frame: strip), row(2, frame: full)], frames: [strip, full]))
    XCTAssertNil(match([row(1, pid: 11, frame: strip), row(2, frame: full)], frames: [full]))
    XCTAssertNil(match([row(1, frame: strip), row(3, frame: strip), row(2, frame: full)], frames: [full]))
    XCTAssertNil(match([row(1, frame: CGRect(x: 20, y: 100, width: 300, height: 200)), row(2, frame: full)], frames: [full]))
    XCTAssertNil(match([row(1, frame: CGRect(x: 0, y: 37, width: 1500, height: 100)), row(2, frame: full)], frames: [full]))
  }

  func testDuplicateOrMismatchedWindowEvidenceCannotGrantArrival() {
    XCTAssertNil(match([row(1, frame: full), row(2, frame: full)]))
    XCTAssertNil(match([row(1, title: "Sibling", frame: full)]))
    XCTAssertNil(match([row(1, pid: 11, frame: full)]))
    XCTAssertNil(match([row(1, frame: full.offsetBy(dx: 2, dy: 0))]))
  }

  func testPreviousAppRequiresChangedPIDAndStableSurface() {
    var settling = AppSwitchSettlement<String>(originPID: 10, at: 0)
    XCTAssertEqual(settling.sample("different-window-same-app", pid: 10, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(settling.sample("different-window-same-app", pid: 10, epoch: 1, at: 0.8), .waiting)
    XCTAssertEqual(settling.sample("destination", pid: 20, epoch: 2, at: 1), .waiting)
    XCTAssertEqual(settling.sample("destination", pid: 20, epoch: 2, at: 1.3), .waiting)
    XCTAssertEqual(settling.sample("destination", pid: 20, epoch: 2, at: 1.7), .ready)
  }

  func testPreviousAppEpochAndGeometryChangesRestartSettlementAndExpire() {
    var settling = AppSwitchSettlement<String>(originPID: 10, at: 0)
    XCTAssertEqual(settling.sample("B", pid: 20, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(settling.sample("B", pid: 20, epoch: 1, at: 0.3), .waiting)
    XCTAssertEqual(settling.sample("B", pid: 20, epoch: 2, at: 0.7), .waiting)
    XCTAssertEqual(settling.sample("resized-B", pid: 20, epoch: 2, at: 1.4), .waiting)
    XCTAssertEqual(settling.sample(nil, pid: nil, epoch: 2, at: 1.8), .waiting)
    XCTAssertEqual(settling.sample("resized-B", pid: 20, epoch: 2, at: 5), .expired)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .switchPreviousApp, submitted: true), .transitionUnknown)
    XCTAssertEqual(DesktopEffectOutcome.failure(.stoppedByPerson, dispatched: true), .transitionUnknown)
  }

  func testGenericKeyboardCannotCycleTheAppSwitcher() throws {
    for name in ["cmd+tab", "cmd+shift+tab"] {
      let key = try XCTUnwrap(KeyCombo.parse(name))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: 48, configured: []))
      XCTAssertFalse(DesktopShortcuts.permits(key, resolvedCode: 48, configured: nil))
    }
  }

  func testAppArrivalLeavesZoomWideUntilFreshContextAndStopFencesCallbacks() {
    var latch = CallPresentationTransitionLatch()
    var settling = AppSwitchSettlement<String>(originPID: 10, at: 0)
    XCTAssertTrue(latch.receive(.switching, epoch: 1))
    XCTAssertTrue(latch.receive(.waiting, epoch: 1))
    let oldRead = latch.generation
    XCTAssertEqual(settling.sample("full-screen-app", pid: 20, epoch: 2, at: 0), .waiting)
    XCTAssertEqual(settling.sample("full-screen-app", pid: 20, epoch: 2, at: 0.3), .waiting)
    XCTAssertEqual(settling.sample("full-screen-app", pid: 20, epoch: 2, at: 0.7), .ready)
    XCTAssertTrue(latch.receive(.ready, epoch: 2))
    XCTAssertEqual(latch.mode, .freshContext)
    XCTAssertFalse(latch.establishFreshContext(generation: oldRead))
    XCTAssertTrue(latch.establishFreshContext(generation: latch.generation))
    XCTAssertTrue(latch.permitsContent(generation: latch.generation))
    latch.reset()
    XCTAssertFalse(latch.receive(.ready, epoch: 2))
  }
}
