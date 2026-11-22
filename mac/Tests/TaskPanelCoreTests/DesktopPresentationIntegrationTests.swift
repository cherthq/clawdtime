import XCTest
@testable import TaskPanelCore

/// Composes the desktop's actual epoch/settlement policy with the video latch.
/// These synthetic windows establish policy behavior, not physical Space arrival.
final class DesktopPresentationIntegrationTests: XCTestCase {
  @discardableResult private func deliver(_ phase: DesktopTransitionPhase, epoch: Int,
                                         to latch: inout CallPresentationTransitionLatch) -> Bool {
    guard let mapped = CallPresentationTransitionPhase(rawValue: phase.rawValue) else {
      XCTFail("Desktop lifecycle has no presentation counterpart: \(phase.rawValue)")
      return false
    }
    return latch.receive(mapped, epoch: epoch)
  }

  func testVerifiedAdjacentMoveKeepsVideoWideUntilFreshDestinationContext() {
    var lease = DesktopObservationLease<String>()
    var latch = CallPresentationTransitionLatch()
    lease.record("left-fixture", at: 0)
    let sourceRead = latch.generation
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    XCTAssertTrue(deliver(.waiting, epoch: lease.epoch, to: &latch))
    XCTAssertFalse(lease.permits("left-fixture", at: 0.1))

    var settling = DesktopSwitchSettlement(origin: "left-fixture", at: 0)
    // A changed front window without a Space notification grants neither arrival nor zoom.
    XCTAssertEqual(settling.sample("right-fixture", spaceChanges: 0, epoch: lease.epoch, at: 0.1), .waiting)
    XCTAssertEqual(latch.mode, .transition)
    lease.invalidate() // Independent active-Space notification advances the producer epoch.
    XCTAssertEqual(settling.sample("right-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.2), .waiting)
    XCTAssertEqual(settling.sample("right-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.5), .waiting)
    XCTAssertEqual(settling.sample("right-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.9), .ready)
    lease.record("right-fixture", at: 0.9)
    XCTAssertTrue(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertTrue(lease.permits("right-fixture", at: 1))
    // Verified input destination does not itself restore a presentation target.
    XCTAssertEqual(latch.mode, .freshContext)
    XCTAssertFalse(latch.permitsContent(generation: sourceRead))
    let beforeFreshContext = latch.generation
    XCTAssertFalse(latch.permitsContent(generation: beforeFreshContext))
    XCTAssertTrue(latch.establishFreshContext(generation: beforeFreshContext))
    XCTAssertFalse(latch.permitsContent(generation: beforeFreshContext))
    XCTAssertTrue(latch.permitsContent(generation: latch.generation))
  }

  func testBoundaryTimeoutCannotReleaseZoomOrCreatePreviousDesktopHistory() {
    var lease = DesktopObservationLease<String>()
    var history = DesktopSwitchHistory<String>()
    var latch = CallPresentationTransitionLatch()
    var settling = DesktopSwitchSettlement(origin: "edge-fixture", at: 0)
    lease.record("edge-fixture", at: 0)
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    XCTAssertTrue(deliver(.waiting, epoch: lease.epoch, to: &latch))
    XCTAssertEqual(settling.sample("edge-fixture", spaceChanges: 0, epoch: lease.epoch, at: 4.9), .waiting)
    XCTAssertEqual(settling.sample("edge-fixture", spaceChanges: 0, epoch: lease.epoch, at: 5), .expired)
    lease.invalidate()
    history.invalidate()
    XCTAssertTrue(deliver(.blocked, epoch: lease.epoch, to: &latch))
    XCTAssertNil(history.previous(from: "edge-fixture"))
    XCTAssertFalse(lease.permits("edge-fixture", at: 5))
    XCTAssertFalse(deliver(.ready, epoch: lease.epoch, to: &latch))
    lease.invalidate()
    XCTAssertFalse(deliver(.waiting, epoch: lease.epoch, to: &latch))
    XCTAssertFalse(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertEqual(latch.mode, .transition)
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    XCTAssertTrue(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertEqual(latch.mode, .freshContext)
  }

  func testStopRetiresOldReadsAndCompletedLifecycleCannotReopenAfterReset() {
    var lease = DesktopObservationLease<String>()
    var latch = CallPresentationTransitionLatch()
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    lease.invalidate()
    XCTAssertTrue(deliver(.waiting, epoch: lease.epoch, to: &latch))
    let stoppedEpoch = lease.epoch
    let pendingRead = latch.generation
    lease.invalidate()
    latch.reset() // The controller also marks presentation inactive at Stop.
    XCTAssertFalse(latch.permitsContent(generation: pendingRead))
    XCTAssertFalse(deliver(.ready, epoch: stoppedEpoch, to: &latch))
    // An unseen later ready still cannot invent a new active lifecycle.
    XCTAssertFalse(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertFalse(deliver(.switching, epoch: lease.epoch, to: &latch))
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    XCTAssertTrue(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertFalse(latch.establishFreshContext(generation: pendingRead))
    XCTAssertTrue(latch.establishFreshContext(generation: latch.generation))
  }

  func testDestinationChangeRestartsSettlementWithoutAllowingPrematureZoom() {
    var lease = DesktopObservationLease<String>()
    var latch = CallPresentationTransitionLatch()
    var settling = DesktopSwitchSettlement(origin: "source-fixture", at: 0)
    lease.invalidate()
    XCTAssertTrue(deliver(.switching, epoch: lease.epoch, to: &latch))
    lease.invalidate()
    XCTAssertTrue(deliver(.waiting, epoch: lease.epoch, to: &latch))
    XCTAssertEqual(settling.sample("destination-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.1), .waiting)
    XCTAssertEqual(settling.sample("destination-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.5), .waiting)
    lease.invalidate() // App activation/geometry invalidation during settling.
    XCTAssertEqual(settling.sample("destination-fixture", spaceChanges: 1, epoch: lease.epoch, at: 0.8), .waiting)
    XCTAssertEqual(latch.mode, .transition)
    XCTAssertEqual(settling.sample("destination-fixture", spaceChanges: 1, epoch: lease.epoch, at: 1.1), .waiting)
    XCTAssertEqual(settling.sample("destination-fixture", spaceChanges: 1, epoch: lease.epoch, at: 1.5), .ready)
    XCTAssertTrue(deliver(.ready, epoch: lease.epoch, to: &latch))
    XCTAssertEqual(latch.mode, .freshContext)
  }
}
