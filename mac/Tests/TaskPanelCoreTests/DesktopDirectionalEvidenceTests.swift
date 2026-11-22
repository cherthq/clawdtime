import Foundation
import XCTest
@testable import TaskPanelCore

final class DesktopDirectionalEvidenceTests: XCTestCase {
  let display = CGRect(x: 0, y: 0, width: 1600, height: 1000)
  let parent = CGRect(x: 0, y: 40, width: 1600, height: 960)
  let strip = CGRect(x: 0, y: 40, width: 1600, height: 48)
  let overlay = CGRect(x: 1400, y: 300, width: 250, height: 280)
  func row(_ id: Int, pid: Int = 10, title: String? = nil, frame: CGRect) -> DesktopWindowEvidence {
    .init(id: id, pid: pid, title: title, frame: frame)
  }
  var rows: [DesktopWindowEvidence] { [row(1, frame: strip), row(2, frame: overlay), row(3, frame: overlay), row(4, title: "Fixture", frame: parent)] }
  func group(_ rows: [DesktopWindowEvidence], confirmed: Bool = true) -> DesktopDirectionalGroup? {
    DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: parent, display: display, fullScreenConfirmed: confirmed, visible: rows)
  }
  func testKeepsCompleteOrderedUnclippedOverlayGeometryForDirectionalEvidenceOnly() throws {
    let value = try XCTUnwrap(group(rows))
    XCTAssertEqual(value.parentID, 4)
    XCTAssertEqual(value.overlays.map(\.id), [1, 2, 3])
    XCTAssertEqual(value.overlays[1].frame, overlay)
    XCTAssertGreaterThan(value.overlays[1].frame.maxX, display.maxX)
    XCTAssertNil(DesktopWindowVisibility.focusedWindowID(pid: 10, title: "Fixture", frame: parent,
      fullScreenConfirmed: true, display: display, visible: rows, accessibleFrames: [parent]))
  }
  func testForeignLeadingRowAndDuplicateIDsOrParentRemainAmbiguous() {
    var foreign = rows; foreign[1] = row(2, pid: 20, frame: overlay)
    XCTAssertNil(group(foreign))
    var duplicate = rows; duplicate[1] = row(1, frame: overlay)
    XCTAssertNil(group(duplicate))
    XCTAssertNil(group(rows + [row(5, title: "Fixture", frame: parent)]))
    XCTAssertNil(group(rows, confirmed: false))
  }
  func testIncompleteUnpositionedRowsCannotBeDroppedFromInventory() {
    let valid = DesktopDirectionalRow(id: 4, pid: 10, frame: parent, title: "Fixture", alpha: 1)
    for missing in [DesktopDirectionalRow(id: 1, pid: nil, frame: overlay, title: nil, alpha: 1),
                    DesktopDirectionalRow(id: nil, pid: 20, frame: overlay, title: nil, alpha: 1),
                    DesktopDirectionalRow(id: 1, pid: 20, frame: nil, title: nil, alpha: 1)] {
      XCTAssertNil(DesktopDirectionalEvidence.inventory([missing, valid]))
    }
    XCTAssertNil(DesktopDirectionalEvidence.inventory([valid, valid]))
  }
  func testNonFiniteOffDisplayAndLargeOverlaysRefuseInsteadOfClipping() {
    for frame in [CGRect(x: 0, y: 0, width: Double.infinity, height: 20),
                  CGRect(x: 2000, y: 0, width: 40, height: 40),
                  CGRect(x: 0, y: 40, width: 1601, height: 20), parent, .zero] {
      XCTAssertNil(group([row(1, frame: frame), row(4, title: "Fixture", frame: parent)]))
    }
    let tooMany = (1...9).map { row($0, frame: overlay) } + [row(10, title: "Fixture", frame: parent)]
    XCTAssertNil(group(tooMany))
  }
  func testOverlayOnlyChangesNeverCountAsChangedParent() throws {
    let before = try XCTUnwrap(group(rows))
    var changed = rows; changed[1] = row(2, frame: overlay.offsetBy(dx: -20, dy: 0))
    let after = try XCTUnwrap(group(changed))
    XCTAssertNotEqual(before, after)
    XCTAssertFalse(DesktopDirectionalEvidence.changedParent(fromPID: 10, fromWindow: before.parentID, toPID: 10, toWindow: after.parentID))
    XCTAssertTrue(DesktopDirectionalEvidence.changedParent(fromPID: 10, fromWindow: 4, toPID: 10, toWindow: 8))
  }
  func testKnownNoMovementKeepsExactCompositeOriginForWholeWait() throws {
    let origin = try XCTUnwrap(group(rows))
    var settlement = DesktopSwitchSettlement(origin: origin, at: 0)
    XCTAssertEqual(settlement.sample(origin, spaceChanges: 0, epoch: 1, at: 0), .waiting)
    XCTAssertEqual(settlement.sample(origin, spaceChanges: 0, epoch: 1, at: 2), .waiting)
    XCTAssertEqual(settlement.sample(origin, spaceChanges: 0, epoch: 1, at: 5), .expired)
    XCTAssertTrue(settlement.notMoved)
  }
  func testMissingOrMultipleSpaceEventsCannotSettleAChangedComposition() throws {
    let origin = try XCTUnwrap(group(rows))
    var changed = rows; changed[3] = row(5, title: "Fixture", frame: parent)
    let arrival = try XCTUnwrap(group(changed))
    for changes in [0, 2] {
      var settlement = DesktopSwitchSettlement(origin: origin, at: 0)
      for time in [0.0, 0.4, 0.8] { XCTAssertEqual(settlement.sample(arrival, spaceChanges: changes, epoch: 2, at: time), .waiting) }
    }
    var settlement = DesktopSwitchSettlement(origin: origin, at: 0)
    XCTAssertEqual(settlement.sample(arrival, spaceChanges: 1, epoch: 2, at: 0), .waiting)
    XCTAssertEqual(settlement.sample(arrival, spaceChanges: 1, epoch: 2, at: 0.4), .waiting)
    XCTAssertEqual(settlement.sample(arrival, spaceChanges: 1, epoch: 2, at: 0.8), .ready)
  }
  func testCaptureBracketRejectsEveryIdentityGenerationAndEnvironmentRace() throws {
    let expected = try XCTUnwrap(group(rows))
    func matches(_ observed: DesktopDirectionalGroup?, epoch: Int = 2, spaces: Int = 1, environment: Int = 0, displays: Int = 1) -> Bool {
      DesktopDirectionalEvidence.captureMatches(expected: expected, observed: observed, expectedEpoch: 2, observedEpoch: epoch,
        spaceChanges: spaces, environmentChanges: environment, activeDisplays: displays)
    }
    XCTAssertTrue(matches(expected))
    XCTAssertFalse(matches(nil)); XCTAssertFalse(matches(expected, epoch: 3))
    XCTAssertFalse(matches(expected, spaces: 0)); XCTAssertFalse(matches(expected, spaces: 2))
    XCTAssertFalse(matches(expected, environment: 1)); XCTAssertFalse(matches(expected, displays: 2))
    var changed = rows; changed.swapAt(1, 2)
    XCTAssertFalse(matches(group(changed)))
  }
  func testDiagnosticIdentifiesMatchedButTooInsetFullscreenParentWithoutRelaxingIt() {
    let inset = CGRect(x: 0, y: 120, width: 1600, height: 880)
    var reason = "", counts: [String: Int] = [:]
    let result = DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: inset, display: display,
      fullScreenConfirmed: true, visible: [row(1, frame: strip), row(2, title: "Fixture", frame: inset)],
      diagnostic: { reason = $0 }, count: { counts[$0] = $1 })
    XCTAssertNil(result)
    XCTAssertEqual(reason, "directional_parent_geometry")
    XCTAssertEqual(counts, ["directionalParentMatches": 1, "directionalLeadingRows": 1])
  }
  func testJointMatchDiagnosticDoesNotConflateIndependentTitleAndFrameMatches() {
    var reason = "", counts: [String: Int] = [:]
    let result = DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: parent, display: display,
      fullScreenConfirmed: true, visible: [row(1, title: "Different", frame: parent), row(2, title: "Fixture", frame: overlay)],
      diagnostic: { reason = $0 }, count: { counts[$0] = $1 })
    XCTAssertNil(result)
    XCTAssertEqual(reason, "directional_parent_match_missing")
    XCTAssertEqual(counts, ["directionalParentMatches": 0])
  }
  func testDirectionalFullscreenContentWithContiguousToolbarRowsKeepsEveryRow() throws {
    let content = CGRect(x: 0, y: 120, width: 1600, height: 880)
    let chrome = [row(1, frame: CGRect(x: 0, y: 40, width: 1600, height: 40)),
                  row(2, frame: CGRect(x: 0, y: 80, width: 1600, height: 40)),
                  row(3, frame: CGRect(x: 0, y: 40, width: 1600, height: 140))]
    let visible = chrome + [row(4, title: "Fixture", frame: content)]
    let matched = try XCTUnwrap(DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: content,
      display: display, fullScreenConfirmed: true, visible: visible))
    XCTAssertTrue(matched.usesToolbarCoverage)
    XCTAssertEqual(matched.overlays.map(\.id), [1, 2, 3])
    XCTAssertEqual(matched.overlays.map(\.frame), chrome.map(\.frame))
    XCTAssertFalse(DesktopSurfaceScope.fullScreenGeometry(window: content, display: display))
    XCTAssertNil(DesktopWindowVisibility.focusedWindowID(pid: 10, title: "Fixture", frame: content,
      fullScreenConfirmed: true, display: display, visible: visible, accessibleFrames: [content]))
  }
  func testToolbarCoverageCannotBridgeGapsOrUseForeignOversizedOrNarrowRows() {
    let content = CGRect(x: 0, y: 120, width: 1600, height: 880)
    let upper = row(1, frame: CGRect(x: 0, y: 40, width: 1600, height: 40))
    let lower = row(2, frame: CGRect(x: 0, y: 80, width: 1600, height: 40))
    let invalid: [[DesktopWindowEvidence]] = [
      [upper, row(2, frame: CGRect(x: 0, y: 90, width: 1600, height: 30))],
      [upper, row(2, pid: 20, frame: lower.frame)],
      [row(1, frame: CGRect(x: 0, y: 40, width: 1600, height: 100))],
      [upper, row(2, frame: CGRect(x: 20, y: 80, width: 1580, height: 40))],
      [row(1, frame: CGRect(x: 0, y: 81, width: 1600, height: 39))],
    ]
    for chrome in invalid {
      XCTAssertNil(DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: content, display: display,
        fullScreenConfirmed: true, visible: chrome + [row(4, title: "Fixture", frame: content)]))
    }
    XCTAssertNil(DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: content, display: display,
      fullScreenConfirmed: false, visible: [upper, lower, row(4, title: "Fixture", frame: content)]))
  }
  func testToolbarCoverageStillRequiresLargeBottomAnchoredFullWidthParent() {
    for content in [CGRect(x: 0, y: 120, width: 1600, height: 850),
                    CGRect(x: 20, y: 120, width: 1580, height: 880),
                    CGRect(x: 0, y: 200, width: 1600, height: 800)] {
      let chrome = [row(1, frame: CGRect(x: 0, y: 40, width: 1600, height: 80)),
                    row(2, frame: CGRect(x: 0, y: 120, width: 1600, height: 80))]
      XCTAssertNil(DesktopDirectionalEvidence.group(pid: 10, title: "Fixture", parent: content, display: display,
        fullScreenConfirmed: true, visible: chrome + [row(4, title: "Fixture", frame: content)]))
    }
  }
  func testMissingTransparentOrInvalidAlphaRejectsEntireDirectionalInventory() {
    let valid = DesktopDirectionalRow(id: 4, pid: 10, frame: parent, title: "Fixture", alpha: 1)
    for alpha: Double? in [nil, 0, -.infinity, .infinity, .nan, -0.1, 1.1] {
      let bad = DesktopDirectionalRow(id: 1, pid: 10, frame: strip, title: nil, alpha: alpha)
      XCTAssertNil(DesktopDirectionalEvidence.inventory([bad, valid]))
      let badParent = DesktopDirectionalRow(id: 4, pid: 10, frame: parent, title: "Fixture", alpha: alpha)
      XCTAssertNil(DesktopDirectionalEvidence.inventory([badParent]))
    }
    let translucent = DesktopDirectionalRow(id: 1, pid: 10, frame: strip, title: nil, alpha: 0.5)
    XCTAssertEqual(DesktopDirectionalEvidence.inventory([translucent, valid])?.count, 2)
  }
}
