// Draws the ClawdTime app icon and writes its .icns file and a large PNG.
//
//   swift mac/scripts/make-app-icon.swift [--out DIR]
//
// The icon is flat: the brand green tile in the macOS icon grid (an 824 point
// rounded square on a 1024 point canvas, with a soft shadow), and the mark on
// it. Each size is drawn from the shapes, not scaled from a large picture, so
// the small sizes stay sharp. The script writes DIR/AppIcon.icns (with
// iconutil, from a temporary iconset) and DIR/AppIcon-1024.png.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
func option(_ name: String, _ fallback: String) -> String {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return fallback }
  return arguments[index + 1]
}
let out = URL(fileURLWithPath: option("--out", "mac/Resources"), isDirectory: true)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}
let green = color(0x366A43)
let greenDeep = color(0x2C5937)
let paper = color(0xF4F1E8)
let stone = color(0x1C1A16)

/// The macOS tile: a superellipse, which has the continuous corners of the
/// system icons, 824 points wide in the middle of the 1024 point canvas.
func tile(in unit: CGFloat) -> CGPath {
  let path = CGMutablePath()
  let size = 824 * unit, origin = (1024 * unit - size) / 2
  let a = size / 2, center = CGPoint(x: origin + a, y: origin + a)
  let n: CGFloat = 5
  let steps = 720
  for step in 0...steps {
    let t = CGFloat(step) / CGFloat(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = pow(abs(c), 2 / n) * a * (c < 0 ? -1 : 1)
    let y = pow(abs(s), 2 / n) * a * (s < 0 ? -1 : 1)
    let point = CGPoint(x: center.x + x, y: center.y + y)
    if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

/// A rounded polygon: each corner is cut with an arc of the given radius.
func roundedPolygon(_ points: [CGPoint], radius: CGFloat) -> CGPath {
  let path = CGMutablePath()
  let count = points.count
  for index in 0..<count {
    let previous = points[(index + count - 1) % count], here = points[index], next = points[(index + 1) % count]
    let start = CGPoint(x: (previous.x + here.x) / 2, y: (previous.y + here.y) / 2)
    if index == 0 { path.move(to: start) }
    path.addArc(tangent1End: here, tangent2End: next, radius: radius)
  }
  path.closeSubpath()
  return path
}

func draw(_ context: CGContext, pixels: Int) {
  let unit = CGFloat(pixels) / 1024
  func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * unit, y: (1024 - y) * unit) }
  context.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  let shape = tile(in: unit)
  // The soft shadow of the system icons, below the tile.
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -10 * unit), blur: 22 * unit, color: color(0x000000, 0.28))
  context.addPath(shape)
  context.setFillColor(green)
  context.fillPath()
  context.restoreGState()
  // A quiet tone from a lighter top to the brand green, still flat.
  context.saveGState()
  context.addPath(shape)
  context.clip()
  let tone = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0x417C50), green] as CFArray,
    locations: [0, 1])!
  context.drawLinearGradient(
    tone, start: CGPoint(x: 0, y: 924 * unit), end: CGPoint(x: 0, y: 380 * unit), options: [.drawsAfterEndLocation])
  context.restoreGState()
  // Jet, the black pebble of the panel, hopping over its flat shadow: a thin
  // paper rim, the stone, and two paper bars for eyes that look up and on.
  context.setFillColor(greenDeep)
  let shadow = CGRect(origin: p(348, 800), size: CGSize(width: 328 * unit, height: 44 * unit))
  context.fillEllipse(in: shadow)
  // The stone in a 200 point drawing, placed and turned on the tile.
  let scale: CGFloat = 3.05
  var place = CGAffineTransform(translationX: 512 * unit, y: (1024 - 500) * unit)
    .rotated(by: 7 * .pi / 180)
    .scaledBy(x: scale * unit, y: -scale * unit)
    .translatedBy(x: -100, y: -101)
  let pebble = CGMutablePath()
  pebble.move(to: CGPoint(x: 96, y: 30))
  pebble.addCurve(to: CGPoint(x: 172, y: 98), control1: CGPoint(x: 140, y: 28), control2: CGPoint(x: 172, y: 58))
  pebble.addCurve(to: CGPoint(x: 104, y: 172), control1: CGPoint(x: 172, y: 142), control2: CGPoint(x: 146, y: 172))
  pebble.addCurve(to: CGPoint(x: 28, y: 106), control1: CGPoint(x: 60, y: 172), control2: CGPoint(x: 28, y: 150))
  pebble.addCurve(to: CGPoint(x: 96, y: 30), control1: CGPoint(x: 28, y: 62), control2: CGPoint(x: 52, y: 32))
  pebble.closeSubpath()
  let stonePath = pebble.copy(using: &place)!
  context.addPath(stonePath)
  context.setStrokeColor(paper)
  context.setLineWidth(2 * 17 * unit)
  context.setLineJoin(.round)
  context.strokePath()
  context.addPath(stonePath)
  context.setFillColor(stone)
  context.fillPath()
  let wide: CGFloat = 13, tall: CGFloat = 30
  for x in [CGFloat(94), 132] {
    let eye = CGRect(x: x - wide / 2, y: 86 - tall / 2, width: wide, height: tall)
    context.addPath(CGPath(roundedRect: eye, cornerWidth: wide / 2, cornerHeight: wide / 2, transform: &place))
    context.setFillColor(paper)
    context.fillPath()
  }
}

func png(_ pixels: Int, to url: URL) throws {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  guard
    let context = CGContext(
      data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw NSError(domain: "icon", code: 1) }
  context.setShouldAntialias(true)
  context.interpolationQuality = .high
  draw(context, pixels: pixels)
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { throw NSError(domain: "icon", code: 2) }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "icon", code: 3) }
}

let iconset = FileManager.default.temporaryDirectory
  .appendingPathComponent("clawdtime-\(UUID().uuidString)/AppIcon.iconset", isDirectory: true)
defer { try? FileManager.default.removeItem(at: iconset.deletingLastPathComponent()) }
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
  try png(points, to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
  try png(points * 2, to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
try png(1024, to: out.appendingPathComponent("AppIcon-1024.png"))
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", out.appendingPathComponent("AppIcon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { throw NSError(domain: "icon", code: 4) }
print("Wrote \(out.appendingPathComponent("AppIcon.icns").path).")
