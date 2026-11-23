import CoreGraphics
import Foundation

/// The pictures of the guided cursor: a ring around the place where the hands act, and a small pointer of
/// ClawdTime's own. Both carry the two colors of the Chert mark, warm at the top and deep at the bottom.
///
/// The ring is computed here pixel by pixel, so its look can be checked by its numbers: it is round, its
/// middle is the middle of its picture, and its left half is the exact mirror of its right half. The panel
/// only places the pictures, turns the ring and moves the pointer.
public enum GuidedCursorArt {
  public struct Tint: Equatable, Sendable {
    public let red: Double, green: Double, blue: Double
    public init(red: Double, green: Double, blue: Double) { self.red = red; self.green = green; self.blue = blue }
  }
  /// The two colors of the Chert mark, from its top to its bottom.
  public static let warm = Tint(red: 0xEF / 255.0, green: 0x90 / 255.0, blue: 0x44 / 255.0)
  public static let deep = Tint(red: 0x25 / 255.0, green: 0x33 / 255.0, blue: 0x5D / 255.0)

  /// A mix of the two colors: 0 is warm, 1 is deep.
  public static func mix(_ share: Double) -> Tint {
    let t = share.isFinite ? min(1, max(0, share)) : 0
    return Tint(red: warm.red + (deep.red - warm.red) * t, green: warm.green + (deep.green - warm.green) * t,
                blue: warm.blue + (deep.blue - warm.blue) * t)
  }
  /// The color of the ring at `turn` of a full turn from its top. It is warm at the top and deep at the bottom,
  /// the same on the left as on the right, and it has no seam. Each color holds for a part of the ring before
  /// it passes into the other one, as in the mark.
  public static func ringTint(turn: Double) -> Tint {
    guard turn.isFinite else { return warm }
    let share = (1 - cos(2 * Double.pi * turn)) / 2
    return mix(share * share * (3 - 2 * share))
  }

  /// The pale edge of the ring's line, on each side of it, and how solid that edge is.
  public static let edge = 1.0, edgeAlpha = 0.9
  /// The side of the ring's picture, in points: the ring, its line, its pale edge and a little air. It is an
  /// even whole number, so the middle of the picture lies between two pixels on any screen, and a ring that
  /// is put on a whole point is sharp.
  public static var ringSide: Double { ((GuidedLook.ring + GuidedLook.ringLine + 2 * edge + 1) / 2).rounded(.up) * 2 }
  /// The space between the pointer's outline and the border of its picture, and its pale edge inside that space.
  public static let pointerInset = 2.0, pointerEdge = 1.2
  /// The outline of the pointer from its tip, on a frame that counts down. It is 15 units wide and 23.4 high.
  public static let outline: [(Double, Double)] = [(0, 0), (0, 20), (5.2, 15.4), (8.8, 23.4), (12, 22), (8.4, 14.2), (15, 14.2)]
  /// The size of the pointer's picture, in points. The tip is `pointerInset` from its left and from its top.
  public static var pointerSize: CGSize {
    CGSize(width: GuidedLook.pointer * 15 / 23.4 + 2 * pointerInset, height: GuidedLook.pointer + 2 * pointerInset)
  }

  private static func canvas(width: Double, height: Double, scale: Double) -> CGContext? {
    let k = scale.isFinite ? min(8, max(1, scale)) : 2
    let w = Int((width * k).rounded(.up)), h = Int((height * k).rounded(.up))
    guard w > 0, h > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.scaleBy(x: CGFloat(k), y: CGFloat(k))
    context.setShouldAntialias(true); context.setAllowsAntialiasing(true)
    return context
  }

  /// The ring: a round line in the colors of the mark, with a pale line under it, so that all of the ring is
  /// clear on a dark and on a bright ground. The second ring that a click opens is the same picture.
  ///
  /// Each pixel gets its color from its own distance and direction from the middle. So the picture has no
  /// seam, and a pixel and its mirror on the other side are equal to the last bit.
  public static func ring(scale: Double) -> CGImage? {
    let k = scale.isFinite ? min(8, max(1, scale)) : 2
    let n = Int((ringSide * k).rounded(.up))
    guard n > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let middle = Double(n) / 2, radius = GuidedLook.ring / 2 * k, half = GuidedLook.ringLine / 2 * k, pale = half + edge * k
    var bytes = [UInt8](repeating: 0, count: n * n * 4)
    for y in 0..<n {
      for x in 0..<n {
        // From the middle of the picture to the middle of this pixel. The first row is the top one.
        let dx = Double(x) + 0.5 - middle, dy = middle - Double(y) - 0.5
        let off = abs((dx * dx + dy * dy).squareRoot() - radius)
        // How much of the pixel the line covers, and the pale edge under it: each border is one pixel soft.
        let line = min(1, max(0, half - off + 0.5))
        let under = edgeAlpha * min(1, max(0, pale - off + 0.5))
        guard line > 0 || under > 0 else { continue }
        let tint = ringTint(turn: atan2(dx, dy) / (2 * Double.pi))
        // The line over the pale edge. A color is stored multiplied by how solid the pixel is.
        let rest = under * (1 - line), at = (y * n + x) * 4
        bytes[at] = UInt8((min(1, tint.red * line + rest) * 255).rounded())
        bytes[at + 1] = UInt8((min(1, tint.green * line + rest) * 255).rounded())
        bytes[at + 2] = UInt8((min(1, tint.blue * line + rest) * 255).rounded())
        bytes[at + 3] = UInt8((min(1, line + rest) * 255).rounded())
      }
    }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
    return CGImage(width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4, space: space,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
      shouldInterpolate: true, intent: .defaultIntent)
  }

  /// The small pointer: the outline of a pointer, warm at its tip and deep at its tail. A pale edge lies
  /// around it, outside the outline, so the pointer is clear on any ground and its colors stay whole.
  public static func pointer(scale: Double) -> CGImage? {
    let size = pointerSize
    guard let context = canvas(width: Double(size.width), height: Double(size.height), scale: scale),
      let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let unit = CGFloat(GuidedLook.pointer / 23.4), inset = CGFloat(pointerInset)
    // The picture counts up from its bottom. The outline counts down from the tip.
    let top = size.height - inset
    let path = CGMutablePath()
    for (index, place) in outline.enumerated() {
      let point = CGPoint(x: inset + CGFloat(place.0) * unit, y: top - CGFloat(place.1) * unit)
      if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
    }
    path.closeSubpath()
    // The pale edge first, as a wide line. The colors then cover its inner half.
    context.addPath(path)
    context.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.96)
    context.setLineWidth(CGFloat(2 * pointerEdge)); context.setLineJoin(.round)
    context.strokePath()
    context.addPath(path); context.clip()
    let colors = [warm, warm, deep, deep].map { CGColor(srgbRed: CGFloat($0.red), green: CGFloat($0.green), blue: CGFloat($0.blue), alpha: 1) }
    if let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: [0, 0.2, 0.85, 1]) {
      context.drawLinearGradient(gradient, start: CGPoint(x: inset, y: top), end: CGPoint(x: inset + 9 * unit, y: top - 23.4 * unit),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    return context.makeImage()
  }
}
