import Combine
import Darwin
import Foundation

/// A long-lived command of the runtime that the app owns after setup.
public struct ManagedCommand: Equatable, Sendable {
  public var name: String
  public var arguments: [String]
  /// The app waits for `{"type":"ready"}` on its stdout before it counts it as running.
  public var waitsForReady: Bool
  public init(name: String, arguments: [String], waitsForReady: Bool) {
    self.name = name; self.arguments = arguments; self.waitsForReady = waitsForReady
  }

  /// The desktop: the service and the panel, in local mode. It stays in the
  /// foreground for the desktop's whole life and stops both on SIGTERM.
  public static let desktop = ManagedCommand(name: "desktop", arguments: ["start", "--tucked", "true", "--foreground"], waitsForReady: true)
  /// The one shared connection. It needs a ready desktop and ends on SIGTERM.
  public static let connection = ManagedCommand(name: "connection", arguments: ["shared", "run"], waitsForReady: false)

  /// A stdout line that says the command is ready.
  public static func isReadyLine(_ line: String) -> Bool {
    guard let data = line.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return object["type"] as? String == "ready"
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
  func start(connection: Bool)
  func stop(completion: @escaping @MainActor () -> Void)
}

/// The one owner of the desktop and connection processes. It starts the
/// connection only after the desktop is ready, ends the connection when the
/// desktop ends, and never restarts either by itself: a new start is the
/// person's choice.
@MainActor
public final class ProcessOwner: ObservableObject, ProcessOwning {
  @Published public private(set) var desktop: OwnedStatus = .off
  @Published public private(set) var connection: OwnedStatus = .off

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
  public var desktopPID: pid_t? { desktopChild?.pid }
  public var connectionPID: pid_t? { connectionChild?.pid }

  /// Starts the desktop, then the connection once the desktop is ready.
  public func start(connection wanted: Bool) {
    guard !stopping, desktopChild == nil else { return }
    wantsConnection = wanted
    generation += 1
    let current = generation
    desktop = .starting
    do {
      desktopChild = try spawn(desktopCommand, onLine: { [weak self] line in
        guard let self, current == self.generation, self.desktop == .starting, ManagedCommand.isReadyLine(line) else { return }
        self.desktopReady()
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
      executable: launcher, arguments: command.arguments, environment: environment,
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
