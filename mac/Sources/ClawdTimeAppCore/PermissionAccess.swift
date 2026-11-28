import ApplicationServices
import Foundation

/// A macOS permission that ClawdTime needs. The raw value is its id in the
/// setup protocol.
///
/// macOS ties the permission of an ad hoc signed app to the code hash of one
/// build. After an update to a new ad hoc build, System Settings can show
/// ClawdTime switched on while macOS refuses the new build: the switch
/// belongs to a build that no longer exists. A Developer ID signature keeps
/// the permission across updates.
public enum PermissionKind: String, CaseIterable, Sendable {
  case accessibility
  case screenRecording = "screen_recording"

  /// The service name that `tccutil` takes.
  public var service: String {
    switch self {
    case .accessibility: "Accessibility"
    case .screenRecording: "ScreenCapture"
    }
  }

  /// The list in System Settings, Privacy & Security.
  public var pane: PermissionPane {
    switch self {
    case .accessibility: .accessibility
    case .screenRecording: .screenRecording
    }
  }

  /// The name of the list, as System Settings shows it on macOS 15 and later.
  public var listName: String {
    switch self {
    case .accessibility: "Accessibility"
    case .screenRecording: "Screen & System Audio Recording"
    }
  }
}

/// Asks macOS for a permission. macOS shows its own dialog and adds the build
/// that asks to the list in System Settings. Tests replace it.
@MainActor
public protocol PermissionPrompting: AnyObject {
  func request(_ kind: PermissionKind)
}

/// The real request: the trusted check with its prompt option, and the
/// Screen Recording request. The app is the responsible process of the panel
/// and the capture helper, so their checks read what the app is granted.
@MainActor
public final class SystemPermissionPrompt: PermissionPrompting {
  public init() {}
  public func request(_ kind: PermissionKind) {
    switch kind {
    case .accessibility:
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    case .screenRecording:
      _ = CGRequestScreenCaptureAccess()
    }
  }
}

/// Asks macOS for each permission at most once, until it is made ready to
/// ask again: a new setup run, or a reset that the person clicked.
@MainActor
public final class PermissionRequests {
  private let prompt: PermissionPrompting
  public private(set) var asked: Set<PermissionKind> = []
  public init(prompt: PermissionPrompting) { self.prompt = prompt }

  /// Asks for each permission that was not asked yet. Returns what it asked.
  @discardableResult
  public func ask(_ kinds: [PermissionKind]) -> [PermissionKind] {
    var new: [PermissionKind] = []
    for kind in kinds where !asked.contains(kind) {
      asked.insert(kind)
      new.append(kind)
      prompt.request(kind)
    }
    return new
  }

  /// These permissions may be asked once more.
  public func rearm(_ kinds: [PermissionKind]) { asked.subtract(kinds) }
  /// A new setup run: every permission may be asked once more.
  public func rearmAll() { asked = [] }
}

/// The reset of ClawdTime's own permissions with `tccutil`. It names only
/// the bundle id of the app, never every app.
public enum PermissionReset {
  public static let bundleID = "com.clawdtime.app"
  public static let tool = URL(fileURLWithPath: "/usr/bin/tccutil")

  public static func arguments(_ kind: PermissionKind) -> [String] { ["reset", kind.service, bundleID] }
  /// The command as a person types it in Terminal. Setup in Terminal prints the same one.
  public static func command(_ kind: PermissionKind) -> String { (["tccutil"] + arguments(kind)).joined(separator: " ") }

  /// Resets each permission, one after the other. True when every reset worked.
  public static func run(_ kinds: [PermissionKind], runner: CommandRunning) async -> Bool {
    var worked = true
    for kind in kinds {
      let result = await runner.run(tool, arguments(kind), input: nil)
      if result.status != 0 { worked = false }
    }
    return worked
  }
}

/// Where the reset of the permissions is.
public enum PermissionResetState: Equatable, Sendable { case idle, running, done, failed }

/// The words about a permission that macOS holds for an older build.
public enum PermissionWords {
  public static let resetLabel = "Reset ClawdTime permissions"
  public static let olderBuild = "If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime. Remove ClawdTime from the list with the minus button, then turn it on again."
  public static let resetDone = "Reset. Turn on ClawdTime in the list again."
  public static let resetFailed = "The reset did not work. Remove ClawdTime from the list with the minus button."
}
