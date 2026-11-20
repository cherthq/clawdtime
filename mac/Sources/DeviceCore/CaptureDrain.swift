import Foundation

public enum CaptureDrainError: Error { case unconfirmed }

/// Revocation prevents future capture; it does not join a native screenshot
/// already awaiting its framework callback. Handoff needs both facts.
@MainActor public enum CaptureDrain {
  public static func wait(timeout: Duration = .milliseconds(1500),
                          busy: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while busy() {
      try Task.checkCancellation()
      guard ContinuousClock.now < deadline else { throw CaptureDrainError.unconfirmed }
      try await Task.sleep(for: .milliseconds(10))
    }
    try Task.checkCancellation()
  }
}
