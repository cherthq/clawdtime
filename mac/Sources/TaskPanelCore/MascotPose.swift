import Foundation

/// What the mascot shows about the work it supervises.
public enum MascotMood: String, CaseIterable, Sendable {
  case idle, working, attention, sharing, sleepy, asleep, offline
}

/// How the mascot is drawn. Every style reads the same poses, so each one blinks,
/// looks, jumps, runs with a drag and shows the state in its own way. Flint, the
/// Chert mark, is the one a new install starts with. The six after it are the
/// plain stones: one solid shape with two eyes.
public enum MascotStyle: String, CaseIterable, Sendable {
  case flint, jet, jade, lapis, amber, garnet, amethyst, pebble, core, neon, iris
  public var title: String {
    switch self {
    case .flint: return "Flint"
    case .jet: return "Jet"
    case .jade: return "Jade"
    case .lapis: return "Lapis"
    case .amber: return "Amber"
    case .garnet: return "Garnet"
    case .amethyst: return "Amethyst"
    case .pebble: return "Pebble"
    case .core: return "Core"
    case .neon: return "Neon"
    case .iris: return "Iris"
    }
  }
  public var summary: String {
    switch self {
    case .flint: return "The Chert mark, and its flake"
    case .jet: return "A round black pebble"
    case .jade: return "A green slab"
    case .lapis: return "A blue wedge, cut like the mark"
    case .amber: return "A drop of amber"
    case .garnet: return "A wine-red peak"
    case .amethyst: return "A violet flake"
    case .pebble: return "The round stone, friendly"
    case .core: return "A glass orb with an iris of light"
    case .neon: return "A night-city droid in black chrome and neon"
    case .iris: return "A lens that watches: glass, steel, an aperture"
    }
  }
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
  /// 0 to 1: how loud the conversation is. A mascot moves its mouth or its light with it.
  public var voice = 0.0
  /// Seconds of animation. It stands still under reduced motion, so a style
  /// that moves on its own (a tail, a flicker, a wave) stops with it.
  public var clock = 0.0
  /// 0 still, 1 at a full run: the mascot is carried or thrown across the screen.
  public var gait = 0.0
  /// -1 to 1, one swing for each step. Legs, a tail or ears alternate with it.
  public var stride = 0.0
  /// -1 to the left, 1 to the right: the way it travels. The body already turns that way.
  public var travel = 0.0
  /// 0 to 1 while it waves to the person. A style with a hand raises it.
  public var wave = 0.0
  /// 0 to 1 while it is off the ground in a jump.
  public var air = 0.0
  /// True while a hand holds it.
  public var held = false
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
  /// 0 to 1: how loud the conversation is, the person's voice or ClawdTime's own.
  public var voice = 0.0
  /// From the body's physics: the swing under a hand, the way and the speed it travels.
  public var swing = 0.0
  public var travel = 0.0
  public var gait = 0.0
  public var gaitPhase = 0.0
  public var held = false
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
  private var jumpStart = -10.0
  private var jumpLanded = true
  private var waveStart = -10.0
  private var heldSince = -10.0
  private var wasHeld = false
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
  /// A real jump: it crouches, leaves the ground, lands with weight and settles.
  public mutating func jump() { jumpStart = time; jumpLanded = false; tapStart = time; sheenStart = time }
  /// A greeting: the body rocks from side to side, and a style with a hand waves it.
  public mutating func wave() { if time - waveStart > 1.2 { waveStart = time } }
  /// It hit something, for example the edge of the screen. `strength` goes from 0 to 1.
  public mutating func thud(_ strength: Double) { squash.velocity -= 2 + 6 * max(0, min(1, strength)) }
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
    let reacting = time - tapStart < 1 || time - nodStart < 1 || time - shakeStart < 1 || time - sheenStart < 1.2 || time - jumpStart < 1.2 || time - waveStart < 1.1
    let carried = input.held || input.gait > 0.01 || abs(input.swing) > 0.003
    if input.hovering || input.pressed || reacting || carried || input.voice > 0.02 || abs(input.dragVelocityX) + abs(input.dragVelocityY) > 1 { return 60 }
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
        for start in [0.0, 0.38] where cycle >= start && cycle < start + 0.36 {
          let phase = (cycle - start) / 0.36
          pose.lift = sin(phase * .pi) * 0.32
          pose.squash = 1 + abs(cos(phase * .pi)) * 0.10
          pose.air = sin(phase * .pi)
        }
        // After the hops it waves, so it is clear that it asks for the person.
        if cycle > 0.9 && cycle < 1.8 { pose.wave = sin((cycle - 0.9) / 0.9 * .pi) }
      }
    }
    if !still {
      // It breathes at rest, and it keeps a beat while agents work.
      let breath = mood == .asleep ? 0.020 : mood == .offline ? 0 : 0.012
      pose.squash *= 1 + breath * sin(time * 2 * .pi / (mood == .asleep ? 5.2 : 3.8))
      if mood == .working {
        pose.bob += 0.020 * sin(time * 2 * .pi * 1.7)
        pose.squash *= 1 + 0.012 * sin(time * 2 * .pi * 3.4)
      }
      // The jump: a crouch, the flight, the landing. The spring rings after it lands.
      let jump = time - jumpStart
      if jump >= 0 && jump < 0.56 {
        if jump < 0.12 {
          let down = jump / 0.12
          pose.squash *= 1 - 0.20 * down * (2 - down)
        } else {
          let flight = (jump - 0.12) / 0.44
          pose.lift += 0.46 * sin(flight * .pi)
          // Long at the start of the flight, round at the top, long again on the way down.
          pose.squash *= 1 + 0.15 * abs(cos(flight * .pi))
          pose.air = sin(flight * .pi)
        }
      } else if !jumpLanded {
        jumpLanded = true
        squash.velocity -= 6.5
      }
      // Carried or thrown: it runs with a cadence, leans into its way and faces it.
      let gait = max(0, min(1, input.gait))
      if gait > 0.01 {
        pose.bob += 0.075 * gait * abs(sin(input.gaitPhase))
        pose.squash *= 1 - 0.05 * gait * cos(2 * input.gaitPhase)
      }
      pose.gait = gait; pose.stride = gait > 0.01 ? sin(input.gaitPhase) : 0
      pose.travel = max(-1, min(1, input.travel))
    }
    pose.held = input.held
    if input.held && !wasHeld { heldSince = time }
    wasHeld = input.held
    pose.squash *= max(0.6, min(1.4, squash.value))
    pose.scale = max(0, scale.value)
    pose.yaw = yaw.value; pose.pitch = pitch.value; pose.roll = roll.value
    if !still {
      pose.roll += max(-0.85, min(0.85, input.swing))
      pose.yaw += 0.5 * pose.travel
      pose.pitch += 0.10 * pose.gait
      // The wave: three rocks from side to side that fade out.
      let wave = time - waveStart
      if wave >= 0 && wave < 0.95 {
        let fade = sin(wave / 0.95 * .pi)
        pose.roll += 0.27 * fade * sin(wave * 2 * .pi * 3.0)
        pose.bob += 0.05 * fade * abs(sin(wave * 2 * .pi * 3.0))
        pose.wave = fade
      }
      // Picked up: a moment of wide eyes.
      if time - heldSince < 0.4 { pose.eyeOpen = max(pose.eyeOpen, 1.22) }
    }
    let nod = time - nodStart, shake = time - shakeStart
    if !still && nod >= 0 && nod < 0.5 { pose.pitch += sin(nod / 0.5 * 2 * .pi) * 0.22 * (1 - nod / 0.5) }
    if !still && shake >= 0 && shake < 0.45 { pose.yaw += sin(shake / 0.45 * 6 * .pi) * 0.22 * (1 - shake / 0.45) }

    // The spark rides the ring. Its speed is the status.
    sparkSpeed += (Self.sparkSpeed(mood) - sparkSpeed) * min(1, dt * 3)
    if !still { sparkAngle = (sparkAngle + sparkSpeed * dt).truncatingRemainder(dividingBy: 2 * .pi) }
    pose.sparkAngle = sparkAngle
    pose.ringWobble = still ? 0 : sin(time * 1.3) * 0.05 + (mood == .attention ? sin(time * 9) * 0.03 : 0)
    let pulse = mood == .attention || mood == .sharing ? 0.75 + 0.25 * sin(time * 5.5) : 1
    // A voice lights the spark and opens the mouth, in every mood.
    let voice = max(0, min(1, input.voice))
    pose.glow = max(0, min(1, max(glow.value * (still ? 1 : pulse), voice)))
    pose.smile = max(pose.smile, voice * 0.9)
    pose.voice = voice
    pose.clock = still ? 0 : time
    if !still { pose.squash *= 1 + voice * 0.035 }

    // The sheen of the Chert mark: on a click, and now and then at rest.
    if !still && awake && time >= nextSheen && time - sheenStart > 2 { sheenStart = time; nextSheen = time + 9 + unit() * 8 }
    let sweep = (time - sheenStart) / MotionToken.sheen
    pose.sheen = !still && sweep >= 0 && sweep <= 1 ? sweep : -1
    return pose
  }
}
