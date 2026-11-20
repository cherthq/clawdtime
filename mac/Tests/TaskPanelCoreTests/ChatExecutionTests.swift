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
}
