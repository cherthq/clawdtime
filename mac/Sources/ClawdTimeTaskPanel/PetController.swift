import AppKit
import TaskPanelCore

final class PetWindow: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  // The mascot may hang over a screen edge: the system must not push it back.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
  static func make(size: NSSize) -> PetWindow {
    let window = PetWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.level = .floating; window.isFloatingPanel = true
    window.hidesOnDeactivate = false; window.isReleasedWhenClosed = false
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    window.animationBehavior = .none
    return window
  }
}

/// The window's content: it owns the press, the drag and the context menu.
private final class PetGestureView: NSView {
  weak var controller: PetController?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { controller?.press(event) }
  override func mouseDragged(with event: NSEvent) { controller?.drag(event) }
  override func mouseUp(with event: NSEvent) { controller?.release(event) }
  override func menu(for event: NSEvent) -> NSMenu? { controller?.menu?() }
}

/// What the mascot has to say, in a small card that points at it. A click acts on it.
final class BubbleView: NSView {
  let title = Theme.label("", font: Theme.sans(13, weight: 600))
  let detail = Theme.label("", font: Theme.sans(12), color: .labelSecondary)
  var tail: CGFloat = 40 { didSet { needsDisplay = true } }
  var below = false { didSet { needsDisplay = true; needsLayout = true } }
  var onClick: (() -> Void)?
  var onDismiss: (() -> Void)?
  private let dismiss = IconButton(symbol: "xmark", label: "Dismiss", diameter: 18, target: nil, action: nil)
  private var pressing = false { didSet { needsDisplay = true } }
  static let tailHeight: CGFloat = 7
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    addSubview(title); addSubview(detail); addSubview(dismiss)
    dismiss.target = self; dismiss.action = #selector(dismissed)
    setAccessibilityElement(true); setAccessibilityRole(.button)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  func fit() -> NSSize {
    let width = min(292, max(168, max(title.intrinsicContentSize.width, detail.intrinsicContentSize.width) + 58))
    return NSSize(width: ceil(width), height: 54 + Self.tailHeight)
  }
  override func layout() {
    super.layout()
    let base = below ? 0 : Self.tailHeight
    title.frame = NSRect(x: 14, y: base + 27, width: bounds.width - 46, height: 18)
    detail.frame = NSRect(x: 14, y: base + 9, width: bounds.width - 28, height: 16)
    dismiss.frame = NSRect(x: bounds.width - 26, y: base + 28, width: 18, height: 18)
    setAccessibilityLabel(title.stringValue + ". " + detail.stringValue)
  }
  override func draw(_ dirtyRect: NSRect) {
    let body = NSRect(x: 0.5, y: (below ? 0 : Self.tailHeight) + 0.5, width: bounds.width - 1, height: bounds.height - Self.tailHeight - 1)
    let path = NSBezierPath(roundedRect: body, xRadius: 16, yRadius: 16)
    let tip = NSBezierPath()
    if below {
      tip.move(to: NSPoint(x: tail - 8, y: body.maxY - 0.5)); tip.line(to: NSPoint(x: tail, y: bounds.maxY - 0.5)); tip.line(to: NSPoint(x: tail + 8, y: body.maxY - 0.5))
    } else {
      tip.move(to: NSPoint(x: tail - 8, y: body.minY + 0.5)); tip.line(to: NSPoint(x: tail, y: 0.5)); tip.line(to: NSPoint(x: tail + 8, y: body.minY + 0.5))
    }
    tip.close(); path.append(tip)
    Theme.color(pressing ? .fill : .raised).setFill(); path.fill()
    Theme.color(.borderSubtle).setStroke(); path.lineWidth = 1; path.stroke()
  }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { pressing = true; animateScale(0.97, spring: false) }
  override func mouseUp(with event: NSEvent) {
    guard pressing else { return }
    pressing = false; animateScale(1, spring: true)
    if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
  }
  override func accessibilityPerformPress() -> Bool { onClick?(); return true }
  @objc private func dismissed() { onDismiss?() }
}

