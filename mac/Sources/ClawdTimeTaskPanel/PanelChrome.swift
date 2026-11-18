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
private final class PassiveBlur: NSVisualEffectView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
final class GlassSurface: NSView {
  var dragGesture: NativeWindowDrag?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { dragGesture != nil }
  override func mouseDown(with event: NSEvent) {
    if let dragGesture { dragGesture.begin(event, window: window) } else { super.mouseDown(with: event) }
  }
  override func mouseDragged(with event: NSEvent) { dragGesture?.move(event) }
  override func mouseUp(with event: NSEvent) { dragGesture?.end(event) }
  init(radius: CGFloat) {
    super.init(frame: .zero)
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = radius; layer?.masksToBounds = true
    layer?.borderWidth = 1; layer?.borderColor = NSColor.white.withAlphaComponent(0.13).cgColor
    // Tint is a separate view above the material: an effect view's background
    // layer is not a reliable foreground tint, particularly on bright desktops.
    let blur = PassiveBlur(frame: bounds)
    blur.material = .hudWindow; blur.blendingMode = .behindWindow; blur.state = .active
    blur.autoresizingMask = [.width, .height]
    let tint = GlassTint(frame: bounds); tint.autoresizingMask = [.width, .height]
    addSubview(blur); addSubview(tint)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
}

final class MascotBadge: NSView {
  var restore: (() -> Void)?
  var beginDrag: (() -> Void)?
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
  private let dragGesture = NativeWindowDrag()
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    dragGesture.onBegin = { [weak self] in self?.beginDrag?() }
    dragGesture.onEnd = { [weak self] dragged in
      self?.clampAfterDrag?()
      if !dragged { self?.restore?() }
    }
    dragGesture.begin(event, window: window)
  }
  override func mouseDragged(with event: NSEvent) { dragGesture.move(event) }
  override func mouseUp(with event: NSEvent) { dragGesture.end(event) }
  override func accessibilityPerformPress() -> Bool { restore?(); return true }
}

/// The full-size body is top-aligned inside a growing viewport. Text never scales.
final class BodyClipView: NSView {
  let body: NSView
  var fullSize = NSSize.zero { didSet { alignBody() } }
  init(body: NSView) {
    self.body = body
    super.init(frame: .zero); wantsLayer = true; layer?.masksToBounds = true
    addSubview(body)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func resizeSubviews(withOldSize oldSize: NSSize) { alignBody() }
  override func layout() { super.layout(); alignBody() }
  private func alignBody() {
    body.frame = NSRect(x: 0, y: bounds.height - fullSize.height, width: fullSize.width, height: fullSize.height)
  }
}
/// Mouse events belong only to the actual toolbar background/logo or mascot view.
/// No synthetic input, global monitor or asynchronous Window Server drag ownership.
final class NativeWindowDrag {
  var onBegin: (() -> Void)?
  var onEnd: ((Bool) -> Void)?
  private weak var window: NSWindow?
  private var gesture: PanelDrag?
  func begin(_ event: NSEvent, window: NSWindow?) {
    guard let window else { return }
    let pointer = window.convertPoint(toScreen: event.locationInWindow)
    onBegin?()
    self.window = window
    gesture = PanelDrag(pointer: pointer, window: window.frame.origin)
  }
  func move(_ event: NSEvent) {
    guard let window, var gesture else { return }
    let pointer = window.convertPoint(toScreen: event.locationInWindow)
    if let origin = gesture.move(to: pointer) { window.setFrameOrigin(origin) }
    self.gesture = gesture
  }
  func end(_ event: NSEvent) {
    guard gesture != nil else { return }
    move(event)
    let dragged = gesture?.didDrag ?? false
    gesture = nil; window = nil
    onEnd?(dragged)
  }
}
final class DragMascotImageView: NSImageView {
  var dragGesture: NativeWindowDrag?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { dragGesture?.begin(event, window: window) }
  override func mouseDragged(with event: NSEvent) { dragGesture?.move(event) }
  override func mouseUp(with event: NSEvent) { dragGesture?.end(event) }
}
