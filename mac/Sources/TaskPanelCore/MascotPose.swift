import Foundation

/// What the mascot shows about the work it supervises.
public enum MascotMood: String, CaseIterable, Sendable {
  case idle, working, attention, sharing, sleepy, asleep, offline
}

/// One frame of the mascot. Every value is plain data, so a frame can be drawn,
/// tested and rendered off screen with no clock.
public struct MascotPose: Equatable, Sendable {
  /// Vertical drift and hop height, in body units.
  public var bob = 0.0
  public var lift = 0.0
  /// 1 is rest. Below 1 the stone is pressed flat and grows wider.
  public var squash = 1.0
  public var scale = 1.0
  public var yaw = 0.0
  public var pitch = 0.0
  public var roll = 0.0
  /// 0 closed, 1 normal, above 1 wide.
  public var eyeOpen = 1.0
  /// 0 to 1: the lower lid comes up, as in a smile.
  public var squint = 0.0
  /// -1 to 1 inside the eye.
  public var pupilX = 0.0
  public var pupilY = 0.0
  public var smile = 0.35
  /// Where the spark is on the ring, in radians.
  public var sparkAngle = 0.6
  public var ringWobble = 0.0
  /// 0 to 1 brightness of the spark.
  public var glow = 0.6
  /// 0 to 1 progress of the sheen across the stone. Negative: no sheen.
  public var sheen = -1.0
  public init() {}
}

public struct MascotInput: Equatable, Sendable {
  public var mood: MascotMood
  /// Pointer direction from the mascot, -1 to 1 on each axis. Up is positive.
  public var pointerX = 0.0
  public var pointerY = 0.0
  /// False when the pointer has not moved for some seconds or is on another screen.
  public var pointerActive = false
  public var hovering = false
  public var pressed = false
  /// Points per second while the person drags the mascot.
  public var dragVelocityX = 0.0
  public var dragVelocityY = 0.0
  public var reduceMotion = false
  public init(mood: MascotMood) { self.mood = mood }
}

/// Turns time and input into poses. The same seed and the same steps give the same poses.
public struct MascotAnimator: Sendable {
  public private(set) var time = 0.0
  private var random: UInt64
  private var nextBlink = 1.4
  private var blinkStart = -10.0
  private var secondBlink = -10.0
  private var tapStart = -10.0
  private var nodStart = -10.0
  private var shakeStart = -10.0
  private var sheenStart = -10.0
  private var nextSheen = 6.0
  private var moodStart = 0.0
  private var mood = MascotMood.idle
  private var sparkAngle = 0.6
  private var sparkSpeed = 0.5
  private var yaw = Spring(0, response: 0.38, dampingRatio: 0.82)
  private var pitch = Spring(0, response: 0.38, dampingRatio: 0.82)
  private var roll = Spring(0, response: 0.34, dampingRatio: 0.55)
  private var pupilX = Spring(0, response: 0.16, dampingRatio: 0.9)
  private var pupilY = Spring(0, response: 0.16, dampingRatio: 0.9)
  private var squash = Spring(1, response: 0.30, dampingRatio: 0.42)
  private var scale = Spring(1, response: MotionToken.settle.response, dampingRatio: MotionToken.settle.dampingRatio)
  private var eye = Spring(1, response: 0.24, dampingRatio: 0.9)
  private var glow = Spring(0.6, response: 0.5, dampingRatio: 1)
  private var smile = Spring(0.35, response: 0.3, dampingRatio: 0.7)

  public init(seed: UInt64 = 0x5EED) { random = seed &* 2862933555777941757 &+ 3037000493 }

  private mutating func unit() -> Double {
    random = random &* 6364136223846793005 &+ 1442695040888963407
    return Double((random >> 33) & 0xFFFFFF) / Double(0x1000000)
  }

  /// The person clicked the mascot: a quick press, a rebound, a smile and a sheen.
  public mutating func tap() { tapStart = time; squash.velocity -= 5.5; sheenStart = time }
  /// Something the person asked for worked: a nod.
  public mutating func nod() { nodStart = time; sheenStart = time }
  /// Something could not be done: one shake.
  public mutating func shake() { shakeStart = time }
  /// The mascot was dropped after a drag.
  public mutating func land() { squash.velocity -= 3.2 }
  public mutating func appear() { scale.snap(to: 1); scale.value = 0.4; scale.velocity = 4; sheenStart = time + 0.1 }

  private static func baseEye(_ mood: MascotMood) -> Double {
    switch mood {
    case .idle, .sharing: return 1
    case .working: return 0.84
    case .attention: return 1.2
    case .sleepy: return 0.46
    case .asleep: return 0.02
    case .offline: return 0.6
    }
  }
  private static func sparkSpeed(_ mood: MascotMood) -> Double {
    switch mood {
    case .idle: return 0.55
    case .working: return 4.4
    case .attention: return 2.4
    case .sharing: return 1.3
    case .sleepy: return 0.25
    case .asleep: return 0.1
    case .offline: return 0
    }
  }
  private static func baseGlow(_ mood: MascotMood) -> Double {
    switch mood {
    case .idle: return 0.55
    case .working: return 0.9
    case .attention, .sharing: return 1
    case .sleepy: return 0.3
    case .asleep, .offline: return 0.12
    }
  }

  /// Frames per second that the current motion needs. A view may draw less often when this is low.
  public func preferredFramesPerSecond(_ input: MascotInput) -> Int {
    if input.reduceMotion { return input.pointerActive || input.hovering ? 30 : 10 }
    let reacting = time - tapStart < 1 || time - nodStart < 1 || time - shakeStart < 1 || time - sheenStart < 1.2
    if input.hovering || input.pressed || reacting || abs(input.dragVelocityX) + abs(input.dragVelocityY) > 1 { return 60 }
    switch input.mood {
    case .asleep, .offline: return 15
    case .working, .attention: return 60
    default: return input.pointerActive ? 60 : 30
    }
  }

