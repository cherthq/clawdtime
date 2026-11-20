import Foundation

/// The runtime may omit its own UI from screenshots, but must never act through
/// that invisible overlay or approve itself. Absence of a hit witness is refusal.
public enum LocalInputExclusion {
  public static func conflictingHelper(bundleId: String?, pid: Int32, helperPID: Int32) -> Bool {
    pid != helperPID && ["com.clawdtime.companion", "com.clawdtime.local-control"].contains(bundleId ?? "")
  }

  /// ClawdTime's own apps: every app in the product's namespace. A new app of
  /// the product is then never a target of local input by oversight.
  public static func isOwned(bundleId: String?, pid: Int32, helperPID: Int32) -> Bool {
    pid == helperPID || inNamespace(bundleId)
  }
  /// The bundle id belongs to ClawdTime. Bundle ids compare without regard to case.
  /// The disposable fixture apps of the qualification runs are not the product:
  /// they are the targets that local input is proven on.
  public static func inNamespace(_ bundleId: String?) -> Bool {
    let name = (bundleId ?? "").lowercased()
    return name.hasPrefix("com.clawdtime.") && !name.hasPrefix("com.clawdtime.fixture.")
  }
  public static func validate(witnessKnown: Bool, targetOwned: Bool, coveredByOwnedWindow: Bool) throws {
    guard witnessKnown, !targetOwned, !coveredByOwnedWindow else {
      throw HelperError(409, "Local input cannot target hidden ClawdTime UI or an unverified target.")
    }
  }
}
