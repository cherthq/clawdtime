import XCTest
@testable import DeviceCore

final class CameraPolicyTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1800000000)
  func policy() throws -> DevicePolicy {
    let p = try DevicePolicy(config: HelperConfig(deviceId: "device", secret: String(repeating: "s", count: 32), displays: [DisplayPermission(displayId: 7, viewers: ["owner"], controllers: [])]))
    p.arm(); return p
  }
  func lease() -> Lease {
    Lease(id: "camera", deviceId: "device", memberId: "owner", callId: "call", displayId: 7, mode: "view", expiresAt: now.addingTimeInterval(20), protocolVersion: 2, sessionId: "session", executorEpoch: 0, policyRevision: 1, executor: "none", cameraVersion: 1, surface: CameraSurface(kind: "window", id: "88", displayId: 7, ownerPid: 123))
  }
  func testCameraRequiresExactVersionSurfaceAndOwner() throws {
    for modify in [
      { (x: inout Lease) in x.cameraVersion = nil },
      { (x: inout Lease) in x.cameraVersion = 2 },
      { (x: inout Lease) in x.surface = nil },
      { (x: inout Lease) in x.surface?.displayId = 8 },
      { (x: inout Lease) in x.surface?.ownerPid = nil },
      { (x: inout Lease) in x.protocolVersion = nil },
    ] {
      let p = try policy(); var l = lease(); modify(&l)
      XCTAssertThrowsError(try p.begin(l, now: now, sessionAvailable: true, accessibility: false))
    }
    let p = try policy(); try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false)
    XCTAssertEqual(p.lease?.surface?.ownerPid, 123)
  }
  func testWindowIdentityCannotRenewIntoAnotherSurfaceOrDisplay() throws {
    let p = try policy(); try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false)
    for target in [CameraSurface(kind: "window", id: "89", displayId: 7, ownerPid: 123), CameraSurface(kind: "window", id: "88", displayId: 7, ownerPid: 124), CameraSurface(kind: "display", id: "7", displayId: 7)] {
      var l = lease(); l.surface = target
      XCTAssertThrowsError(try p.renew(l, now: now, sessionAvailable: true, accessibility: false))
    }
    p.stop(disarm: true); XCTAssertNil(p.frame); XCTAssertNil(p.lease)
    p.arm(); XCTAssertThrowsError(try p.begin(lease(), now: now, sessionAvailable: true, accessibility: false))
  }
  func testDisplaySurfaceCannotClaimAnotherDisplayOrProcess() throws {
    XCTAssertNoThrow(try CameraSurface(kind: "display", id: "7", displayId: 7).validate(display: 7))
    XCTAssertThrowsError(try CameraSurface(kind: "display", id: "8", displayId: 7).validate(display: 7))
    XCTAssertThrowsError(try CameraSurface(kind: "display", id: "7", displayId: 7, ownerPid: 123).validate(display: 7))
  }
}
