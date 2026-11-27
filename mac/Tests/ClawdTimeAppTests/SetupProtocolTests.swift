import XCTest
@testable import ClawdTimeAppCore

final class SetupProtocolTests: XCTestCase {
  func testItReadsEveryEventType() throws {
    XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"hello","protocol":1,"version":"0.4.0"}"#), .hello(protocol: 1, version: "0.4.0"))
    XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"log","level":"warn","message":"Coordinator slow"}"#), .log(level: "warn", message: "Coordinator slow"))
    let step = try EngineEvent.decode(line: #"{"type":"step","id":"permissions","state":"needs_input","title":"Permissions","detail":"Allow Screen Recording.","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"},"input":{"kind":"choice","prompt":"Displays","options":[{"id":"1","label":"Built-in display","detail":"3024 x 1964"}],"multiple":true}}"#)
    guard case .step(let event) = step else { return XCTFail("not a step") }
    XCTAssertEqual(event.id, .permissions)
    XCTAssertEqual(event.state, .needsInput)
    XCTAssertEqual(event.recovery?.action, .openSettings)
    XCTAssertEqual(event.input?.kind, .choice)
    XCTAssertEqual(event.input?.options?.first?.detail, "3024 x 1964")
    XCTAssertTrue(event.input?.allowsMany == true)
    XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"done","ready":false,"report":[{"id":"model","state":"ready","detail":"Stored"},{"id":"phone","state":"skipped"}]}"#),
                   .done(ready: false, report: [ReportEntry(id: .model, state: .ready, detail: "Stored"), ReportEntry(id: .phone, state: .skipped)]))
  }

  func testEveryStepStateHasItsWireName() throws {
    for (wire, state) in [("pending", StepState.pending), ("in_progress", .inProgress), ("needs_input", .needsInput), ("ready", .ready), ("failed", .failed), ("skipped", .skipped)] {
      XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"step","id":"model","state":"\#(wire)"}"#), .step(StepEvent(id: .model, state: state)))
    }
  }

  func testUnknownTypesAndFieldsAreToleratedAndBadLinesRefused() throws {
    XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"progress","value":3}"#), .unknown(type: "progress"))
    XCTAssertEqual(try EngineEvent.decode(line: #"{"type":"hello","protocol":1,"version":"0.4.0","build":"x"}"#), .hello(protocol: 1, version: "0.4.0"))
    XCTAssertThrowsError(try EngineEvent.decode(line: "Starting ClawdTime")) { XCTAssertEqual($0 as? EngineEvent.DecodeError, .notJSON) }
    XCTAssertThrowsError(try EngineEvent.decode(line: "[1,2]")) { XCTAssertEqual($0 as? EngineEvent.DecodeError, .notJSON) }
    XCTAssertThrowsError(try EngineEvent.decode(line: #"{"id":"model"}"#)) { XCTAssertEqual($0 as? EngineEvent.DecodeError, .missingType) }
    XCTAssertThrowsError(try EngineEvent.decode(line: #"{"type":"step","id":"model","state":"sleeping"}"#)) { XCTAssertEqual($0 as? EngineEvent.DecodeError, .invalid("step")) }
  }

  func testCommandsAreOneLineOfJSONEach() throws {
    func object(_ command: EngineCommand) throws -> [String: Any] {
      let line = command.line()
      XCTAssertEqual(line.last, 0x0A)
      XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1, "exactly one newline")
      return try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
    }
    let text = try object(.input(id: .phone, value: .string("+14155550100\nsecond line")))
    XCTAssertEqual(text["type"] as? String, "input")
    XCTAssertEqual(text["id"] as? String, "phone")
    XCTAssertEqual(text["value"] as? String, "+14155550100\nsecond line")
    XCTAssertEqual(try object(.input(id: .computer, value: .bool(true)))["value"] as? Bool, true)
    XCTAssertEqual(try object(.input(id: .pairing, value: .strings(["view", "control"])))["value"] as? [String], ["view", "control"])
    let action = try object(.action(id: .permissions, action: .recheck))
    XCTAssertEqual(action["type"] as? String, "action")
    XCTAssertEqual(action["action"] as? String, "recheck")
    XCTAssertEqual(String(decoding: EngineCommand.cancel.line(), as: UTF8.self), "{\"type\":\"cancel\"}\n")
    XCTAssertEqual(String(decoding: EngineCommand.input(id: .model, value: .string("a/b")).line(), as: UTF8.self),
                   "{\"id\":\"model\",\"type\":\"input\",\"value\":\"a/b\"}\n")
  }

  func testACommandNeverShowsItsValueWhenPrintedDumpedOrReflected() {
    let command = EngineCommand.input(id: .model, value: .string(madeUpKey))
    var dumped = ""
    dump(command, to: &dumped)
    for text in [String(describing: command), String(reflecting: command), "\(command)", dumped, String(describing: [command])] {
      XCTAssertFalse(text.contains(madeUpKey), text)
      XCTAssertFalse(text.contains("STONEPAD"), text)
    }
    XCTAssertEqual(String(describing: command), "input(model, <redacted>)")
  }

  func testTheEngineGetsNoSecretOnItsCommandLine() {
    // --app: the app owns the desktop and the one connection, so setup starts no background connection.
    XCTAssertEqual(SetupProtocol.arguments(local: false), ["onboard", "--json", "--app"])
    XCTAssertEqual(SetupProtocol.arguments(local: true), ["onboard", "--json", "--app", "--local"])
  }

  func testStepsHaveTheirFixedOrderAndOnlySomeMayBeSkipped() {
    XCTAssertEqual(StepID.order.map(\.rawValue), ["preflight", "model", "desktop", "computer", "permissions", "phone", "pairing", "connection", "ready"])
    XCTAssertEqual(StepID.order.filter(\.isSkippable), [.computer, .phone, .pairing, .connection])
    for id in StepID.order { XCTAssertFalse(id.fallbackTitle.isEmpty) }
    XCTAssertEqual(StepID(rawValue: "voice").fallbackTitle, "Voice")
  }
}
