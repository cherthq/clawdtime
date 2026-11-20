import Foundation
import XCTest
@testable import TaskPanelCore

/// What the watcher found, as the panel reads and shows it.
final class WatchTests: XCTestCase {
  /// The same file that the TypeScript tests check against the service's schema and sentences.
  func fixture() throws -> Incidents {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/agent-incidents.json").standardizedFileURL
    return try JSONDecoder().decode(Incidents.self, from: Data(contentsOf: url))
  }
  let now = 1_795_156_200_000.0
  func incident(_ kind: String, id: String = "0123456789ab", session: String = "100-abc", title: String = "deploy fix", host: String? = nil,
                since: Double = 1_000_000, workedMs: Double? = nil, cause: String? = nil, raisedAt: Double = 1_100_000,
                text: String = "the service's own sentence") -> Incidents.Incident {
    .init(id: id, kind: kind, sessionId: session, title: title, agentLabel: "Claude Code", host: host, since: since,
          workedMs: workedMs, cause: cause, raisedAt: raisedAt, text: text)
  }
  func session(_ id: String, _ state: AgentBoard.State, name: String? = nil, focus: String = "tab", since: Double? = 1_000_000) -> AgentBoard.Session {
    .init(id: id, agentLabel: "Claude Code", name: name, project: "work", mode: "interactive", state: state, detail: state == .needsYou ? "question" : "turn_running",
          since: since, focus: focus, terminal: .init(tty: "ttys001", app: "Terminal", tmux: nil, remote: false))
  }
  func board(_ sessions: [AgentBoard.Session]) -> AgentBoard {
    AgentBoard(version: 1, generatedAt: 1_120_000, intervalMs: 3000,
      counts: .init(needsYou: sessions.filter { $0.state == .needsYou }.count, working: sessions.filter { $0.state == .working }.count,
                    idle: sessions.filter { $0.state == .idle }.count, unknown: sessions.filter { $0.state == .unknown }.count), sessions: sessions)
  }
  func status(_ sessions: [AgentBoard.Session], _ incidents: [Incidents.Incident], task: Bool = false,
              decisions: [PendingDecisions.Request] = [], connected: Bool = true) -> PetStatus {
    PetStatus.make(board: board(sessions), connected: connected, taskNeedsPerson: task, sharing: false, quietSeconds: 0,
                   now: 1_120_000, decisions: decisions, incidents: incidents)
  }

  func testDecodesTheServiceContractAndRejectsWhatIsOutsideIt() throws {
    let found = try fixture()
    try found.validate()
    XCTAssertEqual(found.incidents.map(\.kind), ["failed", "waiting", "stalled", "finished"])
    XCTAssertEqual(found.incidents.map(\.isTrouble), [true, false, true, false])
    XCTAssertEqual(found.incidents[0].cause, "gone"); XCTAssertEqual(found.incidents[0].workedMs, 480_000)
    XCTAssertNil(found.incidents[1].workedMs); XCTAssertNil(found.incidents[1].host)
    XCTAssertEqual(found.incidents[2].host, "mini"); XCTAssertEqual(found.incidents[2].sessionId, "mini_512-abc123")
    // The words made here say the same as the service's own sentences.
    XCTAssertEqual(found.incidents.map { IncidentText.who($0) + " " + IncidentText.detail($0, now: now) }, [
      "docs gone: its process ended in the middle of its work",
      "deploy fix has waited for you for 5m",
      "ios build on mini no sign of life for 12m",
      "site done after 12m",
    ])
    XCTAssertTrue(Incidents.identity("a1b2c3d4e5f6"))
    for bad in ["", "A1B2C3D4E5F6", "a1b2c3d4e5f", "../watch.json", "a1b2c3d4e5f6a"] { XCTAssertFalse(Incidents.identity(bad), bad) }
    func invalid(_ incident: Incidents.Incident, _ note: String) {
      XCTAssertThrowsError(try Incidents(version: 1, incidents: [incident]).validate(), note)
    }
    invalid(incident("stalled", id: "nope"), "id")
    invalid(incident("stalled", session: "../etc"), "session id")
    invalid(incident("stalled", title: String(repeating: "x", count: 81)), "title")
    invalid(incident("stalled", host: "Mini Mac"), "host")
    invalid(incident("stalled", since: -1), "since")
    invalid(incident("finished", workedMs: -5), "worked")
    invalid(incident("stalled", text: String(repeating: "x", count: 401)), "text")
    XCTAssertThrowsError(try Incidents(version: 2, incidents: []).validate())
    XCTAssertNoThrow(try Incidents(version: 1, incidents: []).validate())
  }

