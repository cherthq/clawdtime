import AppKit
import SceneKit
import TaskPanelCore

/// Which drawing belongs to which style.
enum MascotCatalog {
  /// The lit 3D figure of a style. A plain stone has none.
  static func make(_ style: MascotStyle) -> MascotFigure? {
    switch style {
    case .flint: return FlintScene()
    case .pebble: return MascotScene()
    case .core: return CoreScene()
    case .neon: return NeonScene()
    case .iris: return IrisScene()
    case .jet, .jade, .lapis, .amber, .garnet, .amethyst: return nil
    }
  }
  private static var thumbnails: [MascotStyle: NSImage] = [:]
  private static var plainFlint: NSImage?
  /// A small picture of a style at rest, for the menu. Each one is drawn once.
  static func thumbnail(_ style: MascotStyle, points: CGFloat = 32, flintEye: Bool = true) -> NSImage {
    // Flint has two pictures: with its eye and as the plain mark.
    let plain = style == .flint && !flintEye
    if plain, let image = plainFlint { return image }
    if !plain, let image = thumbnails[style] { return image }
    // A style with no lit figure shows its flat picture.
    guard let figure = make(style) else { return flatImage(style, points: points) }
    (figure as? FlintScene)?.showsEye = !plain
    figure.set(mood: .idle)
    var pose = MascotPose()
    // Parts that follow late get time to settle.
    for step in 0..<24 { pose.clock = 1 + Double(step) / 60; figure.apply(pose) }
    let image = figure.snapshot(pixels: points * 3)
    image.size = NSSize(width: points, height: points)
    if plain { plainFlint = image } else { thumbnails[style] = image }
    return image
  }
}

