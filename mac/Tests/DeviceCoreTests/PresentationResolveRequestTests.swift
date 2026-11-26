import XCTest
@testable import DeviceCore

final class PresentationResolveRequestTests: XCTestCase {
  private func bytes(_ changes: [String: Any] = [:]) throws -> Data {
    var value: [String: Any] = ["v": 1, "requestId": "read1", "op": "resolve", "sessionId": "session", "leaseId": "lease",
      "authorityRequestId": "request", "processIdentity": "identity", "epoch": 0, "cursor": 0, "policyRevision": 1,
      "displayId": 1, "expiresAt": 2500, "target": ["pid": 42, "bundleId": "com.apple.finder", "windowId": 77]]
    value.merge(changes) { _, new in new }
    return try JSONSerialization.data(withJSONObject: value)
  }
  func testReadOnlyEpochZeroAndStrictNoEffectSurface() throws {
    XCTAssertTrue(try PresentationResolveRequest.decode(bytes(), now: 1000).valid(now: 1000))
    for op in ["activate","raise","qualify","click","type","scroll","stop"] {
      XCTAssertThrowsError(try PresentationResolveRequest.decode(bytes(["op": op]), now: 1000))
    }
    for extra in ["effect","targetToken","script","x","text"] {
      XCTAssertThrowsError(try PresentationResolveRequest.decode(bytes([extra: "anything"]), now: 1000))
    }
    XCTAssertThrowsError(try PresentationResolveRequest.decode(bytes(["epoch": -1]), now: 1000))
    XCTAssertThrowsError(try PresentationResolveRequest.decode(bytes(["expiresAt": 1000]), now: 1000))
    XCTAssertThrowsError(try PresentationResolveRequest.decode(bytes(["target": ["pid": 42,"bundleId": "com.openai.codex","windowId": 77]]), now: 1000))
  }
  func testResolverCannotChangeItsFixedBinding() throws {
    let first = try PresentationResolveRequest.decode(bytes(), now: 1000)
    XCTAssertTrue(first.sameBinding(try PresentationResolveRequest.decode(bytes(["requestId":"read2","expiresAt":2600]), now: 1000)))
    for change: [String: Any] in [["epoch":1],["cursor":1],["displayId":2],["sessionId":"other"],["leaseId":"other"],["processIdentity":"new_process"]] {
      XCTAssertFalse(first.sameBinding(try PresentationResolveRequest.decode(bytes(change), now: 1000)))
    }
  }
}