  func testWordsForEachKindCountTheTimeNow() {
    let wait = incident("waiting", since: 1_000_000)
    XCTAssertEqual(IncidentText.detail(wait, now: 1_000_000 + 125_000), "has waited for you for 2m")
    XCTAssertEqual(IncidentText.detail(wait, now: 1_000_000 + 3_700_000), "has waited for you for 1h 01m")
    XCTAssertEqual(IncidentText.detail(incident("stalled", since: 1_000_000), now: 1_000_000 + 600_000), "no sign of life for 10m")
    XCTAssertEqual(IncidentText.detail(incident("failed", workedMs: 480_000, cause: "error"), now: 0), "stopped on an error after 8m")
    XCTAssertEqual(IncidentText.detail(incident("failed", cause: "error"), now: 0), "stopped on an error")
    XCTAssertEqual(IncidentText.detail(incident("failed", workedMs: 480_000, cause: "gone"), now: 0), "gone: its process ended in the middle of its work")
    XCTAssertEqual(IncidentText.detail(incident("finished", workedMs: 45_000), now: 0), "done after 45s")
    XCTAssertEqual(IncidentText.detail(incident("finished"), now: 0), "is done")
    // A kind that a newer service adds shows with the service's own sentence, cleaned.
    XCTAssertEqual(IncidentText.detail(incident("rested", text: "deploy fix\u{1B}[31m rests."), now: 0), "deploy fix [31m rests.")
    XCTAssertEqual(IncidentText.headline(incident("stalled")), "deploy fix shows no sign of life")
    XCTAssertEqual(IncidentText.headline(incident("failed", cause: "gone")), "deploy fix is gone")
    XCTAssertEqual(IncidentText.headline(incident("failed", host: "mini", cause: "error")), "deploy fix on mini stopped on an error")
    XCTAssertEqual(IncidentText.headline(incident("finished")), "deploy fix is done")
    // A name with control characters is cleaned, and an empty one falls back to the agent.
    XCTAssertEqual(IncidentText.who(incident("stalled", title: "a\u{07}b")), "a b")
    XCTAssertEqual(IncidentText.who(incident("stalled", title: "")), "Claude Code")
  }

  func testTheBubbleKeepsItsPrioritiesAndShowsTheNewestIncidentWhenNothingWaits() {
    let work = session("100-abc", .working, name: "deploy fix")
    let stalled = incident("stalled", id: "aaaaaaaaaaaa", session: "100-abc", since: 400_000, raisedAt: 1_000_000)
    let done = incident("finished", id: "bbbbbbbbbbbb", session: "200-abc", title: "docs", workedMs: 720_000, raisedAt: 1_100_000)
    // Nothing waits: the newest thing the watcher found shows.
    var shown = status([work], [stalled, done])
    XCTAssertEqual(shown.bubble, .init(key: "incident:bbbbbbbbbbbb", title: "docs", detail: "done after 12m", sessionId: nil, incidentId: "bbbbbbbbbbbb"))
    // Its session is on the board and can be opened: a click goes there.
    shown = status([work], [stalled])
    XCTAssertEqual(shown.bubble, .init(key: "incident:aaaaaaaaaaaa", title: "deploy fix", detail: "no sign of life for 12m",
                                       sessionId: "100-abc", incidentId: "aaaaaaaaaaaa"))
    // A session with no terminal to open: a click opens the board.
    XCTAssertNil(status([session("100-abc", .working, focus: "none")], [stalled]).bubble?.sessionId)
    // A session that waits has its own bubble, and it comes first.
    let asks = session("300-abc", .needsYou, name: "site")
    shown = status([asks, work], [stalled, done])
    XCTAssertEqual(shown.bubble?.title, "site"); XCTAssertNil(shown.bubble?.incidentId)
    // A long wait is not said twice: the waiting session says it.
    let waited = incident("waiting", id: "cccccccccccc", session: "300-abc", title: "site", raisedAt: 1_110_000)
    XCTAssertNil(status([asks], [waited]).bubble?.incidentId)
    XCTAssertNil(status([work], [waited]).bubble, "a wait alone, with its session gone from the list, makes no bubble")
    // The task and a request that can be answered here come before anything the watcher found.
    XCTAssertEqual(status([work], [stalled], task: true).bubble?.key, "task")
    let request = PendingDecisions.Request(id: "0123456789abcdef", agentLabel: "Claude Code", kind: "permission", tool: "Bash", summary: "npm test",
      options: [], project: "app", session: nil, sessionId: nil, createdAt: 1, holdUntil: 2, allowedBefore: 0, deniedBefore: 0, canRemember: true)
    XCTAssertEqual(status([work], [stalled], decisions: [request]).bubble?.key, "decision:0123456789abcdef")
    // No incidents: exactly what it showed before.
    XCTAssertNil(status([work], []).bubble)
  }

  func testTroubleAsksForAttentionAndFinishedWorkDoesNot() {
    let work = session("100-abc", .working, name: "deploy fix")
    let stalled = incident("stalled", id: "aaaaaaaaaaaa", session: "100-abc", raisedAt: 1_000_000)
    let gone = incident("failed", id: "dddddddddddd", session: "400-abc", title: "api", cause: "gone", raisedAt: 1_050_000)
    let done = incident("finished", id: "bbbbbbbbbbbb", session: "200-abc", title: "docs", raisedAt: 1_100_000)
    XCTAssertEqual(status([work], []).mood, .working); XCTAssertEqual(status([work], []).headline, "1 agent at work")
    XCTAssertEqual(status([work], [stalled]).mood, .attention); XCTAssertEqual(status([work], [stalled]).headline, "deploy fix shows no sign of life")
    // The newest trouble is the headline.
    XCTAssertEqual(status([work], [stalled, gone]).headline, "api is gone")
    // Finished work is good news: the mood stays, the bubble tells it.
    XCTAssertEqual(status([work], [done]).mood, .working)
    XCTAssertEqual(status([], [done]).mood, .idle); XCTAssertEqual(status([], [done]).bubble?.incidentId, "bbbbbbbbbbbb")
    // A session that waits and a request come before trouble in the headline too.
    XCTAssertEqual(status([session("300-abc", .needsYou, name: "site"), work], [gone]).headline, "1 agent needs you")
    // Not connected: nothing the watcher found changes that.
    XCTAssertEqual(status([work], [gone], connected: false).mood, .offline)
  }
}
