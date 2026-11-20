import XCTest
@testable import DeviceCore

final class CaptureDrainTests: XCTestCase {
  @MainActor func testIdleCaptureCompletesImmediately() async throws {
    try await CaptureDrain.wait(timeout: .zero, busy: { false })
  }

  @MainActor func testRevokedLeaseDoesNotConfirmUntilNativeCaptureFinishes() async throws {
    var busy = true
    var confirmed = false
    let drain = Task { @MainActor in
      try await CaptureDrain.wait { busy }
      confirmed = true
    }
    await Task.yield()
    XCTAssertFalse(confirmed)
    busy = false
    try await drain.value
    XCTAssertTrue(confirmed)
  }

  @MainActor func testStalledCallbackRemainsUnconfirmed() async {
    do {
      try await CaptureDrain.wait(timeout: .milliseconds(15), busy: { true })
      XCTFail("An outstanding native callback is not confirmed cleanup")
    } catch CaptureDrainError.unconfirmed {
    } catch { XCTFail("Unexpected failure") }
  }

  @MainActor func testCancellationCannotConfirmCleanup() async {
    let drain = Task { @MainActor in try await CaptureDrain.wait { true } }
    drain.cancel()
    do {
      try await drain.value
      XCTFail("Canceled cleanup is unconfirmed")
    } catch is CancellationError {
    } catch { XCTFail("Unexpected failure") }
  }
}
