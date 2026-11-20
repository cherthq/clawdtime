import AppKit
import SceneKit
import TaskPanelCore

/// Iris: one eye, built like a fine lens. A barrel of black anodised metal and
/// titanium, a front element of coated glass, and behind it aperture blades
/// that open on a well of light. A blink closes the blades and the lid, a look
/// moves the inner group, and the focus scale turns while agents work.
///
/// The lens hangs in a gimbal of two rings. The outer hoop is what a hand holds:
/// it swings under the hand and turns into the way of travel at once. The lens is
/// heavy: it swings behind on its pivots, rocks with each step, and swings past
/// level and back when the hoop stops.
final class IrisScene: MascotFigure {
  let scene = SCNScene()
  /// A little closer than the other styles, with the same frame: the layers of the lens shift more against each other.
  let camera = Stage.camera(fieldOfView: 30, distance: 8.7, height: 0.02)
  private let root = SCNNode(), lens = SCNNode(), focus = SCNNode(), group = SCNNode()
  /// The gimbal: the hoop turns as a whole, the cradle turns in it about the upright pivots, the lens tips in the cradle.
  /// Each ring's metal sits in its own node, so a press can flex the ring and not what hangs in it.
  private let hoop = SCNNode(), hoopBand = SCNNode(), cradle = SCNNode(), cradleBand = SCNNode()
  private var blades: [SCNNode] = []
  private let topLid = SCNNode(), bottomLid = SCNNode()
  private let sensor = SCNNode(), core = SCNNode(), well = SCNNode(), spill = SCNNode(), aura = SCNNode()
  private var lamps: [SCNNode] = [], lampGlows: [SCNNode] = []
  private let tally = SCNNode(), tallyGlow = SCNNode()
  private let streak = SCNNode(), ghostNear = SCNNode(), ghostFar = SCNNode()
  private let streakMaterial = Finish.halo(), ghostNearMaterial = Finish.halo(), ghostFarMaterial = Finish.halo()
  private let glass = SCNMaterial(), innerGlass = SCNMaterial()
  private let titanium = Finish.solid(0xD9D3C8, roughness: 0.26, metalness: 1)
  private let anodised = Finish.solid(0x15161A, roughness: 0.40, metalness: 0.75)
  private let sensorMaterial = SCNMaterial(), coreMaterial = Finish.light(), lampMaterial = Finish.light(), tallyMaterial = Finish.light()
  private let wellMaterial = Finish.halo(), spillMaterial = Finish.halo(), lampGlowMaterial = Finish.halo(), tallyGlowMaterial = Finish.halo(), auraMaterial = Finish.halo()
  private var mood = MascotMood.idle
  private var lastClock: Double?
  private var lastSpark: Double?
  private var focusTurn = 0.0
  private var lastTravel = 0.0, lastAir = 0.0, lastWave = 0.0, waveStart = -10.0, wasHeld = false
  /// The hoop is light: it turns into the way of travel almost at once.
  private var hoopYaw = Spring(0, response: 0.20, dampingRatio: 0.8)
  /// The lens is heavy. Side to side on the upright pivots: it swings a few passes before it settles.
  private var swing = Spring(0, response: 0.62, dampingRatio: 0.2)
  /// Up and down on the side pivots.
  private var tilt = Spring(0, response: 0.34, dampingRatio: 0.32)
  /// Around its own axis: the hoop swings under the hand, the lens follows late and less.
  private var level = Spring(0, response: 0.6, dampingRatio: 0.45)
  /// The blades at a landing: half shut at once, then open again.
  private var flinch = Spring(0, response: 0.30, dampingRatio: 0.55)
  /// A hand takes hold: the aperture opens wide for a moment.
  private var grab = Spring(0, response: 0.45, dampingRatio: 0.8)
  private var hunt = Spring(0, response: 0.5, dampingRatio: 1)

  private static let bladeCount = 9, lampCount = 32
  /// The lens is drawn a little larger than it is built, to fill its frame.
  private static let size = 1.0
  /// The hole at the bottom of the baffle, the height of the lids' hinges, and the depths of the layers.
  private static let throat = 0.56, hinge = 0.67
  private static let glassBase = 0.335, lidDepth = 0.104, bladeDepth = 0.03

  // MARK: shapes

