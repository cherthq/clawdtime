import Foundation
import XCTest
@testable import TaskPanelCore

final class AgentBoardTests: XCTestCase {
  /// The same file that the TypeScript tests check against the service's schema.
  func fixture() throws -> AgentBoard {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/agent-board.json").standardizedFileURL
    return try JSONDecoder().decode(AgentBoard.self, from: Data(contentsOf: url))
  }
  func session(id: String = "100-abc123", name: String? = "deploy fix", project: String = "work", mode: String = "interactive",
               state: AgentBoard.State = .needsYou, detail: String = "permission_prompt", since: Double? = 1000,
               focus: String = "tab", terminal: AgentBoard.Terminal = .init(tty: "ttys001", app: "Terminal", tmux: nil, remote: false),
               host: String? = nil) -> AgentBoard.Session {
    .init(id: id, agentLabel: "Claude Code", name: name, project: project, mode: mode, state: state, detail: detail,
          since: since, focus: focus, terminal: terminal, host: host)
  }
  func board(_ sessions: [AgentBoard.Session], generatedAt: Double = 1000, intervalMs: Double? = 3000) -> AgentBoard {
    AgentBoard(version: 1, generatedAt: generatedAt, intervalMs: intervalMs,
      counts: .init(needsYou: sessions.filter { $0.state == .needsYou }.count, working: sessions.filter { $0.state == .working }.count,
                    idle: sessions.filter { $0.state == .idle }.count, unknown: sessions.filter { $0.state == .unknown }.count),
      sessions: sessions)
  }

  func testDecodesTheServiceContract() throws {
    let board = try fixture()
    try board.validate()
    XCTAssertEqual(board.counts, .init(needsYou: 1, working: 3, idle: 1, unknown: 1))
    XCTAssertEqual(board.sessions.map(\.state), [.needsYou, .working, .working, .working, .idle, .unknown])
    XCTAssertEqual(board.sessions[0].terminal, .init(tty: "ttys001", app: "Terminal", tmux: nil, remote: false))
    XCTAssertEqual(board.sessions[1].terminal.tmux, .init(session: "main", window: 2, pane: 1))
    XCTAssertEqual(board.sessions.map(\.canFocus), [true, true, false, true, true, true])
    XCTAssertNil(board.sessions[2].since)
  }

  // MARK: remote Macs

