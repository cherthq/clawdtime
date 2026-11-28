import Combine
import Darwin
import Foundation

/// A long-lived command of the runtime that the app owns after setup.
public struct ManagedCommand: Equatable, Sendable {
  public var name: String
  public var arguments: [String]
  /// The app waits for `{"type":"ready"}` on its stdout before it counts it as running.
  public var waitsForReady: Bool
  /// Added to the app's child environment for this command alone.
  public var environment: [String: String]
  public init(name: String, arguments: [String], waitsForReady: Bool, environment: [String: String] = [:]) {
    self.name = name; self.arguments = arguments; self.waitsForReady = waitsForReady; self.environment = environment
  }

  /// The desktop: the service and the panel, in local mode. It stays in the
  /// foreground for the desktop's whole life and stops both on SIGTERM.
  public static let desktop = ManagedCommand(name: "desktop", arguments: ["start", "--tucked", "true", "--foreground"], waitsForReady: true)
  /// The desktop of the app at `app`. `CLAWDTIME_APP_BUNDLE` reaches the panel
  /// alone: the panel then adds Settings and Stop ClawdTime to its menu and
  /// opens them in this app. Outside an app bundle nothing is added.
  public static func desktop(app: URL?) -> ManagedCommand {
    guard let app, app.pathExtension == "app" else { return desktop }
    var command = desktop
    command.environment = ["CLAWDTIME_APP_BUNDLE": app.standardizedFileURL.path]
    return command
  }
  /// The same desktop, but its panel opens with the chat in focus and one
  /// suggested first request: the end of setup, when the person chooses Start talking.
  public func openingChat() -> ManagedCommand {
    var command = self
    if let index = command.arguments.firstIndex(of: "--tucked"), index + 1 < command.arguments.count {
      command.arguments.replaceSubrange(index...index + 1, with: ["--chat"])
    }
    return command
  }
  /// The one shared connection. It needs a ready desktop and ends on SIGTERM.
  /// `--owned`: it also ends by itself when the app is gone, after a crash too,
  /// so it never stays connected with no owner and never keeps the lock.
  public static let connection = ManagedCommand(name: "connection", arguments: ["shared", "run", "--owned"], waitsForReady: false)

  /// A stdout line that says the command is ready.
  public static func isReadyLine(_ line: String) -> Bool { object(line)?["type"] as? String == "ready" }

  /// The desktop's stdout line that says its panel closed while it runs on.
  public static func isPanelClosedLine(_ line: String) -> Bool {
    guard let object = object(line) else { return false }
    return object["type"] as? String == "panel" && object["state"] as? String == "closed"
  }

  private static func object(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }
}

public enum OwnedStatus: Equatable, Sendable {
  case off, starting, running, stopping
  /// It ended without a Stop. Nothing restarts it by itself.
  case ended(String)

  public var isLive: Bool { self == .starting || self == .running || self == .stopping }
}

/// What the setup window and the menu need from the owner. Tests replace it.
@MainActor
public protocol ProcessOwning: AnyObject {
  var isActive: Bool { get }
  /// `chat`: the panel opens with the chat in focus, for the end of setup.
  func start(connection: Bool, chat: Bool)
  func stop(completion: @escaping @MainActor () -> Void)
}

extension ProcessOwning {
  public func start(connection: Bool) { start(connection: connection, chat: false) }
}

/// The one owner of the desktop and connection processes. It starts the
/// connection only after the desktop is ready, ends the connection when the
/// desktop ends, and never restarts either by itself: a new start is the
/// person's choice.
@MainActor
public final class ProcessOwner: ObservableObject, ProcessOwning {
  @Published public private(set) var desktop: OwnedStatus = .off
  @Published public private(set) var connection: OwnedStatus = .off
  /// The desktop said that its panel closed. The desktop and its work run on.
  @Published private var panelClosed = false

  private let launcher: URL
  private let environment: [String: String]
  private let logs: URL?
  private let desktopCommand: ManagedCommand
  private let connectionCommand: ManagedCommand
  private let readyTimeout: TimeInterval
  private let grace: TimeInterval
  private var desktopChild: ChildProcess?
  private var connectionChild: ChildProcess?
  private var wantsConnection = false
  private var stopping = false
  private var stopWaiters: [@MainActor () -> Void] = []
  private var generation = 0

  public init(
    launcher: URL, environment: [String: String] = childEnvironment(), logs: URL? = nil,
    desktop: ManagedCommand = .desktop, connection: ManagedCommand = .connection,
    readyTimeout: TimeInterval = 120, grace: TimeInterval = 10
  ) {
    self.launcher = launcher
    self.environment = environment
    self.logs = logs
    desktopCommand = desktop
    connectionCommand = connection
    self.readyTimeout = readyTimeout
    self.grace = grace
  }

  public var isActive: Bool { desktop.isLive || connection.isLive }
  /// The panel of the running desktop is open: from the ready line, which
  /// comes after the panel started, until the desktop says it closed.
  public var panelOpen: Bool { desktop == .running && !panelClosed }
  public var desktopPID: pid_t? { desktopChild?.pid }
  public var connectionPID: pid_t? { connectionChild?.pid }

