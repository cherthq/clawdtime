// Regenerate with: swift scripts/create-social-card.swift
import AppKit

let width = 1200, height = 630
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let ink = NSColor(srgbRed: 37/255, green: 44/255, blue: 39/255, alpha: 1)
let green = NSColor(srgbRed: 54/255, green: 106/255, blue: 67/255, alpha: 1)
NSColor(srgbRed: 244/255, green: 241/255, blue: 232/255, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat,
          _ color: NSColor, mono: Bool = false) {
  (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
    .font: mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .bold) : NSFont.systemFont(ofSize: size, weight: .bold),
    .foregroundColor: color
  ])
}
green.setFill()
NSRect(x: 72, y: 505, width: 54, height: 48).fill()
NSColor.white.setFill()
NSRect(x: 83, y: 518, width: 26, height: 22).fill()
let camera = NSBezierPath()
camera.move(to: NSPoint(x: 112, y: 523)); camera.line(to: NSPoint(x: 121, y: 515))
camera.line(to: NSPoint(x: 121, y: 543)); camera.line(to: NSPoint(x: 112, y: 535)); camera.close(); camera.fill()
text("clawdtime_", 148, 509, 39, ink, mono: true)
text("Talk to your Mac.", 72, 352, 78, ink)
text("It does the work.", 72, 258, 78, green)
text("An assistant for your Mac. Ask by chat or by voice.", 76, 179, 30, ink)
green.setFill(); NSRect(x: 76, y: 116, width: 1048, height: 2).fill()
text("FREE FOR MAC", 76, 65, 18, green, mono: true)
text("clawdtime.com", 916, 65, 18, ink, mono: true)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "public/social-card.png"))
