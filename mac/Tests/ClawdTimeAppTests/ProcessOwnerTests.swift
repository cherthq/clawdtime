import Darwin
import XCTest
@testable import ClawdTimeAppCore

/// The owner with real child processes: fake `start --foreground` and
/// `shared run` commands in one script that records what happens to it.
@MainActor
final class ProcessOwnerTests: XCTestCase {
  /// A launcher that acts as the desktop or the connection, by its first argument.
  private func launcher(_ folder: URL, desktopReady: Bool = true, desktopIgnoresTerm: Bool = false) throws -> URL {
    let record = folder.path.replacingOccurrences(of: "'", with: "'\\''")
    return try writeScript(folder.appendingPathComponent("runtime/bin/clawdtime"), """
    record='\(record)'
    case "$1" in
      start)
        echo "$$" > "$record/desktop.pid"
        sleep 600 &
        echo "$!" > "$record/desktop-child.pid"
        \(desktopIgnoresTerm ? "trap '' TERM" : "trap 'echo term >> \"$record/events\"; exit 0' TERM")
        echo 'Desktop starting'
        \(desktopReady ? "echo '{\"type\":\"ready\"}'" : "")
        while :; do sleep 1; done ;;
      shared)
        trap 'echo connection-term >> "$record/events"; exit 0' TERM
        echo "connection $*" >> "$record/events"
        while :; do sleep 1; done ;;
    esac
    """)
  }

  private func waitUntil(_ timeout: TimeInterval = 10, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  }

