import CoreGraphics
import Foundation

/// The pictures of the guided cursor: a small solid arrow in the accent orange of the panel, and three short
/// rays at its tip, as a click is drawn. Both have a soft orange glow. The arrow also has a thin darker edge
/// and a very soft shadow, so it is clear on a white window and on a dark one.
///
/// The tip of the arrow is the hot spot. It is the exact middle of each picture, so the place of a layer is
/// the place where the hands act. The corners of the arrow are round, so the tip is not the corner of its
/// outline: it is the front of the round tip, a little inside that corner. `hotSpot` computes it.
public enum GuidedCursorArt {
  /// The fill of the arrow and of the rays: the accent of the panel.
  public static func fill(dark: Bool) -> RGB { DesignTokens.value(.accent, dark: dark) }
  /// The thin edge: the same orange at this share of its light.
  public static let edgeShade = 0.7
  public static func edge(dark: Bool) -> RGB {
    let color = fill(dark: dark)
    return RGB(red: color.red * edgeShade, green: color.green * edgeShade, blue: color.blue * edgeShade)
  }
  /// The width of the edge. Half of it is outside the outline.
  public static let edgeLine = 1.2
  /// The glow: its blur, and how solid its color is before the blur. It is the same orange.
  public static let glowBlur = 8.0, glowAlpha = 0.6
  /// The very soft shadow under the arrow and the rays: its blur, how dark it is, and how far down it falls.
  public static let shadowBlur = 2.0, shadowAlpha = 0.22, shadowDrop = 0.5
  /// The room around a painted part for its glow.
  public static var glowPad: Double { glowBlur + 2 }

  /// A corner of the outline: its place on a frame that counts right and down from the corner of the tip,
  /// and its radius. All corners are round.
  public struct Corner: Equatable, Sendable {
    public let x: Double, y: Double, radius: Double
    public init(x: Double, y: Double, radius: Double) { self.x = x; self.y = y; self.radius = radius }
  }
  /// The outline of the arrow: the tip, the right wing, the notch and the lower wing. The arrow is its own
  /// mirror across its line from the tip to the notch, so it points up and to the left.
  public static let corners: [Corner] = [
    Corner(x: 0, y: 0, radius: 2.0), Corner(x: 30.5, y: 11.8, radius: 3.4),
    Corner(x: 17.6, y: 17.6, radius: 2.6), Corner(x: 11.8, y: 30.5, radius: 3.4),
  ]

  private static func unit(_ x: Double, _ y: Double) -> (Double, Double) {
    let length = (x * x + y * y).squareRoot()
    return length > 0 ? (x / length, y / length) : (0, 0)
  }
  /// The front of the round tip, on the frame of `corners`. It is on the line that halves the corner of the tip,
  /// `r / sin(a / 2) - r` inside it, where `r` is the radius of the tip and `a` its angle. The arc of the tip
  /// is nearest to the corner there.
  public static var hotSpot: CGPoint {
    let tip = corners[0], next = corners[1], back = corners[corners.count - 1]
    let u = unit(back.x - tip.x, back.y - tip.y), v = unit(next.x - tip.x, next.y - tip.y)
    let half = acos(max(-1, min(1, u.0 * v.0 + u.1 * v.1))) / 2
    let w = unit(u.0 + v.0, u.1 + v.1), inside = tip.radius / sin(half) - tip.radius
    return CGPoint(x: tip.x + w.0 * inside, y: tip.y + w.1 * inside)
  }
  /// The angle of the tip, in degrees.
  public static var tipAngle: Double {
    let tip = corners[0], next = corners[1], back = corners[corners.count - 1]
    let u = unit(back.x - tip.x, back.y - tip.y), v = unit(next.x - tip.x, next.y - tip.y)
    return acos(max(-1, min(1, u.0 * v.0 + u.1 * v.1))) * 180 / Double.pi
  }

