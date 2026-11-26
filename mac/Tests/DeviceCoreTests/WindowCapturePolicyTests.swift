import XCTest
@testable import DeviceCore

final class WindowCapturePolicyTests: XCTestCase {
  let frame = CGRect(x: 130, y: 277, width: 920, height: 436)
  func permits(onScreen: Bool = false, active: Bool = false, hidden: Bool = false,
    witnesses: [WindowLifecycleWitness] = []) -> Bool {
    WindowCapturePolicy.available(frame: frame, onScreen: onScreen, active: active, appHidden: hidden, witnesses: witnesses)
  }
  func testOffscreenSelectedWindowRemainsBoundToInitialDisplayAnchor() {
    let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let outside = CGRect(x: -837, y: 229, width: 920, height: 436)
    XCTAssertFalse(WindowCapturePolicy.placementAllowed(frame: outside, selectedDisplay: display, otherDisplays: [], initial: true))
    XCTAssertTrue(WindowCapturePolicy.placementAllowed(frame: outside, selectedDisplay: display, otherDisplays: [], initial: false))
    XCTAssertFalse(WindowCapturePolicy.placementAllowed(frame: outside, selectedDisplay: display,
      otherDisplays: [CGRect(x: -1512, y: 0, width: 1512, height: 982)], initial: false))
    XCTAssertTrue(WindowCapturePolicy.placementAllowed(frame: frame, selectedDisplay: display, otherDisplays: [], initial: true))
  }
  func testVisibleAndActivelyStreamingWindowsDoNotNeedAXPermission() {
    XCTAssertTrue(permits(onScreen: true)); XCTAssertTrue(permits(active: true))
    XCTAssertFalse(permits(onScreen: true, hidden: true))
  }
  func testOffSpaceWindowRequiresUniqueNonMinimizedGeometryWitness() {
    let valid = WindowLifecycleWitness(frame: frame, minimized: false)
    XCTAssertTrue(permits(witnesses: [valid]))
    XCTAssertFalse(permits(witnesses: [valid, valid]))
    XCTAssertFalse(WindowCapturePolicy.available(frame: frame, onScreen: false, active: false, appHidden: false,
      witnesses: [valid], matchingCaptureWindows: 2))
    XCTAssertFalse(permits(witnesses: []))
    XCTAssertFalse(permits(witnesses: [.init(frame: frame, minimized: true)]))
    XCTAssertFalse(permits(witnesses: [.init(frame: frame, minimized: nil)]))
    XCTAssertFalse(permits(witnesses: [.init(frame: frame.offsetBy(dx: 1, dy: 0), minimized: false)]))
  }
}
