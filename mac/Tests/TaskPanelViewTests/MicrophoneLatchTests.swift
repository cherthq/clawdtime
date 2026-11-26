import AVFoundation
import XCTest
@testable import ClawdTimeTaskPanel

/// The latch that the audio thread asks for each buffer of the microphone. No microphone is used here: the buffers
/// are only times of the host clock.
final class MicrophoneLatchTests: XCTestCase {
  private func stamp(_ secondsFromNow: Double) -> AVAudioTime {
    AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: AVAudioTime.seconds(forHostTime: mach_absolute_time()) + secondsFromNow))
  }

  func testMuteKeepsEveryBufferOutOfTheRecordingAndUnmuteLetsOnlyNewOnesIn() {
    let latch = MicrophoneLatch()
    XCTAssertTrue(latch.admits(stamp(-0.05), seconds: 0.046))
    latch.set(on: false)
    XCTAssertFalse(latch.admits(stamp(-0.05), seconds: 0.046))
    XCTAssertFalse(latch.admits(stamp(0), seconds: 0.046))
    XCTAssertFalse(latch.admits(AVAudioTime(sampleTime: 0, atRate: 48_000), seconds: 0.046))
    latch.set(on: true)
    // Heard while muted, handed over after unmute: out.
    XCTAssertFalse(latch.admits(stamp(-0.5), seconds: 0.046))
    XCTAssertTrue(latch.admits(stamp(0.01), seconds: 0.046))
    // A buffer with no host time goes only while the microphone is on.
    XCTAssertTrue(latch.admits(AVAudioTime(sampleTime: 0, atRate: 48_000), seconds: 0.046))
  }
}
