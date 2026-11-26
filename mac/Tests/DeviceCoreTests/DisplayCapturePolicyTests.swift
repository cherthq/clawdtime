import XCTest
@testable import DeviceCore

final class DisplayCapturePolicyTests: XCTestCase {
  func testRetinaCaptureUsesModeBackingPixelsRatherThanLogicalDisplaySize() {
    let logical = CGRect(x: 0, y: 0, width: 1512, height: 982)
    XCTAssertTrue(DisplayCapturePolicy.unchanged(expectedBounds: logical, capturedWidth: 3024, capturedHeight: 1964,
      currentBounds: logical, modePixelWidth: 3024, modePixelHeight: 1964))
    XCTAssertFalse(DisplayCapturePolicy.unchanged(expectedBounds: logical, capturedWidth: 3024, capturedHeight: 1964,
      currentBounds: logical, modePixelWidth: 1512, modePixelHeight: 982))
  }
  func testDisplayModePlacementAndMissingModeRemainFailClosed() {
    let bounds = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
    XCTAssertTrue(DisplayCapturePolicy.unchanged(expectedBounds: bounds, capturedWidth: 1920, capturedHeight: 1080,
      currentBounds: bounds, modePixelWidth: 1920, modePixelHeight: 1080))
    for (current, width, height) in [(bounds.offsetBy(dx: 1, dy: 0), 1920, 1080), (bounds, 2560, 1440), (bounds, 0, 0)] {
      XCTAssertFalse(DisplayCapturePolicy.unchanged(expectedBounds: bounds, capturedWidth: 1920, capturedHeight: 1080,
        currentBounds: current, modePixelWidth: width, modePixelHeight: height))
    }
    XCTAssertFalse(DisplayCapturePolicy.unchanged(expectedBounds: bounds, capturedWidth: 1920, capturedHeight: 1080,
      currentBounds: bounds, modePixelWidth: nil, modePixelHeight: nil))
  }
}
