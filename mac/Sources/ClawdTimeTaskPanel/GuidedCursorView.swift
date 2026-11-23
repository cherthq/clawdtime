import AppKit
import QuartzCore
import TaskPanelCore

/// What the guided cursor draws: a ring in the two colors of the Chert mark around the place where the hands
/// act, ClawdTime's own small pointer in the same colors, and a pill that says what the hands do there. The
/// sizes are those of `GuidedLook`, so a phone that shows the screen can read it.
///
/// The ring and the pointer are pictures from `GuidedCursorArt`, each on a layer of its own, so they move
/// with no new drawing. Every motion of the ring is about its exact middle: its colors turn, it closes in
/// when the cursor arrives, and a click opens a second ring from it. The small pointer points at the place.
/// While the pointer of the Mac is there, it stands beside it, so a person sees both.
final class GuidedCursorView: NSView {
  private static let font = Theme.sans(CGFloat(GuidedLook.letters), weight: 600)
  /// The ring turns inside its holder. The holder closes in, opens and gives way under a click.
  private let holder = CALayer(), ring = CALayer()
  /// The second ring that a click opens. It is the same picture as the ring.
  private let wave = CALayer()
  /// ClawdTime's own small pointer. Its place is the tip; a shift puts it beside the pointer of the Mac.
  private let pointer = CALayer()
  private var layout: GuidedLayout?
  private var label = ""
  private var beside = false, flying = false
  /// The pixels for each point of the screen that the pictures were made for.
  private var grid = 0.0

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let side = CGFloat(GuidedCursorArt.ringSide)
    for part in [holder, ring, wave] {
      part.bounds = CGRect(x: 0, y: 0, width: side, height: side)
      part.contentsGravity = .resize; part.minificationFilter = .trilinear
    }
    ring.position = CGPoint(x: side / 2, y: side / 2)
    wave.opacity = 0
    holder.addSublayer(ring)
    let box = GuidedCursorArt.pointerSize, inset = CGFloat(GuidedCursorArt.pointerInset)
    pointer.bounds = CGRect(origin: .zero, size: box)
    // The tip of the picture is near its upper left corner. That point is the place of the layer.
    pointer.anchorPoint = CGPoint(x: inset / box.width, y: 1 - inset / box.height)
    pointer.contentsGravity = .resize
    pointer.shadowColor = NSColor.black.cgColor; pointer.shadowOpacity = 0.34; pointer.shadowRadius = 2.5
    pointer.shadowOffset = CGSize(width: 0, height: -1.5)
    for part in [wave, holder, pointer] { layer?.addSublayer(part) }
    setAccessibilityElement(false)
    paint()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
  override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); paint(); place() }

  /// Makes the pictures for the pixels of the screen that the window is on. The two rings get twice as many:
  /// one turns and one grows, and both stay sharp.
  private func paint() {
    let scale = Double(window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
    guard scale != grid else { return }
    grid = scale
    CATransaction.begin(); CATransaction.setDisableActions(true)
    let picture = GuidedCursorArt.ring(scale: scale * 2)
    ring.contents = picture; wave.contents = picture
    pointer.contents = GuidedCursorArt.pointer(scale: scale)
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
  /// Puts the ring and the pointer at the tip, on a whole pixel, with no motion.
  private func place() {
    guard let layout else { return }
    let pixels = CGFloat(max(1, grid))
    let tip = CGPoint(x: (layout.tip.x * pixels).rounded() / pixels, y: (layout.tip.y * pixels).rounded() / pixels)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    holder.position = tip; wave.position = tip; pointer.position = tip
    CATransaction.commit()
  }

  /// The pill: the surface, the border and the letters of the panel. The ring and the pointer are layers.
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

  private static let easeOut = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)

  /// Sets a value of a layer and, with motion, goes to it from what the layer shows now.
  private func move(_ layer: CALayer, _ key: String, to value: Any, from: Any?, seconds: Double, still: Bool) {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.setValue(value, forKeyPath: key)
    CATransaction.commit()
    guard !still, let from else { layer.removeAnimation(forKey: key); return }
    let motion = CABasicAnimation(keyPath: key)
    motion.fromValue = from; motion.toValue = value
    motion.duration = seconds; motion.timingFunction = Self.easeOut
    layer.add(motion, forKey: key)
  }

  /// The colors of the ring turn slowly, to the right, while the cursor is out. With no motion they stay
  /// as the mark has them: warm at the top.
  func turn(_ on: Bool) {
    guard on else { ring.removeAnimation(forKey: "turn"); return }
    guard ring.animation(forKey: "turn") == nil else { return }
    let turn = CABasicAnimation(keyPath: "transform.rotation.z")
    turn.fromValue = 0.0; turn.toValue = -2 * Double.pi
    turn.duration = GuidedLook.turn; turn.repeatCount = .infinity
    ring.add(turn, forKey: "turn")
  }

  /// While the cursor glides, the ring is open and light. At its place it closes in and is solid.
  func fly(_ on: Bool, still: Bool) {
    let open = on && !still
    guard open != flying else { return }
    flying = open
    let shown = holder.presentation() ?? holder
    move(holder, "transform.scale", to: open ? GuidedLook.flight : 1.0, from: shown.value(forKeyPath: "transform.scale"),
      seconds: open ? GuidedLook.aside : GuidedLook.settle, still: still)
    move(holder, "opacity", to: open ? Float(0.7) : Float(1), from: shown.opacity, seconds: open ? GuidedLook.aside : GuidedLook.settle, still: still)
  }

  /// The pointer of the Mac is at the place, or it went away: the small pointer steps aside, or points again.
  func stand(beside on: Bool, still: Bool) {
    guard on != beside else { return }
    beside = on
    let shift = on ? CATransform3DMakeTranslation(CGFloat(GuidedLook.besideX), CGFloat(GuidedLook.besideY), 0) : CATransform3DIdentity
    let shown = (pointer.presentation() ?? pointer).transform
    move(pointer, "transform", to: NSValue(caTransform3D: shift), from: NSValue(caTransform3D: shown), seconds: GuidedLook.aside, still: still)
  }

  /// The hands click here: the ring gives way and comes back, and a second ring opens from it and fades.
  func pulse(still: Bool) {
    wave.removeAllAnimations()
    wave.opacity = 0
    guard !still else {
      // No motion: the second ring shows for a moment, at one size, and goes.
      let show = CAKeyframeAnimation(keyPath: "opacity")
      show.values = [0.9, 0.9, 0]; show.keyTimes = [0, 0.85, 1]; show.duration = 0.3
      wave.add(show, forKey: "pulse")
      return
    }
    let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 1.0; grow.toValue = GuidedLook.pulse
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.9; fade.toValue = 0
    let both = CAAnimationGroup(); both.animations = [grow, fade]; both.duration = 0.45
    both.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
    wave.add(both, forKey: "pulse")
    let press = CAKeyframeAnimation(keyPath: "transform.scale")
    press.values = [1.0, 0.86, 1.0]; press.keyTimes = [0, 0.35, 1]; press.duration = 0.26
    press.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
    holder.add(press, forKey: "press")
  }
}
