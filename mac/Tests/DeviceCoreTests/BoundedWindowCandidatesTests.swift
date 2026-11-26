import XCTest
@testable import DeviceCore

final class BoundedWindowCandidatesTests: XCTestCase {
  struct Window { let identity: Int; let bounds: Int }
  func testMainAndFocusedRecoverOneOmittedWindowAndDeduplicateByIdentity() {
    let desktop = Window(identity: 1, bounds: 10)
    let target = Window(identity: 2, bounds: 20)
    let result = BoundedWindowCandidates.merge([desktop], supplemental: [target, target], same: { $0.identity == $1.identity })
    XCTAssertEqual(result?.map(\.identity), [1, 2])
    XCTAssertEqual(BoundedWindowCandidates.merge([desktop, target], supplemental: [target, desktop], same: { $0.identity == $1.identity })?.count, 2)
  }
  func testEqualGeometryDoesNotCollapseDistinctElements() {
    let a = Window(identity: 1, bounds: 20), b = Window(identity: 2, bounds: 20)
    let result = BoundedWindowCandidates.merge([a], supplemental: [b], same: { $0.identity == $1.identity })
    XCTAssertEqual(result?.count, 2) // Resolver must still reject ambiguous exact candidates.
  }
  func testTotalAndInputBoundsRefuseInsteadOfTruncating() {
    let full = Array(0..<32)
    XCTAssertEqual(BoundedWindowCandidates.merge(full, supplemental: [30,31], same: ==), full)
    XCTAssertNil(BoundedWindowCandidates.merge(full, supplemental: [32], same: ==))
    XCTAssertNil(BoundedWindowCandidates.merge(Array(0..<33), supplemental: [], same: ==))
    XCTAssertNil(BoundedWindowCandidates.merge([1], supplemental: [1,1,1], same: ==))
    XCTAssertNil(BoundedWindowCandidates.merge([1], supplemental: [], maximum: 0, same: ==))
    XCTAssertNil(BoundedWindowCandidates.merge([1], supplemental: [], maximum: 33, same: ==))
  }
}
