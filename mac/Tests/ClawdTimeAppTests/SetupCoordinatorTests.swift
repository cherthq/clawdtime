import XCTest
@testable import ClawdTimeAppCore

/// The coordinator with a scripted engine and a recording owner: no process runs.
@MainActor
final class SetupCoordinatorTests: XCTestCase {
  private var engine: ScriptedEngine!
  private var owner: RecordingOwner!
  private var opened: [URL] = []
  /// The coordinator's clock, moved by hand.
  private var clock: TimeInterval = 1000

  private func coordinator(answerDelay: TimeInterval = 0) -> SetupCoordinator {
    engine = ScriptedEngine()
    owner = RecordingOwner()
    opened = []
    let coordinator = SetupCoordinator(makeEngine: { [unowned self] _ in self.engine }, owner: owner, open: { [unowned self] url in self.opened.append(url); return true },
                                       answerDelay: answerDelay, now: { [unowned self] in self.clock })
    coordinator.begin()
    engine.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    return coordinator
  }

  /// One question of a step, with its one-time id.
  private func ask(_ id: String, _ question: String, _ more: String = #""input":{"kind":"confirm","consent":true}"#) {
    engine.emit(#"{"type":"step","id":"\#(id)","state":"needs_input","question":"\#(question)",\#(more)}"#)
  }

  func testAnAnswerGoesToTheQuestionOnScreenOnce() {
    let setup = coordinator()
    XCTAssertTrue(engine.started)
    setup.submit(.string("too early"))
    XCTAssertTrue(engine.sent.isEmpty, "nothing is asked yet")
    ask("model", "model-question-0001", #""input":{"kind":"secret"}"#)
    setup.submit(.string(madeUpKey))
    setup.submit(.string(madeUpKey))
    XCTAssertEqual(engine.sent, [.input(id: .model, question: "model-question-0001", value: .string(madeUpKey))], "a second press waits for the engine")
    XCTAssertEqual(setup.answered, "model-question-0001")
    engine.emit(#"{"type":"step","id":"model","state":"in_progress"}"#)
    XCTAssertNil(setup.answered)
  }

  func testTheSecondClickOfADoubleClickNeverAnswersTheNextQuestion() {
    let setup = coordinator(answerDelay: 0.6)
    ask("pairing", "view-question-0001", #""input":{"kind":"confirm","prompt":"Allow this display to be shown during your verified calls?","consent":true}"#)
    setup.submit(.bool(true))
    XCTAssertTrue(engine.sent.isEmpty, "a click as the question appears answers nothing")
    clock += 1
    setup.submit(.bool(true))
    setup.submit(.bool(true))
    // The engine asks the next question at once, before the second click lands.
    ask("pairing", "control-question-01", #""input":{"kind":"confirm","prompt":"Allow your verified phone to ask for computer actions on this Mac?","consent":true}"#)
    clock += 0.2
    setup.submit(.bool(true))
    XCTAssertEqual(engine.sent, [.input(id: .pairing, question: "view-question-0001", value: .bool(true))], "one answer, to the view question")
    // The person reads the new question, then answers it.
    clock += 1
    setup.submit(.bool(false))
    XCTAssertEqual(engine.sent.last, .input(id: .pairing, question: "control-question-01", value: .bool(false)))
    XCTAssertEqual(engine.sent.count, 2)
  }

  func testAStepWithNoQuestionTakesNoAnswer() {
    let setup = coordinator()
    engine.emit(#"{"type":"step","id":"computer","state":"needs_input","input":{"kind":"confirm","consent":true}}"#)
    setup.submit(.bool(true))
    setup.perform(.skip)
    engine.emit(#"{"type":"step","id":"phone","state":"failed","recovery":{"label":"Retry","action":"retry"}}"#)
    setup.perform(.retry)
    XCTAssertTrue(engine.sent.isEmpty)
  }

  func testOnlyPhonePairingConnectionAndComputerMayBeSkipped() {
    let setup = coordinator()
    ask("permissions", "permissions-question-1", #""input":{"kind":"confirm"}"#)
    setup.perform(.skip)
    XCTAssertTrue(engine.sent.isEmpty)
    for id in ["phone", "pairing", "connection", "computer"] {
      ask(id, "\(id)-question-000001", #""input":{"kind":"confirm"}"#)
      setup.perform(.skip)
      XCTAssertEqual(engine.sent.last, .action(id: StepID(rawValue: id), question: "\(id)-question-000001", action: .skip))
    }
  }

  func testOpenSettingsOpensOnlyASettingsPaneAndRechecksWhenThePersonComesBack() {
    let setup = coordinator()
    let settings = #""recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}"#
    ask("permissions", "settings-question-01", settings)
    setup.applicationDidBecomeActive()
    XCTAssertTrue(engine.sent.isEmpty, "no recheck before the person went to System Settings")
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(opened.map(\.absoluteString), ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])
    setup.applicationDidBecomeActive()
    XCTAssertEqual(engine.sent, [.action(id: .permissions, question: "settings-question-01", action: .recheck)])
    ask("permissions", "settings-question-02", settings)
    setup.applicationDidBecomeActive()
    XCTAssertEqual(engine.sent.count, 1, "one recheck for each visit")
  }

  func testARecoveryLinkToAnythingElseIsRefused() {
    let setup = coordinator()
    for (action, url) in [("open_settings", "https://shop.example/settings"), ("open_url", "file:///etc/hosts"), ("open_url", "http://shop.example"), ("open_url", "x-apple.systempreferences:com.apple.preference.security"), ("open_url", "clawdtime://pair")] {
      engine.emit(#"{"type":"step","id":"phone","state":"failed","question":"phone-failed-000001","recovery":{"label":"Open","action":"\#(action)","url":"\#(url)"}}"#)
      XCTAssertFalse(setup.followRecovery(), url)
    }
    engine.emit(#"{"type":"step","id":"phone","state":"failed","question":"phone-failed-000002","recovery":{"label":"Read more","action":"open_url","url":"https://shop.example/help"}}"#)
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(opened.map(\.absoluteString), ["https://shop.example/help"])
    engine.emit(#"{"type":"step","id":"phone","state":"failed","question":"phone-failed-000003","recovery":{"label":"Retry","action":"retry"}}"#)
    XCTAssertTrue(setup.followRecovery())
    XCTAssertEqual(engine.sent, [.action(id: .phone, question: "phone-failed-000003", action: .retry)])
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
    ask("phone", "phone-question-0001", #""input":{"kind":"phone"}"#)
    let stoppedEngine = engine!
    var done = false
    setup.stop { done = true }
    XCTAssertTrue(stoppedEngine.cancelled)
    XCTAssertEqual(owner.stops, 1)
    XCTAssertEqual(setup.state.phase, .stopped)
    XCTAssertFalse(setup.engineIsRunning)
    stoppedEngine.emit(#"{"type":"step","id":"phone","state":"ready"}"#)
    stoppedEngine.leave(code: 15)
    XCTAssertTrue(done)
    XCTAssertEqual(setup.state.phase, .stopped, "events after Stop change nothing")
  }

  func testStopGivesTheEngineTimeToEndTheDesktopItWasStarting() {
    let setup = coordinator()
    engine.emit(#"{"type":"step","id":"desktop","state":"in_progress"}"#)
    let stoppedEngine = engine!
    var done = false
    setup.stop { done = true }
    // A first desktop start can take many seconds: SIGTERM only after the grace time.
    XCTAssertGreaterThanOrEqual(stoppedEngine.grace ?? 0, 15)
    XCTAssertFalse(done, "Stop is done only when the engine has left")
    XCTAssertTrue(setup.isStopping)
    stoppedEngine.leave()
    XCTAssertTrue(done)
    XCTAssertFalse(setup.isStopping)
  }

  func testANewRunStartsOnlyAfterTheStoppedEngineHasLeft() {
    var made = 0
    let first = ScriptedEngine(), second = ScriptedEngine()
    let setup = SetupCoordinator(makeEngine: { _ in made += 1; return made == 1 ? first : second }, owner: nil, open: { _ in false })
    setup.begin()
    first.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    setup.stop()
    setup.begin()
    XCTAssertEqual(made, 1, "two engines never run at once")
    first.leave()
    XCTAssertEqual(made, 2)
    XCTAssertTrue(second.started)
  }

  func testAnotherProtocolCancelsTheEngineBeforeAnyStep() {
    engine = ScriptedEngine()
    let setup = SetupCoordinator(makeEngine: { [unowned self] _ in self.engine }, owner: nil, open: { _ in false })
    setup.begin()
    engine.emit(#"{"type":"hello","protocol":3,"version":"1.0.0"}"#)
    XCTAssertTrue(engine.cancelled)
    guard case .failed(let failure) = setup.state.phase else { return XCTFail() }
    XCTAssertEqual(failure.kind, .incompatible)
  }

  func testQuitEndsTheEngineAndTheOwnerBeforeItReplies() {
    let setup = coordinator()
    var replied = false
    setup.shutdown { replied = true }
    XCTAssertTrue(engine.cancelled)
    XCTAssertGreaterThanOrEqual(engine.grace ?? 0, 15)
    XCTAssertEqual(owner.stops, 1)
    XCTAssertFalse(replied, "the app quits only after the engine has left")
    engine.leave()
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
