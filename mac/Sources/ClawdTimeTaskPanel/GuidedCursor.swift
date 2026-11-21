import AppKit
import QuartzCore
import TaskPanelCore

/// The pointer that the mascot sends out: an arrow in Chert orange, with a ring
/// that opens where the hands click.
private final class GuidedCursorView: NSView {
  /// The window is this large, and the tip of the arrow is at this place in it.
  static let side: CGFloat = 76
  static let tip = CGPoint(x: 26, y: 50)
  private let ring = CAShapeLayer()
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let box = CGRect(x: Self.tip.x - 7, y: Self.tip.y - 7, width: 14, height: 14)
    ring.frame = box
    ring.path = CGPath(ellipseIn: CGRect(origin: .zero, size: box.size), transform: nil)
    ring.fillColor = nil; ring.lineWidth = 2; ring.opacity = 0
    layer?.addSublayer(ring)
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }

  override func draw(_ dirtyRect: NSRect) {
    // The outline of a pointer, from its tip, on a frame that counts down.
    let outline: [(CGFloat, CGFloat)] = [(0, 0), (0, 20), (5.2, 15.4), (8.8, 23.4), (12, 22), (8.4, 14.2), (15, 14.2)]
    let arrow = NSBezierPath()
    for (index, place) in outline.enumerated() {
      let point = NSPoint(x: Self.tip.x + place.0 * 1.15, y: Self.tip.y - place.1 * 1.15)
      if index == 0 { arrow.move(to: point) } else { arrow.line(to: point) }
    }
    arrow.close(); arrow.lineJoinStyle = .round
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.34); shadow.shadowBlurRadius = 5; shadow.shadowOffset = NSSize(width: 0, height: -1.5)
    shadow.set()
    Theme.color(.accent).setFill(); arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    // A pale edge keeps the arrow clear on any ground, dark or bright.
    NSColor.white.withAlphaComponent(0.96).setStroke(); arrow.lineWidth = 1.6; arrow.stroke()
    // The ring takes the orange of the theme that is on now.
    ring.strokeColor = Theme.color(.accent).cgColor
  }
  /// The hands click here: a ring opens from the tip and fades.
  func pulse(still: Bool) {
    ring.removeAllAnimations()
    ring.opacity = 0
    guard !still else {
      // No motion: the ring shows for a moment, at one size, and goes.
      let show = CAKeyframeAnimation(keyPath: "opacity")
      show.values = [0.9, 0.9, 0]; show.keyTimes = [0, 0.85, 1]; show.duration = 0.3
      ring.add(show, forKey: "pulse")
      return
    }
    let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 0.6; grow.toValue = 3.0
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.9; fade.toValue = 0
    let both = CAAnimationGroup(); both.animations = [grow, fade]; both.duration = 0.42
    both.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
    ring.add(both, forKey: "pulse")
  }
}

/// The mascot directs the hands. Before a pointing command, a guided cursor
/// leaves the mascot and travels to the target, and the mascot leans toward it.
/// Only then is the real event sent, so the person sees each action before it
/// happens. The cursor never takes focus, lets every click through, and is kept
/// out of captures. All points here are screen points counted from the bottom
/// left, as windows are.
@MainActor final class GuidedCursor {
  private let pet: PetController
  let window: PetWindow
  private let view = GuidedCursorView(frame: NSRect(x: 0, y: 0, width: GuidedCursorView.side, height: GuidedCursorView.side))
  private let clock = FrameClock()
  private var path: GuidedPath?
  private var elapsed = 0.0
  private var shown: CGPoint?
  private var fade: Task<Void, Never>?

  init(pet: PetController) {
    self.pet = pet
    window = PetWindow.make(size: NSSize(width: GuidedCursorView.side, height: GuidedCursorView.side))
    window.contentView = view
    window.ignoresMouseEvents = true
    window.sharingType = .none
    // Above the menu bar and every app, as the real pointer is.
    window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
    clock.onFrame = { [weak self] step in self?.frame(step) }
  }

  private func place(_ tip: CGPoint) {
    shown = tip
    window.setFrameOrigin(NSPoint(x: tip.x - GuidedCursorView.tip.x, y: tip.y - GuidedCursorView.tip.y))
  }
  private func frame(_ step: Double) {
    guard let path else { return }
    elapsed += step
    place(path.point(at: elapsed))
  }
  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  /// Sends the cursor from the mascot to `target` and returns when it is there.
  /// With Reduce Motion there is no travel: the cursor appears at the target.
  func travel(to target: CGPoint) async {
    fade?.cancel(); fade = nil
    let still = Theme.reduceMotion
    // It leaves the mascot. With the mascot put away, it leaves from where it last was.
    let start = pet.handsOrigin ?? shown ?? NSEvent.mouseLocation
    let way = GuidedPath(from: start, to: target, still: still)
    pet.point(at: target)
    elapsed = 0; path = way
    place(way.point(at: 0))
    // A fade that still runs ends here.
    NSAnimationContext.runAnimationGroup({ context in context.duration = 0; window.animator().alphaValue = 1 }, completionHandler: nil)
    window.alphaValue = 1
    window.orderFrontRegardless()
    clock.framesPerSecond = 120
    clock.start(on: view)
    await pause(way.duration)
    path = nil
    clock.stop()
    place(target)
    // A moment at the target: the eye is there before the hand.
    await pause(still ? 0.14 : 0.07)
  }
  /// The hands click where the cursor is.
  func pulse() { if window.isVisible { view.pulse(still: Theme.reduceMotion) } }
  /// The command is done: the mascot stands straight, and the cursor fades unless another command sends it out again.
  func rest() {
    pet.point(at: nil)
    guard window.isVisible, fade == nil else { return }
    fade = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 650_000_000)
      guard let self, !Task.isCancelled else { return }
      if !Theme.reduceMotion {
        NSAnimationContext.runAnimationGroup({ context in context.duration = 0.18; self.window.animator().alphaValue = 0 }, completionHandler: nil)
        try? await Task.sleep(nanoseconds: 200_000_000)
        // Another command sent it out again while it faded.
        guard !Task.isCancelled else { return }
      }
      self.fade = nil
      self.window.orderOut(nil)
    }
  }
  /// The run is over, or it was stopped: nothing points any more.
  func hide() {
    fade?.cancel(); fade = nil
    path = nil
    clock.stop()
    pet.point(at: nil)
    if window.isVisible { window.orderOut(nil) }
  }
  /// The hands type, or stop typing: the mascot shows it.
  func typing(_ on: Bool) { pet.setTyping(on) }
}
