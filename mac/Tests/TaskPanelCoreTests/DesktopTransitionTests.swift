import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

final class DesktopTransitionTests: XCTestCase {
  struct Surface: Equatable {
    var app = 10
    var window = 20
    var rect = CGRect(x: 40, y: 50, width: 400, height: 300)
    var display = 1
    var scale = 2
  }
  func testReadinessRequiresRepeatedStableEvidenceOverTime() {
    var wait = DesktopSettlement<Surface>(at: 10)
    let surface = Surface()
    XCTAssertEqual(wait.sample(surface, at: 10), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 10.2), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 10.4), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 10.7), .ready)
  }
  func testMovementMissingEvidenceAndIdentityChangeResetSettlement() {
    var wait = DesktopSettlement<Surface>(at: 0)
    var surface = Surface()
    XCTAssertEqual(wait.sample(surface, at: 0), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 0.4), .waiting)
    surface.rect.origin.x += 1
    XCTAssertEqual(wait.sample(surface, at: 0.7), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 1.0), .waiting)
    XCTAssertEqual(wait.sample(nil, at: 1.2), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 1.3), .waiting)
    surface.window += 1
    XCTAssertEqual(wait.sample(surface, at: 1.6), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 1.9), .waiting)
    XCTAssertEqual(wait.sample(surface, at: 2.3), .ready)
  }
  func testWaitIsBoundedEvenIfEvidenceKeepsChanging() {
    var wait = DesktopSettlement<Int>(at: 0)
    for tick in 0..<10 { XCTAssertEqual(wait.sample(tick, at: Double(tick) / 2), .waiting) }
    XCTAssertEqual(wait.sample(9, at: 5), .expired)
    XCTAssertEqual(wait.sample(nil, at: 100), .expired)
    var invalid = DesktopSettlement<Int>(at: 0)
    XCTAssertEqual(invalid.sample(1, at: .nan), .expired)
    XCTAssertEqual(invalid.sample(1, at: -1), .expired)
  }
  func testOldCoordinatesCannotSurviveSpaceChangeEvenIfTargetLooksIdentical() {
    var lease = DesktopObservationLease<Surface>()
    let surface = Surface()
    XCTAssertFalse(lease.permits(surface, at: 0))
    lease.record(surface, at: 1)
    XCTAssertTrue(lease.permits(surface, at: 1.9))
    let original = lease.epoch
    lease.invalidate() // activeSpaceDidChange notification, display change, Stop, or activation
    XCTAssertGreaterThan(lease.epoch, original)
    XCTAssertFalse(lease.permits(surface, at: 1.9))
    lease.record(surface, at: 2)
    XCTAssertTrue(lease.permits(surface, at: 2.1))
  }
  func testFocusClickConsumesFreshnessWithoutChangingTheSurfaceEpoch() {
    var lease = DesktopObservationLease<Surface>()
    let surface = Surface()
    lease.record(surface, at: 10)
    let epoch = lease.epoch
    lease.consume()
    XCTAssertFalse(lease.permits(surface, at: 10.1))
    XCTAssertEqual(lease.epoch, epoch)
    lease.record(surface, at: 10.2)
    XCTAssertEqual(lease.epoch, epoch)
    XCTAssertTrue(lease.permits(surface, at: 10.3))
    lease.invalidate()
    lease.record(surface, at: 10.4)
    XCTAssertNotEqual(lease.epoch, epoch)
  }
  func testGeometryDisplayScaleWindowAndAppMustMatchLastObservation() {
    let original = Surface()
    var lease = DesktopObservationLease<Surface>()
    lease.record(original, at: 10)
    var variants = [Surface]()
    var changed = original; changed.app += 1; variants.append(changed)
    changed = original; changed.window += 1; variants.append(changed)
    changed = original; changed.display += 1; variants.append(changed)
    changed = original; changed.scale += 1; variants.append(changed)
    changed = original; changed.rect.origin.x += 1; variants.append(changed)
    changed = original; changed.rect.size.width += 1; variants.append(changed)
    for value in variants { XCTAssertFalse(lease.permits(value, at: 11)) }
    XCTAssertFalse(lease.permits(nil, at: 11))
    XCTAssertFalse(lease.permits(original, at: 12.001))
    XCTAssertFalse(lease.permits(original, at: 9))
    XCTAssertFalse(lease.permits(original, at: .nan))
    XCTAssertTrue(lease.permits(original, at: 12))
    let epoch = lease.epoch
    lease.record(variants[0], at: 12)
    XCTAssertGreaterThan(lease.epoch, epoch)
  }
  func testStopFailureAndPermissionLossAfterDispatchRemainUnknown() {
    for error in HandError.allCases {
      XCTAssertEqual(DesktopEffectOutcome.failure(error, dispatched: false), error)
      XCTAssertEqual(DesktopEffectOutcome.failure(error, dispatched: true), .transitionUnknown)
    }
  }
  func testTakeoverPausesBeforeInputAndPartialInputCannotReplay() {
    XCTAssertEqual(DesktopInputOutcome.failure(.stoppedByPerson, submitted: false, interrupted: true), .stoppedByPerson)
    XCTAssertEqual(DesktopInputOutcome.failure(.refused, submitted: false, interrupted: true), .refused)
    XCTAssertEqual(DesktopInputOutcome.failure(.stoppedByPerson, submitted: false, interrupted: false), .stoppedByPerson)
    XCTAssertEqual(DesktopInputOutcome.failure(.staleObservation, submitted: false, interrupted: false), .staleObservation)
    for error in HandError.allCases {
      XCTAssertEqual(DesktopInputOutcome.failure(error, submitted: true, interrupted: false), error == .transitionUnknown ? .transitionUnknown : .inputUnknown)
      XCTAssertEqual(DesktopInputOutcome.failure(error, submitted: true, interrupted: true), error == .transitionUnknown ? .transitionUnknown : .inputUnknown)
    }
  }
  func testWindowSelectorIsExactAndBounded() throws {
    for title in ["", "   ", "one\ntwo", "one\u{0000}two", String(repeating: "a", count: 201)] {
      XCTAssertNil(HandsTarget.windowTitle(title))
      let json = try JSONSerialization.data(withJSONObject: ["kind": "open_app", "name": "TextEdit", "window": title])
      XCTAssertThrowsError(try JSONDecoder().decode(HandCommand.self, from: json))
    }
    XCTAssertEqual(HandsTarget.windowTitle("  exact title  "), "  exact title  ")
    XCTAssertNotNil(HandsTarget.windowTitle(String(repeating: "a", count: 200)))
  }
  func testDuplicateApplicationNamesNeverSelectTheFirstBundle() throws {
    let one = DesktopAppCandidate(path: "/fixture/A.app", names: ["Fixture", "Localized"])
    let two = DesktopAppCandidate(path: "/fixture/B.app", names: ["Fixture"])
    XCTAssertEqual(try DesktopAppSelection.path(named: "fixture", candidates: [one, one]).get(), one.path)
    XCTAssertEqual(try DesktopAppSelection.path(named: "Localized", candidates: [one, two]).get(), one.path)
    XCTAssertThrowsError(try DesktopAppSelection.path(named: "Fixture", candidates: [one, two]).get()) { error in
      XCTAssertEqual(error as? HandError, .ambiguousTarget)
    }
    XCTAssertThrowsError(try DesktopAppSelection.path(named: "Absent", candidates: [one, two]).get()) { error in
      XCTAssertEqual(error as? HandError, .notFound)
    }
  }
  func testEpochRoundTripsWithoutChangingLegacyObservation() throws {
    let observation = Observation(at: 100, screen: .init(width: 100, height: 80, scale: 2), cursor: .init(x: 0, y: 0),
      app: .init(name: "Fixture", bundleId: "test.fixture", window: "Disposable"), elements: [], surfaceEpoch: 9)
    let encoded = try JSONEncoder().encode(observation)
    XCTAssertEqual(try JSONDecoder().decode(Observation.self, from: encoded), observation)
    try observation.validate()
    let invalid = Observation(at: 100, screen: observation.screen, cursor: observation.cursor, app: observation.app, elements: [], surfaceEpoch: -1)
    XCTAssertThrowsError(try invalid.validate())
  }
}
