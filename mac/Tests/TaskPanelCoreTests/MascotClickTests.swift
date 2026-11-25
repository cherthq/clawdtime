import XCTest
@testable import TaskPanelCore

/// ClawdTime is a computer use agent. A click on the mascot opens the chat, where the person gives it
/// work. Nothing that the mascot or its bubble opens lists coding sessions.
final class MascotClickTests: XCTestCase {
  private func session(_ id: String, focus: String = "tab") -> AgentBoard.Session {
    .init(id: id, agentLabel: "Claude Code", name: "deploy fix", project: "work", mode: "interactive", state: .needsYou,
          detail: "permission_prompt", since: 1_000_000, focus: focus, terminal: .init(tty: "ttys001", app: "Terminal", tmux: nil, remote: false))
  }
  private func board(_ sessions: [AgentBoard.Session]) -> AgentBoard {
    AgentBoard(version: 1, generatedAt: 1_120_000, intervalMs: 3000,
      counts: .init(needsYou: sessions.count, working: 0, idle: 0, unknown: 0), sessions: sessions)
  }
  private func request(kind: String = "permission", options: [String] = []) -> PendingDecisions.Request {
    .init(id: "0123456789abcdef", agentLabel: "Claude Code", kind: kind, tool: "Bash", summary: "npm test", options: options, project: "app",
          session: "deploy fix", sessionId: "1-a", createdAt: 1_000_000, holdUntil: 1_045_000, allowedBefore: 0, deniedBefore: 0, canRemember: true)
  }

  func testAClickOnTheMascotOpensTheChatAndNeverTheBoard() {
    XCTAssertEqual(MascotClick.release(didDrag: false, docked: false), .openChat)
    // A tucked mascot first comes out of the edge. A drag is only a drag.
    XCTAssertEqual(MascotClick.release(didDrag: false, docked: true), .undock)
    XCTAssertEqual(MascotClick.release(didDrag: true, docked: false), .none)
    XCTAssertEqual(MascotClick.release(didDrag: true, docked: true), .none)
    // No press of the mascot opens a session, and there is no board to open.
    for dragged in [false, true] {
      for docked in [false, true] {
        let result = MascotClick.release(didDrag: dragged, docked: docked)
        XCTAssertTrue([MascotClick.openChat, .undock, .none].contains(result), "\(result)")
      }
    }
  }

  func testABubbleOpensItsOneSessionAndEveryOtherBubbleOpensTheChat() throws {
    // One session that waits for the person: its bubble brings that session's terminal forward.
    let one = try XCTUnwrap(PetStatus.make(board: board([session("1-a")]), connected: true, taskNeedsPerson: false, sharing: false,
                                           quietSeconds: 0, now: 1_120_000).bubble)
    XCTAssertEqual(MascotClick.bubble(one), .openSession("1-a"))
    XCTAssertEqual(MascotClick.hint(one), "Open this session's terminal")
    // A session with no terminal on this Mac, several sessions, a task, a request of an agent,
    // and a caption of the conversation: the chat opens.
    let none = try XCTUnwrap(PetStatus.make(board: board([session("bg-1", focus: "none")]), connected: true, taskNeedsPerson: false,
                                            sharing: false, quietSeconds: 0, now: 1_120_000).bubble)
    let many = try XCTUnwrap(PetStatus.make(board: board([session("1-a"), session("2-a")]), connected: true, taskNeedsPerson: false,
                                            sharing: false, quietSeconds: 0, now: 1_120_000).bubble)
    let task = try XCTUnwrap(PetStatus.make(board: nil, connected: true, taskNeedsPerson: true, sharing: false, quietSeconds: 0, now: 0).bubble)
    let asks = try XCTUnwrap(PetStatus.make(board: nil, connected: true, taskNeedsPerson: false, sharing: false, quietSeconds: 0, now: 0,
                                            decisions: [request()]).bubble)
    let question = try XCTUnwrap(PetStatus.make(board: nil, connected: true, taskNeedsPerson: false, sharing: false, quietSeconds: 0, now: 0,
                                                decisions: [request(kind: "question", options: ["Red", "Blue"])]).bubble)
    let caption = PetStatus.Bubble.said(heard: "open the mail", reply: "It is open.", at: 5).bubble
    for bubble in [none, many, task, asks, question, caption] {
      XCTAssertEqual(MascotClick.bubble(bubble), .openChat, bubble.key)
    }
    XCTAssertEqual(MascotClick.hint(asks), "Answer here, or click to open the chat")
    for bubble in [none, many, task, question, caption] { XCTAssertEqual(MascotClick.hint(bubble), "Open the chat", bubble.key) }
    // A caption is what was said: it opens the chat even when it names a session.
    let spoken = PetStatus.Bubble(key: "say-1", title: "x", detail: "y", sessionId: "1-a", caption: true)
    XCTAssertEqual(MascotClick.bubble(spoken), .openChat)
    // No tooltip names a board.
    for bubble in [one, none, many, task, asks, question, caption] {
      XCTAssertFalse(MascotClick.hint(bubble).lowercased().contains("board"))
      XCTAssertFalse(bubble.detail.lowercased().contains("board"))
    }
  }
}