  /// A surface turned around the axis of the lens, which points at the viewer.
  /// The profile is (radius, depth) and runs around the solid: out across the back,
  /// forward along the side, in across the front, back down a bore. Give a point
  /// twice for a hard edge. The texture runs clockwise from twelve o'clock, and
  /// from the first point (the top of the image) to the last. `planar` lays the
  /// texture flat across a disc of that radius instead.
  private static func turned(_ profile: [(r: Double, z: Double)], around: Int = 128, planar: Double? = nil) -> SCNGeometry {
    let count = profile.count
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    for k in 0..<count {
      var a = max(0, k - 1), b = min(count - 1, k + 1)
      if k + 1 < count, profile[k + 1] == profile[k] { b = k } else if k > 0, profile[k - 1] == profile[k] { a = k }
      var dr = profile[b].r - profile[a].r, dz = profile[b].z - profile[a].z
      let length = max(1e-9, (dr * dr + dz * dz).squareRoot()); dr /= length; dz /= length
      for i in 0...around {
        let angle = 2 * Double.pi * Double(i) / Double(around)
        let s = sin(angle), c = cos(angle)
        positions.append(SCNVector3(profile[k].r * s, profile[k].r * c, profile[k].z))
        normals.append(SCNVector3(dz * s, dz * c, -dr))
        if let planar {
          coordinates.append(CGPoint(x: profile[k].r * s / (2 * planar) + 0.5, y: 0.5 - profile[k].r * c / (2 * planar)))
        } else {
          coordinates.append(CGPoint(x: Double(i) / Double(around), y: Double(k) / Double(max(1, count - 1))))
        }
      }
    }
    var indices: [Int32] = []
    let row = Int32(around + 1)
    for k in 0..<Int32(count - 1) { for i in 0..<Int32(around) {
      let a = k * row + i, b = a + 1, c = a + row, d = c + 1
      indices += [a, c, b, b, c, d]
    } }
    return Sculpt.geometry(positions, normals, coordinates, indices)
  }
  /// The profile of a lens surface: from the rim to the middle, `sag` proud of the rim.
  private static func dome(radius: Double, sag: Double, steps: Int = 28) -> [(r: Double, z: Double)] {
    let curve = (radius * radius + sag * sag) / (2 * sag), limit = asin(radius / curve)
    return (0...steps).map { step in
      let angle = limit * (1 - Double(step) / Double(steps))
      return (r: curve * sin(angle), z: sag - curve * (1 - cos(angle)))
    }
  }
  private static func part(_ geometry: SCNGeometry, _ material: SCNMaterial, in parent: SCNNode, z: Double = 0) -> SCNNode {
    geometry.firstMaterial = material
    let node = SCNNode(geometry: geometry)
    node.position = SCNVector3(0, 0, z)
    parent.addChildNode(node)
    return node
  }
  private static func plate(_ path: NSBezierPath, depth: CGFloat, _ material: SCNMaterial) -> SCNGeometry {
    path.flatness = 0.002
    let shape = SCNShape(path: path, extrusionDepth: depth)
    shape.firstMaterial = material
    return shape
  }
  /// One blade of the aperture. Its inner edge is an arc, so the opening stays round as it closes.
  private static func blade(_ material: SCNMaterial, bevel: SCNMaterial) -> SCNNode {
    let half = 0.46, radius = 0.56, depth = 0.52
    func edge(_ x: Double) -> Double { radius - (radius * radius - x * x).squareRoot() }
    let path = NSBezierPath(), line = NSBezierPath()
    path.move(to: NSPoint(x: -half, y: edge(-half)))
    for step in 1...18 { let x = -half + 2 * half * Double(step) / 18; path.line(to: NSPoint(x: x, y: edge(x))) }
    path.line(to: NSPoint(x: half * 0.9, y: -depth)); path.line(to: NSPoint(x: -half * 0.9, y: -depth)); path.close()
    // The ground edge of the blade: a fine bright line around the opening.
    line.move(to: NSPoint(x: -half, y: edge(-half)))
    for step in 1...18 { let x = -half + 2 * half * Double(step) / 18; line.line(to: NSPoint(x: x, y: edge(x))) }
    for step in 0...18 { let x = half - 2 * half * Double(step) / 18; line.line(to: NSPoint(x: x, y: edge(x) - 0.013)) }
    line.close()
    let node = SCNNode(geometry: plate(path, depth: 0.006, material))
    let rim = SCNNode(geometry: plate(line, depth: 0.003, bevel)); rim.position = SCNVector3(0, 0, 0.004)
    node.addChildNode(rim)
    return node
  }
  /// The edge of a lid at `x`, from its hinge. The upper lid hangs lowest in the middle, as a closed eye does.
  /// The lower lid is a hill, so that a smile leaves an arch of light.
  private static func lidEdge(upper: Bool, _ x: Double) -> Double { upper ? -hinge + 0.25 * x * x : hinge - 0.5 * x * x }
  private static func lid(upper: Bool, plate material: SCNMaterial, edge trim: SCNMaterial) -> SCNNode {
    let wide = 0.70, steps = 24, band = upper ? 0.026 : -0.026
    let body = NSBezierPath(), line = NSBezierPath()
    body.move(to: NSPoint(x: -wide, y: 0)); body.line(to: NSPoint(x: wide, y: 0))
    for step in 0...steps { let x = wide - 2 * wide * Double(step) / Double(steps); body.line(to: NSPoint(x: x, y: lidEdge(upper: upper, x))) }
    body.close()
    line.move(to: NSPoint(x: -wide, y: lidEdge(upper: upper, -wide)))
    for step in 1...steps { let x = -wide + 2 * wide * Double(step) / Double(steps); line.line(to: NSPoint(x: x, y: lidEdge(upper: upper, x))) }
    for step in 0...steps { let x = wide - 2 * wide * Double(step) / Double(steps); line.line(to: NSPoint(x: x, y: lidEdge(upper: upper, x) + band)) }
    line.close()
    let node = SCNNode(geometry: plate(body, depth: 0.004, material))
    let rim = SCNNode(geometry: plate(line, depth: 0.004, trim)); rim.position = SCNVector3(0, 0, 0.003)
    node.addChildNode(rim)
    return node
  }
  /// Half of the grip ring: fine teeth on the outside, as on a focus ring.
  private static func gripHalf(from start: Double, _ material: SCNMaterial) -> SCNGeometry {
    let teeth = 66, outer = 1.264, cut = 0.016, inner = 1.0, width = Double.pi / Double(teeth)
    let path = NSBezierPath()
    var first = true
    func point(_ angle: Double, _ radius: Double) {
      let p = NSPoint(x: radius * cos(angle), y: radius * sin(angle))
      if first { path.move(to: p); first = false } else { path.line(to: p) }
    }
    for tooth in 0..<teeth {
      let angle = start + Double(tooth) * width
      point(angle, outer); point(angle + 0.42 * width, outer); point(angle + 0.5 * width, outer - cut); point(angle + 0.92 * width, outer - cut)
    }
    point(start + .pi, outer)
    path.appendArc(withCenter: .zero, radius: inner, startAngle: (start + .pi) * 180 / .pi, endAngle: start * 180 / .pi, clockwise: true)
    path.close()
    return plate(path, depth: 0.35, material)
  }

  // MARK: paint

