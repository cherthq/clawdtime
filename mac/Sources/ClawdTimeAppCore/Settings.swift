import Foundation

/// One provider, from `clawdtime keys list --json`. It never holds a key.
public struct ProviderKey: Decodable, Equatable, Identifiable, Sendable {
  public enum Source: String, Decodable, Sendable { case store, environment }
  public var id: String
  public var name: String
  public var set: Bool
  /// Where the key that is used comes from. Nil: no key.
  public var source: Source?
  /// The variable of the environment that holds it.
  public var variable: String?
  /// The key store holds a key for it, maybe under one from the environment.
  public var stored: Bool
  public var defaultModel: String?
  public var needsModel: Bool
  public var needsBaseUrl: Bool

  /// A key from the environment wins and is not ClawdTime's to remove.
  public var canRemove: Bool { stored && source == .store }
}

/// `clawdtime keys list --json`.
public struct KeysReport: Decodable, Equatable, Sendable {
  public var version: Int
  public var store: String
  public var problem: String?
  public var providers: [ProviderKey]
}

/// `clawdtime computer model --json`.
public struct ModelReport: Decodable, Equatable, Sendable {
  public enum From: String, Decodable, Sendable { case environment, store, `default` }
  public struct Key: Decodable, Equatable, Sendable {
    public var source: ProviderKey.Source?
    public var variable: String?
  }
  public var version: Int
  public var ok: Bool
  /// `no_key`, `missing_key`, `no_model` or `invalid` when the planner cannot start.
  public var reason: String?
  public var problem: String?
  public var provider: String?
  public var providerName: String?
  public var model: String?
  public var name: String?
  public var from: From
  public var variable: String?
  public var baseUrl: String?
  public var key: Key?
}

/// The desktop part of `clawdtime computer doctor --json`.
public struct DesktopReport: Decodable, Equatable, Sendable {
  public var service: String
  public var taskSession: String
  public var taskAdmission: String
  public init(service: String, taskSession: String, taskAdmission: String) {
    self.service = service; self.taskSession = taskSession; self.taskAdmission = taskAdmission
  }
  /// The rule of setup for a restart: the service answers, takes new work and runs none.
  public var isIdle: Bool { service == "connected" && taskAdmission == "available" && taskSession != "active" }
}

/// The macOS permissions of the panel and the capture helper, as each binary
/// reads them itself, with no prompt. Nil: the binary is not in the runtime,
/// or it did not answer.
public struct PermissionStatus: Equatable, Sendable {
  public var panelAccessibility: Bool?
  public var panelScreenRecording: Bool?
  public var captureScreenRecording: Bool?
  public init(panelAccessibility: Bool?, panelScreenRecording: Bool?, captureScreenRecording: Bool?) {
    self.panelAccessibility = panelAccessibility; self.panelScreenRecording = panelScreenRecording
    self.captureScreenRecording = captureScreenRecording
  }
}

/// The two lists in System Settings, Privacy & Security.
public enum PermissionPane: String, CaseIterable, Sendable {
  case accessibility, screenRecording
  public var url: URL {
    switch self {
    case .accessibility: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
    case .screenRecording: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
    }
  }
}

/// What the settings need from the owner of the desktop. Tests replace it.
@MainActor
public protocol DesktopRestarting: AnyObject {
  var desktopStatus: OwnedStatus { get }
  var connectionStatus: OwnedStatus { get }
  /// Stops the desktop (and its connection) and starts both again as they were.
  func restartDesktop()
}

extension ProcessOwner: DesktopRestarting {
  public var desktopStatus: OwnedStatus { desktop }
  public var connectionStatus: OwnedStatus { connection }
  public func restartDesktop() {
    let keep = self.connection.isLive
    stop { [weak self] in self?.start(connection: keep) }
  }
}

/// The version of the app and of its runtime.
public struct AboutInfo: Equatable, Sendable {
  public var app: String
  public var runtime: String?
  public var commit: String?
  public init(app: String, runtime: String?, commit: String?) {
    self.app = app; self.runtime = runtime; self.commit = commit
  }
  public static func current(_ layout: RuntimeLayout?, bundle: Bundle = .main) -> AboutInfo {
    let app = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return AboutInfo(app: app ?? layout?.manifest.version ?? "development", runtime: layout?.manifest.version, commit: layout?.manifest.commit)
  }
  /// The commit as people read it: its first 7 characters.
  public var shortCommit: String? { commit.map { String($0.prefix(7)) } }
}

/// The Settings window's state. It reads and changes the model keys and the
/// planner model through the runtime's own commands, and reads the
/// permissions from the panel and the capture helper. A key goes to
/// `clawdtime keys set PROVIDER` on stdin only: never in an argument, the
/// environment, a file or a message. After a change, the desktop starts
/// again only when it is idle; otherwise the window offers the restart.
@MainActor
public final class SettingsModel: ObservableObject {
  public enum Work: Equatable, Sendable { case loading, key(String), model, permissions }
  /// What the window says after a key or model change.
  public enum RestartNote: Equatable, Sendable {
    /// The desktop is not running: it reads the change when it starts.
    case nextStart
    /// The desktop was idle and starts again now.
    case restarting
    /// The desktop is busy: the person chooses when it starts again.
    case offer(String)
  }