/// Stop sharing and Stop call, always one click away while either can be stopped.
final class ControlsView: NSView {
  let sharing: PillButton, call: PillButton
  private let row: NSStackView
  init(target: AnyObject, stopSharing: Selector, stopCall: Selector) {
    sharing = PillButton("Stop sharing", kind: .danger, small: true, symbol: "stop.fill", target: target, action: stopSharing)
    call = PillButton("Stop call", kind: .danger, small: true, symbol: "phone.down.fill", target: target, action: stopCall)
    row = NSStackView(views: [sharing, call])
    super.init(frame: .zero)
    row.orientation = .horizontal; row.spacing = 6; row.detachesHiddenViews = true
    addSubview(row); row.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 5), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5)])
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func draw(_ dirtyRect: NSRect) {
    let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    Theme.color(.raised).setFill(); pill.fill()
    Theme.color(.borderSubtle).setStroke(); pill.lineWidth = 1; pill.stroke()
  }
}

/// The mascot on the desktop: where it sits, how it is dragged, tucked against an
/// edge and brought back, the two buttons on it, its bubble, and the Stop controls.
final class PetController: NSObject {
  enum Placement: Equatable { case free, docked(PetSide) }
  let window: PetWindow
  let mascot: MascotView
  private let gestures = PetGestureView()
  private let closeButton: IconButton, sideButton: IconButton
  private let bubbleWindow: PetWindow
  private let bubble = BubbleView(frame: .zero)
  private let controlsWindow: PetWindow
  private var controls: ControlsView!
  private let defaults = UserDefaults.standard

  var onToggleBoard: (() -> Void)?
  var onOpenSession: ((String) -> Void)?
  var onStopSharing: (() -> Void)?
  var onStopCall: (() -> Void)?
  var onHide: (() -> Void)?
  var onMoved: (() -> Void)?
  var menu: (() -> NSMenu)?
  /// Runs on the mascot's clock after the controller's own motion.
  var afterFrame: ((Double) -> Void)?

  private(set) var placement = Placement.free
  private(set) var visible = false
  var boardOpen = false
  private var origin = CGPoint.zero
  private var dockY: CGFloat = 0
  private var x = Spring(0, response: 0.40, dampingRatio: 0.78), y = Spring(0, response: 0.40, dampingRatio: 0.78)
  private var reveal = Spring(PetLayout.revealResting, response: 0.34, dampingRatio: 0.74)
  private var lean = Spring(0, response: 0.42, dampingRatio: 0.7)
  private var buttons = Spring(0, response: 0.24, dampingRatio: 0.7)
  private var bubbleShown = Spring(0, response: 0.30, dampingRatio: 0.68)
  private var drag: PanelDrag?
  private var lastDrag: (point: CGPoint, time: TimeInterval)?
  private var dismissedBubble: String?
  private var shownBubble: PetStatus.Bubble?
  private var stopSharingAllowed = false, stopCallAllowed = false
  var status = PetStatus(mood: .offline, headline: "", detail: "", bubble: nil) { didSet { mascot.mood = status.mood } }

