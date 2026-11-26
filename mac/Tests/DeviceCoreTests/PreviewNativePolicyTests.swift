import XCTest
@testable import DeviceCore

final class PreviewNativePolicyTests: XCTestCase {
  private func request(_ changes: [String: Any] = [:], targetChanges: [String: Any] = [:]) throws -> PreviewNativeRequest {
    var target: [String: Any] = ["pid": 42, "bundleId": "com.apple.TextEdit", "windowId": 77,
      "titleHash": String(repeating: "a", count: 64), "bounds": ["x": 8, "y": 46, "width": 800, "height": 600]]
    target.merge(targetChanges) { _, new in new }
    var value: [String: Any] = ["v": 1, "requestId": "q1", "op": "qualify", "effect": "activate", "sessionId": "session_a",
      "leaseId": "lease_a", "authorityRequestId": "request_a", "cursor": 0, "executorEpoch": 1, "policyRevision": 2, "displayId": 1, "expiresAt": 2500, "target": target]
    value.merge(changes) { _, new in new }
    return try JSONDecoder().decode(PreviewNativeRequest.self, from: JSONSerialization.data(withJSONObject: value))
  }
  func testAdmissionRejectsUnboundedOrUnapprovedRequests() throws {
    XCTAssertTrue(try request().valid(now: 1000))
    for changes: [String: Any] in [["expiresAt": 1000], ["expiresAt": 3001], ["executorEpoch": 0],
      ["policyRevision": 0], ["displayId": 0], ["op": "click"], ["effect": "type"],
      ["op": "raise"], ["requestId": "bad request"], ["requestId": String(repeating: "x", count: 161)]] {
      XCTAssertFalse(try request(changes).valid(now: 1000))
    }
    for changes: [String: Any] in [["bundleId": "com.openai.codex"], ["bundleId": "com.apple.Terminal"],
      ["pid": 0], ["windowId": 0], ["titleHash": "guessed"], ["bounds": ["x": 0, "y": 0, "width": 0, "height": 1]]] {
      XCTAssertFalse(try request(targetChanges: changes).valid(now: 1000))
    }
  }
  func testTokenConsumedOnceAndDuplicateRequestInvalidatesQualification() throws {
    var policy = PreviewNativeAdmission(); let q = try request()
    XCTAssertTrue(policy.begin(q, now: 1000)); policy.qualify(q, token: "opaque", uptime: 5)
    let action = try request(["op": "activate", "requestId": "a1", "targetToken": "opaque"])
    XCTAssertTrue(policy.begin(action, now: 1100)); XCTAssertTrue(policy.consume(action, now: 1100, uptime: 5.1))
    XCTAssertFalse(policy.consume(action, now: 1100, uptime: 5.1))
    policy.qualify(q, token: "opaque", uptime: 5)
    XCTAssertFalse(policy.begin(q, now: 1100)); XCTAssertFalse(policy.consume(action, now: 1100, uptime: 5.1))
  }
  func testEveryAuthorityTargetAndEffectMismatchConsumesToken() throws {
    let q = try request()
    for changes: [String: Any] in [["authorityRequestId": "request_b"], ["cursor": 1], ["sessionId": "other"], ["leaseId": "other"], ["executorEpoch": 2],
      ["policyRevision": 3], ["displayId": 2], ["effect": "raise", "op": "raise"], ["targetToken": "other"]] {
      var policy = PreviewNativeAdmission(); policy.qualify(q, token: "opaque", uptime: 5)
      var values: [String: Any] = ["op": "activate", "requestId": "a1", "targetToken": "opaque"]
      values.merge(changes) { _, new in new }
      XCTAssertFalse(policy.consume(try request(values), now: 1100, uptime: 5.1))
      XCTAssertFalse(policy.consume(try request(["op": "activate", "targetToken": "opaque"]), now: 1100, uptime: 5.1))
    }
    for target: [String: Any] in [["pid": 43], ["windowId": 78], ["titleHash": String(repeating: "b", count: 64)],
      ["bounds": ["x": 9, "y": 46, "width": 800, "height": 600]]] {
      var policy = PreviewNativeAdmission(); policy.qualify(q, token: "opaque", uptime: 5)
      XCTAssertFalse(policy.consume(try request(["op": "activate", "targetToken": "opaque"], targetChanges: target), now: 1100, uptime: 5.1))
    }
  }
  func testOriginalWallAndMonotonicAgeAndStop() throws {
    let q = try request(); let action = try request(["op": "activate", "targetToken": "opaque", "expiresAt": 4000])
    for (wall, mono) in [(1100.0,5.1), (2500,5.1), (1100,7.0), (1100,4.9)] {
      var policy = PreviewNativeAdmission(); policy.qualify(q, token: "opaque", uptime: 5)
      XCTAssertFalse(policy.consume(action, now: wall, uptime: mono))
    }
    var policy = PreviewNativeAdmission(); policy.qualify(q, token: "opaque", uptime: 5); policy.clear()
    XCTAssertFalse(policy.consume(action, now: 1100, uptime: 5.1))
  }
  func testRequestHistoryHasHardCap() throws {
    var policy = PreviewNativeAdmission()
    for n in 0..<256 { XCTAssertTrue(policy.begin(try request(["requestId": "q_\(n)"]), now: 1000)) }
    XCTAssertFalse(policy.begin(try request(["requestId": "q_overflow"]), now: 1000))
  }
}
