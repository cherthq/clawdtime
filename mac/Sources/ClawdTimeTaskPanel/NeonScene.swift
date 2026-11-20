import AppKit
import SceneKit
import TaskPanelCore

/// The shell of Neon's head: a box with round corners, narrower at the jaw.
/// Plates, the visor and the small parts all take their place from it.
private enum NeonShell {
  static let half = (x: 1.16, y: 0.93, z: 0.98)
  static let vertical = 0.5, around = 0.56
  static func taper(_ t: Double) -> Double { t >= 0 ? 1 : 1 - 0.23 * pow(-t, 1.4) }

  /// The point of the surface at a turn from the front (positive to the viewer's right) and a height.
  static func point(turn: Double, y: Double) -> SCNVector3 {
    let t = max(-1, min(1, y / half.y))
    let v = asin(Sculpt.power(t, 1 / vertical))
    let ring = Sculpt.power(cos(v), vertical) * taper(t)
    return SCNVector3(half.x * ring * Sculpt.power(sin(turn), around), y, half.z * ring * Sculpt.power(cos(turn), around))
  }
  static func normal(turn: Double, y: Double) -> SCNVector3 {
    let h = 0.004
    let a = point(turn: turn + h, y: y), b = point(turn: turn - h, y: y)
    let c = point(turn: turn, y: min(half.y * 0.999, y + h)), d = point(turn: turn, y: max(-half.y * 0.999, y - h))
    let tu = SCNVector3(a.x - b.x, a.y - b.y, a.z - b.z), tv = SCNVector3(c.x - d.x, c.y - d.y, c.z - d.z)
    var n = SCNVector3(tu.y * tv.z - tu.z * tv.y, tu.z * tv.x - tu.x * tv.z, tu.x * tv.y - tu.y * tv.x)
    let length = sqrt(n.x * n.x + n.y * n.y + n.z * n.z)
    if length < 1e-9 { return SCNVector3(0, 0, 1) }
    n = SCNVector3(n.x / length, n.y / length, n.z / length)
    let p = point(turn: turn, y: y)
    if n.x * p.x + n.z * p.z < 0 { n = SCNVector3(-n.x, -n.y, -n.z) }
    return n
  }

  /// Distance around the shell for each turn. A plate is laid out by distance,
  /// so a picture on it is not stretched where the shell is flat.
  private static let table: (turns: [Double], lengths: [Double]) = {
    var turns: [Double] = [], lengths: [Double] = []
    var total = 0.0
    var last = point(turn: -Double.pi, y: 0.1)
    let count = 1440
    for index in 0...count {
      let turn = -Double.pi + 2 * Double.pi * Double(index) / Double(count)
      let p = point(turn: turn, y: 0.1)
      let dx = Double(p.x - last.x), dz = Double(p.z - last.z)
      total += sqrt(dx * dx + dz * dz); last = p
      turns.append(turn); lengths.append(total)
    }
    return (turns, lengths)
  }()
  static func length(atTurn turn: Double) -> Double {
    let place = (turn + Double.pi) / (2 * Double.pi) * Double(table.turns.count - 1)
    let index = max(0, min(table.turns.count - 2, Int(place)))
    let part = place - Double(index)
    return table.lengths[index] + (table.lengths[index + 1] - table.lengths[index]) * part
  }
  /// Distance along the shell from the middle of the face to a turn.
  static func reach(_ turn: Double) -> Double { length(atTurn: turn) - length(atTurn: 0) }
  static func turn(atLength length: Double) -> Double {
    var low = 0, high = table.lengths.count - 1
    while high - low > 1 {
      let middle = (low + high) / 2
      if table.lengths[middle] < length { low = middle } else { high = middle }
    }
    let span = max(1e-9, table.lengths[high] - table.lengths[low])
    return table.turns[low] + (table.turns[high] - table.turns[low]) * (length - table.lengths[low]) / span
  }

  /// A plate that lies on the shell, `lift` above it. `top` and `bottom` give its
  /// edges from -1 at its left end to 1 at its right end. The picture on it runs
  /// left to right, and from `frame.top` down to `frame.bottom`.
  static func plate(from: Double, to: Double, lift: Double, frame: (top: Double, bottom: Double),
                    columns: Int = 72, rows: Int = 10, top: (Double) -> Double, bottom: (Double) -> Double) -> SCNGeometry {
    let start = length(atTurn: from), end = length(atTurn: to)
    var positions: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
    for i in 0...columns {
      let part = Double(i) / Double(columns)
      let turn = self.turn(atLength: start + (end - start) * part)
      let high = top(part * 2 - 1), low = bottom(part * 2 - 1)
      for j in 0...rows {
        let y = high + (low - high) * Double(j) / Double(rows)
        let p = point(turn: turn, y: y), n = normal(turn: turn, y: y)
        positions.append(SCNVector3(p.x + n.x * CGFloat(lift), p.y + n.y * CGFloat(lift), p.z + n.z * CGFloat(lift)))
        normals.append(n)
        coordinates.append(CGPoint(x: part, y: (frame.top - y) / (frame.top - frame.bottom)))
      }
    }
    var indices: [Int32] = []
    let column = Int32(rows + 1)
    for i in 0..<Int32(columns) { for j in 0..<Int32(rows) {
      let a = i * column + j, b = a + column, c = a + 1, d = b + 1
      indices += [a, c, b, b, c, d]
    } }
    return Sculpt.geometry(positions, normals, coordinates, indices)
  }

  /// The visor: wide, flat on top, cut up toward the temples.
  static let visorTurn = 1.18
  static let visorFrame = (top: 0.45, bottom: -0.25)
  static func visorTop(_ across: Double) -> Double {
    let edge = abs(across)
    return edge < 0.78 ? 0.45 : 0.45 - (edge - 0.78) / 0.22 * 0.16
  }
  static func visorBottom(_ across: Double) -> Double {
    let edge = abs(across)
    return edge < 0.42 ? -0.25 : -0.25 + (edge - 0.42) / 0.58 * 0.34
  }
}

