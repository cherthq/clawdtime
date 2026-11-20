import Foundation

/// Activation is narrower than screenshot access: only explicitly configured
/// ordinary applications, never launch, minimize reversal, security UI or shells.
public enum LocalWindowPolicy {
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
