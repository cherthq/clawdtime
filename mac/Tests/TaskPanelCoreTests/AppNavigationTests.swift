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

  func testASheetIsMatchedByItsAppAndFrameAsTheTopWindowOnly() {
    let sheet = CGRect(x: 250, y: 158, width: 390, height: 318)
    let window = CGRect(x: 152, y: 73, width: 586, height: 488)
    let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    func id(_ visible: [DesktopWindowEvidence], sheet isSheet: Bool = true, frame: CGRect? = nil) -> Int? {
      DesktopWindowVisibility.focusedWindowID(pid: 10, title: "", frame: frame ?? sheet, fullScreenConfirmed: false,
        display: display, visible: visible, accessibleFrames: nil, sheet: isSheet)
    }
    let own: [DesktopWindowEvidence] = [.init(id: 7, pid: 10, title: "Save", frame: sheet), .init(id: 3, pid: 10, title: "Untitled", frame: window)]
    // The sheet has no Accessibility title. The window server calls it "Save". Same app, same frame, on top: it is the one.
    XCTAssertEqual(id(own), 7)
    // The same rows read as an ordinary window need the same name, so a window with no title matches nothing.
    XCTAssertNil(id(own, sheet: false))
    // Another app's window on top, a sheet that is not on top, another frame, two rows with the frame: no match.
    XCTAssertNil(id([.init(id: 9, pid: 11, title: "Other", frame: window)] + own))
    XCTAssertNil(id([.init(id: 3, pid: 10, title: "Untitled", frame: window), .init(id: 7, pid: 10, title: "Save", frame: sheet)]))
    XCTAssertNil(id(own, frame: sheet.offsetBy(dx: 40, dy: 0)))
    XCTAssertNil(id([.init(id: 7, pid: 10, title: "Save", frame: sheet), .init(id: 8, pid: 10, title: "Save", frame: sheet)]))
    XCTAssertNil(id([.init(id: 7, pid: 12, title: "Save", frame: sheet), .init(id: 3, pid: 10, title: "Untitled", frame: window)]))
  }

  func testAListNameWithTheAppsOwnWordsAfterItIsTheSameWindow() {
    func found(_ rows: [DesktopWindowEvidence], accessible: String) -> Int? {
      DesktopWindowVisibility.focusedWindowID(pid: 10, title: accessible, frame: full,
        fullScreenConfirmed: false, display: display, visible: rows, accessibleFrames: [])
    }
    // A browser: the window list has the page title, Accessibility adds the app and the profile.
    XCTAssertEqual(found([row(1, title: "Inbox (3)", frame: full)], accessible: "Inbox (3) - Browser \u{2013} Work"), 1)
    XCTAssertEqual(found([row(1, title: "Notes", frame: full)], accessible: "Notes \u{2014} Editor"), 1)
    XCTAssertEqual(found([row(1, title: "Same", frame: full)], accessible: "Same"), 1)
    // Two windows of the app in the same place: only the one whose title it is.
    XCTAssertEqual(found([row(1, title: "Inbox", frame: full), row(2, title: "Inbox (2)", frame: full)], accessible: "Inbox - Browser"), 1)
    XCTAssertNil(found([row(1, title: "Inbox (2)", frame: full), row(2, title: "Inbox", frame: full)], accessible: "Inbox - Browser"),
      "the window of that title is behind another one")
    // A part of a word, another title, an empty or a missing list name: no window.
    XCTAssertNil(found([row(1, title: "Fix", frame: full)], accessible: "Fixture"))
    XCTAssertNil(found([row(1, title: "Fix", frame: full)], accessible: "Fix-ture"))
    XCTAssertNil(found([row(1, title: "Sibling", frame: full)], accessible: "Fixture - Browser"))
    XCTAssertNil(found([row(1, title: "", frame: full)], accessible: "Bluetooth"))
    XCTAssertNil(found([row(1, title: nil, frame: full)], accessible: "Fixture"))
    XCTAssertEqual(found([row(1, title: "", frame: full)], accessible: ""), 1)
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

  func testEmptyInventoryRevealIsNamedRunningAppOnlyAndCanBeClaimedOnce() {
    var reveal = DesktopAppReveal()
    XCTAssertNoThrow(try reveal.claim(running: true, exactWindowRequested: false, inventory: .empty, refusal: nil).get())
    XCTAssertTrue(reveal.claimed)
    XCTAssertThrowsError(try reveal.claim(running: true, exactWindowRequested: false, inventory: .empty, refusal: nil).get())
    // It cannot be claimed again after an unverified result or a repeated read.
    XCTAssertThrowsError(try reveal.claim(running: true, exactWindowRequested: false, inventory: .nonempty, refusal: nil).get())
    XCTAssertEqual(DesktopEffectOutcome.failure(.targetNotVisible, dispatched: reveal.claimed), .transitionUnknown)
    XCTAssertEqual(DesktopEffectOutcome.failure(.ambiguousTarget, dispatched: reveal.claimed), .transitionUnknown)
  }

  func testEmptyInventoryRevealNeverWidensAnExactWindowOrAnUnreadableInventory() {
    for (running, exact, inventory) in [(true, true, DesktopAppInventory.empty),
      (false, false, .empty), (true, false, .nonempty), (true, false, .unavailable)] {
      var reveal = DesktopAppReveal()
      XCTAssertThrowsError(try reveal.claim(running: running, exactWindowRequested: exact, inventory: inventory, refusal: nil).get())
      XCTAssertFalse(reveal.claimed)
      XCTAssertEqual(DesktopEffectOutcome.failure(.targetNotVisible, dispatched: reveal.claimed), .targetNotVisible)
    }
  }

  func testPendingStopOrPermissionRefusalPreventsRevealWithoutConsumingIt() {
    for refusal in [HandError.stoppedByPerson, .refused, .noAccessibility, .noScreenRecording, .staleObservation] {
      var reveal = DesktopAppReveal()
      let result = reveal.claim(running: true, exactWindowRequested: false, inventory: .empty, refusal: refusal)
      if case .failure(let error) = result { XCTAssertEqual(error, refusal) } else { XCTFail("Refusal must prevent activation") }
      XCTAssertFalse(reveal.claimed)
    }
    // A Stop after submission must remain unknown rather than becoming safe to retry.
    XCTAssertEqual(DesktopEffectOutcome.failure(.stoppedByPerson, dispatched: true), .transitionUnknown)
  }

}
