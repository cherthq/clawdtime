import Foundation
import Network
import XCTest
@testable import TaskPanelCore

/// Real loopback HTTP, no provider, worker, desktop automation or private config.
private final class FixtureHTTP: @unchecked Sendable {
  let listener: NWListener
  let queue = DispatchQueue(label: "panel.http.fixture")
  let lock = NSLock()
  var received: [String] = []
  var connections: [NWConnection] = []
  var startResumed = false
  var port: UInt16 { listener.port!.rawValue }
  let response: (String, UInt16) -> (Int, [String: String], Data)
  init(response: @escaping (String, UInt16) -> (Int, [String: String], Data)) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    self.response = response
  }
  func start() async throws {
    try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { [self] state in
        lock.lock(); defer { lock.unlock() }
        guard !startResumed else { return }
        switch state {
        case .ready: startResumed = true; continuation.resume()
        case .failed(let error): startResumed = true; continuation.resume(throwing: error)
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return }
        self.lock.lock(); self.connections.append(connection); self.lock.unlock()
        connection.start(queue: self.queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
          guard let self, let data else { connection.cancel(); return }
          let request = String(decoding: data, as: UTF8.self)
          self.lock.lock(); self.received.append(request); self.lock.unlock()
          let (status, headers, body) = self.response(request, self.port)
          var head = "HTTP/1.1 \(status) Fixture\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
          for (name, value) in headers { head += "\(name): \(value)\r\n" }
          head += "\r\n"
          connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
        }
      }
      listener.start(queue: queue)
    }
  }
  func requests() -> [String] { lock.lock(); defer { lock.unlock() }; return received }
  func close() { listener.cancel(); lock.lock(); defer { lock.unlock() }; connections.forEach { $0.cancel() } }
}