  @Published public private(set) var keys: KeysReport?
  @Published public private(set) var model: ModelReport?
  @Published public private(set) var permissions: PermissionStatus?
  /// One plain sentence about the last thing that went wrong.
  @Published public private(set) var problem: String?
  @Published public private(set) var work: Work?
  @Published public private(set) var restart: RestartNote?

  public let about: AboutInfo
  private let runner: CommandRunning
  private let launcher: URL?
  private let panel: URL?
  private let capture: URL?
  private weak var desktop: DesktopRestarting?
  private let open: (URL) -> Bool

  public init(runner: CommandRunning, launcher: URL?, native: URL?, desktop: DesktopRestarting?, about: AboutInfo,
              open: @escaping (URL) -> Bool) {
    self.runner = runner
    self.launcher = launcher
    panel = native?.appendingPathComponent("ClawdTimeTaskPanel")
    capture = native?.appendingPathComponent("ClawdTimeTaskCapture")
    self.desktop = desktop
    self.about = about
    self.open = open
  }

  /// The words of every problem the window shows. None holds a key.
  public enum Text {
    public static let noRuntime = "The app has no runtime, so settings cannot be read. Download ClawdTime again."
    public static let notStarted = "ClawdTime could not run its runtime. Download ClawdTime again."
    public static let unreadable = "The runtime sent an answer this app cannot read."
    public static let failed = "That did not work. Nothing was changed."
    public static let unknownProvider = "That provider is not in the list."
    public static let emptyKey = "Paste a key first."
    public static let keyAsModel = "That looks like a key, not a model name. Add keys in Model keys."
    public static let badModel = "Use a model name with letters, numbers and . _ - : / only."
    public static let needsBase = "This provider needs its base address, for example https://models.example/v1."
  }

  /// Reads the keys, the model and the permissions again.
  public func load() async {
    work = .loading
    defer { work = nil }
    await readKeys()
    await readModel()
    await checkPermissions()
  }

  @discardableResult
  public func readKeys() async -> Bool {
    guard let report: KeysReport = await json(["keys", "list", "--json"]) else { return false }
    keys = report
    return true
  }

  @discardableResult
  public func readModel() async -> Bool {
    guard let report: ModelReport = await json(["computer", "model", "--json"]) else { return false }
    model = report
    return true
  }

  public func provider(_ id: String) -> ProviderKey? { keys?.providers.first { $0.id == id } }

  /// Stores a key. It goes on stdin only. True when it was stored.
  @discardableResult
  public func setKey(provider id: String, key: String) async -> Bool {
    guard provider(id) != nil else { problem = Text.unknownProvider; return false }
    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { problem = Text.emptyKey; return false }
    work = .key(id)
    defer { work = nil }
    let result = await command(["keys", "set", id], input: Data(trimmed.utf8))
    guard succeeded(result, secret: trimmed) else { return false }
    await readKeys()
    await readModel()
    await changed()
    return true
  }

  /// Removes a stored key. A key from the environment is not removed here.
  @discardableResult
  public func removeKey(provider id: String) async -> Bool {
    guard let row = provider(id) else { problem = Text.unknownProvider; return false }
    guard row.canRemove else { return false }
    work = .key(id)
    defer { work = nil }
    guard succeeded(await command(["keys", "remove", id])) else { return false }
    await readKeys()
    await readModel()
    await changed()
    return true
  }

  /// Chooses the planner model, or `nil` for the automatic choice. A custom
  /// service takes its base address.
  @discardableResult
  public func chooseModel(provider id: String?, model name: String = "", baseURL: String? = nil) async -> Bool {
    var arguments = ["computer", "model"]
    if let id {
      guard let row = provider(id) else { problem = Text.unknownProvider; return false }
      let model = name.trimmingCharacters(in: .whitespacesAndNewlines)
      // The runtime refuses these too, but a key must not even reach an argument.
      guard !Self.looksLikeKey(model) else { problem = Text.keyAsModel; return false }
      guard Self.isModelName(model) else { problem = Text.badModel; return false }
      arguments.append("\(id)/\(model)")
      let base = baseURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if row.needsBaseUrl {
        guard base.hasPrefix("https://") || base.hasPrefix("http://") else {
          if self.model?.provider == id, self.model?.baseUrl != nil, base.isEmpty {
            // The runtime keeps the address it has.
            return await sendModel(arguments)
          }
          problem = Text.needsBase
          return false
        }
        guard !Self.looksLikeKey(base) else { problem = Text.keyAsModel; return false }
        arguments += ["--base-url", base]
      }
    } else {
      arguments.append("auto")
    }
    return await sendModel(arguments)
  }

