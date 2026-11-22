import AppKit
import QuartzCore
import TaskPanelCore

/// What the guided cursor draws: a pointer in Chert orange inside a bright
/// ring, and beside it a pill that says what the hands do there. The sizes are
/// those of `GuidedLook`, so a phone that shows the screen can read it.
private final class GuidedCursorView: NSView {
  /// The outline of a pointer, from its tip, on a frame that counts down. It is 23.4 units high.
  private static let outline: [(CGFloat, CGFloat)] = [(0, 0), (0, 20), (5.2, 15.4), (8.8, 23.4), (12, 22), (8.4, 14.2), (15, 14.2)]
  private static let font = Theme.sans(CGFloat(GuidedLook.letters), weight: 600)
  /// The ring that a click opens. It is the one part that moves by itself.
  private let wave = CAShapeLayer()
  private var layout: GuidedLayout?
  private var label = ""

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    wave.fillColor = nil; wave.lineWidth = CGFloat(GuidedLook.ringLine); wave.opacity = 0
    layer?.addSublayer(wave)
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }

  /// The width of the pill that `label` needs. Zero for no label.
  static func pillWidth(for label: String) -> Double {
    guard !label.isEmpty else { return 0 }
    return GuidedLook.pillWidth(text: Double(NSAttributedString(string: label, attributes: [.font: font]).size().width))
  }

  /// Shows the parts where `layout` puts them. It draws again only when a part moved inside the window.
  func show(_ layout: GuidedLayout, label: String) {
    guard layout.tip != self.layout?.tip || layout.pill != self.layout?.pill || label != self.label else { return }
    self.layout = layout; self.label = label
    let across = CGFloat(GuidedLook.ring)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    wave.frame = CGRect(x: layout.tip.x - across / 2, y: layout.tip.y - across / 2, width: across, height: across)
    wave.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: across, height: across), transform: nil)
    CATransaction.commit()
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let layout else { return }
    let tip = layout.tip, accent = Theme.color(.accent)
    // The pill: the surface, the border and the letters of the panel.
    if !layout.pill.isEmpty, !label.isEmpty {
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
    // The ring: a faint field, a pale edge and the orange line, so it is bright on any ground.
    let across = CGFloat(GuidedLook.ring)
    let circle = NSBezierPath(ovalIn: NSRect(x: tip.x - across / 2, y: tip.y - across / 2, width: across, height: across))
    accent.withAlphaComponent(0.12).setFill(); circle.fill()
    NSColor.white.withAlphaComponent(0.92).setStroke(); circle.lineWidth = CGFloat(GuidedLook.ringLine) + 3; circle.stroke()
    accent.setStroke(); circle.lineWidth = CGFloat(GuidedLook.ringLine); circle.stroke()
    // The pointer, over the ring, with its tip at the middle.
    let scale = CGFloat(GuidedLook.pointer) / 23.4
    let arrow = NSBezierPath()
    for (index, place) in Self.outline.enumerated() {
      let point = NSPoint(x: tip.x + place.0 * scale, y: tip.y - place.1 * scale)
      if index == 0 { arrow.move(to: point) } else { arrow.line(to: point) }
    }
    arrow.close(); arrow.lineJoinStyle = .round
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.34); shadow.shadowBlurRadius = 5; shadow.shadowOffset = NSSize(width: 0, height: -1.5)
    shadow.set()
    accent.setFill(); arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    // A pale edge keeps the arrow clear on any ground, dark or bright.
    NSColor.white.withAlphaComponent(0.96).setStroke(); arrow.lineWidth = 1.8; arrow.stroke()
    // The ring of a click takes the orange of the theme that is on now.
    wave.strokeColor = accent.cgColor
  }

  /// The hands click here: a second ring opens from the first and fades.
  func pulse(still: Bool) {
    wave.removeAllAnimations()
    wave.opacity = 0
    guard !still else {
      // No motion: the ring shows for a moment, at one size, and goes.
      let show = CAKeyframeAnimation(keyPath: "opacity")
      show.values = [0.9, 0.9, 0]; show.keyTimes = [0, 0.85, 1]; show.duration = 0.3
      wave.add(show, forKey: "pulse")
      return
    }
    let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 1.0; grow.toValue = GuidedLook.pulse
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.9; fade.toValue = 0
    let both = CAAnimationGroup(); both.animations = [grow, fade]; both.duration = 0.42
    both.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
    wave.add(both, forKey: "pulse")
  }
}

