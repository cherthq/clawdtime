import AppKit
import TaskPanelCore

/// The flat look. Each mascot is a few solid shapes with one edge around them,
/// drawn in a box of 200 by 200 with the origin at the top left. There is no
/// light, no shadow and no reflection: the life is in the pose and in the
/// body's physics.
protocol FlatFigure: AnyObject {
  func draw(_ pose: MascotPose, mood: MascotMood, in context: CGContext)
}

/// How the mascot is drawn: flat shapes, or the lit 3D figure.
enum MascotLook: String, CaseIterable {
  case flat, solid
  var title: String { self == .flat ? "Flat" : "3D" }
}

/// The shapes and colors that every flat figure shares.
enum Flat {
  static func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
  static let ink = color(0x1C1A16), paper = color(0xF7F5EF), orange = color(0xFF8040)
  /// The state is one color: warm at rest, blue at work, amber when it needs the person, red while sharing.
  static func state(_ mood: MascotMood, idle: UInt32 = 0xFFD9B0) -> CGColor {
    switch mood {
    case .idle, .sleepy: return color(idle)
    case .working: return color(0x86A8FF)
    case .attention: return color(0xFFB936)
    case .sharing: return color(0xFF6257)
    case .asleep, .offline: return color(0x8A857D)
    }
  }
  /// The polygon moved inward by `distance` on every edge.
  static func inset(_ points: [CGPoint], by distance: CGFloat) -> [CGPoint] {
    let count = points.count
    var area: CGFloat = 0
    for i in 0..<count { let a = points[i], b = points[(i + 1) % count]; area += a.x * b.y - b.x * a.y }
    let sign: CGFloat = area > 0 ? 1 : -1
    var lines: [(CGPoint, CGPoint)] = []
    for i in 0..<count {
      let a = points[i], b = points[(i + 1) % count]
      let length = max(0.0001, hypot(b.x - a.x, b.y - a.y))
      let nx = -(b.y - a.y) / length * sign * distance, ny = (b.x - a.x) / length * sign * distance
      lines.append((CGPoint(x: a.x + nx, y: a.y + ny), CGPoint(x: b.x + nx, y: b.y + ny)))
    }
    var result: [CGPoint] = []
    for i in 0..<count {
      let first = lines[(i + count - 1) % count], second = lines[i]
      let ax = first.1.x - first.0.x, ay = first.1.y - first.0.y, bx = second.1.x - second.0.x, by = second.1.y - second.0.y
      let det = ax * by - ay * bx
      guard abs(det) > 0.0001 else { result.append(second.0); continue }
      let t = ((second.0.x - first.0.x) * by - (second.0.y - first.0.y) * bx) / det
      result.append(CGPoint(x: first.0.x + ax * t, y: first.0.y + ay * t))
    }
    return result
  }
  static func polygon(_ points: [CGPoint]) -> CGPath {
    let path = CGMutablePath(); path.addLines(between: points); path.closeSubpath(); return path
  }
  private static func rounded(_ c: CGContext, _ path: CGPath, _ color: CGColor, _ width: CGFloat) {
    c.setFillColor(color); c.setStrokeColor(color); c.setLineWidth(width); c.setLineJoin(.round)
    c.addPath(path); c.drawPath(using: .fillStroke)
  }
  /// A rounded polygon in one flat color, with an edge in another.
  static func sticker(_ c: CGContext, _ points: [CGPoint], fill: CGColor, line: CGColor, radius: CGFloat = 6, edge: CGFloat = 3.5) {
    let path = polygon(inset(points, by: radius))
    rounded(c, path, line, 2 * radius + 2 * edge)
    rounded(c, path, fill, 2 * radius)
  }
  /// A rounded polygon with no edge.
  static func soft(_ c: CGContext, _ points: [CGPoint], fill: CGColor, radius: CGFloat = 5) {
    rounded(c, polygon(inset(points, by: radius)), fill, 2 * radius)
  }
  static func fill(_ c: CGContext, _ path: CGPath, _ color: CGColor) { c.setFillColor(color); c.addPath(path); c.fillPath() }
  static func stroke(_ c: CGContext, _ path: CGPath, _ color: CGColor, _ width: CGFloat, cap: CGLineCap = .round, dash: [CGFloat] = []) {
    c.saveGState()
    c.setStrokeColor(color); c.setLineWidth(width); c.setLineCap(cap); c.setLineJoin(.round)
    if !dash.isEmpty { c.setLineDash(phase: 0, lengths: dash) }
    c.addPath(path); c.strokePath()
    c.restoreGState()
  }
  static func disc(_ c: CGContext, _ x: CGFloat, _ y: CGFloat, _ r: CGFloat, _ color: CGColor) {
    c.setFillColor(color); c.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
  }
  static func oval(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> CGPath {
    CGPath(ellipseIn: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2), transform: nil)
  }
  /// A pale rim outside a shape's ink edge. The ink edge holds the shape on a
  /// light desk; the rim holds its dark parts on a dark one.
  static func rim(_ c: CGContext, _ path: CGPath, edge: CGFloat = 3.5, width: CGFloat = 3) {
    stroke(c, path, paper, 2 * (edge + width))
  }
  /// A line with an edge under it: a ring, a halo, an orbit.
  static func band(_ c: CGContext, _ path: CGPath, _ color: CGColor, _ width: CGFloat, edge: CGColor = ink, cap: CGLineCap = .round) {
    stroke(c, path, edge, width + 5, cap: cap); stroke(c, path, color, width, cap: cap)
  }
  /// The small robotic eye, flat: a ring of light with a pupil that looks. Shut,
  /// it is one line; pleased, it is an arch.
  static func eye(_ c: CGContext, _ x: CGFloat, _ y: CGFloat, color: CGColor, r: CGFloat = 9.5, pose: MascotPose,
                  rim: CGColor? = nil, socket: CGColor? = nil) {
    if let socket { disc(c, x, y, r + 5, socket) }
    if let rim { stroke(c, oval(x, y, r + 4.2, r + 4.2), rim, 2.6) }
    let open = CGFloat(max(0, min(1.25, pose.eyeOpen)))
    if open < 0.2 {
      let line = CGMutablePath(); line.move(to: CGPoint(x: x - r, y: y)); line.addLine(to: CGPoint(x: x + r, y: y))
      stroke(c, line, color, 3.2); return
    }
    if pose.squint > 0.5 {
      let arch = CGMutablePath()
      arch.addArc(center: CGPoint(x: x, y: y + r * 0.35), radius: r, startAngle: .pi * 1.08, endAngle: .pi * 1.92, clockwise: false)
      stroke(c, arch, color, 3.6); return
    }
    stroke(c, oval(x, y, r, r * min(1.1, open)), color, 3.2)
    let reach = r * 0.36
    disc(c, x + CGFloat(pose.pupilX) * reach, y - CGFloat(pose.pupilY) * reach * min(1, open), r * (0.40 + 0.10 * CGFloat(pose.glow)), color)
  }
  /// Moves the box for the body's pose: its height, its swing about its middle, and its squash about its base.
  static func place(_ c: CGContext, _ pose: MascotPose, base: CGFloat = 176) {
    let unit: CGFloat = 43.5
    c.translateBy(x: 0, y: -CGFloat(pose.bob + pose.lift) * unit)
    c.translateBy(x: 100, y: 100); c.rotate(by: -CGFloat(pose.roll)); c.translateBy(x: -100, y: -100)
    let tall = CGFloat(pose.scale * pose.squash), wide = CGFloat(pose.scale) / CGFloat(max(0.3, pose.squash)).squareRoot()
    c.translateBy(x: 100, y: base); c.scaleBy(x: wide, y: tall); c.translateBy(x: -100, y: -base)
  }
  static func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
}

