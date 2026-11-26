import XCTest
import DeviceCore
@testable import ClawdTimeCompanion

/// A scripted child stands in for the AX executor. It never touches a window.
final class InstalledNativeHostTests: XCTestCase {
  static let child = """
import json, os, sys, time
mode = sys.argv[1]
target = {"pid": 1, "bundleId": "com.apple.finder", "windowId": 2, "titleHash": "b" * 64,
  "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}}
observation = {"window": "fixture", "processIdentity": "fixture", "appActive": True}
def answer(request, status, **extra):
  value = {"v": 1, "requestId": request["requestId"], "status": status, "reason": "fixture",
    "effectAttempted": False, **extra}
  sys.stdout.write(json.dumps(value) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
  request = json.loads(line)
  if mode == "epipe":
    os.close(0)
    sys.stdout.write('{"localAuthority":1}\\n'); sys.stdout.flush()
    time.sleep(2); sys.exit(0)
  if request["op"] == "qualify":
    if mode == "refuse": answer(request, "rejected")
    elif mode == "changed": answer(request, "qualified", observation=observation, targetToken="token",
      wireTarget={**target, "windowId": 3})
    else: answer(request, "qualified", observation=observation, targetToken="token", wireTarget=target)
  elif mode == "die_after_effect": sys.exit(0)
  else: answer(request, "verified", observation=observation)
"""
  let observation: [String: Any] = ["window": "fixture", "processIdentity": "fixture", "appActive": true]
  var folder: URL!
  var started = 0.0
  override func setUp() {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    started = Date().timeIntervalSince1970 * 1000
  }
  override func tearDown() { try? FileManager.default.removeItem(at: folder) }
  func raw(now: Double) -> [String: Any] {
    ["version": 1,
     "operation": ["version": 1, "operationId": "operation", "sceneId": "scene", "generation": 1, "action": "activate_app",
       "window": ["appId": "com.apple.finder", "ownerPid": 1, "windowId": "2", "displayId": 1],
       "expected": ["requestId": "request", "sessionId": "agent", "leaseId": "lease", "epoch": 2, "cursor": 3, "policyRevision": 1, "displayId": 1]],
     "binding": ["mediaSessionId": "media", "pairingId": "pair", "deviceId": "device", "memberId": "member", "expiresAt": now + 19000]]
  }
  func envelope(dispatch: Bool) throws -> NativeActivationEnvelope {
    let now = Date().timeIntervalSince1970 * 1000
    var value = raw(now: started)
    value["fingerprint"] = try NativeActivationEnvelope.operationFingerprint(value["operation"] as! [String: Any])
    if dispatch { value["nativeExpiresAt"] = now + 1800; value["preparedObservation"] = observation }
    return try NativeActivationEnvelope.decode(JSONSerialization.data(withJSONObject: value), now: now)
  }
  @MainActor func host(_ mode: String, executable: String = "/usr/bin/python3") throws -> InstalledNativeHost {
    try InstalledNativeHost(url: folder.appendingPathComponent("receipts.json"),
      executable: URL(fileURLWithPath: executable), arguments: ["-u", "-c", Self.child, mode])
  }
  /// Prepares with a qualifying child, then dispatches with the child of `mode`.
  @MainActor func dispatch(_ mode: String, executable: String = "/usr/bin/python3") async throws -> (InstalledNativeHost, [String: Any]) {
    let host = try host("qualify")
    _ = try await host.run(envelope(dispatch: false), dispatch: false, allowed: { true })
    host.executable = URL(fileURLWithPath: executable)
    host.arguments = ["-u", "-c", Self.child, mode]
    return (host, try await host.run(envelope(dispatch: true), dispatch: true, allowed: { true }))
  }
  @MainActor func testRefusedQualificationBeforeAnyEffectIsStoredAsRejected() async throws {
    let (host, result) = try await dispatch("refuse")
    XCTAssertEqual(result["state"] as? String, "rejected")
    XCTAssertNotNil(result["terminalEvidence"])
    XCTAssertEqual(host.store.unresolved, 0)
    XCTAssertEqual(try host.store.receipt(id: "operation", leaseId: "lease")["state"] as? String, "rejected")
  }
  @MainActor func testChangedTargetBeforeAnyEffectIsStoredAsRejected() async throws {
    let (host, result) = try await dispatch("changed")
    XCTAssertEqual(result["state"] as? String, "rejected")
    XCTAssertEqual(host.store.unresolved, 0)
  }
  @MainActor func testChildThatCannotStartIsStoredAsRejected() async throws {
    let (host, result) = try await dispatch("refuse", executable: folder.appendingPathComponent("missing").path)
    XCTAssertEqual(result["state"] as? String, "rejected")
    XCTAssertEqual(host.store.unresolved, 0)
  }
  @MainActor func testChildLostAfterTheEffectRequestStaysUncertain() async throws {
    let (host, result) = try await dispatch("die_after_effect")
    XCTAssertEqual(result["state"] as? String, "uncertain")
    XCTAssertNil(result["terminalEvidence"])
    XCTAssertEqual(host.store.unresolved, 1)
  }
}