  private func sendModel(_ arguments: [String]) async -> Bool {
    work = .model
    defer { work = nil }
    guard succeeded(await command(arguments)) else { return false }
    await readModel()
    await changed()
    return true
  }

  /// Asks the panel and the capture helper what macOS grants them. Neither
  /// prompts. `quietly` is the page's own repeated check: it shows no work.
  public func checkPermissions(quietly: Bool = false) async {
    let previous = work
    if previous == nil && !quietly { work = .permissions }
    defer { if previous == nil && !quietly { work = nil } }
    var status = PermissionStatus(panelAccessibility: nil, panelScreenRecording: nil, captureScreenRecording: nil)
    if let panel, FileManager.default.isExecutableFile(atPath: panel.path),
      let object = Self.object(await runner.run(panel, ["--check-access"], input: nil)) {
      status.panelAccessibility = object["accessibility"] as? Bool
      status.panelScreenRecording = object["screenRecording"] as? Bool
    }
    if let capture, FileManager.default.isExecutableFile(atPath: capture.path),
      let object = Self.object(await runner.run(capture, ["--preflight"], input: nil)) {
      status.captureScreenRecording = object["screenPermission"] as? Bool
    }
    permissions = status
  }

  /// Opens one list in System Settings.
  @discardableResult
  public func openSettings(_ pane: PermissionPane) -> Bool { open(pane.url) }

  /// The person chose to start the desktop again now.
  public func restartNow() {
    guard let desktop, desktop.desktopStatus.isLive else { restart = .nextStart; return }
    restart = .restarting
    desktop.restartDesktop()
  }

  public func dismissProblem() { problem = nil }

  /// After a change: start the desktop again only while it is idle, as setup
  /// does: no task, no unresolved action and no phone connection.
  private func changed() async {
    guard let desktop, desktop.desktopStatus.isLive else { restart = .nextStart; return }
    if desktop.connectionStatus.isLive {
      restart = .offer("The phone connection is on.")
      return
    }
    guard desktop.desktopStatus == .running, let report = await doctor() else {
      restart = .offer("The desktop did not say it is idle.")
      return
    }
    guard report.isIdle else {
      restart = .offer("A task is running.")
      return
    }
    restart = .restarting
    desktop.restartDesktop()
  }

  private struct Doctor: Decodable { var version: Int; var desktop: DesktopReport }
  private func doctor() async -> DesktopReport? {
    guard let launcher else { return nil }
    let result = await runner.run(launcher, ["computer", "doctor", "--json"], input: nil)
    guard result.status == 0, let doctor = try? JSONDecoder().decode(Doctor.self, from: result.output), doctor.version == 1 else { return nil }
    return doctor.desktop
  }

  // MARK: Commands

  private func command(_ arguments: [String], input: Data? = nil) async -> CommandResult? {
    guard let launcher else { problem = Text.noRuntime; return nil }
    return await runner.run(launcher, arguments, input: input)
  }

  /// True on status 0. Otherwise the window shows the runtime's last line,
  /// which is a fixed sentence, or a plain one of its own.
  private func succeeded(_ result: CommandResult?, secret: String? = nil) -> Bool {
    guard let result else { return false }
    if result.status == 0 { problem = nil; return true }
    if result == .notStarted { problem = Text.notStarted; return false }
    let line = result.errors.last { !$0.isEmpty }
    // The runtime never says a key; this app never shows one either.
    if let line, secret.map({ !line.contains($0) }) ?? true, !Self.looksLikeKey(line) {
      problem = line
    } else {
      problem = Text.failed
    }
    return false
  }

  private func json<T: Decodable>(_ arguments: [String]) async -> T? {
    guard let result = await command(arguments) else { return nil }
    guard succeeded(result) else { return nil }
    guard (try? JSONDecoder().decode(ReportVersion.self, from: result.output))?.version == 1,
      let value = try? JSONDecoder().decode(T.self, from: result.output) else {
      problem = Text.unreadable
      return nil
    }
    return value
  }

  private struct ReportVersion: Decodable { var version: Int }

  private static func object(_ result: CommandResult) -> [String: Any]? {
    guard result.status == 0 else { return nil }
    return (try? JSONSerialization.jsonObject(with: result.output)) as? [String: Any]
  }

  /// The beginnings of the providers' keys, as the runtime checks them.
  static func looksLikeKey(_ text: String) -> Bool {
    let starts = ["sk-", "sk_", "gsk_", "xai-", "fw_", "AIza", "tgp_", "r8_", "pplx-", "nvapi-"]
    return text.split(whereSeparator: { $0 == " " || $0 == "/" }).contains { word in starts.contains { word.hasPrefix($0) } }
  }

  /// A model name as the runtime takes it: no leading dash, so it is never an option.
  static func isModelName(_ text: String) -> Bool {
    guard let first = text.unicodeScalars.first, CharacterSet.alphanumerics.contains(first), text.count <= 200 else { return false }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/@+-")
    return text.unicodeScalars.allSatisfy { allowed.contains($0) } && first.isASCII
  }
}