/// Neon: a droid head from a street at night. Black chrome that mirrors the
/// signs, acid yellow armor with hazard stripes, and a dark visor with eyes of
/// light. The light is the state, and it glitches when the state changes.
final class NeonScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  private let root = SCNNode()
  private let head = SCNNode()
  private let collar = SCNNode()
  private let hud = SCNNode(), ticks = SCNNode(), marker = SCNNode()
  private let spin = SCNNode()
  private let aura = SCNNode(), thrust = SCNNode(), thrustCore = SCNNode()
  private var blades: [SCNNode] = []
  private var bars: [SCNNode] = []
  private var earHalos: [SCNNode] = []
  private var whip: [SCNNode] = []

  private let chrome = Finish.solid(0x30333D, roughness: 0.2, metalness: 1, coat: 0.7, coatRoughness: 0.06)
  private let gunmetal = Finish.solid(0x1B1D24, roughness: 0.34, metalness: 0.9, coat: 0.3)
  private let rubber = Finish.solid(0x101116, roughness: 0.7)
  private let glass = Finish.solid(0x04060B, roughness: 0.05, coat: 1, coatRoughness: 0.03)
  private let armor = Finish.solid(0xF5DF1D, roughness: 0.36, coat: 0.6, coatRoughness: 0.12)
  private let cheek = Finish.solid(0xF5DF1D, roughness: 0.36, coat: 0.6, coatRoughness: 0.12)
  private let cheekMirror = Finish.solid(0xF5DF1D, roughness: 0.36, coat: 0.6, coatRoughness: 0.12)
  private let stripe = Finish.solid(0xF5DF1D, roughness: 0.4, coat: 0.4)
  private let paint = Finish.solid(0xF5DF1D, roughness: 0.36, coat: 0.6, coatRoughness: 0.12)
  private let mask = Finish.solid(0x8A91A3, roughness: 0.34, metalness: 1)
  private let wire = Finish.solid(0xA7AEC0, roughness: 0.3, metalness: 1)
  private let lamp = Finish.light(), lampSoft = Finish.light(), hudLight = Finish.light()
  private let auraHalo = Finish.halo(), lampHalo = Finish.halo()
  private let roll = SCNMaterial()

  private var mood = MascotMood.idle
  private var tint = MascotScene.color(0x19E6FF)
  private var lastClock = 0.0
  private var changePending = false
  private var changeClock = -10.0
  private var followYaw = Spring(0, response: 0.42, dampingRatio: 0.34)
  private var followRoll = Spring(0, response: 0.42, dampingRatio: 0.34)
  private var followRise = Spring(0, response: 0.40, dampingRatio: 0.36)
  private var followScale = Spring(1, response: 0.46, dampingRatio: 0.38)

  private let faceWidth = 512
  private let faceHeight: Int
  private var faceKey: [Int] = []

  /// The whole figure, scaled to fill the frame and still leave room to hop.
  private static let size: CGFloat = 1.12
  private static let headHeight = 0.16
  private static let collarHeight = -1.36
  private static let hudRadius: CGFloat = 1.42

  // MARK: pictures

  private static func write(_ string: String, size: CGFloat, color: NSColor, at point: CGPoint, in context: CGContext, heavy: Bool = false) {
    let previous = NSGraphicsContext.current
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    let font = heavy ? (NSFont(name: "HelveticaNeue-CondensedBlack", size: size) ?? NSFont.systemFont(ofSize: size, weight: .black))
      : NSFont.monospacedSystemFont(ofSize: size, weight: .bold)
    (string as NSString).draw(at: point, withAttributes: [.font: font, .foregroundColor: color])
    NSGraphicsContext.current = previous
  }
  private static func stripes(in rect: CGRect, step: CGFloat, color: NSColor, context: CGContext) {
    context.saveGState()
    context.clip(to: rect)
    context.setFillColor(color.cgColor)
    var x = rect.minX - rect.height
    while x < rect.maxX + rect.height {
      context.move(to: CGPoint(x: x, y: rect.minY)); context.addLine(to: CGPoint(x: x + step * 0.5, y: rect.minY))
      context.addLine(to: CGPoint(x: x + step * 0.5 + rect.height, y: rect.maxY)); context.addLine(to: CGPoint(x: x + rect.height, y: rect.maxY))
      context.closePath(); context.fillPath()
      x += step
    }
    context.restoreGState()
  }
  /// The brow plate: acid yellow, a stencil name, a code, a hazard block.
  private static func browPlate() -> CGImage {
    MascotScene.image(width: 512, height: 128) { context in
      let ink = MascotScene.color(0x0B0C10)
      context.setFillColor(MascotScene.color(0xF5DF1D).cgColor); context.fill(CGRect(x: 0, y: 0, width: 512, height: 128))
      // Paint that is a little darker toward the edge reads as a real plate.
      let shade = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [MascotScene.color(0x8A6A00, 0.35).cgColor, MascotScene.color(0x8A6A00, 0).cgColor] as CFArray, locations: [0, 1])!
      context.drawLinearGradient(shade, start: .zero, end: CGPoint(x: 0, y: 30), options: [])
      stripes(in: CGRect(x: 356, y: 0, width: 96, height: 128), step: 30, color: ink, context: context)
      write("CLWD-01", size: 50, color: ink, at: CGPoint(x: 76, y: 4), in: context, heavy: true)
      // One thin cut through the letters, as a stencil leaves.
      context.setFillColor(MascotScene.color(0xF5DF1D).cgColor); context.fill(CGRect(x: 72, y: 17, width: 190, height: 3))
      write("SUPERVISOR UNIT", size: 11, color: ink, at: CGPoint(x: 78, y: 60), in: context)
      context.setFillColor(ink.cgColor)
      var x: CGFloat = 292
      for width in [3, 1, 2, 1, 4, 1, 1, 3, 2, 1, 3, 1, 2] as [CGFloat] { context.fill(CGRect(x: x, y: 8, width: width, height: 34)); x += width + 2.5 }
      context.fill(CGRect(x: 0, y: 122, width: 512, height: 6))
    }
  }
  private static func cheekPlate() -> CGImage {
    MascotScene.image(width: 128, height: 128) { context in
      let ink = MascotScene.color(0x0B0C10)
      context.setFillColor(MascotScene.color(0xF5DF1D).cgColor); context.fill(CGRect(x: 0, y: 0, width: 128, height: 128))
      context.setStrokeColor(ink.cgColor); context.setLineWidth(11); context.setLineJoin(.miter)
      for x in [34, 62, 90] as [CGFloat] {
        context.move(to: CGPoint(x: x - 12, y: 84)); context.addLine(to: CGPoint(x: x + 8, y: 62)); context.addLine(to: CGPoint(x: x - 12, y: 40))
        context.strokePath()
      }
      context.setFillColor(ink.cgColor); context.fill(CGRect(x: 0, y: 0, width: 128, height: 14))
    }
  }
  /// The jaw mask: bare metal with a few small marks, as on a machine part.
  private static func maskPaint() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let ink = MascotScene.color(0x15171D), yellow = MascotScene.color(0xF5DF1D)
      context.setFillColor(MascotScene.color(0x8A91A3).cgColor); context.fill(CGRect(x: 0, y: 0, width: 512, height: 256))
      // A line and a word over the mouth.
      context.setFillColor(yellow.cgColor); context.fill(CGRect(x: 150, y: 141, width: 44, height: 5))
      write("VOX", size: 13, color: ink, at: CGPoint(x: 200, y: 135), in: context)
      context.setFillColor(ink.cgColor)
      for index in 0..<5 { context.fill(CGRect(x: 244 + CGFloat(index) * 9, y: 140, width: 5, height: 7)) }
      context.setFillColor(yellow.cgColor); context.fill(CGRect(x: 300, y: 141, width: 62, height: 5))
      // Under the mouth: a number and a small arrow down.
      write("02", size: 20, color: ink, at: CGPoint(x: 196, y: 14), in: context, heavy: true)
      context.setFillColor(yellow.cgColor)
      context.move(to: CGPoint(x: 246, y: 36)); context.addLine(to: CGPoint(x: 266, y: 36)); context.addLine(to: CGPoint(x: 256, y: 20)); context.closePath(); context.fillPath()
      context.setFillColor(ink.cgColor); context.fill(CGRect(x: 276, y: 20, width: 40, height: 3)); context.fill(CGRect(x: 276, y: 28, width: 26, height: 3))
    }
  }
  private static func hazardBand() -> CGImage {
    MascotScene.image(width: 64, height: 32) { context in
      context.setFillColor(MascotScene.color(0xF5DF1D).cgColor); context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
      stripes(in: CGRect(x: 0, y: 0, width: 64, height: 32), step: 32, color: MascotScene.color(0x0B0C10), context: context)
    }
  }
  /// What the chrome mirrors: a dark street with a magenta sign at the viewer's
  /// left, a cyan sign at the right and a pale strip overhead. The part in front
  /// of the face stays dark, so the glass of the visor is clear over the eyes.
  private static func street() -> CGImage {
    MascotScene.image(width: 512, height: 256) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let ground = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x040509).cgColor, MascotScene.color(0x0C0E16).cgColor, MascotScene.color(0x1C2030).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(ground, start: .zero, end: CGPoint(x: 0, y: 256), options: [])
      func sign(_ rect: CGRect, _ hex: UInt32, _ strength: CGFloat, blur: CGFloat = 22) {
        context.saveGState()
        context.setShadow(offset: .zero, blur: blur, color: MascotScene.color(hex, strength).cgColor)
        context.setFillColor(MascotScene.color(hex, strength).cgColor)
        context.fill(rect)
        context.restoreGState()
      }
      // Left of the viewer is the middle of the picture; right is its two ends; the front is at one quarter.
      sign(CGRect(x: 238, y: 64, width: 34, height: 150), 0xFF2E88, 1)
      sign(CGRect(x: 318, y: 96, width: 16, height: 90), 0xFF2E88, 0.8)
      sign(CGRect(x: 0, y: 64, width: 17, height: 150), 0x19E6FF, 1)
      sign(CGRect(x: 495, y: 64, width: 17, height: 150), 0x19E6FF, 1)
      sign(CGRect(x: 438, y: 96, width: 16, height: 90), 0x19E6FF, 0.8)
      sign(CGRect(x: 372, y: 120, width: 26, height: 40), 0xFFC21A, 0.7)
      // Overhead and a little in front: the long highlight on the crown and the brow.
      sign(CGRect(x: 60, y: 226, width: 140, height: 14), 0xEEF2FF, 0.95, blur: 16)
      // Low in front: the glow of the street on the jaw.
      sign(CGRect(x: 96, y: 22, width: 70, height: 8), 0x8A7CFF, 0.45, blur: 30)
    }
  }
  /// The shell is darker toward the jaw and has two seams, so it reads as built of panels.
  private static func shellPaint() -> CGImage {
    MascotScene.image(width: 8, height: 512) { context in
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      let fade = CGGradient(colorsSpace: space, colors: [MascotScene.color(0x1C1E26).cgColor, MascotScene.color(0x30333D).cgColor, MascotScene.color(0x3C404C).cgColor] as CFArray, locations: [0, 0.5, 1])!
      context.drawLinearGradient(fade, start: .zero, end: CGPoint(x: 0, y: 512), options: [])
      context.setFillColor(MascotScene.color(0x050608).cgColor)
      for height in [-0.36, 0.5] {
        let y = CGFloat((height / NeonShell.half.y + 1) / 2 * 512)
        context.fill(CGRect(x: 0, y: y - 2, width: 8, height: 4))
      }
    }
  }

  // MARK: parts

  private static func polygon(_ points: [(Double, Double)], mirror: Bool) -> NSBezierPath {
    let path = NSBezierPath()
    for (index, point) in points.enumerated() {
      let p = NSPoint(x: mirror ? -point.0 : point.0, y: point.1)
      if index == 0 { path.move(to: p) } else { path.line(to: p) }
    }
    path.close()
    return path
  }
  private static func slab(_ points: [(Double, Double)], mirror: Bool, depth: CGFloat, _ material: SCNMaterial, chamfer: CGFloat = 0) -> SCNNode {
    let shape = SCNShape(path: polygon(points, mirror: mirror), extrusionDepth: depth)
    shape.chamferRadius = chamfer
    shape.firstMaterial = material
    return SCNNode(geometry: shape)
  }
  private static func band(inner: CGFloat, outer: CGFloat, start: CGFloat, sweep: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    path.appendArc(withCenter: .zero, radius: outer, startAngle: start, endAngle: start + sweep)
    path.appendArc(withCenter: .zero, radius: inner, startAngle: start + sweep, endAngle: start, clockwise: true)
    path.close()
    return path
  }
  private static func flat(_ paths: [NSBezierPath], _ material: SCNMaterial) -> SCNGeometry {
    let all = NSBezierPath()
    for path in paths { all.append(path) }
    all.flatness = 0.002
    let shape = SCNShape(path: all, extrusionDepth: 0.006)
    shape.firstMaterial = material
    return shape
  }

  init() {
    // The picture on the visor keeps square dots: its height follows the real size of the glass.
    let wide = NeonShell.length(atTurn: NeonShell.visorTurn) - NeonShell.length(atTurn: -NeonShell.visorTurn)
    faceHeight = max(96, min(200, Int((Double(faceWidth) * (NeonShell.visorFrame.top - NeonShell.visorFrame.bottom) / wide).rounded())))

    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = Self.street()
    scene.lightingEnvironment.intensity = 1.8
    scene.rootNode.addChildNode(root)

    // Light that carries the state, behind everything.
    aura.geometry = SCNPlane(width: 5.2, height: 5.2); aura.geometry?.firstMaterial = auraHalo
    aura.position = SCNVector3(0, 0, -1.6)
    root.addChildNode(aura)

    // A ring of marks behind the head, as on a display in the air.
    for material in [hudLight, lamp, lampSoft] { material.writesToDepthBuffer = true }
    let r = Self.hudRadius
    let marks = (0..<72).compactMap { index -> NSBezierPath? in
      let angle = CGFloat(index) * 5
      let fromSide = min(abs(angle.truncatingRemainder(dividingBy: 180)), 180 - abs(angle.truncatingRemainder(dividingBy: 180)))
      if fromSide < 36 { return nil }
      let long = index % 6 == 0
      return Self.band(inner: long ? r - 0.09 : r - 0.04, outer: r, start: angle - 0.5, sweep: 1.0)
    }
    ticks.geometry = Self.flat(marks, hudLight)
    let brackets = SCNNode(geometry: Self.flat([Self.band(inner: r - 0.03, outer: r + 0.01, start: -30, sweep: 60), Self.band(inner: r - 0.03, outer: r + 0.01, start: 150, sweep: 60),
      Self.band(inner: r + 0.06, outer: r + 0.075, start: -18, sweep: 36), Self.band(inner: r + 0.06, outer: r + 0.075, start: 162, sweep: 36)], hudLight))
    marker.geometry = SCNShape(path: Self.polygon([(-0.085, 0.07), (0.085, 0.07), (0, -0.09)], mirror: false), extrusionDepth: 0.008)
    marker.geometry?.firstMaterial = lamp
    let markerHalo = SCNNode(geometry: SCNPlane(width: 0.8, height: 0.8)); markerHalo.geometry?.firstMaterial = lampHalo
    markerHalo.position = SCNVector3(0, 0, 0.01)
    marker.addChildNode(markerHalo)
    for node in [ticks, brackets, marker] { hud.addChildNode(node) }
    hud.position = SCNVector3(0, 0.02, -0.7)
    root.addChildNode(hud)

    // The head.
    chrome.diffuse.contents = Self.shellPaint()
    chrome.emission.contents = MascotScene.sheenBand(); chrome.emission.wrapT = .clampToBorder; chrome.emission.intensity = 0
    let shell = SCNNode(geometry: Sculpt.blob(half: NeonShell.half, vertical: NeonShell.vertical, around: NeonShell.around, taper: NeonShell.taper))
    shell.geometry?.firstMaterial = chrome
    head.addChildNode(shell)

    // The visor, in a frame that stands a little proud of the shell.
    let frame = SCNNode(geometry: NeonShell.plate(from: -NeonShell.visorTurn - 0.07, to: NeonShell.visorTurn + 0.07, lift: 0.014,
      frame: (top: 0.52, bottom: -0.32), columns: 84, rows: 10,
      top: { NeonShell.visorTop($0 * 0.96) + 0.055 }, bottom: { NeonShell.visorBottom($0 * 0.96) - 0.055 }))
    frame.geometry?.firstMaterial = gunmetal
    head.addChildNode(frame)
    let visor = SCNNode(geometry: NeonShell.plate(from: -NeonShell.visorTurn, to: NeonShell.visorTurn, lift: 0.034,
      frame: NeonShell.visorFrame, columns: 96, rows: 12, top: NeonShell.visorTop, bottom: NeonShell.visorBottom))
    glass.emission.intensity = 1
    visor.geometry?.firstMaterial = glass
    head.addChildNode(visor)

    // A soft line of light rolls down the glass, as on an old screen. It is one
    // more plate over the visor, and only its picture moves.
    roll.lightingModel = .constant; roll.blendMode = .add; roll.writesToDepthBuffer = false
    roll.diffuse.contents = MascotScene.image(width: 8, height: 128) { context in
      context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: 8, height: 128))
      let band = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [NSColor.black.cgColor, NSColor(white: 0.34, alpha: 1).cgColor, NSColor.black.cgColor] as CFArray, locations: [0, 0.6, 1])!
      context.drawLinearGradient(band, start: CGPoint(x: 0, y: 48), end: CGPoint(x: 0, y: 80), options: [])
    }
    roll.diffuse.wrapT = .clamp
    let rolling = SCNNode(geometry: NeonShell.plate(from: -NeonShell.visorTurn, to: NeonShell.visorTurn, lift: 0.04,
      frame: NeonShell.visorFrame, columns: 48, rows: 6, top: NeonShell.visorTop, bottom: NeonShell.visorBottom))
    rolling.geometry?.firstMaterial = roll
    head.addChildNode(rolling)

    // Armor: a brow plate with the name, and one plate on each side of the jaw.
    let browPicture = Self.browPlate()
    armor.diffuse.contents = browPicture
    armor.emission.contents = browPicture; armor.emission.intensity = 0.16
    paint.emission.contents = MascotScene.color(0xF5DF1D); paint.emission.intensity = 0.2
    let brow = SCNNode(geometry: NeonShell.plate(from: -0.86, to: 0.86, lift: 0.036, frame: (top: 0.9, bottom: 0.535), columns: 64, rows: 12,
      top: { abs($0) < 0.62 ? 0.9 : 0.9 - (abs($0) - 0.62) / 0.38 * 0.17 },
      bottom: { abs($0) < 0.8 ? 0.535 : 0.535 + (abs($0) - 0.8) / 0.2 * 0.09 }))
    brow.geometry?.firstMaterial = armor
    head.addChildNode(brow)
    let cheekPicture = Self.cheekPlate()
    cheek.diffuse.contents = cheekPicture
    cheekMirror.diffuse.contents = cheekPicture
    cheekMirror.diffuse.wrapS = .repeat
    cheekMirror.diffuse.contentsTransform = SCNMatrix4Translate(SCNMatrix4MakeScale(-1, 1, 1), 1, 0, 0)
    for side in [-1.0, 1.0] {
      let from = side > 0 ? 0.9 : -1.34, to = side > 0 ? 1.34 : -0.9
      let plate = SCNNode(geometry: NeonShell.plate(from: from, to: to, lift: 0.03, frame: (top: -0.36, bottom: -0.8), columns: 24, rows: 8,
        top: { -0.40 + ($0 * side) * 0.035 }, bottom: { -0.80 + (($0 * side) + 1) * 0.11 }))
      plate.geometry?.firstMaterial = side > 0 ? cheek : cheekMirror
      head.addChildNode(plate)
    }

    // A mask over the jaw, and in it a row of small lamps: the mouth. A voice moves them.
    let maskTurn = 0.86
    let ratio = NeonShell.reach(maskTurn) / NeonShell.reach(NeonShell.visorTurn)
    let jaw = SCNNode(geometry: NeonShell.plate(from: -maskTurn, to: maskTurn, lift: 0.03, frame: (top: -0.1, bottom: -0.84), columns: 56, rows: 10,
      top: { NeonShell.visorBottom($0 * ratio) - 0.1 }, bottom: { abs($0) < 0.4 ? -0.84 : -0.84 + (abs($0) - 0.4) / 0.6 * 0.42 }))
    mask.diffuse.contents = Self.maskPaint()
    jaw.geometry?.firstMaterial = mask
    head.addChildNode(jaw)
    let slotTurn = NeonShell.turn(atLength: NeonShell.length(atTurn: 0) + 0.47)
    let slot = SCNNode(geometry: NeonShell.plate(from: -slotTurn, to: slotTurn, lift: 0.04, frame: (top: -0.48, bottom: -0.68), columns: 28, rows: 4,
      top: { abs($0) < 0.8 ? -0.48 : -0.48 - (abs($0) - 0.8) / 0.2 * 0.06 }, bottom: { abs($0) < 0.8 ? -0.68 : -0.68 + (abs($0) - 0.8) / 0.2 * 0.06 }))
    slot.geometry?.firstMaterial = rubber
    head.addChildNode(slot)
    for index in 0..<9 {
      let turn = NeonShell.turn(atLength: NeonShell.length(atTurn: 0) + Double(index - 4) * 0.085)
      let p = NeonShell.point(turn: turn, y: -0.58), n = NeonShell.normal(turn: turn, y: -0.58)
      let bar = SCNNode(geometry: SCNBox(width: 0.045, height: 0.17, length: 0.03, chamferRadius: 0.012))
      bar.geometry?.firstMaterial = lampSoft
      bar.position = SCNVector3(p.x + n.x * 0.045, p.y, p.z + n.z * 0.045)
      bar.eulerAngles.y = CGFloat(atan2(Double(n.x), Double(n.z)))
      head.addChildNode(bar); bars.append(bar)
    }
    // Three slanted vents on each side of the mouth.
    for side in [-1.0, 1.0] {
      for index in 0..<3 {
        let turn = NeonShell.turn(atLength: NeonShell.length(atTurn: 0) + side * (0.6 + Double(index) * 0.09))
        let p = NeonShell.point(turn: turn, y: -0.575), n = NeonShell.normal(turn: turn, y: -0.575)
        let vent = SCNNode(geometry: SCNBox(width: 0.034, height: 0.23 - CGFloat(index) * 0.03, length: 0.02, chamferRadius: 0.008))
        vent.geometry?.firstMaterial = rubber
        vent.position = SCNVector3(p.x + n.x * 0.034, p.y, p.z + n.z * 0.034)
        vent.eulerAngles = SCNVector3(0, CGFloat(atan2(Double(n.x), Double(n.z))), CGFloat(-side * 0.5))
        head.addChildNode(vent)
      }
    }

    // Ear pods with a lit band, and a blade antenna on each.
    stripe.diffuse.contents = Self.hazardBand()
    stripe.diffuse.wrapS = .repeat; stripe.diffuse.contentsTransform = SCNMatrix4MakeScale(10, 1, 1)
    for side in [-1.0, 1.0] {
      let pod = SCNNode()
      pod.position = SCNVector3(side * 1.07, 0.08, -0.04)
      pod.eulerAngles.z = CGFloat(-side * Double.pi / 2)
      let body = SCNNode(geometry: Sculpt.lathe([(0.0, 0), (0.37, 0), (0.37, 0), (0.37, 0.13), (0.37, 0.13), (0.31, 0.2), (0.31, 0.2), (0.0, 0.2)], around: 56))
      body.geometry?.firstMaterial = gunmetal
      let lit = SCNNode(geometry: Sculpt.lathe([(0.376, 0.05), (0.376, 0.1)], around: 56))
      lit.geometry?.firstMaterial = lamp
      let cap = SCNNode(geometry: Sculpt.lathe([(0.24, 0.203), (0.0, 0.203)], around: 40))
      cap.geometry?.firstMaterial = paint
      let dot = SCNNode(geometry: Sculpt.lathe([(0.08, 0.207), (0.0, 0.207)], around: 24))
      dot.geometry?.firstMaterial = lamp
      for node in [body, lit, cap, dot] { pod.addChildNode(node) }
      let glow = SCNNode(geometry: SCNPlane(width: 1.3, height: 1.5)); glow.geometry?.firstMaterial = lampHalo
      glow.position = SCNVector3(side * 1.26, 0.08, -0.06)
      head.addChildNode(glow); earHalos.append(glow)
      head.addChildNode(pod)

      let mirror = side < 0
      let blade = SCNNode()
      blade.position = SCNVector3(side * 1.2, 0.34, -0.06)
      let fin = Self.slab([(-0.13, 0), (0.12, 0), (0.2, 0.45), (0.33, 1.2), (0.24, 1.2), (0.03, 0.5), (-0.13, 0.28)], mirror: mirror, depth: 0.06, gunmetal, chamfer: 0.012)
      let tip = Self.slab([(0.166, 0.94), (0.285, 0.94), (0.335, 1.215), (0.236, 1.215)], mirror: mirror, depth: 0.075, paint)
      let mark = Self.slab([(0.136, 0.85), (0.268, 0.85), (0.275, 0.9), (0.152, 0.9)], mirror: mirror, depth: 0.07, rubber)
      let edge = Self.slab([(0.168, 0.47), (0.2, 0.47), (0.262, 0.83), (0.232, 0.83)], mirror: mirror, depth: 0.068, lamp)
      for node in [fin, tip, mark, edge] { blade.addChildNode(node) }
      head.addChildNode(blade); blades.append(blade)
    }

    // One thin whip antenna, off to one side. It bends more toward its tip.
    var parent = head
    for index in 0..<3 {
      let joint = SCNNode()
      joint.position = index == 0 ? SCNVector3(0.72, 0.8, -0.34) : SCNVector3(0, 0.24, 0)
      let link = SCNNode(geometry: SCNCapsule(capRadius: 0.017 - CGFloat(index) * 0.003, height: 0.26))
      link.geometry?.firstMaterial = wire
      link.position = SCNVector3(0, 0.12, 0)
      joint.addChildNode(link)
      parent.addChildNode(joint); parent = joint
      whip.append(joint)
    }
    let foot = SCNNode(geometry: Sculpt.lathe([(0.0, -0.03), (0.07, -0.03), (0.07, -0.03), (0.05, 0.03), (0.05, 0.03), (0.0, 0.03)], around: 24))
    foot.geometry?.firstMaterial = gunmetal
    whip[0].addChildNode(foot)
    let bead = SCNNode(geometry: SCNSphere(radius: 0.042)); bead.geometry?.firstMaterial = lamp
    bead.position = SCNVector3(0, 0.26, 0)
    let beadHalo = SCNNode(geometry: SCNPlane(width: 0.5, height: 0.5)); beadHalo.geometry?.firstMaterial = lampHalo
    beadHalo.constraints = [SCNBillboardConstraint()]
    bead.addChildNode(beadHalo)
    whip[2].addChildNode(bead)

    // Under the head a short nozzle with a lamp in it: this is what holds it up.
    let nozzle = SCNNode(geometry: Sculpt.lathe([(0.0, -1.1), (0.2, -1.1), (0.2, -1.1), (0.28, -1.04), (0.28, -1.04), (0.3, -0.98), (0.3, -0.98), (0.44, -0.9), (0.6, -0.8)], around: 48))
    nozzle.geometry?.firstMaterial = rubber
    head.addChildNode(nozzle)
    thrustCore.geometry = SCNSphere(radius: 0.17); thrustCore.geometry?.firstMaterial = lamp
    thrustCore.position = SCNVector3(0, -1.1, 0)
    head.addChildNode(thrustCore)
    root.addChildNode(head)

    // The collar floats under the head, turns slowly and follows a little late.
    let ring = SCNNode(geometry: Sculpt.lathe([(0.4, -0.07), (0.62, -0.07), (0.62, -0.07), (0.7, -0.015), (0.7, -0.015), (0.7, 0.03), (0.7, 0.03),
      (0.62, 0.08), (0.62, 0.08), (0.42, 0.1), (0.42, 0.1), (0.4, -0.07)], around: 72))
    ring.geometry?.firstMaterial = chrome
    let hazard = SCNNode(geometry: Sculpt.lathe([(0.706, -0.012), (0.706, 0.027)], around: 72))
    hazard.geometry?.firstMaterial = stripe
    let line = SCNTorus(ringRadius: 0.53, pipeRadius: 0.014); line.ringSegmentCount = 96; line.pipeSegmentCount = 10; line.firstMaterial = lamp
    let lineNode = SCNNode(geometry: line); lineNode.position = SCNVector3(0, 0.09, 0)
    for node in [ring, hazard, lineNode] { spin.addChildNode(node) }
    collar.addChildNode(spin)
    collar.position = SCNVector3(0, Self.collarHeight, 0)
    root.addChildNode(collar)
    thrust.geometry = SCNPlane(width: 2.3, height: 1.5); thrust.geometry?.firstMaterial = lampHalo
    thrust.position = SCNVector3(0, CGFloat(Self.collarHeight) - 0.05, 0.3)
    root.addChildNode(thrust)
    root.scale = SCNVector3(Self.size, Self.size, Self.size)

    // A pale key from the front, and one sign on each side from behind: the rim is magenta and cyan.
    let lights = [
      Stage.light(.ambient, 0x8C93B8, 140),
      Stage.light(.directional, 0xF2F4FF, 640, angles: SCNVector3(-0.7, -0.5, 0)),
      Stage.light(.directional, 0xFF2E88, 1500, angles: SCNVector3(-0.15, -2.45, 0)),
      Stage.light(.directional, 0x19E6FF, 1500, angles: SCNVector3(0.25, 2.45, 0)),
    ]
    for node in lights { scene.rootNode.addChildNode(node) }
    Stage.bloom(camera, intensity: 0.7, threshold: 0.75, radius: 9)
    // Where plates meet, a little shade: it sets the armor off from the shell.
    camera.camera?.screenSpaceAmbientOcclusionIntensity = 1.1
    camera.camera?.screenSpaceAmbientOcclusionRadius = 0.22
    scene.rootNode.addChildNode(camera)
    set(mood: .idle)
    apply(MascotPose())
  }

  // MARK: state

  /// The light carries the state: cyan at rest, violet at work, amber when it
  /// needs the person, red while the screen is shared.
  func set(mood: MascotMood) {
    if mood != self.mood { changePending = true }
    self.mood = mood
    let hex: UInt32
    switch mood {
    case .idle, .sleepy: hex = 0x19E6FF
    case .working: hex = 0x8477FF
    case .attention: hex = 0xFFC21A
    case .sharing: hex = 0xFF3355
    case .asleep: hex = 0x7C8CA0
    case .offline: hex = 0x8A8A8A
    }
    tint = MascotScene.color(hex)
    lamp.diffuse.contents = tint.blended(withFraction: 0.25, of: .white) ?? tint
    lampSoft.diffuse.contents = tint
    hudLight.diffuse.contents = tint.withAlphaComponent(0.8)
    auraHalo.multiply.contents = tint; lampHalo.multiply.contents = tint
    roll.multiply.contents = mood == .asleep || mood == .offline ? NSColor.black : tint
    // With no service the paint loses its color.
    let wash: NSColor = mood == .offline ? NSColor(white: 0.55, alpha: 1) : .white
    for material in [armor, cheek, cheekMirror, stripe, paint] {
      material.multiply.contents = wash
      material.diffuse.intensity = mood == .offline ? 0.6 : 1
    }
    armor.emission.intensity = mood == .offline ? 0 : 0.16
    paint.emission.intensity = mood == .offline ? 0 : 0.2
    faceKey = []
  }

  private static func noise(_ value: Double) -> Double {
    let s = sin(value * 127.1 + 311.7) * 43758.5453
    return s - s.rounded(.down)
  }
  /// How strong the glitch is now, where its band is, and how far the band is pushed.
  private func glitch(_ clock: Double, moving: Bool) -> (amount: Double, band: Double, shift: Double) {
    guard moving, mood != .asleep else { return (0, 0, 0) }
    var amount = 0.0
    let since = clock - changeClock
    if since >= 0 && since < 0.34 { amount = 1 - since / 0.34 }
    let period = mood == .attention ? 1.9 : mood == .offline ? 1.4 : 6.7
    let phase = clock.truncatingRemainder(dividingBy: period)
    if phase < 0.17 { amount = max(amount, 0.75 * (1 - phase / 0.17)) }
    guard amount > 0 else { return (0, 0, 0) }
    // It moves in steps, as a bad signal does.
    let step = (clock * 24).rounded(.down)
    return ((amount * 3).rounded(.up) / 3, Self.noise(step), (Self.noise(step + 7) - 0.5) * 2)
  }

  // MARK: face

  private func eye(_ context: CGContext, side: CGFloat, center: CGPoint, width: CGFloat, height: CGFloat, open: CGFloat, hard: CGFloat, happy: CGFloat, color: NSColor, glow: Bool) {
    context.saveGState()
    context.translateBy(x: center.x, y: center.y)
    if glow { context.setShadow(offset: .zero, blur: height * 0.42, color: color.withAlphaComponent(0.95).cgColor) }
    context.setLineJoin(.round); context.setLineCap(.round)
    if mood == .offline {
      // No link: two crosses.
      let reach = height * 0.3
      context.setStrokeColor(color.cgColor); context.setLineWidth(height * 0.16)
      context.move(to: CGPoint(x: -reach, y: -reach)); context.addLine(to: CGPoint(x: reach, y: reach))
      context.move(to: CGPoint(x: -reach, y: reach)); context.addLine(to: CGPoint(x: reach, y: -reach))
      context.strokePath()
    } else if happy > 0.4 {
      // Pleased: each eye is an arrow that points up.
      context.setStrokeColor(color.cgColor); context.setLineWidth(height * 0.24)
      context.move(to: CGPoint(x: -width * 0.42, y: -height * 0.2)); context.addLine(to: CGPoint(x: 0, y: height * 0.22))
      context.addLine(to: CGPoint(x: width * 0.42, y: -height * 0.2))
      context.strokePath()
    } else {
      let w = width / 2, h = max(height * 0.05, height * open / 2)
      let drop = min(h * 1.6, hard * height * 0.42 * min(1, open))
      // The inner side is toward the middle of the face. The outer corner is a point.
      let lid = -h + min(h * 1.2, happy * h * 1.6)
      let points = [CGPoint(x: -w, y: h - drop), CGPoint(x: w * 0.5, y: h), CGPoint(x: w, y: max(lid, h * 0.3)), CGPoint(x: w * 0.7, y: lid),
        CGPoint(x: -w * 0.84, y: lid), CGPoint(x: -w, y: max(lid, -h * 0.5))]
      context.beginPath()
      for (index, point) in points.enumerated() {
        let p = CGPoint(x: point.x * side, y: point.y)
        if index == 0 { context.move(to: p) } else { context.addLine(to: p) }
      }
      context.closePath()
      let outline = context.path
      context.setFillColor(color.cgColor); context.setStrokeColor(color.cgColor); context.setLineWidth(height * 0.07)
      context.drawPath(using: .fillStroke)
      if glow, let outline {
        // A lit panel is brighter toward its top.
        context.setShadow(offset: .zero, blur: 0, color: nil)
        context.addPath(outline); context.clip()
        let lift = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [NSColor.white.withAlphaComponent(0).cgColor, NSColor.white.withAlphaComponent(0.5).cgColor] as CFArray, locations: [0, 1])!
        context.drawLinearGradient(lift, start: CGPoint(x: 0, y: -h), end: CGPoint(x: 0, y: h), options: [])
      }
    }
    context.restoreGState()
  }

  private func drawFace(_ pose: MascotPose, glitch: (amount: Double, band: Double, shift: Double)) -> CGImage {
    let width = faceWidth, height = faceHeight
    let tint = self.tint, mood = self.mood
    return MascotScene.image(width: width, height: height) { context in
      let w = CGFloat(width), h = CGFloat(height)
      context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
      let span = NeonShell.visorFrame.top - NeonShell.visorFrame.bottom
      func row(_ y: Double) -> CGFloat { CGFloat((y - NeonShell.visorFrame.bottom) / span) * h }
      let bright = tint.blended(withFraction: 0.45, of: .white) ?? tint

      // The edge of the glass is a line of light.
      for (inset, alpha, edge) in [(CGFloat(0.045), CGFloat(0.95), NeonShell.visorBottom), (CGFloat(-0.045), CGFloat(0.5), NeonShell.visorTop)] {
        context.saveGState()
        context.setShadow(offset: .zero, blur: h * 0.09, color: tint.withAlphaComponent(0.9).cgColor)
        context.setStrokeColor(tint.withAlphaComponent(alpha).cgColor); context.setLineWidth(h * 0.028); context.setLineJoin(.round)
        context.beginPath()
        for index in 0...80 {
          let across = Double(index) / 40 - 1
          let p = CGPoint(x: CGFloat(index) / 80 * w, y: row(edge(across)) + inset * h)
          if index == 0 { context.move(to: p) } else { context.addLine(to: p) }
        }
        context.strokePath()
        context.restoreGState()
      }

      // Eyes.
      let open = CGFloat(max(0.05, min(1.3, pose.eyeOpen)))
      let happy = CGFloat(max(0, min(1, pose.squint)))
      let hard: CGFloat = mood == .attention ? 0 : mood == .working ? 0.75 : mood == .sleepy || mood == .asleep ? 0.2 : 0.55
      let eyeWidth = h * 0.72, eyeHeight = h * 0.5
      let middle = CGPoint(x: w / 2 + CGFloat(pose.pupilX) * h * 0.24, y: h * 0.58 + CGFloat(pose.pupilY) * h * 0.1)
      let apart = h * 0.7
      func eyes(shift: CGFloat, color: NSColor, glow: Bool) {
        for side in [CGFloat(-1), 1] {
          eye(context, side: side, center: CGPoint(x: middle.x + side * apart + shift, y: middle.y), width: eyeWidth, height: eyeHeight,
              open: open, hard: hard, happy: happy, color: color, glow: glow)
        }
      }
      let amount = CGFloat(glitch.amount)
      // The colors never sit quite on each other: a fringe of magenta and of cyan.
      context.setBlendMode(.screen)
      eyes(shift: -h * 0.028, color: MascotScene.color(0xFF2E88, 0.9), glow: false)
      eyes(shift: h * 0.028, color: MascotScene.color(0x19E6FF, 0.9), glow: false)
      context.setBlendMode(.normal)
      if amount > 0 {
        // The colors come apart, and one band of the picture is pushed to the side.
        context.setBlendMode(.screen)
        eyes(shift: -amount * h * 0.11, color: MascotScene.color(0xFF2E88, 0.9), glow: false)
        eyes(shift: amount * h * 0.11, color: MascotScene.color(0x19E6FF, 0.9), glow: false)
        context.setBlendMode(.normal)
        let band = CGRect(x: 0, y: CGFloat(glitch.band) * h * 0.7 + h * 0.1, width: w, height: h * 0.2)
        context.saveGState(); context.clip(to: [CGRect(x: 0, y: 0, width: w, height: band.minY), CGRect(x: 0, y: band.maxY, width: w, height: h - band.maxY)])
        eyes(shift: 0, color: bright, glow: true)
        context.restoreGState()
        context.saveGState(); context.clip(to: band)
        eyes(shift: CGFloat(glitch.shift) * amount * h * 0.3, color: bright, glow: true)
        context.restoreGState()
      } else {
        eyes(shift: 0, color: bright, glow: true)
      }

      // A voice shows as a wave under the eyes.
      let voice = CGFloat(max(0, min(1, pose.voice)))
      let mouth = CGPoint(x: middle.x, y: h * 0.17)
      context.saveGState()
      context.setShadow(offset: .zero, blur: h * 0.1, color: tint.withAlphaComponent(0.9).cgColor)
      if voice > 0.03 {
        context.setFillColor(bright.cgColor)
        for index in -9...9 {
          let place = Double(index)
          let wave = abs(sin(pose.clock * 17 + place * 1.3) * sin(pose.clock * 7.3 + place * 0.7))
          let fall = 1 - abs(place) / 11
          let tall = h * 0.03 + h * 0.3 * voice * CGFloat((0.3 + 0.7 * wave) * fall)
          context.fill(CGRect(x: mouth.x + CGFloat(index) * h * 0.085 - h * 0.025, y: mouth.y - tall / 2, width: h * 0.05, height: tall))
        }
      }
      context.restoreGState()

      // At rest and at work the temples carry two small instruments: a dial and a signal meter.
      if mood == .idle || mood == .working || mood == .sleepy {
        let dial = CGPoint(x: w / 2 - w * 0.372, y: h * 0.66), radius = h * 0.105
        context.saveGState()
        context.setShadow(offset: .zero, blur: h * 0.05, color: tint.withAlphaComponent(0.8).cgColor)
        context.setStrokeColor(tint.withAlphaComponent(0.3).cgColor); context.setLineWidth(h * 0.028)
        context.addArc(center: dial, radius: radius, startAngle: 0, endAngle: 2 * .pi, clockwise: false); context.strokePath()
        context.setStrokeColor(tint.withAlphaComponent(0.9).cgColor); context.setLineCap(.round)
        let start = CGFloat(-pose.sparkAngle)
        context.addArc(center: dial, radius: radius, startAngle: start, endAngle: start + 1.9, clockwise: false); context.strokePath()
        context.setFillColor(tint.withAlphaComponent(0.85).cgColor)
        let lit = Int((1 + 3 * max(0, min(1, pose.glow))).rounded())
        for index in 0..<4 {
          let tall = h * (0.05 + 0.045 * CGFloat(index))
          context.setFillColor(tint.withAlphaComponent(index < lit ? 0.9 : 0.25).cgColor)
          context.fill(CGRect(x: w / 2 + w * 0.345 + CGFloat(index) * h * 0.055, y: h * 0.57, width: h * 0.034, height: tall))
        }
        context.restoreGState()
      }

      // What each state adds.
      let beat = pose.clock - (pose.clock).rounded(.down)
      switch mood {
      case .working:
        // A bar of light that reads across the glass.
        let x = CGFloat((pose.clock * 0.55).truncatingRemainder(dividingBy: 1)) * w
        let bar = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [tint.withAlphaComponent(0).cgColor, tint.withAlphaComponent(0.34).cgColor, tint.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.85, 1])!
        context.drawLinearGradient(bar, start: CGPoint(x: x - h * 0.55, y: 0), end: CGPoint(x: x, y: 0), options: [])
      case .attention:
        // A warning sign at each temple.
        if pose.clock == 0 || (pose.clock * 2.2).truncatingRemainder(dividingBy: 1) < 0.62 {
          for side in [CGFloat(-1), 1] {
            let c = CGPoint(x: w / 2 + side * w * 0.365, y: h * 0.63), size = h * 0.2
            context.saveGState()
            context.setShadow(offset: .zero, blur: h * 0.08, color: tint.cgColor)
            context.setStrokeColor(bright.cgColor); context.setLineWidth(h * 0.035); context.setLineJoin(.round)
            context.move(to: CGPoint(x: c.x, y: c.y + size)); context.addLine(to: CGPoint(x: c.x - size, y: c.y - size * 0.7)); context.addLine(to: CGPoint(x: c.x + size, y: c.y - size * 0.7))
            context.closePath(); context.strokePath()
            context.setFillColor(bright.cgColor)
            context.fill(CGRect(x: c.x - h * 0.018, y: c.y - size * 0.1, width: h * 0.036, height: size * 0.62))
            context.fill(CGRect(x: c.x - h * 0.018, y: c.y - size * 0.42, width: h * 0.036, height: h * 0.036))
            context.restoreGState()
          }
        }
      case .sharing:
        // On air: a round lamp at the left temple.
        if pose.clock == 0 || beat < 0.6 {
          context.saveGState()
          context.setShadow(offset: .zero, blur: h * 0.1, color: tint.cgColor)
          context.setFillColor(bright.cgColor)
          context.fillEllipse(in: CGRect(x: w / 2 - w * 0.385, y: h * 0.56, width: h * 0.16, height: h * 0.16))
          context.restoreGState()
        }
        Self.write("LIVE", size: h * 0.13, color: tint.withAlphaComponent(0.85), at: CGPoint(x: w / 2 + w * 0.315, y: h * 0.56), in: context)
      case .asleep:
        Self.write("z z", size: h * 0.16, color: tint.withAlphaComponent(0.7), at: CGPoint(x: w / 2 + w * 0.3, y: h * 0.62), in: context)
      case .offline:
        Self.write("NO LINK", size: h * 0.11, color: tint.withAlphaComponent(0.7), at: CGPoint(x: w / 2 - h * 0.3, y: h * 0.1), in: context)
      default: break
      }

      // The sheen is a line that scans down the glass.
      if pose.sheen >= 0 {
        let y = h * CGFloat(1 - pose.sheen)
        let scan = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [bright.withAlphaComponent(0).cgColor, bright.withAlphaComponent(0.75).cgColor, bright.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.5, 1])!
        context.saveGState(); context.clip(to: CGRect(x: 0, y: y - h * 0.1, width: w, height: h * 0.2))
        context.drawLinearGradient(scan, start: CGPoint(x: 0, y: y - h * 0.1), end: CGPoint(x: 0, y: y + h * 0.1), options: [])
        context.restoreGState()
      }

      // Fine dark rows, as on a screen of small lamps.
      context.setFillColor(NSColor.black.withAlphaComponent(0.26).cgColor)
      var y: CGFloat = 0
      while y < h { context.fill(CGRect(x: 0, y: y, width: w, height: 1)); y += 3 }
    }
  }

  // MARK: pose

  func apply(_ pose: MascotPose) {
    let dt = max(0, min(0.1, pose.clock - lastClock))
    let moving = dt > 0
    lastClock = pose.clock
    if changePending { changePending = false; changeClock = moving ? pose.clock : -10 }

    // Parts that follow late. With the clock at rest they sit where the pose puts them.
    followYaw.target = pose.yaw; followRoll.target = pose.roll; followRise.target = pose.bob + pose.lift; followScale.target = pose.scale
    if moving { followYaw.step(dt); followRoll.step(dt); followRise.step(dt); followScale.step(dt) }
    else { followYaw.snap(); followRoll.snap(); followRise.snap(); followScale.snap() }
    let lateYaw = CGFloat(pose.yaw - followYaw.value), lateRoll = CGFloat(pose.roll - followRoll.value)
    let lateRise = CGFloat(pose.bob + pose.lift - followRise.value)

    let now = glitch(pose.clock, moving: moving)
    let jolt = CGFloat(now.amount * now.shift) * 0.03

    root.position = SCNVector3(0, CGFloat(pose.bob + pose.lift + Self.headHeight), 0)
    // Metal gives only a little under a press.
    let give = CGFloat(1 + (pose.squash - 1) * 0.5)
    let wide = 1 / sqrt(max(0.3, give))
    let size = CGFloat(pose.scale)
    head.scale = SCNVector3(size * wide, size * give, size * wide)
    head.eulerAngles = SCNVector3(CGFloat(pose.pitch), CGFloat(pose.yaw), CGFloat(pose.roll))
    head.position = SCNVector3(jolt, (give - 1) * 0.7, 0)

    // The antennas whip after the head.
    for (index, blade) in blades.enumerated() {
      let side: CGFloat = index == 0 ? -1 : 1
      blade.eulerAngles = SCNVector3(lateRise * 1.5, -lateYaw * 0.8, -side * 0.06 - lateRoll * 1.5 - lateYaw * 0.5)
    }

    for (index, joint) in whip.enumerated() {
      let bend = CGFloat(index + 1) * 0.9
      joint.eulerAngles = SCNVector3(lateRise * bend * 1.2 + (index == 0 ? -0.1 : 0), 0, (index == 0 ? -0.2 : 0) - (lateRoll * 1.3 + lateYaw * 0.9) * bend)
    }

    // The collar trails the head, tips with it and spreads under a press.
    collar.position = SCNVector3(-lateYaw * 0.3 + CGFloat(pose.yaw) * 0.12, CGFloat(Self.collarHeight) - lateRise * 0.6 + (1 - give) * 0.2, 0)
    collar.eulerAngles = SCNVector3(CGFloat(pose.pitch) * 0.4 + 0.26, 0, CGFloat(pose.roll) * 0.6 - lateRoll * 0.8 + CGFloat(pose.ringWobble) * 0.6)
    collar.scale = SCNVector3(size * wide * 0.88, size * 0.88, size * wide * 0.88)
    spin.eulerAngles.y = CGFloat(pose.sparkAngle) * 0.35

    // The marks turn slowly; the pointer rides them, and its speed is the state.
    let late = CGFloat(followScale.value)
    hud.scale = SCNVector3(late, late, 1)
    hud.eulerAngles = SCNVector3(0.1 + CGFloat(pose.ringWobble) * 1.4, -lateYaw * 0.5, CGFloat(pose.roll) * 0.5 - lateRoll * 0.6)
    ticks.eulerAngles.z = CGFloat(pose.sparkAngle) * 0.12
    let turn = CGFloat(pose.sparkAngle)
    marker.position = SCNVector3((Self.hudRadius + 0.12) * cos(turn), (Self.hudRadius + 0.12) * sin(turn), 0)
    marker.eulerAngles.z = turn + .pi / 2

    // Light.
    let glow = CGFloat(max(0, min(1, pose.glow)))
    let flicker: CGFloat = now.amount > 0 ? (now.band > 0.5 ? 0.55 : 1.25) : 1
    glass.emission.intensity = (0.3 + 1.0 * glow) * flicker
    aura.opacity = (0.08 + 0.24 * glow) * flicker
    aura.scale = SCNVector3(size, size, 1)
    hud.opacity = 0.3 + 0.6 * glow
    marker.scale = SCNVector3(0.8 + 0.5 * glow, 0.8 + 0.5 * glow, 1)
    for halo in earHalos { halo.opacity = 0.12 + 0.3 * glow }
    lamp.diffuse.intensity = 0.45 + 0.55 * glow
    thrust.opacity = 0.2 + 0.45 * glow + CGFloat(pose.lift) * 1.2
    thrust.position.y = CGFloat(Self.collarHeight) - 0.05 - lateRise * 0.6
    thrust.scale = SCNVector3(size * (1 + CGFloat(pose.lift) * 1.5), size * (1 + CGFloat(pose.lift) * 2.5), 1)
    thrustCore.scale = SCNVector3(0.8 + 0.3 * glow, 0.45 + CGFloat(pose.lift) * 1.2, 0.8 + 0.3 * glow)

    // Small signs of a live signal: the line that rolls down the glass, a
    // flicker in the light under the head, and the marks that close in when it needs the person.
    let phase = CGFloat((pose.clock / 3.6).truncatingRemainder(dividingBy: 1))
    roll.diffuse.contentsTransform = SCNMatrix4MakeTranslation(0, 0.62 - 1.24 * phase, 0)
    if moving {
      thrust.opacity *= 0.9 + 0.1 * CGFloat(sin(pose.clock * 11))
      if mood == .attention {
        let lock = 1 - 0.05 * CGFloat(max(0, sin(pose.clock * 5.5)))
        hud.scale = SCNVector3(late * lock, late * lock, 1)
      }
    }

    // The mouth lamps: a low line at rest, a level meter under a voice.
    let voice = max(0, min(1, pose.voice))
    for (index, bar) in bars.enumerated() {
      let place = Double(index - 4)
      let wave = abs(sin(pose.clock * 15 + place * 1.7))
      // At rest the row is a line that turns up at its ends with the smile.
      let level = voice > 0.03 ? 0.3 + voice * (0.35 + 0.65 * wave) * (1 - abs(place) / 6) * 1.3 : 0.26 + 0.1 * Double(glow)
      bar.scale = SCNVector3(1, CGFloat(max(0.2, min(1.3, level))), 1)
      bar.position.y = -0.58 + (voice > 0.03 ? 0 : CGFloat(pose.smile * 0.075 * pow(abs(place) / 4, 2) - pose.smile * 0.03))
    }
    lampSoft.diffuse.intensity = 0.35 + 0.65 * max(glow, CGFloat(voice))

    // The sheen crosses the shell as it scans the glass.
    if pose.sheen >= 0 {
      chrome.emission.intensity = CGFloat(0.4 * sin(pose.sheen * .pi))
      chrome.emission.contentsTransform = SCNMatrix4MakeTranslation(0, CGFloat(0.9 - pose.sheen * 1.8), 0)
    } else if chrome.emission.intensity != 0 { chrome.emission.intensity = 0 }

    // The face is drawn again only when what it shows has changed.
    func step(_ value: Double, _ parts: Double) -> Int { Int((value * parts).rounded()) }
    let lively = voice > 0.03 || mood == .working
    let blinking = mood == .attention || mood == .sharing
    let key = [step(pose.eyeOpen, 40), step(pose.squint, 20), step(pose.pupilX, 40), step(pose.pupilY, 30), step(pose.smile, 12),
      step(voice, 20), lively ? step(pose.clock, 30) : 0, blinking ? step(pose.clock * 2.2, 5) : 0, step(pose.sheen, 40),
      step(now.amount, 3), now.amount > 0 ? step(pose.clock, 24) : 0, step(pose.sparkAngle, 5), step(pose.glow, 3)]
    if key != faceKey {
      faceKey = key
      glass.emission.contents = drawFace(pose, glitch: now)
    }
  }
}
