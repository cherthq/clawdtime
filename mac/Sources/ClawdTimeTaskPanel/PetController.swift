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
  var onApprove: (() -> Void)?
  var onDeny: (() -> Void)?
  /// A request that can be answered here gets Approve and Deny on the bubble itself.
  var showsActions = false { didSet { if showsActions != oldValue { approve.isHidden = !showsActions; deny.isHidden = !showsActions; needsLayout = true } } }
  private lazy var approve = PillButton("Approve", kind: .accent, small: true, target: self, action: #selector(approved))
  private lazy var deny = PillButton("Deny", kind: .secondary, small: true, target: self, action: #selector(denied))
  private let dismiss = IconButton(symbol: "xmark", label: "Dismiss", diameter: 18, target: nil, action: nil)
  private var pressing = false { didSet { needsDisplay = true } }
  static let tailHeight: CGFloat = 7
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    addSubview(title); addSubview(detail); addSubview(dismiss); addSubview(approve); addSubview(deny)
    approve.isHidden = true; deny.isHidden = true
    dismiss.target = self; dismiss.action = #selector(dismissed)
    setAccessibilityElement(true); setAccessibilityRole(.button)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  /// A caption holds what ClawdTime said: up to three lines, where other news has one.
  var caption = false {
    didSet {
      guard caption != oldValue else { return }
      detail.maximumNumberOfLines = caption ? 3 : 1
      detail.lineBreakMode = caption ? .byWordWrapping : .byTruncatingTail
      detail.cell?.wraps = caption; detail.cell?.truncatesLastVisibleLine = true
      needsLayout = true
    }
  }
  /// The room that a caption's extra lines take.
  private var extra: CGFloat {
    guard caption, let font = detail.font else { return 0 }
    let box = (detail.stringValue as NSString).boundingRect(with: NSSize(width: 292 - 28, height: 200), options: [.usesLineFragmentOrigin], attributes: [.font: font])
    return min(34, max(0, ceil(box.height) - 16))
  }
  func fit() -> NSSize {
    let width = caption ? 292 : min(292, max(168, max(title.intrinsicContentSize.width, detail.intrinsicContentSize.width) + 58))
    return NSSize(width: ceil(max(width, showsActions ? 208 : 0)), height: 54 + extra + (showsActions ? 36 : 0) + Self.tailHeight)
  }
  override func layout() {
    super.layout()
    let base = (below ? 0 : Self.tailHeight) + (showsActions ? 36 : 0)
    let extra = self.extra
    title.frame = NSRect(x: 14, y: base + 27 + extra, width: bounds.width - 46, height: 18)
    detail.frame = NSRect(x: 14, y: base + 9, width: bounds.width - 28, height: 16 + extra)
    dismiss.frame = NSRect(x: bounds.width - 26, y: base + 28 + extra, width: 18, height: 18)
    let row = base - 30
    approve.frame = NSRect(x: 12, y: row, width: approve.intrinsicContentSize.width, height: 26)
    deny.frame = NSRect(x: approve.frame.maxX + 8, y: row, width: deny.intrinsicContentSize.width, height: 26)
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
  @objc private func approved() { onApprove?() }
  @objc private func denied() { onDeny?() }
}

/// The bar under the mascot. At rest: chat and talk. In a conversation it widens
/// into the microphone, the level of the voice, the speaker and an end button.
/// Stop sharing and Stop call join it whenever either can be stopped.
final class DockBarView: NSView {
  var talking = false { didSet { if talking != oldValue { needsLayout = true } } }
  let chat: IconButton, talk: IconButton, mic: IconButton, speaker: IconButton, end: IconButton
  let bars = LevelBarsView()
  let sharing: PillButton, call: PillButton
  private var dividers: [CGFloat] = []
  init(target: AnyObject, chat chatAction: Selector, talk talkAction: Selector, mic micAction: Selector, speaker speakerAction: Selector,
       end endAction: Selector, stopSharing: Selector, stopCall: Selector) {
    chat = IconButton(symbol: "text.bubble.fill", label: "Chat with ClawdTime", diameter: 30, target: target, action: chatAction)
    talk = IconButton(symbol: "waveform", label: "Talk to ClawdTime", diameter: 30, target: target, action: talkAction)
    mic = IconButton(symbol: "mic.fill", label: "Mute the microphone", diameter: 30, target: target, action: micAction)
    speaker = IconButton(symbol: "speaker.wave.2.fill", label: "Mute ClawdTime's voice", diameter: 30, target: target, action: speakerAction)
    end = IconButton(symbol: "xmark", label: "End the conversation", diameter: 30, target: target, action: endAction)
    sharing = PillButton("Stop sharing", kind: .danger, small: true, symbol: "stop.fill", target: target, action: stopSharing)
    call = PillButton("Stop call", kind: .danger, small: true, symbol: "phone.down.fill", target: target, action: stopCall)
    super.init(frame: .zero)
    end.danger = true
    for view in [chat, talk, mic, bars, speaker, end, sharing, call] as [NSView] { addSubview(view) }
    sharing.isHidden = true; call.isHidden = true
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  private struct Slot { let view: NSView; let width: CGFloat; let divider: Bool }
  private var row: [Slot] {
    var items: [Slot] = [Slot(view: chat, width: 30, divider: true)]
    if talking {
      items.append(Slot(view: mic, width: 30, divider: false))
      items.append(Slot(view: bars, width: 40, divider: false))
      items.append(Slot(view: speaker, width: 30, divider: false))
      items.append(Slot(view: end, width: 30, divider: false))
    } else {
      items.append(Slot(view: talk, width: 30, divider: false))
    }
    for pill in [sharing, call] where !pill.isHidden {
      items.append(Slot(view: pill, width: pill.intrinsicContentSize.width, divider: false))
    }
    return items
  }
  func fit() -> NSSize {
    var width: CGFloat = 12
    let items = row
    for item in items { width += item.width + (item.divider ? 9 : 0) }
    width += CGFloat(items.count - 1) * 4
    return NSSize(width: width, height: 40)
  }
  override func layout() {
    super.layout()
    for view in [talk, mic, bars, speaker, end] as [NSView] { view.isHidden = true }
    var x: CGFloat = 6
    dividers = []
    for item in row {
      item.view.isHidden = false
      let height = item.view is PillButton ? 26 : item.view is LevelBarsView ? 22 : 30
      item.view.frame = NSRect(x: x, y: (bounds.height - CGFloat(height)) / 2, width: item.width, height: CGFloat(height))
      x += item.width + 4
      if item.divider { dividers.append(x + 2); x += 9 }
    }
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    Theme.color(.raised).setFill(); pill.fill()
    Theme.color(.borderSubtle).setStroke(); pill.lineWidth = 1; pill.stroke()
    Theme.color(.borderSubtle).setFill()
    for x in dividers where x < bounds.width - 8 { NSRect(x: x, y: 11, width: 1, height: bounds.height - 22).fill() }
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
  private var bar: DockBarView!
  private var barWidth = Spring(86, response: 0.30, dampingRatio: 0.72)
  private var phase = 0.0
  private let defaults = UserDefaults.standard

  /// A bubble about one session that waits for the person: its terminal comes forward.
  var onOpenSession: ((String) -> Void)?
  /// request id, "allow" or "deny"
  var onDecide: ((String, String) -> Void)?
  /// The person closed the bubble of something the watcher found: its incident id.
  var onDismissIncident: ((String) -> Void)?
  var onStopSharing: (() -> Void)?
  var onStopCall: (() -> Void)?
  /// A click on the mascot, the chat button of its bar, or a bubble with no session: the chat
  /// opens, where the person gives ClawdTime work. Nothing here lists sessions.
  var onChat: (() -> Void)?
  var onTalk: (() -> Void)?
  var onMic: (() -> Void)?
  var onSpeaker: (() -> Void)?
  var onEndTalk: (() -> Void)?
  /// The loudness of the conversation, read every frame.
  var voiceLevel: (() -> Double)?
  var onHide: (() -> Void)?
  var onMoved: (() -> Void)?
  var menu: (() -> NSMenu)?
  /// Runs on the mascot's clock after the controller's own motion.
  var afterFrame: ((Double) -> Void)?

  private(set) var placement = Placement.free
  private(set) var visible = false
  /// The chat is open beside the mascot: the bubble waits until it closes.
  var sheetOpen = false
  private var origin = CGPoint.zero
  private var dockY: CGFloat = 0
  /// The size that the person chose with the slider, and the window that it gives.
  private var petScale: Double
  private var petSize: CGSize
  private var x = Spring(0, response: 0.40, dampingRatio: 0.78), y = Spring(0, response: 0.40, dampingRatio: 0.78)
  private var reveal = Spring(PetLayout.revealResting, response: 0.34, dampingRatio: 0.74)
  private var lean = Spring(0, response: 0.42, dampingRatio: 0.7)
  private var buttons = Spring(0, response: 0.24, dampingRatio: 0.7)
  private var bubbleShown = Spring(0, response: 0.30, dampingRatio: 0.68)
  private var drag: PanelDrag?
  private var lastDrag: (point: CGPoint, time: TimeInterval)?
  /// The body has weight: while a hand drags it, and after a throw until it rests, its physics owns its place.
  private var body = BodyPhysics(x: 0, y: 0)
  private var bodyActive = false
  private var wasHovering = false
  private var lastWave = -100.0
  private var clockTime = 0.0
  private var dismissedBubble: String?
  private var shownBubble: PetStatus.Bubble?
  private var stopSharingAllowed = false, stopCallAllowed = false
  var status = PetStatus(mood: .offline, headline: "", detail: "", bubble: nil) { didSet { mascot.mood = status.mood } }

  override init() {
    // No choice yet: the start size, which is smaller than the full size.
    petScale = PetLayout.scale(UserDefaults.standard.object(forKey: "pet.size") as? Double ?? PetLayout.defaultScale)
    petSize = PetLayout.size(scale: petScale)
    let size = petSize
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
    bubble.onDismiss = { [weak self] in
      guard let self else { return }
      self.dismissedBubble = self.shownBubble?.key
      // An incident that the person has seen is told to the service, so it leaves every view.
      if let incident = self.shownBubble?.incidentId { self.onDismissIncident?(incident) }
    }
    bubble.onApprove = { [weak self] in self?.decided("allow") }
    bubble.onDeny = { [weak self] in self?.decided("deny") }
    bar = DockBarView(target: self, chat: #selector(chatPressed), talk: #selector(talkPressed), mic: #selector(micPressed), speaker: #selector(speakerPressed),
      end: #selector(endPressed), stopSharing: #selector(stopSharing), stopCall: #selector(stopCall))
    controlsWindow.contentView = bar; controlsWindow.hasShadow = true
    mascot.afterFrame = { [weak self] step in self?.frame(step) }
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  private var visibleFrame: CGRect { (window.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

  /// The mascot's size as a share of its full size. The choice is kept between starts.
  /// The mascot's middle stays where it is while it grows or shrinks.
  var scale: Double {
    get { petScale }
    set {
      petScale = PetLayout.scale(newValue); defaults.set(petScale, forKey: "pet.size")
      let size = PetLayout.size(scale: petScale), old = petSize
      guard size != old else { return }
      petSize = size
      let screen = visibleFrame
      origin = PetLayout.resized(origin: origin, from: old, to: size, in: screen)
      dockY = max(screen.minY + 6, min(dockY + (old.height - size.height) / 2, screen.maxY - size.height - 6))
      let place = target(in: screen)
      window.setFrame(CGRect(origin: place, size: size), display: true)
      gestures.frame = NSRect(origin: .zero, size: size); mascot.frame = gestures.bounds
      x.snap(to: Double(place.x)); y.snap(to: Double(place.y))
      body.place(x: Double(place.x), y: Double(place.y)); bodyActive = false
      layoutControls()
      if visible { save(); onMoved?() }
    }
  }
  /// Flint with an eye in its window. Off, it is the Chert mark and nothing else.
  var flintEye: Bool {
    get { mascot.flintEye }
    set { mascot.flintEye = newValue; defaults.set(newValue, forKey: "pet.flintEye"); mascot.tap() }
  }
  /// How the mascot is drawn. The choice is kept between starts.
  var style: MascotStyle {
    get { mascot.style }
    set { mascot.style = newValue; defaults.set(newValue.rawValue, forKey: "pet.style"); mascot.tap() }
  }
  /// Shows the mascot where the person left it. It takes no focus.
  func show() {
    guard !visible else { return }
    visible = true
    // No choice yet, or a style that is no longer there: the Chert mark.
    mascot.style = MascotStyle(rawValue: defaults.string(forKey: "pet.style") ?? "") ?? .flint
    mascot.flintEye = defaults.bool(forKey: "pet.flintEye")
    let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? visibleFrame
    if defaults.object(forKey: "pet.x") != nil {
      origin = PetLayout.origin(fraction: CGPoint(x: defaults.double(forKey: "pet.x"), y: defaults.double(forKey: "pet.y")), in: screen, size: petSize)
    } else { origin = PetLayout.defaultOrigin(in: screen, size: petSize) }
    dockY = origin.y
    placement = PetSide(rawValue: defaults.string(forKey: "pet.dock") ?? "").map { .docked($0) } ?? .free
    let start = target(in: screen)
    x.snap(to: Double(start.x)); y.snap(to: Double(start.y))
    window.setFrameOrigin(start)
    body.place(x: Double(start.x), y: Double(start.y)); bodyActive = false
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
    case .free: return PetLayout.clamp(origin: origin, size: petSize, in: screen)
    case .docked(let side): return PetLayout.docked(side: side, y: dockY, reveal: reveal.value, in: screen, size: petSize).origin
    }
  }
  private func save() {
    let fraction = PetLayout.fraction(origin: origin, in: visibleFrame, size: petSize)
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
    origin = PetLayout.clamp(origin: CGPoint(x: origin.x, y: dockY), size: petSize, in: visibleFrame)
    // Come back to where it was, but never stay against the edge it was tucked on.
    let screen = visibleFrame
    origin.x = max(screen.minX + 24, min(origin.x, screen.maxX - petSize.width - 24))
    mascot.tap(); save(); onMoved?()
  }
  @objc private func sideRequested() { dock() }
  @objc private func hideRequested() { onHide?() }
  @objc private func chatPressed() { onChat?() }
  @objc private func talkPressed() { onTalk?() }
  @objc private func micPressed() { onMic?() }
  @objc private func speakerPressed() { onSpeaker?() }
  @objc private func endPressed() { onEndTalk?() }
  /// What the conversation does now: the bar and the mascot follow it.
  func setTalk(on: Bool, micOn: Bool, speakerOn: Bool, speaking: Bool, thinking: Bool) {
    if on && isDocked { undock() }
    bar.talking = on
    bar.mic.symbolName = micOn ? "mic.fill" : "mic.slash.fill"
    bar.mic.active = on && micOn && !speaking && !thinking ? .accentText : nil
    bar.mic.toolTip = micOn ? "Mute the microphone" : "Turn the microphone on"
    bar.speaker.symbolName = speakerOn ? "speaker.wave.2.fill" : "speaker.slash.fill"
    bar.speaker.toolTip = speakerOn ? "Mute ClawdTime's voice" : "Let ClawdTime speak"
    bar.bars.tint = speaking ? .accentText : thinking ? .labelSecondary : .info
    bar.talk.toolTip = "Talk to ClawdTime"
  }
  @objc private func stopSharing() { onStopSharing?() }
  @objc private func stopCall() { onStopCall?() }
  @objc private func screensChanged() {
    origin = PetLayout.clamp(origin: origin, size: petSize, in: visibleFrame); dockY = min(dockY, visibleFrame.maxY - petSize.height - 6)
  }

  /// Stop is a safety control: while something can be stopped the mascot comes out of the edge.
  func setStop(sharing: Bool, call: Bool) {
    let changed = sharing != stopSharingAllowed || call != stopCallAllowed
    stopSharingAllowed = sharing; stopCallAllowed = call
    bar.sharing.isHidden = !sharing; bar.call.isHidden = !call
    guard changed else { return }
    if (sharing || call) && isDocked { undock() }
    bar.needsLayout = true
    layoutControls()
  }
  private func layoutControls() {
    // The bar stays under a free mascot. A tucked mascot keeps it only for a conversation or a Stop control.
    guard visible, !isDocked || bar.talking || stopSharingAllowed || stopCallAllowed else { controlsWindow.orderOut(nil); return }
    let size = NSSize(width: CGFloat(barWidth.value), height: 40)
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
      // The hand does not carry the window. It pulls the body, and the body follows with its weight.
      if !bodyActive { body.place(x: Double(window.frame.minX), y: Double(window.frame.minY)); bodyActive = true }
      body.hold(x: Double(moved.x), y: Double(moved.y))
    }
    drag = gesture
  }
  fileprivate func release(_ event: NSEvent) {
    guard let gesture = drag else { return }
    drag = nil; mascot.pressed = false; mascot.dragVelocity = .zero
    // A click opens the chat, where the person gives ClawdTime work. It never opens a list of sessions.
    switch MascotClick.release(didDrag: gesture.didDrag, docked: isDocked) {
    case .none: settle()
    case .undock: undock()
    case .openChat: mascot.jump(); onChat?()
    case .openSession: break
    }
  }
  /// The end of a drag.
  private func settle() {
    let screen = visibleFrame
    if let side = PetLayout.magneticSide(frame: window.frame, in: screen) {
      // Let go against the left or right edge: it tucks there.
      body.place(x: Double(window.frame.minX), y: Double(window.frame.minY)); bodyActive = false
      mascot.motion = BodyPhysics.Frame(); mascot.held = false
      mascot.land(); dock(side)
    } else {
      // Let go in the open: it keeps its speed, slows, and may bounce off an edge.
      body.letGo()
      if body.speed < 1 { mascot.land() }
    }
    updateSideButton()
  }
  private func decided(_ decision: String) {
    guard let shown = shownBubble, let request = shown.decisionId else { return }
    dismissedBubble = shown.key
    onDecide?(request, decision)
  }
  private func bubbleClicked() {
    guard let shown = shownBubble else { return }
    dismissedBubble = shown.key
    switch MascotClick.bubble(shown) {
    case .openSession(let session): onOpenSession?(session)
    case .openChat: onChat?()
    case .undock, .none: break
    }
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
    let inside = !clickThrough && (drag != nil || overStone || overButtons)
    if window.ignoresMouseEvents == inside { window.ignoresMouseEvents = !inside }
    mascot.hovering = inside && drag == nil

    if case .docked(let side) = placement {
      let wants = status.mood == .attention || status.mood == .sharing
      reveal.target = mascot.hovering ? PetLayout.revealHover : wants ? PetLayout.revealAttention : PetLayout.revealResting
      lean.target = side == .right ? 0.30 : -0.30
    } else { lean.target = 0 }
    if let pointing { lean.target = GuidedPath.lean(from: CGPoint(x: box.midX, y: box.midY), to: pointing) }
    reveal.step(step); lean.step(step)
    mascot.lean = lean.value

    clockTime += step
    if mascot.hovering && !wasHovering && drag == nil && !isDocked && clockTime - lastWave > 8 { mascot.wave(); lastWave = clockTime }
    wasHovering = mascot.hovering
    if bodyActive {
      let size = petSize
      let bounds = BodyPhysics.Bounds(minX: Double(screen.minX) + 6, minY: Double(screen.minY) + 6,
        maxX: Double(screen.maxX - size.width) - 6, maxY: Double(screen.maxY - size.height) - 6)
      let moved = body.step(step, bounds: bounds, still: Theme.reduceMotion)
      mascot.motion = moved; mascot.held = body.held
      if moved.impact > 0 { mascot.thud(moved.impact) }
      let next = CGPoint(x: moved.x, y: moved.y)
      if abs(next.x - box.minX) > 0.05 || abs(next.y - box.minY) > 0.05 { window.setFrameOrigin(next); layoutControls(); onMoved?() }
      x.snap(to: moved.x); y.snap(to: moved.y); origin = next
      if !moved.moving && drag == nil {
        // At rest: this is its place from now on.
        bodyActive = false; mascot.motion = BodyPhysics.Frame(); mascot.held = false
        origin = PetLayout.clamp(origin: next, size: petSize, in: screen); dockY = origin.y; save(); updateSideButton()
      }
    } else if drag == nil {
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
      let size = petSize, base = index == 0 ? CGFloat(8) : size.width - 34
      button.frame = NSRect(x: base + 13 * (1 - scale), y: size.height - 34 + 13 * (1 - scale) - 6 * (1 - shown), width: 26 * scale, height: 26 * scale)
    }

    // The bubble: only when there is news, the chat is closed, and it was not dismissed.
    let news = status.bubble.flatMap { $0.key == dismissedBubble || sheetOpen ? nil : $0 }
    if let news, news != shownBubble {
      shownBubble = news
      bubble.title.stringValue = news.title; bubble.detail.stringValue = news.detail
      bubble.showsActions = news.decisionId != nil; bubble.caption = news.caption
      bubble.needsLayout = true
      bubble.toolTip = MascotClick.hint(news)
    }
    bubbleShown.target = news == nil ? 0 : 1
    bubbleShown.step(step)
    if Theme.reduceMotion { bubbleShown.snap() }
    if bubbleShown.value > 0.02, shownBubble != nil {
      let placed = PetLayout.bubble(size: bubble.fit(), pet: window.frame, in: screen, clear: controlsWindow.isVisible ? controlsWindow.frame : nil)
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

    // The bar: its width follows what it holds, and its bars follow the voice.
    barWidth.target = Double(bar.fit().width)
    barWidth.step(step)
    if Theme.reduceMotion { barWidth.snap() }
    if !barWidth.settled || !controlsWindow.isVisible || abs(controlsWindow.frame.width - CGFloat(barWidth.value)) > 0.5 { layoutControls(); controlsWindow.invalidateShadow() }
    controlsWindow.alphaValue = drag?.didDrag == true ? 0.4 : 1
    let voice = voiceLevel?() ?? 0
    mascot.voice = voice
    if bar.talking {
      phase += step
      var meter = VoiceMeter()
      // The meter's own smoothing ran already: here the level only shapes the bars.
      for _ in 0..<12 { meter.feed(rms: voice <= 0 ? 0 : pow(10, (voice * 40 - 50) / 20)) }
      bar.bars.levels = meter.bars(5, phase: phase)
    }

    afterFrame?(step)
    mascot.boost = !(x.settled && y.settled && buttons.settled && bubbleShown.settled && reveal.settled && lean.settled && barWidth.settled) || drag != nil || bodyActive || wantsBoost || voice > 0.02
  }
  /// The chat sets this while it opens or closes.
  var wantsBoost = false

  // MARK: computer use

  private var pointing: CGPoint?
  private var clickThrough = false
  /// The middle of the mascot on the screen, where the guided cursor leaves it. Nil while the mascot is put away.
  var handsOrigin: CGPoint? { visible ? CGPoint(x: window.frame.midX, y: window.frame.midY) : nil }
  /// Where the hands point now: the mascot leans toward it. Nil: it stands straight again.
  func point(at target: CGPoint?) { pointing = target }
  /// The hands type: the mascot shows it.
  func setTyping(_ on: Bool) { mascot.typing = on }
  /// The hands click a place that is behind the mascot: the mascot lets the click through.
  func letClicksThrough(_ on: Bool) { clickThrough = on; if on { window.ignoresMouseEvents = true } }
}