  public mutating func step(_ dt: Double, _ input: MascotInput) -> MascotPose {
    let dt = min(max(dt, 0), 0.1)
    time += dt
    if input.mood != mood { mood = input.mood; moodStart = time; if mood == .attention { nextBlink = time + 0.9 } }
    let still = input.reduceMotion
    var pose = MascotPose()

    // Eyes and head follow the pointer. With no pointer the eyes read while it works.
    let awake = mood != .asleep && mood != .offline
    var lookX = 0.0, lookY = 0.0
    if input.pointerActive && awake { lookX = input.pointerX; lookY = input.pointerY }
    else if mood == .working && !still {
      // Reading: short steps left to right, then back.
      let phase = (time * 0.9).truncatingRemainder(dividingBy: 1)
      lookX = -0.5 + (phase * 4).rounded(.down) / 3; lookY = -0.15
    } else if mood == .attention { lookY = 0.1 }
    pupilX.target = max(-1, min(1, lookX)); pupilY.target = max(-1, min(1, lookY))
    yaw.target = still ? 0 : max(-1, min(1, lookX)) * 0.40
    pitch.target = still ? 0 : -max(-1, min(1, lookY)) * 0.20
    roll.target = still ? 0 : max(-0.35, min(0.35, -input.dragVelocityX * 0.0007))
    // Reduced motion: nothing scales.
    scale.target = still ? 1 : input.pressed ? 0.94 : input.hovering ? 1.05 : 1
    eye.target = Self.baseEye(mood) * (input.hovering && awake && mood != .attention ? 1.08 : 1)
    glow.target = Self.baseGlow(mood)
    smile.target = time - tapStart < 0.9 || time - nodStart < 0.9 ? 1 : mood == .attention ? 0.1 : mood == .asleep ? 0.2 : input.hovering ? 0.6 : 0.35
    for keyPath in [\MascotAnimator.yaw, \.pitch, \.roll, \.pupilX, \.pupilY, \.squash, \.scale, \.eye, \.glow, \.smile] { self[keyPath: keyPath].step(dt) }
    if still { squash.snap(to: 1); scale.snap() ; roll.snap(); yaw.snap(); pitch.snap() }

    // Blinks: one every few seconds, sometimes two.
    if awake && time >= nextBlink {
      blinkStart = time
      secondBlink = unit() < 0.18 ? time + 0.3 : -10
      nextBlink = time + 2.6 + unit() * 3.6
    }
    func blink(_ start: Double) -> Double {
      let t = time - start
      if t < 0 || t > 0.22 { return 1 }
      if t < 0.07 { return 1 - t / 0.07 }
      if t < 0.10 { return 0 }
      return (t - 0.10) / 0.12
    }
    let lid = min(blink(blinkStart), blink(secondBlink))
    let happy = max(0, 1 - abs((time - tapStart) - 0.25) / 0.45)
    pose.eyeOpen = max(0, eye.value * lid)
    pose.squint = max(happy, time - nodStart < 0.6 ? 0.6 : 0)
    pose.pupilX = pupilX.value; pose.pupilY = pupilY.value
    pose.smile = smile.value

    // Drift, and a double hop every few seconds while something waits for the person.
    if !still {
      let period = mood == .sleepy || mood == .asleep ? 4.6 : mood == .working ? 2.4 : 3.2
      let depth = mood == .asleep ? 0.03 : mood == .working ? 0.035 : 0.05
      pose.bob = sin(time * 2 * .pi / period) * depth
      if mood == .attention {
        let cycle = (time - moodStart).truncatingRemainder(dividingBy: 3.4)
        for start in [0.0, 0.36] where cycle >= start && cycle < start + 0.34 {
          let phase = (cycle - start) / 0.34
          pose.lift = sin(phase * .pi) * 0.24
          pose.squash = 1 + sin(phase * .pi) * 0.07
        }
      }
    }
    pose.squash *= max(0.6, min(1.4, squash.value))
    pose.scale = max(0, scale.value)
    pose.yaw = yaw.value; pose.pitch = pitch.value; pose.roll = roll.value
    let nod = time - nodStart, shake = time - shakeStart
    if !still && nod >= 0 && nod < 0.5 { pose.pitch += sin(nod / 0.5 * 2 * .pi) * 0.22 * (1 - nod / 0.5) }
    if !still && shake >= 0 && shake < 0.45 { pose.yaw += sin(shake / 0.45 * 6 * .pi) * 0.22 * (1 - shake / 0.45) }

    // The spark rides the ring. Its speed is the status.
    sparkSpeed += (Self.sparkSpeed(mood) - sparkSpeed) * min(1, dt * 3)
    if !still { sparkAngle = (sparkAngle + sparkSpeed * dt).truncatingRemainder(dividingBy: 2 * .pi) }
    pose.sparkAngle = sparkAngle
    pose.ringWobble = still ? 0 : sin(time * 1.3) * 0.05 + (mood == .attention ? sin(time * 9) * 0.03 : 0)
    let pulse = mood == .attention || mood == .sharing ? 0.75 + 0.25 * sin(time * 5.5) : 1
    pose.glow = max(0, min(1, glow.value * (still ? 1 : pulse)))

    // The sheen of the Chert mark: on a click, and now and then at rest.
    if !still && awake && time >= nextSheen && time - sheenStart > 2 { sheenStart = time; nextSheen = time + 9 + unit() * 8 }
    let sweep = (time - sheenStart) / MotionToken.sheen
    pose.sheen = !still && sweep >= 0 && sweep <= 1 ? sweep : -1
    return pose
  }
}