/// Which flat drawing belongs to which style.
extension MascotCatalog {
  static func flat(_ style: MascotStyle) -> FlatFigure {
    switch style {
    case .flint: return FlintFlat()
    case .pebble: return PebbleFlat()
    case .core: return CoreFlat()
    case .neon: return NeonFlat()
    case .iris: return IrisFlat()
    case .jet, .jade, .lapis, .amber, .garnet, .amethyst: return StoneFlat(style)
    }
  }
  /// A flat figure at rest as a picture, for the menu.
  static func flatImage(_ style: MascotStyle, points: CGFloat = 32, flintEye: Bool = false) -> NSImage {
    let figure = flat(style)
    (figure as? FlintFlat)?.eye = flintEye
    return NSImage(size: NSSize(width: points, height: points), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.scaleBy(x: rect.width / 200, y: rect.height / 200)
      var pose = MascotPose(); pose.clock = 1
      figure.draw(pose, mood: .idle, in: context)
      return true
    }
  }
}

/// Parts that follow the body late, shared by the flat figures.
private struct Follow {
  var trail = Spring(0, response: 0.36, dampingRatio: 0.42)
  var rise = Spring(0, response: 0.30, dampingRatio: 0.5)
  private var lastClock = 0.0
  /// Steps the springs by the animation time that passed. With the clock still, nothing moves.
  mutating func step(_ pose: MascotPose, trail trailTarget: Double, rise riseTarget: Double) {
    let dt = max(0, min(0.1, pose.clock - lastClock)); lastClock = pose.clock
    trail.target = trailTarget; rise.target = riseTarget
    if dt > 0 { trail.step(dt); rise.step(dt) } else if pose.clock == 0 { trail.snap(); rise.snap() }
  }
}

