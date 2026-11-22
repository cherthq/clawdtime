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
    let valid = DesktopDirectionalRow(id: 4, pid: 10, frame: parent, title: "Fixture")
    for missing in [DesktopDirectionalRow(id: 1, pid: nil, frame: overlay, title: nil),
                    DesktopDirectionalRow(id: nil, pid: 20, frame: overlay, title: nil),
                    DesktopDirectionalRow(id: 1, pid: 20, frame: nil, title: nil)] {
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
}
