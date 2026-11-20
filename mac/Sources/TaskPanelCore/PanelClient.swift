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
    policy.timeoutIntervalForRequest = 4; policy.timeoutIntervalForResource = 120
    session = URLSession(configuration: policy, delegate: delegate, delegateQueue: nil)
  }
  public func close() { session.invalidateAndCancel() }
  private func request(path: String, body: Data? = nil, patient: Bool = false) async throws -> Data {
    guard path == "/desktop/state" || path == "/desktop/operations" ||
      path == "/desktop/agents" || path == "/desktop/agents/focus" || path == "/desktop/agents/send" ||
      path == "/desktop/chat" || path == "/desktop/execution/stop" || path == "/desktop/voice" || path == "/desktop/memory" ||
      path == "/desktop/decisions" || path == "/desktop/decisions/answer" || path == "/desktop/decisions/away" ||
      path == "/desktop/incidents" || path == "/desktop/incidents/dismiss" ||
      (path.hasPrefix("/desktop/operations/") && PanelConfiguration.identity(String(path.dropFirst("/desktop/operations/".count)))) else { throw PanelFailure.configuration }
    guard let url = URL(string: configuration.origin + path) else { throw PanelFailure.configuration }
    var request = URLRequest(url: url)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    // An answer from the language model, or speech, takes longer than a task read.
    if patient { request.timeoutInterval = 90 }
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
  /// What agents ask the person now. Reading it also tells their hooks that someone is here.
  public func decisions() async throws -> PendingDecisions {
    let result = try JSONDecoder().decode(PendingDecisions.self, from: await request(path: "/desktop/decisions"))
    try result.validate()
    return result
  }
  /// The person's answer to one request: allow, deny, or the text of a choice.
  public func answerDecision(_ id: String, decision: String, text: String? = nil, remember: Bool = false) async throws -> Bool {
    guard PendingDecisions.identity(id), ["allow", "deny", "answer"].contains(decision), (text?.count ?? 0) <= 600 else { throw PanelFailure.configuration }
    var body: [String: Any] = ["id": id, "decision": decision, "remember": remember]
    if let text { body["text"] = text }
    let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    return try JSONDecoder().decode(DecisionAnswerResult.self, from: await request(path: "/desktop/decisions/answer", body: data)).ok
  }
  /// What the watcher found on the sessions. A service with no watcher answers with an error.
  public func incidents() async throws -> Incidents {
    let result = try JSONDecoder().decode(Incidents.self, from: await request(path: "/desktop/incidents"))
    try result.validate()
    return result
  }
  /// The person has seen one incident. False when it is no longer open.
  public func dismissIncident(_ id: String) async throws -> Bool {
    guard Incidents.identity(id) else { throw PanelFailure.configuration }
    let data = try JSONSerialization.data(withJSONObject: ["id": id], options: [.sortedKeys])
    return try JSONDecoder().decode(IncidentDismissResult.self, from: await request(path: "/desktop/incidents/dismiss", body: data)).ok
  }
  /// Away: requests wait for a phone call.
  public func setAway(_ away: Bool) async throws {
    let data = try JSONSerialization.data(withJSONObject: ["away": away], options: [.sortedKeys])
    _ = try await request(path: "/desktop/decisions/away", body: data)
  }
  /// Memory on or off. It is off until the person turns it on.
  public func setMemory(_ enabled: Bool) async throws {
    let data = try JSONSerialization.data(withJSONObject: ["enabled": enabled], options: [.sortedKeys])
    _ = try await request(path: "/desktop/memory", body: data)
  }
  /// The conversation with ClawdTime.
  public func chat() async throws -> ChatTranscript {
    let result = try JSONDecoder().decode(ChatTranscript.self, from: await request(path: "/desktop/chat"))
    try result.validate()
    return result
  }
  /// One cooperative stop request. Unknown results are reconciled by chat reads,
  /// never by replaying this POST or claiming an in-flight action was interrupted.
  public func stopExecution() async throws -> ChatExecution {
    let result = try JSONDecoder().decode(ChatExecutionReply.self,
      from: await request(path: "/desktop/execution/stop", body: Data("{}".utf8)))
    try result.execution.validate()
    return result.execution
  }
  /// One typed message. The answer can take as long as the language model takes.
  public func say(_ text: String) async throws -> ChatTranscript.Message {
    guard (1...2000).contains(text.count) else { throw PanelFailure.configuration }
    let body = try JSONSerialization.data(withJSONObject: ["text": text], options: [.sortedKeys])
    return try JSONDecoder().decode(ChatReply.self, from: await request(path: "/desktop/chat", body: body, patient: true)).reply
  }
  /// One recording that the panel wrote into the voice folder, by its file name.
  public func hear(_ recording: String) async throws -> VoiceReply {
    guard recording.range(of: "^[A-Za-z0-9_-]{1,60}\\.(wav|m4a)$", options: .regularExpression) != nil else { throw PanelFailure.configuration }
    let body = try JSONSerialization.data(withJSONObject: ["recording": recording], options: [.sortedKeys])
    return try JSONDecoder().decode(VoiceReply.self, from: await request(path: "/desktop/voice", body: body, patient: true))
  }
  public func submit(_ payload: Data, eventId: String, action: PanelAction) async throws -> PanelOperation {
    // Exactly one POST. Redirects and network failures never trigger a replay.
    let result = try JSONDecoder().decode(PanelOperation.self, from: await request(path: "/desktop/operations", body: payload))
    try result.validate()
    guard result.eventId == eventId, result.action == action else { throw PanelFailure.response }
    return result
  }
}