/// Flint: the Chert mark itself, and its flake. The person can give it one ring eye in its window.
final class FlintFlat: FlatFigure {
  /// Off, Flint is the mark and nothing else, and its window carries the state.
  var eye = false
  static let core = [Flat.point(102, 24.5), Flat.point(130.8, 46.9), Flat.point(106.8, 73.7), Flat.point(136, 176.1), Flat.point(50.4, 176.1), Flat.point(20, 80.5)]
  static let window = [Flat.point(48.8, 94.1), Flat.point(102.4, 128.1), Flat.point(95.6, 158.1), Flat.point(64, 159.7), Flat.point(46.4, 101.3)]
  static let flake = [Flat.point(156, 64.5), Flat.point(180, 82.5), Flat.point(155.2, 142.9), Flat.point(130.8, 81.3)]
  private var follow = Follow()
  private var sparkAt = -10.0, wasPleased = false
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 13, rise: (mood == .attention ? 7 : 0) + pose.air * 13)
    if pose.squint > 0.6 && !wasPleased { sparkAt = pose.clock }
    wasPleased = pose.squint > 0.6
    let light = Flat.state(mood)
    c.saveGState()
    Flat.place(c, pose)
    Flat.sticker(c, Self.core, fill: Flat.paper, line: Flat.ink)
    // The window and the eye shift a little when the mark turns: that is all the depth there is.
    c.saveGState()
    c.translateBy(x: CGFloat(pose.yaw) * 5, y: CGFloat(pose.pitch) * 4)
    if eye {
      Flat.soft(c, Self.window, fill: Flat.ink)
      Flat.eye(c, 75, 134, color: light, r: 10.5, pose: pose)
      if pose.voice > 0.03 {
        // A voice shows as a short level line under the eye.
        let half = 5 + 9 * CGFloat(pose.voice)
        let line = CGMutablePath(); line.move(to: Flat.point(75 - half, 152)); line.addLine(to: Flat.point(75 + half, 152))
        Flat.stroke(c, line, light, 2.6)
      }
    } else {
      // The plain mark. At rest the window is dark, as in the mark. In every other
      // state the window is lit in the color of that state.
      let rest = mood == .idle || mood == .sleepy
      Flat.soft(c, Self.window, fill: rest ? Flat.ink : light)
      if pose.voice > 0.03 {
        // A voice shows as a level line across the window.
        let half = 6 + 12 * CGFloat(pose.voice)
        let line = CGMutablePath(); line.move(to: Flat.point(74 - half, 133)); line.addLine(to: Flat.point(74 + half, 133))
        Flat.stroke(c, line, rest ? light : Flat.ink, 3)
      }
    }
    c.restoreGState()
    // The flake floats in its place, trails when the mark is carried, lifts when it calls, and waves.
    c.saveGState()
    let asleep = mood == .asleep || mood == .offline
    c.translateBy(x: CGFloat(follow.trail.value) - (asleep ? 6 : 0), y: -CGFloat(follow.rise.value) + (asleep ? 4 : 0))
    let turn = pose.wave * 0.55 * sin(pose.clock * 2 * .pi * 3) + (mood == .working ? 0.10 * sin(pose.sparkAngle) : 0) + pose.ringWobble
    c.translateBy(x: 155.2, y: 142.9); c.rotate(by: CGFloat(turn)); c.translateBy(x: -155.2, y: -142.9)
    Flat.sticker(c, Self.flake, fill: Flat.paper, line: Flat.ink)
    c.restoreGState()
    // Flint strikes sparks: a click throws a few from the gap.
    let age = pose.clock - sparkAt
    if age >= 0 && age < 0.5 {
      for k in 0..<7 {
        let angle = -1.3 + Double(k) * 0.42, reach = 6 + age * 80 + Double(k % 3) * 5, size = 6 * (1 - age / 0.5)
        let from = Flat.point(121 + CGFloat(cos(angle) * reach), 78 + CGFloat(sin(angle) * reach))
        let line = CGMutablePath(); line.move(to: from)
        line.addLine(to: Flat.point(from.x + CGFloat(cos(angle) * size), from.y + CGFloat(sin(angle) * size)))
        Flat.stroke(c, line, k % 2 == 0 ? Flat.orange : light, 2.8)
      }
    }
    c.restoreGState()
  }
}

