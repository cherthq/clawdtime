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
}
