import CoreGraphics
import Foundation

/// The way of a cursor from where it is to where the hands act next: points over
/// time, with an ease at both ends. The mascot's guided cursor follows it across
/// the screen, and the real pointer follows a short straight one. A view only
/// draws what this gives.
public struct GuidedPath: Equatable, Sendable {
  /// Seconds for a way when the caller names no time. The guided cursor takes `glideDuration`.
  public static let travel = 0.30
  /// The middle of the way bends off the straight line by this share of its length, and never by more points than `maxBend`.
  public static let arc = 0.10, maxBend = 36.0
  public let start: CGPoint
  public let target: CGPoint
  public let duration: Double
  /// How far the middle of the way is off the straight line, in points.
  public let bend: Double

  /// `still` is Reduce Motion: no travel, the cursor is at the target at once.
  public init(from start: CGPoint, to target: CGPoint, duration: Double = GuidedPath.travel, arc: Double = GuidedPath.arc, still: Bool = false) {
    self.start = start; self.target = target
    self.duration = still || !duration.isFinite ? 0 : max(0, duration)
    let length = hypot(Double(target.x - start.x), Double(target.y - start.y))
    bend = still || !length.isFinite ? 0 : min(Self.maxBend, max(0, arc) * length)
  }
  public var length: Double { hypot(Double(target.x - start.x), Double(target.y - start.y)) }
  /// Slow, fast, slow: 0 at 0, 1 at 1, never outside, never backward.
  public static func ease(_ t: Double) -> Double {
    let x = max(0, min(1, t))
    return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
  }
  /// The share of the way that is behind the cursor at `time` seconds, 0 to 1.
  public func progress(at time: Double) -> Double {
    guard duration > 0, time.isFinite else { return 1 }
    return Self.ease(time / duration)
  }
  /// Where the cursor is at `time` seconds after it left.
  public func point(at time: Double) -> CGPoint {
    let s = progress(at: time)
    guard s < 1 else { return target }
    let dx = Double(target.x - start.x), dy = Double(target.y - start.y), length = hypot(dx, dy)
    guard length > 0 else { return target }
    // Along the line it only goes forward. Across it, it swings out and comes back.
    let side = bend * 4 * s * (1 - s)
    return CGPoint(x: Double(start.x) + dx * s - dy / length * side, y: Double(start.y) + dy * s + dx / length * side)
  }
  public func done(at time: Double) -> Bool { time >= duration }
  /// The points for events sent every `interval` seconds. The last one is the target itself.
  public func points(every interval: Double) -> [CGPoint] {
    guard duration > 0, interval > 0 else { return [target] }
    let count = max(1, Int(min(600, (duration / interval).rounded(.up))))
    return (1...count).map { $0 == count ? target : point(at: duration * Double($0) / Double(count)) }
  }
  /// Seconds for the real pointer to cross `length` points: short, and a little longer for a long way.
  public static func moveDuration(length: Double) -> Double { min(0.18, 0.06 + max(0, length) / 6000) }
  /// Seconds for a drag: slow enough that an app follows it.
  public static func dragDuration(length: Double) -> Double { min(0.60, 0.25 + max(0, length) / 3000) }
  /// Seconds for the guided cursor to glide `length` points. A glide is slow enough to follow on a
  /// phone that shows the screen: the picture of a call has 10 frames a second, so the shortest
  /// glide is in four of them or more. A long way takes longer than a short one, up to a limit.
  /// The limit is low, because the screen can change between the worker's last look and the
  /// event: the glide and the wait together stay at one second or under.
  public static let shortestGlide = 0.45, longestGlide = 0.70
  public static func glideDuration(length: Double) -> Double {
    guard length.isFinite else { return shortestGlide }
    return min(longestGlide, shortestGlide + max(0, length) / 2400)
  }
  /// Seconds that the cursor waits at the target before the click or the first key, so the eye
  /// is there before the hand and the label can be read: three frames of a call's picture. Reduce
  /// Motion had no glide to lead the eye, so its wait is longer. A cursor that did not move (the
  /// next key in the field that it points at) already has the eye there: it waits only for the new
  /// label, one or two frames.
  public static func dwell(still: Bool, moved: Bool = true) -> Double { !moved ? 0.15 : still ? 0.40 : 0.30 }
  /// A way shorter than this many points is no way: the cursor is already at the target, and it
  /// does not glide.
  public static let inPlace = 3.0
  /// Seconds that the cursor stays after a command, before it fades. A command that comes in this
  /// time takes the cursor on from where it is. It is longer than the usual time between two steps
  /// (a look and a plan, about two seconds), so the cursor goes from one action to the next and
  /// does not come out of the mascot again for each one.
  public static let rest = 3.0
  /// Where the cursor leaves from. While it is on the screen it goes on from where it is, so its
  /// way from one action to the next is one line. It first comes out of the mascot. With the
  /// mascot put away it starts at the real pointer.
  public static func origin(shown: CGPoint?, mascot: CGPoint?, pointer: CGPoint) -> CGPoint {
    func real(_ point: CGPoint?) -> CGPoint? { point.flatMap { $0.x.isFinite && $0.y.isFinite ? $0 : nil } }
    return real(shown) ?? real(mascot) ?? pointer
  }
  /// The way of the guided cursor to one target. `still` is Reduce Motion: a jump with no glide.
  public static func glide(from start: CGPoint, to target: CGPoint, still: Bool) -> GuidedPath {
    let length = hypot(Double(target.x - start.x), Double(target.y - start.y))
    // Already there: no glide, and no time spent on one.
    let duration = length.isFinite && length < inPlace ? 0 : glideDuration(length: length)
    return GuidedPath(from: start, to: target, duration: duration, still: still)
  }
  /// How far the mascot leans toward a target, in radians. A positive lean is toward the left.
  public static func lean(from mascot: CGPoint, to target: CGPoint) -> Double {
    let offset = Double(target.x - mascot.x)
    guard offset.isFinite else { return 0 }
    return -max(-1, min(1, offset / 480)) * 0.26
  }
}

/// The mascot while the hands type: it looks down at the keys and taps.
public enum TypingBeat {
  public static let tapsPerSecond = 7.0
  /// Changes one pose. `still` is Reduce Motion: the eyes go down and nothing moves.
  public static func apply(to pose: inout MascotPose, at time: Double, still: Bool) {
    pose.pupilY = min(pose.pupilY, -0.55)
    guard !still, time.isFinite else { return }
    let tap = abs(sin(time * .pi * tapsPerSecond))
    pose.pitch += 0.08
    pose.bob -= 0.020 * tap
    pose.squash *= 1 - 0.025 * tap
    pose.roll += 0.030 * sin(time * .pi * tapsPerSecond)
  }
}