  /// The outline of the arrow, in points, with the hot spot at zero. It counts up, as windows do.
  public static var arrowPath: CGPath {
    let hot = hotSpot
    func at(_ corner: Corner) -> CGPoint { CGPoint(x: corner.x - Double(hot.x), y: Double(hot.y) - corner.y) }
    let path = CGMutablePath(), count = corners.count
    // Start between the last corner and the tip, then round each corner on the way.
    let last = at(corners[count - 1]), first = at(corners[0])
    path.move(to: CGPoint(x: (last.x + first.x) / 2, y: (last.y + first.y) / 2))
    for index in 0..<count {
      let corner = corners[index], next = corners[(index + 1) % count]
      path.addArc(tangent1End: at(corner), tangent2End: at(next), radius: CGFloat(corner.radius))
    }
    path.closeSubpath()
    return path
  }
  /// The arrow with its edge, with no glow, around the hot spot.
  public static var arrowBounds: CGRect { arrowPath.boundingBoxOfPath.insetBy(dx: -edgeLine / 2, dy: -edgeLine / 2) }

  /// The rays: their directions in degrees, counted from the right and up; where each one starts and ends,
  /// from the hot spot; and their width. They fan out from just beyond the tip, 45 degrees apart: to the left,
  /// up and to the left, and up. The middle one is on the line of the arrow.
  public static let rayAngles = [180.0, 135.0, 90.0], rayFrom = 5.6, rayTo = 10.4, rayLine = 2.2
  /// The two ends of each ray, around the hot spot, counting up.
  public static var raySegments: [(CGPoint, CGPoint)] {
    rayAngles.map { degrees in
      let angle = degrees * Double.pi / 180, dx = cos(angle), dy = sin(angle)
      return (CGPoint(x: dx * rayFrom, y: dy * rayFrom), CGPoint(x: dx * rayTo, y: dy * rayTo))
    }
  }
  /// The rays with their edge, with no glow, around the hot spot.
  public static var raysBounds: CGRect {
    let path = CGMutablePath()
    for (start, end) in raySegments { path.move(to: start); path.addLine(to: end) }
    let half = (rayLine + edgeLine) / 2
    return path.boundingBoxOfPath.insetBy(dx: -half, dy: -half)
  }

  /// Half the side of each picture, in points: the arrow with its glow, and the copy of the rays with its glow
  /// at the end of a click, from the hot spot, in every direction. A whole number, so the middle of a picture
  /// is on a pixel border at any scale.
  public static var half: Double {
    func far(_ box: CGRect) -> Double { max(-Double(box.minX), Double(box.maxX), -Double(box.minY), Double(box.maxY)) + glowPad }
    return max(far(arrowBounds), far(raysBounds) * GuidedClick.spread).rounded(.up)
  }
  public static var side: Double { half * 2 }

