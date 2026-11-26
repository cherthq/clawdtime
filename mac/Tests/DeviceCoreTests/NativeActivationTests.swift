import XCTest
@testable import DeviceCore

final class NativeActivationTests: XCTestCase {
  let target:[String:Any] = ["pid":1,"bundleId":"com.apple.finder","windowId":2,"titleHash":String(repeating:"b",count:64),"bounds":["x":0,"y":0,"width":100,"height":100]]
  let now=Date(timeIntervalSince1970:2000000000)
  func raw() -> [String:Any] { ["version":1,"fingerprint":String(repeating:"a",count:64),
    "operation":["version":1,"operationId":"operation","sceneId":"scene","generation":1,"action":"activate_app",
      "window":["appId":"com.apple.finder","ownerPid":1,"windowId":"2","displayId":1],
      "expected":["requestId":"request","sessionId":"agent","leaseId":"lease","epoch":2,"cursor":3,"policyRevision":1,"displayId":1]],
    "binding":["mediaSessionId":"media","pairingId":"pair","deviceId":"device","memberId":"member","expiresAt":now.timeIntervalSince1970*1000+19000]] }
  func decode(_ value:[String:Any]) throws -> NativeActivationEnvelope {
    var value=value;value["fingerprint"]=try NativeActivationEnvelope.operationFingerprint(value["operation"] as! [String:Any])
    return try NativeActivationEnvelope.decode(JSONSerialization.data(withJSONObject:value),now:now.timeIntervalSince1970*1000)
  }
  func lease() -> Lease { Lease(id:"lease",deviceId:"device",memberId:"member",callId:"call",displayId:1,mode:"view",expiresAt:now.addingTimeInterval(20),protocolVersion:2,sessionId:"agent",executorEpoch:2,policyRevision:1,executor:"native",cameraVersion:1,surface:CameraSurface(kind:"display",id:"1",displayId:1)) }
  func testExactBindingAndNoDeadlineRenewal() throws {
    let e=try decode(raw());XCTAssertTrue(e.matches(lease(),device:"device",now:now))
    for change in ["device","member","session","epoch","executor","display"] {
      var l=lease();switch change {case "device":l.deviceId="other";case "member":l.memberId="other";case "session":l.sessionId="other";case "epoch":l.executorEpoch=3;case "executor":l.executor="none";default:l.displayId=2}
      XCTAssertFalse(e.matches(l,device:"device",now:now))
    }
    var changed=raw();changed["nativeExpiresAt"]=now.timeIntervalSince1970*1000+2001;XCTAssertThrowsError(try decode(changed))
    changed["nativeExpiresAt"]=now.timeIntervalSince1970*1000;XCTAssertThrowsError(try decode(changed))
    changed["nativeExpiresAt"]=now.timeIntervalSince1970*1000+1500;let dispatched=try decode(changed)
    XCTAssertEqual(dispatched.baseHash,e.baseHash);XCTAssertFalse(dispatched.matches(lease(),device:"device",now:now.addingTimeInterval(2)))
  }
  func testUnknownSurvivesRestartAndFencesNewOperation() throws {
    let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at:folder) }
    let url=folder.appendingPathComponent("receipts.json"),e=try decode(raw())
    var store: NativeActivationStore?=try NativeActivationStore(url:url)
    try store!.prepare(e,observation:["synthetic":true],target:target);try store!.dispatch(e)
    XCTAssertEqual(store!.unresolved,1);store=nil
    let restarted=try NativeActivationStore(url:url)
    XCTAssertEqual(restarted.unresolved,1)
    XCTAssertEqual(try restarted.receipt(id:"operation",leaseId:"lease")["state"] as? String,"uncertain")
    XCTAssertThrowsError(try restarted.receipt(id:"operation",leaseId:"different"))
    XCTAssertThrowsError(try restarted.prepare(e,observation:[:],target:target))
    var changed=raw();var op=changed["operation"] as! [String:Any];op["sceneId"]="other";changed["operation"]=op
    XCTAssertThrowsError(try restarted.existing(decode(changed)))
  }
  func testTerminalReceiptPreservedAndCompetingHostRefused() throws {
    let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at:folder) }
    let url=folder.appendingPathComponent("receipts.json"),e=try decode(raw())
    let store=try NativeActivationStore(url:url)
    XCTAssertThrowsError(try NativeActivationStore(url:url))
    var value=raw();value["nativeExpiresAt"]=now.timeIntervalSince1970*1000+1500;let dispatch=try decode(value)
    try store.prepare(e,observation:[:],target:target)
    XCTAssertEqual((try store.existing(e)?["target"] as? [String:Any])?["titleHash"] as? String,target["titleHash"] as? String)
    var changedTarget=target;changedTarget["titleHash"]=String(repeating:"c",count:64)
    XCTAssertThrowsError(try store.prepare(e,observation:[:],target:changedTarget))
    try store.dispatch(dispatch)
    try store.finish(dispatch,result:["operationId":"operation","state":"verified","reason":"target_foreground",
      "terminalEvidence":["receiptId":"receipt","operationId":"operation","fingerprint":e.fingerprint,"hostId":"clawdtime-installed-native","completedAt":now.timeIntervalSince1970*1000]])
    XCTAssertEqual(store.unresolved,0)
    XCTAssertThrowsError(try store.dispatch(e))
  }
  func testStorageFailurePoisonsInMemoryReceiptAndInputFence() throws {
    let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at:folder) }
    let url=folder.appendingPathComponent("receipts.json"),e=try decode(raw())
    let store=try NativeActivationStore(url:url)
    try store.prepare(e,observation:[:],target:target);try store.dispatch(e)
    try FileManager.default.removeItem(at:folder)
    XCTAssertThrowsError(try store.finish(e,result:["operationId":"operation","state":"uncertain","reason":"native_completion_unknown"]))
    XCTAssertGreaterThan(store.unresolved,0)
    XCTAssertThrowsError(try store.receipt(id:"operation",leaseId:"lease"))
    XCTAssertThrowsError(try store.existing(e))
  }

  func testChildReturnAfterStopIsNotVerifiedAndKilledChildStaysUncertain() {
    XCTAssertEqual(NativeCompletionDecision.state(childStatus:"verified",responseMatches:true,authorityCurrent:true),"verified")
    XCTAssertEqual(NativeCompletionDecision.state(childStatus:"verified",responseMatches:true,authorityCurrent:false),"returned")
    XCTAssertEqual(NativeCompletionDecision.state(childStatus:"unknown",responseMatches:true,authorityCurrent:false),"returned")
    XCTAssertEqual(NativeCompletionDecision.state(childStatus:nil,responseMatches:false,authorityCurrent:false),"uncertain")
    XCTAssertEqual(NativeCompletionDecision.state(childStatus:"verified",responseMatches:false,authorityCurrent:true),"uncertain")
  }
  func testHelperIndependentlyRejectsWrongHashAndBooleanIntegers() throws {
    let correct="11857f476f591fa89d037cfcf8122d8181c911551b7a79df4a2efa98ed0cc397"
    XCTAssertEqual(try NativeActivationEnvelope.operationFingerprint(raw()["operation"] as! [String:Any]),correct)
    var changed=raw();changed["fingerprint"]=correct
    var action=changed["operation"] as! [String:Any];action["action"]="raise_window";changed["operation"]=action
    XCTAssertThrowsError(try NativeActivationEnvelope.decode(JSONSerialization.data(withJSONObject:changed),now:now.timeIntervalSince1970*1000))
    XCTAssertThrowsError(try NativeActivationEnvelope.decode(JSONSerialization.data(withJSONObject:raw()),now:now.timeIntervalSince1970*1000))
    var value=raw();value["version"]=true
    XCTAssertThrowsError(try decode(value))
    value=raw();var op=value["operation"] as! [String:Any];var expected=op["expected"] as! [String:Any];expected["epoch"]=true;op["expected"]=expected;value["operation"]=op
    XCTAssertThrowsError(try decode(value))
  }

}
