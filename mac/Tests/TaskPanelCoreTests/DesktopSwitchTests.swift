import CoreGraphics
import XCTest
@testable import TaskPanelCore

final class DesktopSwitchTests: XCTestCase {
  func testConfiguredShortcutsRequireBothExplicitDistinctEnabledBindings() throws {
    let left = try XCTUnwrap(KeyCombo.parse("ctrl+left")), right = try XCTUnwrap(KeyCombo.parse("ctrl+right"))
    let enabled = [DesktopHotKey(code: 123, carbonModifiers: 4096), DesktopHotKey(code: 124, carbonModifiers: 4096)]
    func pair(_ l: KeyCombo? = left, _ r: KeyCombo? = right, leftCode: UInt16? = 123, rightCode: UInt16? = 124,
              inventory: [DesktopHotKey]? = enabled) -> DesktopShortcutPair? {
      DesktopShortcutConfiguration.validate(left: l, right: r, leftCode: leftCode, rightCode: rightCode, enabled: inventory)
    }
    let configured = try XCTUnwrap(pair())
    XCTAssertEqual(configured.shortcut(for: .left), .init(code: 123, flags: KeyCombo.control))
    XCTAssertEqual(configured.shortcut(for: .right), .init(code: 124, flags: KeyCombo.control))
    XCTAssertNil(configured.shortcut(for: .previous)) // history must resolve it first
    XCTAssertNil(pair(nil, right)); XCTAssertNil(pair(left, nil))
    XCTAssertNil(pair(leftCode: nil)); XCTAssertNil(pair(rightCode: nil))
    XCTAssertNil(pair(inventory: nil)); XCTAssertNil(pair(inventory: []))
    XCTAssertNil(pair(inventory: [enabled[0]]))
    XCTAssertNil(pair(left, left, rightCode: 123))
    XCTAssertNil(pair(left, right, inventory: [.init(code: 123, carbonModifiers: 512), enabled[1]]))
    XCTAssertNil(pair(KeyCombo.parse("fn+left"), right))
  }
  func testCustomBindingsUseResolvedLayoutAndExactModifiers() throws {
    let left = try XCTUnwrap(KeyCombo.parse("cmd+alt+x")), right = try XCTUnwrap(KeyCombo.parse("cmd+alt+y"))
    let enabled = [DesktopHotKey(code: 42, carbonModifiers: 2304), DesktopHotKey(code: 43, carbonModifiers: 2304)]
    XCTAssertNotNil(DesktopShortcutConfiguration.validate(left: left, right: right, leftCode: 42, rightCode: 43, enabled: enabled))
    XCTAssertNil(DesktopShortcutConfiguration.validate(left: left, right: right, leftCode: left.keyCode, rightCode: right.keyCode, enabled: enabled))
    XCTAssertFalse(DesktopShortcutConfiguration.isEnabled(.init(code: 42, flags: left.flags), in: [.init(code: 42, carbonModifiers: UInt64(2304 | 65536))]))
  }
  func testPreviousIsOnlyInverseOfLastVerifiedMoveFromItsVerifiedDestination() {
    var history = DesktopSwitchHistory<String>()
    XCTAssertNil(history.previous(from: "B"))
    history.verified(.right, from: "A", to: "B")
    XCTAssertEqual(history.previous(from: "B")?.direction, .left)
    XCTAssertEqual(history.previous(from: "B")?.target, "A")
    XCTAssertNil(history.previous(from: "C"))
    history.verified(.left, from: "B", to: "A")
    XCTAssertEqual(history.previous(from: "A")?.direction, .right)
    XCTAssertEqual(history.previous(from: "A")?.target, "B")
    history.invalidate() // external Space, display/session changes, Stop, unknown
    XCTAssertNil(history.previous(from: "A"))
    history.verified(.right, from: "A", to: "A")
    XCTAssertNil(history.previous(from: "A"))
    history.verified(.previous, from: "A", to: "B")
    XCTAssertNil(history.previous(from: "B"))
  }
  func testSwitchRequiresOneSpaceNotificationAndAChangedStableSurface() {
    for changes in [0, 2] {
      var settling = DesktopSwitchSettlement(origin: "A", at: 0)
      for at in [0.0, 0.3, 0.7, 1.0] {
        XCTAssertEqual(settling.sample("B", spaceChanges: changes, epoch: 1, at: at), .waiting)
      }
      XCTAssertEqual(settling.sample("B", spaceChanges: changes, epoch: 1, at: 5), .expired)
    }
    var unchanged = DesktopSwitchSettlement(origin: "Pinned", at: 0)
    XCTAssertEqual(unchanged.sample("Pinned", spaceChanges: 1, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(unchanged.sample("Pinned", spaceChanges: 1, epoch: 1, at: 1), .waiting)
    XCTAssertEqual(unchanged.sample("Pinned", spaceChanges: 1, epoch: 1, at: 5), .expired)
    var verified = DesktopSwitchSettlement(origin: "A", at: 0)
    XCTAssertEqual(verified.sample("B", spaceChanges: 1, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(verified.sample("B", spaceChanges: 1, epoch: 1, at: 0.3), .waiting)
    XCTAssertEqual(verified.sample("B", spaceChanges: 1, epoch: 1, at: 0.7), .ready)
  }
  func testPreviousVerifiesPriorSurfaceAndEpochChangeResetsSettlement() {
    var settling = DesktopSwitchSettlement(origin: "B", expected: "A", at: 0)
    XCTAssertEqual(settling.sample("C", spaceChanges: 1, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(settling.sample("C", spaceChanges: 1, epoch: 1, at: 0.7), .waiting)
    XCTAssertEqual(settling.sample("A", spaceChanges: 1, epoch: 1, at: 1), .waiting)
    XCTAssertEqual(settling.sample("A", spaceChanges: 1, epoch: 1, at: 1.3), .waiting)
    XCTAssertEqual(settling.sample("A", spaceChanges: 1, epoch: 2, at: 1.7), .waiting)
    XCTAssertEqual(settling.sample("A", spaceChanges: 1, epoch: 2, at: 2), .waiting)
    XCTAssertEqual(settling.sample("A", spaceChanges: 1, epoch: 2, at: 2.4), .ready)
  }
  func testNoDestinationWitnessExpiresAndUnknownNeverBecomesAnInputRefusal() {
    var settling = DesktopSwitchSettlement(origin: "A", at: 0)
    XCTAssertEqual(settling.sample(nil, spaceChanges: 1, epoch: 2, at: 1), .waiting)
    XCTAssertEqual(settling.sample(nil, spaceChanges: 1, epoch: 2, at: 5), .expired)
    XCTAssertEqual(DesktopEffectOutcome.failure(.stoppedByPerson, dispatched: true), .transitionUnknown)
    XCTAssertEqual(DesktopInputOutcome.failure(.transitionUnknown, submitted: true, interrupted: true), .transitionUnknown)
    XCTAssertEqual(DesktopEffectOutcome.failure(.desktopShortcutUnavailable, dispatched: false), .desktopShortcutUnavailable)
  }
  func testInvalidPostDispatchResultPreservesUnknownInsteadOfClaimingNoEffect() {
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .switchDesktop(direction: .left), submitted: true), .transitionUnknown)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .openApp(name: "Fixture"), submitted: false), .transitionUnknown)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .type(text: "fixture"), submitted: true), .inputUnknown)
    XCTAssertEqual(DesktopInputOutcome.invalidResult(command: .observe(image: true, elements: true), submitted: false), .failed)
  }
  func testTransitionRestrictionsDoNotLeakIntoGenericInputScope() {
    let display = CGRect(x: 0, y: 0, width: 1000, height: 700)
    let cases: [(CGRect, Bool, Bool, Int)] = [
      (display, true, true, 1), // visible full-screen window
      (CGRect(x: 20, y: 30, width: 500, height: 400), true, false, 2),
      (CGRect(x: -20, y: 30, width: 500, height: 400), true, false, 1),
      (CGRect(x: 20, y: 30, width: 500, height: 400), false, false, 1), // visible dialog
    ]
    for (window, ordinary, fullScreen, count) in cases {
      XCTAssertTrue(DesktopSurfaceScope.permits(window: window, display: display, ordinary: ordinary, fullScreen: fullScreen, activeDisplays: count, transition: false))
      XCTAssertFalse(DesktopSurfaceScope.permits(window: window, display: display, ordinary: ordinary, fullScreen: fullScreen, activeDisplays: count, transition: true))
    }
    XCTAssertFalse(DesktopSurfaceScope.permits(window: CGRect(x: 1200, y: 0, width: 200, height: 100), display: display,
      ordinary: true, fullScreen: false, activeDisplays: 2, transition: false))
    XCTAssertTrue(DesktopSurfaceScope.permits(window: CGRect(x: 20, y: 30, width: 500, height: 400), display: display,
      ordinary: true, fullScreen: false, activeDisplays: 1, transition: true))
  }
}
