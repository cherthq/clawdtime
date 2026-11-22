import AppKit
import TaskPanelCore

/// The live mascot and the clock that moves it. It is drawn flat, as solid shapes.
final class MascotView: NSView {
  private let flat = FlatMascotView()
  /// Changes the drawing. The pose, the mood and the clock carry over.
  var style = MascotStyle.flint { didSet { if style != oldValue { rebuild() } } }
  /// Flint with an eye in its window. Off, Flint is the Chert mark and nothing else.
  var flintEye = false { didSet { if flintEye != oldValue { applyFlintEye() } } }
  private func applyFlintEye() {
    (flat.figure as? FlintFlat)?.eye = flintEye
    lastPose = nil; flat.needsDisplay = true
  }
  private func rebuild() {
    lastPose = nil
    jelly(stretch: 0, angle: 0)
    flat.figure = MascotCatalog.flat(style); flat.mood = mood
    applyFlintEye()
    setAccessibilityLabel("ClawdTime, " + style.title)
  }
  let clock = FrameClock()
  private var animator = MascotAnimator(seed: UInt64(Date().timeIntervalSince1970 * 1000) & 0xFFFF_FFFF)
  var mood = MascotMood.idle { didSet { if mood != oldValue { flat.mood = mood; lastPose = nil } } }
  var hovering = false
  var pressed = false
  var dragVelocity = CGVector.zero
  /// Lean toward the middle of the screen while it hangs over an edge, in radians.
  var lean = 0.0
  /// 0 to 1: the loudness of the conversation, when the person talks to ClawdTime.
  var voice = 0.0
  /// What the body's physics says about this frame: the swing, the way it travels, its stretch.
  var motion = BodyPhysics.Frame()
  /// A hand holds the mascot.
  var held = false
  /// Computer use types on the person's Mac: the mascot looks down and taps.
  var typing = false
  /// Another animation is running and wants the full frame rate.
  var boost = false
  /// Runs after each frame of the mascot, on the same clock.
  var afterFrame: ((Double) -> Void)?
  /// Seconds since the pointer last moved.
  private(set) var quietSeconds = 0.0
  private var lastPointer = NSPoint.zero
  private var lastPose: MascotPose?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    flat.wantsLayer = true; flat.layerContentsRedrawPolicy = .onSetNeedsDisplay
    flat.autoresizingMask = [.width, .height]; flat.frame = bounds
    addSubview(flat)
    rebuild()
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel("ClawdTime")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  // The stone never takes the click itself: the window's content view owns the gesture.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  private var shownStretch = 0.0
  /// The whole figure grows longer along its way and thinner across it, and keeps
  /// its area: the stretch of a soft body at speed. It works for every style.
  private func jelly(stretch: Double, angle: Double) {
    guard abs(stretch - shownStretch) > 0.001 || (stretch == 0 && shownStretch != 0) else { return }
    shownStretch = stretch
    guard let layer = flat.layer else { return }
    let box = bounds
    var transform = CGAffineTransform.identity
    if stretch > 0.001 {
      let long = CGFloat(1 + stretch), thin = 1 / long
      transform = CGAffineTransform(translationX: box.midX, y: box.midY)
        .rotated(by: CGFloat(angle)).scaledBy(x: long, y: thin).rotated(by: -CGFloat(angle))
        .translatedBy(x: -box.midX, y: -box.midY)
    }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.setAffineTransform(transform)
    CATransaction.commit()
  }

  func start() {
    clock.onFrame = { [weak self] step in self?.frame(step) }
    clock.start(on: self)
  }
  func stop() { clock.stop() }
  func tap() { animator.tap() }
  func jump() { animator.jump() }
  func wave() { animator.wave() }
  func thud(_ strength: Double) { animator.thud(strength) }
  func nod() { animator.nod() }
  func shake() { animator.shake() }
  func land() { animator.land() }
  func appear() { animator.appear() }

  private func frame(_ step: Double) {
    let pointer = NSEvent.mouseLocation
    if abs(pointer.x - lastPointer.x) + abs(pointer.y - lastPointer.y) > 0.5 { quietSeconds = 0; lastPointer = pointer }
    else { quietSeconds += step }
    var input = MascotInput(mood: mood)
    if let window, window.isVisible {
      let center = window.convertPoint(toScreen: convert(NSPoint(x: bounds.midX, y: bounds.midY), to: nil))
      input.pointerX = max(-1, min(1, Double(pointer.x - center.x) / 380))
      input.pointerY = max(-1, min(1, Double(pointer.y - center.y) / 300))
      input.pointerActive = quietSeconds < 5 && (window.screen?.frame.contains(pointer) ?? true)
    }
    input.hovering = hovering; input.pressed = pressed
    input.dragVelocityX = Double(dragVelocity.dx); input.dragVelocityY = Double(dragVelocity.dy)
    input.reduceMotion = Theme.reduceMotion
    input.voice = voice
    input.swing = motion.swing; input.travel = motion.travel
    input.gait = motion.gait; input.gaitPhase = motion.gaitPhase; input.held = held
    var pose = animator.step(step, input)
    pose.roll += lean
    if typing { TypingBeat.apply(to: &pose, at: animator.time, still: Theme.reduceMotion) }
    if pose != lastPose { flat.pose = pose; lastPose = pose }
    jelly(stretch: Theme.reduceMotion ? 0 : motion.stretch, angle: motion.stretchAngle)
    clock.framesPerSecond = boost ? 120 : typing ? 60 : animator.preferredFramesPerSecond(input)
    afterFrame?(step)
  }
}