  override init() {
    let size = PetLayout.petSize
    window = PetWindow.make(size: size)
    mascot = MascotView(frame: NSRect(origin: .zero, size: size))
    closeButton = IconButton(symbol: "xmark", label: "Close ClawdTime. It stays in the menu bar.", diameter: 26, target: nil, action: nil)
    sideButton = IconButton(symbol: "arrow.right.to.line", label: "Tuck against the edge of the screen", diameter: 26, target: nil, action: nil)
    bubbleWindow = PetWindow.make(size: NSSize(width: 200, height: 60))
    controlsWindow = PetWindow.make(size: NSSize(width: 200, height: 36))
    super.init()
    gestures.frame = NSRect(origin: .zero, size: size); gestures.controller = self
    gestures.addSubview(mascot)
    for (button, x) in [(closeButton, CGFloat(8)), (sideButton, size.width - 34)] {
      button.floating = true; button.target = self
      button.frame = NSRect(x: x, y: size.height - 34, width: 26, height: 26)
      button.alphaValue = 0; button.isHidden = true
      gestures.addSubview(button)
    }
    closeButton.danger = true
    closeButton.action = #selector(hideRequested); sideButton.action = #selector(sideRequested)
    window.contentView = gestures
    bubbleWindow.contentView = bubble; bubbleWindow.hasShadow = true
    bubble.onClick = { [weak self] in self?.bubbleClicked() }
    bubble.onDismiss = { [weak self] in self?.dismissedBubble = self?.shownBubble?.key }
    controls = ControlsView(target: self, stopSharing: #selector(stopSharing), stopCall: #selector(stopCall))
    controlsWindow.contentView = controls; controlsWindow.hasShadow = true
    mascot.afterFrame = { [weak self] step in self?.frame(step) }
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  private var visibleFrame: CGRect { (window.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

  /// Pebble or Core. The choice is kept between starts.
  var style: MascotStyle {
    get { mascot.style }
    set { mascot.style = newValue; defaults.set(newValue.rawValue, forKey: "pet.style"); mascot.tap() }
  }
  /// Shows the mascot where the person left it. It takes no focus.
  func show() {
    guard !visible else { return }
    visible = true
    mascot.style = MascotStyle(rawValue: defaults.string(forKey: "pet.style") ?? "") ?? .pebble
    let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? visibleFrame
    if defaults.object(forKey: "pet.x") != nil {
      origin = PetLayout.origin(fraction: CGPoint(x: defaults.double(forKey: "pet.x"), y: defaults.double(forKey: "pet.y")), in: screen)
    } else { origin = PetLayout.defaultOrigin(in: screen) }
    dockY = origin.y
    placement = PetSide(rawValue: defaults.string(forKey: "pet.dock") ?? "").map { .docked($0) } ?? .free
    let start = target(in: screen)
    x.snap(to: Double(start.x)); y.snap(to: Double(start.y))
    window.setFrameOrigin(start)
    window.alphaValue = 0; window.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in context.duration = Theme.reduceMotion ? 0 : 0.18; window.animator().alphaValue = 1 }
    mascot.appear(); mascot.start()
    updateSideButton()
  }
  func hide() {
    guard visible else { return }
    visible = false
    bubbleWindow.orderOut(nil); controlsWindow.orderOut(nil)
    NSAnimationContext.runAnimationGroup({ context in context.duration = Theme.reduceMotion ? 0 : 0.14; window.animator().alphaValue = 0 }) { [weak self] in
      guard let self, !self.visible else { return }
      self.window.orderOut(nil); self.mascot.stop()
    }
  }
  var frame: CGRect { window.frame }
  var isDocked: Bool { if case .docked = placement { return true }; return false }

  private func target(in screen: CGRect) -> CGPoint {
    switch placement {
    case .free: return PetLayout.clamp(origin: origin, in: screen)
    case .docked(let side): return PetLayout.docked(side: side, y: dockY, reveal: reveal.value, in: screen).origin
    }
  }
  private func save() {
    let fraction = PetLayout.fraction(origin: origin, in: visibleFrame)
    defaults.set(Double(fraction.x), forKey: "pet.x"); defaults.set(Double(fraction.y), forKey: "pet.y")
    if case .docked(let side) = placement { defaults.set(side.rawValue, forKey: "pet.dock") } else { defaults.removeObject(forKey: "pet.dock") }
  }
  private func updateSideButton() {
    let side = PetLayout.nearestSide(frame: window.frame, in: visibleFrame)
    sideButton.toolTip = "Tuck against the \(side == .left ? "left" : "right") edge"
    sideButton.setAccessibilityLabel(sideButton.toolTip)
  }

  /// Tucks the mascot against the nearer side edge. It keeps watching from there.
  func dock(_ side: PetSide? = nil) {
    let chosen = side ?? PetLayout.nearestSide(frame: window.frame, in: visibleFrame)
    dockY = window.frame.minY
    placement = .docked(chosen); reveal.target = PetLayout.revealResting
    save(); onMoved?()
  }
  func undock() {
    guard isDocked else { return }
    placement = .free
    origin = PetLayout.clamp(origin: CGPoint(x: origin.x, y: dockY), in: visibleFrame)
    // Come back to where it was, but never stay against the edge it was tucked on.
    let screen = visibleFrame
    origin.x = max(screen.minX + 24, min(origin.x, screen.maxX - PetLayout.petSize.width - 24))
    mascot.tap(); save(); onMoved?()
  }
  @objc private func sideRequested() { dock() }
  @objc private func hideRequested() { onHide?() }
  @objc private func stopSharing() { onStopSharing?() }
  @objc private func stopCall() { onStopCall?() }
  @objc private func screensChanged() {
    origin = PetLayout.clamp(origin: origin, in: visibleFrame); dockY = min(dockY, visibleFrame.maxY - PetLayout.petSize.height - 6)
  }

  /// Stop is a safety control: while something can be stopped the mascot comes out of the edge.
  func setStop(sharing: Bool, call: Bool) {
    let changed = sharing != stopSharingAllowed || call != stopCallAllowed
    stopSharingAllowed = sharing; stopCallAllowed = call
    controls.sharing.isHidden = !sharing; controls.call.isHidden = !call
    guard changed else { return }
    if (sharing || call) && isDocked { undock() }
    layoutControls()
  }
  private func layoutControls() {
    guard visible, stopSharingAllowed || stopCallAllowed else { controlsWindow.orderOut(nil); return }
    controls.layoutSubtreeIfNeeded()
    let size = controls.fittingSize
    controlsWindow.setFrame(PetLayout.controls(size: size, pet: window.frame, in: visibleFrame), display: true)
    if !controlsWindow.isVisible { controlsWindow.orderFrontRegardless(); controlsWindow.invalidateShadow() }
  }

  // MARK: press, drag, release

  fileprivate func press(_ event: NSEvent) {
    mascot.pressed = true
    drag = PanelDrag(pointer: NSEvent.mouseLocation, window: window.frame.origin)
    lastDrag = nil
  }
  fileprivate func drag(_ event: NSEvent) {
    guard var gesture = drag else { return }
    let point = NSEvent.mouseLocation
    if let moved = gesture.move(to: point) {
      if isDocked { placement = .free }
      window.setFrameOrigin(moved)
      x.snap(to: Double(moved.x)); y.snap(to: Double(moved.y)); origin = moved
      let now = event.timestamp
      if let last = lastDrag, now > last.time {
        let span = CGFloat(now - last.time)
        mascot.dragVelocity = CGVector(dx: (point.x - last.point.x) / span, dy: (point.y - last.point.y) / span)
      }
      lastDrag = (point, now)
      layoutControls(); onMoved?()
    }
    drag = gesture
  }
  fileprivate func release(_ event: NSEvent) {
    guard let gesture = drag else { return }
    drag = nil; mascot.pressed = false; mascot.dragVelocity = .zero
    if gesture.didDrag {
      mascot.land()
      let screen = visibleFrame
      if let side = PetLayout.magneticSide(frame: window.frame, in: screen) { dock(side) }
      else { origin = PetLayout.clamp(origin: window.frame.origin, in: screen); dockY = origin.y; save(); onMoved?() }
      updateSideButton()
    } else if isDocked { undock() }
    else { mascot.tap(); onToggleBoard?() }
  }
  private func bubbleClicked() {
    guard let shown = shownBubble else { return }
    dismissedBubble = shown.key
    if let session = shown.sessionId { onOpenSession?(session) } else { onToggleBoard?() }
  }
  /// The mascot answers what the person did: a nod for yes, one shake for no.
  func react(success: Bool) { if success { mascot.nod() } else { mascot.shake() } }

  // MARK: every frame

  private func frame(_ step: Double) {
    guard visible else { return }
    let screen = visibleFrame
    let pointer = NSEvent.mouseLocation
    let box = window.frame
    // The stone and its ring: an ellipse. Clicks outside it go to whatever is behind.
    let dx = (pointer.x - box.midX) / (box.width * 0.42), dy = (pointer.y - (box.midY - 4)) / (box.height * 0.36)
    let overStone = dx * dx + dy * dy <= 1
    let overButtons = buttons.value > 0.3 && pointer.y >= box.maxY - 40 && box.contains(pointer) && (pointer.x <= box.minX + 40 || pointer.x >= box.maxX - 40)
    let inside = drag != nil || overStone || overButtons
    if window.ignoresMouseEvents == inside { window.ignoresMouseEvents = !inside }
    mascot.hovering = inside && drag == nil

    if case .docked(let side) = placement {
      let wants = status.mood == .attention || status.mood == .sharing
      reveal.target = mascot.hovering ? PetLayout.revealHover : wants ? PetLayout.revealAttention : PetLayout.revealResting
      lean.target = side == .right ? 0.30 : -0.30
    } else { lean.target = 0 }
    reveal.step(step); lean.step(step)
    mascot.lean = lean.value

    if drag == nil {
      let goal = target(in: screen)
      x.target = Double(goal.x); y.target = Double(goal.y)
      x.step(step); y.step(step)
      if Theme.reduceMotion { x.snap(); y.snap() }
      let next = CGPoint(x: x.value, y: y.value)
      if abs(next.x - box.minX) > 0.05 || abs(next.y - box.minY) > 0.05 { window.setFrameOrigin(next); layoutControls(); onMoved?() }
    }

    // The two buttons come out when the pointer is on a free mascot.
    buttons.target = mascot.hovering && !isDocked && drag?.didDrag != true ? 1 : 0
    buttons.step(step)
    let shown = CGFloat(max(0, min(1, buttons.value)))
    for (index, button) in [closeButton, sideButton].enumerated() {
      button.isHidden = shown < 0.02
      button.alphaValue = shown
      let scale = 0.6 + 0.4 * shown
      let size = PetLayout.petSize, base = index == 0 ? CGFloat(8) : size.width - 34
      button.frame = NSRect(x: base + 13 * (1 - scale), y: size.height - 34 + 13 * (1 - scale) - 6 * (1 - shown), width: 26 * scale, height: 26 * scale)
    }

    // The bubble: only when there is news, the board is closed, and it was not dismissed.
    let news = status.bubble.flatMap { $0.key == dismissedBubble || boardOpen ? nil : $0 }
    if let news, news != shownBubble {
      shownBubble = news
      bubble.title.stringValue = news.title; bubble.detail.stringValue = news.detail
      bubble.toolTip = news.sessionId == nil ? "Open the board" : "Open this session's terminal"
    }
    bubbleShown.target = news == nil ? 0 : 1
    bubbleShown.step(step)
    if Theme.reduceMotion { bubbleShown.snap() }
    if bubbleShown.value > 0.02, shownBubble != nil {
      let placed = PetLayout.bubble(size: bubble.fit(), pet: window.frame, in: screen)
      bubble.tail = placed.tail; bubble.below = placed.below
      // It grows out of its pointer.
      let grow = CGFloat(min(1.06, max(0, bubbleShown.value)))
      var shape = placed.frame
      shape.size.width *= 0.86 + 0.14 * grow; shape.size.height *= 0.86 + 0.14 * grow
      shape.origin.x = placed.frame.minX + placed.tail * (1 - (0.86 + 0.14 * grow))
      shape.origin.y = placed.below ? placed.frame.maxY - shape.height : placed.frame.minY
      bubbleWindow.setFrame(shape, display: true)
      bubbleWindow.alphaValue = CGFloat(min(1, max(0, bubbleShown.value * 1.4)))
      if !bubbleWindow.isVisible { bubbleWindow.orderFrontRegardless() }
    } else if bubbleWindow.isVisible { bubbleWindow.orderOut(nil); if news == nil { shownBubble = nil } }

    afterFrame?(step)
    mascot.boost = !(x.settled && y.settled && buttons.settled && bubbleShown.settled && reveal.settled && lean.settled) || drag != nil || wantsBoost
  }
  /// The board sets this while it opens or closes.
  var wantsBoost = false
}
