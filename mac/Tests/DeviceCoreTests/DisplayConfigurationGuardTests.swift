import XCTest
@testable import DeviceCore

final class DisplayConfigurationGuardTests: XCTestCase {
  func entry(_ id: UInt32 = 1, main: Bool = true) -> DisplayConfigurationEntry {
    .init(id: id, active: true, main: main, x: 0, y: 0, width: 1512, height: 982,
      modeID: 54, modeFlags: 33554439, modeWidth: 1512, modeHeight: 982,
      pixelWidth: 3024, pixelHeight: 1964, refreshRate: 120, rotation: 0,
      mirrorOf: 0, inMirrorSet: false, backingScale: 2)
  }
  func signature(_ entries: [DisplayConfigurationEntry]? = nil) -> DisplayConfigurationSignature? {
    let entries = entries ?? [entry()]
    return DisplayConfigurationSignature(activeIDs: entries.filter(\.active).map(\.id), displays: entries)
  }
  func testStableDuplicateNotificationDoesNotRequestStop() {
    let guardrail = DisplayConfigurationGuard(), first = signature()
    XCTAssertEqual(guardrail.observe(first: first, second: first), .changed)
    for _ in 0..<20 { XCTAssertEqual(guardrail.observe(first: first, second: first), .unchanged) }
  }
  func testDisplayEnumerationOrderDoesNotInventTopologyChanges() {
    let guardrail = DisplayConfigurationGuard()
    let first = signature([entry(), entry(2, main: false)])
    let reordered = signature([entry(2, main: false), entry()])
    XCTAssertEqual(guardrail.observe(first: first, second: reordered), .changed)
    XCTAssertEqual(guardrail.observe(first: reordered, second: first), .unchanged)
  }
  func testEveryCoordinateModeAndIdentityFactRemainsAStopBoundary() {
    let changes: [(inout DisplayConfigurationEntry) -> Void] = [
      { $0.id = 2 }, { $0.x = 10 }, { $0.y = -100 }, { $0.width = 1500 }, { $0.height = 980 },
      { $0.modeID += 1 }, { $0.modeFlags += 1 }, { $0.modeWidth = 1500 }, { $0.modeHeight = 980 },
      { $0.pixelWidth = 3000 }, { $0.pixelHeight = 1960 }, { $0.refreshRate = 60 },
      { $0.rotation = 90 }, { $0.backingScale = 1 },
    ]
    for change in changes {
      let guardrail = DisplayConfigurationGuard(), baseline = signature()
      _ = guardrail.observe(first: baseline, second: baseline)
      var altered = entry(); change(&altered)
      let next = signature([altered]); XCTAssertNotNil(next)
      XCTAssertEqual(guardrail.observe(first: next, second: next), .changed)
    }
  }
  func testAttachDetachMainActiveAndMirroringChangesRemainStopBoundaries() {
    let baseline = signature([entry(), entry(2, main: false)])
    var changedMain = [entry(), entry(2, main: false)]
    changedMain[0].main = false; changedMain[1].main = true
    var inactive = [entry(), entry(2, main: false)]; inactive[1].active = false
    var mirror = [entry(), entry(2, main: false)]
    mirror[0].inMirrorSet = true; mirror[1].inMirrorSet = true; mirror[1].mirrorOf = 1
    for candidate in [signature(), signature([entry(), entry(2, main: false), entry(3, main: false)]),
      signature(changedMain), signature(inactive), signature(mirror)] {
      XCTAssertNotNil(candidate)
      let guardrail = DisplayConfigurationGuard()
      _ = guardrail.observe(first: baseline, second: baseline)
      XCTAssertEqual(guardrail.observe(first: candidate, second: candidate), .changed)
    }
  }
  func testMissingOrUnstableReadRetiresBaselineEvenIfOriginalTopologyReturns() {
    let first = signature(), second = signature([entry(2)])
    for pair in [(first, nil), (nil, first), (first, second)] {
      let guardrail = DisplayConfigurationGuard()
      _ = guardrail.observe(first: first, second: first)
      XCTAssertEqual(guardrail.observe(first: pair.0, second: pair.1), .unavailable)
      XCTAssertEqual(guardrail.observe(first: first, second: first), .changed)
      XCTAssertEqual(guardrail.observe(first: first, second: first), .unchanged)
    }
  }
  func testIncompleteInvalidAndNonfiniteMetadataCannotEstablishAuthority() {
    var invalid: [DisplayConfigurationEntry] = []
    var value = entry(); value.x = .nan; invalid.append(value)
    value = entry(); value.width = 0; invalid.append(value)
    value = entry(); value.pixelHeight = 0; invalid.append(value)
    value = entry(); value.backingScale = nil; invalid.append(value)
    value = entry(); value.refreshRate = .infinity; invalid.append(value)
    value = entry(); value.rotation = -1; invalid.append(value)
    value = entry(); value.mirrorOf = 77; invalid.append(value)
    value = entry(); value.main = false; invalid.append(value)
    for entry in invalid { XCTAssertNil(signature([entry])) }
    XCTAssertNil(signature([]))
    XCTAssertNil(signature([entry(), entry()]))
    XCTAssertNil(DisplayConfigurationSignature(activeIDs: [1, 2], displays: [entry()]))
    XCTAssertNil(DisplayConfigurationSignature(activeIDs: [1, 1], displays: [entry()]))
    XCTAssertNil(DisplayConfigurationSignature(activeIDs: [], displays: [entry()]))
  }
}
