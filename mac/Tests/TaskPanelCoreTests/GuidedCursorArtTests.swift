import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import TaskPanelCore

/// The pictures of the guided cursor, checked by their numbers: the orange of the panel, a small arrow whose
/// tip is the hot spot, three rays at that tip, and a click that moves only with motion on.
final class GuidedCursorArtTests: XCTestCase {
  /// The pixels of a picture as red, green, blue and alpha, with the color not multiplied by alpha. The first
  /// row is the top one.
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
    /// The pixel at `x` points right of the middle and `y` points under it.
    func at(_ x: Double, _ y: Double, scale: Double) -> (Int, Int) {
      (Int((Double(width) / 2 + x * scale).rounded(.down)), Int((Double(height) / 2 + y * scale).rounded(.down)))
    }
  }

  func testTheArrowIsTheAccentOrangeOfThePanelInLightAndDarkWithADarkerEdgeAndASoftGlow() throws {
    XCTAssertEqual(GuidedCursorArt.fill(dark: false), RGB(0xFF8040))
    XCTAssertEqual(GuidedCursorArt.fill(dark: true), RGB(0xFF8A50))
    for dark in [false, true] {
      let fill = GuidedCursorArt.fill(dark: dark), edge = GuidedCursorArt.edge(dark: dark)
      // The edge is the same orange, darker.
      XCTAssertLessThan(edge.red, fill.red); XCTAssertLessThan(edge.luminance, fill.luminance)
      XCTAssertGreaterThan(edge.red, edge.green); XCTAssertGreaterThan(edge.green, edge.blue)
      let scale = 4.0
      let pixels = try XCTUnwrap(Pixels(try XCTUnwrap(GuidedCursorArt.arrow(scale: scale, dark: dark))))
      // Inside the body, on its line from the tip to the notch: solid, and exactly the orange of the theme.
      let inside = pixels.at(9, 9, scale: scale)
      XCTAssertEqual(pixels.alpha(inside.0, inside.1), 1)
      let color = pixels.color(inside.0, inside.1)
      XCTAssertEqual(color.0, fill.red, accuracy: 1.5 / 255, "dark \(dark)")
      XCTAssertEqual(color.1, fill.green, accuracy: 1.5 / 255, "dark \(dark)")
      XCTAssertEqual(color.2, fill.blue, accuracy: 1.5 / 255, "dark \(dark)")
      // Out along that row to the left, the last solid pixel is the darker edge.
      var x = inside.0
      while x > 0, pixels.alpha(x - 1, inside.1) >= 0.9 { x -= 1 }
      XCTAssertLessThan(pixels.color(x, inside.1).0, fill.red - 0.1, "the edge, dark \(dark)")
      // A few points out from the edge there is only the glow: orange, and faint.
      let glow = pixels.at(-1, 14, scale: scale)
      XCTAssertGreaterThan(pixels.alpha(glow.0, glow.1), 0.01)
      XCTAssertLessThan(pixels.alpha(glow.0, glow.1), 0.35)
      let tint = pixels.color(glow.0, glow.1)
      XCTAssertGreaterThan(tint.0, tint.1); XCTAssertGreaterThan(tint.1, tint.2)
      // The glow fades out before the border of the picture.
      XCTAssertEqual(pixels.alpha(pixels.width - 1, pixels.height - 1), 0)
      XCTAssertEqual(pixels.alpha(0, pixels.height - 1), 0)
    }
  }

  func testTheTipIsTheHotSpotAndTheMiddleOfThePictureWithinOnePointAtCommonScales() throws {
    // The round tip is nearest to its corner on the line that halves it, r / sin(a / 2) - r inside.
    let tip = GuidedCursorArt.corners[0], angle = GuidedCursorArt.tipAngle * Double.pi / 180
    let inside = tip.radius / sin(angle / 2) - tip.radius
    XCTAssertEqual(Double(GuidedCursorArt.hotSpot.x), inside / 2.0.squareRoot(), accuracy: 1e-9)
    XCTAssertEqual(Double(GuidedCursorArt.hotSpot.y), inside / 2.0.squareRoot(), accuracy: 1e-9)
    // The outline is at zero there: just inside it is the arrow, just outside it is not. The arrow points up
    // and to the left, so nothing of it is further that way than zero.
    let path = GuidedCursorArt.arrowPath
    XCTAssertTrue(path.contains(CGPoint(x: 0.03, y: -0.03)))
    XCTAssertFalse(path.contains(CGPoint(x: -0.03, y: 0.03)))
    XCTAssertFalse(path.contains(CGPoint(x: -0.6, y: 0)))
    XCTAssertFalse(path.contains(CGPoint(x: 0, y: 0.6)))
    // The pictures: the hot spot is their middle, on a pixel border, so a layer placed at the tip is exact.
    XCTAssertEqual(GuidedCursorArt.side.truncatingRemainder(dividingBy: 2), 0)
    for scale in [1.0, 1.5, 2.0, 3.0] {
      for dark in [false, true] {
        let pixels = try XCTUnwrap(Pixels(try XCTUnwrap(GuidedCursorArt.arrow(scale: scale, dark: dark))))
        XCTAssertEqual(Double(pixels.width), GuidedCursorArt.side * scale)
        XCTAssertEqual(Double(pixels.height), GuidedCursorArt.side * scale)
        // The painted tip: of all solid pixels, the one furthest up and to the left.
        var best: (x: Int, y: Int)?
        for y in 0..<pixels.height {
          for x in 0..<pixels.width where pixels.alpha(x, y) >= 0.5 {
            if best == nil || x + y < best!.x + best!.y { best = (x, y) }
          }
        }
        let found = try XCTUnwrap(best)
        let middle = Double(pixels.width) / 2
        let dx = (Double(found.x) + 0.5 - middle) / scale, dy = (Double(found.y) + 0.5 - middle) / scale
        XCTAssertLessThanOrEqual((dx * dx + dy * dy).squareRoot(), 1, "scale \(scale) dark \(dark): \(dx), \(dy)")
      }
    }
  }

  func testTheArrowIsSmallWithRoundCornersAndAShortNotch() throws {
    let bounds = GuidedCursorArt.arrowPath.boundingBoxOfPath
    XCTAssertGreaterThanOrEqual(bounds.height, 22); XCTAssertLessThanOrEqual(bounds.height, 28)
    XCTAssertGreaterThanOrEqual(bounds.width, 22); XCTAssertLessThanOrEqual(bounds.width, 28)
    // It hangs under the tip and to its right.
    XCTAssertLessThanOrEqual(bounds.maxY, 1); XCTAssertGreaterThanOrEqual(bounds.minX, -1)
    // Every corner is round. The tip is sharp: under 60 degrees.
    XCTAssertTrue(GuidedCursorArt.corners.allSatisfy { $0.radius > 0 })
    XCTAssertLessThan(GuidedCursorArt.tipAngle, 60)
    // The notch is inside the line from wing to wing, a short way: under a quarter of the length of the arrow.
    let c = GuidedCursorArt.corners, wing = (x: (c[1].x + c[3].x) / 2, y: (c[1].y + c[3].y) / 2)
    let depth = ((wing.x - c[2].x) + (wing.y - c[2].y)) / 2.0.squareRoot()
    XCTAssertGreaterThan(depth, 2); XCTAssertLessThan(depth, Double(bounds.height) / 4)
    // The arrow is its own mirror across its line from the tip to the notch.
    XCTAssertEqual(c[1].x, c[3].y); XCTAssertEqual(c[1].y, c[3].x); XCTAssertEqual(c[2].x, c[2].y)
    // What is painted solid is as small, at a usual scale.
    let pixels = try XCTUnwrap(Pixels(try XCTUnwrap(GuidedCursorArt.arrow(scale: 2, dark: false))))
    var top = Int.max, bottom = Int.min
    for y in 0..<pixels.height { for x in 0..<pixels.width where pixels.alpha(x, y) >= 0.5 { top = min(top, y); bottom = max(bottom, y) } }
    let painted = Double(bottom - top + 1) / 2
    XCTAssertGreaterThanOrEqual(painted, 22); XCTAssertLessThanOrEqual(painted, 28 + GuidedCursorArt.edgeLine)
    // On a phone that shows a screen of 982 points as 720 pixels, the arrow is still 16 pixels high.
    XCTAssertGreaterThanOrEqual(GuidedLook.pixels(Double(bounds.height), screenHeight: 982, shownHeight: 720), 16)
  }

  func testThreeRaysFanOutJustBeyondTheTipEvenlyAndClearOfTheArrow() throws {
    let angles = GuidedCursorArt.rayAngles
    XCTAssertEqual(angles.count, 3)
    // To the left, up and to the left, and up: 45 degrees apart, and the middle one on the line of the arrow.
    XCTAssertEqual(angles, [180, 135, 90])
    let path = GuidedCursorArt.arrowPath, clear = (GuidedCursorArt.rayLine + GuidedCursorArt.edgeLine) / 2 + 0.5
    for (start, end) in GuidedCursorArt.raySegments {
      // Short, and starting just beyond the tip.
      let length = hypot(Double(end.x - start.x), Double(end.y - start.y))
      XCTAssertGreaterThanOrEqual(length, 3); XCTAssertLessThanOrEqual(length, 7)
      let near = hypot(Double(start.x), Double(start.y))
      XCTAssertGreaterThan(near - clear, 2); XCTAssertLessThan(near, 8)
      // No part of a ray, with its edge, lies on the arrow.
      for step in 0...20 {
        let t = Double(step) / 20
        let x = Double(start.x) + Double(end.x - start.x) * t, y = Double(start.y) + Double(end.y - start.y) * t
        for turn in 0..<16 {
          let a = Double(turn) / 16 * 2 * Double.pi
          XCTAssertFalse(path.contains(CGPoint(x: x + cos(a) * clear, y: y + sin(a) * clear)))
        }
      }
    }
    for dark in [false, true] {
      let scale = 4.0
      let pixels = try XCTUnwrap(Pixels(try XCTUnwrap(GuidedCursorArt.rays(scale: scale, dark: dark))))
      XCTAssertEqual(Double(pixels.width), GuidedCursorArt.side * scale)
      // The middle of each ray is solid orange. The tip itself is clear: the arrow is there.
      for (start, end) in GuidedCursorArt.raySegments {
        // A picture counts its rows down, the rays count up.
        let mid = pixels.at(Double(start.x + end.x) / 2, -Double(start.y + end.y) / 2, scale: scale)
        XCTAssertEqual(pixels.alpha(mid.0, mid.1), 1)
        XCTAssertEqual(pixels.color(mid.0, mid.1).0, GuidedCursorArt.fill(dark: dark).red, accuracy: 1.5 / 255)
      }
      XCTAssertLessThan(pixels.alpha(pixels.width / 2, pixels.height / 2), 0.3)
      // Nothing of the rays is under the tip and to its right, where the arrow is.
      let body = pixels.at(9, 9, scale: scale)
      XCTAssertLessThan(pixels.alpha(body.0, body.1), 0.05)
    }
  }

  func testAClickPulsesTheRaysOnceAndReduceMotionHasNoPulse() {
    // Reduce Motion: no frames, so nothing moves.
    XCTAssertTrue(GuidedClick.frames(still: true).isEmpty)
    for time in [0, 0.05, GuidedClick.duration / 2, GuidedClick.duration] {
      XCTAssertNil(GuidedClick.frame(at: time, still: true))
    }
    // With motion: a quick scale and fade, from the rays as they are to nothing.
    XCTAssertLessThanOrEqual(GuidedClick.duration, 0.4)
    let frames = GuidedClick.frames(still: false)
    XCTAssertGreaterThanOrEqual(frames.count, 6)
    XCTAssertEqual(frames.first, GuidedClick.Frame(scale: 1, opacity: 1))
    XCTAssertEqual(frames.last?.scale ?? 0, GuidedClick.spread, accuracy: 1e-9)
    XCTAssertEqual(frames.last?.opacity ?? 1, 0, accuracy: 1e-9)
    for (before, after) in zip(frames, frames.dropFirst()) {
      XCTAssertGreaterThanOrEqual(after.scale, before.scale)
      XCTAssertLessThanOrEqual(after.opacity, before.opacity)
    }
    // Once: there is nothing before the click or after it.
    XCTAssertNil(GuidedClick.frame(at: -0.01, still: false))
    XCTAssertNil(GuidedClick.frame(at: GuidedClick.duration + 0.01, still: false))
    XCTAssertNil(GuidedClick.frame(at: .nan, still: false))
    // The copy at its full size, with its glow, is inside the window of the cursor.
    let rays = GuidedCursorArt.raysBounds.insetBy(dx: -GuidedCursorArt.glowPad, dy: -GuidedCursorArt.glowPad)
    let far = max(-Double(rays.minX), Double(rays.maxX), -Double(rays.minY), Double(rays.maxY))
    XCTAssertLessThanOrEqual(far * GuidedClick.spread, GuidedLayout.reach)
  }

  /// Not a check: with CLAWDTIME_RENDER_DIR set, it writes the art as a picture for a person to look at. Each
  /// row is a theme on a white and on a dark ground: the cursor, then the click in six steps.
  func testWritesTheLookForAPersonWhenAFolderIsNamed() throws {
    guard let folder = ProcessInfo.processInfo.environment["CLAWDTIME_RENDER_DIR"], !folder.isEmpty else { return }
    let scale = 4.0, side = GuidedCursorArt.side, columns = 7
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let grounds: [(CGFloat, CGFloat, CGFloat)] = [(1, 1, 1), (0.12, 0.12, 0.13)]
    let context = try XCTUnwrap(CGContext(data: nil, width: Int(side * Double(columns) * scale), height: Int(side * 4 * scale),
      bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    for (theme, dark) in [false, true].enumerated() {
      let arrow = try XCTUnwrap(GuidedCursorArt.arrow(scale: scale, dark: dark))
      let rays = try XCTUnwrap(GuidedCursorArt.rays(scale: scale * 2, dark: dark))
      for (index, ground) in grounds.enumerated() {
        let row = theme * 2 + index
        for column in 0..<columns {
          let cell = CGRect(x: Double(column) * side, y: Double(row) * side, width: side, height: side)
          context.setFillColor(red: ground.0, green: ground.1, blue: ground.2, alpha: 1); context.fill(cell)
          context.draw(rays, in: cell)
          if column > 0, let click = GuidedClick.frame(at: GuidedClick.duration * Double(column - 1) / 5, still: false) {
            context.saveGState(); context.setAlpha(CGFloat(click.opacity))
            context.translateBy(x: cell.midX, y: cell.midY); context.scaleBy(x: CGFloat(click.scale), y: CGFloat(click.scale))
            context.draw(rays, in: CGRect(x: -side / 2, y: -side / 2, width: side, height: side))
            context.restoreGState()
          }
          context.draw(arrow, in: cell)
        }
      }
    }
    let image = try XCTUnwrap(context.makeImage())
    let url = URL(fileURLWithPath: folder).appendingPathComponent("guided-cursor.png")
    let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }
}
