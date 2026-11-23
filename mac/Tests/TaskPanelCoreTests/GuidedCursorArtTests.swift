import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import TaskPanelCore

/// The pictures of the guided cursor, checked by their numbers: the colors of the mark, and a ring that is
/// round, centered and the same on its left as on its right.
final class GuidedCursorArtTests: XCTestCase {
  /// The pixels of a picture as red, green, blue and alpha, with the color not multiplied by alpha.
  private struct Pixels {
    let width: Int, height: Int, data: [UInt8]
    init?(_ image: CGImage) {
      width = image.width; height = image.height
      var bytes = [UInt8](repeating: 0, count: width * height * 4)
      guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
      context.interpolationQuality = .none
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      data = bytes
    }
    func alpha(_ x: Int, _ y: Int) -> Double { Double(data[(y * width + x) * 4 + 3]) / 255 }
    func color(_ x: Int, _ y: Int) -> (Double, Double, Double) {
      let i = (y * width + x) * 4, a = max(1, Double(data[i + 3]))
      return (Double(data[i]) / a, Double(data[i + 1]) / a, Double(data[i + 2]) / a)
    }
  }

  func testTheColorsAreThoseOfTheMarkWarmAtTheTopAndDeepAtTheBottom() {
    XCTAssertEqual(GuidedCursorArt.warm, .init(red: 239 / 255.0, green: 144 / 255.0, blue: 68 / 255.0))
    XCTAssertEqual(GuidedCursorArt.deep, .init(red: 37 / 255.0, green: 51 / 255.0, blue: 93 / 255.0))
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: 0), GuidedCursorArt.warm)
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: 0.5).red, GuidedCursorArt.deep.red, accuracy: 1e-9)
    // The same on the left as on the right, and no seam where a turn ends.
    for turn in stride(from: 0.0, through: 0.5, by: 0.05) {
      XCTAssertEqual(GuidedCursorArt.ringTint(turn: turn).red, GuidedCursorArt.ringTint(turn: 1 - turn).red, accuracy: 1e-9)
      XCTAssertEqual(GuidedCursorArt.ringTint(turn: turn).blue, GuidedCursorArt.ringTint(turn: 1 - turn).blue, accuracy: 1e-9)
    }
    // Each color holds for a part of the ring: an eighth of a turn from the top is still nearly warm.
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: 0.125).red, GuidedCursorArt.warm.red, accuracy: 0.06)
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: 0.375).blue, GuidedCursorArt.deep.blue, accuracy: 0.03)
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: .nan), GuidedCursorArt.warm)
    XCTAssertEqual(GuidedCursorArt.ringTint(turn: 0.999).green, GuidedCursorArt.ringTint(turn: 0.001).green, accuracy: 1e-4)
    XCTAssertEqual(GuidedCursorArt.mix(-3), GuidedCursorArt.warm)
    XCTAssertEqual(GuidedCursorArt.mix(.nan), GuidedCursorArt.warm)
  }

  func testTheRingIsRoundCenteredAndTheExactMirrorOfItselfLeftToRight() throws {
    for scale in [1.0, 2.0, 4.0] {
      let image = try XCTUnwrap(GuidedCursorArt.ring(scale: scale))
      let pixels = try XCTUnwrap(Pixels(image))
      XCTAssertEqual(pixels.width, pixels.height)
      // An even number of pixels: the middle of the picture lies between two of them.
      XCTAssertEqual(Double(pixels.width), GuidedCursorArt.ringSide * scale)
      XCTAssertEqual(pixels.width % 2, 0)
      let n = pixels.width
      var sum = 0.0, sumX = 0.0, sumY = 0.0, unequal = 0, worstFlip = 0.0
      for y in 0..<n {
        for x in 0..<n {
          let a = pixels.alpha(x, y)
          sum += a; sumX += a * (Double(x) + 0.5); sumY += a * (Double(y) + 0.5)
          // Left and right: the same shape and the same color, to the last bit.
          let here = (y * n + x) * 4, there = (y * n + n - 1 - x) * 4
          if pixels.data[here..<here + 4] != pixels.data[there..<there + 4] { unequal += 1 }
          // Top and bottom: the same shape. The colors differ, as in the mark.
          worstFlip = max(worstFlip, abs(a - pixels.alpha(x, n - 1 - y)))
        }
      }
      XCTAssertEqual(unequal, 0, "scale \(scale)")
      XCTAssertEqual(worstFlip, 0)
      // The middle of everything that is painted is the middle of the picture.
      XCTAssertEqual(sumX / sum, Double(n) / 2, accuracy: 1e-9)
      XCTAssertEqual(sumY / sum, Double(n) / 2, accuracy: 1e-9)
      // The line is where the ring is, all the way around, with no seam, and nothing is painted inside it.
      let middle = Double(n) / 2, radius = GuidedLook.ring / 2 * scale
      for step in 0..<360 {
        let angle = Double(step) / 360 * 2 * Double.pi
        XCTAssertEqual(pixels.alpha(Int(middle + cos(angle) * radius), Int(middle + sin(angle) * radius)), 1, "the line at \(step) degrees")
        XCTAssertEqual(pixels.alpha(Int(middle + cos(angle) * radius * 0.5), Int(middle + sin(angle) * radius * 0.5)), 0)
      }
      XCTAssertEqual(pixels.alpha(n / 2, n / 2), 0)
      // The top is warm and the bottom is deep. A picture counts its rows from the top.
      let top = pixels.color(n / 2, Int(middle - radius)), bottom = pixels.color(n / 2, Int(middle + radius))
      XCTAssertEqual(top.0, GuidedCursorArt.warm.red, accuracy: 0.02)
      XCTAssertEqual(top.2, GuidedCursorArt.warm.blue, accuracy: 0.02)
      XCTAssertEqual(bottom.0, GuidedCursorArt.deep.red, accuracy: 0.02)
      XCTAssertEqual(bottom.2, GuidedCursorArt.deep.blue, accuracy: 0.02)
      // The pale edge is outside the colored line, on both of its sides, all the way around: also where the
      // line is deep, so all of the ring shows on a dark ground.
      if scale >= 2 {
        let reach = (GuidedLook.ringLine / 2 + GuidedCursorArt.edge / 2) * scale
        for (x, y) in [(n / 2, Int(middle - radius - reach)), (n / 2, Int(middle + radius + reach)), (n / 2, Int(middle + radius - reach))] {
          XCTAssertGreaterThan(pixels.alpha(x, y), 0.5)
          XCTAssertGreaterThan(pixels.color(x, y).2, 0.9)
        }
      }
    }
  }

  func testThePointerIsWarmAtItsTipAndDeepAtItsTailWithItsTipAtTheInset() throws {
    let image = try XCTUnwrap(GuidedCursorArt.pointer(scale: 4))
    let pixels = try XCTUnwrap(Pixels(image))
    let size = GuidedCursorArt.pointerSize
    XCTAssertEqual(Double(pixels.width), (Double(size.width) * 4).rounded(.up))
    XCTAssertEqual(Double(pixels.height), (Double(size.height) * 4).rounded(.up))
    let inset = GuidedCursorArt.pointerInset * 4, unit = GuidedLook.pointer / 23.4 * 4
    func at(_ x: Double, _ y: Double) -> (Int, Int) { (Int(inset + x * unit), Int(inset + y * unit)) }
    // Inside the outline near the tip, and inside the tail.
    let tip = at(2.2, 6), tail = at(9.86, 21.5)
    XCTAssertEqual(pixels.alpha(tip.0, tip.1), 1)
    XCTAssertEqual(pixels.alpha(tail.0, tail.1), 1)
    XCTAssertGreaterThan(pixels.color(tip.0, tip.1).0, 0.75)
    XCTAssertEqual(pixels.color(tail.0, tail.1).0, GuidedCursorArt.deep.red, accuracy: 0.05)
    XCTAssertEqual(pixels.color(tail.0, tail.1).2, GuidedCursorArt.deep.blue, accuracy: 0.05)
    // The pale edge is outside the outline: just left of the long left side, the picture is nearly white.
    let edge = at(-0.9, 10)
    XCTAssertGreaterThan(pixels.alpha(edge.0, edge.1), 0.8)
    XCTAssertGreaterThan(pixels.color(edge.0, edge.1).2, 0.9)
    // The edge is inside the picture, and nothing is painted to the upper right of the outline.
    XCTAssertLessThanOrEqual(GuidedCursorArt.pointerEdge, GuidedCursorArt.pointerInset)
    XCTAssertEqual(pixels.alpha(pixels.width - 2, 2), 0)
  }

  /// Not a check: with CLAWDTIME_RENDER_DIR set, it writes the look as a picture for a person to look at.
  /// From the left: on its way, at its place, the pointer of the Mac came, a click. On a bright and a dark ground.
  func testWritesTheLookForAPersonWhenAFolderIsNamed() throws {
    guard let folder = ProcessInfo.processInfo.environment["CLAWDTIME_RENDER_DIR"], !folder.isEmpty else { return }
    let scale = 6.0
    let ring = try XCTUnwrap(GuidedCursorArt.ring(scale: scale)), wave = ring
    let pointer = try XCTUnwrap(GuidedCursorArt.pointer(scale: scale))
    let side = 150.0, space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let grounds: [(CGFloat, CGFloat, CGFloat)] = [(0.11, 0.12, 0.14), (0.96, 0.96, 0.95)]
    let context = try XCTUnwrap(CGContext(data: nil, width: Int(side * 4 * scale), height: Int(side * 2 * scale), bitsPerComponent: 8,
      bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    for (row, ground) in grounds.enumerated() {
      for column in 0..<4 {
        let cell = CGRect(x: Double(column) * side, y: Double(row) * side, width: side, height: side)
        context.setFillColor(red: ground.0, green: ground.1, blue: ground.2, alpha: 1); context.fill(cell)
        let middle = CGPoint(x: cell.midX, y: cell.midY), ringSide = GuidedCursorArt.ringSide
        func draw(_ image: CGImage, across: Double, turned: Double = 0, alpha: CGFloat = 1) {
          context.saveGState()
          context.translateBy(x: middle.x, y: middle.y); context.rotate(by: CGFloat(-turned * 2 * Double.pi))
          context.setAlpha(alpha)
          context.draw(image, in: CGRect(x: -across / 2, y: -across / 2, width: across, height: across))
          context.restoreGState()
        }
        if column == 3 { draw(wave, across: ringSide * 1.4, alpha: 0.45) }
        draw(ring, across: column == 0 ? ringSide * GuidedLook.flight : ringSide, turned: [0.1, 0.3, 0, 0.6][column], alpha: column == 0 ? 0.7 : 1)
        // The pointer of the Mac, as a plain dark outline, where it is when the hands act.
        let macIsHere = column >= 2
        if macIsHere {
          let mac = CGMutablePath(), unit = 17.0 / 23.4
          for (index, place) in GuidedCursorArt.outline.enumerated() {
            let point = CGPoint(x: middle.x + place.0 * unit, y: middle.y - place.1 * unit)
            if index == 0 { mac.move(to: point) } else { mac.addLine(to: point) }
          }
          mac.closeSubpath()
          context.addPath(mac); context.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1); context.setLineWidth(2); context.strokePath()
          context.addPath(mac); context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1); context.fillPath()
        }
        let box = GuidedCursorArt.pointerSize, inset = GuidedCursorArt.pointerInset
        let tip = macIsHere ? CGPoint(x: middle.x + GuidedLook.besideX, y: middle.y + GuidedLook.besideY) : middle
        context.setShadow(offset: CGSize(width: 0, height: -1.5 * scale), blur: CGFloat(4 * scale), color: CGColor(gray: 0, alpha: 0.34))
        context.draw(pointer, in: CGRect(x: tip.x - inset, y: tip.y + inset - Double(box.height), width: Double(box.width), height: Double(box.height)))
        context.setShadow(offset: .zero, blur: 0, color: nil)
      }
    }
    let image = try XCTUnwrap(context.makeImage())
    let url = URL(fileURLWithPath: folder).appendingPathComponent("guided-cursor.png")
    let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }
}
