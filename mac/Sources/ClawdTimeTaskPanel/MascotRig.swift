import AppKit
import SceneKit
import TaskPanelCore
import simd

/// Real arms, legs and hands for the mascots that have a body. A limb is two
/// bones with a joint: it bends at its elbow or knee so that its end reaches a
/// point, as a real arm does. A hand has a palm, four fingers and a thumb, and
/// every finger has three joints.
enum Rig {
  /// One bone: a rounded, tapered segment that starts at the origin and points down.
  static func bone(length: CGFloat, top: CGFloat, bottom: CGFloat, material: SCNMaterial) -> SCNNode {
    var profile: [(r: Double, y: Double)] = []
    let steps = 7
    // The lower cap, the shaft, the upper cap: one smooth profile from the base to the top.
    for step in 0...steps {
      let angle = Double(step) / Double(steps) * .pi / 2
      profile.append((r: Double(bottom) * sin(angle), y: -Double(length) - Double(bottom) * cos(angle)))
    }
    for step in 0...steps {
      let angle = Double(step) / Double(steps) * .pi / 2
      profile.append((r: Double(top) * cos(angle), y: Double(top) * sin(angle)))
    }
    let geometry = Sculpt.lathe(profile, around: 28)
    geometry.firstMaterial = material
    return SCNNode(geometry: geometry)
  }
  /// A ball for a joint: an elbow, a knee, a knuckle.
  static func joint(radius: CGFloat, material: SCNMaterial) -> SCNNode {
    let sphere = SCNSphere(radius: radius); sphere.segmentCount = 24; sphere.firstMaterial = material
    return SCNNode(geometry: sphere)
  }
  /// A rotation that lays a bone (which points down its own -y) along `direction`,
  /// with its front (+z) turned as near to `front` as the bone allows.
  static func aim(_ direction: SIMD3<Float>, front: SIMD3<Float>) -> simd_quatf {
    let y = -simd_normalize(direction)
    var z = front - y * simd_dot(front, y)
    if simd_length(z) < 1e-4 {
      let other: SIMD3<Float> = abs(y.x) < 0.9 ? SIMD3(1, 0, 0) : SIMD3(0, 0, 1)
      z = other - y * simd_dot(other, y)
    }
    z = simd_normalize(z)
    let x = simd_cross(y, z)
    return simd_quatf(simd_float3x3(columns: (x, y, z)))
  }
}

/// An arm or a leg: two bones and the joint between them.
final class RigLimb {
  /// Put this at the shoulder or the hip, inside the body.
  let root = SCNNode()
  let upper: SCNNode, lower: SCNNode
  /// The wrist or the ankle. A hand or a foot goes inside it.
  let end = SCNNode()
  let upperLength: Float, lowerLength: Float
  /// The longest reach, a little less than both bones in a line, so the joint never locks straight.
  var reachLimit: Float { (upperLength + lowerLength) * 0.985 }

  /// `width` is the radius at the shoulder or hip. The limb narrows to `taper` of it at the wrist or ankle.
  /// `jointMaterial` shows a ball at the elbow or knee, as on a robot or a suit; with none the bones meet smoothly.
  init(upper: CGFloat, lower: CGFloat, width: CGFloat, taper: CGFloat = 0.72, material: SCNMaterial, jointMaterial: SCNMaterial? = nil, jointScale: CGFloat = 1.08) {
    upperLength = Float(upper); lowerLength = Float(lower)
    let middle = width * (1 + taper) / 2
    self.upper = Rig.bone(length: upper, top: width, bottom: middle, material: material)
    self.lower = Rig.bone(length: lower, top: middle, bottom: width * taper, material: material)
    root.addChildNode(self.upper); root.addChildNode(self.lower); root.addChildNode(end)
    if let jointMaterial {
      self.lower.addChildNode(Rig.joint(radius: middle * jointScale, material: jointMaterial))
    }
    reach(SIMD3(0, -(upperLength + lowerLength) * 0.96, 0), pole: SIMD3(0, 0, -1))
  }

