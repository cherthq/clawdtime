import XCTest
import DeviceCore
@testable import ClawdTimeCompanion

/// The packaged companion is a release build. Modes that read the pixels of any
/// window or act on one without an armed share exist only in a debug build.
final class CompanionModesTests: XCTestCase {
  func testReleaseBuildRefusesModesThatCaptureOrActOnAnyWindow() {
    for mode in ["--camera-frame", "--camera-stream", "--preview-native-executor"] {
      let refusal = CompanionModes.refusal(["helper", mode, "--surface", "{}"], developmentBuild: false)
      XCTAssertEqual(refusal?.status, 400, mode)
    }
    XCTAssertFalse(CompanionModes.camera(developmentBuild: false).contains("--camera-frame"))
    XCTAssertFalse(CompanionModes.camera(developmentBuild: false).contains("--camera-stream"))
  }
  func testReleaseBuildKeepsMetadataModesAndTheInstalledExecutor() {
    for mode in ["--camera-list", "--camera-check", "--camera-local-status", "--installed-native-executor"] {
      XCTAssertNil(CompanionModes.refusal(["helper", mode], developmentBuild: false), mode)
    }
    XCTAssertTrue(CompanionModes.camera(developmentBuild: false).contains("--camera-check"))
  }
  func testDebugBuildKeepsTheDevelopmentModes() {
    XCTAssertTrue(CompanionModes.developmentBuild)
    XCTAssertNil(CompanionModes.refusal(["helper", "--camera-frame"], developmentBuild: true))
    XCTAssertTrue(CompanionModes.camera(developmentBuild: true).contains("--camera-stream"))
  }
}
