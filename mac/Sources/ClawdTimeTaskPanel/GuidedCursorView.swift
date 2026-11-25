import AppKit
import QuartzCore
import TaskPanelCore

/// What the guided cursor draws: a small orange arrow whose tip is the place where the hands act, three short
/// rays at that tip, and a pill just below and to the right of the arrow that says what the hands do there.
/// The sizes are those of `GuidedLook` and `GuidedCursorArt`, so a phone that shows the screen can read it.
///
/// The arrow and the rays are pictures from `GuidedCursorArt`, each on a layer of its own, so they move with no
/// new drawing. The hot spot is the middle of each picture, and the place of each layer is the tip. Only a
/// click moves anything here: a copy of the rays opens out from the tip and fades. With Reduce Motion
/// nothing moves.
final class GuidedCursorView: NSView {
  private static let font = Theme.sans(CGFloat(GuidedLook.letters), weight: 600)
  /// The arrow, its rays, and the copy of the rays that a click sends out.
  private let arrow = CALayer(), rays = CALayer(), echo = CALayer()
  private var layout: GuidedLayout?
  private var label = ""
  /// The pixels for each point of the screen, and the theme, that the pictures were made for.
  private var grid = 0.0, dark: Bool?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let side = CGFloat(GuidedCursorArt.side)
    for part in [rays, echo, arrow] {
      part.bounds = CGRect(x: 0, y: 0, width: side, height: side)
      // The hot spot is the middle of the picture. That point is the place of the layer.
      part.anchorPoint = CGPoint(x: 0.5, y: 0.5)
      part.contentsGravity = .resize; part.minificationFilter = .trilinear
      layer?.addSublayer(part)
    }
    echo.opacity = 0
    setAccessibilityElement(false)
    paint()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); paint(); needsDisplay = true }
  override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); paint(); place() }

  /// Makes the pictures for the pixels of the screen that the window is on, in the orange of the theme. The
  /// rays get twice as many pixels: their copy grows at a click and stays sharp.
  private func paint() {
    let scale = Double(window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
    let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    guard scale != grid || dark != self.dark else { return }
    grid = scale; self.dark = dark
    CATransaction.begin(); CATransaction.setDisableActions(true)
    arrow.contents = GuidedCursorArt.arrow(scale: scale, dark: dark)
    let burst = GuidedCursorArt.rays(scale: scale * 2, dark: dark)
    rays.contents = burst; echo.contents = burst
    CATransaction.commit()
  }

  /// The width of the pill that `label` needs. Zero for no label.
  static func pillWidth(for label: String) -> Double {
    guard !label.isEmpty else { return 0 }
    return GuidedLook.pillWidth(text: Double(NSAttributedString(string: label, attributes: [.font: font]).size().width))
  }

  /// Shows the parts where `layout` puts them. It draws the pill again only when a part moved inside the window.
  func show(_ layout: GuidedLayout, label: String) {
    guard layout.tip != self.layout?.tip || layout.pill != self.layout?.pill || label != self.label else { return }
    self.layout = layout; self.label = label
    place()
    needsDisplay = true
  }
  /// Puts the arrow and the rays at the tip, on a whole pixel, with no motion. The middle of each picture is
  /// on a pixel border, so the pictures stay sharp and the hot spot is within half a pixel of the tip.
  private func place() {
    guard let layout else { return }
    let pixels = CGFloat(max(1, grid))
    let tip = CGPoint(x: (layout.tip.x * pixels).rounded() / pixels, y: (layout.tip.y * pixels).rounded() / pixels)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    arrow.position = tip; rays.position = tip; echo.position = tip
    CATransaction.commit()
  }

  /// The pill: the surface, the border and the letters of the panel. The arrow and the rays are layers above it.
  override func draw(_ dirtyRect: NSRect) {
    guard let layout, !layout.pill.isEmpty, !label.isEmpty else { return }
    let pill = layout.pill.insetBy(dx: 0.5, dy: 0.5)
    let shape = NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.30); shadow.shadowBlurRadius = 6; shadow.shadowOffset = NSSize(width: 0, height: -1.5)
    shadow.set()
    Theme.color(.raised).setFill(); shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    Theme.color(.borderSubtle).setStroke(); shape.lineWidth = 1; shape.stroke()
    let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
    let words = NSAttributedString(string: label, attributes: [.font: Self.font, .foregroundColor: Theme.color(.label), .paragraphStyle: style])
    let height = ceil(words.size().height), inset = CGFloat(GuidedLook.pillInset)
    words.draw(with: NSRect(x: pill.minX + inset, y: (pill.midY - height / 2).rounded(), width: pill.width - 2 * inset, height: height),
               options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
  }

  // MARK: Motion

  /// The hands click here: a copy of the rays opens out from the tip and fades, once. The arrow and the rays
  /// stay where they are. With Reduce Motion nothing moves.
  func pulse(still: Bool) {
    echo.removeAllAnimations()
    let frames = GuidedClick.frames(still: still)
    guard frames.count >= 2 else { return }
    let times = frames.indices.map { NSNumber(value: Double($0) / Double(frames.count - 1)) }
    let grow = CAKeyframeAnimation(keyPath: "transform.scale")
    grow.values = frames.map(\.scale); grow.keyTimes = times
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = frames.map { Float($0.opacity) }; fade.keyTimes = times
    let both = CAAnimationGroup(); both.animations = [grow, fade]; both.duration = GuidedClick.duration
    echo.add(both, forKey: "pulse")
  }
}
