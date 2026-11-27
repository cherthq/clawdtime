import XCTest
@testable import ClawdTimeAppCore

/// The real process path against a fake engine script: pipes, framing, stdin
/// commands, exit and cancel. The key goes to stdin and nowhere else.
@MainActor
final class EngineProcessTests: XCTestCase {
  func testTheWholeFlowRunsAndTheKeyTravelsOnStdinOnly() throws {
    let folder = try temporaryFolder(self)
    let script = try writeScript(folder.appendingPathComponent("runtime/bin/clawdtime"), FakeEngine.fullFlow(folder))
    let engine = EngineProcess(executable: script, arguments: SetupProtocol.arguments(local: false))
    let coordinator = SetupCoordinator(makeEngine: { _ in engine }, owner: nil, open: { _ in false })
    let modelAsked = expectation(description: "model asked")
    let phoneAsked = expectation(description: "phone asked")
    let done = expectation(description: "done")
    let watch = coordinator.$state.sink { state in
      if state.current?.id == .model, state.current?.state == .needsInput { modelAsked.fulfill() }
      if state.current?.id == .phone, state.current?.state == .needsInput { phoneAsked.fulfill() }
      if state.phase == .finished(ready: true) { done.fulfill() }
    }
    defer { watch.cancel() }
    modelAsked.assertForOverFulfill = false
    phoneAsked.assertForOverFulfill = false
    done.assertForOverFulfill = false

    coordinator.begin()
    wait(for: [modelAsked], timeout: 10)
    XCTAssertEqual(coordinator.state.state(of: .preflight), .ready)
    coordinator.submit(.string(madeUpKey))
    XCTAssertEqual(coordinator.awaiting, .model)
    wait(for: [phoneAsked], timeout: 10)
    XCTAssertNil(coordinator.awaiting)
    coordinator.perform(.skip)
    wait(for: [done], timeout: 10)

    XCTAssertEqual(coordinator.state.reported(.phone), .skipped)
    XCTAssertEqual(coordinator.state.state(of: .model), .ready)
    XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("key-arrived").path), "the engine read the key from stdin")
    let args = try String(contentsOf: folder.appendingPathComponent("args"), encoding: .utf8)
    XCTAssertEqual(args, "onboard\n--json\n")
    let environment = try String(contentsOf: folder.appendingPathComponent("env"), encoding: .utf8)
    XCTAssertFalse(environment.contains(madeUpKey))
    XCTAssertTrue(environment.contains("PATH="))
  }

  func testCancelReachesTheEngineAndItLeaves() throws {
    let folder = try temporaryFolder(self)
    let script = try writeScript(folder.appendingPathComponent("clawdtime"), FakeEngine.waitsForCancel(folder))
    let engine = EngineProcess(executable: script, arguments: ["onboard", "--json"])
    let hello = expectation(description: "hello")
    let exit = expectation(description: "exit")
    engine.onEvent = { if case .hello = $0 { hello.fulfill() } }
    var status: Int32?
    engine.onExit = { code, _ in status = code; exit.fulfill() }
    try engine.start()
    wait(for: [hello], timeout: 10)
    engine.cancel(grace: 5)
    wait(for: [exit], timeout: 10)
    XCTAssertEqual(status, 0)
    XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("cancelled").path))
  }

  func testAnEngineThatIgnoresCancelIsEndedAfterTheGraceTime() throws {
    let folder = try temporaryFolder(self)
    let script = try writeScript(folder.appendingPathComponent("clawdtime"), """
    trap '' TERM
    echo '{"type":"hello","protocol":1,"version":"0.4.0"}'
    while :; do sleep 1; done
    """)
    let engine = EngineProcess(executable: script, arguments: ["onboard", "--json"])
    let exit = expectation(description: "exit")
    engine.onExit = { _, _ in exit.fulfill() }
    try engine.start()
    let started = Date()
    engine.cancel(grace: 0.3)
    wait(for: [exit], timeout: 10)
    XCTAssertLessThan(Date().timeIntervalSince(started), 6)
    XCTAssertFalse(engine.isRunning)
  }

  func testAnEngineThatLeavesEarlyFailsTheRunWithItsStderr() throws {
    let folder = try temporaryFolder(self)
    let script = try writeScript(folder.appendingPathComponent("clawdtime"), """
    echo 'Starting' 1>&2
    echo '{"type":"hello","protocol":1,"version":"0.4.0"}'
    echo 'not json'
    echo 'The runtime is missing app/dist.' 1>&2
    exit 2
    """)
    let coordinator = SetupCoordinator(makeEngine: { _ in EngineProcess(executable: script, arguments: ["onboard", "--json"]) }, owner: nil, open: { _ in false })
    let failed = expectation(description: "failed")
    failed.assertForOverFulfill = false
    let watch = coordinator.$state.sink { if case .failed = $0.phase { failed.fulfill() } }
    defer { watch.cancel() }
    coordinator.begin()
    wait(for: [failed], timeout: 10)
    guard case .failed(let failure) = coordinator.state.phase else { return XCTFail() }
    XCTAssertEqual(failure.kind, .engineStopped)
    XCTAssertTrue(failure.details.contains("The runtime is missing app/dist."))
    XCTAssertTrue(failure.details.contains("Exit status 2."))
    XCTAssertEqual(coordinator.state.unreadableLines, 1)
    XCTAssertFalse(coordinator.engineIsRunning)
  }

  func testAnEngineThatNeverSaysHelloFailsAfterTheTimeout() throws {
    let folder = try temporaryFolder(self)
    let script = try writeScript(folder.appendingPathComponent("clawdtime"), "while :; do sleep 1; done\n")
    let coordinator = SetupCoordinator(makeEngine: { _ in EngineProcess(executable: script, arguments: ["onboard", "--json"]) }, owner: nil, open: { _ in false }, helloTimeout: 0.3)
    let failed = expectation(description: "failed")
    failed.assertForOverFulfill = false
    let watch = coordinator.$state.sink { if case .failed = $0.phase { failed.fulfill() } }
    defer { watch.cancel() }
    coordinator.begin()
    wait(for: [failed], timeout: 10)
    guard case .failed(let failure) = coordinator.state.phase else { return XCTFail() }
    XCTAssertEqual(failure.kind, .noHello)
  }

  func testAMissingEngineFailsToStart() {
    let coordinator = SetupCoordinator(
      makeEngine: { _ in EngineProcess(executable: URL(fileURLWithPath: "/nonexistent/clawdtime"), arguments: ["onboard", "--json"]) },
      owner: nil, open: { _ in false })
    coordinator.begin()
    guard case .failed(let failure) = coordinator.state.phase else { return XCTFail("\(coordinator.state.phase)") }
    XCTAssertEqual(failure.kind, .engineDidNotStart)
  }

  func testTheChildEnvironmentAlwaysHasTheSystemFoldersOnItsPath() {
    let environment = childEnvironment(["PATH": "/opt/example/bin", "HOME": "/Users/example", "TERM_PROGRAM": "Terminal"])
    XCTAssertEqual(environment["PATH"], "/opt/example/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    XCTAssertNil(environment["TERM_PROGRAM"])
    XCTAssertEqual(childEnvironment([:])["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
  }
}
