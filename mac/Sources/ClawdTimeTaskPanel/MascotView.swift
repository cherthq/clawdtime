import AppKit
import SceneKit
import TaskPanelCore

/// The live mascot and the clock that moves it. It is drawn flat, as solid shapes,
/// or as the lit 3D figure: the pose, the mood and the body's physics are the same.
final class MascotView: NSView {
  /// The lit 3D figure. It is built only when the person chooses that look.
  private var solid: MascotFigure?
  private let flat = FlatMascotView()
  /// Flat shapes, or the 3D figure.
  var look = MascotLook.flat { didSet { if look != oldValue { rebuild() } } }
  /// Changes the drawing. The pose, the mood and the clock carry over.
  var style = MascotStyle.flint { didSet { if style != oldValue { rebuild() } } }
  private func rebuild() {
    lastPose = nil
    jelly(stretch: 0, angle: 0)
    flat.isHidden = look != .flat; scene.isHidden = look == .flat; deskShadow.isHidden = look == .flat
    if look == .flat {
      flat.figure = MascotCatalog.flat(style); flat.mood = mood
      solid = nil; scene.scene = nil
    } else {
      let figure = MascotCatalog.make(style)
      figure.set(mood: mood)
      solid = figure; scene.scene = figure.scene; scene.pointOfView = figure.camera
      flat.figure = nil
    }
    setAccessibilityLabel("ClawdTime, " + style.title)
  }
  let clock = FrameClock()
  private let scene = SCNView()
  private let deskShadow = CALayer()
  /// Fades the last points at each edge to nothing, so a glow that reaches the
  /// edge of the window ends softly and never shows the window's square.
  private let feather = CALayer()
  private var animator = MascotAnimator(seed: UInt64(Date().timeIntervalSince1970 * 1000) & 0xFFFF_FFFF)
  var mood = MascotMood.idle { didSet { if mood != oldValue { solid?.set(mood: mood); flat.mood = mood; lastPose = nil } } }
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
    deskShadow.contents = Self.shadowImage()
    deskShadow.opacity = 0.9
    layer?.addSublayer(deskShadow)
    scene.backgroundColor = .clear
    scene.antialiasingMode = .multisampling4X
    scene.rendersContinuously = false; scene.isPlaying = false
    scene.allowsCameraControl = false; scene.autoenablesDefaultLighting = false
    scene.autoresizingMask = [.width, .height]; scene.frame = bounds
    addSubview(scene)
    scene.wantsLayer = true
    feather.contents = Self.featherImage()
    feather.contentsCenter = CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2)
    scene.layer?.mask = feather
    flat.wantsLayer = true; flat.layerContentsRedrawPolicy = .onSetNeedsDisplay
    flat.autoresizingMask = [.width, .height]; flat.frame = bounds
    addSubview(flat)
    rebuild()
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel("ClawdTime")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  // The stone never takes the click itself: the window's content view owns the gesture.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func layout() {
    super.layout()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    feather.frame = scene.bounds
    feather.contentsScale = window?.backingScaleFactor ?? 2
    CATransaction.commit()
  }
  private var shownStretch = 0.0
  /// The whole figure grows longer along its way and thinner across it, and keeps
  /// its area: the stretch of a soft body at speed. It works for every style.
  private func jelly(stretch: Double, angle: Double) {
    guard abs(stretch - shownStretch) > 0.001 || (stretch == 0 && shownStretch != 0) else { return }
    shownStretch = stretch
    guard let layer = (look == .flat ? flat : scene).layer else { return }
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
  /// Solid in the middle, clear at the edges, with a soft step of about ten points between.
  private static func featherImage() -> CGImage {
    let size = 96, inset: CGFloat = 13
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // The blurred copy of the shape gives the soft step; the shape itself keeps the middle solid.
    context.setShadow(offset: .zero, blur: 9, color: NSColor.black.cgColor)
    context.setFillColor(NSColor.black.cgColor)
    let box = CGRect(x: inset, y: inset, width: CGFloat(size) - inset * 2, height: CGFloat(size) - inset * 2)
    context.addPath(CGPath(roundedRect: box, cornerWidth: 12, cornerHeight: 12, transform: nil)); context.fillPath()
    return context.makeImage()!
  }
  private static func shadowImage() -> CGImage {
    let context = CGContext(data: nil, width: 128, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
      colors: [NSColor.black.withAlphaComponent(0.34).cgColor, NSColor.black.withAlphaComponent(0.12).cgColor, NSColor.black.withAlphaComponent(0).cgColor] as CFArray,
      locations: [0, 0.5, 1])!
    context.scaleBy(x: 1, y: 0.25)
    context.drawRadialGradient(gradient, startCenter: CGPoint(x: 64, y: 64), startRadius: 0, endCenter: CGPoint(x: 64, y: 64), endRadius: 64, options: [])
    return context.makeImage()!
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
    if pose != lastPose, look == .flat {
      flat.pose = pose; lastPose = pose
    } else if pose != lastPose {
      solid?.apply(pose); lastPose = pose
      // The shadow stays on the desk: it shrinks and fades as the stone rises.
      let height = CGFloat(max(0, pose.bob + pose.lift + 0.05))
      let width = bounds.width * 0.46 * (1 - min(0.4, height * 0.7)) * CGFloat(pose.scale)
      CATransaction.begin(); CATransaction.setDisableActions(true)
      deskShadow.frame = CGRect(x: bounds.midX - width / 2, y: bounds.height * 0.155, width: width, height: width * 0.25)
      deskShadow.opacity = Float(max(0.25, 0.95 - height * 1.6))
      CATransaction.commit()
    }
    jelly(stretch: Theme.reduceMotion ? 0 : motion.stretch, angle: motion.stretchAngle)
    clock.framesPerSecond = boost ? 120 : animator.preferredFramesPerSecond(input)
    afterFrame?(step)
  }
}
