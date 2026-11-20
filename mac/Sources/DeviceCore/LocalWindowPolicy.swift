import Foundation

/// Activation is narrower than screenshot access: only explicitly configured
/// ordinary applications, never launch, minimize reversal, security UI or shells.
public enum LocalWindowPolicy {
  public static func windowCandidates<T>(listed: [T], main: T?, focused: T?, expectedPID: Int32,
      owner: (T) -> Int32?, same: (T, T) -> Bool) throws -> [T] {
    guard expectedPID > 0, listed.count <= 32 else { throw HelperError(409, "Application window catalog exceeds its bound.") }
    var result = [T]()
    for value in listed + [main, focused].compactMap({ $0 }) {
      guard owner(value) == expectedPID else { throw HelperError(409, "Application window owner changed.") }
      if !result.contains(where: { same($0, value) }) { result.append(value) }
      guard result.count <= 32 else { throw HelperError(409, "Application window catalog exceeds its bound.") }
    }
    return result
  }

  public static func requireNativeActivation(accessibility: Bool, secureInput: Bool, displayActive: Bool) throws {
    guard accessibility, !secureInput, displayActive else {
      throw HelperError(403, "Accessibility, an active display and non-secure input are required.")
    }
  }

  private static let denied: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "com.apple.systempreferences",
    "com.apple.keychainaccess", "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.AuthenticationServicesUI",
    "com.apple.ScreenSharing", "com.clawdtime.local-control", "com.clawdtime.companion", "com.clawdtime.task-panel", "com.clawdtime.supervisor.anish"]
  public static func validApplications(_ applications: [String]) -> Bool {
    applications.count <= 20 && Set(applications).count == applications.count && applications.allSatisfy {
      $0.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{2,159}$", options: .regularExpression) != nil && !denied.contains($0)
    }
  }
  public static func allowed(_ bundle: String, applications: [String]) -> Bool {
    validApplications(applications) && applications.contains(bundle) && !denied.contains(bundle)
  }
}
