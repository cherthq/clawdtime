import AppKit
import SceneKit
import TaskPanelCore
import simd

/// Flint: the mark itself as a living stone. The large piece is a knapped core
/// with a window cut through it and one robotic eye inside. The small piece is
/// the flake that was struck from it: it floats in its place in the mark,
/// follows the core late, and strikes sparks from it on a click.
final class FlintScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  private let root = SCNNode(), body = SCNNode(), core = SCNNode(), flake = SCNNode()
  private let eye: RoboEye
  private let windowLight = SCNNode(), spill = SCNNode(), gapLight = SCNNode(), gapLine = SCNNode()
  /// Fine lines of light along the ridges of the core: the fire that is in the flint.
  private let embers = SCNNode()
  private let emberLight = Finish.light()
  private let face: SCNMaterial, faceBase: SCNMaterial, cortex: SCNMaterial, socket: SCNMaterial
  private let lidMaterial: SCNMaterial, podMaterial: SCNMaterial
  private let windowGlow = Finish.halo(), spillGlow = Finish.halo(), gapGlow = Finish.halo(), sparkGlow = Finish.halo()
  private let sparkCore = Finish.light(MascotScene.color(0xFFF6DC))
  private var sparks: [(node: SCNNode, streak: SCNNode, birth: Double, life: Double, velocity: SIMD3<Double>, size: Double)] = []
  private var nextSpark = 0, strikes = 0
  private var mood = MascotMood.idle
  private var lastClock = 0.0, lastSquint = 0.0, lastTick = -1
  // The flake is a little behind the core in everything.
  private var lagYaw = Spring(0, response: 0.42, dampingRatio: 0.5)
  private var lagPitch = Spring(0, response: 0.42, dampingRatio: 0.55)
  private var lagRise = Spring(0, response: 0.36, dampingRatio: 0.5)
  private var strike = Spring(0, response: 0.20, dampingRatio: 0.36)
  private var work = Spring(0, response: 0.5, dampingRatio: 0.9)
  private var alert = Spring(0, response: 0.3, dampingRatio: 0.55)
  private var rest = Spring(0, response: 0.7, dampingRatio: 0.9)
  private var curious = Spring(0, response: 0.3, dampingRatio: 0.5)
  // The flake is the hand and the tail of the stone: it streams behind when the
  // stone is carried, lifts away in a jump, clings when a hand holds the stone.
  private var carry = Spring(0, response: 0.34, dampingRatio: 0.34)
  private var flight = Spring(0, response: 0.20, dampingRatio: 0.42)
  private var cling = Spring(0, response: 0.22, dampingRatio: 0.6)
  private var lastAir = 0.0, lastWave = 0.0, lastSquash = 1.0, lastHeld = false
  private var waveStart = -10.0, heldStart = -10.0, lastThrow = -10.0

  // MARK: the mark

  /// The mark as drawn on its 900 point frame, y down: the core, its window, the flake.
  private static let coreCorners: [(Double, Double)] = [(455, 262), (527, 318), (467, 385), (540, 641), (326, 641), (250, 402)]
  private static let windowCorners: [(Double, Double)] = [(320, 433), (458, 520), (440, 598), (358, 602), (314, 452)]
  private static let flakeCorners: [(Double, Double)] = [(590, 362), (650, 407), (588, 558), (527, 404)]
  /// Low ridges on the face of the core, around the window, with the height of each.
  private static let coreRidge: [(Double, Double, Double)] = [
    (432, 340, 0.15), (492, 326, 0.09), (450, 412, 0.08), (483, 520, 0.10), (494, 614, 0.11),
    (400, 622, 0.08), (342, 622, 0.11), (313, 530, 0.10), (285, 426, 0.14), (352, 388, 0.17),
  ]
  private static let flakeRidge: [(Double, Double, Double)] = [(591, 418, 0.12), (589, 492, 0.09)]
  private static let unit = 0.0080
  private static let cornerRadius = 0.115
  private static let coreDepth = 0.62, flakeDepth = 0.40, chamfer = 0.07
  private static func place(_ x: Double, _ y: Double) -> SIMD2<Double> { SIMD2((x - 450) * unit, (451 - y) * unit) }
  private static let eyeCenter = place(386, 530)
  private static let flakeCenter = place(589, 446)
  private static let gapCenter = place(506, 440)

  private static func area(_ loop: [SIMD2<Double>]) -> Double {
    var sum = 0.0
    for i in 0..<loop.count { let a = loop[i], b = loop[(i + 1) % loop.count]; sum += a.x * b.y - b.x * a.y }
    return sum / 2
  }
  /// A closed outline with rounded corners, counter-clockwise.
  private static func rounded(_ corners: [(Double, Double)], radius: Double, steps: Int = 8) -> [SIMD2<Double>] {
    var points = corners.map { place($0.0, $0.1) }
    if area(points) < 0 { points.reverse() }
    var result: [SIMD2<Double>] = []
    let n = points.count
    for i in 0..<n {
      let v = points[i], p = points[(i + n - 1) % n], q = points[(i + 1) % n]
      let d1 = simd_normalize(p - v), d2 = simd_normalize(q - v)
      let theta = acos(max(-0.999, min(0.999, simd_dot(d1, d2))))
      let tanHalf = tan(theta / 2)
      let reach = min(radius / tanHalf, 0.45 * min(simd_length(p - v), simd_length(q - v)))
      let r = reach * tanHalf
      let center = v + simd_normalize(d1 + d2) * (r / sin(theta / 2))
      let a = v + d1 * reach, b = v + d2 * reach
      let start = atan2(a.y - center.y, a.x - center.x)
      var turn = atan2(b.y - center.y, b.x - center.x) - start
      while turn > .pi { turn -= 2 * .pi }
      while turn < -.pi { turn += 2 * .pi }
      for step in 0...steps {
        let angle = start + turn * Double(step) / Double(steps)
        result.append(center + SIMD2(cos(angle), sin(angle)) * r)
      }
    }
    return result
  }
  /// Moves a counter-clockwise outline inward by a distance, or outward when the distance is negative.
  private static func inset(_ loop: [SIMD2<Double>], by distance: Double) -> [SIMD2<Double>] {
    let n = loop.count
    func left(_ a: SIMD2<Double>, _ b: SIMD2<Double>) -> SIMD2<Double> { let d = simd_normalize(b - a); return SIMD2(-d.y, d.x) }
    return (0..<n).map { i in
      let p = loop[(i + n - 1) % n], v = loop[i], q = loop[(i + 1) % n]
      let n1 = left(p, v), n2 = left(v, q)
      var mid = n1 + n2
      let length = simd_length(mid)
      mid = length < 1e-6 ? n1 : mid / length
      return v + mid * (distance / max(0.5, simd_dot(mid, n1)))
    }
  }
  private static func path(_ loops: [[SIMD2<Double>]]) -> NSBezierPath {
    let path = NSBezierPath()
    for loop in loops {
      path.move(to: NSPoint(x: loop[0].x, y: loop[0].y))
      for point in loop.dropFirst() { path.line(to: NSPoint(x: point.x, y: point.y)) }
      path.close()
    }
    path.windingRule = .evenOdd
    return path
  }

  /// Flat triangles, each with its own normal, as the scars of struck flakes have.
  private struct Facets {
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = [], indices: [Int32] = []
    /// Where a point of the surface is on the image. The default lays one image over the whole mark,
    /// so a band of light crosses both pieces as one.
    var image: (SIMD3<Double>) -> CGPoint = { CGPoint(x: ($0.x + 1.7) / 3.4, y: 0.5 - $0.y / 3.4) }
    mutating func add(_ a: SIMD3<Double>, _ b: SIMD3<Double>, _ c: SIMD3<Double>) {
      var normal = simd_cross(b - a, c - a)
      let length = simd_length(normal)
      guard length > 1e-12 else { return }
      normal /= length
      let corners = normal.z < 0 ? [a, c, b] : [a, b, c]
      if normal.z < 0 { normal = -normal }
      for corner in corners {
        indices.append(Int32(positions.count))
        positions.append(SCNVector3(corner.x, corner.y, corner.z))
        normals.append(SCNVector3(normal.x, normal.y, normal.z))
        coordinates.append(image(corner))
      }
    }
    /// Joins two counter-clockwise loops, the second inside the first.
    mutating func stitch(_ outer: [SIMD3<Double>], _ inner: [SIMD3<Double>]) {
      let nA = outer.count, nB = inner.count
      func flat(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double { simd_length(SIMD2(a.x - b.x, a.y - b.y)) }
      var first = 0
      for j in 1..<nB where flat(outer[0], inner[j]) < flat(outer[0], inner[first]) { first = j }
      var i = 0, j = 0
      while i < nA || j < nB {
        let a = outer[i % nA], b = inner[(first + j) % nB]
        let aNext = outer[(i + 1) % nA], bNext = inner[(first + j + 1) % nB]
        let onOuter = j >= nB || (i < nA && flat(aNext, b) <= flat(a, bNext))
        if onOuter { add(a, aNext, b); i += 1 } else { add(a, bNext, b); j += 1 }
      }
    }
    /// A wall that stands on a counter-clockwise loop and faces into it, from one height down to another.
    mutating func wall(_ loop: [SIMD2<Double>], top: Double, bottom: Double) {
      for i in 0..<loop.count {
        let a = loop[i], b = loop[(i + 1) % loop.count]
        let along = b - a
        guard simd_length(along) > 1e-9 else { continue }
        let facing = simd_normalize(SIMD2(-along.y, along.x))
        for corner in [SIMD3(a.x, a.y, top), SIMD3(b.x, b.y, bottom), SIMD3(a.x, a.y, bottom), SIMD3(a.x, a.y, top), SIMD3(b.x, b.y, top), SIMD3(b.x, b.y, bottom)] {
          indices.append(Int32(positions.count))
          positions.append(SCNVector3(corner.x, corner.y, corner.z))
          normals.append(SCNVector3(facing.x, facing.y, 0))
          coordinates.append(image(corner))
        }
      }
    }
    /// A flat piece: every edge of the loop joined to one point inside it.
    mutating func fan(_ loop: [SIMD3<Double>], around center: SIMD3<Double>) {
      for i in 0..<loop.count { add(loop[i], loop[(i + 1) % loop.count], center) }
    }
    func geometry(_ material: SCNMaterial) -> SCNGeometry {
      let geometry = Sculpt.geometry(positions, normals, coordinates, indices)
      geometry.firstMaterial = material
      return geometry
    }
  }
  private static func lifted(_ loop: [SIMD2<Double>], _ z: Double) -> [SIMD3<Double>] { loop.map { SIMD3($0.x, $0.y, z) } }
  private static func ridge(_ points: [(Double, Double, Double)], base: Double, around center: SIMD2<Double> = .zero) -> [SIMD3<Double>] {
    var loop = points.map { point -> SIMD3<Double> in
      let p = place(point.0, point.1) - center
      return SIMD3(p.x, p.y, base + point.2)
    }
    if area(loop.map { SIMD2($0.x, $0.y) }) < 0 { loop.reverse() }
    return loop
  }

  /// What the polished stone reflects: a dark floor, a pale band of light just over
  /// the horizon all the way round, tall lights at several sides and a wide one
  /// overhead. A scar that tips up shows the band; one that tips down shows the floor.
  private static func studio() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let colors = [0x06070A, 0x0E1016, 0x2B303B, 0xB9C3D9, 0x5A6070, 0x3A3E4A, 0x6B7080].map { MascotScene.color(UInt32($0)).cgColor }
      let room = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: [0, 0.38, 0.5, 0.60, 0.72, 0.86, 1])!
      context.drawLinearGradient(room, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      func box(_ rect: CGRect, _ hex: UInt32, _ strength: CGFloat, blur: CGFloat) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: blur, color: MascotScene.color(hex, strength).cgColor)
        context.setFillColor(MascotScene.color(hex, strength).cgColor)
        context.fill(rect)
        context.restoreGState()
      }
      box(CGRect(x: 110, y: 208, width: 230, height: 26), 0xFFFFFF, 1, blur: 22)
      box(CGRect(x: 60, y: 96, width: 20, height: 96), 0xE4EDFF, 0.95, blur: 18)
      box(CGRect(x: 196, y: 104, width: 16, height: 80), 0xFFFFFF, 0.8, blur: 16)
      box(CGRect(x: 318, y: 100, width: 20, height: 90), 0xFFE2C2, 0.9, blur: 18)
      box(CGRect(x: 440, y: 104, width: 16, height: 80), 0xF2F5FF, 0.8, blur: 16)
    }
  }

  /// Light that leaks from a seam: bright in the middle of the band, nothing at its edges.
  private static func seam() -> CGImage {
    MascotScene.image(width: 64, height: 4) { context in
      let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [NSColor.white.withAlphaComponent(0).cgColor, NSColor.white.withAlphaComponent(0.28).cgColor, NSColor.white.cgColor,
                 NSColor.white.withAlphaComponent(0.28).cgColor, NSColor.white.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.36, 0.5, 0.64, 1])!
      context.drawLinearGradient(glow, start: .zero, end: CGPoint(x: 64, y: 0), options: [])
    }
  }

  // MARK: build

  init() {
    face = Finish.solid(0x1B1F28, roughness: 0.16, coat: 1, coatRoughness: 0.05)
    faceBase = Finish.solid(0x1B1F28, roughness: 0.16, coat: 1, coatRoughness: 0.05)
    cortex = Finish.solid(0xE9E2D2, roughness: 0.6)
    socket = Finish.solid(0x050608, roughness: 0.5)
    podMaterial = Finish.solid(0x2A2D34, roughness: 0.3, metalness: 0.9)
    lidMaterial = Finish.solid(0x30343C, roughness: 0.28, metalness: 0.85)
    eye = RoboEye(radius: 0.30, housing: podMaterial, lid: lidMaterial)

    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.studio()
    scene.lightingEnvironment.intensity = 1.9
    scene.rootNode.addChildNode(root)
    root.addChildNode(body)
    body.addChildNode(core)

    face.emission.contents = MascotScene.sheenBand(); face.emission.wrapT = .clampToBorder; face.emission.intensity = 0
    let profile = NSBezierPath()
    profile.move(to: NSPoint(x: 0, y: 1))
    profile.curve(to: NSPoint(x: 1, y: 0), controlPoint1: NSPoint(x: 0.55, y: 1), controlPoint2: NSPoint(x: 1, y: 0.55))

    // The core: the outline with its window, as a solid with a soft edge.
    let outline = Self.rounded(Self.coreCorners, radius: Self.cornerRadius)
    let window = Self.rounded(Self.windowCorners, radius: Self.cornerRadius * 0.9)
    let solid = SCNShape(path: Self.path([outline, window]), extrusionDepth: Self.coreDepth)
    solid.chamferRadius = Self.chamfer; solid.chamferMode = .both; solid.chamferProfile = profile
    solid.materials = [faceBase, cortex, cortex, cortex, cortex]
    core.addChildNode(SCNNode(geometry: solid))
    // Its face: broad flat scars that rise from the edge to low ridges and fall to the window.
    let front = Self.coreDepth / 2 + 0.006
    var scars = Facets()
    let ridge = Self.ridge(Self.coreRidge, base: front)
    scars.stitch(Self.lifted(Self.inset(outline, by: Self.chamfer + 0.004), front), ridge)
    scars.stitch(ridge, Self.lifted(Self.inset(window, by: -(Self.chamfer + 0.004)), front))
    core.addChildNode(SCNNode(geometry: scars.geometry(face)))
    // The ridges can glow: a thin line of light lies on each one.
    emberLight.blendMode = .add; emberLight.writesToDepthBuffer = false; emberLight.isDoubleSided = true
    emberLight.diffuse.contents = Self.seam()
    for index in ridge.indices {
      let a = ridge[index], b = ridge[(index + 1) % ridge.count]
      // A soft band that lies on the ridge and faces out of the stone.
      let band = SCNPlane(width: 0.085, height: CGFloat(simd_length(b - a)) + 0.03)
      band.firstMaterial = emberLight
      let node = SCNNode(geometry: band)
      let middle = (a + b) / 2
      node.position = SCNVector3(middle.x, middle.y, middle.z + 0.012)
      let along = simd_normalize(SIMD3<Float>(Float(b.x - a.x), Float(b.y - a.y), Float(b.z - a.z)))
      node.simdOrientation = Rig.aim(-along, front: SIMD3<Float>(0, 0, 1))
      embers.addChildNode(node)
    }
    embers.opacity = 0
    core.addChildNode(embers)

    // Behind the window it is dark. The eye sits back in that dark and looks out.
    // Both the dark and its light have the shape of the window, so neither shows past the stone.
    let hollow = Self.inset(window, by: -0.03)
    let middle = SIMD3(Self.eyeCenter.x, Self.eyeCenter.y, 0)
    var dark = Facets()
    dark.fan(Self.lifted(hollow, -Self.coreDepth / 2 + 0.03), around: middle + SIMD3(0, 0, -Self.coreDepth / 2 + 0.03))
    core.addChildNode(SCNNode(geometry: dark.geometry(socket)))
    // The cut shows the dark inside of the stone, not its pale rind.
    var cut = Facets()
    cut.wall(Self.inset(window, by: 0.006), top: Self.coreDepth / 2 - Self.chamfer, bottom: -Self.coreDepth / 2 + 0.03)
    let cutMaterial = Finish.solid(0x0E1014, roughness: 0.42, coat: 0.3)
    cutMaterial.isDoubleSided = true
    core.addChildNode(SCNNode(geometry: cut.geometry(cutMaterial)))
    var light = Facets()
    // The light is round and brightest behind the eye.
    light.image = { CGPoint(x: 0.5 + ($0.x - Self.eyeCenter.x) / 1.9, y: 0.5 - ($0.y - Self.eyeCenter.y) / 1.9) }
    light.fan(Self.lifted(hollow, -Self.coreDepth / 2 + 0.05), around: middle + SIMD3(0, 0, -Self.coreDepth / 2 + 0.05))
    windowLight.geometry = light.geometry(windowGlow)
    core.addChildNode(windowLight)
    eye.node.position = SCNVector3(Self.eyeCenter.x, Self.eyeCenter.y, Self.coreDepth / 2 - 0.15)
    core.addChildNode(eye.node)
    spill.geometry = SCNPlane(width: 2.6, height: 2.6); spill.geometry?.firstMaterial = spillGlow
    spill.position = SCNVector3(Self.eyeCenter.x, Self.eyeCenter.y, front + 0.14)
    core.addChildNode(spill)

    // The flake, built around its own middle, so it can turn and tilt there.
    let chip = Self.rounded(Self.flakeCorners, radius: Self.cornerRadius * 0.9).map { $0 - Self.flakeCenter }
    let chipSolid = SCNShape(path: Self.path([chip]), extrusionDepth: Self.flakeDepth)
    chipSolid.chamferRadius = Self.chamfer * 0.9; chipSolid.chamferMode = .both; chipSolid.chamferProfile = profile
    chipSolid.materials = [faceBase, faceBase, cortex, cortex, cortex]
    flake.addChildNode(SCNNode(geometry: chipSolid))
    var chipScars = Facets()
    let chipFront = Self.flakeDepth / 2 + 0.006
    chipScars.stitch(Self.lifted(Self.inset(chip, by: Self.chamfer * 0.9 + 0.004), chipFront), Self.ridge(Self.flakeRidge, base: chipFront, around: Self.flakeCenter))
    // The image of the band of light is laid over the whole mark: move the flake's part to its place.
    let chipFace = SCNNode(geometry: chipScars.geometry(face))
    flake.addChildNode(chipFace)
    flake.position = SCNVector3(Self.flakeCenter.x, Self.flakeCenter.y, 0)
    body.addChildNode(flake)

    // Light in the gap between the two pieces, and the sparks that jump from it.
    gapLight.geometry = SCNPlane(width: 0.9, height: 2.3); gapLight.geometry?.firstMaterial = gapGlow
    gapLight.position = SCNVector3(Self.gapCenter.x, Self.gapCenter.y, 0.1)
    gapLight.eulerAngles.z = -0.26
    body.addChildNode(gapLight)
    // A narrow, brighter light in the middle of the gap, for a voice.
    gapLine.geometry = SCNPlane(width: 0.22, height: 1.9); gapLine.geometry?.firstMaterial = gapGlow
    gapLine.position = SCNVector3(Self.gapCenter.x, Self.gapCenter.y, 0.12)
    gapLine.eulerAngles.z = -0.26
    body.addChildNode(gapLine)
    for _ in 0..<12 {
      let node = SCNNode(), streak = SCNNode(geometry: SCNSphere(radius: 0.02))
      streak.geometry?.firstMaterial = sparkCore
      let glow = SCNNode(geometry: SCNPlane(width: 0.36, height: 0.36)); glow.geometry?.firstMaterial = sparkGlow
      glow.constraints = [SCNBillboardConstraint()]
      node.addChildNode(streak); node.addChildNode(glow); node.isHidden = true
      body.addChildNode(node)
      sparks.append((node, streak, -10, 0.5, .zero, 1))
    }

    scene.rootNode.addChildNode(Stage.light(.ambient, 0xF4EEE4, 170))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFF4E6, 900, angles: SCNVector3(-0.75, -0.5, 0)))
    // Light from behind on both sides draws the edge of a dark stone on a dark desk.
    scene.rootNode.addChildNode(Stage.light(.directional, 0xC4D2FF, 700, angles: SCNVector3(-0.15, -2.45, 0)))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFDDBE, 620, angles: SCNVector3(0.25, 2.45, 0)))
    scene.rootNode.addChildNode(camera)
    Stage.bloom(camera, intensity: 0.7, threshold: 0.72, radius: 9)
    set(mood: .idle)
    apply(MascotPose())
  }

  // MARK: state

  /// The light carries the state: warm white at rest, blue at work, amber when it
  /// needs the person, red while the screen is shared.
  func set(mood: MascotMood) {
    self.mood = mood
    let tint: UInt32
    switch mood {
    case .idle, .sleepy: tint = 0xFFE2B8
    case .working: tint = 0x86A8FF
    case .attention: tint = 0xFFB936
    case .sharing: tint = 0xFF6257
    case .asleep, .offline: tint = 0x8A857D
    }
    let color = MascotScene.color(tint)
    eye.set(tint: color)
    windowGlow.multiply.contents = color; spillGlow.multiply.contents = color; gapGlow.multiply.contents = color
    emberLight.multiply.contents = color
    sparkGlow.multiply.contents = MascotScene.color(0xFFC46B).blended(withFraction: 0.35, of: color) ?? color
    // With no service the stone is dull and has no light.
    let dull = mood == .offline
    for material in [face, faceBase] {
      material.roughness.contents = dull ? 0.55 : 0.16
      material.clearCoat.contents = dull ? 0.15 : 1.0
      material.diffuse.contents = MascotScene.color(dull ? 0x2A2B2E : 0x1B1F28)
    }
    cortex.diffuse.contents = MascotScene.color(dull ? 0xB9B6AE : 0xE9E2D2)
  }

  private func unit(_ seed: Int) -> Double {
    let value = sin(Double(seed) * 12.9898 + 4.1) * 43758.5453
    return value - value.rounded(.down)
  }
  /// A few sparks leave the gap. They fly up and out, fall, and fade.
  private func throwSparks(_ count: Int, power: Double, at clock: Double) {
    strikes += 1
    lastThrow = clock
    for index in 0..<count {
      let seed = strikes * 31 + index * 7
      let angle = 0.35 + unit(seed) * 2.5
      let speed = power * (0.9 + unit(seed + 1) * 1.6)
      let slot = nextSpark % sparks.count
      nextSpark += 1
      sparks[slot].birth = clock + unit(seed + 2) * 0.05
      sparks[slot].life = 0.5 + unit(seed + 3) * 0.55
      sparks[slot].velocity = SIMD3(cos(angle) * speed, sin(angle) * speed + 0.4, 0.3 + unit(seed + 4) * 0.7)
      sparks[slot].size = 0.7 + unit(seed + 5) * 0.8
    }
  }

  func apply(_ pose: MascotPose) {
    let dt = max(0, min(0.1, pose.clock - lastClock))
    lastClock = pose.clock
    let moving = dt > 0

    // The core. Stone gives only a little when it is pressed.
    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    let give = 1 + (pose.squash - 1) * 0.3
    let wide = 1 / sqrt(max(0.3, give))
    body.scale = SCNVector3(pose.scale * wide, pose.scale * give, pose.scale * wide)
    body.eulerAngles = SCNVector3(pose.pitch * 0.7, pose.yaw * 0.8, pose.roll)

    // The eye in the window. Carried, it looks the way it travels. Picked up, it
    // opens wide and looks hard at the hand for a moment.
    let happy = max(pose.squint, max(0, pose.smile - 0.35) * 0.45)
    if pose.held && !lastHeld { heldStart = pose.clock }
    lastHeld = pose.held
    let startled = pose.held && moving && pose.clock - heldStart < 0.45
    let carrying = min(1, pose.gait * 1.6)
    var lookX = pose.pupilX * 0.85 * (1 - carrying) + pose.travel * 0.95 * carrying
    var lookY = pose.pupilY * 0.85 * (1 - carrying) + 0.12 * carrying
    if startled { lookX = max(-1, min(1, pose.pupilX * 1.3)); lookY = max(-1, min(1, pose.pupilY * 1.3)) }
    eye.apply(open: startled ? max(pose.eyeOpen, 1.28) : pose.eyeOpen, squint: happy, lookX: lookX, lookY: lookY, glow: pose.glow)
    let glow = CGFloat(max(0, min(1, pose.glow))), voice = CGFloat(max(0, min(1, pose.voice)))
    let lit = CGFloat(max(0, min(1, pose.eyeOpen * 2)))
    windowLight.opacity = (0.16 + 0.5 * glow + 0.25 * voice) * (0.35 + 0.65 * lit)
    spill.opacity = (0.03 + 0.09 * glow) * lit

    // Moods of the flake, each as a value that settles.
    work.target = mood == .working ? 1 : 0
    alert.target = mood == .attention ? 1 : 0
    rest.target = mood == .asleep || mood == .offline ? 1 : mood == .sleepy ? 0.4 : 0
    curious.target = max(0, min(1, (pose.scale - 1) / 0.05))
    lagYaw.target = pose.yaw; lagPitch.target = pose.pitch; lagRise.target = pose.bob + pose.lift
    // Above zero the flake is on the side that trails; below zero it leads and the wind pins it back.
    carry.target = -pose.travel * pose.gait
    flight.target = pose.air
    cling.target = pose.held ? 1 - min(1, pose.gait * 2.5) : 0
    if moving {
      // A greeting starts: the flake counts its three waves from here.
      if pose.wave > 0.02 && lastWave <= 0.02 { waveStart = pose.clock }
      // The landing of a jump: the flake snaps back at the core and one small spark jumps.
      if lastAir > 0.08 && pose.air < 0.02 && pose.clock - lastThrow > 0.2 { strike.velocity -= 2.8; throwSparks(1, power: 0.8, at: pose.clock + 0.03) }
      // A hard knock, as on the edge of the screen: flint on stone.
      if lastSquash - pose.squash > 0.04 && pose.clock - lastThrow > 0.35 && pose.air < 0.02 { throwSparks(2, power: 0.9, at: pose.clock) }
      // A click: the flake snaps against the core and sparks fly.
      if pose.squint > 0.4 && lastSquint <= 0.4 { strike.velocity -= 5.2; throwSparks(8, power: 1.5, at: pose.clock + 0.04) }
      let tick = Int(pose.clock / 3.4)
      if mood == .attention && tick != lastTick { throwSparks(3, power: 0.9, at: pose.clock) }
      lastTick = tick
      for keyPath in [\FlintScene.work, \.alert, \.rest, \.curious, \.lagYaw, \.lagPitch, \.lagRise, \.strike, \.carry, \.flight, \.cling] { self[keyPath: keyPath].step(dt) }
    } else {
      for keyPath in [\FlintScene.work, \.alert, \.rest, \.curious, \.lagYaw, \.lagPitch, \.lagRise, \.strike, \.carry, \.flight, \.cling] { self[keyPath: keyPath].snap() }
    }
    lastSquint = pose.squint; lastAir = pose.air; lastWave = pose.wave; lastSquash = pose.squash

    let working = CGFloat(work.value), needs = CGFloat(alert.value), asleep = CGFloat(rest.value), tilt = CGFloat(curious.value)
    let clock = CGFloat(pose.clock)
    // It bobs out of step with the core, lifts and trembles when the person is needed, and rests close when asleep.
    let own = sin(clock * 1.9) * 0.035 * (1 - asleep)
    let tremble = sin(clock * 38) * 0.012 * needs
    let late = CGFloat(lagRise.value - (pose.bob + pose.lift))
    // Carried: on the trailing side it streams out on a longer leash with its tip
    // turned back, and on the leading side the wind pins it back over the shoulder
    // of the core. It bobs with each step. When the stone stops it swings past and settles.
    let trail = CGFloat(max(0, carry.value)), lead = CGFloat(max(0, -carry.value))
    let gait = CGFloat(pose.gait), step = CGFloat(pose.stride) * gait
    // In a jump it lifts away from the core. Held still, it clings to it.
    let up = CGFloat(max(0, flight.value)), near = CGFloat(max(0, cling.value))
    // A greeting: it rises clear of the core and waves three times, turning about a point low on itself, as a hand turns at the wrist.
    let hello = CGFloat(pose.wave)
    let waving = hello * (-0.18 + 0.66 * sin(CGFloat(pose.clock - waveStart) * 2 * .pi * 3.2))
    let wrist: CGFloat = 0.45
    flake.position = SCNVector3(
      CGFloat(Self.flakeCenter.x) + CGFloat(strike.value) - asleep * 0.10 + tilt * 0.05 + tremble
        + 0.22 * trail - 0.12 * lead - 0.11 * near + 0.16 * up + 0.22 * hello + wrist * sin(waving),
      CGFloat(Self.flakeCenter.y) + late * 0.9 + own + needs * 0.17 - asleep * 0.12
        - 0.05 * trail + 0.17 * lead + 0.10 * step + 0.18 * up + 0.34 * hello - wrist * (1 - cos(waving)),
      working * 0.05 + tilt * 0.06 + 0.05 * hello)
    // While agents work it turns in its own plane, with the speed of the work, as a loader does.
    let spin = working * CGFloat(pose.sparkAngle)
    flake.eulerAngles = SCNVector3(
      CGFloat(lagPitch.value - pose.pitch) * 0.9,
      CGFloat(lagYaw.value - pose.yaw) * 0.9,
      tilt * 0.26 - needs * 0.16 * (1 - hello) + asleep * 0.30 + CGFloat(pose.ringWobble) * 1.4 - spin
        + 0.80 * trail + 0.72 * lead + 0.20 * step - 0.28 * up + waving)

    // The gap glows with a voice and flickers when the person is needed.
    let flicker = 0.75 + 0.25 * sin(clock * 18)
    let struck = max(0, -CGFloat(strike.value)) * 5
    gapLight.opacity = min(1, 0.05 + 0.10 * glow + voice * 0.6 * flicker + needs * 0.22 * (0.6 + 0.4 * sin(clock * 5.5)) + struck)
    gapLine.opacity = min(1, voice * 0.95 * flicker + needs * 0.3 * (0.5 + 0.5 * sin(clock * 5.5)) + struck)
    // The ridges light up when the person is needed, breathe with a voice, and flash on a strike.
    embers.opacity = min(1, needs * (0.55 + 0.35 * sin(clock * 5.5)) + voice * 0.7 * flicker + struck * 0.8 + working * 0.16)

    // Sparks: each one flies from the gap, falls and fades.
    for index in sparks.indices {
      let spark = sparks[index]
      let age = pose.clock - spark.birth
      guard age >= 0, age < spark.life else { if !spark.node.isHidden { spark.node.isHidden = true }; continue }
      let left = 1 - age / spark.life
      let velocity = SIMD3(spark.velocity.x, spark.velocity.y - 3.2 * age, spark.velocity.z)
      let place = SIMD3(Self.gapCenter.x, Self.gapCenter.y + 0.1, 0.2) + spark.velocity * age + SIMD3(0, -1.6 * age * age, 0)
      spark.node.isHidden = false
      spark.node.position = SCNVector3(place.x, place.y, place.z)
      spark.node.opacity = CGFloat(min(1, left * 1.6))
      let size = CGFloat(spark.size * (0.35 + 0.65 * left))
      spark.node.scale = SCNVector3(size, size, size)
      // It is drawn out along its path, as a spark is to the eye.
      spark.streak.eulerAngles.z = CGFloat(atan2(velocity.y, velocity.x))
      spark.streak.scale = SCNVector3(2.5 + CGFloat(simd_length(velocity)) * 1.6, 0.75, 0.75)
    }

    // The sheen of the mark: a band of light that crosses the scars from the top edge to the base.
    if pose.sheen >= 0 {
      face.emission.intensity = CGFloat(0.6 * sin(pose.sheen * .pi))
      var transform = SCNMatrix4MakeTranslation(0, CGFloat(0.9 - pose.sheen * 1.8), 0)
      transform = SCNMatrix4Rotate(transform, 0.5, 0, 0, 1)
      face.emission.contentsTransform = transform
    } else if face.emission.intensity != 0 { face.emission.intensity = 0 }
  }
}
