import Foundation

/// Diagnostic counters only. They never grant readiness or expose the sampled surface.
public struct DesktopSwitchSamples<Surface: Equatable> {
  public private(set) var total = 0
  public private(set) var candidates = 0
  public private(set) var consecutive = 0
  public private(set) var empty = 0
  private var previous: Surface?
  private var previousEpoch: Int?
  public init() {}
  public mutating func record(_ surface: Surface?, epoch: Int, isEmpty: Bool) {
    total += 1
    if isEmpty { empty += 1 }
    guard let surface else { previous = nil; previousEpoch = epoch; consecutive = 0; return }
    candidates += 1
    consecutive = previous == surface && previousEpoch == epoch ? consecutive + 1 : 1
    previous = surface; previousEpoch = epoch
  }
}