/// Shapes that the mascots are made of. All are built in code, so they are sharp
/// at every size and there is no model file to load.
enum Sculpt {
  static func power(_ value: Double, _ exponent: Double) -> Double {
    value == 0 ? 0 : (value < 0 ? -1 : 1) * pow(abs(value), exponent)
  }
  static func geometry(_ positions: [SCNVector3], _ normals: [SCNVector3], _ coordinates: [CGPoint], _ indices: [Int32]) -> SCNGeometry {
    SCNGeometry(sources: [SCNGeometrySource(vertices: positions), SCNGeometrySource(normals: normals), SCNGeometrySource(textureCoordinates: coordinates)],
      elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
  }
  private static func unit(_ v: SCNVector3) -> SCNVector3 {
    let length = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    return length < 1e-9 ? SCNVector3(0, 1, 0) : SCNVector3(v.x / length, v.y / length, v.z / length)
  }
  private static func cross(_ a: SCNVector3, _ b: SCNVector3) -> SCNVector3 {
    SCNVector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
  }

  /// A superellipsoid: a ball when both exponents are 1, a rounded box as they go
  /// toward 0, a pinched star above 1. `taper` gives the width at a height from
  /// -1 (base) to 1 (top). The texture lies flat across the front: left to right,
  /// top to base, so a face drawn on an image sits on the front of the shape.
  static func blob(half: (x: Double, y: Double, z: Double), vertical: Double = 1, around: Double = 1,
                   across: Int = 112, up: Int = 72, taper: (Double) -> Double = { _ in 1 }) -> SCNGeometry {
    func point(_ u: Double, _ v: Double) -> SCNVector3 {
      let y = half.y * power(sin(v), vertical)
      let ring = power(cos(v), vertical) * taper(y / half.y)
      return SCNVector3(half.x * ring * power(cos(u), around), y, half.z * ring * power(sin(u), around))
    }
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    let step = 0.004
    for j in 0...up {
      let v = -Double.pi / 2 + Double.pi * Double(j) / Double(up)
      for i in 0...across {
        let u = -Double.pi + 2 * Double.pi * Double(i) / Double(across)
        let p = point(u, v)
        positions.append(p)
        coordinates.append(CGPoint(x: Double(p.x) / (2 * half.x) + 0.5, y: 0.5 - Double(p.y) / (2 * half.y)))
        let a = point(u + step, v), b = point(u - step, v)
        let c = point(u, min(.pi / 2, v + step)), d = point(u, max(-.pi / 2, v - step))
        var n = cross(SCNVector3(a.x - b.x, a.y - b.y, a.z - b.z), SCNVector3(c.x - d.x, c.y - d.y, c.z - d.z))
        let length = sqrt(n.x * n.x + n.y * n.y + n.z * n.z)
        n = length < 1e-7 ? SCNVector3(0, p.y < 0 ? -1 : 1, 0) : SCNVector3(n.x / length, n.y / length, n.z / length)
        if n.x * p.x + n.y * p.y + n.z * p.z < 0 { n = SCNVector3(-n.x, -n.y, -n.z) }
        normals.append(n)
      }
    }
    var indices: [Int32] = []
    let row = Int32(across + 1)
    for j in 0..<Int32(up) { for i in 0..<Int32(across) {
      let a = j * row + i, b = a + 1, c = a + row, d = c + 1
      indices += [a, c, b, b, c, d]
    } }
    return geometry(positions, normals, coordinates, indices)
  }

  /// A surface of revolution around the vertical axis. The profile runs from the
  /// base to the top as (radius, height). Give a point twice for a hard edge.
  static func lathe(_ profile: [(r: Double, y: Double)], around: Int = 80) -> SCNGeometry {
    let count = profile.count
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    for k in 0..<count {
      var a = max(0, k - 1), b = min(count - 1, k + 1)
      if k + 1 < count, profile[k + 1] == profile[k] { b = k } else if k > 0, profile[k - 1] == profile[k] { a = k }
      var dr = profile[b].r - profile[a].r, dy = profile[b].y - profile[a].y
      let length = max(1e-9, sqrt(dr * dr + dy * dy)); dr /= length; dy /= length
      for i in 0...around {
        let angle = 2 * Double.pi * Double(i) / Double(around)
        positions.append(SCNVector3(profile[k].r * cos(angle), profile[k].y, profile[k].r * sin(angle)))
        // The outside of a profile that climbs is to the right of its direction.
        normals.append(SCNVector3(dy * cos(angle), -dr, dy * sin(angle)))
        coordinates.append(CGPoint(x: Double(i) / Double(around), y: 1 - Double(k) / Double(max(1, count - 1))))
      }
    }
    var indices: [Int32] = []
    let row = Int32(around + 1)
    for k in 0..<Int32(count - 1) { for i in 0..<Int32(around) {
      let a = k * row + i, b = a + 1, c = a + row, d = c + 1
      indices += [a, c, b, b, c, d]
    } }
    return geometry(positions, normals, coordinates, indices)
  }

  /// A round tube through the points: a tail, a cable, an antenna. `radius` takes
  /// the place along the tube, 0 at the first point and 1 at the last.
  static func tube(_ points: [SCNVector3], sides: Int = 14, radius: (Double) -> Double) -> SCNGeometry {
    let count = points.count
    guard count >= 2 else { return SCNGeometry() }
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    var side = SCNVector3(0, 0, 0)
    for k in 0..<count {
      let before = points[max(0, k - 1)], after = points[min(count - 1, k + 1)]
      let tangent = unit(SCNVector3(after.x - before.x, after.y - before.y, after.z - before.z))
      if k == 0 {
        let seed = abs(tangent.y) < 0.9 ? SCNVector3(0, 1, 0) : SCNVector3(1, 0, 0)
        side = unit(cross(tangent, seed))
      } else {
        // The frame is carried along the tube, so it never flips.
        let along = side.x * tangent.x + side.y * tangent.y + side.z * tangent.z
        side = unit(SCNVector3(side.x - tangent.x * along, side.y - tangent.y * along, side.z - tangent.z * along))
      }
      let other = cross(tangent, side)
      let t = Double(k) / Double(count - 1), r = CGFloat(max(0, radius(t)))
      for i in 0...sides {
        let angle = 2 * Double.pi * Double(i) / Double(sides)
        let c = CGFloat(cos(angle)), s = CGFloat(sin(angle))
        let n = SCNVector3(side.x * c + other.x * s, side.y * c + other.y * s, side.z * c + other.z * s)
        positions.append(SCNVector3(points[k].x + n.x * r, points[k].y + n.y * r, points[k].z + n.z * r))
        normals.append(n)
        coordinates.append(CGPoint(x: Double(i) / Double(sides), y: t))
      }
    }
    var indices: [Int32] = []
    let row = Int32(sides + 1)
    for k in 0..<Int32(count - 1) { for i in 0..<Int32(sides) {
      let a = k * row + i, b = a + 1, c = a + row, d = c + 1
      indices += [a, b, c, b, d, c]
    } }
    return geometry(positions, normals, coordinates, indices)
  }

  /// A smooth curve through the points, for a tube: `steps` points between each pair.
  static func curve(_ points: [SCNVector3], steps: Int = 8) -> [SCNVector3] {
    guard points.count >= 2 else { return points }
    var result: [SCNVector3] = []
    for k in 0..<(points.count - 1) {
      let p0 = points[max(0, k - 1)], p1 = points[k], p2 = points[k + 1], p3 = points[min(points.count - 1, k + 2)]
      for step in 0..<steps {
        let t = CGFloat(step) / CGFloat(steps), t2 = t * t, t3 = t2 * t
        func mix(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat) -> CGFloat {
          0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
        }
        result.append(SCNVector3(mix(p0.x, p1.x, p2.x, p3.x), mix(p0.y, p1.y, p2.y, p3.y), mix(p0.z, p1.z, p2.z, p3.z)))
      }
    }
    result.append(points[points.count - 1])
    return result
  }
}

/// Materials with one line each.
enum Finish {
  /// A lit surface. `coat` adds a clear, glossy layer over it, as on a toy or a car.
  static func solid(_ hex: UInt32, roughness: CGFloat = 0.4, metalness: CGFloat = 0, coat: CGFloat = 0, coatRoughness: CGFloat = 0.08) -> SCNMaterial {
    let material = SCNMaterial()
    material.lightingModel = .physicallyBased
    material.diffuse.contents = MascotScene.color(hex)
    material.roughness.contents = roughness; material.metalness.contents = metalness
    material.clearCoat.contents = coat; material.clearCoatRoughness.contents = coatRoughness
    return material
  }
  /// A surface that is its own light: a lamp, an eye of a screen, a neon line.
  static func light(_ color: NSColor = .white) -> SCNMaterial {
    let material = SCNMaterial()
    material.lightingModel = .constant; material.diffuse.contents = color
    material.isDoubleSided = true
    return material
  }
  /// A soft round glow that adds its light to what is behind it. Tint it with `multiply.contents`.
  static func halo() -> SCNMaterial {
    let material = SCNMaterial()
    material.lightingModel = .constant; material.diffuse.contents = MascotScene.halo()
    material.blendMode = .add; material.writesToDepthBuffer = false; material.isDoubleSided = true
    return material
  }
}

/// Light and camera, the same frame for every mascot: the view shows about 2.3
/// units up and down from the middle, so a body of radius 1.2 leaves room to hop.
enum Stage {
  static func camera(fieldOfView: CGFloat = 23, distance: CGFloat = 11.4, height: CGFloat = 0.04) -> SCNNode {
    let node = SCNNode()
    node.camera = SCNCamera()
    node.camera?.fieldOfView = fieldOfView; node.camera?.zNear = 1; node.camera?.zFar = 40
    node.position = SCNVector3(0, height, distance)
    return node
  }
  static func light(_ type: SCNLight.LightType, _ hex: UInt32, _ intensity: CGFloat, angles: SCNVector3 = SCNVector3(0, 0, 0)) -> SCNNode {
    let node = SCNNode()
    node.light = SCNLight(); node.light?.type = type
    node.light?.color = MascotScene.color(hex); node.light?.intensity = intensity
    node.eulerAngles = angles
    return node
  }
  /// Light that spills a little past its source, so a screen or a neon line
  /// reads as light. The ground of the view stays clear.
  static func bloom(_ camera: SCNNode, intensity: CGFloat = 0.9, threshold: CGFloat = 0.6, radius: CGFloat = 10) {
    guard let camera = camera.camera else { return }
    camera.wantsHDR = true; camera.wantsExposureAdaptation = false
    camera.bloomIntensity = intensity; camera.bloomThreshold = threshold; camera.bloomBlurRadius = radius
  }
  /// What a glossy surface reflects, as one wide image: the full turn left to right, the ceiling at the top.
  /// A dark street at night: a magenta sign on one side, a cyan sign on the other, a pale strip overhead.
  static func nightStreet() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let ground = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x05060A).cgColor, MascotScene.color(0x10121C).cgColor, MascotScene.color(0x232838).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(ground, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      func sign(_ rect: CGRect, _ hex: UInt32, _ strength: CGFloat) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: 26, color: MascotScene.color(hex, strength).cgColor)
        context.setFillColor(MascotScene.color(hex, strength).cgColor)
        context.fill(rect)
        context.restoreGState()
      }
      sign(CGRect(x: 70, y: 70, width: 26, height: 130), 0xFF2E88, 1)
      sign(CGRect(x: 410, y: 60, width: 26, height: 140), 0x19E6FF, 1)
      sign(CGRect(x: 190, y: 214, width: 130, height: 14), 0xF2F4FF, 0.9)
      sign(CGRect(x: 250, y: 40, width: 60, height: 8), 0xFFE94A, 0.7)
    }
  }
  /// A bright, soft day: a pale sky, a warm sun box, a light floor. Good for chrome and for white plastic.
  static func softDay() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let sky = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x8B8478).cgColor, MascotScene.color(0xCFCBC4).cgColor, MascotScene.color(0xDCE6F5).cgColor, MascotScene.color(0xFFFFFF).cgColor] as CFArray, locations: [0, 0.42, 0.7, 1])!
      context.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      for (center, radius, hex) in [(CGPoint(x: 140, y: 200), CGFloat(80), UInt32(0xFFF4DE)), (CGPoint(x: 390, y: 170), CGFloat(50), UInt32(0xDDE8FF))] {
        let glow = CGGradient(colorsSpace: space, colors: [MascotScene.color(hex).cgColor, MascotScene.color(hex, 0).cgColor] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
      }
    }
  }
}

