import AppKit
import SceneKit
import TaskPanelCore
import simd

/// Onyx: a polished black stone that is alive. Veins of gold run through it and
/// carry the light of the state, two small robotic eyes in pods of gold are set
/// into it, and a thin halo of gold floats over it. It is the adult sibling of
/// Pebble: calm, with no cartoon mouth. It shows a voice as one fine line of light.
///
/// Its parts act out the motion of the body. Carried or thrown, the halo trails
/// behind and tips back like a hat in the wind, its point of light streams behind
/// it, and the veins flare on the leading side. In a jump the stone throws the
/// halo up; it lags above, drops back and wobbles, and the veins flash at the
/// landing. In a wave the halo is raised and tipped three times, as a hat is.
final class OnyxScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  private let root = SCNNode()
  private let body = SCNNode()
  private let form = SCNNode()
  private let sheenShell = SCNNode()
  private let face = SCNNode()
  private var eyes: [RoboEye] = []
  private let brass = SCNMaterial()
  private var lidMetals: [SCNMaterial] = []
  private let haloPivot = SCNNode()
  private let spark = SCNNode(), sparkGlow = SCNNode()
  private var tail: [SCNNode] = []
  private var lastSpark = 0.6, sparkSpeed = 0.0
  // The motion of the body, as the parts of the stone remember it.
  private let windShell = SCNNode()
  private let windMaterial = SCNMaterial()
  /// What the wind shell shows now: 1 the leading side to the right, -1 to the left, 2 every vein (a landing).
  private var windShown = 0
  private var stream = 0.0, flash = 0.0, lastAir = 0.0, lastFloor = 0.0, wavePhase = 0.0
  private var landings = 0
  private var wasHeld = false
  private let aura = SCNNode()
  private let stone = SCNMaterial()
  private let sheenMaterial = SCNMaterial()
  private let faceMaterial = SCNMaterial()
  private let ringMaterial = SCNMaterial()
  private let sparkMaterial = Finish.light()
  private let sparkHalo = Finish.halo(), auraMaterial = Finish.halo()
  private var mood = MascotMood.idle
  private var tint = MascotScene.color(0xFFD79A)
  private var glows: [UInt32: CGImage] = [:]
  private var paints: [Bool: CGImage] = [:]
  private var faceKey = ""
  private var sheenStep = -1
  private var lastClock = 0.0
  // The halo follows the stone late.
  private var haloX = Spring(0, response: 0.52, dampingRatio: 0.36)
  private var haloY = Spring(0, response: 0.46, dampingRatio: 0.40)
  private var haloTilt = Spring(0.34, response: 0.56, dampingRatio: 0.34)
  private var haloLean = Spring(-0.18, response: 0.56, dampingRatio: 0.30)
  /// How far each eye faces outward and upward on the stone, in the units of its look.
  private let toeIn: Double, toeDown: Double

  // The stone: a wide, low pebble with a smooth outline, a little narrower at the crown.
  private static let half = (x: 1.20, y: 0.95, z: 0.96)
  private static let vertical = 0.96, around = 0.98
  private static let bodyY = -0.20
  private static let eyeX = 0.37, eyeY = 0.10, eyeRadius = 0.20
  private static let ringRadius = 0.70
  /// The stone leans a little, as a real one does: its crown sits to one side.
  private static let lean = 0.05
  private static func taper(_ t: Double) -> Double { (1 - 0.05 * t - 0.03 * t * t) / 1.0209 }
  /// Depth of the front of the stone at a point of its face.
  private static func surface(x: Double, y: Double) -> Double {
    let t = max(-0.999, min(0.999, y / half.y))
    let v = asin(Sculpt.power(t, 1 / vertical))
    let ring = Sculpt.power(cos(v), vertical) * taper(t)
    let c = max(-0.999, min(0.999, x / (half.x * ring)))
    return half.z * ring * Sculpt.power(sin(acos(Sculpt.power(c, 1 / around))), around)
  }

  // MARK: the veins

  private struct Vein { var points: [CGPoint]; var widths: [CGFloat] }
  /// The middle of the face stays clear of veins: the eyes, and the line of the voice under them.
  private static func clear(_ point: CGPoint) -> Bool {
    (point.x > 0.19 && point.x < 0.81 && point.y > 0.44 && point.y < 0.66) || (point.x > 0.27 && point.x < 0.73 && point.y > 0.20 && point.y <= 0.44)
  }
  private static func random(_ seed: inout UInt64) -> Double {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    return Double((seed >> 33) & 0xFFFFFF) / Double(0x1000000)
  }
  /// The cracks of the stone, in the view from the front: x from left to right,
  /// y from the base to the crown, both 0 to 1. They are mended with gold.
  private static let veins: [Vein] = {
    var seed: UInt64 = 0x51A7E
    var result: [Vein] = []
    func crack(from start: CGPoint, heading: Double, length: Double, width: Double, depth: Int) {
      var point = start, angle = heading, wide = width
      var vein = Vein(points: [point], widths: [CGFloat(width)])
      let stride = 0.02, steps = max(4, Int(length / stride))
      for step in 0..<steps {
        angle += (random(&seed) - 0.5) * 0.7
        if random(&seed) < 0.10 { angle += (random(&seed) - 0.5) * 1.3 }
        // A crack wanders, but it keeps its way.
        angle += (heading - angle) * 0.3
        var next = CGPoint(x: point.x + CGFloat(cos(angle) * stride), y: point.y + CGFloat(sin(angle) * stride))
        // A crack turns away from the eyes. If it cannot, it ends there.
        for turn in [0.5, -0.5, 1.0, -1.0] where clear(next) {
          next = CGPoint(x: point.x + CGFloat(cos(angle + turn) * stride), y: point.y + CGFloat(sin(angle + turn) * stride))
          if !clear(next) { angle += turn }
        }
        if clear(next) { break }
        point = next
        wide = max(width * 0.45, min(width * 1.5, wide + (random(&seed) - 0.5) * width * 0.6))
        vein.points.append(point); vein.widths.append(CGFloat(wide))
        if depth < 2, step > 2, step < steps - 3, random(&seed) < 0.10 {
          let turn = (random(&seed) < 0.5 ? -1.0 : 1.0) * (0.55 + random(&seed) * 0.6)
          crack(from: point, heading: angle + turn, length: length * (0.22 + random(&seed) * 0.28), width: wide * 0.66, depth: depth + 1)
        }
      }
      guard vein.points.count > 2 else { return }
      // Round the corners twice, then let the crack thin out to its end.
      for _ in 0..<2 {
        var points = [vein.points[0]], widths = [vein.widths[0]]
        for index in 0..<(vein.points.count - 1) {
          let a = vein.points[index], b = vein.points[index + 1], wa = vein.widths[index], wb = vein.widths[index + 1]
          points.append(CGPoint(x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25)); widths.append(wa * 0.75 + wb * 0.25)
          points.append(CGPoint(x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75)); widths.append(wa * 0.25 + wb * 0.75)
        }
        points.append(vein.points[vein.points.count - 1]); widths.append(vein.widths[vein.widths.count - 1])
        vein.points = points; vein.widths = widths
      }
      for index in 0..<vein.widths.count {
        let left = 1 - CGFloat(index) / CGFloat(vein.widths.count - 1)
        vein.widths[index] *= 0.22 + 0.78 * min(1, left * 1.6)
      }
      result.append(vein)
    }
    // One long crack falls from the crown past the right eye. A second crosses the
    // lower left. Short ones start at the edge.
    crack(from: CGPoint(x: 0.38, y: 1.0), heading: -0.60, length: 0.92, width: 0.0118, depth: 0)
    crack(from: CGPoint(x: 0.01, y: 0.50), heading: -0.86, length: 0.62, width: 0.0108, depth: 0)
    crack(from: CGPoint(x: 0.99, y: 0.27), heading: 3.45, length: 0.30, width: 0.0080, depth: 1)
    crack(from: CGPoint(x: 0.05, y: 0.74), heading: 0.55, length: 0.26, width: 0.0078, depth: 1)
    // From the nearest crack a fine line of gold runs to the rim of each eye, so the
    // eyes are part of the mending.
    let wide = 2 * half.x, tall = 2 * half.y
    for side in [-1.0, 1.0] {
      let center = CGPoint(x: 0.5 + (side * eyeX + lean * eyeY) / wide, y: 0.5 + eyeY / tall)
      var nearest = center, best = Double.infinity
      for vein in result { for point in vein.points {
        let distance = hypot(Double(point.x - center.x) * wide, Double(point.y - center.y) * tall)
        if distance < best { best = distance; nearest = point }
      } }
      guard best < 0.62 else { continue }
      let reach = eyeRadius * 1.2 / best
      let rim = CGPoint(x: center.x + (nearest.x - center.x) * CGFloat(reach), y: center.y + (nearest.y - center.y) * CGFloat(reach))
      var link = Vein(points: [], widths: [])
      for step in 0...8 {
        let t = CGFloat(step) / 8, bend = sin(t * .pi) * 0.012 * CGFloat(side)
        link.points.append(CGPoint(x: nearest.x + (rim.x - nearest.x) * t - (rim.y - nearest.y) * bend * 8, y: nearest.y + (rim.y - nearest.y) * t + (rim.x - nearest.x) * bend * 8))
        link.widths.append(0.0062 - 0.0020 * t)
      }
      result.append(link)
    }
    return result
  }()
  private static func stroke(_ context: CGContext, size: CGFloat, scale: CGFloat, color: NSColor) {
    context.setStrokeColor(color.cgColor); context.setLineCap(.round)
    for vein in veins {
      for index in 1..<vein.points.count {
        context.setLineWidth(max(0.6, vein.widths[index] * size * scale))
        context.move(to: CGPoint(x: vein.points[index - 1].x * size, y: vein.points[index - 1].y * size))
        context.addLine(to: CGPoint(x: vein.points[index].x * size, y: vein.points[index].y * size))
        context.strokePath()
      }
    }
  }
  /// The stone as it is painted: black with faint clouds and flecks, and the veins in
  /// gold or, with no service, in grey.
  private static func paint(gold: Bool) -> CGImage {
    let size = 1024
    return MascotScene.image(width: size, height: size) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      context.setFillColor(MascotScene.color(0x050608).cgColor); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
      var seed: UInt64 = 0xC10D5
      // Faint charcoal clouds give the black some depth.
      for _ in 0..<12 {
        let center = CGPoint(x: random(&seed) * Double(size), y: random(&seed) * Double(size)), radius = CGFloat(90 + random(&seed) * 200)
        let cloud = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x1B1E25, 0.55).cgColor, MascotScene.color(0x1B1E25, 0).cgColor] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(cloud, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
      }
      // Flecks of gold, small and few.
      for _ in 0..<260 {
        let point = CGPoint(x: random(&seed), y: random(&seed)), radius = CGFloat(0.9 + random(&seed) * 1.9), alpha = CGFloat(0.18 + random(&seed) * 0.5)
        if clear(point) { continue }
        context.setFillColor(MascotScene.color(gold ? 0xE2B865 : 0x8A8A8C, alpha).cgColor)
        context.fillEllipse(in: CGRect(x: point.x * CGFloat(size) - radius, y: point.y * CGFloat(size) - radius, width: radius * 2, height: radius * 2))
      }
      stroke(context, size: CGFloat(size), scale: 1.3, color: MascotScene.color(gold ? 0x7A5518 : 0x444446))
      stroke(context, size: CGFloat(size), scale: 1.0, color: MascotScene.color(gold ? 0xCFA043 : 0x7A7A7C))
      stroke(context, size: CGFloat(size), scale: 0.36, color: MascotScene.color(gold ? 0xFCE6A8 : 0xAAAAAC))
    }
  }
  /// The light in the veins: a soft glow and a bright core, on black. `wash` adds an even light for the sheen.
  private static func glow(_ color: NSColor, wash: CGFloat = 0) -> CGImage {
    let size = 512
    return MascotScene.image(width: size, height: size) { context in
      context.setFillColor(NSColor(white: wash, alpha: 1).cgColor); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
      context.saveGState()
      context.setShadow(offset: .zero, blur: 9, color: color.cgColor)
      stroke(context, size: CGFloat(size), scale: 1.0, color: color)
      context.restoreGState()
      stroke(context, size: CGFloat(size), scale: 0.5, color: color.blended(withFraction: 0.6, of: .white) ?? color)
    }
  }
  /// A dark room for the polish to reflect. Across the image: the front is at one
  /// quarter, the left at one half, the back at three quarters. Light behind the
  /// stone draws its edge, a window in front lies on its brow, and a warm light
  /// overhead falls on its crown, as if from the halo.
  private static func room() -> CGImage {
    MascotScene.image(width: 1024, height: 512) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let ground = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x020203).cgColor, MascotScene.color(0x07080A).cgColor, MascotScene.color(0x0D0F13).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(ground, start: .zero, end: CGPoint(x: 0, y: 512), options: [])
      func box(_ rect: CGRect, _ hex: UInt32, _ strength: CGFloat, blur: CGFloat) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: blur, color: MascotScene.color(hex, strength).cgColor)
        context.setFillColor(MascotScene.color(hex, strength).cgColor)
        context.fill(rect)
        context.restoreGState()
      }
      // Behind the stone: a low even light for the whole edge, a cool accent high on
      // the left, a warm one on the right.
      box(CGRect(x: 600, y: 150, width: 340, height: 220), 0xC8D0E0, 0.30, blur: 30)
      box(CGRect(x: 640, y: 300, width: 90, height: 90), 0xD6E4FF, 0.85, blur: 22)
      box(CGRect(x: 830, y: 210, width: 80, height: 110), 0xFFE2C0, 0.62, blur: 22)
      // In front, above the eyes: a wide window to the left, brighter at its top.
      context.saveGState()
      context.clip(to: CGRect(x: 300, y: 342, width: 172, height: 90))
      let window = CGGradient(colorsSpace: space, colors: [MascotScene.color(0xFFFFFF, 0.42).cgColor, MascotScene.color(0xFFFFFF, 1).cgColor] as CFArray, locations: [0, 1])!
      context.drawLinearGradient(window, start: CGPoint(x: 0, y: 342), end: CGPoint(x: 0, y: 432), options: [])
      context.restoreGState()
      context.setFillColor(MascotScene.color(0x07080A).cgColor)
      context.fill(CGRect(x: 384, y: 342, width: 4, height: 90)); context.fill(CGRect(x: 300, y: 384, width: 172, height: 3))
      // Overhead: warm, and softer toward the sides, as if from the halo. Below: a faint bounce.
      let overhead = CGGradient(colorsSpace: space, colors: [MascotScene.color(0xFFD9A0, 0).cgColor, MascotScene.color(0xFFD9A0, 0.34).cgColor, MascotScene.color(0xFFE4BC, 0.95).cgColor] as CFArray, locations: [0, 0.55, 1])!
      context.drawLinearGradient(overhead, start: CGPoint(x: 0, y: 392), end: CGPoint(x: 0, y: 512), options: [])
      box(CGRect(x: 0, y: 40, width: 1024, height: 30), 0x8A7A66, 0.16, blur: 30)
      // To the left: a soft light for the shoulder.
      box(CGRect(x: 486, y: 306, width: 80, height: 96), 0xE8EEFF, 0.42, blur: 30)
    }
  }
  /// The veins in white gold with a little even light: what the sheen shows where its band is.
  private static let flare: CGImage = glow(MascotScene.color(0xFFEFCB), wash: 0.20)
  /// The veins as the wind of travel lights them: bright on the leading side, dark behind.
  private static func wind(right: Bool) -> CGImage {
    let size = 384
    return MascotScene.image(width: size, height: size) { context in
      context.draw(glow(MascotScene.color(0xFFEFCB), wash: 0.13), in: CGRect(x: 0, y: 0, width: size, height: size))
      context.setBlendMode(.multiply)
      let fade = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [NSColor.black.cgColor, NSColor(white: 0.25, alpha: 1).cgColor, NSColor.white.cgColor] as CFArray, locations: [0, 0.45, 1])!
      let from = CGFloat(size) * (right ? 0.12 : 0.88), to = CGFloat(size) * (right ? 0.96 : 0.04)
      context.drawLinearGradient(fade, start: CGPoint(x: from, y: 0), end: CGPoint(x: to, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
  }
  /// One step of the sheen: a slanted band of light that goes from the crown to the base.
  private static func sheen(_ progress: Double) -> CGImage {
    let size = 384
    return MascotScene.image(width: size, height: size) { context in
      let full = CGRect(x: 0, y: 0, width: size, height: size)
      context.draw(flare, in: full)
      context.setBlendMode(.multiply)
      context.translateBy(x: CGFloat(size) / 2, y: CGFloat(size) / 2); context.rotate(by: -0.45)
      let middle = CGFloat(size) * CGFloat(0.72 - 1.44 * progress), reach = CGFloat(size) * 0.16
      let band = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [NSColor.black.cgColor, NSColor.white.cgColor, NSColor.black.cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(band, start: CGPoint(x: 0, y: middle - reach), end: CGPoint(x: 0, y: middle + reach),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
  }

  // MARK: the face

  private static let faceWidth = 1.68, faceHeight = 0.84
  /// A piece of the stone's front, a hair above the polish, that carries the line of the voice as light.
  private static func facePatch() -> SCNGeometry {
    let across = 48, up = 24
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    for j in 0...up {
      let y = eyeY - faceHeight / 2 + faceHeight * Double(j) / Double(up)
      for i in 0...across {
        let x = -faceWidth / 2 + faceWidth * Double(i) / Double(across)
        positions.append(SCNVector3(x, y, surface(x: x, y: y) + 0.008))
        normals.append(SCNVector3(0, 0, 1))
        coordinates.append(CGPoint(x: Double(i) / Double(across), y: 1 - Double(j) / Double(up)))
      }
    }
    var indices: [Int32] = []
    let row = Int32(across + 1)
    for j in 0..<Int32(up) { for i in 0..<Int32(across) {
      let a = j * row + i, b = a + 1, c = a + row, d = c + 1
      indices += [a, b, c, b, d, c]
    } }
    return Sculpt.geometry(positions, normals, coordinates, indices)
  }
  /// The voice: one fine line of light under the eyes. It grows longer and brighter with the voice.
  private func drawVoice(_ level: Double) -> CGImage {
    let width = 512, height = 256
    let unit = CGFloat(width) / CGFloat(Self.faceWidth)
    let color = tint.blended(withFraction: 0.25, of: .white) ?? tint
    let core = tint.blended(withFraction: 0.85, of: .white) ?? .white
    return MascotScene.image(width: width, height: height) { context in
      let voice = CGFloat(max(0, min(1, level)))
      let y = CGFloat(height) / 2 - 0.37 * unit, reach = (0.07 + 0.19 * voice) * unit
      let line = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [core.withAlphaComponent(0).cgColor, core.withAlphaComponent(0.35 + 0.65 * voice).cgColor, core.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.5, 1])!
      let thick = (0.010 + 0.010 * voice) * unit
      context.setShadow(offset: .zero, blur: 0.05 * unit, color: color.withAlphaComponent(0.9 * voice).cgColor)
      context.clip(to: CGRect(x: CGFloat(width) / 2 - reach, y: y - thick / 2, width: reach * 2, height: thick))
      context.drawLinearGradient(line, start: CGPoint(x: CGFloat(width) / 2 - reach, y: y), end: CGPoint(x: CGFloat(width) / 2 + reach, y: y), options: [])
    }
  }
  /// The way the stone faces at a point of its front.
  private static func normal(x: Double, y: Double) -> SIMD3<Float> {
    let step = 0.01
    let dx = (surface(x: x + step, y: y) - surface(x: x - step, y: y)) / (2 * step)
    let dy = (surface(x: x, y: y + step) - surface(x: x, y: y - step)) / (2 * step)
    return simd_normalize(SIMD3(Float(-dx), Float(-dy), 1))
  }

  init() {
    let facing = Self.normal(x: Self.eyeX, y: Self.eyeY)
    toeIn = Double(atan2(facing.x, facing.z)) / 0.5
    toeDown = Double(asin(facing.y)) / 0.42
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.room()
    scene.lightingEnvironment.intensity = 1.7
    scene.rootNode.addChildNode(root)

    // A faint light behind the stone: it carries the state and draws the dark edge on a dark desk.
    aura.geometry = SCNPlane(width: 4.4, height: 4.4); aura.geometry?.firstMaterial = auraMaterial
    aura.position = SCNVector3(0, Self.bodyY, -1.3)
    root.addChildNode(aura)

    stone.lightingModel = .physicallyBased
    stone.roughness.contents = 0.07; stone.metalness.contents = 0.0
    stone.clearCoat.contents = 1.0; stone.clearCoatRoughness.contents = 0.03
    form.geometry = Sculpt.blob(half: Self.half, vertical: Self.vertical, around: Self.around, across: 128, up: 84, taper: Self.taper)
    form.geometry?.firstMaterial = stone
    var shear = SCNMatrix4Identity
    shear.m21 = CGFloat(Self.lean)
    form.transform = shear
    body.addChildNode(form)
    root.addChildNode(body)

    // The sheen: for a moment the veins, and a little of the polish, light up in a band that travels.
    sheenMaterial.lightingModel = .constant
    sheenMaterial.blendMode = .add; sheenMaterial.writesToDepthBuffer = false
    sheenShell.geometry = Sculpt.blob(half: Self.half, vertical: Self.vertical, around: Self.around, across: 96, up: 64, taper: Self.taper)
    sheenShell.geometry?.firstMaterial = sheenMaterial
    sheenShell.scale = SCNVector3(1.004, 1.004, 1.004); sheenShell.isHidden = true
    sheenShell.renderingOrder = 5
    form.addChildNode(sheenShell)

    // The wind of travel: the veins on the leading side light up while the stone is carried or thrown.
    windMaterial.lightingModel = .constant
    windMaterial.blendMode = .add; windMaterial.writesToDepthBuffer = false
    windShell.geometry = Sculpt.blob(half: Self.half, vertical: Self.vertical, around: Self.around, across: 96, up: 64, taper: Self.taper)
    windShell.geometry?.firstMaterial = windMaterial
    windShell.scale = SCNVector3(1.005, 1.005, 1.005); windShell.isHidden = true
    windShell.renderingOrder = 4
    form.addChildNode(windShell)

    faceMaterial.lightingModel = .constant
    faceMaterial.blendMode = .add; faceMaterial.writesToDepthBuffer = false
    face.geometry = Self.facePatch(); face.geometry?.firstMaterial = faceMaterial
    face.renderingOrder = 6; face.isHidden = true
    form.addChildNode(face)

    // The eyes: two small robotic eyes set into the stone. The pod is the black of the
    // stone; a fine rim of polished gold holds it, and the lids are gold, so the eyes
    // belong to the mended cracks. Each one faces the way the stone faces there.
    brass.lightingModel = .physicallyBased
    brass.diffuse.contents = MascotScene.color(0xE2B352); brass.metalness.contents = 1.0; brass.roughness.contents = 0.20
    brass.emission.contents = MascotScene.color(0xE2B352); brass.emission.intensity = 0.34
    let socket = Finish.solid(0x07080A, roughness: 0.08, coat: 1, coatRoughness: 0.03)
    for side in [-1.0, 1.0] {
      let x = side * Self.eyeX, y = Self.eyeY
      let eye = RoboEye(radius: CGFloat(Self.eyeRadius), housing: socket, lid: brass)
      let rim = SCNTorus(ringRadius: CGFloat(Self.eyeRadius * 1.20), pipeRadius: CGFloat(Self.eyeRadius * 0.085))
      rim.ringSegmentCount = 72; rim.pipeSegmentCount = 16; rim.firstMaterial = brass
      let bezel = SCNNode(geometry: rim); bezel.eulerAngles.x = .pi / 2
      eye.node.addChildNode(bezel)
      let facing = Self.normal(x: x, y: y)
      eye.node.simdOrientation = simd_quatf(from: SIMD3(0, 0, 1), to: facing)
      // The rim of the pod lies on the polish. The glass stands out of it.
      let point = SIMD3(Float(x + Self.lean * y), Float(y), Float(Self.surface(x: x, y: y))) - facing * 0.012
      eye.node.simdPosition = point
      // The lids are copies of the metal: keep them, so they can go grey with the rest.
      eye.node.enumerateHierarchy { child, _ in
        if let metal = child.geometry?.firstMaterial, metal.isDoubleSided, metal.lightingModel == .physicallyBased { self.lidMetals.append(metal) }
      }
      body.addChildNode(eye.node)
      eyes.append(eye)
    }

    // The halo: a thin ring of gold over the crown, and one point of light on it.
    ringMaterial.lightingModel = .physicallyBased
    ringMaterial.diffuse.contents = MascotScene.color(0xE6B655); ringMaterial.metalness.contents = 1.0; ringMaterial.roughness.contents = 0.22
    ringMaterial.emission.contents = MascotScene.color(0xE6B655); ringMaterial.emission.intensity = 0.45
    let band = SCNTube(innerRadius: Self.ringRadius - 0.026, outerRadius: Self.ringRadius + 0.026, height: 0.020)
    band.radialSegmentCount = 144; band.firstMaterial = ringMaterial
    haloPivot.addChildNode(SCNNode(geometry: band))
    spark.geometry = SCNSphere(radius: 0.052); spark.geometry?.firstMaterial = sparkMaterial
    sparkGlow.geometry = SCNPlane(width: 0.62, height: 0.62); sparkGlow.geometry?.firstMaterial = sparkHalo
    sparkGlow.constraints = [SCNBillboardConstraint()]
    spark.addChildNode(sparkGlow)
    haloPivot.addChildNode(spark)
    // When the point runs, it draws a short tail behind it on the ring.
    for index in 0..<7 {
      let bead = SCNNode(geometry: SCNSphere(radius: 0.046 - 0.0045 * CGFloat(index)))
      bead.geometry?.firstMaterial = sparkMaterial; bead.opacity = 0
      haloPivot.addChildNode(bead); tail.append(bead)
    }
    scene.rootNode.addChildNode(haloPivot)

    scene.rootNode.addChildNode(Stage.light(.ambient, 0xFFF1E3, 170))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFF6EA, 760, angles: SCNVector3(-0.7, -0.5, 0)))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xC9D8FF, 500, angles: SCNVector3(-0.15, -2.5, 0)))
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFDDB8, 500, angles: SCNVector3(0.2, 2.5, 0)))
    scene.rootNode.addChildNode(camera)
    Stage.bloom(camera, intensity: 0.45, threshold: 0.8, radius: 8)
    set(mood: .idle)
    apply(MascotPose())
  }

  /// The light carries the state: warm gold-white at rest, blue at work, amber when it
  /// needs the person, red while the screen is shared, dim in sleep. With no service
  /// the veins are grey and the polish is dull.
  func set(mood: MascotMood) {
    self.mood = mood
    let hex: UInt32
    switch mood {
    case .idle, .sleepy: hex = 0xFFD79A
    case .working: hex = 0x7FA6FF
    case .attention: hex = 0xFFB02E
    case .sharing: hex = 0xFF5A4F
    case .asleep: hex = 0xB39563
    case .offline: hex = 0x8E8E90
    }
    tint = MascotScene.color(hex)
    if glows[hex] == nil { glows[hex] = Self.glow(tint) }
    stone.emission.contents = glows[hex]
    let gold = mood != .offline
    if paints[gold] == nil { paints[gold] = Self.paint(gold: gold) }
    stone.diffuse.contents = paints[gold]
    stone.roughness.contents = gold ? 0.07 : 0.42
    stone.clearCoat.contents = gold ? 1.0 : 0.2
    let ring = MascotScene.color(gold ? 0xE6B655 : 0x8C8C8E)
    ringMaterial.diffuse.contents = ring; ringMaterial.emission.contents = ring
    sparkMaterial.diffuse.contents = tint.blended(withFraction: 0.4, of: .white) ?? tint
    sparkHalo.multiply.contents = tint; auraMaterial.multiply.contents = tint
    let pod = MascotScene.color(gold ? 0xE2B352 : 0x8C8C8E)
    for metal in [brass] + lidMetals { metal.diffuse.contents = pod; metal.emission.contents = pod }
    for eye in eyes { eye.set(tint: tint) }
    faceKey = ""
  }

  func apply(_ pose: MascotPose) {
    let dt = max(0, min(0.1, pose.clock - lastClock))
    lastClock = pose.clock
    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    // A stone gives only a little.
    let give = 1 + (pose.squash - 1) * 0.3
    let wide = 1 / sqrt(max(0.3, give))
    body.scale = SCNVector3(pose.scale * wide, pose.scale * give, pose.scale * wide)
    body.eulerAngles = SCNVector3(pose.pitch, pose.yaw, pose.roll)
    body.position = SCNVector3(0, Self.bodyY + (give - 1) * Self.half.y * 0.6, 0)

    // What the body does: how fast it is carried and which way, a landing, a wave.
    let carry = max(0, min(1, pose.gait)), way = max(-1, min(1, pose.travel))
    stream = dt > 0 ? stream + (carry - stream) * min(1, dt * 7) : carry
    if dt > 0, lastAir > 0.25, pose.air < 0.05 {
      // It lands: the veins flash once and the halo is shaken.
      flash = 1; landings += 1
      haloY.velocity -= 1.6; haloTilt.velocity += 3.6; haloLean.velocity += landings % 2 == 0 ? 3.2 : -3.2
    }
    lastAir = pose.air
    flash = dt > 0 ? flash * exp(-dt / 0.30) : 0
    // Picked up: the halo starts, as the eyes do.
    if dt > 0, pose.held, !wasHeld { haloY.velocity += 1.8; haloTilt.velocity += 1.6 }
    wasHeld = pose.held
    wavePhase = pose.wave > 0.01 ? wavePhase + dt * 2 * .pi * 3 : 0
    // Three tips of the hat, each one up and back.
    let tip = pose.wave * max(0, sin(wavePhase))

    // The veins breathe. They wait with a slow, strong pulse, and they flare with a voice.
    let glow = max(0, min(1, pose.glow))
    let breath = mood == .attention ? 0.72 + 0.28 * sin(pose.clock * 2.3)
      : mood == .working ? 0.84 + 0.2 * sin(pose.clock * 5.2) : 1 + 0.12 * sin(pose.clock * 1.7)
    let dull = mood == .offline ? 0.25 : 1.0
    stone.emission.intensity = CGFloat(min(3.0, ((0.06 + 0.62 * glow) * breath + 0.7 * pose.voice + 2.3 * flash + 0.5 * stream) * dull))
    aura.opacity = CGFloat(min(1, (0.14 + 0.24 * glow + 0.12 * pose.voice + 0.45 * flash + 0.10 * stream) * dull))
    aura.scale = SCNVector3(pose.scale, pose.scale, 1)

    // The eyes look, blink and narrow. Each one faces a little outward on the stone, so
    // its look is turned back in: both eyes meet the person's.
    // Carried, they look along the way of travel. In a wave they smile.
    let carried = max(stream, pose.held ? 0.35 : 0)
    let lookX = pose.pupilX * (1 - carried) + way * carried
    for (index, eye) in eyes.enumerated() {
      let side = index == 0 ? -1.0 : 1.0
      // At speed they narrow a little against the wind.
      eye.apply(open: pose.eyeOpen, squint: max(pose.squint, max(0, pose.smile - 0.6) * 0.6, pose.wave * 0.85, stream * 0.3),
                lookX: lookX - side * toeIn, lookY: pose.pupilY * (1 - 0.5 * carried) - toeDown, glow: min(1, glow + 0.5 * flash) * dull)
    }
    // The line of the voice is drawn again only when the voice has changed.
    let speaking = pose.voice > 0.03
    if face.isHidden == speaking { face.isHidden = !speaking }
    let key = speaking ? String(format: "%.2f", pose.voice) : ""
    if speaking, key != faceKey { faceKey = key; faceMaterial.diffuse.contents = drawVoice(pose.voice) }

    if pose.sheen >= 0 {
      // The band is drawn again for each step, and only while the sheen runs.
      let step = Int(pose.sheen * 40)
      if step != sheenStep { sheenStep = step; sheenMaterial.diffuse.contents = Self.sheen(Double(step) / 40) }
      sheenShell.isHidden = false
      sheenShell.opacity = CGFloat(min(1, sin(pose.sheen * .pi) * 1.6))
    } else if !sheenShell.isHidden { sheenShell.isHidden = true; sheenStep = -1 }

    // Carried or thrown: the veins on the leading side light up, and flicker with each
    // step. At a landing every vein flashes once.
    let gust = stream * (1.25 + 0.25 * pose.stride)
    if flash > 0.04, flash * 1.3 >= gust {
      if windShown != 2 { windShown = 2; windMaterial.diffuse.contents = Self.flare }
      windShell.isHidden = false
      windShell.opacity = CGFloat(min(1, flash * 1.3 * dull))
    } else if stream > 0.02 {
      let side = way >= 0 ? 1 : -1
      if windShown != side { windShown = side; windMaterial.diffuse.contents = Self.wind(right: side > 0) }
      windShell.isHidden = false
      windShell.opacity = CGFloat(min(1, gust * dull))
    } else if !windShell.isHidden { windShell.isHidden = true }

    // The halo rides over the crown and follows it late. In sleep it sinks toward
    // the crown and slips to one side.
    let rest = mood == .asleep ? 1.0 : mood == .sleepy ? 0.4 : 0.0
    let reach = (Self.half.y * give + 0.30 - 0.15 * rest) * pose.scale
    // Carried, it trails behind and tips back like a hat in the wind, and it flutters
    // with each step. In the air it floats a little higher.
    haloX.target = -sin(pose.roll) * reach + Self.lean * Self.half.y * pose.scale - way * carry * 0.56 * pose.scale
    haloY.target = pose.bob + pose.lift + Double(body.position.y) + cos(pose.roll) * cos(pose.pitch) * reach
      + (0.10 * carry + 0.04 * carry * pose.stride + 0.22 * pose.air) * pose.scale
    // Before a jump the stone crouches, and the halo tips forward with it.
    let crouch = max(0, 1 - pose.squash)
    haloTilt.target = 0.34 + pose.pitch * 0.8 + pose.ringWobble + 0.08 * rest + 0.12 * carry + 0.18 * pose.air + 1.1 * crouch
    haloLean.target = -0.18 + pose.roll * 0.9 - pose.yaw * 0.25 + pose.ringWobble * 0.6 - 0.16 * rest + way * carry * 0.72 + carry * pose.stride * 0.14
    if dt > 0 { haloX.step(dt); haloY.step(dt); haloTilt.step(dt); haloLean.step(dt) }
    else { haloX.snap(); haloY.snap(); haloTilt.snap(); haloLean.snap() }
    // The stone never passes through its halo. A jump throws the ring up: it keeps
    // the speed of the crown, flies on above it, and the spring brings it back.
    let floor = pose.bob + pose.lift + Double(body.position.y) + (Self.half.y * give + 0.20 - 0.12 * rest) * pose.scale
    let push = dt > 0 ? (floor - lastFloor) / dt : 0
    lastFloor = floor
    if haloY.value < floor { haloY.value = floor; haloY.velocity = max(haloY.velocity, min(push * 1.15, 5)) }
    // A wave raises the halo and tips it, as a hat is raised.
    let leaning = haloLean.value + 0.66 * tip
    // It stays inside the view: at the top of the highest jump, and at the side in a hard throw.
    let extent = Self.ringRadius * min(1, (pow(sin(haloTilt.value), 2) + pow(sin(leaning), 2)).squareRoot()) + 0.04
    let ceiling = 2.24 - extent * pose.scale
    if haloY.value > ceiling { haloY.value = ceiling; haloY.velocity = min(haloY.velocity, 0) }
    let side = 2.22 - (Self.ringRadius + 0.04) * pose.scale
    if abs(haloX.value) > side { haloX.value = haloX.value < 0 ? -side : side; haloX.velocity = 0 }
    haloPivot.position = SCNVector3(max(-side, min(side, haloX.value + 0.16 * tip * pose.scale)), min(ceiling, haloY.value + 0.26 * tip * pose.scale), sin(pose.pitch) * reach)
    haloPivot.eulerAngles = SCNVector3(haloTilt.value, 0, leaning)
    haloPivot.scale = SCNVector3(pose.scale, pose.scale, pose.scale)

    // The point of light. Carried, it goes to the trailing side of the ring and its
    // tail streams out behind it. At rest the tail follows it around the ring when it runs.
    var angle = pose.sparkAngle
    if stream > 0.01 {
      var arc = (way >= 0 ? Double.pi : 0) - angle
      arc = arc - (arc / (2 * .pi)).rounded() * 2 * .pi
      angle += arc * min(1, stream * 1.4)
    }
    spark.position = SCNVector3(Self.ringRadius * cos(angle), 0, Self.ringRadius * sin(angle))
    var turned = pose.sparkAngle - lastSpark
    if turned < -Double.pi { turned += 2 * Double.pi } else if turned > Double.pi { turned -= 2 * Double.pi }
    lastSpark = pose.sparkAngle
    sparkSpeed = dt > 0 ? sparkSpeed + (abs(turned) / dt - sparkSpeed) * min(1, dt * 6) : 0
    let gap = min(0.11, sparkSpeed * 0.022), shown = max(0, min(1, (sparkSpeed - 0.9) / 2.2)) * (1 - stream)
    let back = way >= 0 ? -1.0 : 1.0
    for (index, bead) in tail.enumerated() {
      let step = Double(index + 1), around = angle - gap * step
      let onRing = SIMD3(Self.ringRadius * cos(around), 0, Self.ringRadius * sin(around))
      // Streaming: a line behind the point that waves a little, as a ribbon does.
      let behind = SIMD3(Self.ringRadius * cos(angle) + back * (0.10 + 0.08 * carry) * step,
                         0.014 * step * sin(pose.clock * 17 - step * 0.9) + 0.012 * step, Self.ringRadius * sin(angle))
      let place = onRing + (behind - onRing) * stream
      bead.position = SCNVector3(place.x, place.y, place.z)
      bead.opacity = CGFloat(max(shown * (1 - Double(index) / 7) * 0.75, stream * (1 - Double(index) / 8) * 0.9) * dull)
    }
    let bright = CGFloat(0.7 + 0.5 * glow + 0.35 * stream)
    spark.scale = SCNVector3(bright, bright, bright)
    // Streaming, its glow is long, as the head of a comet.
    sparkGlow.scale = SCNVector3(1 + 1.5 * stream, 1 + 0.2 * stream, 1)
    sparkGlow.opacity = CGFloat(min(1, 0.25 + 0.75 * glow + 0.4 * stream) * dull)
    ringMaterial.emission.intensity = CGFloat((0.30 + 0.30 * glow) * dull)
  }
}
