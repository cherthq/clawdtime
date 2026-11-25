import Foundation
import XCTest
@testable import TaskPanelCore

/// The small window of the computer work shows only while a question of the worker waits for the
/// person: the question, Approve and No. It shows no status line and no running message, and it
/// hides at once when nothing waits. Stop is on the bar during every run.
final class ExecutionAskTests: XCTestCase {
  private func worker(_ state: String, canStop: Bool = true, message: String = "Working on: \"open the mail\". Step 3 of at most 40.",
                      waiting: String? = nil, configured: Bool = true) -> ChatExecution {
    ChatExecution(configured: configured, state: state, canStop: canStop, message: message, mode: "native", waiting: waiting)
  }
  private let held = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review action.",
    pendingAction: .init(id: "action_1", description: "Click the Send button."), mode: "native")

  func testTheWindowShowsOnlyWhileAQuestionWaits() throws {
    // Nothing waits for the person: no window, also while the work runs, stops, or after it ends.
    XCTAssertNil(ExecutionAsk.current(nil))
    XCTAssertNil(ExecutionAsk.current(worker("running")))
    XCTAssertNil(ExecutionAsk.current(worker("stopping", canStop: false, message: "Stopped. An action that was already sent may have finished.")))
    XCTAssertNil(ExecutionAsk.current(worker("completed", canStop: false, message: "Done.")))
    XCTAssertNil(ExecutionAsk.current(worker("idle", canStop: false, message: "Ready")))
    // A pause because the person took over is no question: the bar says "Waiting for you".
    XCTAssertNil(ExecutionAsk.current(worker("waiting_for_person", message: "Paused. Say continue to go on.", waiting: "takeover")))
    // A wait with no reason, a reason that a newer service adds, no words, or no engine: no window.
    XCTAssertNil(ExecutionAsk.current(worker("waiting_for_person", message: "May I click Send?")))
    XCTAssertNil(ExecutionAsk.current(worker("waiting_for_person", message: "May I click Send?", waiting: "later")))
    XCTAssertNil(ExecutionAsk.current(worker("waiting_for_person", message: "  \n ", waiting: "approval")))
    XCTAssertNil(ExecutionAsk.current(worker("waiting_for_person", canStop: false, message: "May I click Send?", waiting: "approval", configured: false)))
    XCTAssertNil(ExecutionAsk.current(worker("running", message: "May I click Send?", waiting: "approval")))

    // An approval or a question of the worker: the window shows its words, and the answer goes as words.
    let approval = try XCTUnwrap(ExecutionAsk.current(worker("waiting_for_person", message: " May I click Send? ", waiting: "approval")))
    XCTAssertEqual(approval.text, "May I click Send?")
    XCTAssertEqual(approval.route, .words)
    let question = try XCTUnwrap(ExecutionAsk.current(worker("waiting_for_person", message: "Which account, work or home?", waiting: "question")))
    XCTAssertEqual(question.route, .words)
    XCTAssertNotEqual(question.key, approval.key)
    // An action that the engine holds for a yes: the window shows it, and the answer goes to that id only.
    let action = try XCTUnwrap(ExecutionAsk.current(held))
    XCTAssertEqual(action.text, "Click the Send button.")
    XCTAssertEqual(action.route, .action(id: "action_1"))
    XCTAssertEqual(ExecutionAsk.yes, "yes"); XCTAssertEqual(ExecutionAsk.no, "no")
  }

  func testTheWorkerSnapshotDecodesWithItsReasonToWait() throws {
    // The fields that the service sends for the native worker, with some that the panel does not read.
    let json = #"{"requestId":"r1","configured":true,"mode":"native","state":"waiting_for_person","canStop":true,"message":"May I send the mail?","goal":"send the mail","waiting":"approval"}"#
    let value = try JSONDecoder().decode(ChatExecution.self, from: Data(json.utf8))
    try value.validate()
    XCTAssertEqual(value.waiting, "approval")
    XCTAssertEqual(ExecutionAsk.current(value)?.text, "May I send the mail?")
    // An older service sends no reason: nothing shows for its wait.
    let older = try JSONDecoder().decode(ChatExecution.self, from: Data(json.replacingOccurrences(of: #","waiting":"approval""#, with: "").utf8))
    try older.validate()
    XCTAssertNil(older.waiting)
    XCTAssertNil(ExecutionAsk.current(older))
    // A reason that is no plain word is refused.
    for bad in ["", "Approval!", "approval\n", String(repeating: "a", count: 41)] {
      XCTAssertThrowsError(try worker("waiting_for_person", waiting: bad).validate(), bad)
    }
    XCTAssertNoThrow(try worker("waiting_for_person", waiting: "takeover").validate())
  }

  func testOneQuestionTakesOneAnswerAndNothingIsSentAgain() throws {
    let first = try XCTUnwrap(ExecutionAsk.current(worker("waiting_for_person", message: "May I click Send?", waiting: "approval")))
    let other = try XCTUnwrap(ExecutionAsk.current(worker("waiting_for_person", message: "May I delete the draft?", waiting: "approval")))
    var answers = ExecutionAskAnswers()
    XCTAssertTrue(answers.canAnswer(first))
    XCTAssertTrue(answers.begin(first))
    XCTAssertFalse(answers.canAnswer(first), "a second click sends nothing")
    XCTAssertFalse(answers.begin(first))
    // A read that shows the same question again keeps it answered.
    answers.observe(first)
    XCTAssertFalse(answers.canAnswer(first))
    // Another question takes its own answer.
    XCTAssertTrue(answers.canAnswer(other))
    // Once the question no longer shows, it can be answered when it comes back.
    answers.observe(nil)
    XCTAssertTrue(answers.canAnswer(first))
    XCTAssertTrue(answers.begin(first))
    answers.observe(other)
    XCTAssertTrue(answers.canAnswer(first))
  }

  func testApproveAndNoWorkOnlyWhenTheAnswerCanGoNow() throws {
    var control = ChatExecutionControl()
    let answers = ExecutionAskAnswers()
    let asked = worker("waiting_for_person", message: "May I click Send?", waiting: "approval")
    control.receive(asked, readGeneration: control.generation)
    let words = try XCTUnwrap(ExecutionAsk.current(control.execution))
    XCTAssertTrue(ExecutionAsk.canAnswer(words, control: control, answers: answers, chatBusy: false, connected: true))
    XCTAssertFalse(ExecutionAsk.canAnswer(words, control: control, answers: answers, chatBusy: true, connected: true), "a message is on its way")
    XCTAssertFalse(ExecutionAsk.canAnswer(words, control: control, answers: answers, chatBusy: false, connected: false))
    // Stop wins: while a Stop is on its way, no answer goes.
    XCTAssertTrue(control.beginStop())
    XCTAssertFalse(ExecutionAsk.canAnswer(words, control: control, answers: answers, chatBusy: false, connected: true))

    // An action that the engine holds: the decision lane of that exact id.
    var lane = ChatExecutionControl()
    lane.receive(held, readGeneration: lane.generation)
    let action = try XCTUnwrap(ExecutionAsk.current(lane.execution))
    XCTAssertTrue(ExecutionAsk.canAnswer(action, control: lane, answers: answers, chatBusy: true, connected: true))
    XCTAssertTrue(lane.beginDecision("action_1"))
    XCTAssertFalse(ExecutionAsk.canAnswer(action, control: lane, answers: answers, chatBusy: false, connected: true))
    let stale = ExecutionAsk(text: "Click the Send button.", route: .action(id: "action_0"), key: "action|action_0")
    XCTAssertFalse(ExecutionAsk.canAnswer(stale, control: lane, answers: answers, chatBusy: false, connected: true))
  }

  func testTheBarWithStopStaysUpDuringEveryRun() {
    var control = ChatExecutionControl()
    control.receive(worker("running"), readGeneration: control.generation)
    // The panel's own hands show their own bar. Another engine gets the same bar from here.
    XCTAssertFalse(ExecutionStopBar.shows(control, ownHands: true, connected: true))
    XCTAssertTrue(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    XCTAssertFalse(ExecutionStopBar.shows(control, ownHands: false, connected: false), "a service that is gone commands nothing")
    // It stays up while the Stop is on its way and until a fresh read confirms it.
    XCTAssertTrue(control.beginStop())
    XCTAssertTrue(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    control.finishStop(nil)
    XCTAssertTrue(control.awaitingRead)
    XCTAssertTrue(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    control.receive(worker("stop_requested", canStop: false, message: "Stop requested."), readGeneration: control.generation)
    XCTAssertTrue(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    // Work that waits for the person can still stop: the bar stays.
    control.receive(worker("waiting_for_person", message: "May I click Send?", waiting: "approval"), readGeneration: control.generation)
    XCTAssertTrue(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    // Nothing runs: no bar.
    control.receive(worker("completed", canStop: false, message: "Done."), readGeneration: control.generation)
    XCTAssertFalse(ExecutionStopBar.shows(control, ownHands: false, connected: true))
    control.receive(nil, readGeneration: control.generation)
    XCTAssertFalse(ExecutionStopBar.shows(control, ownHands: false, connected: true))
  }
}
