import XCTest
@testable import TaskPanelCore

/// Mute means that no sound of the room leaves the Mac. A sentence that the person began before mute ends with
/// what was written before it: no buffer goes into the recording that is sent while the microphone is off.
final class MicrophoneGateTests: XCTestCase {
  func testNoBufferGoesIntoTheRecordingWhileMuted() {
    var gate = MicrophoneGate()
    XCTAssertTrue(gate.admits(start: 1.00, seconds: 0.046))
    XCTAssertTrue(gate.admitsUntimed)
    gate.mute(at: 2.0)
    // Even a buffer heard just before mute and handed over after it stays out: nothing is written while muted.
    XCTAssertFalse(gate.admits(start: 1.90, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 1.98, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 2.10, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 30.0, seconds: 0.046))
    XCTAssertFalse(gate.admitsUntimed)
    gate.mute(at: 2.5)
    XCTAssertFalse(gate.admits(start: 2.60, seconds: 0.046))
  }

  func testAfterUnmuteOnlyBuffersHeardSinceThenGoIn() {
    var gate = MicrophoneGate()
    gate.mute(at: 2.0)
    gate.unmute(at: 3.0)
    // Heard while muted and handed over late: out.
    XCTAssertFalse(gate.admits(start: 2.50, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 2.97, seconds: 0.046))
    // Heard after unmute: in.
    XCTAssertTrue(gate.admits(start: 3.00, seconds: 0.046))
    XCTAssertTrue(gate.admits(start: 9.00, seconds: 0.046))
    XCTAssertTrue(gate.admitsUntimed)
    // Muted again.
    gate.mute(at: 10.0)
    XCTAssertFalse(gate.admits(start: 9.90, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 10.0, seconds: 0.046))
    // A second unmute starts from its own time.
    gate.unmute(at: 12.0)
    XCTAssertFalse(gate.admits(start: 11.0, seconds: 0.046))
    XCTAssertTrue(gate.admits(start: 12.0, seconds: 0.046))
    // An unmute with no mute before it changes nothing.
    gate.unmute(at: 20.0)
    XCTAssertTrue(gate.admits(start: 13.0, seconds: 0.046))
  }

  func testABufferWithATimeThatIsNoTimeStaysOut() {
    let gate = MicrophoneGate()
    XCTAssertFalse(gate.admits(start: .nan, seconds: 0.046))
    XCTAssertFalse(gate.admits(start: 1, seconds: .infinity))
    XCTAssertFalse(gate.admits(start: 1, seconds: -1))
  }
}
