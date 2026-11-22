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

/// The last check before an event of the hands goes out. The guided cursor took
/// a moment to reach the place, and in that moment the person can have stopped
/// the work or taken the mouse. So the check comes after the glide, as late as
/// it can.
public enum HandsGate {
  /// Nil: the event may go. Otherwise nothing is sent, and this is what the worker hears.
  /// - `stopped`: Stop on the bar, or Escape held, at this Mac.
  /// - `watching` and `personActed`: the tap listens, and the person moved the mouse or pressed
  ///   a key since the command began. What the worker checked may be another place now, so the
  ///   worker pauses and asks.
  /// - `run`: what the service says now, read just before the event. Nil when it did not
  ///   answer. A stop that came through the chat, a call or the panel shows here as `stopping`.
  public static func refusal(stopped: Bool, watching: Bool, personActed: Bool, run: HandsNext.Run?) -> HandError? {
    if stopped { return .stoppedByPerson }
    if watching && personActed { return .refused }
    // With no word from the service nothing is sent: its result could not be posted either.
    guard let run else { return .failed }
    if run.state == "stopping" { return .stoppedByPerson }
    // Only a request that runs may act. One that ended or waits for the person sends nothing.
    return run.active && run.state == "running" ? nil : .refused
  }
}

/// How often the hands ask for the next command.
public enum HandsPace {
  /// Seconds between two reads while the worker runs, and while it does not. The idle time is what a new
  /// request waits before the hands see it: a second there was half a second lost, on average, at the start
  /// of every request. A read is one small request on this Mac, so four a second cost nothing that counts.
  public static let active = 0.12, idle = 0.25
  /// The wait before the next read. A service that does not answer is asked less often.
  public static func delay(active: Bool, failures: Int) -> Double {
    if failures > 0 { return min(5, pow(2, Double(min(failures, 4) - 1))) }
    return active ? Self.active : idle
  }
  /// After this many reads with no answer, the bar goes: nothing can command the hands.
  public static let failuresBeforeQuiet = 3
}