  /// Bends the limb so that its end is at `target`. `target` is measured from the
  /// shoulder or hip, in the space the limb sits in. `pole` is the way the elbow
  /// or the knee points: back and out for an arm, forward for a leg.
  func reach(_ target: SIMD3<Float>, pole: SIMD3<Float>) {
    let a = upperLength, b = lowerLength
    var distance = simd_length(target)
    let direction = distance > 1e-5 ? target / distance : SIMD3<Float>(0, -1, 0)
    distance = min(max(distance, abs(a - b) + 0.002), reachLimit)
    let along = (a * a + distance * distance - b * b) / (2 * a * distance)
    let across = (max(0, 1 - along * along)).squareRoot()
    var side = pole - direction * simd_dot(pole, direction)
    if simd_length(side) < 1e-4 {
      let other: SIMD3<Float> = abs(direction.y) < 0.9 ? SIMD3(0, 1, 0) : SIMD3(0, 0, -1)
      side = other - direction * simd_dot(other, direction)
    }
    side = simd_normalize(side)
    let bend = direction * (a * along) + side * (a * across)
    let tip = direction * distance
    // The front of each bone faces away from the bend, so a hand and a kneecap face the right way.
    upper.simdOrientation = Rig.aim(bend, front: -side)
    lower.simdPosition = bend
    lower.simdOrientation = Rig.aim(tip - bend, front: -side)
    end.simdPosition = tip
    end.simdOrientation = lower.simdOrientation
  }
}

/// A hand with a palm, four fingers and a thumb. In its own space the fingers
/// point up (+y), the palm faces +z and the thumb is on the +x side of a right hand.
final class RigHand {
  enum Pose { case open, relaxed, fist, point, thumbsUp, spread, pinch }
  let node = SCNNode()
  private var knuckles: [[SCNNode]] = []
  private var bases: [SCNNode] = []
  private let side: CGFloat
  private var curl = (0..<5).map { _ in Spring(0.3, response: 0.22, dampingRatio: 0.8) }
  private var fan = Spring(0, response: 0.24, dampingRatio: 0.8)

  /// `side` is 1 for a right hand and -1 for a left hand. `width` is the width of the palm.
  /// `thickness` above 1 gives the fat fingers of a glove. `jointMaterial` shows a ball at every finger joint, as on a robot.
  init(side: CGFloat, width: CGFloat, material: SCNMaterial, jointMaterial: SCNMaterial? = nil, thickness: CGFloat = 1) {
    self.side = side
    let w = width, tall = w * 1.02, deep = w * 0.36
    let palm = SCNBox(width: w, height: tall, length: deep, chamferRadius: deep * 0.48)
    palm.chamferSegmentCount = 8; palm.firstMaterial = material
    let palmNode = SCNNode(geometry: palm); palmNode.position = SCNVector3(0, tall / 2, 0)
    node.addChildNode(palmNode)
    // The heel of the hand rounds the wrist end.
    let heel = Rig.joint(radius: w * 0.30, material: material); heel.scale = SCNVector3(1.25, 0.8, 0.7); heel.position = SCNVector3(0, w * 0.08, 0)
    node.addChildNode(heel)

    func finger(at base: SCNVector3, length: CGFloat, radius: CGFloat, parts: [CGFloat], lean: CGFloat) -> (SCNNode, [SCNNode]) {
      let root = SCNNode(); root.position = base; root.eulerAngles.z = lean
      var parent = root, joints: [SCNNode] = []
      var r = radius
      for (index, part) in parts.enumerated() {
        let pivot = SCNNode()
        let piece = length * part
        let capsule = SCNCapsule(capRadius: r, height: piece + r * 2)
        capsule.radialSegmentCount = 16; capsule.capSegmentCount = 8; capsule.firstMaterial = material
        let shape = SCNNode(geometry: capsule); shape.position = SCNVector3(0, piece / 2, 0)
        pivot.addChildNode(shape)
        if let jointMaterial { pivot.addChildNode(Rig.joint(radius: r * 1.12, material: jointMaterial)) }
        parent.addChildNode(pivot)
        if index > 0 { pivot.position = SCNVector3(0, length * parts[index - 1], 0) }
        joints.append(pivot); parent = pivot
        r *= 0.9
      }
      return (root, joints)
    }
    // The thumb sits low on the side of the palm and points up and out.
    let thumb = finger(at: SCNVector3(side * w * 0.46, tall * 0.22, deep * 0.12), length: w * 0.78, radius: w * 0.135 * thickness, parts: [0.56, 0.44], lean: -side * 0.82)
    thumb.0.eulerAngles.y = -side * 0.5
    node.addChildNode(thumb.0); bases.append(thumb.0); knuckles.append(thumb.1)
    let lengths: [CGFloat] = [0.98, 1.08, 1.0, 0.8]
    for index in 0..<4 {
      // From the index finger, beside the thumb, to the little finger.
      let across = side * w * (0.36 - CGFloat(index) * 0.24)
      let drop = index == 3 ? tall * 0.06 : index == 0 ? tall * 0.02 : 0
      let made = finger(at: SCNVector3(across, tall - drop - w * 0.02, 0), length: w * lengths[index], radius: w * 0.112 * thickness, parts: [0.44, 0.31, 0.25], lean: 0)
      node.addChildNode(made.0); bases.append(made.0); knuckles.append(made.1)
    }
    apply()
  }

