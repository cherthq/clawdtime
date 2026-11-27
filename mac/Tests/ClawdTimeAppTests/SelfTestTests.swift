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
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("args"), encoding: .utf8), "onboard\n--json\n--app\n--local\n")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(report.json().utf8)) as? [String: Any])
    XCTAssertEqual(json["ok"] as? Bool, true)
  }

  func testTheEngineGetsATemporaryHomeNoKeyAndLocalModeSoItStartsNoDesktop() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("runtime"), engine: FakeEngine.waitsForCancel(folder))
    // The environment of a shell that runs package-app.sh: a real home, a key, a desktop state.
    let shell = ["PATH": "/opt/example/bin:/usr/bin:/bin", "HOME": "/Users/example", "OPENAI_API_KEY": madeUpKey,
                 "CLAWDTIME_DESKTOP_STATE": "/Users/example/state", "CLAWDTIME_COORDINATOR": "https://coordinator.example"]
    let report = SelfTest.run(runtime: root, timeout: 10, environment: shell)
    XCTAssertTrue(report.ok, report.problem ?? "")
    let environment = try String(contentsOf: folder.appendingPathComponent("env"), encoding: .utf8)
    for leak in [madeUpKey, "OPENAI_API_KEY", "CLAWDTIME_DESKTOP_STATE", "CLAWDTIME_COORDINATOR", "/Users/example"] {
      XCTAssertFalse(environment.contains(leak), leak)
    }
    let home = try XCTUnwrap(environment.split(separator: "\n").first { $0.hasPrefix("HOME=") }).dropFirst(5)
    XCTAssertNotEqual(String(home), NSHomeDirectory())
    XCTAssertFalse(FileManager.default.fileExists(atPath: String(home)), "the temporary home is gone after the self-test")
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("args"), encoding: .utf8), "onboard\n--json\n--app\n--local\n")
  }

  func testItFailsWhenTheEngineWritesIntoItsHome() throws {
    let folder = try temporaryFolder(self)
    let root = try FakeRuntime.make(at: folder.appendingPathComponent("runtime"), engine: """
    mkdir -p "$HOME/.local/share/clawdtime/desktop"
    echo '{"type":"hello","protocol":\(SetupProtocol.version),"version":"0.4.0"}'
    while IFS= read -r line; do :; done
    exit 0
    """)
    let report = SelfTest.run(runtime: root, timeout: 10)
    XCTAssertFalse(report.ok)
    XCTAssertEqual(report.problem, "The engine wrote into its temporary home after cancel: .local.")
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
