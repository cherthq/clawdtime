import Foundation

/// Every coding-agent session on this Mac, as the task service reports it.
/// The board is read-only: the only action is to bring a session's terminal forward.
public struct AgentBoard: Codable, Equatable {
  public enum State: String, Codable, CaseIterable {
    case needsYou = "needs_you", working, idle, unknown
    /// A state that a newer service adds shows as unknown, not as a failure.
    public init(from decoder: Decoder) throws {
      self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
  }
  public struct Counts: Codable, Equatable {
    public let needsYou: Int
    public let working: Int
    public let idle: Int
    public let unknown: Int
    enum CodingKeys: String, CodingKey { case needsYou = "needs_you", working, idle, unknown }
    public init(needsYou: Int, working: Int, idle: Int, unknown: Int) {
      self.needsYou = needsYou; self.working = working; self.idle = idle; self.unknown = unknown
    }
  }
  public struct Tmux: Codable, Equatable {
    public let session: String
    public let window: Int
    public let pane: Int
    public init(session: String, window: Int, pane: Int) { self.session = session; self.window = window; self.pane = pane }
  }
  public struct Terminal: Codable, Equatable {
    public let tty: String?
    public let app: String?
    public let tmux: Tmux?
    public let remote: Bool
    public init(tty: String?, app: String?, tmux: Tmux?, remote: Bool) {
      self.tty = tty; self.app = app; self.tmux = tmux; self.remote = remote
    }
  }
  public struct Session: Codable, Equatable {
    public let id: String
    public let agentLabel: String
    public let name: String?
    public let project: String
    public let mode: String
    public let state: State
    public let detail: String
    public let since: Double?
    public let focus: String
    public let terminal: Terminal
    public init(id: String, agentLabel: String, name: String?, project: String, mode: String, state: State,
                detail: String, since: Double?, focus: String, terminal: Terminal) {
      self.id = id; self.agentLabel = agentLabel; self.name = name; self.project = project; self.mode = mode
      self.state = state; self.detail = detail; self.since = since; self.focus = focus; self.terminal = terminal
    }
    public var canFocus: Bool { ["tab", "pane", "app"].contains(focus) }
  }
  public let version: Int
  public let generatedAt: Double
  public let intervalMs: Double?
  public let counts: Counts
  public let sessions: [Session]
  public init(version: Int, generatedAt: Double, intervalMs: Double?, counts: Counts, sessions: [Session]) {
    self.version = version; self.generatedAt = generatedAt; self.intervalMs = intervalMs
    self.counts = counts; self.sessions = sessions
  }