/// A face made of light on a screen: two eyes that open, close, smile and look.
/// It is drawn again for each pose, and a mascot shows it on a visor as light.
struct FaceScreen {
  var width = 512, height = 256
  /// How far each eye is from the middle, as a part of half the width.
  var spacing = 0.36
  /// The size of an open eye, as a part of the height of the screen.
  var eyeWidth = 0.30, eyeHeight = 0.52
  /// 1 gives round ends, 0 gives hard corners.
  var roundness = 1.0
  /// Radians. Above 0 the inner corners go down: a hard look.
  var slant = 0.0
  /// How far the eyes travel when they look, as a part of the height.
  var travelX = 0.16, travelY = 0.12
  /// The eyes sit this far above the middle, as a part of the height.
  var raise = 0.0
  var mouth = false
  var scanlines = true
  /// The ground of the screen. With none the screen is clear where it is dark.
  var ground: NSColor?

  /// `glitch` from 0 to 1 pulls the colors apart. `extra` draws on the screen after the eyes.
  func draw(_ pose: MascotPose, tint: NSColor, glitch: Double = 0, extra: ((CGContext, CGSize) -> Void)? = nil) -> CGImage {
    MascotScene.image(width: width, height: height) { context in
      let w = CGFloat(width), h = CGFloat(height)
      if let ground { context.setFillColor(ground.cgColor); context.fill(CGRect(x: 0, y: 0, width: w, height: h)) }
      let open = CGFloat(max(0.05, min(1.3, pose.eyeOpen)))
      let squint = CGFloat(max(0, min(1, pose.squint)))
      let eyeW = CGFloat(eyeWidth) * h, full = CGFloat(eyeHeight) * h
      let eyeH = max(full * 0.09, full * open * (1 - 0.2 * squint))
      let middle = h / 2 + CGFloat(raise) * h + CGFloat(pose.pupilY * travelY) * h
      func eyes(shift: CGFloat, color: NSColor, glow: Bool) {
        for side in [CGFloat(-1), 1] {
          let x = w / 2 + side * CGFloat(spacing) * w / 2 + CGFloat(pose.pupilX * travelX) * h + shift
          context.saveGState()
          context.translateBy(x: x, y: middle); context.rotate(by: -side * CGFloat(slant))
          if glow { context.setShadow(offset: .zero, blur: h * 0.085, color: color.withAlphaComponent(0.95).cgColor) }
          context.beginTransparencyLayer(auxiliaryInfo: nil)
          let radius = min(eyeW, eyeH) / 2 * CGFloat(roundness)
          context.addPath(CGPath(roundedRect: CGRect(x: -eyeW / 2, y: -eyeH / 2, width: eyeW, height: eyeH), cornerWidth: radius, cornerHeight: radius, transform: nil))
          context.setFillColor(color.cgColor); context.fillPath()
          if squint > 0.05 {
            // A smile in the eyes: the lower lid comes up as an arc.
            let circle = eyeW * 0.95
            context.setBlendMode(.destinationOut); context.setFillColor(NSColor.black.cgColor)
            context.fillEllipse(in: CGRect(x: -circle, y: -eyeH / 2 + squint * eyeH * 0.62 - circle * 2, width: circle * 2, height: circle * 2))
          }
          context.endTransparencyLayer()
          context.restoreGState()
        }
      }
      if glitch > 0.01 {
        let apart = CGFloat(glitch) * h * 0.06
        context.setBlendMode(.screen)
        eyes(shift: -apart, color: MascotScene.color(0xFF2E88, 0.85), glow: false)
        eyes(shift: apart, color: MascotScene.color(0x19E6FF, 0.85), glow: false)
        context.setBlendMode(.normal)
      }
      eyes(shift: 0, color: tint, glow: true)
      if mouth {
        // A short line that curves with the smile and opens with the voice.
        let smile = CGFloat(max(0, min(1, pose.smile))), talk = CGFloat(max(0, min(1, pose.voice)))
        let half = h * (0.07 + 0.06 * smile), y = middle - full * 0.5 - h * 0.13
        context.saveGState()
        context.setShadow(offset: .zero, blur: h * 0.06, color: tint.withAlphaComponent(0.9).cgColor)
        if talk > 0.04 {
          context.setFillColor(tint.cgColor)
          context.fillEllipse(in: CGRect(x: w / 2 - half, y: y - h * 0.09 * talk - h * 0.02, width: half * 2, height: h * 0.18 * talk + h * 0.04))
        } else {
          context.setStrokeColor(tint.cgColor); context.setLineWidth(h * 0.04); context.setLineCap(.round)
          context.move(to: CGPoint(x: w / 2 - half, y: y))
          context.addQuadCurve(to: CGPoint(x: w / 2 + half, y: y), control: CGPoint(x: w / 2, y: y - h * 0.16 * smile))
          context.strokePath()
        }
        context.restoreGState()
      }
      extra?(context, CGSize(width: w, height: h))
      if scanlines {
        // Fine dark rows, as on a screen of small lamps.
        context.setBlendMode(ground == nil ? .destinationOut : .normal)
        context.setFillColor(NSColor.black.withAlphaComponent(0.26).cgColor)
        var y: CGFloat = 0
        while y < h { context.fill(CGRect(x: 0, y: y, width: w, height: 1.6)); y += 5 }
        context.setBlendMode(.normal)
      }
    }
  }
}
