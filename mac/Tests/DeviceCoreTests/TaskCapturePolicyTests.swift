import Foundation
import CoreGraphics
import XCTest
@testable import DeviceCore

final class TaskCapturePolicyTests: XCTestCase {
  func testExactTargetAndExpiryCannotWidenToAnotherWindow() throws {
    let target = try JSONDecoder().decode(TaskCaptureTarget.self, from: Data("""
      {"appId":"com.example.fixture","windowId":"101","ownerPid":123,"displayId":1,
       "processIdentity":"\(String(repeating:"a",count:64))","titleHash":"\(String(repeating:"b",count:64))"}
      """.utf8))
    let grant = TaskCaptureGrant(presentationId: "presentation_fixture", expiresAt: 5000, targets: [target])
    XCTAssertTrue(grant.permits(target, now: 1000))
    XCTAssertFalse(grant.permits(target, now: 5000))
    var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target)) as! [String: Any]
    json["ownerPid"] = 124
    let other = try JSONDecoder().decode(TaskCaptureTarget.self, from: JSONSerialization.data(withJSONObject: json))
    XCTAssertFalse(grant.permits(other, now: 1000))
  }
  func testWindowGeometryMustStayWithinSelectedDisplay() {
    let display = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    XCTAssertTrue(TaskCapturePolicy.geometry(width: 1600, height: 1200, bounds: CGRect(x: 100, y: 100, width: 800, height: 600), display: display))
    XCTAssertFalse(TaskCapturePolicy.geometry(width: 1600, height: 1200, bounds: CGRect(x: -1, y: 100, width: 800, height: 600), display: display))
    XCTAssertFalse(TaskCapturePolicy.geometry(width: 8192, height: 8192, bounds: display, display: display))
  }
  func testProcessLifetimeRequiresRealStartWitness() {
    XCTAssertNil(ProcessLifetimeIdentity.resolve(pid: 123, bundleId: "com.example.fixture", launchTime: nil))
    XCTAssertNil(ProcessLifetimeIdentity.resolve(pid: 123, bundleId: "com.example.fixture", launchTime: nil, kernelPID: 124, kernelSeconds: 1, kernelMicroseconds: 0))
    let first = ProcessLifetimeIdentity.resolve(pid: 123, bundleId: "com.example.fixture", launchTime: 100)
    let next = ProcessLifetimeIdentity.resolve(pid: 123, bundleId: "com.example.fixture", launchTime: 101)
    XCTAssertNotEqual(first, next)
  }
}
