import XCTest
@testable import TaskPanelCore

/// The panel's own preferences, as `clawdtime settings set` writes them with
/// `defaults`: a value that does not fit reads as the default.
final class PanelPreferencesTests: XCTestCase {
  func testTheVoiceRepliesAreOnUnlessTheyAreTurnedOff() {
    XCTAssertTrue(PanelPreferences.voiceReplies(nil))
    XCTAssertTrue(PanelPreferences.voiceReplies("off"))
    XCTAssertTrue(PanelPreferences.voiceReplies(true))
    XCTAssertFalse(PanelPreferences.voiceReplies(false))
    XCTAssertFalse(PanelPreferences.voiceReplies(NSNumber(value: false)))
  }

  func testTheSpeedOfTheVoiceStaysInItsRange() {
    XCTAssertEqual(PanelPreferences.voiceRate(nil), 1)
    XCTAssertEqual(PanelPreferences.voiceRate(1.25), 1.25)
    XCTAssertEqual(PanelPreferences.voiceRate(NSNumber(value: 0.75)), 0.75)
    XCTAssertEqual(PanelPreferences.voiceRate(9.0), 2)
    XCTAssertEqual(PanelPreferences.voiceRate(0.1), 0.5)
    XCTAssertEqual(PanelPreferences.voiceRate(Double.nan), 1)
    XCTAssertEqual(PanelPreferences.voiceRate("fast"), 1)
  }

  func testTheNoticeIsTheOneThatTheRuntimePosts() {
    // cli/settings.ts posts this name with notifyutil after each change.
    XCTAssertEqual(PanelPreferences.notice, "com.clawdtime.panel.settings")
    XCTAssertEqual(PanelPreferences.Key.voiceReplies, "voice.replies")
    XCTAssertEqual(PanelPreferences.Key.voiceRate, "voice.rate")
  }
}
