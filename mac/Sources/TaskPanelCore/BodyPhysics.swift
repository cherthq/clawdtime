import Foundation

/// The mascot's body as a thing with weight. A hand that drags it pulls it on a
/// short spring, so it lags the hand and swings under it. It leans and stretches
/// with its speed and runs with a cadence. Let go while it moves and it flies on,
/// slows, bounces off the edge of the screen and comes to rest.
public struct BodyPhysics: Sendable {
  /// What the body does in one frame.
  public struct Frame: Equatable, Sendable {
    /// Where the mascot is, as the origin of its window.
    public var x = 0.0, y = 0.0
    /// Radians. The body hangs back from the pull and swings on.
    public var swing = 0.0
    /// 0 to about 0.26: how much longer the body is along its way.
    public var stretch = 0.0
    /// Radians: the way it travels. 0 is to the right, a quarter turn is up.
    public var stretchAngle = 0.0
    /// -1 to the left, 1 to the right.
    public var travel = 0.0
    /// 0 still, 1 at a full run.
    public var gait = 0.0
    /// Radians. It turns once for each pair of steps, faster at speed.
    public var gaitPhase = 0.0
    /// Above 0 in the one frame in which it hit an edge: how hard, up to 1.
    public var impact = 0.0
    /// False once everything is at rest.
    public var moving = false
    public init() {}
  }
  public struct Bounds: Equatable, Sendable {
    public var minX, minY, maxX, maxY: Double
    public init(minX: Double, minY: Double, maxX: Double, maxY: Double) { self.minX = minX; self.minY = minY; self.maxX = maxX; self.maxY = maxY }
  }

  public private(set) var x: Double, y: Double
  public private(set) var vx = 0.0, vy = 0.0
  private var hand: (x: Double, y: Double)?
  private var swing = 0.0, swingSpeed = 0.0
  private var stretch = 0.0, angle = 0.0, travel = 0.0, gait = 0.0, gaitPhase = 0.0

  public init(x: Double, y: Double) { self.x = x; self.y = y }
  public var held: Bool { hand != nil }
  public var speed: Double { (vx * vx + vy * vy).squareRoot() }

  /// Puts the body somewhere at once, at rest.
  public mutating func place(x: Double, y: Double) {
    self.x = x; self.y = y; vx = 0; vy = 0; hand = nil
    swing = 0; swingSpeed = 0; stretch = 0; travel = 0; gait = 0
  }
  /// The hand holds the body and wants it here.
  public mutating func hold(x: Double, y: Double) { hand = (x, y) }
  /// The hand lets go. The body keeps the speed it has.
  public mutating func letGo() {
    hand = nil
    // A release at rest is a drop, not a throw.
    if speed < 60 { vx = 0; vy = 0 }
  }

  // The pull of the hand: a quick spring with a little overshoot.
  private static let pull = 2 * Double.pi / 0.115, pullDamping = 0.70
  // Free flight: it loses most of its speed in half a second.
  private static let friction = 3.6
  // The swing: a short pendulum that settles in a few passes.
  private static let gravity = 78.0, swingDamping = 6.2, arm = 1 / 1150.0

  /// One step. `still` is reduced motion: the body goes where the hand is and nothing else moves.
  public mutating func step(_ dt: Double, bounds: Bounds, still: Bool = false) -> Frame {
    var frame = Frame()
    var remaining = min(max(dt, 0), 0.1)
    if still {
      if let hand { x = hand.x; y = hand.y }
      x = min(max(x, bounds.minX), bounds.maxX); y = min(max(y, bounds.minY), bounds.maxY)
      vx = 0; vy = 0; swing = 0; swingSpeed = 0; stretch = 0; travel = 0; gait = 0
      frame.x = x; frame.y = y; frame.moving = hand != nil
      return frame
    }
    while remaining > 0 {
      let h = min(remaining, 1.0 / 240)
      var ax = 0.0, ay = 0.0
      if let hand {
        let k = Self.pull * Self.pull, c = 2 * Self.pullDamping * Self.pull
        ax = k * (hand.x - x) - c * vx; ay = k * (hand.y - y) - c * vy
      } else {
        ax = -Self.friction * vx; ay = -Self.friction * vy
      }
      vx += ax * h; vy += ay * h
      x += vx * h; y += vy * h
      if hand == nil {
        // The edge of the screen is a wall. It gives back less than half of the speed.
        if x < bounds.minX { x = bounds.minX; if vx < 0 { frame.impact = max(frame.impact, min(1, -vx / 1100)); vx = -vx * 0.42 } }
        if x > bounds.maxX { x = bounds.maxX; if vx > 0 { frame.impact = max(frame.impact, min(1, vx / 1100)); vx = -vx * 0.42 } }
        if y < bounds.minY { y = bounds.minY; if vy < 0 { frame.impact = max(frame.impact, min(1, -vy / 1100)); vy = -vy * 0.42 } }
        if y > bounds.maxY { y = bounds.maxY; if vy > 0 { frame.impact = max(frame.impact, min(1, vy / 1100)); vy = -vy * 0.42 } }
      }
      // The body hangs from where it is held: a pull to the right leaves its base behind.
      let swingForce = -Self.gravity * sin(swing) - Self.swingDamping * swingSpeed - ax * Self.arm * cos(swing)
      swingSpeed += swingForce * h
      swing = min(max(swing + swingSpeed * h, -0.85), 0.85)
      remaining -= h
    }
    let speed = self.speed
    let rate = min(1, max(0, dt) * 14)
    stretch += (min(0.26, speed / 3000) - stretch) * rate
    if speed > 24 { angle = atan2(vy, vx) }
    travel += (min(1, max(-1, vx / 420)) - travel) * min(1, max(0, dt) * 9)
    gait += (min(1, speed / 520) - gait) * min(1, max(0, dt) * 10)
    if gait > 0.02 { gaitPhase = (gaitPhase + dt * (5 + 9 * gait)).truncatingRemainder(dividingBy: 2 * .pi) }
    if hand == nil && speed < 5 { vx = 0; vy = 0 }
    frame.moving = hand != nil || self.speed > 0 || abs(swing) > 0.004 || abs(swingSpeed) > 0.03 || stretch > 0.004 || gait > 0.02 || abs(travel) > 0.02
    // At rest nothing is left over: the last frame is a clean one.
    if !frame.moving { swing = 0; swingSpeed = 0; stretch = 0; gait = 0; travel = 0 }
    frame.x = x; frame.y = y
    frame.swing = swing; frame.stretch = stretch; frame.stretchAngle = angle
    frame.travel = travel; frame.gait = gait; frame.gaitPhase = gaitPhase
    return frame
  }
}