  private static func color(_ rgb: RGB, _ alpha: Double = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(rgb.red), green: CGFloat(rgb.green), blue: CGFloat(rgb.blue), alpha: CGFloat(alpha))
  }
  /// A clear picture of `side` points for `scale` pixels a point, with zero at its middle.
  private static func canvas(scale: Double) -> (CGContext, CGFloat)? {
    let k = scale.isFinite ? min(8, max(1, scale)) : 2
    let n = Int((side * k).rounded(.up))
    guard n > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.scaleBy(x: CGFloat(k), y: CGFloat(k))
    context.translateBy(x: CGFloat(half), y: CGFloat(half))
    context.setShouldAntialias(true); context.setAllowsAntialiasing(true)
    return (context, CGFloat(k))
  }
  /// The glow alone: the part is drawn far outside the picture and only its blurred shadow falls in it. A
  /// shadow is set in pixels, so the blur and the way back count `k`.
  private static func glow(_ context: CGContext, k: CGFloat, dark: Bool, draw: (CGContext) -> Void) {
    let away = CGFloat(side * 4)
    context.saveGState()
    context.setShadow(offset: CGSize(width: -away * k, height: 0), blur: CGFloat(glowBlur) * k, color: color(fill(dark: dark), glowAlpha))
    context.translateBy(x: away, y: 0)
    draw(context)
    context.restoreGState()
  }
  /// The part itself, over its very soft shadow. The edge and the fill are one layer, so there is one shadow.
  private static func solid(_ context: CGContext, k: CGFloat, draw: (CGContext) -> Void) {
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -CGFloat(shadowDrop) * k), blur: CGFloat(shadowBlur) * k,
      color: CGColor(gray: 0, alpha: CGFloat(shadowAlpha)))
    context.beginTransparencyLayer(auxiliaryInfo: nil)
    draw(context)
    context.endTransparencyLayer()
    context.restoreGState()
  }

  /// The arrow: the accent orange, a thin darker edge, a very soft shadow and a soft orange glow. The hot spot
  /// is the middle of the picture.
  public static func arrow(scale: Double, dark: Bool) -> CGImage? {
    guard let made = canvas(scale: scale) else { return nil }
    let (context, k) = made, path = arrowPath
    glow(context, k: k, dark: dark) { $0.addPath(path); $0.setFillColor(color(fill(dark: dark))); $0.fillPath() }
    solid(context, k: k) { context in
      context.addPath(path)
      context.setStrokeColor(color(edge(dark: dark))); context.setLineWidth(CGFloat(edgeLine)); context.setLineJoin(.round)
      context.strokePath()
      context.addPath(path); context.setFillColor(color(fill(dark: dark))); context.fillPath()
    }
    return context.makeImage()
  }

  /// The three rays: short round strokes in the accent orange, with the same edge, shadow and glow. The hot
  /// spot is the middle of the picture, so a click can grow them from the tip.
  public static func rays(scale: Double, dark: Bool) -> CGImage? {
    guard let made = canvas(scale: scale) else { return nil }
    let (context, k) = made, path = CGMutablePath()
    for (start, end) in raySegments { path.move(to: start); path.addLine(to: end) }
    func stroke(_ context: CGContext, width: Double, _ rgb: RGB) {
      context.addPath(path); context.setLineCap(.round); context.setLineWidth(CGFloat(width))
      context.setStrokeColor(color(rgb)); context.strokePath()
    }
    glow(context, k: k, dark: dark) { stroke($0, width: rayLine, fill(dark: dark)) }
    solid(context, k: k) { context in
      stroke(context, width: rayLine + edgeLine, edge(dark: dark))
      stroke(context, width: rayLine, fill(dark: dark))
    }
    return context.makeImage()
  }
}

/// The click of the guided cursor: a copy of the rays opens out from the tip and fades, once. The rays
/// themselves stay still. With Reduce Motion nothing moves and there is no copy.
public enum GuidedClick {
  /// Seconds for the copy to open and fade, and the size that it ends at, as a share of the rays.
  public static let duration = 0.32, spread = 1.6
  public struct Frame: Equatable, Sendable {
    public let scale: Double, opacity: Double
    public init(scale: Double, opacity: Double) { self.scale = scale; self.opacity = opacity }
  }
  /// The copy at `time` seconds after the click. Nil before the click, after it, and always with Reduce Motion.
  /// It opens fast and slows down, and it fades on the way.
  public static func frame(at time: Double, still: Bool) -> Frame? {
    guard !still, time.isFinite, time >= 0, time <= duration else { return nil }
    return share(time / duration)
  }
  private static func share(_ t: Double) -> Frame { Frame(scale: 1 + (spread - 1) * (1 - pow(1 - t, 3)), opacity: 1 - t * t) }
  /// `count` frames from the click to its end, evenly in time, for a keyframe motion. None with Reduce Motion.
  public static func frames(count: Int = 13, still: Bool) -> [Frame] {
    guard !still, count >= 2 else { return [] }
    return (0..<count).map { share(Double($0) / Double(count - 1)) }
  }
}
