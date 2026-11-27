import Foundation

/// `ClawdTime --self-test`: checks the bundled runtime and the engine handshake
/// with no window. It starts `onboard --json --app --local`, waits for
/// `hello`, sends `cancel` and waits for the engine to leave.
///
/// It runs on every build, often from a shell with a real home and a model
/// key, so the engine gets none of that: a new empty home, its own temporary
/// folder and the system path, and nothing else. With no key and a cancel
/// right after `hello`, setup stops before any effect, so no desktop starts.
/// A home that is not empty after the engine left fails the self-test.
public enum SelfTest {
  public struct Report: Encodable, Equatable {
    public var ok: Bool
    public var runtime: String
    public var runtimeVersion: String?
    public var runtimeCommit: String?
    public var filesVerified: Int?
    public var filesSigned: Int?
    public var engineProtocol: Int?
    public var engineVersion: String?
    public var engineExit: Int32?
    public var problem: String?

    public func json() -> String {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{\"ok\":false}"
    }
  }

  /// The environment of the engine: `PATH` from the app's environment (with
  /// the system folders), the temporary `HOME` and `TMPDIR`, and nothing else.
  public static func engineEnvironment(home: URL, temporary: URL, from app: [String: String]) -> [String: String] {
    ["PATH": childEnvironment(["PATH": app["PATH"] ?? ""])["PATH"]!, "HOME": home.path, "TMPDIR": temporary.path + "/"]
  }

  /// `environment` is the app's own; the engine gets only its path from it.
  public static func run(runtime root: URL, timeout: TimeInterval = 30, environment: [String: String] = ProcessInfo.processInfo.environment) -> Report {
    var report = Report(ok: false, runtime: root.path)
    let layout: RuntimeLayout
    do {
      layout = try RuntimeLayout.load(root)
      report.runtimeVersion = layout.manifest.version
      report.runtimeCommit = layout.manifest.commit
      let checked = try layout.verification()
      report.filesVerified = checked.hashed
      report.filesSigned = checked.signed
    } catch {
      report.problem = String(describing: error)
      return report
    }

    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("ClawdTime self-test \(UUID().uuidString)", isDirectory: true)
    let home = scratch.appendingPathComponent("home", isDirectory: true)
    let temporary = scratch.appendingPathComponent("tmp", isDirectory: true)
    do {
      for folder in [home, temporary] {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      }
    } catch {
      report.problem = "The self-test could not make its temporary home."
      return report
    }
    defer { try? FileManager.default.removeItem(at: scratch) }

    let queue = DispatchQueue(label: "com.clawdtime.app.self-test")
    let engine = EngineProcess(executable: layout.launcher, arguments: SetupProtocol.arguments(local: true),
                               environment: engineEnvironment(home: home, temporary: temporary, from: environment),
                               directory: home, deliver: queue)
    let hello = DispatchSemaphore(value: 0), exited = DispatchSemaphore(value: 0)
    var greeting: (Int, String)?
    var exit: Int32?
    var unreadable = 0
    engine.onEvent = { event in
      if case .hello(let version, let name) = event, greeting == nil {
        greeting = (version, name)
        hello.signal()
      }
    }
    engine.onUnreadableLine = { unreadable += 1 }
    engine.onExit = { status, _ in
      exit = status
      hello.signal()
      exited.signal()
    }
    do { try engine.start() } catch {
      report.problem = "The engine could not start: \(error.localizedDescription)"
      return report
    }
    if hello.wait(timeout: .now() + timeout) == .timedOut {
      engine.cancel(grace: 1)
      _ = exited.wait(timeout: .now() + 5)
      report.problem = "The engine did not say hello within \(Int(timeout)) seconds."
      return report
    }
    let said = queue.sync { greeting }
    engine.cancel(grace: 5)
    _ = exited.wait(timeout: .now() + 15)
    queue.sync {
      report.engineExit = exit
      if unreadable > 0 { report.problem = "The engine wrote \(unreadable) line(s) that are not protocol JSON." }
    }
    guard let said else {
      report.problem = report.problem ?? "The engine left before it said hello."
      return report
    }
    report.engineProtocol = said.0
    report.engineVersion = said.1
    guard said.0 == SetupProtocol.version else {
      report.problem = "The engine speaks protocol \(said.0); this app speaks protocol \(SetupProtocol.version)."
      return report
    }
    guard report.engineExit != nil else {
      report.problem = "The engine did not leave after cancel."
      return report
    }
    let left = ((try? FileManager.default.contentsOfDirectory(atPath: home.path)) ?? []).sorted()
    if !left.isEmpty {
      report.problem = "The engine wrote into its temporary home after cancel: \(left.joined(separator: ", "))."
      return report
    }
    report.ok = report.problem == nil
    return report
  }
}
