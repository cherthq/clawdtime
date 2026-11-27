import XCTest
@testable import ClawdTimeAppCore

final class SetupStateTests: XCTestCase {
  private func running() -> SetupState {
    var state = SetupState()
    state.begin()
    state.apply(.hello(protocol: 2, version: "0.4.0"))
    return state
  }

  func testHelloStartsTheRunAndAnotherProtocolStopsIt() {
    var state = SetupState()
    state.begin()
    XCTAssertEqual(state.phase, .connecting)
    state.apply(.hello(protocol: 2, version: "0.4.0"))
    XCTAssertEqual(state.phase, .running)
    XCTAssertEqual(state.engineVersion, "0.4.0")

    var newer = SetupState()
    newer.begin()
    newer.apply(.hello(protocol: 3, version: "0.9.0"))
    guard case .failed(let failure) = newer.phase else { return XCTFail("\(newer.phase)") }
    XCTAssertEqual(failure.kind, .incompatible)
    newer.apply(.step(StepEvent(id: .model, state: .needsInput)))
    XCTAssertNil(newer.current, "nothing runs after a protocol mismatch")
  }

  func testTheFocusFollowsTheLatestStepThatIsNotPending() {
    var state = running()
    state.apply(.step(StepEvent(id: .preflight, state: .inProgress)))
    XCTAssertEqual(state.focus, .preflight)
    state.apply(.step(StepEvent(id: .model, state: .pending)))
    XCTAssertEqual(state.focus, .preflight, "a pending announcement does not move the window")
    state.apply(.step(StepEvent(id: .preflight, state: .ready)))
    state.apply(.step(StepEvent(id: .model, state: .needsInput, title: "Model key", input: StepInput(kind: .secret))))
    XCTAssertEqual(state.focus, .model)
    XCTAssertEqual(state.current?.displayTitle, "Model key")
    XCTAssertEqual(state.position, 2)
    XCTAssertEqual(state.settledCount, 1)
    XCTAssertEqual(state.progress, 1.0 / 9.0, accuracy: 0.0001)
  }

  func testAnUnknownStepIsDrawnAfterTheKnownOnes() {
    var state = running()
    state.apply(.step(StepEvent(id: "voice", state: .needsInput)))
    XCTAssertEqual(state.order.last, "voice")
    XCTAssertEqual(state.order.count, 10)
    XCTAssertEqual(state.current?.displayTitle, "Voice")
  }

  func testDoneKeepsTheReportAndSettlesEachStep() {
    var state = running()
    state.apply(.step(StepEvent(id: .model, state: .needsInput, input: StepInput(kind: .secret))))
    state.apply(.done(ready: true, report: [ReportEntry(id: .model, state: .ready, detail: "Stored"), ReportEntry(id: .phone, state: .skipped)], setupDesktop: false))
    XCTAssertEqual(state.phase, .finished(ready: true))
    XCTAssertEqual(state.reported(.phone), .skipped)
    XCTAssertEqual(state.state(of: .model), .ready)
    XCTAssertNil(state.steps[.model]?.input, "no field is left open after done")
    XCTAssertEqual(state.summary.map(\.id), [.model, .phone])
  }

  func testWarningsAreKeptButInfoLogsAreNot() {
    var state = running()
    state.apply(.log(level: "info", message: "Starting the desktop"))
    XCTAssertTrue(state.warnings.isEmpty)
    for index in 0..<8 { state.apply(.log(level: "warn", message: "Coordinator slow \(index)")) }
    XCTAssertEqual(state.warnings.count, 5)
    XCTAssertEqual(state.warnings.last, "Coordinator slow 7")
  }

  func testAnEngineThatLeavesBeforeDoneIsAFailureAndAfterDoneIsNot() {
    var early = running()
    early.engineExited(code: 1, details: ["Node could not start"])
    guard case .failed(let failure) = early.phase else { return XCTFail("\(early.phase)") }
    XCTAssertEqual(failure.kind, .engineStopped)
    XCTAssertTrue(failure.details.contains("Node could not start"))

    var missing = SetupState()
    missing.begin()
    missing.engineExited(code: 127, details: [])
    guard case .failed(let notStarted) = missing.phase else { return XCTFail("\(missing.phase)") }
    XCTAssertEqual(notStarted.kind, .engineDidNotStart)

    var finished = running()
    finished.apply(.done(ready: true, report: [], setupDesktop: false))
    finished.engineExited(code: 0, details: [])
    XCTAssertEqual(finished.phase, .finished(ready: true))

    var stopped = running()
    stopped.stopped()
    stopped.engineExited(code: 15, details: [])
    XCTAssertEqual(stopped.phase, .stopped)
  }

  func testNoHelloIsAFailureOnlyWhileConnecting() {
    var state = SetupState()
    state.begin()
    state.noHello()
    guard case .failed(let failure) = state.phase else { return XCTFail("\(state.phase)") }
    XCTAssertEqual(failure.kind, .noHello)
    var later = running()
    later.noHello()
    XCTAssertEqual(later.phase, .running)
  }
}