/// The plain stones: one solid shape with two bar eyes, and nothing else. Each
/// outline is a facet in the language of the Chert mark: a pebble, a slab, a
/// wedge, a drop, a peak, a flake. The rim around a stone is its state: pale at
/// rest, and in the color of the state otherwise.
final class StoneFlat: FlatFigure {
  struct Cut {
    /// The outline: a polygon whose corners are rounded by `radius`, or a smooth path.
    var points: [CGPoint] = []
    var radius: CGFloat = 0
    var path: CGPath?
    let body: UInt32
    /// Pale eyes take the color of the state. Dark eyes, on a light stone, stay dark.
    var darkEyes = false
    /// The middle of the face.
    let face: CGPoint
  }
  static func cut(_ style: MascotStyle) -> Cut {
    switch style {
    case .jade:
      return Cut(points: [Flat.point(50, 48), Flat.point(146, 38), Flat.point(160, 146), Flat.point(44, 160)], radius: 28, body: 0x157A5C, face: Flat.point(101, 98))
    case .lapis:
      // Five sides, as the large piece of the mark.
      return Cut(points: [Flat.point(92, 30), Flat.point(158, 66), Flat.point(150, 164), Flat.point(54, 170), Flat.point(34, 88)], radius: 22, body: 0x2A4BB0, face: Flat.point(97, 104))
    case .amber:
      let drop = CGMutablePath()
      drop.move(to: Flat.point(118, 26))
      drop.addCurve(to: Flat.point(168, 120), control1: Flat.point(136, 52), control2: Flat.point(168, 86))
      drop.addCurve(to: Flat.point(100, 174), control1: Flat.point(168, 152), control2: Flat.point(138, 174))
      drop.addCurve(to: Flat.point(32, 120), control1: Flat.point(62, 174), control2: Flat.point(32, 152))
      drop.addCurve(to: Flat.point(92, 50), control1: Flat.point(32, 84), control2: Flat.point(70, 62))
      drop.addCurve(to: Flat.point(118, 26), control1: Flat.point(104, 44), control2: Flat.point(112, 36))
      drop.closeSubpath()
      return Cut(path: drop, body: 0xE3A32F, darkEyes: true, face: Flat.point(100, 122))
    case .garnet:
      return Cut(points: [Flat.point(100, 22), Flat.point(178, 166), Flat.point(22, 166)], radius: 26, body: 0x8E2440, face: Flat.point(100, 124))
    case .amethyst:
      // Four sides, as the small piece of the mark.
      return Cut(points: [Flat.point(104, 22), Flat.point(166, 78), Flat.point(112, 180), Flat.point(40, 86)], radius: 20, body: 0x5A3AA6, face: Flat.point(104, 92))
    default:
      // Jet, and any style that has no cut of its own.
      return Cut(path: Flat.oval(100, 108, 66, 62), body: 0x1C1A16, face: Flat.point(100, 104))
    }
  }
  private let cut: Cut
  private var follow = Follow()
  init(_ style: MascotStyle) { cut = Self.cut(style) }
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 0.32, rise: pose.air * 5)
    let state = Flat.state(mood, idle: 0xF7F5EF)
    c.saveGState()
    Flat.place(c, pose)
    // The stone: the rim in the color of the state, the ink edge, the body.
    let shape = cut.path ?? Flat.polygon(Flat.inset(cut.points, by: cut.radius))
    let round = cut.path == nil ? 2 * cut.radius : 0
    func layer(_ color: CGColor, grown: CGFloat) {
      c.setFillColor(color); c.setStrokeColor(color); c.setLineWidth(round + 2 * grown); c.setLineJoin(.round)
      c.addPath(shape); c.drawPath(using: round + grown > 0 ? .fillStroke : .fill)
    }
    layer(state, grown: 8.5); layer(Flat.ink, grown: 3.5)
    layer(Flat.color(mood == .offline ? 0x77736C : cut.body), grown: 0)
    // The eyes: two bars. They look, lean into the way the stone is carried, shut to a line, and bow when it is pleased.
    let color = cut.darkEyes ? Flat.ink : mood == .offline ? Flat.color(0xD8D4CB) : state
    let open = CGFloat(max(0, min(1.25, pose.eyeOpen)))
    let lookX = CGFloat(pose.pupilX) * 6 + CGFloat(pose.yaw) * 8, lookY = -CGFloat(pose.pupilY) * 5 - CGFloat(follow.rise.value)
    // A voice makes the bars beat.
    let beat = pose.voice > 0.03 ? 1 + 0.3 * CGFloat(pose.voice) * CGFloat(sin(pose.clock * 15)) : 1
    for side in [CGFloat(-1), 1] {
      c.saveGState()
      c.translateBy(x: cut.face.x + side * 20 + lookX, y: cut.face.y + lookY); c.rotate(by: CGFloat(follow.trail.value))
      if open < 0.2 {
        let line = CGMutablePath(); line.move(to: Flat.point(-10, 0)); line.addLine(to: Flat.point(10, 0))
        Flat.stroke(c, line, color, 6)
      } else if pose.squint > 0.5 {
        let bow = CGMutablePath()
        bow.addArc(center: Flat.point(0, 7), radius: 11, startAngle: .pi * 1.1, endAngle: .pi * 1.9, clockwise: false)
        Flat.stroke(c, bow, color, 6.5)
      } else {
        let wide: CGFloat = 16, tall = max(7, 38 * min(1.15, open) * beat), corner = min(wide, tall) / 2
        Flat.fill(c, CGPath(roundedRect: CGRect(x: -wide / 2, y: -tall / 2, width: wide, height: tall), cornerWidth: corner, cornerHeight: corner, transform: nil), color)
      }
      c.restoreGState()
    }
    c.restoreGState()
  }
}