  private static func write(_ text: String, at x: CGFloat, baseline: CGFloat, size: CGFloat, color: NSColor, kern: CGFloat, in context: CGContext, wrap: CGFloat) {
    let string = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: color, .kern: kern])
    let width = string.size().width
    let before = NSGraphicsContext.current
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    for shift in [-wrap, 0, wrap] { string.draw(at: NSPoint(x: x - width / 2 + shift, y: baseline)) }
    NSGraphicsContext.current = before
  }
  /// The ring around the front glass: the name, engraved and filled with white paint.
  private static func nameRing() -> CGImage {
    MascotScene.image(width: 2048, height: 48) { context in
      context.setFillColor(MascotScene.color(0x131417).cgColor); context.fill(CGRect(x: 0, y: 0, width: 2048, height: 48))
      let ink = MascotScene.color(0xE9E5DC)
      write("CLAWDTIME   IRIS   1:1.4   f = 35", at: 0, baseline: 11, size: 24, color: ink, kern: 3.2, in: context, wrap: 2048)
      write("No. 0148     \u{2300} 52", at: 1024, baseline: 11, size: 24, color: ink, kern: 3.2, in: context, wrap: 2048)
      context.setFillColor(ink.cgColor)
      for x in [CGFloat(512), 1536] { context.fillEllipse(in: CGRect(x: x - 4, y: 20, width: 8, height: 8)) }
    }
  }
  /// The focus scale: ticks at the edge next to the index, distances above them.
  private static func scaleRing() -> CGImage {
    MascotScene.image(width: 2048, height: 64) { context in
      context.setFillColor(MascotScene.color(0x141518).cgColor); context.fill(CGRect(x: 0, y: 0, width: 2048, height: 64))
      let ink = MascotScene.color(0xE9E5DC), orange = MascotScene.color(0xFF8040)
      context.setFillColor(ink.cgColor)
      for tick in 0..<144 {
        let x = CGFloat(tick) * 2048 / 144, height: CGFloat = tick % 12 == 0 ? 24 : tick % 6 == 0 ? 17 : 10
        context.fill(CGRect(x: x - 1.5, y: 0, width: 3, height: height))
      }
      let metres = ["\u{221E}", "10", "5", "3", "2", "1.5", "1", "0.7", "0.5", "0.4", "0.3"]
      for (index, text) in metres.enumerated() {
        write(text, at: CGFloat(index) * 2048 / 12, baseline: 30, size: 25, color: ink, kern: 0.5, in: context, wrap: 2048)
      }
      let feet = ["30", "15", "10", "7", "5", "3.5", "2.5", "1.7", "1.3", "1"]
      for (index, text) in feet.enumerated() {
        write(text, at: (CGFloat(index) + 0.5) * 2048 / 12, baseline: 33, size: 19, color: orange, kern: 0.5, in: context, wrap: 2048)
      }
      write("m", at: 11 * 2048 / 12, baseline: 30, size: 22, color: ink, kern: 0, in: context, wrap: 2048)
      write("ft", at: 11.4 * 2048 / 12, baseline: 33, size: 19, color: orange, kern: 0, in: context, wrap: 2048)
    }
  }
  /// The groove of the lamps: a small dark lens over each one.
  private static func lampRing() -> CGImage {
    MascotScene.image(width: 1024, height: 24) { context in
      context.setFillColor(MascotScene.color(0x0C0D10).cgColor); context.fill(CGRect(x: 0, y: 0, width: 1024, height: 24))
      context.setFillColor(MascotScene.color(0x2B2D33).cgColor)
      for lamp in 0...lampCount {
        let x = CGFloat(lamp) * 1024 / CGFloat(lampCount)
        context.fillEllipse(in: CGRect(x: x - 4, y: 7, width: 8, height: 10))
      }
    }
  }
  /// What glows at the bottom of the lens: fibres of light around a bright middle, as in an eye.
  private static func fibres() -> CGImage {
    MascotScene.image(width: 256, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!, center = CGPoint(x: 128, y: 128)
      context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
      let glow = CGGradient(colorsSpace: space, colors: [NSColor(white: 1, alpha: 1).cgColor, NSColor(white: 0.8, alpha: 1).cgColor, NSColor(white: 0.42, alpha: 1).cgColor,
        NSColor(white: 0.2, alpha: 1).cgColor, NSColor(white: 0.03, alpha: 1).cgColor] as CFArray, locations: [0, 0.12, 0.36, 0.78, 1])!
      context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: 128, options: [])
      var seed: UInt64 = 7
      func unit() -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat((seed >> 33) & 0xFFFF) / 65535 }
      context.setLineCap(.round)
      for _ in 0..<260 {
        let angle = unit() * 2 * .pi, from = 20 + unit() * 34, to = from + 18 + unit() * 74
        let tone: NSColor = unit() < 0.45 ? .black : .white
        context.setStrokeColor(tone.withAlphaComponent(0.10 + unit() * 0.24).cgColor); context.setLineWidth(0.8 + unit() * 1.7)
        context.move(to: CGPoint(x: 128 + cos(angle) * from, y: 128 + sin(angle) * from))
        context.addLine(to: CGPoint(x: 128 + cos(angle) * to, y: 128 + sin(angle) * to))
        context.strokePath()
      }
      context.setStrokeColor(NSColor.black.withAlphaComponent(0.55).cgColor); context.setLineWidth(8)
      context.strokeEllipse(in: CGRect(x: 8, y: 8, width: 240, height: 240))
    }
  }
  /// The coating of the glass: what it gives back is violet in the middle and green at the rim.
  private static func coating(_ middle: UInt32, _ between: UInt32, _ rim: UInt32) -> CGImage {
    MascotScene.image(width: 128, height: 128) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!, center = CGPoint(x: 64, y: 64)
      context.setFillColor(MascotScene.color(rim).cgColor); context.fill(CGRect(x: 0, y: 0, width: 128, height: 128))
      let fade = CGGradient(colorsSpace: space, colors: [MascotScene.color(middle).cgColor, MascotScene.color(between).cgColor, MascotScene.color(rim).cgColor] as CFArray, locations: [0, 0.6, 1])!
      context.drawRadialGradient(fade, startCenter: center, startRadius: 0, endCenter: center, endRadius: 64, options: [])
    }
  }
  /// The room that the metal and the glass reflect: dark, with soft boxes of light.
  /// The lens faces the quarter mark of the image; its left is toward the middle.
  private static func room() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let walls = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x040506).cgColor, MascotScene.color(0x0E1014).cgColor, MascotScene.color(0x24272D).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(walls, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      func wash(_ center: CGPoint, _ radius: CGFloat, _ hex: UInt32, _ alpha: CGFloat) {
        let glow = CGGradient(colorsSpace: space, colors: [MascotScene.color(hex, alpha).cgColor, MascotScene.color(hex, 0).cgColor] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
      }
      func box(_ rect: CGRect, _ hex: UInt32, _ alpha: CGFloat, soft: CGFloat = 5) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: soft, color: MascotScene.color(hex, alpha).cgColor)
        context.setFillColor(MascotScene.color(hex, alpha).cgColor)
        context.addPath(CGPath(roundedRect: rect, cornerWidth: min(rect.width, rect.height) * 0.25, cornerHeight: min(rect.width, rect.height) * 0.25, transform: nil))
        context.fillPath()
        context.restoreGState()
      }
      // A grey wall in front of the lens gives the flat metal its tone.
      wash(CGPoint(x: 128, y: 138), 120, 0x41454E, 0.9)
      wash(CGPoint(x: 128, y: 52), 90, 0x3A2E24, 0.7)
      // The key box, up and to the left; a tall cool strip to the right; a band overhead.
      for (x, y) in [(CGFloat(160), CGFloat(146)), (174, 146), (160, 158), (174, 158)] {
        box(CGRect(x: x, y: y, width: 12, height: 10), 0xFFFFFF, 1, soft: 1.5)
      }
      // A round box to the right: it comes into the glass when the lens turns away from the window.
      context.saveGState()
      context.setShadow(offset: .zero, blur: 2, color: MascotScene.color(0xE6EEFF).cgColor)
      context.setFillColor(MascotScene.color(0xE6EEFF).cgColor)
      context.fillEllipse(in: CGRect(x: 88, y: 143, width: 18, height: 18))
      context.restoreGState()
      box(CGRect(x: 52, y: 120, width: 7, height: 56), 0xDDE8FF, 0.7, soft: 5)
      box(CGRect(x: 44, y: 216, width: 170, height: 16), 0xFFFFFF, 0.42, soft: 9)
      // Two strips behind the lens draw its edges out of a dark ground.
      box(CGRect(x: 310, y: 100, width: 14, height: 96), 0xBFD0FF, 1, soft: 8)
      box(CGRect(x: 452, y: 100, width: 14, height: 96), 0xFFD9B8, 1, soft: 8)
    }
  }

  init() {
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.room()
    scene.lightingEnvironment.intensity = 1.3
    scene.rootNode.addChildNode(root)

    // Light that spills behind the lens, in the color of the state.
    aura.geometry = SCNPlane(width: 4.6, height: 4.6); aura.geometry?.firstMaterial = auraMaterial
    aura.position = SCNVector3(0, 0, -1.2)
    root.addChildNode(aura)
    root.addChildNode(hoop)
    hoop.addChildNode(hoopBand); hoop.addChildNode(cradle)
    cradle.addChildNode(cradleBand); cradle.addChildNode(lens)

    let matte = Finish.solid(0x08090B, roughness: 0.85)
    let gunmetal = Finish.solid(0x50535B, roughness: 0.42, metalness: 0.9)
    let gloss = Finish.solid(0x0C0D10, roughness: 0.18, metalness: 0.2, coat: 1)

    // The front of the barrel, from the rim to the glass.
    _ = Self.part(Self.turned([(1.10, 0.34), (1.10, 0.425), (1.10, 0.425), (1.078, 0.45), (1.078, 0.45), (1.034, 0.45), (1.034, 0.45), (1.02, 0.44)]), titanium, in: lens)
    let name = Finish.solid(0xFFFFFF, roughness: 0.42, metalness: 0.6)
    name.diffuse.contents = Self.nameRing(); name.diffuse.mipFilter = .linear
    _ = Self.part(Self.turned([(1.02, 0.44), (0.90, 0.405)]), name, in: lens)
    _ = Self.part(Self.turned([(0.90, 0.405), (0.90, 0.388)]), anodised, in: lens)
    let groove = Finish.solid(0xFFFFFF, roughness: 0.2, metalness: 0.2, coat: 1)
    groove.diffuse.contents = Self.lampRing()
    _ = Self.part(Self.turned([(0.90, 0.388), (0.80, 0.388)]), groove, in: lens)
    _ = Self.part(Self.turned([(0.80, 0.388), (0.80, 0.345), (0.80, 0.345), (0.78, Self.glassBase)]), gloss, in: lens)
    // The baffle: fine black steps down to the throat, so that no light bounces back.
    var steps: [(r: Double, z: Double)] = [(0.78, Self.glassBase)]
    let count = 6
    for step in 1...count {
      let before = steps[steps.count - 1]
      let z = Self.glassBase - (Self.glassBase - 0.12) * Double(step) / Double(count)
      let r = 0.78 - (0.78 - Self.throat) * Double(step) / Double(count)
      steps += [before, (before.r, z), (before.r, z), (r, z)]
    }
    _ = Self.part(Self.turned(steps), matte, in: lens)
    _ = Self.part(Self.turned([(1.0, -0.22), (0, -0.22)]), matte, in: lens)
    // The flange at the back: a line of titanium outside the grip.
    _ = Self.part(Self.turned([(1.0, -0.24), (1.33, -0.24), (1.33, -0.24), (1.33, -0.175), (1.33, -0.175), (1.305, -0.15), (1.305, -0.15), (1.0, -0.15)]), titanium, in: lens)

    // The ring that turns: the focus scale on a cone that faces the viewer, and the grip.
    let scale = Finish.solid(0xFFFFFF, roughness: 0.42, metalness: 0.6)
    scale.diffuse.contents = Self.scaleRing(); scale.diffuse.mipFilter = .linear
    _ = Self.part(Self.turned([(1.264, 0.20), (1.10, 0.36)]), scale, in: focus)
    for start in [0.0, Double.pi] {
      let half = SCNNode(geometry: Self.gripHalf(from: start, anodised)); half.position = SCNVector3(0, 0, 0.025)
      focus.addChildNode(half)
    }
    lens.addChildNode(focus)
    // The index for the scale: one mark of Chert orange on the rim.
    let wedge = NSBezierPath()
    wedge.move(to: NSPoint(x: -0.034, y: 0.0)); wedge.line(to: NSPoint(x: 0.034, y: 0.0)); wedge.line(to: NSPoint(x: 0, y: 0.062)); wedge.close()
    let mark = Finish.solid(0xFF8040, roughness: 0.35); mark.emission.contents = MascotScene.color(0xFF8040); mark.emission.intensity = 0.35
    let index = SCNNode(geometry: Self.plate(wedge, depth: 0.012, mark)); index.position = SCNVector3(0, 1.022, 0.452)
    lens.addChildNode(index)

    // The lids, in the throat: they close from above and from below.
    for (node, upper) in [(topLid, true), (bottomLid, false)] {
      node.addChildNode(Self.lid(upper: upper, plate: gunmetal, edge: titanium))
      node.position = SCNVector3(0, upper ? Self.hinge : -Self.hinge, Self.lidDepth + (upper ? 0.008 : 0))
      lens.addChildNode(node)
    }

    // The inner group, which looks: the carrier, the blades, and the light behind them.
    let carrier = Finish.solid(0x17181C, roughness: 0.5, metalness: 0.6)
    _ = Self.part(Self.turned([(0.84, 0.095), (0.50, 0.095), (0.50, 0.095), (0.50, 0.08)]), carrier, in: group)
    let bladeMetal = Finish.solid(0x24262C, roughness: 0.32, metalness: 0.9)
    let bevel = Finish.solid(0x9A9892, roughness: 0.28, metalness: 1)
    for _ in 0..<Self.bladeCount {
      let pivot = SCNNode(), leaf = Self.blade(bladeMetal, bevel: bevel)
      // Each blade leans, so that it lies over the next one all the way round, and
      // each one catches the light at its own angle.
      leaf.eulerAngles.y = 0.09
      pivot.addChildNode(leaf); group.addChildNode(pivot); blades.append(pivot)
    }
    sensorMaterial.lightingModel = .constant; sensorMaterial.diffuse.contents = Self.fibres()
    sensor.geometry = Self.turned([(0.62, 0), (0, 0)], around: 64, planar: 0.62); sensor.geometry?.firstMaterial = sensorMaterial
    sensor.position = SCNVector3(0, 0, -0.10)
    let bead = SCNSphere(radius: 0.085); bead.segmentCount = 32; bead.firstMaterial = coreMaterial
    core.geometry = bead; core.position = SCNVector3(0, 0, -0.085)
    well.geometry = SCNPlane(width: 0.9, height: 0.9); well.geometry?.firstMaterial = wellMaterial; well.position = SCNVector3(0, 0, -0.06)
    spill.geometry = SCNPlane(width: 1.3, height: 1.3); spill.geometry?.firstMaterial = spillMaterial; spill.position = SCNVector3(0, 0, 0.10)
    for node in [sensor, core, well, spill] { group.addChildNode(node) }
    lens.addChildNode(group)

    // Glass: only what it reflects is drawn, over everything behind it.
    for (material, middle, between, rim) in [(glass, UInt32(0x5A4CA8), UInt32(0x4660A4), UInt32(0x2E8F78)), (innerGlass, 0x2E7A60, 0x6A5A30, 0x7A4420)] {
      material.lightingModel = .physicallyBased
      material.diffuse.contents = Self.coating(middle, between, rim)
      material.metalness.contents = 1.0; material.roughness.contents = 0.04
      material.blendMode = .add; material.writesToDepthBuffer = false
    }
    glass.emission.contents = MascotScene.sheenBand(); glass.emission.wrapT = .clampToBorder; glass.emission.intensity = 0
    let inner = Self.part(Self.turned(Self.dome(radius: Self.throat, sag: 0.05), planar: Self.throat), innerGlass, in: lens, z: 0.125)
    inner.renderingOrder = 19
    let front = Self.part(Self.turned(Self.dome(radius: 0.78, sag: 0.105), planar: 0.78), glass, in: lens, z: Self.glassBase)
    front.renderingOrder = 20

    // What strong light does in real glass: a streak across the bright point, and two
    // faint ghosts that slide to the other side of the axis as the eye turns.
    streak.geometry = SCNPlane(width: 1.3, height: 0.05); streak.geometry?.firstMaterial = streakMaterial
    ghostNear.geometry = SCNPlane(width: 0.26, height: 0.26); ghostNear.geometry?.firstMaterial = ghostNearMaterial
    ghostFar.geometry = SCNPlane(width: 0.20, height: 0.20); ghostFar.geometry?.firstMaterial = ghostFarMaterial
    ghostNearMaterial.multiply.contents = MascotScene.color(0x8F7BFF); ghostFarMaterial.multiply.contents = MascotScene.color(0x5CE0A8)
    for node in [streak, ghostNear, ghostFar] { node.renderingOrder = 22; lens.addChildNode(node) }

    // The lamps around the glass: a point of light that travels, and a level meter for the voice.
    let dot = SCNSphere(radius: 0.023); dot.segmentCount = 12; dot.firstMaterial = lampMaterial
    let shine = SCNPlane(width: 0.24, height: 0.24); shine.firstMaterial = lampGlowMaterial
    for lamp in 0..<Self.lampCount {
      let angle = 2 * Double.pi * Double(lamp) / Double(Self.lampCount)
      let node = SCNNode(geometry: dot), glow = SCNNode(geometry: shine)
      node.position = SCNVector3(0.85 * sin(angle), 0.85 * cos(angle), 0.39); node.scale = SCNVector3(1, 1, 0.4)
      glow.position = SCNVector3(0.85 * sin(angle), 0.85 * cos(angle), 0.40); glow.renderingOrder = 21
      lens.addChildNode(node); lens.addChildNode(glow); lamps.append(node); lampGlows.append(glow)
    }

    // The gimbal. The outer hoop carries the upright pivots and the tally light.
    func ring(_ middle: Double, _ half: Double, _ thick: Double, _ material: SCNMaterial, in parent: SCNNode) {
      let cut = half * 0.55, low = thick * 0.45
      _ = Self.part(Self.turned([(middle - half + cut, -thick), (middle + half - cut, -thick), (middle + half - cut, -thick), (middle + half, -low), (middle + half, -low),
        (middle + half, low), (middle + half, low), (middle + half - cut, thick), (middle + half - cut, thick), (middle - half + cut, thick), (middle - half + cut, thick),
        (middle - half, low), (middle - half, low), (middle - half, -low), (middle - half, -low), (middle - half + cut, -thick)], around: 160), material, in: parent)
    }
    /// A pivot: a pin along `axis`, a boss on the ring and a bright cap.
    func pivot(at place: SCNVector3, pinFrom start: Double, to end: Double, upright: Bool, in parent: SCNNode) {
      let pin = SCNNode(geometry: SCNCylinder(radius: 0.027, height: CGFloat(abs(end - start)))); pin.geometry?.firstMaterial = gunmetal
      let sign: Double = (upright ? Double(place.y) : Double(place.x)) < 0 ? -1 : 1, middle = sign * (start + end) / 2
      if upright { pin.position = SCNVector3(0, middle, 0) } else { pin.eulerAngles.z = .pi / 2; pin.position = SCNVector3(middle, 0, 0) }
      let boss = SCNNode(geometry: SCNCylinder(radius: 0.066, height: 0.066)); boss.geometry?.firstMaterial = anodised
      (boss.geometry as? SCNCylinder)?.radialSegmentCount = 40
      boss.eulerAngles.x = .pi / 2; boss.position = SCNVector3(place.x, place.y, 0.008)
      let cap = SCNNode(geometry: SCNCylinder(radius: 0.032, height: 0.08)); cap.geometry?.firstMaterial = titanium
      cap.eulerAngles.x = .pi / 2; cap.position = SCNVector3(place.x, place.y, 0.012)
      for node in [pin, boss, cap] { parent.addChildNode(node) }
    }
    let far = 1.56, near = 1.43
    ring(far, 0.025, 0.027, titanium, in: hoopBand)
    for side in [-1.0, 1.0] { pivot(at: SCNVector3(0, side * far, 0), pinFrom: near + 0.01, to: far - 0.015, upright: true, in: hoopBand) }
    // The cradle: the inner ring. The lens tips in it on the two side pivots, which reach well into the barrel.
    let steel = Finish.solid(0xA6A198, roughness: 0.30, metalness: 1)
    ring(near, 0.020, 0.022, steel, in: cradleBand)
    for side in [-1.0, 1.0] { pivot(at: SCNVector3(side * near, 0, 0), pinFrom: 1.20, to: near - 0.012, upright: false, in: cradleBand) }
    let house = SCNNode(geometry: SCNCylinder(radius: 0.075, height: 0.08)); house.geometry?.firstMaterial = anodised
    (house.geometry as? SCNCylinder)?.radialSegmentCount = 40
    let place = 0.52
    house.eulerAngles.x = .pi / 2; house.position = SCNVector3(far * sin(place), far * cos(place), 0.014)
    let bulb = SCNSphere(radius: 0.05); bulb.firstMaterial = tallyMaterial
    tally.geometry = bulb; tally.scale = SCNVector3(1, 1, 0.6); tally.position = SCNVector3(far * sin(place), far * cos(place), 0.055)
    tallyGlow.geometry = SCNPlane(width: 0.6, height: 0.6); tallyGlow.geometry?.firstMaterial = tallyGlowMaterial
    tallyGlow.position = SCNVector3(far * sin(place), far * cos(place), 0.08); tallyGlow.renderingOrder = 21
    for node in [house, tally, tallyGlow] { hoopBand.addChildNode(node) }

    for node in [Stage.light(.ambient, 0xE8ECFF, 160),
                 Stage.light(.directional, 0xFFF7EE, 900, angles: SCNVector3(-0.75, -0.55, 0)),
                 Stage.light(.directional, 0xBFD0FF, 800, angles: SCNVector3(-0.1, -2.4, 0)),
                 Stage.light(.directional, 0xFFD9B8, 800, angles: SCNVector3(0.3, 2.4, 0))] { scene.rootNode.addChildNode(node) }
    scene.rootNode.addChildNode(camera)
    Stage.bloom(camera, intensity: 0.7, threshold: 0.8, radius: 9)
    set(mood: .idle)
    apply(MascotPose())
  }

  /// The light carries the state: warm white at rest, blue at work, amber when it
  /// needs the person, red while the screen is shared. Offline it is metal and glass only.
  func set(mood: MascotMood) {
    self.mood = mood
    let tint: UInt32
    switch mood {
    case .idle, .sleepy: tint = 0xFFD9A8
    case .working: tint = 0x6F9CFF
    case .attention: tint = 0xFFB228
    case .sharing: tint = 0xFF5446
    case .asleep, .offline: tint = 0x8A857D
    }
    let color = MascotScene.color(tint), bright = color.blended(withFraction: 0.55, of: .white) ?? color
    sensorMaterial.multiply.contents = color
    coreMaterial.diffuse.contents = bright
    lampMaterial.diffuse.contents = color.blended(withFraction: 0.3, of: .white) ?? color
    tallyMaterial.diffuse.contents = color.blended(withFraction: 0.2, of: .white) ?? color
    for material in [wellMaterial, spillMaterial, lampGlowMaterial, tallyGlowMaterial, auraMaterial, streakMaterial] { material.multiply.contents = color }
    let off = mood == .offline
    titanium.diffuse.contents = MascotScene.color(off ? 0x8E8A84 : 0xD9D3C8); titanium.roughness.contents = off ? 0.55 : 0.26
    anodised.roughness.contents = off ? 0.6 : 0.40
  }

  func apply(_ pose: MascotPose) {
    let dt = lastClock.map { max(0, min(0.1, pose.clock - $0)) } ?? 0
    lastClock = pose.clock
    let lit = mood == .offline ? 0.0 : 1.0, glow = max(0, min(1, pose.glow))

    let travel = max(-1, min(1, pose.travel)), gait = max(0, min(1, pose.gait))
    let air = max(0, min(1, pose.air)), wave = max(0, min(1, pose.wave))

    // What the pointer asks of the eye. The pose also turns the body into its way of
    // travel, by half a radian at full speed: that part belongs to the hoop.
    let turn = 0.4 * travel
    let asked = pose.yaw * 0.8 - turn
    // It never looks quite straight ahead: it rests a little turned, and it scans slowly.
    // When it follows the pointer or is carried, that takes over.
    let free = max(0, 1 - (abs(asked) + abs(pose.pitch)) / 0.3) * (1 - gait)
    let aimYaw = asked + free * (-0.16 + 0.07 * sin(pose.clock * 0.45))
    let aimPitch = pose.pitch * 0.9 + free * (-0.07 + 0.04 * sin(pose.clock * 0.33 + 1.3))

    // What just happened: a greeting begins, the body lands, a hand takes hold.
    if wave > 0.001 && lastWave <= 0.001 { waveStart = pose.clock }
    let waved = pose.clock - waveStart
    if dt > 0 && lastAir > 0.05 && air <= 0.001 { flinch.value = 0.55 }
    if pose.held && !wasHeld { grab.value = 1 }
    lastWave = wave; lastAir = air; wasHeld = pose.held

    // The hoop leads. The lens hangs back from a start, swings on after a stop, and rocks with each step.
    hoopYaw.target = 0.3 * aimYaw + 1.1 * turn
    swing.target = -0.35 * travel + 0.12 * gait * pose.stride
    tilt.target = -0.38 * air + 0.06 * gait * (2 * abs(pose.stride) - 1)
    level.target = 0.5 * pose.roll
    hunt.target = mood == .working ? 1 : 0
    flinch.target = 0; grab.target = 0
    if dt > 0 {
      // A change of speed pushes the heavy lens the other way: it hangs back from a
      // start and swings on past level after a stop. A sudden turn, as at the edge
      // of the screen, also makes the blades wince.
      swing.velocity -= (travel - lastTravel) * 6
      if abs(travel - lastTravel) > 0.18 { flinch.value = max(flinch.value, 0.4) }
      hoopYaw.step(dt); swing.step(dt); tilt.step(dt); level.step(dt); hunt.step(dt); flinch.step(dt); grab.step(dt)
    } else {
      hoopYaw.snap(); swing.snap(); tilt.snap(); level.snap(); hunt.snap(); flinch.snap(); grab.snap()
    }
    lastTravel = travel

    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    let size = Self.size * pose.scale
    root.scale = SCNVector3(size, size, size)
    let hoopPitch = aimPitch * 0.25, hoopRoll = pose.roll + pose.ringWobble * 1.2
    hoop.eulerAngles = SCNVector3(hoopPitch, hoopYaw.value, hoopRoll)
    // A greeting: the lens nods from side to side three times.
    let nod = 0.32 * wave * sin(2 * .pi * 3 * waved)
    // The upright pivots turn freely: the hoop's turn does not carry the lens with it.
    let side = max(-1.15, min(1.15, aimYaw + swing.value + nod - hoopYaw.value))
    cradle.eulerAngles = SCNVector3(0, side, 0)
    let tip = max(-0.7, min(0.7, aimPitch + tilt.value - hoopPitch))
    lens.eulerAngles = SCNVector3(tip, 0, level.value - hoopRoll)
    // Where the lens points in the end, for the light in its glass.
    let yaw = hoopYaw.value + side, pitch = hoopPitch + tip
    // Metal and glass give only a little. The rings give more.
    let give = 1 + (pose.squash - 1) * 0.3, wide = 1 / max(0.3, give).squareRoot()
    lens.scale = SCNVector3(wide, give, wide)
    let flex = 1 + (pose.squash - 1) * 0.55, bend = 1 + (pose.squash - 1) * 0.42
    hoopBand.scale = SCNVector3(1 / max(0.3, flex).squareRoot(), flex, 1)
    cradleBand.scale = SCNVector3(1 / max(0.3, bend).squareRoot(), bend, 1)

    // The focus ring: it creeps at rest, and hunts back and forth while agents work.
    // Carried or thrown, it spins with the speed, the way a ring spins when it is brushed.
    if let last = lastSpark {
      var delta = pose.sparkAngle - last
      if delta < -Double.pi { delta += 2 * .pi } else if delta > .pi { delta -= 2 * .pi }
      focusTurn += delta * 0.22
    } else { focusTurn = pose.sparkAngle * 0.22 }
    lastSpark = pose.sparkAngle
    focusTurn += travel * 9 * dt
    focus.eulerAngles.z = -(focusTurn + hunt.value * 0.5 * sin(pose.sparkAngle))

    // The aperture: the blades swing in as the eye closes.
    let open = max(0, min(1.3, pose.eyeOpen))
    let squint = max(0, min(1, pose.squint)), smile = max(0, min(1, pose.smile))
    let breath = 1 + 0.035 * sin(pose.clock * 1.3)
    // Off the ground and in a hand it opens wide. At a landing the blades snap half shut and open again.
    let extra = 0.07 * squint + 0.10 * air + 0.06 * max(0, grab.value) + (pose.held ? 0.03 : 0)
    let reach = min(0.47, (0.015 + 0.345 * min(1, open) + 0.34 * max(0, open - 1)) * breath + extra) * max(0.35, min(1.08, 1 - flinch.value))
    let twist = (1 - reach / 0.46) * 0.55
    for (index, blade) in blades.enumerated() {
      let angle = 2 * Double.pi * Double(index) / Double(Self.bladeCount) + twist
      blade.eulerAngles.z = angle
      blade.position = SCNVector3(reach * sin(angle), -reach * cos(angle), Self.bladeDepth)
    }
    // The lids: the upper one comes down for a blink and for sleep, the lower one comes up for a smile.
    let close = max(0, min(1, (0.9 - pose.eyeOpen) / 0.88)), shut = max(0, (close - 0.6) / 0.4)
    // At rest the upper lid shows a little, as on a relaxed eye. Wide open, it is gone.
    // It rides up when the eye looks up and comes down when it looks down.
    let follow = pose.pupilY > 0 ? pose.pupilY * 0.13 : pose.pupilY * 0.08
    let top = pose.eyeOpen >= 0.9 ? min(0.62, 0.47 + (pose.eyeOpen - 1) * 0.75 + follow) : 0.395 - 0.815 * close
    // The lower lid shows with a smile and moves with the voice, which lifts the smile.
    let bottom = max(-0.62 + 0.36 * shut, -0.62 + 0.72 * squint, -0.62 + 0.34 * max(0, smile - 0.35) / 0.65)
    topLid.scale.y = (Self.hinge - top) / Self.hinge
    bottomLid.scale.y = (Self.hinge + bottom) / Self.hinge

    // The inner group looks where the eyes of the stone would look.
    // In a smile the light rides up into the arch that the lower lid leaves.
    // Carried, the eye looks along its way: the body swings behind, the gaze leads.
    let aim = (x: max(-0.21, min(0.21, pose.pupilX * 0.19 + 0.17 * travel)), y: pose.pupilY * 0.15 * (1 - squint) + 0.27 * squint)
    group.position = SCNVector3(aim.x, aim.y, 0)
    group.eulerAngles = SCNVector3(-pose.pupilY * 0.10, pose.pupilX * 0.12, 0)
    sensor.opacity = lit * (0.30 + 0.70 * glow)
    core.opacity = lit; core.scale = SCNVector3(0.8 + 0.5 * glow, 0.8 + 0.5 * glow, 0.35)
    well.opacity = lit * (0.12 + 0.40 * glow)
    spill.opacity = lit * (0.05 + 0.16 * glow)
    aura.opacity = lit * (0.05 + 0.22 * glow)
    aura.scale = SCNVector3(pose.scale, pose.scale, 1)
    // Where the bright point shows on the front glass: it sits half a unit behind it.
    let seen = (x: aim.x - 0.5 * tan(yaw), y: aim.y + 0.5 * tan(pitch))
    let flare = lit * max(0, glow - 0.62) * min(1, open) * (1 - close)
    streak.position = SCNVector3(seen.x, seen.y, 0.452); streak.opacity = CGFloat(flare * 1.5)
    ghostNear.position = SCNVector3(-0.45 * seen.x, -0.45 * seen.y, 0.454); ghostNear.opacity = CGFloat(lit * (0.10 + 0.5 * flare) * (1 - close))
    ghostFar.position = SCNVector3(-0.95 * seen.x, -0.95 * seen.y, 0.456); ghostFar.opacity = CGFloat(lit * (0.08 + 0.30 * flare) * (1 - close))

    // The lamps: one point of light goes round with the spark. A voice fills them from the bottom up.
    let voice = max(0, min(1, pose.voice))
    for (index, lamp) in lamps.enumerated() {
      let angle = 2 * Double.pi * Double(index) / Double(Self.lampCount)
      let chase = pow(max(0, cos(angle - pose.sparkAngle)), 14) * (0.35 + 0.65 * glow)
      let height = abs(atan2(sin(angle - .pi), cos(angle - .pi))) / .pi
      let level = voice * (0.80 + 0.20 * sin(pose.clock * 19 + Double(index % 2) * 1.3))
      let meter = voice > 0.02 ? max(0, min(1, (level - height) * 9 + 0.5)) : 0
      // A greeting: one bright point runs once around the ring.
      let run = wave > 0.001 ? pow(max(0, cos(angle - 2 * .pi * min(1, max(0, waved / 0.95)))), 6) * min(1, wave * 3) : 0
      let bright = CGFloat(lit * max(chase * (1 - min(1, voice * 2)) * (1 - min(1, wave * 3)), meter, run))
      lamp.opacity = bright; lampGlows[index].opacity = bright * 0.8
    }
    tally.opacity = CGFloat(lit * (0.35 + 0.65 * glow)); tallyGlow.opacity = CGFloat(lit * (0.15 + 0.75 * glow))

    if pose.sheen >= 0 {
      // The sheen of the mark is a glint that crosses the front glass.
      glass.emission.intensity = CGFloat(0.5 * sin(pose.sheen * .pi))
      // The band is half as wide as on the stone: the texture is stretched, then moved.
      let stretch = 2.0
      let move = SCNMatrix4Mult(SCNMatrix4MakeScale(1, CGFloat(stretch), 1), SCNMatrix4MakeTranslation(0, CGFloat(0.8 - pose.sheen * (stretch + 0.9)), 0))
      glass.emission.contentsTransform = SCNMatrix4Mult(SCNMatrix4MakeRotation(0.5, 0, 0, 1), move)
    } else if glass.emission.intensity != 0 { glass.emission.intensity = 0 }
  }
}
