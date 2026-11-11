import DeviceCore
import Foundation
import Network

struct HTTPResponse {
  var status: Int = 200
  var contentType = "application/json"
  var headers = [String: String]()
  var body: Data
  static func json<T: Encodable>(_ value: T, status: Int = 200) throws -> HTTPResponse {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return HTTPResponse(status: status, body: try encoder.encode(value))
  }
  static func error(_ error: Error) -> HTTPResponse {
    let known = error as? HelperError
    return
      (try? .json(
        ["error": known?.message ?? "Device operation failed."], status: known?.status ?? 503))
      ?? HTTPResponse(status: 503, body: Data())
  }
  func encoded() -> Data {
    let safeHeaders = headers.map { "\($0.key): \($0.value)\r\n" }.joined()
    var data = Data(
      "HTTP/1.1 \(status) Response\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\(safeHeaders)\r\n"
        .utf8)
    data.append(body)
    return data
  }
}
final class HTTPServer {
  let listener: NWListener
  let queue = DispatchQueue(label: "ClawdTimeCompanion.http")
  let handler: (HTTPRequest) async -> HTTPResponse
  init(config: HelperConfig, handler: @escaping (HTTPRequest) async -> HTTPResponse) throws {
    self.handler = handler
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(
      host: NWEndpoint.Host(config.bind), port: NWEndpoint.Port(rawValue: config.port)!)
    listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
  }
  func start() { listener.start(queue: queue) }
  func stop() { listener.cancel() }
  func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 5) { connection.cancel() }
    receive(connection, buffer: Data())
  }
  func receive(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) {
      [weak self] data, _, complete, error in
      guard let self else {
        connection.cancel()
        return
      }
      var buffer = buffer
      if let data { buffer.append(data) }
      do {
        if let request = try HTTPRequest.parse(buffer) {
          Task {
            let response = await self.handler(request)
            connection.send(
              content: response.encoded(),
              completion: .contentProcessed { _ in connection.cancel() })
          }
        } else if complete || error != nil {
          connection.cancel()
        } else {
          self.receive(connection, buffer: buffer)
        }
      } catch {
        connection.send(
          content: HTTPResponse.error(error).encoded(),
          completion: .contentProcessed { _ in connection.cancel() })
      }
    }
  }
}