  private func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }
  private func pid(_ file: URL) -> pid_t? {
    (try? String(contentsOf: file, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
  }
  private func events(_ folder: URL) -> [String] {
    ((try? String(contentsOf: folder.appendingPathComponent("events"), encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  func testTheConnectionStartsOnlyAfterTheDesktopIsReadyAndStopEndsItFirst() throws {
    let folder = try temporaryFolder(self)
    let logs = folder.appendingPathComponent("Logs")
    let owner = ProcessOwner(launcher: try launcher(folder), logs: logs, grace: 3)
    owner.start(connection: true)
    XCTAssertEqual(owner.desktop, .starting)
    waitUntil { owner.connection == .running }
    XCTAssertEqual(owner.desktop, .running)
    XCTAssertTrue(owner.isActive)
    waitUntil { events(folder).contains("connection shared run") }
    XCTAssertEqual(events(folder), ["connection shared run"])

    var stopped = false
    owner.stop { stopped = true }
    XCTAssertEqual(owner.connection, .stopping)
    waitUntil { stopped }
    XCTAssertTrue(stopped)
    XCTAssertEqual(owner.desktop, .off)
    XCTAssertEqual(owner.connection, .off)
    XCTAssertFalse(owner.isActive)
    XCTAssertEqual(events(folder), ["connection shared run", "connection-term", "term"], "the connection ends before the desktop")
    // The desktop's own child, in its process group, is gone too.
    let child = try XCTUnwrap(pid(folder.appendingPathComponent("desktop-child.pid")))
    waitUntil { !alive(child) }
    XCTAssertFalse(alive(child))
    let log = try String(contentsOf: logs.appendingPathComponent("desktop.log"), encoding: .utf8)
    XCTAssertTrue(log.contains("Desktop starting"))
    let mode = try FileManager.default.attributesOfItem(atPath: logs.appendingPathComponent("desktop.log").path)[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o600)
  }

  func testWithoutAConnectionOnlyTheDesktopRuns() throws {
    let folder = try temporaryFolder(self)
    let owner = ProcessOwner(launcher: try launcher(folder), grace: 3)
    owner.start(connection: false)
    waitUntil { owner.desktop == .running }
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    XCTAssertEqual(owner.connection, .off)
    XCTAssertFalse(events(folder).contains { $0.hasPrefix("connection") })
    var stopped = false
    owner.stop { stopped = true }
    waitUntil { stopped }
    XCTAssertEqual(owner.desktop, .off)
  }

  func testADesktopThatIgnoresSIGTERMIsKilledWithItsGroupAfterTheGraceTime() throws {
    let folder = try temporaryFolder(self)
    let owner = ProcessOwner(launcher: try launcher(folder, desktopIgnoresTerm: true), grace: 0.4)
    owner.start(connection: false)
    waitUntil { owner.desktop == .running }
    let desktop = try XCTUnwrap(owner.desktopPID)
    var stopped = false
    let began = Date()
    owner.stop { stopped = true }
    waitUntil { stopped }
    XCTAssertTrue(stopped)
    XCTAssertLessThan(Date().timeIntervalSince(began), 5)
    XCTAssertFalse(alive(desktop))
    let child = try XCTUnwrap(pid(folder.appendingPathComponent("desktop-child.pid")))
    waitUntil { !alive(child) }
    XCTAssertFalse(alive(child))
  }

  func testADesktopThatNeverGetsReadyIsEndedAndNoConnectionStarts() throws {
    let folder = try temporaryFolder(self)
    let owner = ProcessOwner(launcher: try launcher(folder, desktopReady: false), readyTimeout: 3, grace: 2)
    owner.start(connection: true)
    waitUntil { if case .ended = owner.desktop { return true } else { return false } }
    XCTAssertEqual(owner.desktop, .ended("The desktop did not get ready."))
    XCTAssertEqual(owner.connection, .off)
    let desktop = try XCTUnwrap(pid(folder.appendingPathComponent("desktop.pid")))
    waitUntil { !alive(desktop) }
    XCTAssertFalse(alive(desktop))
  }

  func testWhenTheDesktopEndsTheConnectionEndsWithItAndNothingRestarts() throws {
    let folder = try temporaryFolder(self)
    let owner = ProcessOwner(launcher: try launcher(folder), grace: 3)
    owner.start(connection: true)
    waitUntil { owner.connection == .running && events(folder).contains("connection shared run") }
    let desktop = try XCTUnwrap(owner.desktopPID)
    kill(desktop, SIGKILL)
    waitUntil { if case .ended = owner.connection { return true } else { return false } }
    XCTAssertEqual(owner.desktop, .ended("The desktop stopped by signal 9."))
    XCTAssertEqual(owner.connection, .ended("The connection ended with the desktop."))
    XCTAssertTrue(events(folder).contains("connection-term"))
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    XCTAssertNil(owner.desktopPID, "no restart by itself")
    XCTAssertFalse(owner.isActive)
    // The child of the killed desktop does not outlive it.
    let child = try XCTUnwrap(pid(folder.appendingPathComponent("desktop-child.pid")))
    waitUntil { !alive(child) }
    XCTAssertFalse(alive(child))
  }

  func testAMissingLauncherEndsTheDesktopAtOnce() {
    let owner = ProcessOwner(launcher: URL(fileURLWithPath: "/nonexistent/clawdtime"))
    owner.start(connection: true)
    XCTAssertEqual(owner.desktop, .ended("The desktop could not start."))
    XCTAssertFalse(owner.isActive)
  }

  func testTheCommandsAreTheOnesTheRuntimeMustProvide() {
    XCTAssertEqual(ManagedCommand.desktop.arguments, ["start", "--tucked", "true", "--foreground"])
    XCTAssertTrue(ManagedCommand.desktop.waitsForReady)
    XCTAssertEqual(ManagedCommand.connection.arguments, ["shared", "run"])
    XCTAssertTrue(ManagedCommand.isReadyLine(#"{"type":"ready"}"#))
    XCTAssertTrue(ManagedCommand.isReadyLine(#"{"type":"ready","origin":"http://127.0.0.1:13326"}"#))
    XCTAssertFalse(ManagedCommand.isReadyLine("Desktop ready"))
    XCTAssertFalse(ManagedCommand.isReadyLine(#"{"type":"log"}"#))
  }
}
