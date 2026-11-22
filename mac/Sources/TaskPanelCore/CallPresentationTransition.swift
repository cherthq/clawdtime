import Foundation

/// Optional presentation lifecycle seam. These raw values match a desktop
/// transition producer, but this module does not depend on that implementation.
public enum CallPresentationTransitionPhase: String, Sendable {
  case switching, waiting, ready, blocked
}

/// Keeps outgoing video wide for an entire transition, including a blocked
/// outcome. Epochs must come from one monotonic producer for this panel lifetime.
/// A reset fences all epochs already observed; it cannot identify an arbitrary
/// unseen callback from a recreated producer. Native callers also reject events
/// while inactive. No lifecycle callback grants input or verifies a desktop.
public struct CallPresentationTransitionLatch: Sendable {
  public enum Mode: Equatable, Sendable { case content, transition, freshContext }
  public private(set) var mode: Mode = .content
  public private(set) var generation: UInt64 = 0
  public private(set) var phase: CallPresentationTransitionPhase?
  public private(set) var highestEpoch = -1
  private var resetThrough = -1
  public init() {}

  /// True when presentation state must be retired. A ready event may advance
  /// the epoch because native observations can invalidate it during settlement.
  @discardableResult public mutating func receive(_ next: CallPresentationTransitionPhase, epoch: Int) -> Bool {
    guard epoch >= 0, epoch >= highestEpoch, epoch > resetThrough else { return false }
    let previousEpoch = highestEpoch
    highestEpoch = epoch
    if next == .ready {
      guard mode == .transition, phase != .blocked else {
        // An orphan ready is never authority to reopen a completed lifecycle.
        if phase == nil { resetThrough = max(resetThrough, epoch) }
        return false
      }
      phase = .ready; mode = .freshContext; generation &+= 1
      return true
    }
    if phase == .blocked {
      // Waiting/ready cannot recover a blocked lifecycle, even at a later epoch.
      guard next == .blocked || (next == .switching && epoch > previousEpoch) else { return false }
    }
    if epoch == previousEpoch {
      if phase == .ready || (phase == .waiting && next == .switching) { return false }
    }
    phase = next; mode = .transition; generation &+= 1
    return true
  }

  /// Ready is followed by an independent fresh surface read and context-only
  /// event. Neither old target coordinates nor an earlier AX read can resume it.
  @discardableResult public mutating func establishFreshContext(generation observed: UInt64) -> Bool {
    guard mode == .freshContext, observed == generation else { return false }
    mode = .content; generation &+= 1
    return true
  }
  public func permitsContent(generation observed: UInt64) -> Bool {
    mode == .content && observed == generation
  }
  /// Ordinary one-shot transitions also retire asynchronous geometry reads,
  /// without acquiring or releasing a persistent lifecycle hold.
  public mutating func invalidateContent() { generation &+= 1 }
  public mutating func reset() {
    resetThrough = max(resetThrough, highestEpoch)
    phase = nil; mode = .content; generation &+= 1
  }
}