/// Pebble: the round stone in four flat strata, with its ring and two large eyes.
final class PebbleFlat: FlatFigure {
  private var follow = Follow()
  private static let stone: CGPath = {
    let p = CGMutablePath()
    p.move(to: Flat.point(100, 34))
    p.addCurve(to: Flat.point(170, 106), control1: Flat.point(146, 34), control2: Flat.point(170, 64))
    p.addCurve(to: Flat.point(100, 170), control1: Flat.point(170, 148), control2: Flat.point(140, 170))
    p.addCurve(to: Flat.point(30, 106), control1: Flat.point(60, 170), control2: Flat.point(30, 148))
    p.addCurve(to: Flat.point(100, 34), control1: Flat.point(30, 64), control2: Flat.point(54, 34))
    p.closeSubpath(); return p
  }()
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 0.4, rise: pose.air * 9)
    let light = Flat.state(mood, idle: 0xFFF1DC)
    c.saveGState()
    Flat.place(c, pose)
    let tilt = -0.30 + CGFloat(follow.trail.value) + CGFloat(pose.ringWobble) + CGFloat(pose.wave * 0.3 * sin(pose.clock * 2 * .pi * 3))
    func ring(front: Bool) {
      c.saveGState()
      c.translateBy(x: 100, y: 112 + CGFloat(follow.rise.value)); c.rotate(by: tilt); c.translateBy(x: -100, y: -112)
      let path = CGMutablePath()
      if front { path.addEllipse(in: CGRect(x: 8, y: 85, width: 184, height: 54)) }
      // The front half only: the lower arc.
      let arc = CGMutablePath(); arc.move(to: Flat.point(8, 112))
      arc.addCurve(to: Flat.point(100, 139), control1: Flat.point(8, 127), control2: Flat.point(49, 139))
      arc.addCurve(to: Flat.point(192, 112), control1: Flat.point(151, 139), control2: Flat.point(192, 127))
      Flat.band(c, front ? arc : Flat.oval(100, 112, 92, 27), Flat.paper, 5.5)
      // The spark rides the ring. It is in front for half of its way.
      let angle = pose.sparkAngle, ahead = sin(angle) > 0
      if ahead == front {
        let x = 100 + 92 * CGFloat(cos(angle)), y = 112 + 27 * CGFloat(sin(angle))
        Flat.disc(c, x, y, 9, Flat.ink); Flat.disc(c, x, y, 5 + 2 * CGFloat(pose.glow), light)
      }
      c.restoreGState()
    }
    Flat.rim(c, Self.stone)
    ring(front: false)
    Flat.stroke(c, Self.stone, Flat.ink, 7); Flat.fill(c, Self.stone, Flat.ink)
    c.saveGState(); c.addPath(Self.stone); c.clip()
    for (y, height, hex) in [(20, 76, 0xFF8A47), (96, 24, 0xF06A38), (120, 22, 0x8E3F42), (142, 40, 0x232A5C)] as [(CGFloat, CGFloat, UInt32)] {
      c.setFillColor(mood == .offline ? Flat.color(0x8A857D, 0.25 + 0.75 * (y / 200)) : Flat.color(hex)); c.fill(CGRect(x: 20, y: y, width: 160, height: height))
    }
    c.restoreGState()
    let turn = CGFloat(pose.yaw) * 7, open = CGFloat(max(0, min(1.25, pose.eyeOpen)))
    for x in [CGFloat(79), 121] {
      let cx = x + turn
      if open < 0.2 || pose.squint > 0.5 {
        let lid = CGMutablePath(); lid.move(to: Flat.point(cx - 11, 92))
        lid.addQuadCurve(to: Flat.point(cx + 11, 92), control: Flat.point(cx, pose.squint > 0.5 ? 80 : 99))
        Flat.stroke(c, lid, Flat.ink, 4)
      } else {
        let white = Flat.oval(cx, 90, 12.5, 16.5 * min(1.1, open))
        Flat.fill(c, white, Flat.paper); Flat.stroke(c, white, Flat.ink, 3)
        let px = cx + CGFloat(pose.pupilX) * 4, py = 91 - CGFloat(pose.pupilY) * 5
        Flat.fill(c, Flat.oval(px, py, 6.5, 8.5 * min(1, open)), Flat.color(0x1D2040)); Flat.disc(c, px - 2, py - 4, 2.2, Flat.paper)
      }
    }
    let smile = CGFloat(max(0, min(1, pose.smile))), talk = CGFloat(pose.voice)
    if talk > 0.05 { Flat.fill(c, Flat.oval(100 + turn, 119, 7 + 3 * talk, 3 + 6 * talk), Flat.ink) } else {
      let mouth = CGMutablePath(); mouth.move(to: Flat.point(90 + turn, 116))
      mouth.addQuadCurve(to: Flat.point(110 + turn, 116), control: Flat.point(100 + turn, 116 + 12 * smile))
      Flat.stroke(c, mouth, Flat.ink, 4)
    }
    ring(front: true)
    c.restoreGState()
  }
}