/// The live cursor of computer use. Before the hands click, scroll, drag or
/// type, this cursor glides to the place, with a short label of what they do
/// there. Only then does the real event go, so a person sees each action before
/// it happens: at the Mac, and on a phone that shows the screen.
///
/// Its window is above every other window, shows on every Space and lets
/// every click through: `GuidedOverlay.cursor` holds that rule. A screen share
/// shows it. The picture that the worker takes leaves it out, as it leaves out
/// every window of ClawdTime. With Reduce Motion the cursor jumps and nothing
/// glides. All points here are screen points counted from the bottom left, as
/// windows are.
@MainActor final class GuidedCursor {
  private let pet: PetController
  let window: PetWindow
  private let view = GuidedCursorView(frame: .zero)
  private let clock = FrameClock()
  private var path: GuidedPath?
  private var elapsed = 0.0
  private var shown: CGPoint?
  private var label = ""
  private var pillWidth = 0.0
  private var fade: Task<Void, Never>?

  init(pet: PetController) {
    self.pet = pet
    let rule = GuidedOverlay.cursor
    let side = CGFloat(GuidedLayout.reach * 2)
    window = PetWindow.make(size: NSSize(width: side, height: side))
    window.contentView = view
    window.ignoresMouseEvents = rule.ignoresMouseEvents
    // A screen share and a recording show the cursor. The worker's own picture does not.
    window.sharingType = rule.inScreenShare ? .readOnly : .none
    // Above the menu bar, an open menu and every app, as the real pointer is.
    window.level = NSWindow.Level(rawValue: rule.level)
    var spaces: NSWindow.CollectionBehavior = [.stationary, .ignoresCycle]
    if rule.onEverySpace { spaces.insert(.canJoinAllSpaces) }
    if rule.besideFullScreenApps { spaces.insert(.fullScreenAuxiliary) }
    window.collectionBehavior = spaces
    clock.onFrame = { [weak self] step in self?.frame(step) }
  }

  /// Where the tip is now, while the cursor is on the screen.
  var place: CGPoint? { window.isVisible ? shown : nil }
  /// The main display: the one that the hands use.
  private var screen: CGRect { (NSScreen.screens.first ?? NSScreen.main)?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

  /// The size that the window was last given. While it stays, only the place of the window changes.
  private var size = CGSize.zero
  private func put(_ tip: CGPoint) {
    shown = tip
    let layout = GuidedLayout(tip: tip, pillWidth: pillWidth, screen: screen)
    if size == layout.window.size { window.setFrameOrigin(layout.window.origin) }
    else { size = layout.window.size; window.setFrame(layout.window, display: false) }
    view.show(layout, label: label)
  }
  private func frame(_ step: Double) {
    guard let path else { return }
    elapsed += step
    put(path.point(at: elapsed))
  }
  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  /// Sends the cursor to `target` with the label of the command, and returns
  /// when it is there and the person had a moment to read it. While it is on
  /// the screen it goes on from where it is; else it comes out of the mascot.
  /// With Reduce Motion there is no glide: the cursor is at the target at once.
  func travel(to target: CGPoint, label text: String) async {
    fade?.cancel(); fade = nil
    let still = Theme.reduceMotion
    let way = GuidedPath.glide(from: GuidedPath.origin(shown: place, mascot: pet.handsOrigin, pointer: NSEvent.mouseLocation), to: target, still: still)
    pet.point(at: target)
    label = GuidedLook.label(text); pillWidth = GuidedCursorView.pillWidth(for: label)
    elapsed = 0; path = way
    put(way.point(at: 0))
    // A fade that still runs ends here.
    NSAnimationContext.runAnimationGroup({ context in context.duration = 0; window.animator().alphaValue = 1 }, completionHandler: nil)
    window.alphaValue = 1
    // In front of every window, with no focus taken: the window can never be key or main.
    window.orderFrontRegardless()
    if way.duration > 0 {
      clock.framesPerSecond = 120
      clock.start(on: view)
      await pause(way.duration)
      clock.stop()
    }
    path = nil
    put(target)
    await pause(GuidedPath.dwell(still: still))
  }
  /// The hands click where the cursor is.
  func pulse() { if window.isVisible { view.pulse(still: Theme.reduceMotion) } }
  /// The command is done: the mascot stands straight, and the cursor fades unless another command sends it on.
  func rest() {
    pet.point(at: nil)
    guard window.isVisible, fade == nil else { return }
    fade = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(GuidedPath.rest * 1_000_000_000))
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
