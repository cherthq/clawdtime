import XCTest
@testable import ClawdTimeAppCore

/// The coordinator with a scripted engine and a recording owner: no process runs.
@MainActor
final class SetupCoordinatorTests: XCTestCase {
  private var engine: ScriptedEngine!
  private var owner: RecordingOwner!
  private var opened: [URL] = []

  private func coordinator() -> SetupCoordinator {
    engine = ScriptedEngine()
    owner = RecordingOwner()
    opened = []
    let coordinator = SetupCoordinator(makeEngine: { [unowned self] _ in self.engine }, owner: owner, open: { [unowned self] url in self.opened.append(url); return true })
    coordinator.begin()
    engine.emit(#"{"type":"hello","protocol":1,"version":"0.4.0"}"#)
    return coordinator
  }

  func testAnAnswerGoesToTheStepOnScreenOnce() {
    let setup = coordinator()
    XCTAssertTrue(engine.started)
    setup.submit(.string("too early"))
    XCTAssertTrue(engine.sent.isEmpty, "nothing is asked yet")
    engine.emit(#"{"type":"step","id":"model","state":"needs_input","input":{"kind":"secret"}}"#)
    setup.submit(.string(madeUpKey))
    setup.submit(.string(madeUpKey))
    XCTAssertEqual(engine.sent, [.input(id: .model, value: .string(madeUpKey))], "a second press waits for the engine")
    XCTAssertEqual(setup.awaiting, .model)
    engine.emit(#"{"type":"step","id":"model","state":"in_progress"}"#)
    XCTAssertNil(setup.awaiting)
  }

  func testOnlyPhonePairingConnectionAndComputerMayBeSkipped() {
    let setup = coordinator()
    engine.emit(#"{"type":"step","id":"permissions","state":"needs_input","input":{"kind":"confirm"}}"#)
    setup.perform(.skip)
    XCTAssertTrue(engine.sent.isEmpty)
    for id in ["phone", "pairing", "connection", "computer"] {
      engine.emit(#"{"type":"step","id":"\#(id)","state":"needs_input","input":{"kind":"confirm"}}"#)
      setup.perform(.skip)
      XCTAssertEqual(engine.sent.last, .action(id: StepID(rawValue: id), action: .skip))
    }
  }

  func testOpenSettingsOpensOnlyASettingsPaneAndRechecksWhenThePersonComesBack() {
    let setup = coordinator()
    engine.emit(#"{"type":"step","id":"permissions","state":"needs_input","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}}"#)
    setup.applicationDidBecomeActive()
    XCTAssertTrue(engine.sent.isEmpty, "no recheck before the person went to System Settings")
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(opened.map(\.absoluteString), ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])
    setup.applicationDidBecomeActive()
    XCTAssertEqual(engine.sent, [.action(id: .permissions, action: .recheck)])
    engine.emit(#"{"type":"step","id":"permissions","state":"needs_input","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}}"#)
    setup.applicationDidBecomeActive()
    XCTAssertEqual(engine.sent.count, 1, "one recheck for each visit")
  }

  func testARecoveryLinkToAnythingElseIsRefused() {
    let setup = coordinator()
    for (action, url) in [("open_settings", "https://shop.example/settings"), ("open_url", "file:///etc/hosts"), ("open_url", "http://shop.example"), ("open_url", "x-apple.systempreferences:com.apple.preference.security"), ("open_url", "clawdtime://pair")] {
      engine.emit(#"{"type":"step","id":"phone","state":"failed","recovery":{"label":"Open","action":"\#(action)","url":"\#(url)"}}"#)
      XCTAssertFalse(setup.followRecovery(), url)
    }
    engine.emit(#"{"type":"step","id":"phone","state":"failed","recovery":{"label":"Read more","action":"open_url","url":"https://shop.example/help"}}"#)
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(opened.map(\.absoluteString), ["https://shop.example/help"])
    engine.emit(#"{"type":"step","id":"phone","state":"failed","recovery":{"label":"Retry","action":"retry"}}"#)
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(engine.sent, [.action(id: .phone, action: .retry)])
  }

  func testFinishStartsWhatTheReportSaysIsReady() {
    let local = coordinator()
    engine.emit(#"{"type":"done","ready":true,"report":[{"id":"desktop","state":"ready"},{"id":"connection","state":"skipped"}]}"#)
    XCTAssertTrue(owner.starts.isEmpty, "nothing starts before the person chooses Finish")
    var finished = 0
    local.onFinish = { finished += 1 }
    local.finish()
    XCTAssertEqual(owner.starts, [false])
    XCTAssertEqual(finished, 1)
    XCTAssertTrue(local.handedOff)

    let paired = coordinator()
    engine.emit(#"{"type":"done","ready":true,"report":[{"id":"desktop","state":"ready"},{"id":"connection","state":"ready"}]}"#)
    paired.finish()
    XCTAssertEqual(owner.starts, [true])

    let broken = coordinator()
    engine.emit(#"{"type":"done","ready":false,"report":[{"id":"desktop","state":"failed"}]}"#)
    broken.finish()
    XCTAssertTrue(owner.starts.isEmpty, "no desktop, nothing to own")
  }

  func testALaterLaunchFinishesByItselfWhenEverythingIsReady() {
    let setup = coordinator()
    setup.finishWhenReady = true
    engine.emit(#"{"type":"done","ready":true,"report":[{"id":"desktop","state":"ready"},{"id":"connection","state":"ready"}]}"#)
    XCTAssertEqual(owner.starts, [true])
    let notReady = coordinator()
    notReady.finishWhenReady = true
    engine.emit(#"{"type":"done","ready":false,"report":[{"id":"desktop","state":"ready"}]}"#)
    XCTAssertTrue(owner.starts.isEmpty)
  }

  func testStopCancelsTheEngineStopsTheOwnerAndIgnoresLateEvents() {
    let setup = coordinator()
    engine.emit(#"{"type":"step","id":"phone","state":"needs_input","input":{"kind":"phone"}}"#)
    let stoppedEngine = engine!
    var done = false
    setup.stop { done = true }
    XCTAssertTrue(stoppedEngine.cancelled)
    XCTAssertEqual(owner.stops, 1)
    XCTAssertTrue(done)
    XCTAssertEqual(setup.state.phase, .stopped)
    XCTAssertFalse(setup.engineIsRunning)
    stoppedEngine.emit(#"{"type":"step","id":"phone","state":"ready"}"#)
    stoppedEngine.onExit?(15, [])
    XCTAssertEqual(setup.state.phase, .stopped, "events after Stop change nothing")
  }

  func testAnotherProtocolCancelsTheEngineBeforeAnyStep() {
    engine = ScriptedEngine()
    let setup = SetupCoordinator(makeEngine: { [unowned self] _ in self.engine }, owner: nil, open: { _ in false })
    setup.begin()
    engine.emit(#"{"type":"hello","protocol":2,"version":"1.0.0"}"#)
    XCTAssertTrue(engine.cancelled)
    guard case .failed(let failure) = setup.state.phase else { return XCTFail() }
    XCTAssertEqual(failure.kind, .incompatible)
  }

  func testQuitEndsTheEngineAndTheOwnerBeforeItReplies() {
    let setup = coordinator()
    var replied = false
    setup.shutdown { replied = true }
    XCTAssertTrue(engine.cancelled)
    XCTAssertEqual(owner.stops, 1)
    XCTAssertTrue(replied)
  }

  func testARuntimeProblemIsShownAndCannotBeRetried() {
    let setup = SetupCoordinator(makeEngine: { _ in ScriptedEngine() }, owner: nil, open: { _ in false })
    setup.reportRuntimeProblem("The runtime has no node/bin/node.")
    guard case .failed(let failure) = setup.state.phase else { return XCTFail() }
    XCTAssertEqual(failure.kind, .runtimeMissing)
    XCTAssertEqual(failure.details, ["The runtime has no node/bin/node."])
  }
}
