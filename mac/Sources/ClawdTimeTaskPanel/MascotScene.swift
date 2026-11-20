import AppKit
import SceneKit
import TaskPanelCore

/// The Chert stone as a living thing: a sunset-strata pebble, the white ring of the
/// mark in orbit around it, and a spark that rides the ring as the status light.
/// It is built from code, so it is sharp at every size and has no image to load.
final class MascotScene {
  let scene = SCNScene()
  let camera = SCNNode()
  private let root = SCNNode()
  private let body = SCNNode()
  private let ringPivot = SCNNode()
  private let spark = SCNNode()
  private let sparkHalo = SCNNode()
  private var eyes: [SCNNode] = []
  private var pupils: [SCNNode] = []
  private var whites: [SCNMaterial] = []
  private let mouth = SCNNode()
  private let stone = SCNMaterial()
  private let sparkMaterial = SCNMaterial()
  private let haloMaterial = SCNMaterial()
  private let ringMaterial = SCNMaterial()
  private var mood = MascotMood.idle

  // The stone: a superellipsoid, wider than it is tall, a little narrower at the top.
  private static let half = (x: 1.14, y: 1.02, z: 0.98)
  private static let roundness = (vertical: 0.82, around: 0.88)
  private static let ringRadius = 1.72
  private static let eyeHeight = 0.13
  private static func power(_ value: Double, _ exponent: Double) -> Double {
    value == 0 ? 0 : (value < 0 ? -1 : 1) * pow(abs(value), exponent)
  }
  private static func taper(_ y: Double) -> Double { let t = y / half.y; return 1 - 0.09 * t - 0.05 * t * t }
  private static func point(u: Double, v: Double) -> SCNVector3 {
    let y = half.y * power(sin(v), roundness.vertical)
    let ring = power(cos(v), roundness.vertical) * taper(y)
    return SCNVector3(half.x * ring * power(cos(u), roundness.around), y, half.z * ring * power(sin(u), roundness.around))
  }
  /// Depth of the front surface at a point of the face.
  private static func surfaceZ(x: Double, y: Double) -> Double {
    let v = asin(power(max(-1, min(1, y / half.y)), 1 / roundness.vertical))
    let ring = power(cos(v), roundness.vertical) * taper(y)
    let c = max(-1, min(1, x / (half.x * ring)))
    let u = acos(power(c, 1 / roundness.around))
    return half.z * ring * power(sin(u), roundness.around)
  }

