import AppKit
import SceneKit
import TaskPanelCore
import simd

/// Flux: a living drop of liquid chrome. The metal moves in slow swells and
/// mirrors a room. Where it mirrors the horizon it glows in the state color.
/// Two small robotic eyes ride the surface, and one bright droplet in orbit is the status light.
final class FluxScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  private let root = SCNNode(), body = SCNNode()
  private let orbit = SCNNode()
  private let lead = SCNNode(), leadHalo = SCNNode(), bead = SCNNode(), mote = SCNNode()
  private let chrome = SCNMaterial()
  private let beadChrome = Finish.solid(0xEEF0F5, roughness: 0.05, metalness: 1)
  private let leadChrome = Finish.solid(0xEEF0F5, roughness: 0.05, metalness: 1), haloMaterial = Finish.halo()
  private var mood = MascotMood.idle
  private var tint = MascotScene.color(0xFFE3C2)
  private var tintHex: UInt32 = 0xFFE3C2
  private var spills: [UInt32: CGImage] = [:]
  /// The color of the horizon light: where it goes, and where it is now on its way there.
  private var stateTarget = (1.0, 0.77, 0.54), stateShown = (1.0, 0.77, 0.54)

  // The drop is a grid over a ball. Each frame moves every point along its own
  // direction, so the surface can swell, ripple and pull up into spikes.
  private static let across = 84, up = 56
  private static let half = (x: Float(1.16), y: Float(1.0), z: Float(1.04))
  /// The face texture covers this much of the front, in body units.
  private static let faceSpan = (width: 2.6, height: 2.2)
  /// For each point of the grid: its direction, its angle from the middle of
  /// the face, and how much it belongs to a spike. Fixed tables, read every frame.
  private let directionTable: UnsafeMutablePointer<Float>
  private let frontTable: UnsafeMutablePointer<Float>
  private let spikeTable: UnsafeMutablePointer<Float>
  private var buffer: [Float] = []
  private var coordinates: SCNGeometrySource!
  private var element: SCNGeometryElement!

  // Parts that follow late: the tip sways, the body rings like jelly, the base drips behind a hop.
  private var lastClock: Double?
  private var flow = 2.0
  private var swayX = Spring(0, response: 0.62, dampingRatio: 0.28)
  private var swayZ = Spring(0, response: 0.62, dampingRatio: 0.28)
  private var jelly = Spring(1, response: 0.30, dampingRatio: 0.24)
  private var trail = Spring(0, response: 0.24, dampingRatio: 0.5)
  private var work = Spring(0, response: 0.7, dampingRatio: 1)
  private var spikes = Spring(0, response: 0.5, dampingRatio: 0.42)
  private var puddle = Spring(0, response: 1.1, dampingRatio: 1)
  private var dull = Spring(0, response: 0.8, dampingRatio: 1)
  private var lastSpark = 0.0, sparkSpeed = 0.0
  private var shownFace: [Int] = []
  private var shownGrey = -1.0
  // Two small robotic eyes. Each sits on one point of the grid and is turned
  // to the surface there, so it rides the swells with the metal.
  private static let eyeRadius: CGFloat = 0.21
  private var eyes: [RoboEye] = []
  private var eyePoints: [Int] = []
  private var eyeGlows: [SCNNode] = []
  private let eyeGlow = Finish.halo()

  private static func unit(azimuth: Double, elevation: Double) -> (Float, Float, Float) {
    let a = azimuth * .pi / 180, e = elevation * .pi / 180
    return (Float(cos(e) * cos(a)), Float(sin(e)), Float(cos(e) * sin(a)))
  }

  /// The room the metal reflects, as one wide image. Across it runs the full
  /// turn: the wall behind the viewer at one quarter, the left wall at the
  /// half, the wall behind the drop at three quarters, the right wall at the
  /// ends. The ceiling is at the top. The wall behind the viewer is dark, so
  /// the eyes stay clear.
  private static func room() -> CGImage {
    MascotScene.image(width: 1024, height: 512) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let viewer: CGFloat = 256, left: CGFloat = 512, behind: CGFloat = 768
      func y(_ elevation: CGFloat) -> CGFloat { 256 + elevation / 90 * 256 }
      func fade(_ stops: [(CGFloat, UInt32, CGFloat)], from: CGFloat, to: CGFloat) {
        let gradient = CGGradient(colorsSpace: space, colors: stops.map { MascotScene.color($0.1, $0.2).cgColor } as CFArray, locations: stops.map(\.0))!
        context.saveGState()
        context.clip(to: CGRect(x: 0, y: min(from, to), width: 1024, height: abs(to - from)))
        context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: from), end: CGPoint(x: 0, y: to), options: [])
        context.restoreGState()
      }
      func box(_ rect: CGRect, _ hex: UInt32, _ alpha: CGFloat, soft: CGFloat, corner: CGFloat = 0) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: soft, color: MascotScene.color(hex, alpha).cgColor)
        context.setFillColor(MascotScene.color(hex, alpha).cgColor)
        context.addPath(CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)); context.fillPath()
        context.restoreGState()
      }
      func pool(_ center: CGPoint, _ radius: CGFloat, _ hex: UInt32, _ alpha: CGFloat) {
        let gradient = CGGradient(colorsSpace: space, colors: [MascotScene.color(hex, alpha).cgColor, MascotScene.color(hex, 0).cgColor] as CFArray, locations: [0.15, 1])!
        context.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
      }
      // A sky of silver that is pale at the horizon and deep above it: the look of chrome.
      fade([(0, 0xEEF1FB, 1), (0.14, 0xB4BEDF, 1), (0.5, 0x6F7BB0, 1), (1, 0x3A4276, 1)], from: y(0), to: y(90))
      // A thin film of color, as oil on metal: teal on one side of the back wall, violet on the other.
      pool(CGPoint(x: 640, y: y(26)), 120, 0x4FD1C5, 0.42)
      pool(CGPoint(x: 900, y: y(30)), 120, 0xB36BFF, 0.42)
      // The floor is dark at the horizon and pale under the drop, as light that comes back from a desk.
      fade([(0, 0x0D0E13, 1), (0.24, 0x1B1D26, 1), (0.52, 0x4C5269, 1), (1, 0x858A9B, 1)], from: y(0), to: y(-90))
      // A dark far wall just above the horizon: a hard edge in the metal, which is what makes it chrome.
      box(CGRect(x: -20, y: y(13), width: 1064, height: y(23) - y(13)), 0x232850, 0.82, soft: 1.5)
      // The viewer's side of the room is in shadow: the calm, dark ground behind the face.
      context.saveGState()
      context.translateBy(x: viewer, y: y(10)); context.scaleBy(x: 1, y: 0.74)
      let shade = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x0B0D1A, 0.98).cgColor, MascotScene.color(0x0B0D1A, 0.94).cgColor, MascotScene.color(0x0B0D1A, 0).cgColor] as CFArray, locations: [0, 0.55, 1])!
      context.drawRadialGradient(shade, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 226, options: [])
      context.restoreGState()
      // The wall behind the drop is a middle grey: a line around its edge that shows on a dark desk and on a light one.
      for x in [behind, behind - 1024] { pool(CGPoint(x: x, y: y(2)), 185, 0x4A5272, 0.97) }
      // A window of soft light high over the viewer's shoulder, and a smaller one on the other side.
      box(CGRect(x: viewer + 6, y: y(52), width: 150, height: y(76) - y(52)), 0xF6F8FF, 1, soft: 7, corner: 10)
      context.setFillColor(MascotScene.color(0x1A1D38, 0.85).cgColor)
      context.fill(CGRect(x: viewer + 6 + 92, y: y(52), width: 7, height: y(76) - y(52)))
      context.fill(CGRect(x: viewer + 6, y: y(65), width: 150, height: 6))
      box(CGRect(x: viewer - 150, y: y(60), width: 62, height: y(72) - y(60)), 0xEEF1FF, 0.7, soft: 8, corner: 8)
      // The ceiling right above: the light on the tip.
      box(CGRect(x: -40, y: y(82), width: 1104, height: 60), 0xF2F5FF, 0.6, soft: 12)
      // A light high on the wall behind the drop: the bright line on its crown.
      for x in [behind, behind - 1024] { box(CGRect(x: x - 75, y: y(40), width: 150, height: y(58) - y(40)), 0xFFFFFF, 0.92, soft: 7, corner: 8) }
      // A tall cool strip on the left wall and a warm one on the right wall.
      box(CGRect(x: left - 24, y: y(5), width: 48, height: y(50) - y(5)), 0xD6E4FF, 1, soft: 10, corner: 6)
      for x in [CGFloat(0), 1024] { box(CGRect(x: x - 16, y: y(8), width: 32, height: y(44) - y(8)), 0xFFE6CC, 1, soft: 8, corner: 6) }
    }
  }

  /// The horizon in the metal: a line of light in the state color where the
  /// reflection meets the horizon of the room, and its glow on the floor below.
  /// It fades toward the viewer, so it frames the face and does not cross it.
  /// It is light added by the metal itself, so a change of state needs no new room.
  private static let horizon = """
  #pragma arguments
  float3 stateColor;
  #pragma body
  float3 fluxNormal = normalize(_surface.normal);
  float3 fluxMirror = reflect(-normalize(_surface.view), fluxNormal);
  float3 fluxWorld = (scn_frame.inverseViewTransform * float4(fluxMirror, 0.0)).xyz;
  float fluxHeight = asin(clamp(fluxWorld.y, -1.0, 1.0));
  float fluxToViewer = fluxWorld.z / max(0.0001, length(fluxWorld.xz));
  float fluxSide = 1.0 - smoothstep(0.30, 0.90, fluxToViewer);
  float fluxLine = exp(-pow((fluxHeight - 0.012) / 0.027, 2.0));
  float fluxFloor = fluxHeight < 0.0 ? 0.42 * exp(fluxHeight / 0.13) : 0.0;
  _surface.emission.rgb += stateColor * (1.15 * fluxLine + fluxFloor) * fluxSide;
  """

  init() {
    let row = Self.across + 1, points = row * (Self.up + 1)
    directionTable = .allocate(capacity: points * 3)
    frontTable = .allocate(capacity: points)
    spikeTable = .allocate(capacity: points)
    scene.background.contents = NSColor.clear
    scene.rootNode.addChildNode(root)

    // The grid: directions on a ball, and where the face texture lies on the front.
    var uv: [CGPoint] = []
    var at = 0
    let spikeDirections: [(Float, Float, Float)] = [
      (45, 58), (135, 58), (225, 58), (315, 58),
      (0, 18), (28, 16), (152, 16), (180, 18), (225, 20), (270, 22), (315, 20),
      (5, -28), (175, -28), (40, -34), (140, -34), (250, -30), (290, -30),
    ].map { Self.unit(azimuth: $0.0, elevation: $0.1) }
    for j in 0...Self.up {
      let v = -Double.pi / 2 + Double.pi * Double(j) / Double(Self.up)
      for i in 0...Self.across {
        let u = -Double.pi + 2 * Double.pi * Double(i) / Double(Self.across)
        let x = Float(cos(v) * cos(u)), y = Float(sin(v)), z = Float(cos(v) * sin(u))
        directionTable[at * 3] = x; directionTable[at * 3 + 1] = y; directionTable[at * 3 + 2] = z
        frontTable[at] = acosf(max(-1, min(1, z)))
        var mask: Float = 0
        for spike in spikeDirections {
          let angle = acosf(max(-1, min(1, x * spike.0 + y * spike.1 + z * spike.2)))
          mask += expf(-(angle * angle) / (0.17 * 0.17))
        }
        spikeTable[at] = mask
        at += 1
        uv.append(CGPoint(x: Double(x * Self.half.x) / Self.faceSpan.width + 0.5, y: 0.5 - Double(y * Self.half.y) / Self.faceSpan.height))
      }
    }
    buffer = [Float](repeating: 0, count: points * 6)
    coordinates = SCNGeometrySource(textureCoordinates: uv)
    var indices: [Int32] = []
    for j in 0..<Int32(Self.up) { for i in 0..<Int32(Self.across) {
      let a = j * Int32(row) + i, b = a + 1, c = a + Int32(row), d = c + 1
      indices += [a, c, b, b, c, d]
    } }
    element = SCNGeometryElement(indices: indices, primitiveType: .triangles)

    chrome.lightingModel = .physicallyBased
    chrome.diffuse.contents = MascotScene.color(0xF1F3F7)
    chrome.metalness.contents = 1.0; chrome.roughness.contents = 0.04
    chrome.emission.wrapS = .clampToBorder; chrome.emission.wrapT = .clampToBorder
    chrome.shaderModifiers = [.surface: Self.horizon]
    scene.lightingEnvironment.contents = Self.room()
    root.addChildNode(body)

    // The eyes: small pods of bright steel with lids of brushed steel, a little above the middle of the drop.
    let pod = Finish.solid(0xDDE1EA, roughness: 0.14, metalness: 1), lid = Finish.solid(0x8D93A3, roughness: 0.26, metalness: 1)
    for side in [Float(-1), 1] {
      let want = simd_normalize(SIMD3<Float>(side * 0.36, 0.21, 1))
      var best = 0, nearest = Float(-2)
      for point in 0..<points {
        let match = directionTable[point * 3] * want.x + directionTable[point * 3 + 1] * want.y + directionTable[point * 3 + 2] * want.z
        if match > nearest { nearest = match; best = point }
      }
      eyePoints.append(best)
      let eye = RoboEye(radius: Self.eyeRadius, housing: pod, lid: lid)
      body.addChildNode(eye.node); eyes.append(eye)
      // A faint light on the metal around each eye, so the eyes read when the pet is small.
      let glow = SCNNode(geometry: SCNPlane(width: Self.eyeRadius * 3.7, height: Self.eyeRadius * 3.7))
      glow.geometry?.firstMaterial = eyeGlow
      eye.node.addChildNode(glow); eyeGlows.append(glow)
    }

    // Droplets in orbit. The first is the status light.
    let glow = SCNSphere(radius: 0.135); glow.segmentCount = 40; glow.firstMaterial = leadChrome
    lead.geometry = glow
    leadHalo.geometry = SCNPlane(width: 1.15, height: 1.15); leadHalo.geometry?.firstMaterial = haloMaterial
    leadHalo.constraints = [SCNBillboardConstraint()]
    // The glow is beside the droplet, not inside it, so it stays round when the droplet stretches.
    orbit.addChildNode(leadHalo)
    orbit.addChildNode(lead)
    let small = SCNSphere(radius: 0.085); small.segmentCount = 32; small.firstMaterial = beadChrome
    bead.geometry = small
    orbit.addChildNode(bead)
    let tiny = SCNSphere(radius: 0.055); tiny.segmentCount = 24; tiny.firstMaterial = beadChrome
    mote.geometry = tiny
    orbit.addChildNode(mote)
    root.addChildNode(orbit)

    // One hard light for the wet glint. The room does the rest.
    scene.rootNode.addChildNode(Stage.light(.directional, 0xFFFFFF, 900, angles: SCNVector3(-0.7, -0.5, 0)))
    scene.rootNode.addChildNode(camera)
    Stage.bloom(camera, intensity: 0.6, threshold: 0.9, radius: 10)
    set(mood: .idle)
    apply(MascotPose())
  }

  deinit { directionTable.deallocate(); frontTable.deallocate(); spikeTable.deallocate() }

  /// The state is the color of the horizon in the metal, of the eyes and of the lead droplet.
  func set(mood: MascotMood) {
    self.mood = mood
    let hex: UInt32
    switch mood {
    case .idle, .sleepy: hex = 0xFFE3C2
    case .working: hex = 0x7FA4FF
    case .attention: hex = 0xFFB936
    case .sharing: hex = 0xFF5B52
    case .asleep, .offline: hex = 0x8E8A84
    }
    tint = MascotScene.color(hex); tintHex = hex
    // The shader works in linear light.
    let rgb = tint.usingColorSpace(.sRGB) ?? tint
    stateTarget = (pow(Double(rgb.redComponent), 2.2), pow(Double(rgb.greenComponent), 2.2), pow(Double(rgb.blueComponent), 2.2))
    leadChrome.emission.contents = tint
    haloMaterial.multiply.contents = tint
    for eye in eyes { eye.set(tint: tint) }
    eyeGlow.multiply.contents = tint
    shownFace = []
  }

  /// A round patch of light in the state color that fades out smoothly: the
  /// light an eye spills on the metal. Made once for each state.
  private func spillImage() -> CGImage {
    if let image = spills[tintHex] { return image }
    let size = 96
    let rgb = tint.usingColorSpace(.sRGB) ?? tint
    var pixels = [UInt8](repeating: 0, count: size * size * 4)
    for row in 0..<size {
      for column in 0..<size {
        let dx = (Double(column) + 0.5) / Double(size) * 2 - 1, dy = (Double(row) + 0.5) / Double(size) * 2 - 1
        let far = min(1, (dx * dx + dy * dy).squareRoot())
        // Strong near the eye, then a long soft tail to nothing at the edge.
        let alpha = 0.92 * pow(1 - far, 2.4)
        let at = (row * size + column) * 4
        pixels[at] = UInt8(Double(rgb.redComponent) * alpha * 255); pixels[at + 1] = UInt8(Double(rgb.greenComponent) * alpha * 255)
        pixels[at + 2] = UInt8(Double(rgb.blueComponent) * alpha * 255); pixels[at + 3] = UInt8(alpha * 255)
      }
    }
    let image = pixels.withUnsafeMutableBytes { bytes -> CGImage in
      let context = CGContext(data: bytes.baseAddress, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      return context.makeImage()!
    }
    spills[tintHex] = image
    return image
  }

  /// The light that the metal itself gives, drawn where the texture meets the
  /// front of the drop: a small mouth, and the glint of the sheen.
  private func face(_ pose: MascotPose) -> CGImage {
    // Pixels for one unit of the body. The eyes are soft light, so this is enough at every size the pet has.
    let scale: CGFloat = 160
    let width = Int(Self.faceSpan.width * 160), height = Int(Self.faceSpan.height * 160)
    let dim: CGFloat = mood == .offline ? 0.42 : mood == .asleep ? 0.7 : 1
    let core = (tint.blended(withFraction: 0.5, of: .white) ?? .white).withAlphaComponent(dim)
    let soft = spillImage()
    return MascotScene.image(width: width, height: height) { context in
      let w = CGFloat(width), h = CGFloat(height)
      /// The light that an oval spills on the metal around it.
      func spill(_ rect: CGRect, _ reach: CGFloat) {
        context.saveGState()
        context.setAlpha(dim)
        context.draw(soft, in: rect.insetBy(dx: -reach, dy: -reach))
        context.restoreGState()
      }
      /// A line of light with a soft edge: drawn wide and faint, then narrower and brighter.
      func line(_ path: CGPath, _ thick: CGFloat, _ color: NSColor) {
        context.setLineCap(.round)
        for (grow, alpha) in [(CGFloat(4.4), CGFloat(0.05)), (3.4, 0.07), (2.6, 0.10), (1.9, 0.16), (1.4, 0.24), (1, 1)] {
          context.addPath(path)
          context.setStrokeColor((alpha == 1 ? color : tint.withAlphaComponent(alpha * color.alphaComponent)).cgColor)
          context.setLineWidth(thick * grow)
          context.strokePath()
        }
      }
      if pose.sheen >= 0 {
        // The sheen: a glint that runs once around the edge of the drop, and never across the face.
        let strength = CGFloat(sin(pose.sheen * .pi))
        let head = 2.5 - CGFloat(pose.sheen) * 2 * .pi
        context.setLineCap(.round)
        let pieces = 26
        for (grow, fade) in [(CGFloat(3), CGFloat(0.22)), (1, 1)] {
          for piece in 0..<pieces {
            let part = CGFloat(piece) / CGFloat(pieces - 1)
            let from = head + (part - 0.5) * 1.5, to = from + 1.5 / CGFloat(pieces) + 0.01
            let bright = strength * pow(sin(part * .pi), 2) * fade
            context.setStrokeColor(NSColor(white: 1, alpha: bright).cgColor); context.setLineWidth((0.015 + 0.025 * sin(part * .pi)) * scale * grow)
            context.move(to: CGPoint(x: w / 2 + 1.03 * scale * cos(from), y: h / 2 + 0.86 * scale * sin(from) - 0.03 * scale))
            context.addLine(to: CGPoint(x: w / 2 + 1.03 * scale * cos(to), y: h / 2 + 0.86 * scale * sin(to) - 0.03 * scale))
            context.strokePath()
          }
        }
      }
      // The mouth: a short curve that opens with the voice.
      let smile = CGFloat(max(0, min(1, pose.smile))), talk = CGFloat(max(0, min(1, pose.voice)))
      let reach = (0.075 + 0.055 * smile) * scale
      let mx = w / 2, my = h / 2 - 0.235 * scale
      if talk > 0.04 {
        let tall = (0.035 + 0.17 * talk) * scale
        let lips = CGRect(x: mx - reach * 0.8, y: my - tall * 0.7, width: reach * 1.6, height: tall)
        spill(lips, 0.11 * scale)
        context.setFillColor(core.cgColor); context.fillEllipse(in: lips)
      } else if mood != .offline {
        let curve = CGMutablePath()
        curve.move(to: CGPoint(x: mx - reach, y: my))
        curve.addQuadCurve(to: CGPoint(x: mx + reach, y: my), control: CGPoint(x: mx, y: my - 0.15 * scale * smile))
        line(curve, 0.03 * scale, core)
      }
    }
  }

  /// Moves every point of the drop, then gives the surface its true normals,
  /// so the reflections travel with the swells.
  private func shape(_ pose: MascotPose) {
    let row = Self.across + 1, rings = Self.up + 1
    let f = Float(flow)
    let calm = Float(1 - 0.5 * max(0, min(1, puddle.value))) * Float(1 - 0.85 * max(0, min(1, dull.value)))
    let swell = 0.034 * calm
    let working = Float(max(0, work.value)), spiky = Float(max(-0.2, spikes.value))
    let voice = Float(max(0, min(1, pose.voice)))
    let ringOn = pose.sheen >= 0
    let ringAt = Float(pose.sheen) * 2.7, ringHeight = Float(0.055 * sin(max(0, pose.sheen) * .pi))
    // The tip: a soft peak that leans with the sway.
    var nx = Float(0.10 + swayX.value), ny = Float(1), nz = Float(0.04 + swayZ.value)
    let nl = (nx * nx + ny * ny + nz * nz).squareRoot(); nx /= nl; ny /= nl; nz /= nl
    let tip = Float(0.20 * (1 - max(0, min(1, puddle.value)))) + 0.12 * max(0, spiky) + 0.02 * working * sinf(f * 3.1)
    let wobble = Float(max(-0.3, min(0.3, jelly.value - pose.squash))) * 0.9
    let drip = Float(max(-0.08, min(0.3, (pose.lift + pose.bob) - trail.value))) * 1.6
    let hx = Self.half.x, hy = Self.half.y, hz = Self.half.z
    let spikePulse = 0.24 + 0.035 * sinf(f * 6.5)
    buffer.withUnsafeMutableBufferPointer { out in
      let directions = UnsafeBufferPointer(start: directionTable, count: row * rings * 3)
      let fromFront = UnsafeBufferPointer(start: frontTable, count: row * rings)
      let spikeMask = UnsafeBufferPointer(start: spikeTable, count: row * rings)
      for v in 0..<(row * rings) {
        let x = directions[v * 3], y = directions[v * 3 + 1], z = directions[v * 3 + 2]
        var r: Float = 1
        r += swell * (sinf(2.1 * x + 1.3 * y + f * 0.9) + sinf(1.7 * y - 2.3 * z + f * 1.25 + 1) + sinf(2.9 * z + 1.1 * x - f * 0.7 + 2)
          + 0.24 * sinf(4.3 * x - 3.1 * y + 2.2 * z + f * 1.9))
        if working > 0.01 { r += working * 0.018 * sinf(8 * y + 1.5 * x - f * 5.5) }
        if voice > 0.02 { r += voice * (0.025 + 0.016 * sinf(9 * fromFront[v] - f * 12)) }
        if abs(spiky) > 0.01 { r += spiky * (spikeMask[v] * spikePulse - 0.03) }
        if ringOn { let q = (fromFront[v] - ringAt) / 0.24; r += ringHeight * expf(-q * q) }
        let toward = x * nx + y * ny + z * nz
        if toward > 0.4 { r += tip * expf(-(1 - toward) * 30) }
        var px = x * r * hx, py = y * r * hy, pz = z * r * hz
        if y < 0 {
          // A drop sits wide and flat at its base, and its base hangs behind a hop.
          let low = y * y
          px *= 1 + 0.10 * low; pz *= 1 + 0.10 * low
          py *= 1 - 0.13 * low
          py -= drip * low
        }
        let lean = 1 + wobble * y
        px *= lean; pz *= lean
        out[v * 6] = px; out[v * 6 + 1] = py; out[v * 6 + 2] = pz
      }
      // Normals from the neighbors on the grid.
      for j in 1..<(rings - 1) {
        for i in 0..<row {
          let left = j * row + (i == 0 ? Self.across - 1 : i - 1), right = j * row + (i == Self.across ? 1 : i + 1)
          let below = (j - 1) * row + i, above = (j + 1) * row + i
          let ax = out[right * 6] - out[left * 6], ay = out[right * 6 + 1] - out[left * 6 + 1], az = out[right * 6 + 2] - out[left * 6 + 2]
          let bx = out[above * 6] - out[below * 6], by = out[above * 6 + 1] - out[below * 6 + 1], bz = out[above * 6 + 2] - out[below * 6 + 2]
          var cx = by * az - bz * ay, cy = bz * ax - bx * az, cz = bx * ay - by * ax
          let length = max(1e-7, (cx * cx + cy * cy + cz * cz).squareRoot())
          cx /= length; cy /= length; cz /= length
          let at = (j * row + i) * 6
          out[at + 3] = cx; out[at + 4] = cy; out[at + 5] = cz
        }
      }
      // The two ends of the grid are single points: they take the mean of the ring next to them.
      for (pole, ring) in [(0, 1), (rings - 1, rings - 2)] {
        var sx: Float = 0, sy: Float = 0, sz: Float = 0
        for i in 0..<Self.across { let at = (ring * row + i) * 6; sx += out[at + 3]; sy += out[at + 4]; sz += out[at + 5] }
        let length = max(1e-7, (sx * sx + sy * sy + sz * sz).squareRoot())
        for i in 0..<row { let at = (pole * row + i) * 6; out[at + 3] = sx / length; out[at + 4] = sy / length; out[at + 5] = sz / length }
      }
    }
    let count = row * rings, stride = MemoryLayout<Float>.size * 6
    let data = buffer.withUnsafeBufferPointer { Data(buffer: $0) }
    let positions = SCNGeometrySource(data: data, semantic: .vertex, vectorCount: count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: stride)
    let normals = SCNGeometrySource(data: data, semantic: .normal, vectorCount: count, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 12, dataStride: stride)
    let geometry = SCNGeometry(sources: [positions, normals, coordinates], elements: [element])
    geometry.firstMaterial = chrome
    body.geometry = geometry
  }

  func apply(_ pose: MascotPose) {
    // Time for the parts that move on their own. When the clock stands still, so do they.
    let dt = lastClock.map { max(0, min(0.1, pose.clock - $0)) } ?? 0
    lastClock = pose.clock
    work.target = mood == .working ? 1 : 0
    spikes.target = mood == .attention ? 1 : 0
    puddle.target = mood == .asleep ? 1 : mood == .sleepy ? 0.3 : 0
    dull.target = mood == .offline ? 1 : 0
    swayX.target = -pose.roll * 1.3 + pose.yaw * 0.30 + pose.pupilX * 0.05
    swayZ.target = pose.pitch * 0.7
    jelly.target = pose.squash
    trail.target = pose.lift + pose.bob
    if dt > 0 {
      for keyPath in [\FluxScene.work, \.spikes, \.puddle, \.dull, \.swayX, \.swayZ, \.jelly, \.trail] { self[keyPath: keyPath].step(dt) }
      let speed = mood == .offline ? 0 : mood == .asleep ? 0.35 : mood == .working ? 1.7 : mood == .attention ? 1.4 : 1
      flow += dt * speed
      var turn = pose.sparkAngle - lastSpark
      if turn < -Double.pi { turn += 2 * .pi } else if turn > Double.pi { turn -= 2 * .pi }
      sparkSpeed += (turn / dt - sparkSpeed) * min(1, dt * 8)
      // The horizon light turns to the new state color in a moment, not at once.
      let blend = min(1, dt * 7)
      stateShown = (stateShown.0 + (stateTarget.0 - stateShown.0) * blend, stateShown.1 + (stateTarget.1 - stateShown.1) * blend, stateShown.2 + (stateTarget.2 - stateShown.2) * blend)
    } else {
      stateShown = stateTarget
      // No time passes: the state still shows, with no motion of its own.
      for keyPath in [\FluxScene.work, \.spikes, \.puddle, \.dull, \.swayX, \.swayZ, \.jelly, \.trail] { self[keyPath: keyPath].snap() }
    }
    lastSpark = pose.sparkAngle

    let flat = max(0, min(1, puddle.value)), grey = max(0, min(1, dull.value))
    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    let wide = 1 / sqrt(max(0.3, pose.squash))
    body.scale = SCNVector3(pose.scale * wide * (1 + 0.13 * flat), pose.scale * pose.squash * (1 - 0.24 * flat), pose.scale * wide * (1 + 0.13 * flat))
    // A drop leans more than it turns, so the face stays toward the person.
    body.eulerAngles = SCNVector3(pose.pitch * 0.9, pose.yaw * 0.78, pose.roll)
    // A pressed drop sits lower, so its base stays where it was. Asleep it sinks into a puddle.
    body.position.y = (pose.squash - 1) * 0.6 - 0.34 * flat

    if abs(grey - shownGrey) > 0.004 {
      // With no service the metal goes dull, as pewter.
      shownGrey = grey
      chrome.roughness.contents = 0.04 + 0.34 * grey
      chrome.metalness.contents = 1 - 0.5 * grey
      chrome.diffuse.contents = MascotScene.color(0xF1F3F7).blended(withFraction: grey * 0.6, of: MascotScene.color(0x7C7F86)) ?? .white
      scene.lightingEnvironment.intensity = 1.25 - 0.45 * grey
    }
    shape(pose)
    let lit = 1 - 0.8 * grey
    chrome.setValue(NSValue(scnVector3: SCNVector3(stateShown.0 * lit, stateShown.1 * lit, stateShown.2 * lit)), forKey: "stateColor")

    // The eyes take their place and their turn from the surface under them.
    buffer.withUnsafeBufferPointer { mesh in
      for (index, eye) in eyes.enumerated() {
        let at = eyePoints[index] * 6
        let place = SIMD3<Float>(mesh[at], mesh[at + 1], mesh[at + 2])
        let out = simd_normalize(SIMD3<Float>(mesh[at + 3], mesh[at + 4], mesh[at + 5]))
        eye.node.simdPosition = place + out * Float(Self.eyeRadius) * 0.42
        eye.node.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 0, 1), to: out)
        // Each pod faces a little outward with the surface. The pupil turns back in, so both eyes look the same way.
        let inward = index == 0 ? 0.5 : -0.5
        let light = pose.glow * (1 - 0.6 * grey)
        eye.apply(open: pose.eyeOpen, squint: pose.squint, lookX: max(-1, min(1, pose.pupilX * 0.8 + inward)), lookY: pose.pupilY, glow: light)
        eyeGlows[index].opacity = CGFloat((0.06 + 0.20 * light) * max(0, min(1, (pose.eyeOpen - 0.08) * 5)))
      }
    }

    // The mouth and the glint are drawn again only when they change.
    let key = [pose.smile * 30, pose.voice * 24, pose.sheen * 90].map { Int($0.rounded()) }
    if key != shownFace {
      shownFace = key
      chrome.emission.contents = face(pose)
    }

    // The droplets: the lead one carries the state, two of plain metal follow their own paths.
    let glow = CGFloat(pose.glow)
    orbit.scale = SCNVector3(pose.scale, pose.scale, pose.scale)
    orbit.eulerAngles = SCNVector3(0.36 + pose.ringWobble, 0, -0.30 + pose.roll * 0.5 + pose.ringWobble * 0.6)
    let radius = 1.74, angle = pose.sparkAngle
    lead.position = SCNVector3(radius * cos(angle), 0, radius * sin(angle))
    // A droplet stretches along its path when it is fast.
    let stretch = 1 + min(0.45, abs(sparkSpeed) * 0.07)
    lead.eulerAngles.y = -angle
    lead.scale = SCNVector3((0.8 + 0.4 * glow) / sqrt(stretch), (0.8 + 0.4 * glow) / sqrt(stretch), (0.8 + 0.4 * glow) * stretch)
    leadHalo.position = lead.position
    leadHalo.scale = SCNVector3(0.8 + 0.4 * glow, 0.8 + 0.4 * glow, 0.8 + 0.4 * glow)
    leadHalo.opacity = 0.25 + 0.75 * glow
    leadChrome.emission.intensity = 0.16 + 0.5 * glow
    let behind = angle - 0.42 - min(0.3, abs(sparkSpeed) * 0.05)
    bead.position = SCNVector3(radius * cos(behind), 0, radius * sin(behind))
    bead.eulerAngles.y = -behind
    bead.scale = SCNVector3(1 / sqrt(stretch), 1 / sqrt(stretch), stretch)
    // A third, smaller one joins the tail only when they are fast.
    let quick = max(0, min(1, (abs(sparkSpeed) - 1.2) / 2))
    let last = behind - 0.34 - min(0.3, abs(sparkSpeed) * 0.05)
    mote.position = SCNVector3(radius * cos(last), 0, radius * sin(last))
    mote.eulerAngles.y = -last
    mote.scale = SCNVector3(quick / sqrt(stretch), quick / sqrt(stretch), quick * stretch)
    mote.isHidden = quick < 0.05
  }
}