  private static func curls(_ pose: Pose) -> (curl: [Double], fan: Double) {
    switch pose {
    case .open: return ([0.05, 0.04, 0.04, 0.05, 0.07], 0.25)
    case .relaxed: return ([0.25, 0.26, 0.32, 0.38, 0.44], 0.1)
    case .fist: return ([0.75, 1, 1, 1, 1], 0)
    case .point: return ([0.8, 0.02, 1, 1, 1], 0)
    case .thumbsUp: return ([0, 1, 1, 1, 1], 1)
    case .spread: return ([0, 0, 0, 0, 0], 1)
    case .pinch: return ([0.5, 0.62, 0.2, 0.14, 0.1], 0.3)
    }
  }
  /// Where the fingers go. They move there over the next steps.
  func set(_ pose: Pose) {
    let wanted = Self.curls(pose)
    for index in 0..<5 { curl[index].target = wanted.curl[index] }
    fan.target = wanted.fan
  }
  /// Each finger by hand: 0 is straight, 1 is closed. Thumb first, then index to little.
  func set(curls: [Double], fan spread: Double = 0.1) {
    for index in 0..<min(5, curls.count) { curl[index].target = max(0, min(1, curls[index])) }
    fan.target = max(0, min(1, spread))
  }
  /// Takes the pose at once, with no motion.
  func snap(_ pose: Pose) { set(pose); for index in 0..<5 { curl[index].snap() }; fan.snap(); apply() }
  func step(_ dt: Double) {
    guard dt > 0 else { return }
    for index in 0..<5 { curl[index].step(dt) }
    fan.step(dt); apply()
  }
  private func apply() {
    let spread = CGFloat(fan.value)
    for (index, joints) in knuckles.enumerated() {
      let amount = CGFloat(max(0, min(1.1, curl[index].value)))
      if index == 0 {
        // The thumb closes across the palm.
        bases[0].eulerAngles.z = -side * (0.75 - 0.42 * amount + 0.55 * spread)
        bases[0].eulerAngles.y = -side * (0.5 + 0.7 * amount)
        joints[0].eulerAngles.x = 0.25 * amount
        joints[1].eulerAngles.x = 1.0 * amount
      } else {
        let limits: [CGFloat] = [1.45, 1.7, 1.15]
        for (joint, limit) in zip(joints, limits) { joint.eulerAngles.x = limit * amount }
        // Open fingers fan out a little; a fist pulls them together.
        bases[index].eulerAngles.z = side * (CGFloat(index) - 2.2) * (0.05 + 0.13 * spread) * (1 - 0.8 * min(1, amount))
      }
    }
  }
}

/// A small robotic eye: a ball of dark glass in a metal pod, a ring of light
/// around a bright pupil that turns to look, and two shutters that close over
/// it from above and below. In its own space it looks along +z.
final class RoboEye {
  let node = SCNNode()
  private let look = SCNNode()
  private let upperLid = SCNNode(), lowerLid = SCNNode()
  private let ring = SCNNode(), pupil = SCNNode(), halo = SCNNode()
  private let ringLight = Finish.light(), pupilLight = Finish.light(), haloLight = Finish.halo()
  private let radius: CGFloat

  /// Half of a ball, as a thin shell: the lid. Its edge starts at the top and it covers the back.
  private static func shell(radius: CGFloat, sweep: CGFloat) -> SCNGeometry {
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = [], indices: [Int32] = []
    let around = 20, across = 22
    for i in 0...around {
      let a = sweep * CGFloat(i) / CGFloat(around)
      for j in 0...across {
        let b = -CGFloat.pi / 2 + CGFloat.pi * CGFloat(j) / CGFloat(across)
        let n = SCNVector3(sin(b), cos(b) * cos(a), -cos(b) * sin(a))
        positions.append(SCNVector3(n.x * radius, n.y * radius, n.z * radius)); normals.append(n)
        coordinates.append(CGPoint(x: CGFloat(j) / CGFloat(across), y: CGFloat(i) / CGFloat(around)))
      }
    }
    let row = Int32(across + 1)
    for i in 0..<Int32(around) { for j in 0..<Int32(across) {
      let p = i * row + j, q = p + 1, r = p + row, t = r + 1
      indices += [p, q, r, q, t, r]
    } }
    return Sculpt.geometry(positions, normals, coordinates, indices)
  }