/// Core: a dark disc with an iris of arcs and two orbit lines.
final class CoreFlat: FlatFigure {
  private var follow = Follow()
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 0.45, rise: pose.air * 0.14)
    let light = Flat.state(mood)
    c.saveGState()
    Flat.place(c, pose)
    let wide = 1 + CGFloat(follow.rise.value)
    func orbit(_ rx: CGFloat, _ ry: CGFloat, _ angle: CGFloat) {
      c.saveGState()
      c.translateBy(x: 100, y: 100); c.rotate(by: angle + CGFloat(follow.trail.value)); c.scaleBy(x: wide, y: wide); c.translateBy(x: -100, y: -100)
      Flat.band(c, Flat.oval(100, 100, rx, ry), Flat.paper, 2.6, cap: .butt)
      c.restoreGState()
    }
    orbit(86, 30, -0.49 + CGFloat(pose.ringWobble) + CGFloat(pose.wave * 0.35 * sin(pose.clock * 2 * .pi * 3)))
    orbit(90, 22, 0.94 - CGFloat(pose.ringWobble))
    let body = Flat.oval(100, 100, 58, 58)
    Flat.fill(c, body, Flat.color(0x14161C)); Flat.stroke(c, body, Flat.paper, 5)
    // The iris looks, and closes to blink.
    let open = CGFloat(max(0.12, min(1.2, pose.eyeOpen))) * (1 - 0.3 * CGFloat(pose.squint))
    let x = 100 + CGFloat(pose.pupilX) * 9 + CGFloat(pose.yaw) * 8, y = 100 - CGFloat(pose.pupilY) * 7
    func arcs(_ r: CGFloat, _ width: CGFloat, _ dash: [CGFloat], _ turn: Double) {
      c.saveGState(); c.translateBy(x: x, y: y); c.rotate(by: CGFloat(turn)); c.translateBy(x: -x, y: -y)
      Flat.stroke(c, Flat.oval(x, y, r * open, r * open), light, width, cap: .butt, dash: dash)
      c.restoreGState()
    }
    arcs(34, 3, [2, 5], pose.sparkAngle * 0.08)
    arcs(26, 6, [38, 16], pose.sparkAngle)
    arcs(16, 4, [30, 20], -pose.sparkAngle * 0.62)
    Flat.disc(c, x, y, (5 + 3 * CGFloat(pose.glow)) * max(0.4, open), Flat.paper)
    // The spark rides the first orbit.
    let angle = pose.sparkAngle * 1.7
    let sx = 100 + 86 * CGFloat(cos(angle)) * wide, sy = 100 + 30 * CGFloat(sin(angle)) * wide
    let spin = CGAffineTransform(translationX: 100, y: 100).rotated(by: -0.49 + CGFloat(follow.trail.value)).translatedBy(x: -100, y: -100)
    let spark = CGPoint(x: sx, y: sy).applying(spin)
    Flat.disc(c, spark.x, spark.y, 8.5, Flat.ink); Flat.disc(c, spark.x, spark.y, 5.5, light)
    c.restoreGState()
  }
}

