import XCTest
@testable import DeviceCore

final class TaskCaptureStreamPolicyTests: XCTestCase {
  func testRequiresNewCompleteBoundFrameAndNativeTime() {
    func admitted(_ complete: Bool = true, valid: Bool = true, timestamp: UInt64 = 120, width: Int = 800) -> Bool {
      TaskCaptureStreamPolicy.admits(complete: complete, valid: valid, frameHostTime: timestamp,
        requestHostTime: 100, callbackHostTime: 150, width: width, height: 600, expectedWidth: 800, expectedHeight: 600)
    }
    XCTAssertTrue(admitted())
    XCTAssertFalse(admitted(false)) // idle/started/blank do not renew a frame.
    XCTAssertFalse(admitted(valid: false))
    XCTAssertFalse(admitted(timestamp: 99))
    XCTAssertFalse(admitted(timestamp: 151))
    XCTAssertFalse(admitted(width: 799))
  }
  func testDelayedTimerCannotAdmitAnExpiredLifecycle() {
    XCTAssertTrue(TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: 1.249))
    XCTAssertFalse(TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: 1.25))
    XCTAssertFalse(TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: 1.6))
    XCTAssertFalse(TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: -.infinity))
    XCTAssertFalse(TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: .nan))
  }
  func testDeadlineAndCompletionAreExclusive() {
    let expired = TaskCaptureDeadline()
    XCTAssertTrue(expired.expire()); XCTAssertFalse(expired.finish()); XCTAssertFalse(expired.expire())
    let completed = TaskCaptureDeadline()
    XCTAssertTrue(completed.finish()); XCTAssertFalse(completed.expire()); XCTAssertFalse(completed.finish())
  }
  func testMailboxDropsLateFramesAndPendingWaiter() async throws {
    let value = TaskCaptureFrameMailbox<Int>()
    XCTAssertTrue(value.offer(.success(7))); XCTAssertFalse(value.offer(.success(8)))
    let first = try await value.value(); XCTAssertEqual(first, 7)
    value.invalidate(); XCTAssertFalse(value.offer(.success(9)))
    do { _ = try await value.value(); XCTFail("invalidated mailbox returned an old frame") } catch {}
    let pending = TaskCaptureFrameMailbox<Int>()
    let waiting = Task { try await pending.value() }
    await Task.yield(); pending.invalidate()
    do { _ = try await waiting.value; XCTFail("pending waiter survived invalidation") } catch {}
  }
  @MainActor func testSuccessReturnsOnlyAfterOneJoinedStop() async throws {
    var events = [String]()
    let value = try await TaskCaptureStreamAttempt.acquire(start: { events.append("start") },
      frame: { events.append("frame"); return 7 }, invalidate: {}, stop: { events.append("stop") })
    XCTAssertEqual(value, 7); XCTAssertEqual(events, ["start", "frame", "stop"])
  }
  @MainActor func testCancellationWaitsForLateStartThenStopsWithoutReadingFrame() async throws {
    let entered = TaskCaptureFrameMailbox<Void>(), startGate = TaskCaptureFrameMailbox<Void>()
    let frame = TaskCaptureFrameMailbox<Int>()
    var stops = 0, frameReads = 0, completed = false
    let operation = Task {
      defer { completed = true }
      return try await TaskCaptureStreamAttempt.acquire(start: {
        entered.offer(.success(())); _ = try await startGate.value()
      }, frame: { frameReads += 1; return try await frame.value() },
      invalidate: { frame.invalidate() }, stop: { stops += 1 })
    }
    _ = try await entered.value(); operation.cancel()
    try await Task.sleep(nanoseconds: 10_000_000)
    XCTAssertFalse(completed); XCTAssertEqual(stops, 0)
    startGate.offer(.success(()))
    do { _ = try await operation.value; XCTFail("cancelled start returned a frame") } catch {}
    XCTAssertEqual(stops, 1); XCTAssertEqual(frameReads, 0)
    XCTAssertFalse(frame.offer(.success(99)))
  }
  @MainActor func testFrameFailureStopsAndStopFailureIsNotRetried() async {
    var starts = 0, stops = 0
    do {
      let _: Int = try await TaskCaptureStreamAttempt.acquire(start: { starts += 1 },
        frame: { throw CancellationError() }, invalidate: {}, stop: { stops += 1 })
      XCTFail("failed frame succeeded")
    } catch {}
    XCTAssertEqual(starts, 1); XCTAssertEqual(stops, 1)
    stops = 0
    do {
      let _: Int = try await TaskCaptureStreamAttempt.acquire(start: {}, frame: { 7 }, invalidate: {}, stop: {
        stops += 1; throw CancellationError()
      })
      XCTFail("unconfirmed stop succeeded")
    } catch TaskCaptureStreamError.cleanupUnconfirmed {} catch { XCTFail("lost cleanup uncertainty") }
    XCTAssertEqual(stops, 1)
  }
  @MainActor func testAlreadyCancelledAttemptDoesNotStart() async {
    var starts = 0, stops = 0
    let operation = Task { () throws -> Int in
      try await TaskCaptureStreamAttempt.acquire(start: { starts += 1 }, frame: { 7 }, invalidate: {}, stop: { stops += 1 })
    }
    operation.cancel()
    do { _ = try await operation.value; XCTFail("cancelled attempt succeeded") } catch {}
    XCTAssertEqual(starts, 0); XCTAssertEqual(stops, 0)
  }
}
