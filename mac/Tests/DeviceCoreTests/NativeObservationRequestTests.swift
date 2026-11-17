import XCTest
@testable import DeviceCore

final class NativeObservationRequestTests: XCTestCase {
  private func decode(_ changes: [String: Any] = [:], now: Double = 1000) throws -> NativeObservationRequest {
    var target: [String: Any] = ["appId":"com.apple.finder","windowId":"77","ownerPid":42,"displayId":1]
    target.merge(changes) { _, value in value }
    return try .decode(JSONSerialization.data(withJSONObject: target), now: now)
  }
  func testMetadataOnlyExactTargetRejectsEffectsAndScopeClaims() throws {
    let request = try decode()
    XCTAssertTrue(request.valid(now: 1000)); XCTAssertEqual(request.target.windowId,77)
    for field in ["op","effect","targetToken","sessionId","leaseId","script","text","x","expiresAt"] {
      XCTAssertThrowsError(try decode([field:"anything"]))
    }
    for change: [String: Any] in [["appId":"com.openai.codex"],["ownerPid":0],["ownerPid":true],
      ["windowId":"077"],["windowId":"0"],["windowId":"4294967296"],["windowId":77],["displayId":0]] {
      XCTAssertThrowsError(try decode(change))
    }
  }
  func testResolutionPreservesOriginalDeadlineAndExactIdentity() throws {
    let request = try decode()
    let resolved = request.resolving(titleHash:String(repeating:"a",count:64),
      bounds:PreviewNativeBounds(x:8,y:46,width:800,height:600))
    XCTAssertEqual(resolved.target.pid,request.target.pid); XCTAssertEqual(resolved.target.windowId,request.target.windowId)
    XCTAssertEqual(resolved.target.bundleId,request.target.bundleId); XCTAssertEqual(resolved.displayId,request.displayId)
    XCTAssertTrue(resolved.valid(now:2999)); XCTAssertFalse(resolved.valid(now:3000))
    XCTAssertFalse(resolved.valid(now:999)); XCTAssertFalse(resolved.valid(now:.nan))
    XCTAssertThrowsError(try decode(now:.infinity))
  }
}
