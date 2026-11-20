import AppKit
import SceneKit
import TaskPanelCore
import simd

/// Orb: a ball droid. A titanium dome sits over a graphite bowl, with a belt of
/// dark glass and a line of light between them. Two small robotic eyes are the
/// face. It hovers over a thin ring, and it shows the state in its light.
final class OrbScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  /// Moves up and down and grows: the whole droid and what floats with it.
  private let root = SCNNode()
  /// Turns to look: the dome, the eyes, the ears and the belt.
  private let body = SCNNode()
  /// The lower shell. It follows a turn of the dome late.
  private let bowl = SCNNode()
  private var eyes: [RoboEye] = []
  private var caps: [SCNNode] = []
  private var earRings: [SCNNode] = []
  private var bars: [SCNNode] = []
  private let hoverLine = SCNNode()
  private let hover = SCNNode(), underGlow = SCNNode()
  private let orbit = SCNNode(), mote = SCNNode(), moteHalo = SCNNode()
  private let strip = SCNNode(), crown = SCNNode()

  private let dome = SCNMaterial(), shell = SCNMaterial(), steel = SCNMaterial()
  private let stripLight = SCNMaterial(), lamp = Finish.light(), earLight = Finish.light(), hoverLight = Finish.light()
  private let moteLight = Finish.light(), moteGlow = Finish.halo(), glow = Finish.halo()

  private let spun = OrbScene.spunImage()
  private var mood = MascotMood.idle
  private var lastClock: Double?
  private var lastSquint = 0.0
  private var bowlYaw = Spring(0, response: 0.55, dampingRatio: 0.55)
  private var ringLift = Spring(0, response: 0.42, dampingRatio: 0.5)
  private var ringTilt = Spring(0, response: 0.5, dampingRatio: 0.45)
  private var ringSway = Spring(0, response: 0.5, dampingRatio: 0.45)
  private var kick = Spring(0, response: 0.36, dampingRatio: 0.32)
  private var sink = Spring(0, response: 0.9, dampingRatio: 1)

  private static let radius: CGFloat = 1.15
  /// Degrees of latitude where the dome ends and where the bowl begins. The belt is between them.
  private static let domeEdge = -9.0, bowlEdge = -19.0
  private static let center: CGFloat = 0.22
  private static let eyeAim = SIMD3<Float>(0.33, 0.30, 1)
  private static let eyeRadius: CGFloat = 0.2
  /// The ears sit a little forward of the sides, so their rings show from the front.
  private static let earLongitude = 72.0

  /// A part of a ball as a profile for a lathe, from one latitude up to another.
  private static func arc(from start: Double, to end: Double, steps: Int, scale: Double = 1) -> [(r: Double, y: Double)] {
    (0...steps).map { step in
      let latitude = (start + (end - start) * Double(step) / Double(steps)) * .pi / 180
      return (r: max(0, Double(radius) * scale * cos(latitude)), y: Double(radius) * scale * sin(latitude))
    }
  }
  /// A point on the ball: longitude 0 is the front, positive is the viewer's right.
  private static func surface(longitude: Double, latitude: Double, lift: Double = 0) -> SIMD3<Float> {
    let a = longitude * .pi / 180, b = latitude * .pi / 180, r = Double(radius) + lift
    return SIMD3(Float(r * cos(b) * sin(a)), Float(r * sin(b)), Float(r * cos(b) * cos(a)))
  }

  /// Draws on a shell texture in degrees. The lathe wraps the image around the
  /// ball from right to left, so `x` runs backward and text is drawn mirrored.
  private struct Chart {
    let context: CGContext
    let width: CGFloat, height: CGFloat
    let low: CGFloat, high: CGFloat
    func x(_ longitude: CGFloat) -> CGFloat { (90 - longitude) / 360 * width }
    func y(_ latitude: CGFloat) -> CGFloat { (latitude - low) / (high - low) * height }
    var perDegree: CGFloat { width / 360 }
    /// Runs the drawing three times, so a shape that crosses the edge of the image wraps.
    func wrapped(_ draw: () -> Void) {
      for shift in [-width, 0, width] {
        context.saveGState(); context.translateBy(x: shift, y: 0); draw(); context.restoreGState()
      }
    }
    /// A panel line: a dark groove with a thin light edge under it.
    func groove(_ path: CGPath, width line: CGFloat = 3.2, dark: UInt32 = 0x2E3138) {
      wrapped {
        context.saveGState()
        context.translateBy(x: -1.7, y: -1.7)
        context.addPath(path); context.setStrokeColor(NSColor(white: 1, alpha: 0.42).cgColor); context.setLineWidth(line * 0.5); context.strokePath()
        context.restoreGState()
        context.addPath(path); context.setStrokeColor(MascotScene.color(dark).cgColor); context.setLineWidth(line); context.strokePath()
      }
    }
    func box(_ west: CGFloat, _ east: CGFloat, _ south: CGFloat, _ north: CGFloat, corner: CGFloat) -> CGPath {
      let rect = CGRect(x: x(east), y: y(south), width: x(west) - x(east), height: y(north) - y(south))
      let r = min(corner * perDegree, min(rect.width, rect.height) / 2)
      return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    }
    func line(_ a: (CGFloat, CGFloat), _ b: (CGFloat, CGFloat)) -> CGPath {
      let path = CGMutablePath(); path.move(to: CGPoint(x: x(a.0), y: y(a.1))); path.addLine(to: CGPoint(x: x(b.0), y: y(b.1)))
      return path
    }
    /// A round mark that stays round on the ball: wider on the image the nearer it is to a pole.
    func disc(_ longitude: CGFloat, _ latitude: CGFloat, degrees: CGFloat) -> CGPath {
      let wide = degrees * perDegree / max(0.2, cos(latitude * .pi / 180)), tall = degrees * height / (high - low)
      return CGPath(ellipseIn: CGRect(x: x(longitude) - wide, y: y(latitude) - tall, width: wide * 2, height: tall * 2), transform: nil)
    }
  }

  /// The dome: brushed titanium, a darker plate behind the eyes, a few panel lines, a label and one orange tag.
  private static func domeImage() -> CGImage {
    let w = 2048, h = 576
    return MascotScene.image(width: w, height: h) { context in
      let chart = Chart(context: context, width: CGFloat(w), height: CGFloat(h), low: CGFloat(domeEdge), high: 90)
      context.setFillColor(MascotScene.color(0xB9BDC4).cgColor); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
      // The crown is one tone lighter, as a separate pressed part.
      context.setFillColor(MascotScene.color(0xC6CAD0).cgColor); context.fill(CGRect(x: 0, y: chart.y(58), width: CGFloat(w), height: CGFloat(h)))
      // The plate that carries the eyes.
      let plate = chart.box(-36.5, 36.5, 2.5, 30.5, corner: 14)
      chart.wrapped { context.addPath(plate); context.setFillColor(MascotScene.color(0x4B4F58).cgColor); context.fillPath() }
      chart.groove(plate, width: 3.4, dark: 0x25272C)
      chart.groove(chart.line((-180, 58), (180, 58)))
      for longitude in [CGFloat(earLongitude), CGFloat(-earLongitude), 180] { chart.groove(chart.line((longitude, CGFloat(domeEdge)), (longitude, 58))) }
      // Small screws where panels meet.
      for (longitude, latitude) in [(CGFloat(50), CGFloat(51)), (-50, 51), (126, 51), (-126, 51)] {
        let screw = chart.disc(longitude, latitude, degrees: 1.25)
        chart.wrapped {
          context.addPath(screw); context.setFillColor(MascotScene.color(0x5D6169).cgColor); context.fillPath()
          context.addPath(chart.disc(longitude, latitude, degrees: 0.5)); context.setFillColor(MascotScene.color(0x24262B).cgColor); context.fillPath()
        }
      }
      // One orange tag, to the left of the level lamps.
      let tag = chart.box(-31, -23.5, -6.6, -3.4, corner: 0.8)
      context.addPath(tag); context.setFillColor(MascotScene.color(0xFF8040).cgColor); context.fillPath()
      // The label, engraved to the right of the lamps. The image is mirrored on the ball, so the text is too.
      let text = NSAttributedString(string: "CLAWDTIME  ORB\u{2009}01", attributes: [
        .font: NSFont.systemFont(ofSize: 15, weight: .bold), .kern: 2.2, .foregroundColor: MascotScene.color(0x3C4047)])
      let line = CTLineCreateWithAttributedString(text)
      context.saveGState()
      context.translateBy(x: chart.x(22), y: chart.y(-6.4)); context.scaleBy(x: -1, y: 1)
      context.textPosition = .zero; CTLineDraw(line, context)
      context.restoreGState()
    }
  }
  /// The bowl: graphite, with one seam and two rows of vent slots.
  private static func bowlImage() -> CGImage {
    let w = 2048, h = 448
    return MascotScene.image(width: w, height: h) { context in
      let chart = Chart(context: context, width: CGFloat(w), height: CGFloat(h), low: -90, high: CGFloat(bowlEdge))
      context.setFillColor(MascotScene.color(0x3B3E46).cgColor); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
      context.setFillColor(MascotScene.color(0x30333A).cgColor); context.fill(CGRect(x: 0, y: 0, width: CGFloat(w), height: chart.y(-54)))
      chart.groove(chart.line((-180, -54), (180, -54)), dark: 0x141518)
      for side in [CGFloat(-1), 1] {
        for index in 0..<9 {
          let longitude = side * (26 + CGFloat(index) * 6)
          let slot = chart.box(longitude - 1.1, longitude + 1.1, -44, -29, corner: 1.1)
          chart.wrapped { context.addPath(slot); context.setFillColor(MascotScene.color(0x0E0F12).cgColor); context.fillPath() }
        }
      }
      for longitude in [CGFloat(earLongitude), CGFloat(-earLongitude), 180] { chart.groove(chart.line((longitude, -54), (longitude, CGFloat(bowlEdge))), dark: 0x141518) }
    }
  }
  /// The light that runs around the belt: a row of small lamps, dim, with one bright point and its tail.
  private static func cometImage() -> CGImage {
    let width = 960, lamps = 96
    return MascotScene.image(width: width, height: 4) { context in
      context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: 4))
      let pitch = width / lamps
      for lampIndex in 0..<lamps {
        let x = lampIndex * pitch, head = width * 5 / 8
        let behind = Double((head - x + width) % width), ahead = Double((x - head + width) % width)
        let level = min(1, 0.13 + 0.87 * exp(-behind / 150) + 0.87 * exp(-ahead / 12))
        context.setFillColor(NSColor(white: CGFloat(level), alpha: 1).cgColor)
        context.fill(CGRect(x: x + 1, y: 0, width: pitch - 3, height: 4))
      }
    }
  }
  /// Fine rings of rougher and smoother metal, as a lathe leaves them: the dome reads as spun titanium.
  private static func spunImage() -> CGImage {
    MascotScene.image(width: 4, height: 512) { context in
      var seed: UInt64 = 0x0B5E55ED
      var last: CGFloat = 0.5
      for y in 0..<512 {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        // Each ring is near its neighbour, so the grain is fine and not scratched.
        last = last * 0.55 + 0.45 * CGFloat((seed >> 33) & 0xFFFF) / 65535
        context.setFillColor(NSColor(white: 0.29 + 0.10 * last, alpha: 1).cgColor)
        context.fill(CGRect(x: 0, y: y, width: 4, height: 1))
      }
    }
  }
  /// What the metal reflects: a dark studio with one wide box overhead and a tall strip on each side.
  private static func studio() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let room = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x202228).cgColor, MascotScene.color(0x3A3D45).cgColor, MascotScene.color(0x8E939C).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(room, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      func box(_ rect: CGRect, _ hex: UInt32, _ strength: CGFloat, blur: CGFloat) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: blur, color: MascotScene.color(hex, strength).cgColor)
        context.setFillColor(MascotScene.color(hex, strength).cgColor); context.fill(rect)
        context.restoreGState()
      }
      box(CGRect(x: 0, y: 214, width: 512, height: 30), 0xFFFFFF, 1, blur: 24)
      for x in [CGFloat(40), 168, 296, 424] { box(CGRect(x: x, y: 78, width: 20, height: 112), 0xF4F7FF, 0.95, blur: 14) }
      box(CGRect(x: 0, y: 18, width: 512, height: 10), 0xFFD9B8, 0.35, blur: 18)
    }
  }

  init() {
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.studio()
    scene.lightingEnvironment.intensity = 1.35
    scene.rootNode.addChildNode(root)
    body.position = SCNVector3(0, Self.center, 0)
    root.addChildNode(body)
    let r = Self.radius

    // A lamp shows one face only. Seen through itself when it dims, it would show two tones.
    for material in [lamp, earLight, hoverLight, moteLight] { material.isDoubleSided = false }

    // The soft light under it sits behind everything.
    underGlow.geometry = SCNPlane(width: 2.6, height: 1.3); underGlow.geometry?.firstMaterial = glow
    underGlow.position = SCNVector3(0, Self.center - 1.42, -0.4)
    root.addChildNode(underGlow)

    // Dome and bowl.
    dome.lightingModel = .physicallyBased
    dome.diffuse.contents = Self.domeImage()
    dome.metalness.contents = 0.9; dome.roughness.contents = spun
    dome.clearCoat.contents = 0.3; dome.clearCoatRoughness.contents = 0.14
    dome.emission.contents = MascotScene.sheenBand(); dome.emission.wrapT = .clampToBorder; dome.emission.intensity = 0
    let top = Sculpt.lathe(Self.arc(from: Self.domeEdge, to: 90, steps: 56), around: 128)
    top.firstMaterial = dome
    body.addChildNode(SCNNode(geometry: top))
    shell.lightingModel = .physicallyBased
    shell.diffuse.contents = Self.bowlImage()
    shell.metalness.contents = 0.85; shell.roughness.contents = 0.42
    let low = Sculpt.lathe(Self.arc(from: -90, to: Self.bowlEdge, steps: 44), around: 128)
    low.firstMaterial = shell
    bowl.geometry = low
    body.addChildNode(bowl)

    // The belt: dark glass set back between two steel lips, with a line of light in it.
    let glass = Finish.solid(0x07080B, roughness: 0.08, coat: 1, coatRoughness: 0.04)
    let channel = Sculpt.lathe(Self.arc(from: Self.bowlEdge - 1, to: Self.domeEdge + 1, steps: 8, scale: 0.972), around: 128)
    channel.firstMaterial = glass
    body.addChildNode(SCNNode(geometry: channel))
    steel.lightingModel = .physicallyBased
    steel.diffuse.contents = MascotScene.color(0xDDE0E5); steel.metalness.contents = 1; steel.roughness.contents = 0.24
    for edge in [Self.domeEdge, Self.bowlEdge] {
      let latitude = edge * .pi / 180
      let lip = SCNTorus(ringRadius: r * CGFloat(cos(latitude)) + 0.003, pipeRadius: 0.019)
      lip.ringSegmentCount = 128; lip.pipeSegmentCount = 12; lip.firstMaterial = steel
      let node = SCNNode(geometry: lip); node.position = SCNVector3(0, r * CGFloat(sin(latitude)), 0)
      body.addChildNode(node)
    }
    let middle = (Self.domeEdge + Self.bowlEdge) / 2 * .pi / 180
    let beltRadius = Double(r) * cos(middle) * 0.99, beltHeight = Double(r) * sin(middle)
    stripLight.lightingModel = .constant
    stripLight.diffuse.contents = Self.cometImage(); stripLight.diffuse.wrapS = .repeat
    stripLight.blendMode = .add; stripLight.writesToDepthBuffer = false; stripLight.isDoubleSided = true
    let band = Sculpt.lathe([(r: beltRadius, y: beltHeight - 0.021), (r: beltRadius, y: beltHeight + 0.021)], around: 128)
    band.firstMaterial = stripLight
    strip.geometry = band
    body.addChildNode(strip)

    // Eyes: two small pods on the plate, turned to face out from the middle of the ball.
    let pod = Finish.solid(0x15171B, roughness: 0.3, metalness: 0.9)
    let lid = Finish.solid(0x9A9EA6, roughness: 0.34, metalness: 0.9)
    for side in [Float(-1), 1] {
      let eye = RoboEye(radius: Self.eyeRadius, housing: pod, lid: lid)
      let direction = simd_normalize(SIMD3<Float>(side * Self.eyeAim.x, Self.eyeAim.y, Self.eyeAim.z))
      eye.node.simdPosition = direction * (Float(r) + 0.006)
      eye.node.simdOrientation = simd_quatf(from: SIMD3(0, 0, 1), to: direction)
      // A fine steel ring around each pod, as on a watch.
      let bezel = SCNTorus(ringRadius: Self.eyeRadius * 1.25, pipeRadius: 0.011); bezel.ringSegmentCount = 64; bezel.firstMaterial = steel
      let bezelNode = SCNNode(geometry: bezel); bezelNode.eulerAngles.x = .pi / 2; bezelNode.position = SCNVector3(0, 0, -0.012)
      eye.node.addChildNode(bezelNode)
      body.addChildNode(eye.node)
      eyes.append(eye)
    }

    // On the crown: a small sensor of dark glass in a steel rim, with a ring of light.
    let puck = Sculpt.lathe([(r: 0.2, y: Double(r) - 0.035), (r: 0.2, y: Double(r) + 0.014), (r: 0.2, y: Double(r) + 0.014),
      (r: 0.165, y: Double(r) + 0.036), (r: 0.165, y: Double(r) + 0.036), (r: 0, y: Double(r) + 0.042)], around: 64)
    puck.firstMaterial = glass
    body.addChildNode(SCNNode(geometry: puck))
    let rim = SCNTorus(ringRadius: 0.2, pipeRadius: 0.012); rim.ringSegmentCount = 64; rim.firstMaterial = steel
    let rimNode = SCNNode(geometry: rim); rimNode.position = SCNVector3(0, r + 0.012, 0)
    body.addChildNode(rimNode)
    let crownRing = SCNTorus(ringRadius: 0.105, pipeRadius: 0.009); crownRing.ringSegmentCount = 48; crownRing.firstMaterial = earLight
    crown.geometry = crownRing; crown.position = SCNVector3(0, r + 0.04, 0)
    body.addChildNode(crown)

    // Level lamps: a short row of bars under the eyes. Each sits in a dark window.
    let window = Finish.solid(0x0B0C0F, roughness: 0.1, coat: 1)
    for index in 0..<7 {
      let direction = Self.surface(longitude: Double(index - 3) * 4.3, latitude: -4.6, lift: 0.004)
      let holder = SCNNode()
      holder.simdPosition = direction
      holder.simdOrientation = simd_quatf(from: SIMD3(0, 0, 1), to: simd_normalize(direction))
      let slot = SCNCapsule(capRadius: 0.023, height: 0.09); slot.firstMaterial = window
      let slotNode = SCNNode(geometry: slot); slotNode.scale = SCNVector3(1, 1, 0.3)
      let bar = SCNCapsule(capRadius: 0.015, height: 0.062); bar.firstMaterial = lamp
      let barNode = SCNNode(geometry: bar); barNode.scale = SCNVector3(1, 1, 0.4); barNode.position = SCNVector3(0, 0, 0.006)
      holder.addChildNode(slotNode); holder.addChildNode(barNode)
      body.addChildNode(holder)
      bars.append(barNode)
    }

    // Ears: a sensor disc on each side, with a lit ring and a cap that turns.
    let graphite = Finish.solid(0x2C2F36, roughness: 0.38, metalness: 0.85)
    for side in [CGFloat(-1), 1] {
      let ear = SCNNode()
      let base = Sculpt.lathe([(r: 0.275, y: -0.12), (r: 0.275, y: 0.035), (r: 0.275, y: 0.035), (r: 0.245, y: 0.075), (r: 0.245, y: 0.075), (r: 0, y: 0.075)], around: 64)
      base.firstMaterial = graphite
      ear.addChildNode(SCNNode(geometry: base))
      let ring = SCNTorus(ringRadius: 0.2, pipeRadius: 0.0105); ring.ringSegmentCount = 64; ring.firstMaterial = earLight
      let ringNode = SCNNode(geometry: ring); ringNode.position = SCNVector3(0, 0.077, 0)
      ear.addChildNode(ringNode); earRings.append(ringNode)
      let cap = SCNNode()
      let disc = Sculpt.lathe([(r: 0.155, y: 0.07), (r: 0.155, y: 0.092), (r: 0.155, y: 0.092), (r: 0.13, y: 0.108), (r: 0, y: 0.112)], around: 48)
      disc.firstMaterial = steel
      cap.addChildNode(SCNNode(geometry: disc))
      let mark = SCNBox(width: 0.024, height: 0.006, length: 0.095, chamferRadius: 0.002)
      mark.firstMaterial = Finish.solid(0xFF8040, roughness: 0.4, coat: 0.5)
      let markNode = SCNNode(geometry: mark); markNode.position = SCNVector3(0, 0.112, 0.07)
      cap.addChildNode(markNode)
      ear.addChildNode(cap); caps.append(cap)
      let outward = simd_normalize(Self.surface(longitude: Double(side) * Self.earLongitude, latitude: 3.5))
      ear.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: outward)
      ear.simdPosition = outward * Float(r - 0.055)
      body.addChildNode(ear)
    }

    // The hover ring: a thin dark ring with a line of light, tipped a little toward the viewer.
    let ringMetal = Finish.solid(0x23262C, roughness: 0.3, metalness: 0.9)
    let outer = SCNTorus(ringRadius: 0.66, pipeRadius: 0.032); outer.ringSegmentCount = 96; outer.pipeSegmentCount = 16; outer.firstMaterial = ringMetal
    hover.addChildNode(SCNNode(geometry: outer))
    let inner = SCNTorus(ringRadius: 0.66, pipeRadius: 0.012); inner.ringSegmentCount = 96; inner.firstMaterial = hoverLight
    hoverLine.geometry = inner; hoverLine.position = SCNVector3(0, 0.026, 0)
    hover.addChildNode(hoverLine)
    root.addChildNode(hover)

    // One small light in orbit.
    let bead = SCNSphere(radius: 0.05); bead.firstMaterial = moteLight
    mote.geometry = bead
    moteHalo.geometry = SCNPlane(width: 0.62, height: 0.62); moteHalo.geometry?.firstMaterial = moteGlow
    // The glow stands behind the bead as the viewer sees it, so it never cuts the bead in two.
    moteHalo.position = SCNVector3(0, 0, -0.09)
    let facing = SCNNode(); facing.constraints = [SCNBillboardConstraint()]
    facing.addChildNode(moteHalo)
    mote.addChildNode(facing)
    orbit.position = SCNVector3(0, Self.center, 0)
    orbit.addChildNode(mote)
    root.addChildNode(orbit)

    scene.rootNode.addChildNode(Stage.light(.ambient, 0xE8ECFF, 150))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFF7EE, 720, angles: SCNVector3(-0.75, -0.55, 0)))
    // Light from behind on both sides draws the edge of the ball on a dark desk.
    scene.rootNode.addChildNode(Stage.light(.directional, 0xBFD0FF, 900, angles: SCNVector3(-0.1, -2.4, 0)))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFD9B8, 760, angles: SCNVector3(0.3, 2.4, 0)))
    // A low light from behind lifts the dark bowl off a dark ground.
    scene.rootNode.addChildNode(Stage.light(.directional, 0xAFC0FF, 220, angles: SCNVector3(0.75, -2.6, 0)))
    scene.rootNode.addChildNode(camera)
    Stage.bloom(camera, intensity: 0.7, threshold: 0.78, radius: 8)
    set(mood: .idle)
    apply(MascotPose())
  }

  /// The light carries the state: soft cyan at rest, blue at work, amber when it
  /// needs the person, red while the screen is shared. Offline it has no light.
  func set(mood: MascotMood) {
    self.mood = mood
    let tint: UInt32
    switch mood {
    case .idle: tint = 0x86E6FF
    case .sleepy: tint = 0x7CC4D8
    case .working: tint = 0x6F9CFF
    case .attention: tint = 0xFFB936
    case .sharing: tint = 0xFF5A4F
    case .asleep: tint = 0x5E8A99
    case .offline: tint = 0x3B3E45
    }
    let color = MascotScene.color(tint)
    for eye in eyes { eye.set(tint: color) }
    stripLight.multiply.contents = color
    lamp.diffuse.contents = color; earLight.diffuse.contents = color; hoverLight.diffuse.contents = color
    moteLight.diffuse.contents = color.blended(withFraction: 0.45, of: .white) ?? color
    moteGlow.multiply.contents = color; glow.multiply.contents = color
    // With no service the shell is dull and grey.
    let dull = mood == .offline
    dome.multiply.contents = dull ? NSColor(white: 0.66, alpha: 1) : NSColor.white
    shell.multiply.contents = dull ? NSColor(white: 0.7, alpha: 1) : NSColor.white
    if dull { dome.roughness.contents = 0.6 } else { dome.roughness.contents = spun }
    camera.camera?.saturation = dull ? 0.3 : 1
  }

  func apply(_ pose: MascotPose) {
    let dt = lastClock.map { max(0, min(0.1, pose.clock - $0)) } ?? 0
    lastClock = pose.clock
    let awake = mood != .asleep && mood != .offline
    let light = CGFloat(max(0, min(1, max(pose.glow, pose.voice))))
    let live: CGFloat = mood == .offline ? 0 : 1

    // A click: the lids go happy and the ball rocks once.
    if dt > 0, lastSquint < 0.3, pose.squint >= 0.3 { kick.velocity += 4.2 }
    lastSquint = pose.squint
    // At rest it tilts a little, as if curious. All of it stops when the clock stops.
    let curious = mood == .idle || mood == .sharing ? 1.0 : mood == .working ? 0.35 : 0
    let tilt = curious * (0.05 * sin(pose.clock * 0.63) + 0.025 * sin(pose.clock * 1.9 + 1.3))
    let glance = curious * 0.05 * sin(pose.clock * 0.41 + 0.6)
    let height = pose.bob + pose.lift
    bowlYaw.target = pose.yaw + glance
    ringLift.target = height
    ringTilt.target = pose.roll + tilt
    ringSway.target = pose.yaw
    sink.target = awake ? 0 : 1
    if dt > 0 {
      bowlYaw.step(dt); ringLift.step(dt); ringTilt.step(dt); ringSway.step(dt); kick.step(dt); sink.step(dt)
    } else {
      bowlYaw.snap(); ringLift.snap(); ringTilt.snap(); ringSway.snap(); kick.snap(to: 0); sink.snap()
    }

    let rest = CGFloat(sink.value)
    root.position = SCNVector3(0, CGFloat(height) - 0.11 * rest, 0)
    root.scale = SCNVector3(pose.scale, pose.scale, pose.scale)
    // Metal gives only a little under a press.
    let give = 1 + (pose.squash - 1) * 0.22
    let wide = 1 / sqrt(max(0.3, give))
    body.scale = SCNVector3(wide, give, wide)
    body.eulerAngles = SCNVector3(pose.pitch, pose.yaw + glance, pose.roll + tilt + kick.value * 0.16)
    bowl.eulerAngles.y = CGFloat(bowlYaw.value - (pose.yaw + glance))

    // The eyes. A smile lifts the lower lids a little; a voice does not.
    let cheer = max(0, min(0.5, (pose.smile - 0.45) * 0.9)) * (1 - pose.voice)
    // Each pod faces a little out and up. The look is turned back by a part of that, so both
    // eyes look at the same thing and a ring never slides out of its glass.
    for (index, eye) in eyes.enumerated() {
      let side = index == 0 ? -1.0 : 1.0
      eye.apply(open: pose.eyeOpen, squint: max(pose.squint, cheer), lookX: max(-1, min(1, pose.pupilX * 0.6 - side * 0.38)),
                lookY: max(-1, min(1, pose.pupilY * 0.6 - 0.3)), glow: Double(light * live))
    }

    // The level lamps: low and even at rest, a moving level from the middle out with a voice.
    for (index, bar) in bars.enumerated() {
      let away = Double(abs(index - 3))
      let shimmer = 0.5 + 0.5 * sin(pose.clock * 21 + Double(index) * 1.9)
      let level = max(0, min(1, (pose.voice * (0.75 + 0.5 * shimmer) - away * 0.17) * 3))
      bar.opacity = live * (0.16 + 0.84 * CGFloat(level))
      bar.scale = SCNVector3(1 + 0.25 * CGFloat(level), 0.55 + 0.8 * CGFloat(level), 0.4)
    }

    // The belt: the bright point runs around it at the speed of the work.
    stripLight.diffuse.contentsTransform = SCNMatrix4MakeTranslation(CGFloat(pose.sparkAngle / (2 * .pi)), 0, 0)
    // At rest the belt breathes slowly.
    let breath = CGFloat(awake ? 0.9 + 0.1 * sin(pose.clock * 1.5) : 1)
    strip.opacity = live * (0.35 + 0.65 * light) * breath
    for (index, cap) in caps.enumerated() { cap.eulerAngles.y = CGFloat(pose.sparkAngle) * (index == 0 ? 1 : -1) }
    for ring in earRings { ring.opacity = live * (0.3 + 0.7 * light) }
    crown.opacity = live * (0.3 + 0.7 * light)

    // The hover ring follows the ball late, and leans against its turn.
    hover.position = SCNVector3(-CGFloat(ringSway.value - pose.yaw) * 0.5, Self.center - 1.6 + CGFloat(ringLift.value - height) * 0.9 + 0.06 * rest, 0)
    hover.eulerAngles = SCNVector3(0.3 + pose.ringWobble, 0, CGFloat(ringTilt.value) * 0.8 + pose.ringWobble * 0.6)
    hoverLine.opacity = live * (0.3 + 0.7 * light)
    underGlow.opacity = live * (0.10 + 0.34 * light) * (1 - 0.6 * rest)

    // The light in orbit.
    orbit.eulerAngles = SCNVector3(0.42 + pose.ringWobble, 0, -0.24 + pose.ringWobble * 0.8)
    // One turn of the orbit for one turn of the belt light, so nothing jumps when the angle starts again.
    let turn = pose.sparkAngle + 2.2
    let reach = 1.62 - 0.12 * Double(rest)
    mote.position = SCNVector3(reach * cos(turn), 0, reach * sin(turn))
    mote.scale = SCNVector3(0.7 + 0.5 * light, 0.7 + 0.5 * light, 0.7 + 0.5 * light)
    // The bead stays solid: its size and its glow carry the brightness.
    mote.opacity = live
    moteHalo.opacity = 0.2 + 0.6 * light

    if pose.sheen >= 0 {
      // A band of light goes down the dome.
      dome.emission.intensity = CGFloat(0.5 * sin(pose.sheen * .pi))
      dome.emission.contentsTransform = SCNMatrix4MakeTranslation(0, CGFloat(0.9 - pose.sheen * 1.8), 0)
    } else if dome.emission.intensity != 0 { dome.emission.intensity = 0 }
  }
}