  public static func identity(_ value: String) -> Bool {
    value.range(of: "^[0-9a-z][0-9a-z_-]{1,40}$", options: .regularExpression) != nil
  }
  public func validate() throws {
    guard version == 1, generatedAt >= 0, sessions.count <= 500,
      [counts.needsYou, counts.working, counts.idle, counts.unknown].allSatisfy({ (0...500).contains($0) }),
      intervalMs.map({ $0 > 0 && $0 <= 600_000 }) ?? true else { throw PanelFailure.response }
    for session in sessions {
      guard Self.identity(session.id), session.agentLabel.count <= 40, (session.name?.count ?? 0) <= 80,
        session.project.count <= 120, session.detail.count <= 40, session.mode.count <= 20,
        session.focus.count <= 10, (session.terminal.app?.count ?? 0) <= 120,
        (session.terminal.tty?.count ?? 0) <= 24, (session.terminal.tmux?.session.count ?? 0) <= 200,
        session.since.map({ $0 >= 0 }) ?? true else { throw PanelFailure.response }
    }
  }
  /// The service publishes on an interval. A board much older than that is not shown.
  public func isFresh(now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
    now - generatedAt <= (intervalMs ?? 3000) * 3 + 4000
  }
}

public struct AgentFocusResult: Codable, Equatable {
  public let ok: Bool
  public let precision: String
  public init(ok: Bool, precision: String) { self.ok = ok; self.precision = precision }
  public func validate() throws {
    guard ["pane", "tab", "app", "none"].contains(precision), ok == (precision != "none") else { throw PanelFailure.response }
  }
  public var message: String {
    switch precision {
    case "pane": return "Opened its tmux pane."
    case "tab": return "Opened its terminal tab."
    case "app": return "Brought its terminal forward. Choose the tab there."
    default: return "That session has no terminal on this Mac."
    }
  }
}

/// Text for the board. Names come from other programs, so every string is cleaned and bounded.
public enum AgentBoardText {
  public static func clean(_ value: String, limit: Int = 80) -> String {
    let scalars = value.unicodeScalars.map { scalar -> Character in
      switch scalar.properties.generalCategory {
      case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return " "
      default: return Character(scalar)
      }
    }
    let collapsed = String(scalars).split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    return collapsed.count <= limit ? collapsed : String(collapsed.prefix(limit - 1)) + "…"
  }
  public static func summary(_ counts: AgentBoard.Counts) -> String {
    var parts: [String] = []
    if counts.needsYou > 0 { parts.append("\(counts.needsYou) \(counts.needsYou == 1 ? "needs" : "need") you") }
    if counts.working > 0 { parts.append("\(counts.working) working") }
    if counts.idle > 0 { parts.append("\(counts.idle) idle") }
    if counts.unknown > 0 { parts.append("\(counts.unknown) unknown") }
    return parts.isEmpty ? "No agent sessions" : parts.joined(separator: " · ")
  }
  public static func title(_ session: AgentBoard.Session) -> String {
    let name = clean(session.name ?? "")
    return name.isEmpty ? clean(session.project) : name
  }
  public static func detail(_ detail: String) -> String {
    switch detail {
    case "permission_prompt": return "permission needed"
    case "question": return "question for you"
    case "plan_review": return "plan to review"
    case "turn_running": return "working"
    case "tool_running": return "running a tool"
    case "background_shell": return "background shell"
    case "turn_complete": return "done"
    case "turn_failed": return "stopped on an error"
    case "turn_interrupted": return "interrupted"
    case "input_prompt", "session_started": return "ready"
    case "no_signal": return "no state signal"
    default: return "state not recognized"
    }
  }
  public static func place(_ session: AgentBoard.Session) -> String {
    if session.mode == "background" { return "background" }
    if session.terminal.remote { return "remote" }
    let app = clean(session.terminal.app ?? "", limit: 24)
    if let tmux = session.terminal.tmux {
      let pane = "tmux \(clean(tmux.session, limit: 24)):\(tmux.window).\(tmux.pane)"
      return app.isEmpty ? pane : app + " · " + pane
    }
    return app
  }
  /// "Claude Code · permission needed · Ghostty"
  public static func subtitle(_ session: AgentBoard.Session) -> String {
    [clean(session.agentLabel, limit: 40), detail(session.detail), place(session)].filter { !$0.isEmpty }.joined(separator: " · ")
  }
  /// 45s, 12m, 3h 05m, 2d 04h.
  public static func elapsed(since: Double?, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
    guard let since else { return "" }
    let seconds = max(0, Int((now - since) / 1000))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return String(format: "%dh %02dm", hours, minutes % 60) }
    return String(format: "%dd %02dh", hours / 24, hours % 24)
  }
  public static func focusHint(_ session: AgentBoard.Session) -> String {
    switch session.focus {
    case "pane": return "Open its tmux pane"
    case "tab": return "Open its terminal tab"
    case "app": return "Bring its terminal forward"
    default: return "No terminal on this Mac to open"
    }
  }
  public static func accessibility(_ session: AgentBoard.Session, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
    let time = elapsed(since: session.since, now: now)
    return [title(session), subtitle(session), time.isEmpty ? "" : "for " + time].filter { !$0.isEmpty }.joined(separator: ", ")
  }
  /// The one line in the collapsed toolbar. A task that waits for the person keeps the
  /// line; otherwise agents that wait for the person take it from the task stage.
  public static func toolbar(stage: String, taskNeedsPerson: Bool, counts: AgentBoard.Counts?) -> (text: String, attention: Bool) {
    guard let counts, counts.needsYou > 0, !taskNeedsPerson else { return (stage, taskNeedsPerson) }
    return ("\(counts.needsYou) \(counts.needsYou == 1 ? "agent needs" : "agents need") you", true)
  }
  /// Sessions that need the person and sessions at work always show. Quiet ones are capped.
  public static func rows(_ board: AgentBoard, quietLimit: Int = 4) -> (shown: [AgentBoard.Session], hidden: Int) {
    let active = board.sessions.filter { $0.state == .needsYou || $0.state == .working }
    let quiet = board.sessions.filter { $0.state != .needsYou && $0.state != .working }
    let kept = Array(quiet.prefix(max(0, quietLimit)))
    return (active + kept, quiet.count - kept.count)
  }
}