/// Neon: the droid head, flat: a yellow brow, a visor, and a magenta and cyan fringe.
final class NeonFlat: FlatFigure {
  private var follow = Follow()
  private static let head = [Flat.point(48, 62), Flat.point(152, 62), Flat.point(162, 88), Flat.point(156, 134), Flat.point(128, 152), Flat.point(72, 152), Flat.point(44, 134), Flat.point(38, 88)]
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 12, rise: pose.air * 14)
    let light = Flat.state(mood, idle: 0x19E6FF)
    // The collar hovers under the head and catches up late.
    Flat.fill(c, Flat.oval(100 + CGFloat(follow.trail.value) * 0.6, 176 - CGFloat(pose.bob) * 20, 34, 9), Flat.ink)
    Flat.stroke(c, Flat.oval(100 + CGFloat(follow.trail.value) * 0.6, 176 - CGFloat(pose.bob) * 20, 34, 9), Flat.paper, 3)
    Flat.stroke(c, Flat.oval(100 + CGFloat(follow.trail.value) * 0.6, 175 - CGFloat(pose.bob) * 20, 22, 4.5), light, 2.5)
    c.saveGState()
    Flat.place(c, pose, base: 152)
    func blade(_ x: CGFloat, _ lean: CGFloat, waves: Bool) {
      let sweep = lean + CGFloat(follow.trail.value) * 1.2 + (waves ? CGFloat(pose.wave * 16 * sin(pose.clock * 2 * .pi * 3)) : 0) - (lean > 0 ? 1 : -1) * CGFloat(pose.air) * 6
      let shape = [Flat.point(x - 6, 64), Flat.point(x + 6, 64), Flat.point(x + sweep + 4, 22), Flat.point(x + sweep - 3, 22)]
      Flat.fill(c, Flat.polygon(shape), Flat.ink); Flat.stroke(c, Flat.polygon(shape), Flat.paper, 3)
      let tip = [Flat.point(x + sweep * 0.62 - 4.6, 38), Flat.point(x + sweep * 0.62 + 5, 38), Flat.point(x + sweep + 4, 22), Flat.point(x + sweep - 3, 22)]
      Flat.fill(c, Flat.polygon(tip), Flat.color(0xFFE94A))
    }
    blade(52, -14, waves: true); blade(148, 14, waves: false)
    // The fringe: the same head in magenta and in cyan, a little apart. A jolt pulls them further.
    let apart = 4 + 5 * CGFloat(pose.air) + 6 * abs(CGFloat(pose.roll))
    Flat.sticker(c, Self.head, fill: Flat.paper, line: Flat.paper, radius: 9, edge: 3)
    Flat.soft(c, Self.head.map { Flat.point($0.x - apart, $0.y) }, fill: Flat.color(0xFF2E88), radius: 9)
    Flat.soft(c, Self.head.map { Flat.point($0.x + apart, $0.y) }, fill: Flat.color(0x19E6FF), radius: 9)
    Flat.soft(c, Self.head, fill: Flat.color(0x101218), radius: 9)
    Flat.soft(c, [Flat.point(54, 60), Flat.point(146, 60), Flat.point(150, 82), Flat.point(50, 82)], fill: Flat.color(mood == .offline ? 0x8A857D : 0xFFE94A), radius: 4)
    for x in [CGFloat(118), 130, 142] { Flat.fill(c, Flat.polygon([Flat.point(x, 62), Flat.point(x + 7, 62), Flat.point(x + 1, 80), Flat.point(x - 6, 80)]), Flat.ink) }
    c.setFillColor(Flat.ink); c.fill(CGRect(x: 56, y: 70, width: 34, height: 5))
    let turn = CGFloat(pose.yaw) * 7
    let visor = CGPath(roundedRect: CGRect(x: 50, y: 90, width: 100, height: 34), cornerWidth: 9, cornerHeight: 9, transform: nil)
    Flat.fill(c, visor, Flat.color(0x05070C)); Flat.stroke(c, visor, light, 2)
    let open = CGFloat(max(0, min(1.2, pose.eyeOpen)))
    for (x, side) in [(CGFloat(76), CGFloat(1)), (124, -1)] {
      let cx = x + turn + CGFloat(pose.pupilX) * 5, cy = 106 - CGFloat(pose.pupilY) * 3
      if open < 0.2 { c.setFillColor(light); c.fill(CGRect(x: cx - 16, y: cy - 2, width: 32, height: 4)) }
      else if pose.squint > 0.5 {
        // Pleased: two arrows that point up.
        let arrow = CGMutablePath(); arrow.move(to: Flat.point(cx - 14, cy + 6)); arrow.addLine(to: Flat.point(cx, cy - 7)); arrow.addLine(to: Flat.point(cx + 14, cy + 6))
        Flat.stroke(c, arrow, light, 5, cap: .butt)
      } else {
        let h = 20 * min(1.1, open)
        Flat.fill(c, Flat.polygon([Flat.point(cx - 16, cy - h / 2 + side * 3), Flat.point(cx + 16, cy - h / 2 - side * 3), Flat.point(cx + 14, cy + h / 2), Flat.point(cx - 14, cy + h / 2)]), light)
      }
    }
    // The grille is a level meter for the voice.
    for k in 0..<6 {
      let level = pose.voice > 0.03 ? 3 + 9 * CGFloat(pose.voice) * CGFloat(0.5 + 0.5 * sin(pose.clock * 17 + Double(k) * 1.9)) : 5
      c.setFillColor(light); c.fill(CGRect(x: 80 + CGFloat(k) * 8, y: 141 - level, width: 5, height: level))
    }
    c.restoreGState()
  }
}

