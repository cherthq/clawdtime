import Foundation
import XCTest
@testable import TaskPanelCore

final class ChatExecutionTests: XCTestCase {
  private let working = ChatExecution(configured: true, state: "running", canStop: true, message: "Working in this chat.")
  private let stopped = ChatExecution(configured: true, state: "stop_requested", canStop: false,
    message: "Stop requested; an action already underway may finish.")

  func testOlderTranscriptHasNoExecutorAndNoStop() throws {
    let json = #"{"version":1,"model":true,"speech":false,"voiceDirectory":"/tmp/voice","messages":[]}"#
    let transcript = try JSONDecoder().decode(ChatTranscript.self, from: Data(json.utf8))
    try transcript.validate()
    XCTAssertNil(transcript.execution)
    var control = ChatExecutionControl()
    control.receive(transcript.execution, readGeneration: 0)
    XCTAssertFalse(control.canStop)
    XCTAssertFalse(control.beginStop())
  }

  func testExecutionBoundsAndContradictoryAuthorityAreRefused() throws {
    try working.validate(); try stopped.validate()
    for value in [
      ChatExecution(configured: false, state: "running", canStop: true, message: "x"),
      ChatExecution(configured: true, state: "", canStop: true, message: "x"),
      ChatExecution(configured: true, state: "running\n", canStop: true, message: "x"),
      ChatExecution(configured: true, state: String(repeating: "x", count: 81), canStop: true, message: "x"),
      ChatExecution(configured: true, state: "running", canStop: true, message: String(repeating: "x", count: 2001))
    ] { XCTAssertThrowsError(try value.validate()) }
  }

  func testStopHasIndependentLaneAndOldReadsCannotRestoreIt() {
    var control = ChatExecutionControl()
    control.receive(working, readGeneration: 0)
    let beforeStop = control.generation
    XCTAssertTrue(control.beginStop())
    XCTAssertFalse(control.beginStop(), "No duplicate request while Stop is pending")
    let duringStop = control.generation
    control.receive(working, readGeneration: beforeStop)
    control.receive(working, readGeneration: duringStop)
    XCTAssertFalse(control.canStop)
    control.finishStop(stopped)
    control.receive(working, readGeneration: beforeStop)
    control.receive(working, readGeneration: duringStop)
    XCTAssertEqual(control.execution, stopped)
    XCTAssertFalse(control.canStop)
    XCTAssertEqual(control.notice, "Stop requested; an action already underway may finish.")
    // A genuinely fresh status may describe new work. No chat pending state gates Stop.
    control.receive(working, readGeneration: control.generation)
    XCTAssertTrue(control.canStop)
  }

  func testUnknownStopWaitsForFreshReadWithoutClaimingInterruption() {
    var control = ChatExecutionControl()
    control.receive(working, readGeneration: 0)
    XCTAssertTrue(control.beginStop())
    let staleRead = control.generation
    control.finishStop(nil)
    XCTAssertTrue(control.awaitingRead)
    XCTAssertFalse(control.canStop)
    XCTAssertEqual(control.notice, "Stop could not be confirmed. An action already underway may finish.")
    control.receive(working, readGeneration: staleRead)
    XCTAssertFalse(control.canStop)
    control.receive(stopped, readGeneration: control.generation)
    XCTAssertFalse(control.awaitingRead)
    XCTAssertEqual(control.execution, stopped)
    XCTAssertNil(control.notice)
  }
  func testDecisionPinsExactIDAndNeverRepostsAnUnknownAction() {
    var control = ChatExecutionControl()
    let pending = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review action.",
      pendingAction: .init(id: "action_1", description: "Click the selected button."))
    control.receive(pending, readGeneration: 0)
    XCTAssertTrue(control.canDecide)
    XCTAssertFalse(control.beginDecision("different"))
    XCTAssertTrue(control.beginDecision("action_1"))
    XCTAssertFalse(control.beginDecision("action_1"))
    XCTAssertTrue(control.canStop, "A decision request never disables independent Stop")
    let oldRead = control.generation
    control.finishDecision("action_1", value: nil)
    control.receive(pending, readGeneration: oldRead)
    XCTAssertFalse(control.canDecide)
    control.receive(pending, readGeneration: control.generation)
    XCTAssertFalse(control.canDecide, "A read cannot silently re-arm an attempted approval")
    let next = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review next action.",
      pendingAction: .init(id: "action_2", description: "Scroll the selected display."))
    control.receive(next, readGeneration: control.generation)
    XCTAssertTrue(control.canDecide)
  }

  func testStopWinsOverLateDecisionResponse() {
    var control = ChatExecutionControl()
    let pending = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review action.",
      pendingAction: .init(id: "action_1", description: "Type a short word."))
    control.receive(pending, readGeneration: 0)
    XCTAssertTrue(control.beginDecision("action_1"))
    XCTAssertTrue(control.beginStop())
    control.finishStop(stopped)
    control.finishDecision("action_1", value: working)
    XCTAssertEqual(control.execution, stopped)
    XCTAssertFalse(control.canStop)
    XCTAssertFalse(control.canDecide)
  }

  func testPendingActionIsOptionalAndBounded() throws {
    let value = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review action.",
      pendingAction: .init(id: "action_1", description: "Click the selected button."))
    try value.validate()
    XCTAssertEqual(try JSONDecoder().decode(ChatExecution.self, from: JSONEncoder().encode(value)), value)
    XCTAssertThrowsError(try ChatPendingAction(id: "../bad", description: "x").validate())
    XCTAssertThrowsError(try ChatPendingAction(id: "safe", description: String(repeating: "x", count: 2001)).validate())
    XCTAssertThrowsError(try ChatExecution(configured: false, state: "off", canStop: false, message: "Off", pendingAction: value.pendingAction).validate())
  }

  func testNativeHandoffIsExplicitAndKeepsStatusUntilWorkEnds() throws {
    let native = ChatExecution(configured: true, state: "idle", canStop: false, message: "Ready", mode: "native")
    let browser = ChatExecution(configured: true, state: "idle", canStop: false, message: "Ready", mode: "browser")
    try native.validate(); try browser.validate()
    XCTAssertTrue(NativeExecutionPresentation.releasesEditor(native))
    XCTAssertFalse(NativeExecutionPresentation.releasesEditor(browser))
    XCTAssertFalse(NativeExecutionPresentation.releasesEditor(working), "Old services retain their current editor behavior")
    XCTAssertTrue(NativeExecutionPresentation.visible(native, submissionPending: true, stopping: false))
    XCTAssertFalse(NativeExecutionPresentation.visible(native, submissionPending: false, stopping: false))
    XCTAssertTrue(NativeExecutionPresentation.visible(native, submissionPending: false, stopping: true))
    let pending = ChatExecution(configured: true, state: "approval", canStop: true, message: "Review",
      pendingAction: .init(id: "exact", description: "Click the shown button"), mode: "native")
    XCTAssertTrue(NativeExecutionPresentation.visible(pending, submissionPending: false, stopping: false))
    XCTAssertEqual(try JSONDecoder().decode(ChatExecution.self, from: JSONEncoder().encode(pending)), pending)
    XCTAssertThrowsError(try ChatExecution(configured: true, state: "idle", canStop: false, message: "Ready", mode: "remote").validate())
  }

}