/// What agents ask the person right now, as the task service reports it. The person
/// answers here, and the agent's own hook hands the answer to the agent.
public struct PendingDecisions: Codable, Equatable {
  public struct Request: Codable, Equatable {
    public let id: String
    public let agentLabel: String
    public let kind: String
    public let tool: String
    public let summary: String
    public let options: [String]
    public let project: String
    public let session: String?
    public let sessionId: String?
    public let createdAt: Double
    public let holdUntil: Double
    public let allowedBefore: Int
    public let deniedBefore: Int
    public let canRemember: Bool
    public init(id: String, agentLabel: String, kind: String, tool: String, summary: String, options: [String], project: String,
                session: String?, sessionId: String?, createdAt: Double, holdUntil: Double, allowedBefore: Int, deniedBefore: Int, canRemember: Bool) {
      self.id = id; self.agentLabel = agentLabel; self.kind = kind; self.tool = tool; self.summary = summary; self.options = options
      self.project = project; self.session = session; self.sessionId = sessionId; self.createdAt = createdAt; self.holdUntil = holdUntil
      self.allowedBefore = allowedBefore; self.deniedBefore = deniedBefore; self.canRemember = canRemember
    }
    public var isQuestion: Bool { kind == "question" }
  }
  public let version: Int
  public let away: Bool
  public let callReady: Bool
  public let pending: [Request]
  public init(version: Int, away: Bool, callReady: Bool, pending: [Request]) {
    self.version = version; self.away = away; self.callReady = callReady; self.pending = pending
  }
  public static func identity(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil }
  public func validate() throws {
    guard version == 1, pending.count <= 200 else { throw PanelFailure.response }
    for request in pending {
      guard Self.identity(request.id), ["permission", "question", "plan"].contains(request.kind), request.summary.count <= 600,
        request.tool.count <= 80, request.agentLabel.count <= 40, request.project.count <= 4096, request.options.count <= 8,
        request.options.allSatisfy({ $0.count <= 200 }), (request.session?.count ?? 0) <= 200,
        request.allowedBefore >= 0, request.deniedBefore >= 0, request.holdUntil >= request.createdAt,
        !request.isQuestion || !request.options.isEmpty else { throw PanelFailure.response }
    }
  }
}
public struct DecisionAnswerResult: Codable, Equatable { public let ok: Bool }

public enum DecisionText {
  /// The session by its name, or the agent and its project.
  public static func who(_ request: PendingDecisions.Request) -> String {
    let session = AgentBoardText.clean(request.session ?? "", limit: 40)
    if !session.isEmpty { return session }
    let project = AgentBoardText.clean(request.project, limit: 30)
    return project.isEmpty ? AgentBoardText.clean(request.agentLabel, limit: 40) : AgentBoardText.clean(request.agentLabel, limit: 40) + " in " + project
  }
  public static func title(_ request: PendingDecisions.Request) -> String {
    switch request.kind {
    case "question": return who(request) + " asks"
    case "plan": return who(request) + " has a plan ready"
    default:
      let shell = ["bash", "shell", "exec", "exec_command", "local_shell"].contains(request.tool.lowercased())
      return who(request) + (shell ? " asks to run" : " asks to use " + AgentBoardText.clean(request.tool, limit: 40))
    }
  }
  public static func summary(_ request: PendingDecisions.Request) -> String { AgentBoardText.clean(request.summary, limit: 600) }
  /// What the person answered before to the same request in this project.
  public static func history(_ request: PendingDecisions.Request) -> String {
    func times(_ count: Int) -> String { count == 1 ? "once" : "\(count) times" }
    switch (request.allowedBefore, request.deniedBefore) {
    case (0, 0): return ""
    case (let allowed, 0): return "You allowed this \(times(allowed)) here."
    case (0, let denied): return "You denied this \(times(denied)) here."
    case (let allowed, let denied): return "Here before: allowed \(times(allowed)), denied \(times(denied))."
    }
  }
  /// How long the answer still works from here. After that the agent's terminal is the only place.
  public static func remaining(_ request: PendingDecisions.Request, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
    let seconds = max(0, Int((request.holdUntil - now) / 1000))
    if seconds >= 90 { return "\((seconds + 30) / 60) min left to answer here" }
    return "\(seconds) s left to answer here"
  }
}