  /// `radius` is the radius of the glass ball. The pod around it is a little larger.
  init(radius: CGFloat, housing: SCNMaterial, lid: SCNMaterial) {
    self.radius = radius
    let r = radius
    // The ball sits back in its pod, so only its front shows through the ring.
    let back = r * 0.34
    let glass = Finish.solid(0x06070A, roughness: 0.06, coat: 1, coatRoughness: 0.03)
    let ball = SCNSphere(radius: r); ball.segmentCount = 48; ball.firstMaterial = glass
    let eye = SCNNode(geometry: ball); eye.position = SCNVector3(0, 0, -back)
    node.addChildNode(eye)
    // The pod: a cup behind the ring, and the ring itself.
    let rim = (r * r - back * back).squareRoot()
    let cup = Sculpt.lathe([(r: 0, y: -Double(r * 1.5)), (r: Double(r * 0.9), y: -Double(r * 1.42)), (r: Double(r * 1.2), y: -Double(r * 1.0)),
      (r: Double(r * 1.24), y: -Double(r * 0.12)), (r: Double(r * 1.2), y: 0), (r: Double(rim * 1.04), y: Double(r * 0.05)), (r: Double(rim * 0.99), y: 0)], around: 48)
    cup.firstMaterial = housing
    let pod = SCNNode(geometry: cup); pod.eulerAngles.x = .pi / 2
    node.addChildNode(pod)
    // Lids: two shells around the ball. Each turns about the line through the eye from side to side.
    for (lidNode, flip) in [(upperLid, CGFloat(1)), (lowerLid, CGFloat(-1))] {
      let shape = Self.shell(radius: r * 1.06, sweep: 2.0)
      let material = lid.copy() as! SCNMaterial; material.isDoubleSided = true
      shape.firstMaterial = material
      let inner = SCNNode(geometry: shape); inner.scale = SCNVector3(1, flip, 1)
      lidNode.addChildNode(inner); lidNode.position = SCNVector3(0, 0, -back)
      node.addChildNode(lidNode)
    }
    // The light: a ring and a pupil on the surface of the ball. They turn with the look.
    look.position = SCNVector3(0, 0, -back)
    let band = SCNTube(innerRadius: r * 0.36, outerRadius: r * 0.50, height: r * 0.02)
    band.radialSegmentCount = 48; band.firstMaterial = ringLight
    ring.geometry = band; ring.eulerAngles.x = .pi / 2; ring.position = SCNVector3(0, 0, r * 0.885)
    let dot = SCNSphere(radius: r * 0.19); dot.segmentCount = 24; dot.firstMaterial = pupilLight
    pupil.geometry = dot; pupil.scale = SCNVector3(1, 1, 0.3); pupil.position = SCNVector3(0, 0, r * 0.99)
    halo.geometry = SCNPlane(width: r * 2.6, height: r * 2.6); halo.geometry?.firstMaterial = haloLight
    halo.position = SCNVector3(0, 0, r * 1.0)
    look.addChildNode(ring); look.addChildNode(pupil); look.addChildNode(halo)
    node.addChildNode(look)
    set(tint: MascotScene.color(0x7FE3FF))
    apply(open: 1, squint: 0, lookX: 0, lookY: 0, glow: 0.6)
  }

  /// The color of the light. The pupil is the same color, nearer to white.
  func set(tint: NSColor) {
    ringLight.diffuse.contents = tint
    pupilLight.diffuse.contents = tint.blended(withFraction: 0.6, of: .white) ?? tint
    haloLight.multiply.contents = tint
  }
  /// `open` 0 is shut and 1 is open (above 1 is wide), `squint` raises the lower lid,
  /// the look goes from -1 to 1 on each axis, `glow` from 0 to 1 is the brightness.
  func apply(open: Double, squint: Double, lookX: Double, lookY: Double, glow: Double) {
    let wide = CGFloat(max(0, min(1.3, open))), smile = CGFloat(max(0, min(1, squint)))
    // Open, the lids rest behind the ring. Shut, they meet a little below the middle.
    upperLid.eulerAngles.x = 0.42 + (1 - min(1, wide)) * 1.52 - max(0, wide - 1) * 0.5
    lowerLid.eulerAngles.x = -min(1.5, 0.42 + (1 - min(1, wide)) * 0.86 + smile * 1.05)
    look.eulerAngles = SCNVector3(-CGFloat(max(-1, min(1, lookY))) * 0.42, CGFloat(max(-1, min(1, lookX))) * 0.5, 0)
    let light = CGFloat(max(0, min(1, glow)))
    // Behind shut lids there is no light at all.
    let seen = max(0, min(1, (wide - 0.08) * 5))
    ring.opacity = (0.35 + 0.65 * light) * seen
    pupil.opacity = seen
    pupil.scale = SCNVector3(0.85 + 0.3 * light, 0.85 + 0.3 * light, 0.3)
    halo.opacity = (0.12 + 0.5 * light) * seen
  }
}
