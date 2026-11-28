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
  /// Ends the phone connection: it stops both, runs `then`, and starts the desktop again alone.
  func dropConnection(then: @escaping @MainActor () -> Void)
}

extension ProcessOwner: DesktopRestarting {
  public var desktopStatus: OwnedStatus { desktop }
  public var connectionStatus: OwnedStatus { connection }
  public func restartDesktop() {
    let keep = self.connection.isLive
    stop { [weak self] in self?.start(connection: keep) }
  }
  public func dropConnection(then: @escaping @MainActor () -> Void) {
    let keepDesktop = desktop.isLive
    stop { [weak self] in
      then()
      if keepDesktop { self?.start(connection: false) }
    }
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

/// The Settings window's state. It reads and changes every setting through
/// the runtime's own commands (`clawdtime settings`, `keys` and `computer
/// model`), and reads the permissions from the panel and the capture helper.
/// It never edits a file itself. A key goes to `clawdtime keys set PROVIDER`
/// on stdin only: never in an argument, the environment, a file or a
/// message. After a change that the desktop reads when it starts, the
/// desktop starts again only when it is idle; otherwise the window offers
/// the restart.
@MainActor
public final class SettingsModel: ObservableObject {
  public enum Work: Equatable, Sendable {
    case loading, key(String), model, permissions, setting(String), privacy, history, forget, update, phone, unpair
  }
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
  /// The permissions that are still off after the person opened System
  /// Settings for them and came back: macOS holds an older build's permission.
  @Published public private(set) var stalePermissions: [PermissionKind] = []
  @Published public private(set) var permissionReset = PermissionResetState.idle
  /// One plain sentence about the last thing that went wrong.
  @Published public private(set) var problem: String?
  @Published public private(set) var work: Work?
  @Published public private(set) var restart: RestartNote?
  /// Every setting of `clawdtime settings --json`.
  @Published public private(set) var runtime: RuntimeSettingsReport?
  @Published public private(set) var privacy: PrivacyReport?
  @Published public private(set) var update: UpdateReport?
  @Published public private(set) var phone: PhoneReport?
  /// One plain sentence about the last thing that worked, such as "Removed 3 facts."
  @Published public private(set) var done: String?
  /// A change that is on its way: the window shows it at once.
  @Published public private(set) var pending: [String: SettingValue] = [:]

  public let about: AboutInfo
  private let runner: CommandRunning
  private let launcher: URL?
  private let panel: URL?
  private let capture: URL?
  private weak var desktop: DesktopRestarting?
  private let open: (URL) -> Bool
  private let prompt: PermissionPrompting?
  /// The lists that the person opened in System Settings, while their permission is off.
  private var openedPanes: Set<PermissionPane> = []

  public init(runner: CommandRunning, launcher: URL?, native: URL?, desktop: DesktopRestarting?, about: AboutInfo,
              open: @escaping (URL) -> Bool, prompt: PermissionPrompting? = nil) {
    self.prompt = prompt
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
    public static let unknownSetting = "That setting is not in the list."
    public static let keyAsSetting = "That looks like a key, not a setting. Add keys in Models."
    public static let badText = "Use plain words, with no line break, that do not start with a dash."
  }

  /// Reads the keys, the model, every setting and the permissions again.
  public func load() async {
    work = .loading
    defer { work = nil }
    await readKeys()
    await readModel()
    await readSettings()
    await checkPermissions()
  }

  @discardableResult
  public func readSettings() async -> Bool {
    guard let report: RuntimeSettingsReport = await json(["settings", "--json"]) else { return false }
    runtime = report
    return true
  }

  public func setting(_ id: String) -> RuntimeSetting? { runtime?.setting(id) }

  /// The value that the window shows: a change on its way, or what the runtime said.
  public func value(_ id: String) -> SettingValue? { pending[id] ?? setting(id)?.value }

  /// A variable of the environment holds this setting: a choice here does not win.
  public func isFixed(_ id: String) -> Bool { setting(id)?.from == .environment }

  /// Changes one setting through `clawdtime settings set`. A change that the
  /// desktop reads when it starts restarts it when it is idle.
  @discardableResult
  public func set(_ id: String, _ value: SettingValue) async -> Bool {
    guard let row = setting(id) else { problem = Text.unknownSetting; return false }
    if case .text(let text) = value {
      // The runtime refuses these too, but a key must not even reach an argument.
      guard !Self.looksLikeKey(text) else { problem = Text.keyAsSetting; return false }
      guard !text.hasPrefix("-"), !text.contains(where: { $0.isNewline }), text.count <= 400 else { problem = Text.badText; return false }
    }
    if let choices = row.choices, let text = value.text, !choices.contains(text) { problem = Text.unknownSetting; return false }
    pending[id] = value
    defer { pending[id] = nil }
    return await change(["settings", "set", id, value.argument, "--json"], id: id)
  }

  /// Back to the default of one setting.
  @discardableResult
  public func reset(_ id: String) async -> Bool {
    guard setting(id) != nil else { problem = Text.unknownSetting; return false }
    return await change(["settings", "reset", id, "--json"], id: id)
  }

  private func change(_ arguments: [String], id: String) async -> Bool {
    work = .setting(id)
    defer { work = nil }
    guard let result: SettingChange = await json(arguments) else { return false }
    await readSettings()
    // The speed and the models change each other.
    if ["speed", "model.planner", "model.chat"].contains(id) { await readModel() }
    if result.applies == .restart { await changed() }
    return true
  }

  /// Removes every fact in memory, for good. The window asked first.
  @discardableResult
  public func forgetMemory() async -> Bool {
    work = .forget
    defer { work = nil }
    guard let result: ForgetResult = await json(["settings", "forget-memory", "--yes", "--json"]) else { return false }
    done = result.removed == 0 ? "Memory was empty." : "Removed \(result.removed) \(result.removed == 1 ? "fact" : "facts") for good."
    await readPrivacy()
    return true
  }

  @discardableResult
  public func readPrivacy() async -> Bool {
    let previous = work
    if previous == nil { work = .privacy }
    defer { if previous == nil { work = nil } }
    guard let report: PrivacyReport = await json(["settings", "privacy", "--json"]) else { return false }
    privacy = report
    return true
  }

  /// Moves the chat history, the spoken replies and the step times to the Trash. The window asked first.
  @discardableResult
  public func deleteHistory() async -> Bool {
    work = .history
    defer { work = nil }
    guard let result: HistoryResult = await json(["settings", "delete-history", "--yes", "--json"]) else { return false }
    done = result.moved.isEmpty ? "There was no history to move." : "Moved \(result.moved.count) \(result.moved.count == 1 ? "file" : "files") to the Trash."
    await readPrivacy()
    if !result.moved.isEmpty { await changed() }
    return true
  }

  /// Reads latest.json of the release. Only when the person asks: it goes to the network.
  @discardableResult
  public func checkUpdate() async -> Bool {
    work = .update
    defer { work = nil }
    guard let report: UpdateReport = await json(["settings", "update", "--json"]) else { return false }
    update = report
    return true
  }

  /// The release page, only when it is an https address.
  public var updatePage: URL? {
    guard let page = update?.page, let url = URL(string: page), url.scheme == "https" else { return nil }
    return url
  }

  @discardableResult
  public func openUpdatePage() -> Bool {
    guard let updatePage else { return false }
    return open(updatePage)
  }

  @discardableResult
  public func readPhone() async -> Bool {
    let previous = work
    if previous == nil { work = .phone }
    defer { if previous == nil { work = nil } }
    guard let report: PhoneReport = await json(["settings", "phone", "--json"]) else { return false }
    phone = report
    return true
  }

  /// Unpairs this Mac. The phone connection uses the pairing, so it ends
  /// first; the desktop goes on. The window asked first.
  public func unpairPhone() async {
    work = .unpair
    if let desktop, desktop.connectionStatus.isLive {
      await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
        desktop.dropConnection { resume.resume() }
      }
    }
    defer { work = nil }
    if let result: UnpairOutcome = await json(["settings", "phone", "unpair", "--yes", "--json"]) {
      done = result.sentence
    }
    await readPhone()
  }

  /// Opens a folder of ClawdTime in the Finder: the state folder, or a folder in it.
  /// Only the state folder and the folder of the logs, as the privacy report names them.
  @discardableResult
  public func openFolder(_ path: String) -> Bool {
    guard let privacy, path.hasPrefix("/") else { return false }
    let allowed = [privacy.folder] + privacy.items.filter { $0.id == "logs" }.map(\.path)
    guard allowed.contains(path) else { return false }
    return open(URL(fileURLWithPath: path, isDirectory: true))
  }

  public func dismissDone() { done = nil }

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
    // The speed preset follows the models.
    await readSettings()
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
    let off = Self.offPermissions(status)
    // A permission that is on ends its wait.
    openedPanes = openedPanes.filter { pane in off.contains { $0.pane == pane } }
    // The person came back from System Settings (the window checks when it
    // comes to the front) or clicked Check again, and it is still off. The
    // page's own repeated check adds nothing: System Settings may be in front.
    stalePermissions = quietly
      ? stalePermissions.filter(off.contains)
      : off.filter { openedPanes.contains($0.pane) }
    // Every permission is on: the note of a reset has done its work.
    if off.isEmpty && permissionReset != .running { permissionReset = .idle }
  }