/// Iris: a lens as rings: a hoop, ticks, glass, an aperture and a core of light.
final class IrisFlat: FlatFigure {
  private var follow = Follow()
  func draw(_ pose: MascotPose, mood: MascotMood, in c: CGContext) {
    follow.step(pose, trail: -pose.travel * pose.gait * 9, rise: pose.air * 8)
    let light = Flat.state(mood)
    c.saveGState()
    Flat.place(c, pose)
    // The hoop is what the hand holds. The lens swings in it, a little behind.
    Flat.band(c, Flat.oval(100, 100, 84, 84), Flat.color(0x9A9EA6), 3, cap: .butt)
    Flat.disc(c, 16, 100, 7, Flat.ink); Flat.disc(c, 184, 100, 7, Flat.ink)
    Flat.disc(c, 150, 33, 7.5, Flat.ink); Flat.disc(c, 150, 33, 4 + 1.5 * CGFloat(pose.glow), light)
    c.translateBy(x: CGFloat(follow.trail.value), y: -CGFloat(follow.rise.value))
    let barrel = Flat.oval(100, 100, 66, 66)
    Flat.fill(c, barrel, Flat.color(0x15171B)); Flat.stroke(c, barrel, Flat.paper, 5)
    // The focus ring turns: slowly at rest, back and forth at work.
    c.saveGState(); c.translateBy(x: 100, y: 100); c.rotate(by: CGFloat(pose.sparkAngle * 0.3)); c.translateBy(x: -100, y: -100)
    for k in 0..<36 {
      let a = Double(k) / 36 * 2 * .pi, long = k % 4 == 0
      let tick = CGMutablePath(); tick.move(to: Flat.point(100 + 55 * CGFloat(cos(a)), 100 + 55 * CGFloat(sin(a))))
      tick.addLine(to: Flat.point(100 + (long ? 63 : 61) * CGFloat(cos(a)), 100 + (long ? 63 : 61) * CGFloat(sin(a))))
      Flat.stroke(c, tick, Flat.paper, long ? 2.4 : 1.6, cap: .butt)
    }
    c.restoreGState()
    Flat.fill(c, Flat.polygon([Flat.point(100, 31), Flat.point(95, 40), Flat.point(105, 40)]), Flat.orange)
    let x = 100 + CGFloat(pose.pupilX) * 7 + CGFloat(pose.yaw) * 7, y = 100 - CGFloat(pose.pupilY) * 6
    Flat.disc(c, 100, 100, 46, Flat.color(0x1F6F6B)); Flat.disc(c, (100 + x) / 2, (100 + y) / 2, 33, Flat.color(0x5B4A8F))
    // Seven blades. A blink closes them; a jump opens them wide.
    let open = CGFloat(max(0.22, min(1.25, pose.eyeOpen + pose.air * 0.4))) * (1 - 0.3 * CGFloat(pose.squint))
    Flat.fill(c, Flat.polygon((0..<7).map { k in
      let a = Double(k) / 7 * 2 * .pi - 0.3 + pose.sparkAngle * 0.05
      return Flat.point(x + 19 * open * CGFloat(cos(a)), y + 19 * open * CGFloat(sin(a)))
    }), Flat.color(0x0B0C0F))
    Flat.disc(c, x, y, (5 + 3 * CGFloat(max(pose.glow, pose.voice))) * max(0.3, min(1, open)), light)
    Flat.disc(c, 82, 78, 6, Flat.color(0xF7F5EF, 0.85))
    c.restoreGState()
  }
}

/// The view that draws a flat figure. It draws again only when the pose changed.
final class FlatMascotView: NSView {
  var figure: FlatFigure?
  var mood = MascotMood.idle
  var pose = MascotPose() { didSet { needsDisplay = true } }
  override var isFlipped: Bool { true }
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    guard let figure, let context = NSGraphicsContext.current?.cgContext else { return }
    // The figure is drawn a little smaller than its box, so a jump and a swing stay inside the window.
    let side = min(bounds.width, bounds.height), scale = side / 200 * 0.78
    context.translateBy(x: bounds.midX - 100 * scale, y: bounds.midY - 100 * scale + side * 0.04)
    context.scaleBy(x: scale, y: scale)
    figure.draw(pose, mood: mood, in: context)
  }
}
