import AppKit
import SceneKit
import TaskPanelCore

/// The live mascot: the 3D stone, its shadow, and the clock that moves both.
final class MascotView: NSView {
  let mascot = MascotScene()
  let clock = FrameClock()
  private let scene = SCNView()
  private let deskShadow = CALayer()
  private var animator = MascotAnimator(seed: UInt64(Date().timeIntervalSince1970 * 1000) & 0xFFFF_FFFF)
  var mood = MascotMood.idle { didSet { if mood != oldValue { mascot.set(mood: mood) } } }
  var hovering = false
  var pressed = false
  var dragVelocity = CGVector.zero
  /// Lean toward the middle of the screen while it hangs over an edge, in radians.
  var lean = 0.0
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
    scene.scene = mascot.scene; scene.pointOfView = mascot.camera
    scene.backgroundColor = .clear
    scene.antialiasingMode = .multisampling4X
    scene.rendersContinuously = false; scene.isPlaying = false
    scene.allowsCameraControl = false; scene.autoenablesDefaultLighting = false
    scene.autoresizingMask = [.width, .height]; scene.frame = bounds
    addSubview(scene)
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel("ClawdTime")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  // The stone never takes the click itself: the window's content view owns the gesture.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

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
    var pose = animator.step(step, input)
    pose.roll += lean
    if pose != lastPose {
      mascot.apply(pose); lastPose = pose
      // The shadow stays on the desk: it shrinks and fades as the stone rises.
      let height = CGFloat(max(0, pose.bob + pose.lift + 0.05))
      let width = bounds.width * 0.46 * (1 - min(0.4, height * 0.7)) * CGFloat(pose.scale)
      CATransaction.begin(); CATransaction.setDisableActions(true)
      deskShadow.frame = CGRect(x: bounds.midX - width / 2, y: bounds.height * 0.155, width: width, height: width * 0.25)
      deskShadow.opacity = Float(max(0.25, 0.95 - height * 1.6))
      CATransaction.commit()
    }
    clock.framesPerSecond = boost ? 120 : animator.preferredFramesPerSecond(input)
    afterFrame?(step)
  }
}
