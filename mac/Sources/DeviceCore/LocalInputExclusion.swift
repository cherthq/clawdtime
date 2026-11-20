import Foundation

/// The runtime may omit its own UI from screenshots, but must never act through
/// that invisible overlay or approve itself. Absence of a hit witness is refusal.
public enum LocalInputExclusion {
  public static func conflictingHelper(bundleId: String?, pid: Int32, helperPID: Int32) -> Bool {
    pid != helperPID && ["com.clawdtime.companion", "com.clawdtime.local-control"].contains(bundleId ?? "")
  }

  public static func isOwned(bundleId: String?, pid: Int32, helperPID: Int32) -> Bool {
    pid == helperPID || ["com.clawdtime.local-control", "com.clawdtime.companion", "com.clawdtime.task-panel", "com.clawdtime.supervisor.anish"].contains(bundleId ?? "")
  }
  public static func validate(witnessKnown: Bool, targetOwned: Bool, coveredByOwnedWindow: Bool) throws {
    guard witnessKnown, !targetOwned, !coveredByOwnedWindow else {
      throw HelperError(409, "Local input cannot target hidden ClawdTime UI or an unverified target.")
    }
  }
}
