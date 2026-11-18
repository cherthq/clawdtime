import AppKit
import TaskPanelCore

/// Translucent native surfaces, not a webview or a capture surface.
private final class GlassTint: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.black.withAlphaComponent(0.80).setFill()
    bounds.fill()
  }
}
final class GlassSurface: NSView {
  init(radius: CGFloat) {
    super.init(frame: .zero)
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = radius; layer?.masksToBounds = true
    layer?.borderWidth = 1; layer?.borderColor = NSColor.white.withAlphaComponent(0.13).cgColor
    // Tint is a separate view above the material: an effect view's background
    // layer is not a reliable foreground tint, particularly on bright desktops.
    let blur = NSVisualEffectView(frame: bounds)
    blur.material = .hudWindow; blur.blendingMode = .behindWindow; blur.state = .active
    blur.autoresizingMask = [.width, .height]
    let tint = GlassTint(frame: bounds); tint.autoresizingMask = [.width, .height]
    addSubview(blur); addSubview(tint)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
}

final class MascotBadge: NSView {
  var restore: (() -> Void)?
  var clampAfterDrag: (() -> Void)?
  var sharing = false { didSet { needsDisplay = true; setAccessibilityLabel(sharing ? "ClawdTime, sharing active. Open task panel" : "ClawdTime. Open task panel") } }
  private let mascot: NSImage?
  init(image: NSImage?) {
    mascot = image
    super.init(frame: .zero)
    setAccessibilityElement(true); setAccessibilityRole(.button)
    setAccessibilityLabel("ClawdTime. Open task panel")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(white: 0.09, alpha: 0.94).setFill()
    NSBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2)).fill()
    NSColor.white.withAlphaComponent(0.25).setStroke()
    let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 2.5, dy: 2.5)); ring.lineWidth = 1; ring.stroke()
    mascot?.draw(in: bounds.insetBy(dx: 12, dy: 12), from: .zero, operation: .sourceOver, fraction: 1)
    if sharing {
      NSColor.systemGreen.setFill(); NSBezierPath(ovalIn: NSRect(x: bounds.maxX - 15, y: 5, width: 9, height: 9)).fill()
    }
  }
  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    let start = window.frame.origin
    window.performDrag(with: event)
    let end = window.frame.origin
    clampAfterDrag?()
    if hypot(end.x - start.x, end.y - start.y) < 3 { restore?() }
  }
  override func accessibilityPerformPress() -> Bool { restore?(); return true }
}
