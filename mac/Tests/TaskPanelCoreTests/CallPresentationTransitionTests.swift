import CoreGraphics
import XCTest
@testable import TaskPanelCore

final class CallPresentationTransitionTests: XCTestCase {
  func testLifecycleHoldsEveryHeartbeatWideUntilReadyAndAFreshContext() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 10))
    XCTAssertEqual(latch.mode, .transition)
    XCTAssertFalse(latch.permitsContent(generation: latch.generation))
    XCTAssertTrue(latch.receive(.waiting, epoch: 11))
    XCTAssertEqual(latch.mode, .transition)
    // Native Space notifications may advance the epoch during settlement.
    XCTAssertTrue(latch.receive(.ready, epoch: 14))
    XCTAssertEqual(latch.mode, .freshContext)
    XCTAssertFalse(latch.permitsContent(generation: latch.generation))
    XCTAssertTrue(latch.establishFreshContext(generation: latch.generation))
    XCTAssertEqual(latch.mode, .content)
    XCTAssertTrue(latch.permitsContent(generation: latch.generation))
  }

  func testReadyWithAnOlderEpochCannotReleaseANewerHold() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 10))
    XCTAssertTrue(latch.receive(.waiting, epoch: 12))
    let generation = latch.generation
    XCTAssertFalse(latch.receive(.ready, epoch: 11))
    XCTAssertEqual(latch.mode, .transition)
    XCTAssertEqual(latch.generation, generation)
    XCTAssertFalse(latch.receive(.switching, epoch: 10))
    XCTAssertEqual(latch.phase, .waiting)
  }

  func testSameEpochCannotRegressOrReopenACompletedPhase() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 4))
    XCTAssertTrue(latch.receive(.waiting, epoch: 4))
    XCTAssertFalse(latch.receive(.switching, epoch: 4))
    XCTAssertTrue(latch.receive(.ready, epoch: 4))
    XCTAssertFalse(latch.receive(.ready, epoch: 4))
    for phase in [CallPresentationTransitionPhase.switching, .waiting, .blocked] {
      XCTAssertFalse(latch.receive(phase, epoch: 4))
    }
    XCTAssertEqual(latch.mode, .freshContext)
    XCTAssertTrue(latch.establishFreshContext(generation: latch.generation))
    XCTAssertTrue(latch.receive(.switching, epoch: 5))
    XCTAssertEqual(latch.mode, .transition)
  }

  func testBlockedStaysLatchedDespiteNewerWaitingOrReadyUntilNewSwitching() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 1))
    XCTAssertTrue(latch.receive(.blocked, epoch: 2))
    XCTAssertFalse(latch.receive(.ready, epoch: 2))
    XCTAssertFalse(latch.receive(.waiting, epoch: 3))
    XCTAssertFalse(latch.receive(.ready, epoch: 4))
    XCTAssertEqual(latch.phase, .blocked)
    XCTAssertEqual(latch.mode, .transition)
    // Even rejected observations advance the watermark, so delayed callbacks
    // cannot start a second lifecycle behind a newer one already seen.
    XCTAssertFalse(latch.receive(.switching, epoch: 3))
    XCTAssertFalse(latch.receive(.switching, epoch: 4))
    XCTAssertTrue(latch.receive(.switching, epoch: 5))
    XCTAssertTrue(latch.receive(.ready, epoch: 6))
    XCTAssertEqual(latch.mode, .freshContext)
  }

  func testStopClearsHoldButFencesObservedCallbacksAndOrphanReady() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 10))
    let oldGeneration = latch.generation
    latch.reset()
    XCTAssertEqual(latch.mode, .content)
    XCTAssertNil(latch.phase)
    XCTAssertFalse(latch.permitsContent(generation: oldGeneration))
    for phase in [CallPresentationTransitionPhase.switching, .waiting, .blocked, .ready] {
      XCTAssertFalse(latch.receive(phase, epoch: 10))
    }
    // A ready without a preceding live hold grants nothing, even at a new epoch.
    XCTAssertFalse(latch.receive(.ready, epoch: 11))
    XCTAssertFalse(latch.receive(.switching, epoch: 11))
    XCTAssertTrue(latch.receive(.switching, epoch: 12))
    XCTAssertEqual(latch.mode, .transition)
  }

  func testInFlightTypingAndSettlementCannotCrossLifecycleOrStop() {
    var latch = CallPresentationTransitionLatch()
    let readingBeforeSwitch = latch.generation
    XCTAssertTrue(latch.receive(.switching, epoch: 1))
    XCTAssertFalse(latch.permitsContent(generation: readingBeforeSwitch))
    XCTAssertTrue(latch.receive(.ready, epoch: 2))
    let readingBeforeContext = latch.generation
    XCTAssertTrue(latch.establishFreshContext(generation: readingBeforeContext))
    // Even if the same command is still running and types again, an AX read
    // or deferred settling task from before the lifecycle is fenced out.
    XCTAssertFalse(latch.permitsContent(generation: readingBeforeSwitch))
    XCTAssertFalse(latch.permitsContent(generation: readingBeforeContext))
    let current = latch.generation
    XCTAssertTrue(latch.permitsContent(generation: current))
    latch.reset()
    XCTAssertFalse(latch.permitsContent(generation: current))
  }

  func testFreshContextCannotBeEstablishedByAnEarlierLifecycleRead() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertTrue(latch.receive(.switching, epoch: 1))
    XCTAssertTrue(latch.receive(.ready, epoch: 2))
    let observing = latch.generation
    XCTAssertTrue(latch.receive(.switching, epoch: 3))
    XCTAssertFalse(latch.establishFreshContext(generation: observing))
    XCTAssertEqual(latch.mode, .transition)
    XCTAssertTrue(latch.receive(.ready, epoch: 4))
    XCTAssertFalse(latch.establishFreshContext(generation: observing))
    XCTAssertEqual(latch.mode, .freshContext)
  }

  func testOneShotTransitionInvalidatesAsyncContentWithoutChangingLatchMode() {
    var latch = CallPresentationTransitionLatch()
    let before = latch.generation
    latch.invalidateContent()
    XCTAssertEqual(latch.mode, .content)
    XCTAssertFalse(latch.permitsContent(generation: before))
    XCTAssertTrue(latch.receive(.switching, epoch: 1))
    latch.invalidateContent()
    XCTAssertEqual(latch.mode, .transition)
    XCTAssertTrue(latch.receive(.ready, epoch: 2))
    latch.invalidateContent()
    XCTAssertEqual(latch.mode, .freshContext)
  }

  func testRetiredIntentNeverReturnsAfterLifecycleRelease() {
    var latch = CallPresentationTransitionLatch()
    var intent = CallPresentationIntent()
    let surface = CallPresentationEvent.Surface(displayId: "1", width: 1440, height: 900, scale: 2,
      appId: "com.example.fixture", windowId: "2", window: .init(CGRect(x: 10, y: 10, width: 1000, height: 800)))
    intent.deferTarget(.init(CGRect(x: 50, y: 50, width: 100, height: 50)), on: surface, commandSeq: 7, at: 1000)
    if latch.receive(.switching, epoch: 1) { intent.retire() }
    XCTAssertNil(intent.takeTarget(on: surface, commandSeq: 7, now: 1350))
    intent.beginTyping()
    if latch.receive(.waiting, epoch: 2) { intent.retire() }
    XCTAssertFalse(intent.typing)
    XCTAssertTrue(latch.receive(.ready, epoch: 3))
    XCTAssertTrue(latch.establishFreshContext(generation: latch.generation))
    XCTAssertFalse(intent.typing)
    XCTAssertNil(intent.takeTarget(on: surface, commandSeq: 7, now: 1400))
    // A genuinely new target after the fresh context is allowed; no target
    // submitted during the context-only stage was saved for later playback.
    let freshTarget = CallPresentationEvent.Rect(CGRect(x: 200, y: 200, width: 80, height: 40))
    XCTAssertTrue(latch.permitsContent(generation: latch.generation))
    intent.deferTarget(freshTarget, on: surface, commandSeq: 8, at: 1500)
    XCTAssertEqual(intent.takeTarget(on: surface, commandSeq: 8, now: 1850), freshTarget)
    intent.beginTyping()
    XCTAssertTrue(intent.typing)
  }

  func testInvalidEpochAndInitialReadyCreateNoAuthority() {
    var latch = CallPresentationTransitionLatch()
    XCTAssertFalse(latch.receive(.switching, epoch: -1))
    XCTAssertEqual(latch.highestEpoch, -1)
    XCTAssertFalse(latch.receive(.ready, epoch: 0))
    XCTAssertEqual(latch.mode, .content)
    XCTAssertFalse(latch.receive(.waiting, epoch: 0))
    XCTAssertTrue(latch.receive(.waiting, epoch: 1))
    XCTAssertEqual(latch.mode, .transition)
  }
}
