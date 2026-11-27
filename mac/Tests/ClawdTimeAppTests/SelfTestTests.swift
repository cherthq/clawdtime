import XCTest
@testable import ClawdTimeAppCore

final class SelfTestTests: XCTestCase {
  func testItPassesForAWholeRuntimeWhoseEngineSaysHelloAndLeavesOnCancel() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("ClawdTime.app/Contents/Resources/runtime"), engine: FakeEngine.waitsForCancel(folder))
    let report = SelfTest.run(runtime: root, timeout: 10)
    XCTAssertTrue(report.ok, report.problem ?? "")
    XCTAssertEqual(report.engineProtocol, 2)
    XCTAssertEqual(report.engineVersion, "0.4.0")
    XCTAssertEqual(report.engineExit, 0)
    XCTAssertEqual(report.filesVerified, 5)
    XCTAssertEqual(report.runtimeVersion, "0.4.0")
    XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("cancelled").path))
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("args"), encoding: .utf8), "onboard\n--json\n--app\n")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(report.json().utf8)) as? [String: Any])
    XCTAssertEqual(json["ok"] as? Bool, true)
  }

  func testItFailsForAnotherProtocol() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("runtime"), engine: FakeEngine.waitsForCancel(folder, protocolVersion: 1))
    let report = SelfTest.run(runtime: root, timeout: 10)
    XCTAssertFalse(report.ok)
    XCTAssertEqual(report.engineProtocol, 1)
    XCTAssertEqual(report.problem, "The engine speaks protocol 1; this app speaks protocol 2.")
  }

  func testItFailsForAnEngineThatSaysNothingOrPrintsText() throws {
    let silent = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: "exit 3\n")
    let quiet = SelfTest.run(runtime: silent, timeout: 5)
    XCTAssertFalse(quiet.ok)
    XCTAssertEqual(quiet.problem, "The engine left before it said hello.")

    let chatty = try FakeRuntime.make(at: temporaryFolder(self).appendingPathComponent("runtime"), engine: """
    echo 'Welcome to ClawdTime'
    echo '{"type":"hello","protocol":2,"version":"0.4.0"}'
    read line
    exit 0
    """)
    let report = SelfTest.run(runtime: chatty, timeout: 5)
    XCTAssertFalse(report.ok)
    XCTAssertEqual(report.problem, "The engine wrote 1 line(s) that are not protocol JSON.")
  }

  func testItFailsBeforeStartingAnythingForADamagedRuntime() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("runtime"), engine: FakeEngine.waitsForCancel(folder))
    try "changed".write(to: root.appendingPathComponent("app/package.json"), atomically: true, encoding: .utf8)
    let report = SelfTest.run(runtime: root, timeout: 5)
    XCTAssertFalse(report.ok)
    XCTAssertEqual(report.problem, "app/package.json in the runtime differs from its manifest.")
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("args").path), "the engine never ran")
  }
}
