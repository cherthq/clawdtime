import Foundation

public enum ReadOnlySettleResult<Value> {
  case verified(Value)
  case unverified(Value?)
  case unavailable
}

public enum ReadOnlySettleObservation<Value> {
  case observed(Value, verified: Bool)
  /// Identity is retained but geometry is transitioning. Never reusable evidence.
  case pending
  case unavailable
}

/// Bounded observation only. This API has no action/retry callback.
public enum ReadOnlySettle {
  @MainActor public static func run<Value>(now: () -> Double, allowed: () -> Bool,
      observe: () -> (Value, Bool)?, sleep: (Double) async -> Void) async -> ReadOnlySettleResult<Value> {
    await observations(now: now, allowed: allowed, observe: {
      guard let (value, verified) = observe() else { return .unavailable }
      return .observed(value, verified: verified)
    }, sleep: sleep)
  }
  @MainActor public static func observations<Value>(now: () -> Double, allowed: () -> Bool,
      observe: () -> ReadOnlySettleObservation<Value>, sleep: (Double) async -> Void) async -> ReadOnlySettleResult<Value> {
    let deadline = now() + 0.6
    var latest: Value?
    var pending = false
    guard allowed() else { return .unavailable }
    await sleep(0.05)
    while allowed() && now() < deadline {
      let observation = observe()
      guard allowed(), now() <= deadline else { return .unavailable }
      switch observation {
      case .unavailable: return .unavailable
      case .pending: latest = nil; pending = true
      case .observed(let value, let verified):
        latest = value; pending = false
        if verified { return .verified(value) }
      }
      let remaining = deadline - now()
      if remaining > 0 { await sleep(min(0.05, remaining)) }
    }
    return allowed() && !pending ? .unverified(latest) : .unavailable
  }
}
