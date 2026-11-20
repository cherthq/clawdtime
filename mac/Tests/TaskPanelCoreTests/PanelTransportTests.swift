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
