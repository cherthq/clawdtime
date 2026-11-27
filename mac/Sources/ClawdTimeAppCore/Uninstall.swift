import Foundation

/// `clawdtime uninstall --plan --json`: what the uninstall would do. It holds
/// paths and plain sentences only, never a credential.
public struct UninstallPlan: Decodable, Equatable, Sendable {
  public struct Item: Decodable, Equatable, Sendable, Identifiable {
    public var path: String
    public var display: String
    public var what: String
    /// Part of the settings: "Keep my settings and keys" keeps it.
    public var settings: Bool
    /// It goes only once the coordinator has unpaired this Mac.
    public var afterUnpair: Bool?
    public var id: String { path }
  }
  public struct Kept: Decodable, Equatable, Sendable, Identifiable {
    public var path: String
    public var display: String
    public var why: String
    public var id: String { path }
  }
  public struct Unpair: Decodable, Equatable, Sendable { public var origin: String }

  public var version: Int
  public var unpair: Unpair?
  public var pairingProblem: String?
  public var move: [Item]
  public var keep: [Kept]
  public var notes: [String]

  /// What goes to the Trash. With the box on the settings stay, and the
  /// pairing shows alone only when no folder in the list holds it.
  public func moves(keepSettings: Bool) -> [Item] {
    let items = move.filter { !(keepSettings && $0.settings) }
    return items.filter { item in
      item.afterUnpair != true || !items.contains { $0.path != item.path && item.path.hasPrefix($0.path + "/") }
    }
  }

  /// What stays where it is, with the settings when the box is on.
  public func kept(keepSettings: Bool) -> [Kept] {
    keep + (keepSettings ? move.filter(\.settings).map { Kept(path: $0.path, display: $0.display, why: $0.what) } : [])
  }
}

/// The two commands of Uninstall ClawdTime… in Settings.
public enum UninstallCommand {
  /// Reads the list for the sheet. It changes nothing.
  public static let plan = ["uninstall", "--plan", "--json"]
  /// The uninstall itself: the sheet was the question, so it does not ask again.
  public static func arguments(keepSettings: Bool) -> [String] {
    keepSettings ? ["uninstall", "--yes", "--keep-settings"] : ["uninstall", "--yes"]
  }

  /// What happened, without the plan that the sheet showed already: the
  /// runtime prints the plan, one empty line, then what it did.
  public static func result(_ output: Data) -> String {
    let text = String(decoding: output, as: UTF8.self)
    let lines = text.components(separatedBy: "\n")
    let after = lines.firstIndex(of: "").map { Array(lines[($0 + 1)...]) } ?? []
    // A refusal before the plan has no empty line: then all of it is the result.
    let result = after.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return result.isEmpty ? text.trimmingCharacters(in: .whitespacesAndNewlines) : result
  }
}

/// The uninstall from the app: it stops what the app owns, runs the bundled
/// `clawdtime uninstall`, removes the app's login item, then moves the app
/// itself to the Trash and quits. Tests replace each effect.
@MainActor
public final class UninstallModel: ObservableObject {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    /// The list could not be read, so nothing can run.
    case unavailable(String)
    case running
    /// The runtime uninstalled ClawdTime. Next: the app goes to the Trash.
    case finished(String)
    /// The runtime stopped. The app stays.
    case failed(String)
    /// ClawdTime is uninstalled, but the app could not go to the Trash.
    case appNotMoved(String)
  }

  public enum Text {
    public static let noRuntime = "The app has no runtime, so it cannot uninstall ClawdTime. Download ClawdTime again."
    public static let notStarted = "ClawdTime could not run its runtime. Nothing changed."
    public static let unreadable = "The runtime sent a list this app cannot read. Nothing changed."
    public static let failed = "The uninstall did not finish."
    public static let appNotMoved = "ClawdTime is uninstalled, but the app could not go to the Trash. Quit, then drag ClawdTime from Applications to the Trash."
    public static let loginItem = "Turn off ClawdTime in System Settings, General, Login Items: macOS did not take it out."
  }

  @Published public private(set) var phase: Phase = .loading
  @Published public private(set) var plan: UninstallPlan?
  @Published public var keepSettings = false

  private let runner: CommandRunning
  private let launcher: URL?
  private let loginItem: LoginItemControlling
  private let stopApp: (@escaping @MainActor () -> Void) -> Void
  private let forgetSetup: () -> Void
  private let trashApp: () throws -> Void
  private let quit: () -> Void

  /// `stopApp` ends setup and every process the app owns, then calls back.
  /// `forgetSetup` clears the app's own "setup is done" mark.
  public init(runner: CommandRunning, launcher: URL?, loginItem: LoginItemControlling,
              stopApp: @escaping (@escaping @MainActor () -> Void) -> Void,
              forgetSetup: @escaping () -> Void, trashApp: @escaping () throws -> Void, quit: @escaping () -> Void) {
    self.runner = runner; self.launcher = launcher; self.loginItem = loginItem
    self.stopApp = stopApp; self.forgetSetup = forgetSetup; self.trashApp = trashApp; self.quit = quit
  }

  /// Reads the list again. It changes nothing.
  public func load() async {
    phase = .loading
    plan = nil
    guard let launcher else { phase = .unavailable(Text.noRuntime); return }
    let result = await runner.run(launcher, UninstallCommand.plan, input: nil)
    guard result != .notStarted else { phase = .unavailable(Text.notStarted); return }
    guard result.status == 0, let read = try? JSONDecoder().decode(UninstallPlan.self, from: result.output), read.version == 1 else {
      phase = .unavailable(Text.unreadable)
      return
    }
    plan = read
    phase = .ready
  }

  /// The person pressed Uninstall in the sheet.
  public func uninstall() async {
    guard phase == .ready, let launcher else { return }
    phase = .running
    let keep = keepSettings
    // The app's own desktop and connection end first, as Stop ends them.
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in stopApp { done.resume() } }
    let result = await runner.run(launcher, UninstallCommand.arguments(keepSettings: keep), input: nil)
    if result == .notStarted { phase = .failed(Text.notStarted); return }
    var text = UninstallCommand.result(result.output)
    guard result.status == 0 else {
      let errors = result.errors.joined(separator: "\n")
      phase = .failed([text, errors].filter { !$0.isEmpty }.joined(separator: "\n").nonEmpty ?? Text.failed)
      return
    }
    do { try loginItem.setEnabled(false) } catch { text += "\n" + Text.loginItem }
    if !keep { forgetSetup() }
    phase = .finished(text)
  }

  /// After the result: the app goes to the Trash, then quits. When it cannot
  /// go, the sheet says so and the next press quits.
  public func finish() {
    switch phase {
    case .finished:
      do {
        try trashApp()
        quit()
      } catch {
        phase = .appNotMoved(Text.appNotMoved)
      }
    case .appNotMoved: quit()
    default: break
    }
  }

  /// For the pictures of the tests.
  func show(_ phase: Phase) { self.phase = phase }
}

private extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