final class PanelTransportTests: XCTestCase {
  func config(_ port: UInt16) -> PanelConfiguration {
    PanelConfiguration(version: 1, desktopId: "desktop_fixture", origin: "http://127.0.0.1:\(port)",
      token: String(repeating: "synthetic", count: 8), projectRoot: "/tmp/panel-worker-fixture",
      receiptDirectory: "/tmp/panel-state-fixture", configurationFingerprint: String(repeating: "a", count: 64))
  }
  func testExecutionStatusAndCooperativeStopUseFixedAuthenticatedRoutes() async throws {
    let execution = #"{"configured":true,"state":"stop_requested","canStop":false,"message":"Stop requested; an action already underway may finish."}"#
    let server = try FixtureHTTP { request, _ in
      let body = request.hasPrefix("GET /desktop/chat ")
        ? #"{"version":1,"model":true,"speech":false,"voiceDirectory":"/tmp/voice","messages":[],"execution":"# + execution + "}"
        : #"{"execution":"# + execution + "}"
      return (200, ["Content-Type": "application/json"], Data(body.utf8))
    }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let chat = try await client.chat()
    let result = try await client.stopExecution()
    XCTAssertEqual(chat.execution, result)
    XCTAssertFalse(result.canStop)
    let requests = server.requests()
    XCTAssertEqual(requests.count, 2)
    XCTAssertTrue(requests[1].hasPrefix("POST /desktop/execution/stop "))
    XCTAssertTrue(requests[1].contains("Content-Length: 2\r\n"))
    XCTAssertTrue(requests[1].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
  }

  func testUnconfirmedExecutorStopNeverRetriesOrFollowsRedirect() async throws {
    for status in [302, 503, 200] {
      let server = try FixtureHTTP { _, port in
        (status, ["Location": "http://127.0.0.1:\(port)/other"],
          Data(#"{"execution":{"configured":false,"state":"running","canStop":true,"message":"invalid"}}"#.utf8))
      }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { _ = try await client.stopExecution(); XCTFail("Unconfirmed Stop accepted") } catch {}
      XCTAssertEqual(server.requests().count, 1)
      XCTAssertTrue(server.requests()[0].hasPrefix("POST /desktop/execution/stop "))
    }
  }

  func testExecutionDecisionUsesExactActionAndNeverRetriesFailure() async throws {
    let server = try FixtureHTTP { _, _ in (503, [:], Data()) }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    do { _ = try await client.decideExecution(actionId: "action_1", approve: false); XCTFail("Failure accepted") } catch {}
    let requests = server.requests()
    XCTAssertEqual(requests.count, 1)
    XCTAssertTrue(requests[0].hasPrefix("POST /desktop/execution/decision "))
    XCTAssertTrue(requests[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    let body = try JSONSerialization.data(withJSONObject: ["actionId": "action_1", "approve": false], options: [.sortedKeys])
    XCTAssertTrue(requests[0].contains("Content-Length: \(body.count)\r\n"))
    do { _ = try await client.decideExecution(actionId: "../other", approve: true); XCTFail("Unsafe identity") } catch {}
    XCTAssertEqual(server.requests().count, 1)
  }

  func testHTTPRedirectIsNotFollowedOrSentCredentialsAgain() async throws {
    let server = try FixtureHTTP { _, port in (302, ["Location": "http://127.0.0.1:\(port)/redirect-target"], Data()) }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    do { _ = try await client.state(); XCTFail("Redirect accepted") } catch {}
    XCTAssertEqual(server.requests().count, 1)
    XCTAssertTrue(server.requests()[0].hasPrefix("GET /desktop/state "))
    XCTAssertFalse(server.requests()[0].contains("Origin:"))
  }
  func testFailedPostIsSentOnceAndNeverConvertedToReadOrReplay() async throws {
    let server = try FixtureHTTP { _, _ in (503, ["Content-Type": "application/json"], Data("{}".utf8)) }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let body = Data("{\"eventId\":\"event_fixture\",\"action\":\"submit\",\"goal\":\"synthetic\"}".utf8)
    do { _ = try await client.submit(body, eventId: "event_fixture", action: .submit); XCTFail("Failure accepted") } catch {}
    XCTAssertEqual(server.requests().count, 1)
    XCTAssertTrue(server.requests()[0].hasPrefix("POST /desktop/operations "))
  }
  func testReceiptIdentityMismatchAndWrongActionAreRejected() async throws {
    let body = Data("{\"eventId\":\"other\",\"action\":\"cancel\",\"state\":\"done\",\"message\":\"Synthetic\"}".utf8)
    let server = try FixtureHTTP { _, _ in (200, ["Content-Type": "application/json"], body) }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    do { _ = try await client.operation("event_fixture"); XCTFail("Foreign receipt accepted") } catch {}
    do { _ = try await client.submit(Data("{}".utf8), eventId: "other", action: .submit); XCTFail("Wrong action accepted") } catch {}
    XCTAssertEqual(server.requests().count, 2)
  }
  func testAgentBoardIsReadWithThePanelCredentialAndAnErrorMeansNoBoard() async throws {
    let board = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/agent-board.json").standardizedFileURL)
    let server = try FixtureHTTP { request, _ in
      request.hasPrefix("GET /desktop/agents ") ? (200, ["Content-Type": "application/json"], board)
        : (200, ["Content-Type": "application/json"], Data("{\"ok\":true,\"precision\":\"tab\"}".utf8))
    }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let result = try await client.agents()
    XCTAssertEqual(result.sessions.count, 6)
    XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    let focus = try await client.focusAgent("100-abc123")
    XCTAssertEqual(focus, AgentFocusResult(ok: true, precision: "tab"))
    XCTAssertTrue(server.requests()[1].hasPrefix("POST /desktop/agents/focus "))
    // The fixture reads the request head. The body is exactly {"id":"100-abc123"}: 19 bytes.
    XCTAssertTrue(server.requests()[1].contains("Content-Length: 19\r\n"))
    XCTAssertTrue(server.requests()[1].contains("Content-Type: application/json\r\n"))
    // An id that could change the path or the body is refused before any request.
    do { _ = try await client.focusAgent("../state"); XCTFail("Unsafe id accepted") } catch {}
    XCTAssertEqual(server.requests().count, 2)
  }
  func testServiceWithoutABoardAndInvalidBoardsAreRejected() async throws {
    for (status, body) in [(503, "{\"error\":\"Agent board unavailable.\"}"), (404, "{}"),
                           (200, "{\"version\":2,\"generatedAt\":1,\"intervalMs\":3000,\"counts\":{\"needs_you\":0,\"working\":0,\"idle\":0,\"unknown\":0},\"sessions\":[]}"),
                           (200, "{\"ok\":true,\"precision\":\"none\"}")] {
      let server = try FixtureHTTP { _, _ in (status, ["Content-Type": "application/json"], Data(body.utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { _ = try await client.agents(); XCTFail("Invalid board accepted") } catch {}
      do { _ = try await client.focusAgent("100-abc123"); XCTFail("Invalid focus result accepted") } catch {}
    }
  }
  func testIncidentsAreReadAndDismissedWithThePanelCredential() async throws {
    let found = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/agent-incidents.json").standardizedFileURL)
    let server = try FixtureHTTP { request, _ in
      request.hasPrefix("GET /desktop/incidents ") ? (200, ["Content-Type": "application/json"], found)
        : (200, ["Content-Type": "application/json"], Data("{\"ok\":true}".utf8))
    }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let incidents = try await client.incidents()
    XCTAssertEqual(incidents.incidents.map(\.kind), ["failed", "waiting", "stalled", "finished"])
    XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    let dismissed = try await client.dismissIncident("a1b2c3d4e5f6")
    XCTAssertTrue(dismissed)
    XCTAssertTrue(server.requests()[1].hasPrefix("POST /desktop/incidents/dismiss "))
    // The body is exactly {"id":"a1b2c3d4e5f6"}: 21 bytes.
    XCTAssertTrue(server.requests()[1].contains("Content-Length: 21\r\n"))
    // An id of another shape is refused before any request.
    do { _ = try await client.dismissIncident("../watch.json"); XCTFail("Unsafe id accepted") } catch {}
    XCTAssertEqual(server.requests().count, 2)
  }
  func testAServiceWithNoWatcherAndIncidentsOutsideTheContractAreRejected() async throws {
    for (status, body) in [(404, "{}"), (200, "{\"version\":2,\"incidents\":[]}"),
                           (200, "{\"version\":1,\"incidents\":[{\"id\":\"nope\",\"kind\":\"stalled\",\"sessionId\":\"100-abc\",\"title\":\"x\",\"agentLabel\":\"y\",\"since\":1,\"raisedAt\":1,\"text\":\"z\"}]}")] {
      let server = try FixtureHTTP { _, _ in (status, ["Content-Type": "application/json"], Data(body.utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { _ = try await client.incidents(); XCTFail("Invalid incidents accepted") } catch {}
    }
  }
  func testChatAndVoiceUseThePanelCredentialAndRefuseUnsafeNames() async throws {
    let transcript = #"{"version":1,"model":true,"speech":true,"voiceDirectory":"/tmp/voice","messages":[{"role":"user","text":"hi","at":1,"via":"chat"}]}"#
    let server = try FixtureHTTP { request, _ in
      if request.hasPrefix("GET /desktop/chat ") { return (200, ["Content-Type": "application/json"], Data(transcript.utf8)) }
      if request.hasPrefix("POST /desktop/chat ") {
        return (200, ["Content-Type": "application/json"], Data(#"{"reply":{"role":"assistant","text":"Hello.","at":2,"via":"chat"}}"#.utf8))
      }
      return (200, ["Content-Type": "application/json"],
        Data(#"{"heard":"what needs me","reply":{"role":"assistant","text":"Nothing.","at":3,"via":"voice"},"audio":"reply-abc123.mp3"}"#.utf8))
    }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let chat = try await client.chat()
    XCTAssertEqual(chat.messages.map(\.text), ["hi"]); XCTAssertTrue(chat.speech); XCTAssertEqual(chat.voiceDirectory, "/tmp/voice")
    XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    let reply = try await client.say("what needs me?")
    XCTAssertEqual(reply.text, "Hello."); XCTAssertFalse(reply.mine)
    XCTAssertTrue(server.requests()[1].hasPrefix("POST /desktop/chat "))
    let heard = try await client.hear("rec-1795170939254.wav")
    XCTAssertEqual(heard.heard, "what needs me"); XCTAssertEqual(heard.audioName, "reply-abc123.mp3"); XCTAssertEqual(heard.reply?.via, "voice")
    XCTAssertTrue(server.requests()[2].hasPrefix("POST /desktop/voice "))
    // The recording goes by its name only: {"recording":"rec-1795170939254.wav"} is 37 bytes.
    XCTAssertTrue(server.requests()[2].contains("Content-Length: 37\r\n"))
    // A name that could leave the voice folder, and an empty message, are refused before any request.
    do { _ = try await client.hear("../chat.jsonl"); XCTFail("Unsafe recording name accepted") } catch {}
    do { _ = try await client.hear("rec.mp3"); XCTFail("Unknown recording type accepted") } catch {}
    do { _ = try await client.say(""); XCTFail("Empty message accepted") } catch {}
    XCTAssertEqual(server.requests().count, 3)
  }
  func testAChatOfAnotherVersionOrARelativeVoiceFolderIsRejected() async throws {
    for body in [#"{"version":2,"model":true,"speech":true,"voiceDirectory":"/tmp/voice","messages":[]}"#,
                 #"{"version":1,"model":true,"speech":true,"voiceDirectory":"voice","messages":[]}"#,
                 #"{"version":1,"model":true,"speech":true,"voiceDirectory":"/tmp/voice","messages":[{"role":"system","text":"x","at":1,"via":"chat"}]}"#] {
      let server = try FixtureHTTP { _, _ in (200, ["Content-Type": "application/json"], Data(body.utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { _ = try await client.chat(); XCTFail("Invalid chat accepted") } catch {}
    }
  }
  func testTheHandsReadTheNextCommandAndPostItsResultWithThePanelCredential() async throws {
    let next = #"{"version":1,"command":{"seq":8,"command":{"kind":"click","x":640,"y":400,"button":"left","count":1},"label":"Click Save"},"run":{"active":true,"goal":"Save the note","step":3,"state":"running"}}"#
    let server = try FixtureHTTP { request, _ in
      request.hasPrefix("GET /desktop/hands/next?after=7 ") ? (200, ["Content-Type": "application/json"], Data(next.utf8))
        : (200, ["Content-Type": "application/json"], Data("{\"ok\":true}".utf8))
    }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    let read = try await client.handsNext(after: 7)
    XCTAssertEqual(read.command, .init(seq: 8, command: .click(x: 640, y: 400, button: .left, count: 1), label: "Click Save"))
    XCTAssertEqual(read.run, .init(active: true, goal: "Save the note", step: 3, state: "running"))
    XCTAssertTrue(server.requests()[0].hasPrefix("GET /desktop/hands/next?after=7 "))
    XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    XCTAssertFalse(server.requests()[0].contains("Origin:"))

    try await client.handsResult(.done(8, interrupted: true))
    XCTAssertTrue(server.requests()[1].hasPrefix("POST /desktop/hands/result "))
    XCTAssertTrue(server.requests()[1].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    XCTAssertTrue(server.requests()[1].contains("Content-Type: application/json\r\n"))
    // The body is exactly {"interrupted":true,"ok":true,"seq":8}: 38 bytes.
    XCTAssertTrue(server.requests()[1].contains("Content-Length: 38\r\n"))

    // What the hands saw goes as the contract writes it, and a slash in the picture is not escaped.
    let seen = Observation(at: 1_795_170_939_254, screen: .init(width: 1512, height: 982, scale: 2), cursor: .init(x: 640.5, y: 300),
      app: .init(name: "Notes", bundleId: "com.apple.Notes", window: "All iCloud"),
      elements: [ScreenElement(id: 0, role: "AXButton", title: "Save", x: 100, y: 40, w: 64, h: 24, enabled: true, focused: false, secure: false)],
      image: "/9j/4AAQ", imageWidth: 1280, imageHeight: 831)
    let body = #"{"observation":{"app":{"bundleId":"com.apple.Notes","name":"Notes","window":"All iCloud"},"at":1795170939254,"cursor":{"x":640.5,"y":300},"elements":[{"enabled":true,"focused":false,"h":24,"id":0,"role":"AXButton","secure":false,"title":"Save","w":64,"x":100,"y":40}],"image":"/9j/4AAQ","imageHeight":831,"imageWidth":1280,"screen":{"height":982,"scale":2,"width":1512}},"ok":true,"seq":9}"#
    try await client.handsResult(.done(9, observation: seen))
    XCTAssertTrue(server.requests()[2].hasPrefix("POST /desktop/hands/result "))
    XCTAssertTrue(server.requests()[2].contains("Content-Length: \(body.utf8.count)\r\n"))

    // A number that cannot be a sequence, and a result outside the contract, are refused before any request.
    do { _ = try await client.handsNext(after: -1); XCTFail("Negative sequence accepted") } catch {}
    do { try await client.handsResult(HandResult(seq: 0, ok: true)); XCTFail("Sequence zero accepted") } catch {}
    do { try await client.handsResult(HandResult(seq: 3, ok: true, error: .failed)); XCTFail("A done result with an error accepted") } catch {}
    XCTAssertEqual(server.requests().count, 3)
  }
  func testAHandsResultIsPostedOnceAndNeverReplayedOrRedirected() async throws {
    for status in [503, 302, 404] {
      let server = try FixtureHTTP { _, port in (status, ["Location": "http://127.0.0.1:\(port)/other"], Data("{}".utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { try await client.handsResult(.failure(4, .stoppedByPerson)); XCTFail("Unconfirmed result accepted") } catch {}
      XCTAssertEqual(server.requests().count, 1)
      XCTAssertTrue(server.requests()[0].hasPrefix("POST /desktop/hands/result "))
      do { _ = try await client.handsNext(after: 4); XCTFail("Failed read accepted") } catch {}
      XCTAssertEqual(server.requests().count, 2)
      XCTAssertTrue(server.requests()[1].hasPrefix("GET /desktop/hands/next?after=4 "))
    }
  }
  func testPresentationIsAuthenticatedTransientAndNeverRetriedOrRedirected() async throws {
    for status in [200, 503, 302] {
      let server = try FixtureHTTP { _, port in (status, ["Location": "http://127.0.0.1:\(port)/other"], Data("{\"ok\":true}".utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      let event = CallPresentationEvent(producerId: "00000000-0000-4000-8000-000000000001", sequence: 1, commandSeq: 8,
        at: 1000, kind: .reset, reducedMotion: true)
      do {
        try await client.handsPresentation(event)
        XCTAssertEqual(status, 200)
      } catch { XCTAssertNotEqual(status, 200) }
      XCTAssertEqual(server.requests().count, 1)
      XCTAssertTrue(server.requests()[0].hasPrefix("POST /desktop/hands/presentation "))
      XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
      XCTAssertTrue(server.requests()[0].lowercased().contains("cache-control: no-store"))
      var invalid = event; invalid.expiresAt = 4000
      do { try await client.handsPresentation(invalid); XCTFail("Invalid hint sent") } catch {}
      XCTAssertEqual(server.requests().count, 1)
    }
  }
  func testAServiceWithNoWorkerAndCommandsOutsideTheContractAreRejected() async throws {
    let run = #""run":{"active":true,"goal":"g","step":1,"state":"running"}"#
    for body in ["{}", #"{"version":2,"command":null,\#(run)}"#, #"{"version":1,\#(run)}"#,
                 #"{"version":1,"command":{"seq":1,"command":{"kind":"shell","command":"ls"},"label":"Run"},\#(run)}"#,
                 #"{"version":1,"command":{"seq":1,"command":{"kind":"move","x":1,"y":2,"then":"click"},"label":"Move"},\#(run)}"#,
                 #"{"version":1,"command":{"seq":0,"command":{"kind":"wait","ms":1},"label":"Wait"},\#(run)}"#] {
      let server = try FixtureHTTP { _, _ in (200, ["Content-Type": "application/json"], Data(body.utf8)) }
      try await server.start(); defer { server.close() }
      let client = PanelClient(configuration: config(server.port)); defer { client.close() }
      do { _ = try await client.handsNext(after: 0); XCTFail("Invalid read accepted: " + body) } catch {}
      XCTAssertEqual(server.requests().count, 1)
    }
  }
  func testMemoryIsSwitchedWithThePanelCredential() async throws {
    let server = try FixtureHTTP { _, _ in (200, ["Content-Type": "application/json"], Data(#"{"enabled":true}"#.utf8)) }
    try await server.start(); defer { server.close() }
    let client = PanelClient(configuration: config(server.port)); defer { client.close() }
    try await client.setMemory(true)
    XCTAssertTrue(server.requests()[0].hasPrefix("POST /desktop/memory "))
    XCTAssertTrue(server.requests()[0].contains("Authorization: Bearer " + String(repeating: "synthetic", count: 8)))
    // The body is exactly {"enabled":true}: 16 bytes.
    XCTAssertTrue(server.requests()[0].contains("Content-Length: 16\r\n"))
  }
}
