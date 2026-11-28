import Foundation

/// The one request that the chat offers when setup opens it at the end. Setup
/// says the same words (src/onboard/engine.ts, firstRequest): change both
/// together. Each request pays, deletes and sends nothing.
public enum FirstRequest {
  /// With computer use on, a short task on this Mac that the person can watch.
  /// With it off, a question that the chat answers alone.
  public static func suggestion(computerUse: Bool) -> String {
    computerUse ? "Open Calculator and calculate 15 percent of 240." : "What can you do on this Mac?"
  }
}
