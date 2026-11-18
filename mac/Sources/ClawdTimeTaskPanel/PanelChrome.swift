import AppKit
import TaskPanelCore

/// Translucent native surfaces, not a webview or a capture surface.
private final class GlassTint: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedWhite: 0.94, alpha: 0.92).setFill()
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
    appearance = NSAppearance(named: .aqua)
    wantsLayer = true
    layer?.cornerRadius = radius; layer?.masksToBounds = true
    layer?.borderWidth = 1; layer?.borderColor = NSColor(white: 0.35, alpha: 0.18).cgColor
    // Tint is a separate view above the material: an effect view's background
    // layer is not a reliable foreground tint, particularly on bright desktops.
    let blur = PassiveBlur(frame: bounds)
    blur.material = .popover; blur.blendingMode = .behindWindow; blur.state = .active
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
    NSColor(white: 0.94, alpha: 0.98).setFill()
    NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5)).fill()
    NSColor(white: 0.35, alpha: 0.22).setStroke()
    let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5)); ring.lineWidth = 1; ring.stroke()
    mascot?.draw(in: NSRect(x: bounds.midX - 16, y: bounds.midY - 16, width: 32, height: 32), from: .zero, operation: .sourceOver, fraction: 1)
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

/// Full-size controls stay right-aligned while the native window retracts.
/// Only its rounded viewport changes size; text and controls never compress or fade.
final class ToolbarControls: NSView {
  var backgroundOnlyViews: [NSView] = []
  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let hit = super.hitTest(point) else { return nil }
    // The fixed container, row gaps and compact status are drag background.
    // Native buttons and the explicit drag-logo view keep their own events.
    return hit === self || backgroundOnlyViews.contains(where: { $0 === hit }) ? nil : hit
  }
}
final class ToolbarClipView: NSView {
  let surface = GlassSurface(radius: 28)
  let controls = ToolbarControls()
  var fullSize = NSSize(width: 430, height: 56) { didSet { alignContents() } }
  init() {
    super.init(frame: .zero)
    wantsLayer = true; layer?.masksToBounds = true
    addSubview(surface); surface.addSubview(controls)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func resizeSubviews(withOldSize oldSize: NSSize) { alignContents() }
  override func layout() { super.layout(); alignContents() }
  private func alignContents() {
    surface.frame = bounds; surface.layer?.cornerRadius = bounds.height / 2
    layer?.cornerRadius = bounds.height / 2
    controls.frame = NSRect(x: bounds.width - fullSize.width, y: (bounds.height - fullSize.height) / 2,
      width: fullSize.width, height: fullSize.height)
  }
}

/// Native NSButton semantics with a restrained glossy blue action surface.
final class GlossyButton: NSButton {
  override var isEnabled: Bool { didSet { needsDisplay = true } }
  var blue = false { didSet { needsDisplay = true } }
  override var intrinsicContentSize: NSSize {
    let size = (title as NSString).size(withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 13)])
    return NSSize(width: ceil(size.width) + (controlSize == .small ? 16 : 28), height: controlSize == .small ? 28 : 36)
  }
  override func draw(_ dirtyRect: NSRect) {
    let rect = bounds.insetBy(dx: 1, dy: 1)
    let radius = min(11, rect.height / 2)
    let shape = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    let pressed = cell?.isHighlighted == true
    let top: NSColor, bottom: NSColor, titleColor: NSColor
    if !isEnabled {
      top = NSColor(white: 0.91, alpha: 1); bottom = NSColor(white: 0.86, alpha: 1)
      titleColor = NSColor(white: 0.56, alpha: 1)
    } else if blue {
      top = NSColor(calibratedRed: 0.14, green: 0.48, blue: 1, alpha: 1)
      bottom = NSColor(calibratedRed: 0.02, green: pressed ? 0.24 : 0.32, blue: pressed ? 0.70 : 0.88, alpha: 1)
      titleColor = .white
    } else {
      top = NSColor(white: pressed ? 0.90 : 1, alpha: 1); bottom = NSColor(white: 0.88, alpha: 1)
      titleColor = contentTintColor ?? NSColor(white: 0.18, alpha: 1)
    }
    NSGradient(starting: bottom, ending: top)?.draw(in: shape, angle: isFlipped ? -90 : 90)
    (blue && isEnabled ? NSColor(calibratedRed: 0.02, green: 0.29, blue: 0.70, alpha: 1) : NSColor(white: 0.65, alpha: 0.6)).setStroke()
    shape.lineWidth = 1; shape.stroke()
    NSGraphicsContext.saveGraphicsState(); shape.addClip()
    NSColor.white.withAlphaComponent(isEnabled ? 0.42 : 0.15).setStroke()
    let topY = isFlipped ? rect.minY + 1.5 : rect.maxY - 1.5
    let bottomY = isFlipped ? rect.maxY - 1.5 : rect.minY + 1.5
    let highlight = NSBezierPath(); highlight.move(to: NSPoint(x: rect.minX + radius, y: topY))
    highlight.line(to: NSPoint(x: rect.maxX - radius, y: topY)); highlight.lineWidth = 1; highlight.stroke()
    NSColor.black.withAlphaComponent(isEnabled ? 0.10 : 0.04).setStroke()
    let depth = NSBezierPath(); depth.move(to: NSPoint(x: rect.minX + radius, y: bottomY))
    depth.line(to: NSPoint(x: rect.maxX - radius, y: bottomY)); depth.lineWidth = 1; depth.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let attrs: [NSAttributedString.Key: Any] = [.font: font ?? NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: titleColor]
    let size = (title as NSString).size(withAttributes: attrs)
    (title as NSString).draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2), withAttributes: attrs)
    if window?.firstResponder === self {
      NSColor.systemBlue.withAlphaComponent(0.6).setStroke()
      let focus = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius + 1, yRadius: radius + 1)
      focus.lineWidth = 2; focus.stroke()
    }
  }
}
