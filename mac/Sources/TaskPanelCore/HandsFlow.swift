import Foundation

/// Each sequence number is run once and answered once. A number that comes
/// again is never run again: the worker reads a missing answer as an unknown
/// outcome, and a second run would repeat an effect on the person's Mac.
public struct HandsLedger: Equatable, Sendable {
  /// The highest sequence number that the hands took. It is the `after` of the next read.
  public private(set) var last = 0
  private var instance: String?
  public init() {}
  /// True once for each number, in rising order.
  public mutating func claim(_ seq: Int) -> Bool {
    guard seq > last else { return false }
    last = seq
    return true
  }
  /// The task service that answers now. Another instance counts from the start again.
  public mutating func service(_ id: String) {
    if let instance, instance != id { last = 0 }
    instance = id
  }
}

/// Stop, as the hands keep it. After the person stops a run, a command that
/// waits is answered and not run. The next run starts free.
public struct HandsStop: Equatable, Sendable {
  public private(set) var stopped = false
  public init() {}
  public mutating func press() { stopped = true }
  /// What the service says about the run. Only the end of the run lifts Stop.
  public mutating func observe(active: Bool) { if !active { stopped = false } }
}

/// How often the hands ask for the next command.
public enum HandsPace {
  /// Seconds between two reads while the worker runs, and while it does not.
  public static let active = 0.12, idle = 1.0
  /// The wait before the next read. A service that does not answer is asked less often.
  public static func delay(active: Bool, failures: Int) -> Double {
    if failures > 0 { return min(5, pow(2, Double(min(failures, 4) - 1))) }
    return active ? Self.active : idle
  }
  /// After this many reads with no answer, the bar goes: nothing can command the hands.
  public static let failuresBeforeQuiet = 3
}
