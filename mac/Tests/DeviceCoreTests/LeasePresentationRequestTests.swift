import XCTest
@testable import DeviceCore

final class LeasePresentationRequestTests: XCTestCase {
  private func raw() -> [String: Any] {
    ["version":1,"window":["appId":"com.apple.finder","windowId":"77","ownerPid":42,"displayId":1],
      "expected":["requestId":"request","sessionId":"session","leaseId":"lease","epoch":0,"cursor":3,"policyRevision":1,"displayId":1],"expiresAt":2500]
  }
  private func decode(_ raw: [String: Any]) throws -> LeasePresentationRequest {
    try .decode(JSONSerialization.data(withJSONObject: raw), now: 1000)
  }
  func testStrictReadOnlyWireAndOriginalDeadline() throws {
    XCTAssertNotNil(try decode(raw()).nativeRequest(now: 1000))
    XCTAssertNil(try decode(raw()).nativeRequest(now: 2500))
    for extra in ["op","effect","targetToken","script","text"] {
      var value=raw();value[extra]="activate"
      XCTAssertThrowsError(try decode(value))
    }
    for bad: Any in [true, 0, 1000, 3001, "2500"] {
      var value=raw();value["expiresAt"]=bad;XCTAssertThrowsError(try decode(value))
    }
    var value=raw();value["processIdentity"]=String(repeating:"a",count:64)
    XCTAssertNotNil(try decode(value))
    value["processIdentity"]="pid42";XCTAssertThrowsError(try decode(value))
    value=raw();value["window"]=["appId":"com.openai.codex","windowId":"77","ownerPid":42,"displayId":1]
    XCTAssertThrowsError(try decode(value))
  }
  func testLeaseBindingsCannotGrantInputOrBroadenSurface() throws {
    let value=try decode(raw())
    var lease=Lease(id:"lease",deviceId:"device",memberId:"member",callId:"call",displayId:1,mode:"view",expiresAt:Date(timeIntervalSince1970:3),protocolVersion:2,sessionId:"session",executorEpoch:0,policyRevision:1,executor:"none",cameraVersion:1,
      surface:CameraSurface(kind:"display",id:"1",displayId:1))
    let now=Date(timeIntervalSince1970:1)
    XCTAssertTrue(value.matches(lease,now:now))
    for executor in ["native","clawdtime"] { var other=lease;other.executor=executor;XCTAssertFalse(value.matches(other,now:now)) }
    var other=lease;other.executorEpoch=1;XCTAssertFalse(value.matches(other,now:now))
    other=lease;other.policyRevision=2;XCTAssertFalse(value.matches(other,now:now))
    other=lease;other.sessionId="other";XCTAssertFalse(value.matches(other,now:now))
    other=lease;other.displayId=2;XCTAssertFalse(value.matches(other,now:now))
    other=lease;other.surface=CameraSurface(kind:"window",id:"77",displayId:1,ownerPid:42);XCTAssertFalse(value.matches(other,now:now))
    XCTAssertFalse(value.matches(lease,now:Date(timeIntervalSince1970:2.5)))
    lease.expiresAt=now;XCTAssertFalse(value.matches(lease,now:now))
  }
}
