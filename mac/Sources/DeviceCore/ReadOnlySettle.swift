import Foundation

public enum ReadOnlySettleResult<Value> {
  case verified(Value)
  case unverified(Value?)
  case unavailable
}

/// Bounded observation only. This API has no action/retry callback.
public enum ReadOnlySettle {
  @MainActor public static func run<Value>(now: () -> Double, allowed: () -> Bool,
      observe: () -> (Value, Bool)?, sleep: (Double) async -> Void) async -> ReadOnlySettleResult<Value> {
    let deadline = now() + 0.6
    var latest: Value?
    guard allowed() else { return .unavailable }
    await sleep(0.05)
    while allowed() && now() < deadline {
      guard let (value, verified) = observe(), allowed(), now() <= deadline else { return .unavailable }
      latest = value
      if verified { return .verified(value) }
      let remaining = deadline - now()
      if remaining > 0 { await sleep(min(0.05, remaining)) }
    }
    return allowed() ? .unverified(latest) : .unavailable
  }
}