  /// Starts the desktop, then the connection once the desktop is ready. A
  /// desktop that runs already is kept: then only a connection that is
  /// wanted and not running starts, beside it. `chat`: the panel opens with
  /// the chat in focus.
  public func start(connection wanted: Bool, chat: Bool = false) {
    guard !stopping else { return }
    guard desktopChild == nil else {
      if wanted, desktop == .running, connectionChild == nil {
        wantsConnection = true
        desktopReady()
      }
      return
    }
    wantsConnection = wanted
    generation += 1
    let current = generation
    panelClosed = false
    desktop = .starting
    do {
      desktopChild = try spawn(chat ? desktopCommand.openingChat() : desktopCommand, onLine: { [weak self] line in
        guard let self, current == self.generation else { return }
        if self.desktop == .starting, ManagedCommand.isReadyLine(line) {
          self.desktopReady()
        } else if self.desktop == .running, ManagedCommand.isPanelClosedLine(line) {
          self.panelClosed = true
        }
      }, onExit: { [weak self] ending in
        self?.desktopEnded(ending, generation: current)
      })
    } catch {
      desktop = .ended("The desktop could not start.")
      return
    }
    if !desktopCommand.waitsForReady {
      desktopReady()
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + readyTimeout) { [weak self] in
        guard let self, current == self.generation, self.desktop == .starting else { return }
        self.desktop = .ended("The desktop did not get ready.")
        self.end(self.desktopChild) {}
      }
    }
  }

  /// Ends the connection first, so remote access is off before anything else,
  /// then the desktop. Each gets SIGTERM, then SIGKILL for its whole group
  /// after the grace time.
  public func stop(completion: @escaping @MainActor () -> Void) {
    stopWaiters.append(completion)
    guard !stopping else { return }
    stopping = true
    generation += 1
    wantsConnection = false
    if connection.isLive { connection = .stopping }
    if desktop.isLive { desktop = .stopping }
    end(connectionChild) { [weak self] in
      guard let self else { return }
      self.connection = .off
      self.connectionChild = nil
      self.end(self.desktopChild) { [weak self] in
        guard let self else { return }
        self.desktop = .off
        self.desktopChild = nil
        self.stopping = false
        let waiters = self.stopWaiters
        self.stopWaiters = []
        waiters.forEach { $0() }
      }
    }
  }

  private func desktopReady() {
    desktop = .running
    guard wantsConnection, connectionChild == nil else { return }
    let current = generation
    connection = .starting
    do {
      connectionChild = try spawn(connectionCommand, onLine: { _ in }, onExit: { [weak self] ending in
        self?.connectionEnded(ending, generation: current)
      })
      connection = .running
    } catch {
      connection = .ended("The connection could not start.")
    }
  }

  private func desktopEnded(_ ending: ChildProcess.Ending, generation ended: Int) {
    guard ended == generation, !stopping else { return }
    desktopChild?.signalGroup(SIGTERM)
    desktopChild = nil
    if case .ended = desktop {} else { desktop = .ended(Self.describe("The desktop", ending)) }
    // A connection belongs to one desktop lifetime.
    if connectionChild != nil {
      connection = .stopping
      end(connectionChild) { [weak self] in
        self?.connectionChild = nil
        self?.connection = .ended("The connection ended with the desktop.")
      }
    }
  }

  private func connectionEnded(_ ending: ChildProcess.Ending, generation ended: Int) {
    guard ended == generation, !stopping else { return }
    connectionChild?.signalGroup(SIGTERM)
    connectionChild = nil
    if connection != .stopping { connection = .ended(Self.describe("The connection", ending)) }
  }

  private static func describe(_ name: String, _ ending: ChildProcess.Ending) -> String {
    switch ending {
    case .exited(0): "\(name) stopped."
    case .exited(let code): "\(name) stopped with status \(code)."
    case .signaled(let signal): "\(name) stopped by signal \(signal)."
    }
  }

  private func spawn(_ command: ManagedCommand, onLine: @escaping (String) -> Void, onExit: @escaping (ChildProcess.Ending) -> Void) throws -> ChildProcess {
    try ChildProcess.spawn(
      executable: launcher, arguments: command.arguments, environment: environment.merging(command.environment) { $1 },
      log: logFile(command.name), queue: .main,
      onLine: { line in MainActor.assumeIsolated { onLine(line) } },
      onExit: { ending in MainActor.assumeIsolated { onExit(ending) } })
  }

  private func logFile(_ name: String) -> URL? {
    guard let logs else { return nil }
    let files = FileManager.default
    try? files.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = logs.appendingPathComponent("\(name).log")
    if let size = (try? files.attributesOfItem(atPath: file.path))?[.size] as? Int, size > 4 << 20 {
      try? files.removeItem(at: file)
    }
    if !files.fileExists(atPath: file.path) {
      files.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    return file
  }

  /// SIGTERM now; SIGKILL for the whole group if it is still there after the grace time.
  private func end(_ child: ChildProcess?, then done: @escaping @MainActor () -> Void) {
    guard let child, child.isRunning else {
      child?.signalGroup(SIGTERM)
      done()
      return
    }
    child.signal(SIGTERM)
    let deadline = Date().addingTimeInterval(grace)
    func poll() {
      if !child.isRunning {
        child.signalGroup(SIGTERM)
        done()
      } else if Date() >= deadline {
        child.signalGroup(SIGKILL)
        child.signal(SIGKILL)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { MainActor.assumeIsolated { poll() } }
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { MainActor.assumeIsolated { poll() } }
      }
    }
    poll()
  }
}