  /// The permissions that a helper reported off. One that is not found is not off.
  static func offPermissions(_ status: PermissionStatus) -> [PermissionKind] {
    var off: [PermissionKind] = []
    if status.panelAccessibility == false { off.append(.accessibility) }
    if status.panelScreenRecording == false || status.captureScreenRecording == false { off.append(.screenRecording) }
    return off
  }

  /// Reset ClawdTime permissions: removes only ClawdTime's own entries of the
  /// permissions that are stale, then asks macOS again, so that the list shows
  /// this build.
  public func resetPermissions() async {
    let kinds = stalePermissions
    guard !kinds.isEmpty, permissionReset != .running else { return }
    permissionReset = .running
    let worked = await PermissionReset.run(kinds, runner: runner)
    permissionReset = worked ? .done : .failed
    guard worked else { return }
    stalePermissions = []
    openedPanes = []
    for kind in kinds { prompt?.request(kind) }
  }

  /// The words of the Permissions page for permissions that macOS holds for an older build.
  public static func staleWords(_ kinds: [PermissionKind]) -> String {
    let lists = kinds.map(\.listName)
    return "\(lists.joined(separator: " and ")) \(lists.count > 1 ? "are" : "is") still off for ClawdTime. \(PermissionWords.olderBuild) Or click \(PermissionWords.resetLabel)."
  }

  /// Opens one list in System Settings.
  @discardableResult
  public func openSettings(_ pane: PermissionPane) -> Bool {
    openedPanes.insert(pane)
    return open(pane.url)
  }

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
