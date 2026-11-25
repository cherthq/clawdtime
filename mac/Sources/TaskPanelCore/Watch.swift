import Foundation

/// What the watcher found on the sessions, as the task service reports it: a
/// session that has waited for the person too long, one that works with no sign
/// of life, one that ended badly, and work that is done.
public struct Incidents: Codable, Equatable {
  public struct Incident: Codable, Equatable, Sendable {
    public let id: String
    /// waiting, stalled, failed or finished. A kind that a newer service adds shows with the service's own sentence.
    public let kind: String
    public let sessionId: String
    public let title: String
    public let agentLabel: String
    /// The remote Mac of the session. Nil for a session of this Mac.
    public let host: String?
    /// When the condition began: the wait, the silence, the end of the work.
    public let since: Double
    /// How long the work ran, when the incident is about its end and that is known.
    public let workedMs: Double?
    /// For a failed session: gone (its process ended) or error (it stopped on one).
    public let cause: String?
    public let raisedAt: Double
    /// The service's own sentence, counted when it answered.
    public let text: String
    public init(id: String, kind: String, sessionId: String, title: String, agentLabel: String, host: String? = nil,
                since: Double, workedMs: Double? = nil, cause: String? = nil, raisedAt: Double, text: String) {
      self.id = id; self.kind = kind; self.sessionId = sessionId; self.title = title; self.agentLabel = agentLabel
      self.host = host; self.since = since; self.workedMs = workedMs; self.cause = cause; self.raisedAt = raisedAt; self.text = text
    }
    /// It asks for the person's eyes: something went wrong or hangs.
    public var isTrouble: Bool { kind == "failed" || kind == "stalled" }
  }
  public let version: Int
  public let incidents: [Incident]
  public init(version: Int, incidents: [Incident]) { self.version = version; self.incidents = incidents }
  public static func identity(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{12}$", options: .regularExpression) != nil }
  public func validate() throws {
    guard version == 1, incidents.count <= 200 else { throw PanelFailure.response }
    for incident in incidents {
      guard Self.identity(incident.id), AgentBoard.identity(incident.sessionId), incident.kind.count <= 20,
        incident.title.count <= 80, incident.agentLabel.count <= 40, incident.text.count <= 400,
        incident.since >= 0, incident.raisedAt >= 0, incident.workedMs.map({ $0 >= 0 }) ?? true,
        (incident.cause?.count ?? 0) <= 20, incident.host.map(AgentBoard.hostName) ?? true else { throw PanelFailure.response }
    }
  }
}
public struct IncidentDismissResult: Codable, Equatable { public let ok: Bool }

/// Words for an incident. Names come from other programs, so every string is cleaned and bounded.
public enum IncidentText {
  /// The session by its name, with its Mac when it is a remote one.
  public static func who(_ incident: Incidents.Incident) -> String {
    let name = AgentBoardText.clean(incident.title, limit: 40)
    let place = incident.host.map { " on " + AgentBoardText.clean($0, limit: 16) } ?? ""
    return (name.isEmpty ? AgentBoardText.clean(incident.agentLabel, limit: 40) : name) + place
  }
  /// The line under the name. The time in it is counted at `now`, so it stays true while it shows.
  public static func detail(_ incident: Incidents.Incident, now: Double) -> String {
    let worked = incident.workedMs.map { AgentBoardText.elapsed(since: 0, now: $0) } ?? ""
    switch incident.kind {
    case "waiting": return "has waited for you for " + AgentBoardText.elapsed(since: incident.since, now: now)
    case "stalled": return "no sign of life for " + AgentBoardText.elapsed(since: incident.since, now: now)
    case "failed":
      if incident.cause == "error" { return worked.isEmpty ? "stopped on an error" : "stopped on an error after " + worked }
      return "gone: its process ended in the middle of its work"
    case "finished": return worked.isEmpty ? "is done" : "done after " + worked
    default: return AgentBoardText.clean(incident.text, limit: 120)
    }
  }
  /// One short line for the headline of the mascot's status.
  public static func headline(_ incident: Incidents.Incident) -> String {
    switch incident.kind {
    case "stalled": return who(incident) + " shows no sign of life"
    case "failed": return who(incident) + (incident.cause == "error" ? " stopped on an error" : " is gone")
    case "finished": return who(incident) + " is done"
    case "waiting": return who(incident) + " waits for you"
    default: return AgentBoardText.clean(incident.text, limit: 80)
    }
  }
}