  private static func pebble() -> SCNGeometry {
    let across = 120, up = 72
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    for j in 0...up {
      let v = -Double.pi / 2 + Double.pi * Double(j) / Double(up)
      for i in 0...across {
        let u = -Double.pi + 2 * Double.pi * Double(i) / Double(across)
        let p = point(u: u, v: v)
        positions.append(p)
        // Texture rows follow height, so the strata stay level on the stone.
        coordinates.append(CGPoint(x: Double(i) / Double(across), y: 1 - (Double(p.y) / half.y + 1) / 2))
        let step = 0.004
        let a = point(u: u + step, v: v), b = point(u: u - step, v: v)
        let c = point(u: u, v: min(.pi / 2, v + step)), d = point(u: u, v: max(-.pi / 2, v - step))
        let tu = SCNVector3(a.x - b.x, a.y - b.y, a.z - b.z), tv = SCNVector3(c.x - d.x, c.y - d.y, c.z - d.z)
        var n = SCNVector3(tu.y * tv.z - tu.z * tv.y, tu.z * tv.x - tu.x * tv.z, tu.x * tv.y - tu.y * tv.x)
        var length = sqrt(n.x * n.x + n.y * n.y + n.z * n.z)
        if length < 1e-6 { n = SCNVector3(0, p.y < 0 ? -1 : 1, 0); length = 1 }
        n = SCNVector3(n.x / length, n.y / length, n.z / length)
        if n.x * p.x + n.y * p.y + n.z * p.z < 0 { n = SCNVector3(-n.x, -n.y, -n.z) }
        normals.append(n)
      }
    }
    var indices: [Int32] = []
    let row = across + 1
    for j in 0..<up { for i in 0..<across {
      let a = Int32(j * row + i), b = a + 1, c = a + Int32(row), d = c + 1
      indices += [a, c, b, b, c, d]
    } }
    let texture = SCNGeometrySource(textureCoordinates: coordinates)
    return SCNGeometry(sources: [SCNGeometrySource(vertices: positions), SCNGeometrySource(normals: normals), texture],
      elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
  }

  private static func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
  private static func image(width: Int, height: Int, _ draw: (CGContext) -> Void) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    draw(context)
    return context.makeImage()!
  }
  /// The strata of the Chert mark, top to base: orange into navy, in soft layers.
  private static func strata() -> CGImage {
    // Six layers, as in the mark. Each keeps its color for a while and then blends
    // into the next, so the stone reads as layered rock and not as one smooth fade.
    let layers: [(CGFloat, UInt32)] = [(0.30, 0xFF8A47), (0.47, 0xF06A38), (0.60, 0xBE4E3C), (0.71, 0x7A3A42), (0.83, 0x3A3560), (1.0, 0x232A5C)]
    var stops: [(CGFloat, UInt32)] = [(0, 0xFFAE6B)]
    var top: CGFloat = 0
    for (index, layer) in layers.enumerated() {
      let blend = min(0.045, (layer.0 - top) * 0.42)
      stops.append((top + (index == 0 ? 0.10 : blend), layer.1)); stops.append((layer.0 - blend, layer.1))
      top = layer.0
    }
    return image(width: 8, height: 512) { context in
      let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: stops.map { color($0.1).cgColor } as CFArray, locations: stops.map(\.0))!
      // The image origin is at the bottom: the first stop goes to the top.
      context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 512), end: CGPoint(x: 0, y: 0), options: [])
    }
  }
  /// A soft band of light. Moved across the stone it is the sheen of the mark.
  private static func sheenBand() -> CGImage {
    image(width: 8, height: 256) { context in
      context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: 8, height: 256))
      let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [NSColor.black.cgColor, color(0xFFF1E0).cgColor, NSColor.black.cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 108), end: CGPoint(x: 0, y: 148), options: [])
    }
  }
  /// A small studio for reflections: a warm ceiling, a soft key box and a dark floor.
  private static func studio() -> CGImage {
    image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let sky = CGGradient(colorsSpace: space, colors: [color(0x59544F).cgColor, color(0x9A9186).cgColor, color(0xFFF6EA).cgColor] as CFArray, locations: [0, 0.45, 1])!
      context.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      for (center, radius, strength) in [(CGPoint(x: 150, y: 205), CGFloat(70), CGFloat(1)), (CGPoint(x: 380, y: 180), CGFloat(44), CGFloat(0.7))] {
        let glow = CGGradient(colorsSpace: space, colors: [NSColor.white.withAlphaComponent(strength).cgColor, NSColor.white.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
      }
    }
  }
  private static func halo() -> CGImage {
    image(width: 128, height: 128) { context in
      let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [NSColor.white.withAlphaComponent(0.9).cgColor, NSColor.white.withAlphaComponent(0.25).cgColor, NSColor.white.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.35, 1])!
      context.drawRadialGradient(glow, startCenter: CGPoint(x: 64, y: 64), startRadius: 0, endCenter: CGPoint(x: 64, y: 64), endRadius: 64, options: [])
    }
  }

  init() {
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.studio()
    scene.lightingEnvironment.intensity = 1.15
    scene.rootNode.addChildNode(root)

    stone.lightingModel = .physicallyBased
    stone.diffuse.contents = Self.strata()
    stone.roughness.contents = 0.34
    stone.metalness.contents = 0.0
    stone.clearCoat.contents = 0.55
    stone.clearCoatRoughness.contents = 0.22
    stone.emission.contents = Self.sheenBand()
    stone.emission.wrapT = .clampToBorder
    stone.emission.intensity = 0
    body.geometry = Self.pebble()
    body.geometry?.firstMaterial = stone
    root.addChildNode(body)

    // Eyes sit on the stone and turn with it.
    for side in [-1.0, 1.0] {
      let x = side * 0.40, y = Self.eyeHeight
      let eye = SCNNode()
      eye.position = SCNVector3(x, y, Self.surfaceZ(x: x, y: y) - 0.035)
      eye.eulerAngles.y = side * 0.14
      let white = SCNMaterial()
      white.lightingModel = .physicallyBased
      white.diffuse.contents = Self.color(0xFFFBF4); white.roughness.contents = 0.25
      white.emission.contents = Self.color(0xFFFBF4); white.emission.intensity = 0.18
      let ball = SCNNode(geometry: SCNSphere(radius: 1)); (ball.geometry as? SCNSphere)?.segmentCount = 48
      ball.geometry?.firstMaterial = white
      ball.scale = SCNVector3(0.24, 0.335, 0.10)
      eye.addChildNode(ball)
      let dark = SCNMaterial()
      dark.lightingModel = .physicallyBased
      dark.diffuse.contents = Self.color(0x1D2040); dark.roughness.contents = 0.18; dark.clearCoat.contents = 1
      let pupil = SCNNode(geometry: SCNSphere(radius: 1)); (pupil.geometry as? SCNSphere)?.segmentCount = 40
      pupil.geometry?.firstMaterial = dark
      pupil.scale = SCNVector3(0.140, 0.180, 0.05)
      pupil.position = SCNVector3(0, 0, 0.075)
      let glint = SCNMaterial(); glint.lightingModel = .constant; glint.diffuse.contents = NSColor.white
      let highlight = SCNNode(geometry: SCNSphere(radius: 1)); highlight.geometry?.firstMaterial = glint
      highlight.scale = SCNVector3(0.34, 0.28, 0.5); highlight.position = SCNVector3(-0.34, 0.40, 0.7)
      pupil.addChildNode(highlight)
      eye.addChildNode(pupil)
      body.addChildNode(eye)
      eyes.append(eye); pupils.append(pupil); whites.append(white)
    }
    mouth.position = SCNVector3(0, -0.24, Self.surfaceZ(x: 0, y: -0.24) + 0.006)
    body.addChildNode(mouth)
    setSmile(0.35)

    // The white ring of the mark, tipped toward the viewer and leaning like the mark.
    ringMaterial.lightingModel = .physicallyBased
    ringMaterial.diffuse.contents = Self.color(0xFBF5EA); ringMaterial.roughness.contents = 0.32
    ringMaterial.emission.contents = Self.color(0xFBF5EA); ringMaterial.emission.intensity = 0.06
    let ring = SCNNode(geometry: SCNTorus(ringRadius: Self.ringRadius, pipeRadius: 0.058))
    (ring.geometry as? SCNTorus)?.ringSegmentCount = 144; (ring.geometry as? SCNTorus)?.pipeSegmentCount = 24
    ring.geometry?.firstMaterial = ringMaterial
    ringPivot.addChildNode(ring)
    sparkMaterial.lightingModel = .constant
    spark.geometry = SCNSphere(radius: 0.15); spark.geometry?.firstMaterial = sparkMaterial
    haloMaterial.lightingModel = .constant; haloMaterial.diffuse.contents = Self.halo()
    haloMaterial.blendMode = .add; haloMaterial.writesToDepthBuffer = false; haloMaterial.isDoubleSided = true
    sparkHalo.geometry = SCNPlane(width: 1.1, height: 1.1); sparkHalo.geometry?.firstMaterial = haloMaterial
    sparkHalo.constraints = [SCNBillboardConstraint()]
    spark.addChildNode(sparkHalo)
    ringPivot.addChildNode(spark)
    root.addChildNode(ringPivot)

    let ambient = SCNNode(); ambient.light = SCNLight(); ambient.light?.type = .ambient
    ambient.light?.intensity = 260; ambient.light?.color = Self.color(0xFFF1E3)
    let key = SCNNode(); key.light = SCNLight(); key.light?.type = .directional
    key.light?.intensity = 820; key.light?.color = Self.color(0xFFF7EE); key.eulerAngles = SCNVector3(-0.75, -0.55, 0)
    let rim = SCNNode(); rim.light = SCNLight(); rim.light?.type = .directional
    rim.light?.intensity = 520; rim.light?.color = Self.color(0xC9D4FF); rim.eulerAngles = SCNVector3(-0.2, 2.5, 0)
    // A second, low light from behind: it draws the navy base out of a dark ground.
    let under = SCNNode(); under.light = SCNLight(); under.light?.type = .directional
    under.light?.intensity = 460; under.light?.color = Self.color(0xAFC0FF); under.eulerAngles = SCNVector3(0.75, -2.6, 0)
    for node in [ambient, key, rim, under] { scene.rootNode.addChildNode(node) }

    camera.camera = SCNCamera()
    camera.camera?.fieldOfView = 23
    camera.camera?.zNear = 1; camera.camera?.zFar = 40
    camera.position = SCNVector3(0, 0.04, 11.4)
    scene.rootNode.addChildNode(camera)
    set(mood: .idle)
    apply(MascotPose())
  }

  private var shownSmile = -1.0
  private let lip: SCNMaterial = { let m = SCNMaterial(); m.lightingModel = .constant; m.diffuse.contents = MascotScene.color(0x2A1730); return m }()
  /// A crescent: flat at 0, a wide smile at 1.
  private func setSmile(_ amount: Double) {
    let amount = max(0, min(1, amount))
    guard abs(amount - shownSmile) > 0.03 else { return }
    shownSmile = amount
    let width = 0.15 + 0.09 * amount, depth = 0.02 + 0.11 * amount, thickness = 0.04
    let path = NSBezierPath()
    path.move(to: NSPoint(x: -width, y: 0))
    path.curve(to: NSPoint(x: width, y: 0), controlPoint1: NSPoint(x: -width * 0.5, y: -depth), controlPoint2: NSPoint(x: width * 0.5, y: -depth))
    path.curve(to: NSPoint(x: -width, y: 0), controlPoint1: NSPoint(x: width * 0.5, y: -depth - thickness * 2), controlPoint2: NSPoint(x: -width * 0.5, y: -depth - thickness * 2))
    path.close(); path.flatness = 0.002
    let shape = SCNShape(path: path, extrusionDepth: 0.01)
    shape.firstMaterial = lip
    mouth.geometry = shape
  }

  /// The spark carries the state: cream at rest, blue at work, amber when it needs the person, red while sharing.
  func set(mood: MascotMood) {
    self.mood = mood
    let tint: UInt32
    switch mood {
    case .idle, .sleepy: tint = 0xFFF1DC
    case .working: tint = 0x9DB2FF
    case .attention: tint = 0xFFB936
    case .sharing: tint = 0xFF6257
    case .asleep, .offline: tint = 0x8E8A84
    }
    sparkMaterial.diffuse.contents = Self.color(tint)
    haloMaterial.multiply.contents = Self.color(tint)
    stone.saturation(mood == .offline ? 0.25 : 1)
  }

  func apply(_ pose: MascotPose) {
    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    let wide = 1 / sqrt(max(0.3, pose.squash))
    body.scale = SCNVector3(pose.scale * wide, pose.scale * pose.squash, pose.scale * wide)
    body.eulerAngles = SCNVector3(pose.pitch, pose.yaw, pose.roll)
    // A pressed stone sits lower, so its base stays where it was.
    body.position.y = (pose.squash - 1) * Self.half.y * 0.6

    let open = max(0.05, pose.eyeOpen) * (1 - 0.42 * pose.squint)
    for (index, eye) in eyes.enumerated() {
      eye.scale = SCNVector3(1 + 0.06 * pose.squint, open, 1)
      eye.position.y = Self.eyeHeight + 0.05 * pose.squint
      // A closed eye is a dark line, not a white one.
      let closed = CGFloat(max(0, min(1, (0.32 - pose.eyeOpen) / 0.27)))
      let white = NSColor(srgbRed: 1, green: 0.984, blue: 0.957, alpha: 1).blended(withFraction: closed, of: Self.color(0x2A1B2E)) ?? .white
      whites[index].diffuse.contents = white; whites[index].emission.contents = white
      whites[index].emission.intensity = 0.18 * (1 - closed)
      pupils[index].position.x = pose.pupilX * 0.088
      pupils[index].position.y = pose.pupilY * 0.125
      pupils[index].opacity = CGFloat(max(0, min(1, (pose.eyeOpen - 0.12) / 0.2)))
    }
    setSmile(pose.smile)

    ringPivot.scale = SCNVector3(pose.scale, pose.scale, pose.scale)
    ringPivot.eulerAngles = SCNVector3(0.36 + pose.ringWobble, 0, -0.30 + pose.roll * 0.5 + pose.ringWobble * 0.6)
    spark.position = SCNVector3(Self.ringRadius * cos(pose.sparkAngle), 0, Self.ringRadius * sin(pose.sparkAngle))
    let glow = CGFloat(pose.glow)
    spark.scale = SCNVector3(0.75 + 0.45 * glow, 0.75 + 0.45 * glow, 0.75 + 0.45 * glow)
    sparkHalo.opacity = 0.25 + 0.75 * glow
    ringMaterial.emission.intensity = 0.05 + 0.07 * glow

    if pose.sheen >= 0 {
      stone.emission.intensity = CGFloat(0.55 * sin(pose.sheen * .pi))
      // The band crosses the stone from the top edge to the base, on a slant.
      var transform = SCNMatrix4MakeTranslation(0, CGFloat(0.9 - pose.sheen * 1.8), 0)
      transform = SCNMatrix4Rotate(transform, 0.5, 0, 0, 1)
      stone.emission.contentsTransform = transform
    } else if stone.emission.intensity != 0 { stone.emission.intensity = 0 }
  }

  /// A still frame, for the tests of the look and for the design board.
  func snapshot(pixels: CGFloat) -> NSImage {
    let renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
    renderer.scene = scene; renderer.pointOfView = camera; renderer.autoenablesDefaultLighting = false
    return renderer.snapshot(atTime: 0, with: CGSize(width: pixels, height: pixels), antialiasingMode: .multisampling4X)
  }
}

private extension SCNMaterial {
  /// Grey the stone when the supervisor has no service to report.
  func saturation(_ amount: CGFloat) {
    multiply.contents = amount >= 1 ? NSColor.white : NSColor(white: 0.62, alpha: 1)
  }
}
