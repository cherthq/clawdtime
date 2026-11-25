import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// The contract between the task service and the hands. Every JSON text here is
/// written by hand from `connectors/computer/ports.ts`.
final class HandsContractTests: XCTestCase {
  func command(_ json: String) throws -> HandCommand { try JSONDecoder().decode(HandCommand.self, from: Data(json.utf8)) }
  func next(_ json: String) throws -> HandsNext {
    let value = try JSONDecoder().decode(HandsNext.self, from: Data(json.utf8))
    try value.validate()
    return value
  }
  func object(_ data: Data) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary) }
  func sorted(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }
  let run = #""run":{"active":true,"goal":"Save the note","step":3,"state":"running"}"#
  let observationJSON = """
    {"at":1795170939254,"screen":{"width":1512,"height":982,"scale":2},"cursor":{"x":640.5,"y":300},
     "app":{"name":"Notes","bundleId":"com.apple.Notes","window":"All iCloud"},
     "elements":[
       {"id":0,"role":"AXButton","title":"Save","x":100,"y":40,"w":64,"h":24,"enabled":true,"focused":false,"secure":false},
       {"id":1,"role":"AXTextField","title":"Name","value":"Ada","x":100,"y":80,"w":200,"h":24,"enabled":true,"focused":true,"secure":false},
       {"id":2,"role":"AXTextField","title":"Password","x":100,"y":120,"w":200,"h":24,"enabled":true,"focused":false,"secure":true}],
     "image":"/9j/4AAQSkZJRg==","imageWidth":1280,"imageHeight":831}
    """

  func testEveryCommandKindDecodesAndEncodesAsTheContractWritesIt() throws {
    let cases: [(String, HandCommand)] = [
      (#"{"kind":"observe","image":true,"elements":false}"#, .observe(image: true, elements: false)),
      (#"{"kind":"move","x":120.5,"y":64}"#, .move(x: 120.5, y: 64)),
      (#"{"kind":"click","x":10,"y":20,"button":"left","count":1}"#, .click(x: 10, y: 20, button: .left, count: 1)),
      (#"{"kind":"click","x":10,"y":20,"button":"right","count":2}"#, .click(x: 10, y: 20, button: .right, count: 2)),
      (#"{"kind":"drag","fromX":1,"fromY":2,"toX":300,"toY":400.25}"#, .drag(fromX: 1, fromY: 2, toX: 300, toY: 400.25)),
      (#"{"kind":"scroll","x":500,"y":400,"dx":0,"dy":-3}"#, .scroll(x: 500, y: 400, dx: 0, dy: -3)),
      (#"{"kind":"type","text":"Grüße, 世界 👋\nline two"}"#, .type(text: "Grüße, 世界 👋\nline two")),
      (#"{"kind":"key","combo":"cmd+shift+4"}"#, .key(combo: "cmd+shift+4")),
      (#"{"kind":"open_app","name":"Safari"}"#, .openApp(name: "Safari")),
      (#"{"kind":"open_app","name":"TextEdit","window":"Disposable note"}"#, .openApp(name: "TextEdit", window: "Disposable note")),
      (#"{"kind":"switch_previous_app"}"#, .switchPreviousApp),
      (#"{"kind":"switch_desktop","direction":"left"}"#, .switchDesktop(direction: .left)),
      (#"{"kind":"switch_desktop","direction":"right"}"#, .switchDesktop(direction: .right)),
      (#"{"kind":"switch_desktop","direction":"previous"}"#, .switchDesktop(direction: .previous)),
      (#"{"kind":"open_url","url":"https://example.com/a?b=1"}"#, .openURL(url: "https://example.com/a?b=1")),
      (#"{"kind":"open_url","url":"https://example.com/a?b=1","browser":"Fixture Browser"}"#, .openURL(url: "https://example.com/a?b=1", browser: "Fixture Browser")),
      (#"{"kind":"quit_app","name":"TextEdit"}"#, .quitApp(name: "TextEdit")),
      (#"{"kind":"wait","ms":250}"#, .wait(ms: 250)),
      (#"{"kind":"zoom","x":900,"y":600.5,"w":240,"h":150,"width":960,"height":600}"#,
       .zoom(x: 900, y: 600.5, w: 240, h: 150, width: 960, height: 600)),
    ]
    XCTAssertEqual(Set(cases.map { $0.1.kind }),
      ["observe", "move", "click", "drag", "scroll", "type", "key", "open_app", "switch_desktop", "switch_previous_app", "open_url", "quit_app", "wait",
       "zoom"])
    for (json, expected) in cases {
      let decoded = try command(json)
      XCTAssertEqual(decoded, expected, json)
      // What it encodes is the same object, key for key, and it reads back the same.
      let encoded = try JSONEncoder().encode(decoded)
      XCTAssertEqual(try object(encoded), try object(Data(json.utf8)), json)
      XCTAssertEqual(try JSONDecoder().decode(HandCommand.self, from: encoded), expected)
    }
  }

  func testACommandOutsideTheContractIsRefusedAndNeverRun() {
    let long = String(repeating: "a", count: 4001), wave = String(repeating: "👋", count: 2001)
    let refused = [
      #"{"kind":"switch_previous_app","direction":"left"}"#,
      #"{"kind":"switch_previous_app","count":2}"#,
      #"{"kind":"shell","command":"ls"}"#,
      #"{"image":true,"elements":true}"#,
      #"{"kind":"move","x":1,"y":2,"z":3}"#,
      #"{"kind":"move","x":1}"#,
      #"{"kind":"move","x":"1","y":2}"#,
      #"{"kind":"observe","image":1,"elements":true}"#,
      #"{"kind":"observe","image":true,"elements":true,"window":"all"}"#,
      // A closer look with no size, a picture outside the limits, or a field more.
      #"{"kind":"zoom","x":1,"y":2,"w":4,"h":150,"width":960,"height":600}"#,
      #"{"kind":"zoom","x":1,"y":2,"w":240,"h":150,"width":4000,"height":600}"#,
      #"{"kind":"zoom","x":1,"y":2,"w":240,"h":150,"width":960}"#,
      #"{"kind":"zoom","x":1,"y":2,"w":240,"h":150,"width":960,"height":600,"elements":true}"#,
      #"{"kind":"click","x":1,"y":2,"button":"middle","count":1}"#,
      #"{"kind":"click","x":1,"y":2,"button":"left","count":3}"#,
      #"{"kind":"click","x":1,"y":2,"button":"left","count":0}"#,
      #"{"kind":"click","x":1,"y":2,"button":"left"}"#,
      #"{"kind":"drag","fromX":1,"fromY":2,"toX":3}"#,
      #"{"kind":"scroll","x":1,"y":2,"dy":3}"#,
      #"{"kind":"type","text":"\#(long)"}"#,
      #"{"kind":"type","text":"\#(wave)"}"#,
      #"{"kind":"type","text":"a","submit":true}"#,
      #"{"kind":"key","combo":"\#(String(repeating: "k", count: 41))"}"#,
      #"{"kind":"open_app","name":"\#(String(repeating: "n", count: 121))"}"#,
      #"{"kind":"open_url","url":"https://example.com/\#(String(repeating: "u", count: 2000))"}"#,
      #"{"kind":"open_url","url":"https://example.com","browser":""}"#,
      #"{"kind":"open_url","url":"https://example.com","browser":"../Fixture"}"#,
      #"{"kind":"open_url","url":"https://example.com","browser":"\#(String(repeating: "n", count: 121))"}"#,
      #"{"kind":"open_url","url":"https://example.com","browser":7}"#,
      #"{"kind":"open_url","url":"https://example.com","app":"Fixture Browser"}"#,
      #"{"kind":"switch_desktop","direction":"up"}"#,
      #"{"kind":"switch_desktop","direction":"left","steps":2}"#,
      #"{"kind":"switch_desktop","direction":"left","shortcut":"ctrl+left"}"#,
      #"{"kind":"switch_desktop"}"#,
      #"{"kind":"wait","ms":10001}"#,
      #"{"kind":"wait","ms":-1}"#,
      #"{"kind":"wait","ms":2.5}"#,
    ]
    for json in refused { XCTAssertThrowsError(try command(json), json) }
    // The limits themselves are inside the contract. A text limit counts UTF-16 units.
    XCTAssertNoThrow(try command(#"{"kind":"type","text":"\#(String(repeating: "a", count: 4000))"}"#))
    XCTAssertNoThrow(try command(#"{"kind":"type","text":"\#(String(repeating: "👋", count: 2000))"}"#))
    XCTAssertNoThrow(try command(#"{"kind":"wait","ms":10000}"#))
    XCTAssertNoThrow(try command(#"{"kind":"wait","ms":0}"#))
  }

  func testTheNextCommandAndTheRunAreReadAsTheServiceSendsThem() throws {
    let waiting = try next(#"{"version":1,"command":{"seq":12,"command":{"kind":"click","x":640,"y":400,"button":"left","count":1},"label":"Click Save"},\#(run)}"#)
    XCTAssertEqual(waiting, HandsNext(command: .init(seq: 12, command: .click(x: 640, y: 400, button: .left, count: 1), label: "Click Save"),
      run: .init(active: true, goal: "Save the note", step: 3, state: "running")))
    let idle = try next(#"{"version":1,"command":null,"run":{"active":false,"goal":"","step":0,"state":"idle"}}"#)
    XCTAssertNil(idle.command); XCTAssertFalse(idle.run.active)
    // With no command the key still holds null, and it reads back the same.
    let encoded = try JSONEncoder().encode(idle)
    XCTAssertTrue(try object(encoded)["command"] is NSNull)
    XCTAssertEqual(try JSONDecoder().decode(HandsNext.self, from: encoded), idle)
    XCTAssertEqual(try JSONDecoder().decode(HandsNext.self, from: try JSONEncoder().encode(waiting)), waiting)
  }

  func testAReadOutsideTheContractIsRefused() {
    let label = String(repeating: "l", count: 121), goal = String(repeating: "g", count: 201), state = String(repeating: "s", count: 41)
    let refused = [
      #"{"version":2,"command":null,\#(run)}"#,
      #"{"version":1,\#(run)}"#,
      #"{"version":1,"command":null}"#,
      #"{"version":1,"command":null,\#(run),"extra":true}"#,
      #"{"version":1,"command":null,"run":{"active":true,"goal":"g","step":1,"state":"running","pid":4}}"#,
      #"{"version":1,"command":null,"run":{"active":true,"goal":"g","step":-1,"state":"running"}}"#,
      #"{"version":1,"command":null,"run":{"active":true,"goal":"\#(goal)","step":1,"state":"running"}}"#,
      #"{"version":1,"command":null,"run":{"active":true,"goal":"g","step":1,"state":"\#(state)"}}"#,
      #"{"version":1,"command":null,"run":{"active":"yes","goal":"g","step":1,"state":"running"}}"#,
      #"{"version":1,"command":{"seq":0,"command":{"kind":"wait","ms":1},"label":"Wait"},\#(run)}"#,
      #"{"version":1,"command":{"seq":1.5,"command":{"kind":"wait","ms":1},"label":"Wait"},\#(run)}"#,
      #"{"version":1,"command":{"seq":1,"command":{"kind":"wait","ms":1}},\#(run)}"#,
      #"{"version":1,"command":{"seq":1,"command":{"kind":"wait","ms":1},"label":"\#(label)"},\#(run)}"#,
      #"{"version":1,"command":{"seq":1,"command":{"kind":"wait","ms":1},"label":"Wait","again":true},\#(run)}"#,
      #"{"version":1,"command":{"seq":1,"command":{"kind":"paste","text":"x"},"label":"Paste"},\#(run)}"#,
    ]
    for json in refused { XCTAssertThrowsError(try next(json), json) }
  }

  func testAResultWithNoObservationCarriesOnlyWhatTheContractNames() throws {
    XCTAssertEqual(try sorted(HandResult.done(7)), #"{"ok":true,"seq":7}"#)
    XCTAssertEqual(try sorted(HandResult.done(7, interrupted: true)), #"{"interrupted":true,"ok":true,"seq":7}"#)
    XCTAssertEqual(try sorted(HandResult.failure(8, .stoppedByPerson)), #"{"error":"stopped_by_person","ok":false,"seq":8}"#)
    XCTAssertEqual(try sorted(HandResult.failure(9, .failed, interrupted: true)), #"{"error":"failed","interrupted":true,"ok":false,"seq":9}"#)
    // The words for an error are the contract's own, in its order.
    XCTAssertEqual(HandError.allCases.map(\.rawValue),
      ["no_accessibility", "no_screen_recording", "stopped_by_person", "not_found", "refused", "failed",
       "desktop_disabled", "desktop_shortcut_unavailable", "desktop_history_unavailable", "ambiguous_target", "unsupported_desktop", "target_not_visible", "desktop_unchanged", "transition_unknown", "input_unknown", "stale_observation"])
    let read = try JSONDecoder().decode(HandResult.self, from: Data(#"{"seq":4,"ok":false,"error":"no_screen_recording"}"#.utf8))
    XCTAssertEqual(read, .failure(4, .noScreenRecording))
    XCTAssertNil(read.observation); XCTAssertNil(read.interrupted)
    XCTAssertThrowsError(try JSONDecoder().decode(HandResult.self, from: Data(#"{"seq":4,"ok":false,"error":"busy"}"#.utf8)))
  }

  func testAResultWithAnObservationReadsAndWritesEveryFieldOfTheContract() throws {
    let read = try JSONDecoder().decode(HandResult.self, from: Data(#"{"seq":5,"ok":true,"observation":\#(observationJSON)}"#.utf8))
    let seen = try XCTUnwrap(read.observation)
    XCTAssertEqual(seen.screen, .init(width: 1512, height: 982, scale: 2))
    XCTAssertEqual(seen.cursor, .init(x: 640.5, y: 300))
    XCTAssertEqual(seen.app, .init(name: "Notes", bundleId: "com.apple.Notes", window: "All iCloud"))
    XCTAssertEqual(seen.elements.map(\.role), ["AXButton", "AXTextField", "AXTextField"])
    XCTAssertEqual(seen.elements.map(\.value), [nil, "Ada", nil])
    XCTAssertEqual(seen.elements.map(\.secure), [false, false, true])
    XCTAssertEqual(seen.imageWidth, 1280); XCTAssertEqual(seen.imageHeight, 831)
    try read.validate()

    // Written again, it is the same object key for key: nothing more and nothing less.
    let written = try object(try JSONEncoder().encode(read))
    XCTAssertEqual(written, try object(Data(#"{"seq":5,"ok":true,"observation":\#(observationJSON)}"#.utf8)))
    XCTAssertEqual(Set(written.allKeys as? [String] ?? []), ["seq", "ok", "observation"])
    let observation = try XCTUnwrap(written["observation"] as? NSDictionary)
    XCTAssertEqual(Set(observation.allKeys as? [String] ?? []), ["at", "screen", "cursor", "app", "elements", "image", "imageWidth", "imageHeight"])
    let elements = try XCTUnwrap(observation["elements"] as? [NSDictionary])
    XCTAssertEqual(Set(elements[1].allKeys as? [String] ?? []), ["id", "role", "title", "value", "x", "y", "w", "h", "enabled", "focused", "secure"])
    // A secure field has no value key at all.
    XCTAssertNil(elements[2]["value"])

    // With no picture asked for, the three picture keys are absent.
    let plain = Observation(at: 1, screen: seen.screen, cursor: seen.cursor, app: seen.app, elements: [])
    let keys = try object(try JSONEncoder().encode(HandResult.done(6, observation: plain)))["observation"] as? NSDictionary
    XCTAssertEqual(Set(keys?.allKeys as? [String] ?? []), ["at", "screen", "cursor", "app", "elements"])
  }

  func testAResultThatTheServiceWouldRefuseIsNotSent() throws {
    let screen = Observation.Screen(width: 1512, height: 982, scale: 2), cursor = Observation.Cursor(x: 1, y: 1)
    let app = Observation.App(name: "Notes", bundleId: "com.apple.Notes", window: "")
    func element(title: String = "Save", value: String? = nil, secure: Bool = false, x: Double = 1) -> ScreenElement {
      ScreenElement(id: 0, role: "AXButton", title: title, value: value, x: x, y: 1, w: 10, h: 10, enabled: true, focused: false, secure: secure)
    }
    func result(_ elements: [ScreenElement] = [], app other: Observation.App? = nil, image: String? = nil, width: Int? = nil) -> HandResult {
      .done(1, observation: Observation(at: 1, screen: screen, cursor: cursor, app: other ?? app,
                                        elements: elements, image: image, imageWidth: width, imageHeight: width))
    }
    XCTAssertNoThrow(try result([element()], image: "abcd", width: 2).validate())
    XCTAssertNoThrow(try result(Array(repeating: element(), count: 400)).validate())
    XCTAssertThrowsError(try result(Array(repeating: element(), count: 401)).validate())
    XCTAssertThrowsError(try result([element(title: String(repeating: "t", count: 201))]).validate())
    XCTAssertThrowsError(try result([element(value: String(repeating: "👋", count: 101))]).validate())
    XCTAssertThrowsError(try result([element(value: "hunter2", secure: true)]).validate())
    XCTAssertThrowsError(try result([element(x: .infinity)]).validate())
    XCTAssertThrowsError(try result(app: .init(name: String(repeating: "n", count: 121), bundleId: "", window: "")).validate())
    XCTAssertThrowsError(try result(image: String(repeating: "A", count: 4_000_001), width: 2).validate())
    XCTAssertThrowsError(try result(image: "abcd", width: 0).validate())
    XCTAssertThrowsError(try HandResult(seq: 0, ok: true).validate())
    XCTAssertThrowsError(try HandResult(seq: 1, ok: true, error: .failed).validate())
  }

  func testEachCommandNamesTheRightThatItNeeds() {
    let both = HandCommand.observe(image: true, elements: true)
    XCTAssertEqual(both.missingRight(accessibility: false, screenRecording: false), .noAccessibility)
    XCTAssertEqual(both.missingRight(accessibility: true, screenRecording: false), .noScreenRecording)
    XCTAssertEqual(both.missingRight(accessibility: false, screenRecording: true), .noAccessibility)
    XCTAssertNil(both.missingRight(accessibility: true, screenRecording: true))
    XCTAssertEqual(HandCommand.observe(image: true, elements: false).missingRight(accessibility: false, screenRecording: false), .noScreenRecording)
    XCTAssertNil(HandCommand.observe(image: true, elements: false).missingRight(accessibility: false, screenRecording: true))
    XCTAssertNil(HandCommand.observe(image: false, elements: false).missingRight(accessibility: false, screenRecording: false))
    let input: [HandCommand] = [.move(x: 1, y: 1), .click(x: 1, y: 1, button: .left, count: 1), .drag(fromX: 1, fromY: 1, toX: 2, toY: 2),
                                .scroll(x: 1, y: 1, dx: 0, dy: 1), .type(text: "a"), .key(combo: "return")]
    for command in input {
      XCTAssertEqual(command.missingRight(accessibility: false, screenRecording: true), .noAccessibility, command.kind)
      XCTAssertNil(command.missingRight(accessibility: true, screenRecording: false), command.kind)
    }
    // A closer look is a picture: it needs the screen, and no Accessibility.
    XCTAssertEqual(HandCommand.zoom(x: 1, y: 2, w: 240, h: 150, width: 960, height: 600).missingRight(accessibility: true, screenRecording: false),
      .noScreenRecording)
    XCTAssertNil(HandCommand.zoom(x: 1, y: 2, w: 240, h: 150, width: 960, height: 600).missingRight(accessibility: false, screenRecording: true))
    for command in [HandCommand.openURL(url: "https://example.com"), .wait(ms: 5)] {
      XCTAssertNil(command.missingRight(accessibility: false, screenRecording: false), command.kind)
    }
    XCTAssertEqual(HandCommand.switchPreviousApp.missingRight(accessibility: false, screenRecording: true), .noAccessibility)
    XCTAssertEqual(HandCommand.switchPreviousApp.missingRight(accessibility: true, screenRecording: false), .noScreenRecording)
    XCTAssertEqual(HandCommand.openApp(name: "Safari").missingRight(accessibility: false, screenRecording: true), .noAccessibility)
    XCTAssertEqual(HandCommand.openApp(name: "Safari").missingRight(accessibility: true, screenRecording: false), .noScreenRecording)
    XCTAssertEqual(HandCommand.switchDesktop(direction: .right).missingRight(accessibility: false, screenRecording: true), .noAccessibility)
    XCTAssertEqual(HandCommand.switchDesktop(direction: .right).missingRight(accessibility: true, screenRecording: false), .noScreenRecording)
    // The guided cursor goes where a pointing command starts. Typing has no place.
    XCTAssertEqual(input.map { $0.pointsAt != nil }, [true, true, true, true, false, false])
    XCTAssertEqual(HandCommand.drag(fromX: 1, fromY: 2, toX: 3, toY: 4).pointsAt, CGPoint(x: 1, y: 2))
    XCTAssertEqual(HandCommand.drag(fromX: 1, fromY: 2, toX: 3, toY: 4).places, [CGPoint(x: 1, y: 2), CGPoint(x: 3, y: 4)])
    XCTAssertEqual(HandCommand.click(x: 9, y: 8, button: .right, count: 2).places, [CGPoint(x: 9, y: 8)])
    XCTAssertEqual(input.map(\.usesKeyboard), [false, false, false, false, true, true])
    XCTAssertTrue(HandCommand.wait(ms: 1).places.isEmpty)
  }

  func testEachSequenceNumberIsTakenOnce() {
    var ledger = HandsLedger()
    XCTAssertEqual(ledger.last, 0)
    XCTAssertTrue(ledger.claim(1)); XCTAssertFalse(ledger.claim(1))
    XCTAssertTrue(ledger.claim(2)); XCTAssertTrue(ledger.claim(5))
    // A number that comes again, or an older one, is never run again.
    XCTAssertFalse(ledger.claim(5)); XCTAssertFalse(ledger.claim(3)); XCTAssertFalse(ledger.claim(0)); XCTAssertFalse(ledger.claim(-4))
    XCTAssertEqual(ledger.last, 5)
    // The same service keeps its numbers. Another instance counts from the start again.
    ledger.service("instance_a"); XCTAssertEqual(ledger.last, 5)
    ledger.service("instance_a"); XCTAssertFalse(ledger.claim(5))
    ledger.service("instance_b"); XCTAssertEqual(ledger.last, 0)
    XCTAssertTrue(ledger.claim(1)); XCTAssertFalse(ledger.claim(1))
  }

  func testStopHoldsUntilTheRunEnds() {
    var stop = HandsStop()
    XCTAssertFalse(stop.stopped)
    stop.observe(active: true); XCTAssertFalse(stop.stopped)
    stop.press(); XCTAssertTrue(stop.stopped)
    // The run still counts as active while the worker hears about Stop: nothing runs.
    stop.observe(active: true); XCTAssertTrue(stop.stopped)
    stop.observe(active: false); XCTAssertFalse(stop.stopped)
    stop.observe(active: true); XCTAssertFalse(stop.stopped)
  }

  func testTheHandsAskOftenDuringARunAndSeldomOtherwise() {
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0), 0.12)
    XCTAssertEqual(HandsPace.delay(active: false, failures: 0), 0.25)
    // A service that does not answer is asked less and less often, whatever the run was.
    XCTAssertEqual([1, 2, 3, 4, 9].map { HandsPace.delay(active: true, failures: $0) }, [1, 2, 4, 5, 5])
    XCTAssertEqual(HandsPace.delay(active: false, failures: 2), 2)
    XCTAssertEqual(HandsPace.delay(active: true, failures: 2, elapsed: 1, held: true, ran: true), 2)
  }
  func testAServiceThatHoldsTheReadIsReadAgainAtOnceWithNoBusyLoop() {
    // The read was held until a command came or the time passed: the next read goes at once.
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: HandsPace.hold, held: true), 0)
    XCTAssertEqual(HandsPace.delay(active: false, failures: 0, elapsed: 0.4, held: true), 0)
    // A service that says that it holds and still answers at once is not read more than 50 times a second.
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: 0, held: true), HandsPace.shortestGap)
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: 0.005, held: true), 0.015, accuracy: 0.000_001)
    XCTAssertGreaterThan(HandsPace.shortestGap, 0)
    // The held read stays well under the time limit of one request of the panel, 4 seconds.
    XCTAssertLessThanOrEqual(HandsPace.hold, 2)
    // A service that answers at once keeps the old pace between the starts of two reads.
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: 0.02), 0.10, accuracy: 0.000_001)
    XCTAssertEqual(HandsPace.delay(active: false, failures: 0, elapsed: 0.05), 0.20, accuracy: 0.000_001)
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: 3), 0)
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: .nan), 0.12)
    // Right after a result the next command of the step usually waits already: one read at once.
    XCTAssertEqual(HandsPace.delay(active: true, failures: 0, elapsed: 0.3, ran: true), 0)
  }
  func testTheLastCheckBeforeAnEventSendsNothingAfterStopOrWhenThePersonTookOver() {
    let running = HandsNext.Run(active: true, goal: "Save the note", step: 2, state: "running")
    // The request runs, nobody stopped it and the person did nothing: the event may go.
    XCTAssertNil(HandsGate.refusal(stopped: false, watching: true, personActed: false, run: running))
    // Without the tap nobody listened, so nothing is said about the person.
    XCTAssertNil(HandsGate.refusal(stopped: false, watching: false, personActed: true, run: running))
    // Stop at this Mac comes first, whatever else holds.
    XCTAssertEqual(HandsGate.refusal(stopped: true, watching: true, personActed: true, run: running), .stoppedByPerson)
    XCTAssertEqual(HandsGate.refusal(stopped: true, watching: false, personActed: false, run: nil), .stoppedByPerson)
    // The person moved the mouse or pressed a key during the glide: nothing is sent, and the worker asks.
    XCTAssertEqual(HandsGate.refusal(stopped: false, watching: true, personActed: true, run: running), .refused)
    // Stop through the chat, a call or the panel: the worker says that it stops.
    XCTAssertEqual(HandsGate.refusal(stopped: false, watching: true, personActed: false,
                                     run: .init(active: true, goal: "Save the note", step: 2, state: "stopping")), .stoppedByPerson)
    // A request that ended, or one that waits for the person, sends nothing.
    for state in ["idle", "waiting_for_person", "completed", "canceled", ""] {
      XCTAssertEqual(HandsGate.refusal(stopped: false, watching: true, personActed: false,
                                       run: .init(active: true, goal: "", step: 0, state: state)), .refused, state)
    }
    XCTAssertEqual(HandsGate.refusal(stopped: false, watching: true, personActed: false,
                                     run: .init(active: false, goal: "", step: 0, state: "running")), .refused)
    // The service did not answer: nothing is sent.
    XCTAssertEqual(HandsGate.refusal(stopped: false, watching: true, personActed: false, run: nil), .failed)
  }

  func testACloserLookShowsOnlyThePartOfTheDisplayThatIsThere() {
    let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    XCTAssertEqual(HandsZoom.region(x: 100, y: 200, w: 240, h: 150, display: display), CGRect(x: 100, y: 200, width: 240, height: 150))
    // Over an edge: only the part on the display.
    XCTAssertEqual(HandsZoom.region(x: 1400, y: 900, w: 240, h: 150, display: display), CGRect(x: 1400, y: 900, width: 112, height: 82))
    XCTAssertEqual(HandsZoom.region(x: -50, y: -20, w: 100, h: 100, display: display), CGRect(x: 0, y: 0, width: 50, height: 80))
    // Nothing of it on the display, or a number that is no number.
    XCTAssertNil(HandsZoom.region(x: 2000, y: 100, w: 240, h: 150, display: display))
    XCTAssertNil(HandsZoom.region(x: .nan, y: 100, w: 240, h: 150, display: display))
    XCTAssertNil(HandsZoom.region(x: 100, y: 100, w: .infinity, h: 150, display: display))
  }
}
