import Foundation

private final class NoPanelRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

public final class PanelClient {
  private let configuration: PanelConfiguration
  private let delegate = NoPanelRedirects()
  private let session: URLSession
  public init(configuration: PanelConfiguration, transportConfiguration: URLSessionConfiguration? = nil) {
    self.configuration = configuration
    let policy = transportConfiguration ?? URLSessionConfiguration.ephemeral
    policy.httpCookieStorage = nil; policy.httpShouldSetCookies = false
    policy.urlCache = nil; policy.requestCachePolicy = .reloadIgnoringLocalCacheData
    policy.timeoutIntervalForRequest = 4; policy.timeoutIntervalForResource = 8
    session = URLSession(configuration: policy, delegate: delegate, delegateQueue: nil)
  }
  public func close() { session.invalidateAndCancel() }
  private func request(path: String, body: Data? = nil) async throws -> Data {
    guard path == "/desktop/state" || path == "/desktop/operations" ||
      path == "/desktop/agents" || path == "/desktop/agents/focus" ||
      (path.hasPrefix("/desktop/operations/") && PanelConfiguration.identity(String(path.dropFirst("/desktop/operations/".count)))) else { throw PanelFailure.configuration }
    guard let url = URL(string: configuration.origin + path) else { throw PanelFailure.configuration }
    var request = URLRequest(url: url)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    do {
      let (bytes, raw) = try await session.bytes(for: request)
      guard let response = raw as? HTTPURLResponse, (200...299).contains(response.statusCode),
        response.url == url else { throw PanelFailure.response }
      var data = Data()
      for try await byte in bytes {
        guard data.count < 262144 else { throw PanelFailure.response }
        data.append(byte)
      }
      return data
    } catch { throw PanelFailure.unavailable } // Never emit URL/header/peer-body diagnostics.
  }
  public func state() async throws -> PanelSnapshot {
    let result = try JSONDecoder().decode(PanelSnapshot.self, from: await request(path: "/desktop/state"))
    try result.validate(configuration: configuration)
    return result
  }
  public func operation(_ eventId: String) async throws -> PanelOperation {
    guard PanelConfiguration.identity(eventId) else { throw PanelFailure.configuration }
    let result = try JSONDecoder().decode(PanelOperation.self, from: await request(path: "/desktop/operations/" + eventId))
    try result.validate()
    guard result.eventId == eventId else { throw PanelFailure.response }
    return result
  }
  /// The board of coding-agent sessions. A service with no board answers with an error.
  public func agents() async throws -> AgentBoard {
    let result = try JSONDecoder().decode(AgentBoard.self, from: await request(path: "/desktop/agents"))
    try result.validate()
    return result
  }
  /// Brings one session's terminal forward. It sends nothing to the session.
  public func focusAgent(_ id: String) async throws -> AgentFocusResult {
    guard AgentBoard.identity(id) else { throw PanelFailure.configuration }
    let body = try JSONSerialization.data(withJSONObject: ["id": id], options: [.sortedKeys])
    let result = try JSONDecoder().decode(AgentFocusResult.self, from: await request(path: "/desktop/agents/focus", body: body))
    try result.validate()
    return result
  }
  public func submit(_ payload: Data, eventId: String, action: PanelAction) async throws -> PanelOperation {
    // Exactly one POST. Redirects and network failures never trigger a replay.
    let result = try JSONDecoder().decode(PanelOperation.self, from: await request(path: "/desktop/operations", body: payload))
    try result.validate()
    guard result.eventId == eventId, result.action == action else { throw PanelFailure.response }
    return result
  }
}