  func testASessionOfARemoteMacShowsItsMacAndOpensOverThere() throws {
    let board = try fixture()
    XCTAssertEqual(board.sessions.map(\.host), [nil, nil, nil, "mini", nil, nil])
    let remote = board.sessions[3]
    XCTAssertEqual(remote.id, "mini_512-abc123")
    XCTAssertTrue(AgentBoard.identity(remote.id))
    // The Mac comes first. The terminal application of that Mac is left out: it is not on this screen.
    XCTAssertEqual(AgentBoardText.place(remote), "on mini · tmux agents:0.1")
    XCTAssertEqual(AgentBoardText.subtitle(remote), "Codex · working · on mini · tmux agents:0.1")
    XCTAssertEqual(AgentBoardText.focusHint(remote), "Open its tmux pane on mini, in a new window")
    XCTAssertTrue(AgentBoardText.accessibility(remote, now: 1795156200000).contains("on mini"))
    let plain = session(id: "mini_7-a", focus: "app", host: "mini")
    XCTAssertEqual(AgentBoardText.place(plain), "on mini")
    XCTAssertEqual(AgentBoardText.focusHint(plain), "Open a shell on mini, in a new window")
    XCTAssertEqual(AgentBoardText.focusHint(session(id: "mini_7-a", focus: "none", host: "mini")), "Nothing on mini to open from here")
    XCTAssertEqual(AgentBoardText.place(session(id: "mini_bg-1", mode: "background", focus: "none", host: "mini")), "on mini · background")
    // A session of this Mac reads as before.
    XCTAssertEqual(AgentBoardText.place(board.sessions[0]), "Terminal")
    // A remote id is the host name, an underscore and that Mac's id: up to 64 characters.
    XCTAssertTrue(AgentBoard.identity("studio-2_bg-" + String(repeating: "a", count: 24)))
    XCTAssertFalse(AgentBoard.identity("m" + String(repeating: "a", count: 64)))
    XCTAssertThrowsError(try self.board([session(host: "Not A Host")]).validate())
    XCTAssertThrowsError(try self.board([session(host: String(repeating: "m", count: 17))]).validate())
  }
  func testARemoteMacThatDoesNotAnswerIsNamed() throws {
    let board = try fixture()
    XCTAssertEqual(board.hosts?.map(\.name), ["mini", "studio"])
    XCTAssertEqual(board.hosts?.map(\.ok), [true, false])
    XCTAssertEqual(AgentBoardText.hostsNote(board), "studio does not answer. ssh could not connect. It must work with no password prompt: ssh studio true")
    XCTAssertEqual(AgentBoardText.hostsNote(self.board([session()])), "")
    let answering = AgentBoard(version: 1, generatedAt: 1, intervalMs: 3000, counts: .init(needsYou: 0, working: 0, idle: 0, unknown: 0), sessions: [],
      hosts: [.init(name: "mini", ok: true, sessions: 0, checkedAt: 1, message: "")])
    try answering.validate()
    XCTAssertEqual(AgentBoardText.hostsNote(answering), "")
    let two = AgentBoard(version: 1, generatedAt: 1, intervalMs: 3000, counts: .init(needsYou: 0, working: 0, idle: 0, unknown: 0), sessions: [],
      hosts: [.init(name: "mini", ok: false, sessions: 0, checkedAt: nil, message: "No answer in time."), .init(name: "studio", ok: false, sessions: 0, checkedAt: 2, message: "")])
    try two.validate()
    XCTAssertEqual(AgentBoardText.hostsNote(two), "mini, studio do not answer. See: clawdtime hosts check NAME")
    // A host line that is not a host line is refused, and so is a book that is too long.
    XCTAssertThrowsError(try AgentBoard(version: 1, generatedAt: 1, intervalMs: 3000, counts: .init(needsYou: 0, working: 0, idle: 0, unknown: 0), sessions: [],
      hosts: [.init(name: "../x", ok: true, sessions: 0, checkedAt: 1, message: "")]).validate())
    XCTAssertThrowsError(try AgentBoard(version: 1, generatedAt: 1, intervalMs: 3000, counts: .init(needsYou: 0, working: 0, idle: 0, unknown: 0), sessions: [],
      hosts: (0..<17).map { .init(name: "m\($0)", ok: true, sessions: 0, checkedAt: 1, message: "") }).validate())
  }
  func testAFocusResultAndARequestOfARemoteMacAreNamedHonestly() throws {
    let pane = AgentFocusResult(ok: true, precision: "remote_pane"), shell = AgentFocusResult(ok: true, precision: "remote_mac")
    try pane.validate(); try shell.validate()
    XCTAssertEqual(pane.message, "Opened its tmux pane on that Mac, in a new window.")
    XCTAssertTrue(shell.message.hasPrefix("Opened a shell on that Mac."))
    XCTAssertThrowsError(try AgentFocusResult(ok: false, precision: "remote_pane").validate())
    XCTAssertThrowsError(try AgentFocusResult(ok: true, precision: "remote").validate())
    let json = #"{"version":1,"away":false,"callReady":false,"pending":[{"id":"0123456789abcdef","agentLabel":"Claude Code","kind":"permission","tool":"Bash","summary":"git push origin main","options":[],"project":"api","session":"migrations","sessionId":"mini_512-abc123","createdAt":1,"holdUntil":2,"allowedBefore":0,"deniedBefore":0,"canRemember":true,"host":"mini"},{"id":"fedcba9876543210","agentLabel":"Codex","kind":"permission","tool":"Bash","summary":"npm test","options":[],"project":"site","session":null,"sessionId":null,"createdAt":1,"holdUntil":2,"allowedBefore":1,"deniedBefore":0,"canRemember":true}]}"#
    let decisions = try JSONDecoder().decode(PendingDecisions.self, from: Data(json.utf8))
    try decisions.validate()
    XCTAssertEqual(decisions.pending.map(\.host), ["mini", nil])
    XCTAssertEqual(DecisionText.who(decisions.pending[0]), "migrations on mini")
    XCTAssertEqual(DecisionText.title(decisions.pending[0]), "migrations on mini asks to run")
    XCTAssertEqual(DecisionText.who(decisions.pending[1]), "Codex in site")
    let bad = json.replacingOccurrences(of: #""host":"mini""#, with: #""host":"A Bad Host""#)
    XCTAssertThrowsError(try JSONDecoder().decode(PendingDecisions.self, from: Data(bad.utf8)).validate())
  }
  func testAStateFromANewerServiceShowsAsUnknown() throws {
    let json = #"{"version":1,"generatedAt":1,"intervalMs":3000,"counts":{"needs_you":0,"working":0,"idle":0,"unknown":1},"sessions":[{"id":"1-a","agentLabel":"New","name":null,"project":"p","mode":"interactive","state":"paused_by_policy","detail":"a_new_detail","since":null,"focus":"app","terminal":{"tty":null,"app":null,"tmux":null,"remote":false}}]}"#
    let board = try JSONDecoder().decode(AgentBoard.self, from: Data(json.utf8))
    try board.validate()
    XCTAssertEqual(board.sessions[0].state, .unknown)
    XCTAssertEqual(AgentBoardText.detail(board.sessions[0].detail), "state not recognized")
  }
  func testValidationRejectsBoardsOutsideTheContract() {
    XCTAssertNoThrow(try board([session()]).validate())
    XCTAssertThrowsError(try AgentBoard(version: 2, generatedAt: 1, intervalMs: 3000, counts: .init(needsYou: 0, working: 0, idle: 0, unknown: 0), sessions: []).validate())
    XCTAssertThrowsError(try board([session(id: "../x")]).validate())
    XCTAssertThrowsError(try board([session(id: "A-UPPER")]).validate())
    XCTAssertThrowsError(try board([session(name: String(repeating: "n", count: 81))]).validate())
    XCTAssertThrowsError(try board([session(project: String(repeating: "p", count: 121))]).validate())
    XCTAssertThrowsError(try board([session(since: -1)]).validate())
    XCTAssertThrowsError(try board([session()], intervalMs: 0).validate())
    XCTAssertThrowsError(try board(Array(repeating: session(), count: 501)).validate())
    XCTAssertThrowsError(try AgentBoard(version: 1, generatedAt: 1, intervalMs: nil, counts: .init(needsYou: -1, working: 0, idle: 0, unknown: 0), sessions: []).validate())
  }
  func testAnOldBoardIsNotFresh() {
    let value = board([], generatedAt: 100_000, intervalMs: 3000)
    XCTAssertTrue(value.isFresh(now: 100_000 + 13_000))
    XCTAssertFalse(value.isFresh(now: 100_000 + 13_001))
    XCTAssertTrue(board([], generatedAt: 100_000, intervalMs: nil).isFresh(now: 113_000))
  }
  func testFocusResultMustAgreeWithItself() {
    XCTAssertNoThrow(try AgentFocusResult(ok: true, precision: "pane").validate())
    XCTAssertNoThrow(try AgentFocusResult(ok: false, precision: "none").validate())
    XCTAssertThrowsError(try AgentFocusResult(ok: true, precision: "none").validate())
    XCTAssertThrowsError(try AgentFocusResult(ok: false, precision: "tab").validate())
    XCTAssertThrowsError(try AgentFocusResult(ok: true, precision: "window").validate())
    XCTAssertEqual(AgentFocusResult(ok: true, precision: "app").message, "Brought its terminal forward. Choose the tab there.")
    XCTAssertEqual(AgentFocusResult(ok: false, precision: "none").message, "That session has no terminal on this Mac.")
  }
  func testTextIsCleanedAndBounded() {
    XCTAssertEqual(AgentBoardText.clean("  work\u{1B}[31m on\nthis\u{2028}\u{200B} "), "work [31m on this")
    XCTAssertEqual(AgentBoardText.clean(String(repeating: "x", count: 200)).count, 80)
    XCTAssertTrue(AgentBoardText.clean(String(repeating: "x", count: 200)).hasSuffix("…"))
    XCTAssertEqual(AgentBoardText.title(session(name: "deploy fix")), "deploy fix")
    XCTAssertEqual(AgentBoardText.title(session(name: nil)), "work")
    XCTAssertEqual(AgentBoardText.title(session(name: "\u{07}\u{1B}")), "work")
  }
  func testRowTextNamesTheAgentTheStateAndThePlace() throws {
    let board = try fixture()
    XCTAssertEqual(board.sessions.map(AgentBoardText.subtitle), [
      "Claude Code · permission needed · Terminal",
      "pi · running a tool · Ghostty · tmux main:2.1",
      "Claude Code · working · background",
      "Codex · working · on mini · tmux agents:0.1",
      "Codex · done · Ghostty",
      "Amp · no state signal · Ghostty",
    ])
    XCTAssertEqual(board.sessions.map(AgentBoardText.focusHint), ["Open its terminal tab", "Open its tmux pane",
      "No terminal on this Mac to open", "Open its tmux pane on mini, in a new window", "Bring its terminal forward", "Bring its terminal forward"])
    XCTAssertEqual(AgentBoardText.place(session(terminal: .init(tty: "ttys9", app: nil, tmux: nil, remote: true))), "remote")
    XCTAssertEqual(AgentBoardText.accessibility(board.sessions[0], now: board.generatedAt),
      "deploy fix, Claude Code · permission needed · Terminal, for 1m")
    XCTAssertEqual(AgentBoardText.accessibility(board.sessions[2], now: board.generatedAt), "director, Claude Code · working · background")
  }
  func testSummaryAndElapsedTime() {
    XCTAssertEqual(AgentBoardText.summary(.init(needsYou: 1, working: 3, idle: 9, unknown: 0)), "1 needs you · 3 working · 9 idle")
    XCTAssertEqual(AgentBoardText.summary(.init(needsYou: 2, working: 0, idle: 0, unknown: 1)), "2 need you · 1 unknown")
    XCTAssertEqual(AgentBoardText.summary(.init(needsYou: 0, working: 0, idle: 0, unknown: 0)), "No agent sessions")
    let now = 10_000_000_000.0
    XCTAssertEqual(AgentBoardText.elapsed(since: now - 45_000, now: now), "45s")
    XCTAssertEqual(AgentBoardText.elapsed(since: now - 12 * 60_000, now: now), "12m")
    XCTAssertEqual(AgentBoardText.elapsed(since: now - 185 * 60_000, now: now), "3h 05m")
    XCTAssertEqual(AgentBoardText.elapsed(since: now - 3121 * 60_000, now: now), "2d 04h")
    XCTAssertEqual(AgentBoardText.elapsed(since: now + 5000, now: now), "0s")
    XCTAssertEqual(AgentBoardText.elapsed(since: nil, now: now), "")
  }
  func testToolbarLineGivesWayToATaskThatWaitsForThePerson() {
    let waiting = AgentBoard.Counts(needsYou: 2, working: 1, idle: 0, unknown: 0)
    let quiet = AgentBoard.Counts(needsYou: 0, working: 1, idle: 4, unknown: 0)
    var line = AgentBoardText.toolbar(stage: "Ready when you are", taskNeedsPerson: false, counts: waiting)
    XCTAssertEqual(line.text, "2 agents need you"); XCTAssertTrue(line.attention)
    line = AgentBoardText.toolbar(stage: "Working on your task", taskNeedsPerson: false, counts: .init(needsYou: 1, working: 0, idle: 0, unknown: 0))
    XCTAssertEqual(line.text, "1 agent needs you")
    line = AgentBoardText.toolbar(stage: "Your input is needed", taskNeedsPerson: true, counts: waiting)
    XCTAssertEqual(line.text, "Your input is needed"); XCTAssertTrue(line.attention)
    line = AgentBoardText.toolbar(stage: "Working on your task", taskNeedsPerson: false, counts: quiet)
    XCTAssertEqual(line.text, "Working on your task"); XCTAssertFalse(line.attention)
    line = AgentBoardText.toolbar(stage: "Ready when you are", taskNeedsPerson: false, counts: nil)
    XCTAssertEqual(line.text, "Ready when you are"); XCTAssertFalse(line.attention)
  }
  func testActiveSessionsAlwaysShowAndQuietOnesAreCapped() {
    var sessions = [session(id: "1-a"), session(id: "2-a", state: .working)]
    for index in 0..<6 { sessions.append(session(id: "1\(index)-a", state: .idle)) }
    sessions.append(session(id: "99-a", state: .unknown))
    let rows = AgentBoardText.rows(board(sessions))
    XCTAssertEqual(rows.shown.map(\.id), ["1-a", "2-a", "10-a", "11-a", "12-a", "13-a"])
    XCTAssertEqual(rows.hidden, 3)
    let all = AgentBoardText.rows(board(Array(sessions.prefix(4))))
    XCTAssertEqual(all.shown.count, 4); XCTAssertEqual(all.hidden, 0)
    var busy: [AgentBoard.Session] = []
    for index in 0..<12 { busy.append(session(id: "2\(index)-a", state: .working)) }
    XCTAssertEqual(AgentBoardText.rows(board(busy)).shown.count, 12)
  }
  func testLaunchArgumentsAcceptOnlyAConfigPathAndTheTuckedSwitch() {
    XCTAssertEqual(PanelLaunch(arguments: ["panel", "--config", "/private/panel.json"]).map { [$0.configPath, String($0.tucked)] }, ["/private/panel.json", "false"])
    for arguments in [["panel", "--config", "/p.json", "--tucked"], ["panel", "--tucked", "--config", "/p.json"]] {
      XCTAssertEqual(PanelLaunch(arguments: arguments).map { [$0.configPath, String($0.tucked)] }, ["/p.json", "true"])
    }
    for arguments in [["panel"], ["panel", "--config"], ["panel", "--config", "relative.json"], ["panel", "--config", "/p.json", "extra"],
                      ["panel", "--tucked"], ["panel", "--config", "/p.json", "--tucked", "--tucked"], ["--config", "/p.json"]] {
      XCTAssertNil(PanelLaunch(arguments: arguments), arguments.joined(separator: " "))
    }
  }
}
