import Foundation

/// A damped spring toward a target. It is stable at any frame rate: a long step is split.
public struct Spring: Equatable, Sendable {
  public var value: Double
  public var velocity: Double = 0
  public var target: Double
  public let stiffness: Double
  public let damping: Double
  /// `response` is the period in seconds. `dampingRatio` 1 settles with no overshoot.
  public init(_ value: Double, response: Double, dampingRatio: Double) {
    self.value = value; target = value
    let omega = 2 * Double.pi / max(0.01, response)
    stiffness = omega * omega; damping = 2 * dampingRatio * omega
  }
  public mutating func step(_ dt: Double) {
    var remaining = min(max(dt, 0), 0.1)
    while remaining > 0 {
      let h = min(remaining, 1.0 / 240)
      velocity += (stiffness * (target - value) - damping * velocity) * h
      value += velocity * h
      remaining -= h
    }
  }
  public var settled: Bool { abs(target - value) < 0.0005 && abs(velocity) < 0.002 }
  public mutating func snap(to value: Double? = nil) {
    if let value { target = value }
    self.value = target; velocity = 0
  }
}

/// The motion tokens of the Chert design system, as spring settings.
public enum MotionToken {
  /// A control that sinks under the pointer: 90 ms, no overshoot.
  public static let press = (response: 0.12, dampingRatio: 1.0)
  /// Release and selection: about 260 ms with a slight overshoot.
  public static let settle = (response: 0.30, dampingRatio: 0.62)
  /// A surface that opens or closes: quick, almost no overshoot.
  public static let surface = (response: 0.34, dampingRatio: 0.80)
  /// Slow changes of state: no overshoot.
  public static let gentle = (response: 0.60, dampingRatio: 1.0)
  /// Seconds for one pass of the sheen across the stone.
  public static let sheen = 0.75
}
