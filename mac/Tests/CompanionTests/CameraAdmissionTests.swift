import XCTest
import DeviceCore
@testable import ClawdTimeCompanion

/// Listing camera surfaces and checking a lease's camera target read the screen,
/// so they run only after the local Enable. The readers are replaced: no test
/// here reads the screen.
final class CameraAdmissionTests: XCTestCase {
  let secret = String(repeating: "s", count: 32)
  var folder: URL!
  override func setUp() { folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
  override func tearDown() { try? FileManager.default.removeItem(at: folder) }
  @MainActor func app() throws -> DeviceApp {
    let config = HelperConfig(deviceId: "device", secret: secret,
      displays: [DisplayPermission(displayId: 1, viewers: ["member"], controllers: [])])
    return try DeviceApp(config: config, ledgerURL: folder.appendingPathComponent("action-receipts.json"))
  }
  func request(_ method: String, _ path: String, body: Data = Data()) throws -> HTTPRequest {
    let head = "\(method) \(path) HTTP/1.1\r\nAuthorization: Bearer \(secret)\r\nContent-Length: \(body.count)\r\n\r\n"
    return try XCTUnwrap(HTTPRequest.parse(Data(head.utf8) + body))
  }
  @MainActor func testCameraSurfacesAreNotListedWhileSharingIsStopped() async throws {
    let app = try app()
    var listed = false
    app.cameraSurfaceList = { listed = true; return [] }
    let response = await app.handle(try request("GET", "/v1/camera-surfaces"))
    XCTAssertEqual(response.status, 423)
    XCTAssertFalse(listed)
  }
  @MainActor func testLeaseCameraTargetIsNotCheckedWhileSharingIsStopped() async throws {
    let app = try app()
    var checked = false
    app.cameraTargetCheck = { _ in checked = true }
    let lease = Lease(id: "lease", deviceId: "device", memberId: "member", callId: "call", displayId: 1, mode: "view",
      expiresAt: Date().addingTimeInterval(20), protocolVersion: 2, sessionId: "agent", executorEpoch: 1,
      policyRevision: 1, executor: "native", cameraVersion: 1, surface: CameraSurface(kind: "display", id: "1", displayId: 1))
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    let response = await app.handle(try request("POST", "/v1/leases", body: encoder.encode(lease)))
    XCTAssertEqual(response.status, 423)
    XCTAssertFalse(checked)
  }
}
