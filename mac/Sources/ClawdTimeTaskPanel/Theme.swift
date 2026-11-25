import AppKit
import CoreText
import QuartzCore
import TaskPanelCore

/// The Chert design system for this app: its colors in both themes, its three
/// typefaces, and the controls that every surface here is built from.
enum Theme {
  static func color(_ token: ColorToken, alpha: CGFloat = 1) -> NSColor {
    NSColor(name: nil) { appearance in
      let value = DesignTokens.value(token, dark: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
      return NSColor(srgbRed: value.red, green: value.green, blue: value.blue, alpha: alpha)
    }
  }
  static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  // Variable font axes, as four-letter tags.
  private static let weightAxis: UInt32 = 0x7767_6874, opticalAxis: UInt32 = 0x6F70_737A, softAxis: UInt32 = 0x534F_4654
  private static var registered = false
  /// The brand faces ship inside the app. With no file the system face stands in.
  static func registerFonts() {
    guard !registered else { return }
    registered = true
    for name in ["Fraunces", "InstrumentSans", "JetBrainsMono"] {
      guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts") else { continue }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }
  private static func face(_ family: String, size: CGFloat, axes: [UInt32: CGFloat], fallback: NSFont) -> NSFont {
    registerFonts()
    var variation: [NSNumber: NSNumber] = [:]
    for (axis, value) in axes { variation[NSNumber(value: axis)] = NSNumber(value: Double(value)) }
    let descriptor = NSFontDescriptor(fontAttributes: [.family: family, .variation: variation])
    guard let font = NSFont(descriptor: descriptor, size: size), font.familyName == family else { return fallback }
    return font
  }
  /// Fraunces: the headline, and nothing else.
  static func display(_ size: CGFloat, weight: CGFloat = 600) -> NSFont {
    face("Fraunces", size: size, axes: [weightAxis: weight, opticalAxis: max(9, min(144, size)), softAxis: 50],
         fallback: .systemFont(ofSize: size, weight: .semibold))
  }
  /// Instrument Sans: the whole interface.
  static func sans(_ size: CGFloat, weight: CGFloat = 400) -> NSFont {
    face("Instrument Sans", size: size, axes: [weightAxis: weight], fallback: .systemFont(ofSize: size, weight: weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular))
  }
  /// JetBrains Mono: times, counts, paths.
  static func mono(_ size: CGFloat, weight: CGFloat = 400) -> NSFont {
    face("JetBrains Mono", size: size, axes: [weightAxis: weight], fallback: .monospacedDigitSystemFont(ofSize: size, weight: .regular))
  }

  static func label(_ text: String, font: NSFont, color: ColorToken = .label, lines: Int = 1) -> NSTextField {
    let field = lines == 1 ? NSTextField(labelWithString: text) : NSTextField(wrappingLabelWithString: text)
    field.font = font; field.textColor = Theme.color(color)
    field.maximumNumberOfLines = lines; field.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
    field.isSelectable = false
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
  }
  static func symbol(_ name: String, size: CGFloat, weight: NSFont.Weight = .semibold) -> NSImage? {
    NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: size, weight: weight))
  }
}

extension NSView {
  /// Press: sink to 0.97 over 90 ms. Release: spring back with a slight overshoot.
  func animateScale(_ scale: CGFloat, spring: Bool) {
    wantsLayer = true
    guard let layer, !Theme.reduceMotion else { return }
    let box = bounds
    var transform = CATransform3DMakeTranslation(box.midX, box.midY, 0)
    transform = CATransform3DScale(transform, scale, scale, 1)
    transform = CATransform3DTranslate(transform, -box.midX, -box.midY, 0)
    let animation: CABasicAnimation
    if spring {
      let bounce = CASpringAnimation(perceptualDuration: 0.26, bounce: 0.38)
      bounce.duration = bounce.settlingDuration; animation = bounce
    } else {
      animation = CABasicAnimation(); animation.duration = 0.09
      animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
    }
    animation.keyPath = "transform"
    animation.fromValue = layer.presentation()?.transform ?? layer.transform
    animation.toValue = transform
    layer.transform = transform
    layer.add(animation, forKey: "press")
  }
}

/// One frame clock for everything that moves. It follows the display it is on.
final class FrameClock: NSObject {
  private var link: CADisplayLink?
  private var last: CFTimeInterval = 0
  var onFrame: ((Double) -> Void)?
  var framesPerSecond = 60 { didSet { if framesPerSecond != oldValue { apply() } } }
  func start(on view: NSView) {
    guard link == nil else { return }
    let link = view.displayLink(target: self, selector: #selector(tick(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link; last = 0; apply()
  }
  func stop() { link?.invalidate(); link = nil }
  private func apply() {
    let rate = Float(max(10, min(120, framesPerSecond)))
    link?.preferredFrameRateRange = CAFrameRateRange(minimum: min(rate, 30), maximum: max(rate, 60), preferred: rate)
  }
  @objc private func tick(_ link: CADisplayLink) {
    let now = link.timestamp
    let step = last == 0 ? 1.0 / 60 : now - last
    last = now
    onFrame?(min(max(step, 0), 0.1))
  }
}

/// The button of the design system: a pill. Verbs only.
final class PillButton: NSControl {
  enum Kind { case primary, accent, secondary, danger, ghost }
  var kind: Kind { didSet { needsDisplay = true } }
  var title: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true; setAccessibilityLabel(title) } }
  let small: Bool
  private let symbolName: String?
  private var hovering = false { didSet { needsDisplay = true } }
  private var pressing = false { didSet { needsDisplay = true } }
  private var tracking: NSTrackingArea?
  override var isEnabled: Bool { didSet { needsDisplay = true } }

  init(_ title: String, kind: Kind = .secondary, small: Bool = false, symbol: String? = nil, target: AnyObject?, action: Selector?) {
    self.title = title; self.kind = kind; self.small = small; symbolName = symbol
    super.init(frame: .zero)
    self.target = target; self.action = action
    wantsLayer = true
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel(title)
    setContentHuggingPriority(.defaultHigh, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .vertical)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  private var font_: NSFont { Theme.sans(small ? 12 : 13, weight: 600) }
  private var glyph: NSImage? { symbolName.flatMap { Theme.symbol($0, size: small ? 10 : 11, weight: .bold) } }
  override var intrinsicContentSize: NSSize {
    let text = (title as NSString).size(withAttributes: [.font: font_]).width
    let icon = glyph.map { $0.size.width + 6 } ?? 0
    return NSSize(width: ceil(text + icon) + (small ? 24 : 32), height: small ? 26 : 32)
  }
  override var acceptsFirstResponder: Bool { isEnabled }
  override var focusRingMaskBounds: NSRect { bounds }
  override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill() }
  override func draw(_ dirtyRect: NSRect) {
    let ground: NSColor, ink: NSColor
    switch kind {
    case .primary: ground = Theme.color(.primary); ink = Theme.color(.onPrimary)
    case .accent: ground = Theme.color(.accent); ink = Theme.color(.onAccent)
    case .secondary: ground = Theme.color(pressing ? .fillPressed : .fill); ink = Theme.color(.label)
    case .danger: ground = Theme.color(.dangerTint); ink = Theme.color(.danger)
    case .ghost: ground = hovering || pressing ? Theme.color(.fill) : .clear; ink = Theme.color(.labelSecondary)
    }
    let alpha: CGFloat = isEnabled ? 1 : 0.42
    let pill = NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    ground.withAlphaComponent(ground.alphaComponent * alpha).setFill(); pill.fill()
    if isEnabled && hovering && !pressing && kind != .ghost {
      // One tone step lighter under the pointer.
      NSColor.white.withAlphaComponent(kind == .secondary ? 0.0 : 0.10).setFill(); pill.fill()
      if kind == .secondary { Theme.color(.fillPressed).withAlphaComponent(0.55).setFill(); pill.fill() }
    }
    if pressing { NSColor.black.withAlphaComponent(0.10).setFill(); pill.fill() }
    let attributes: [NSAttributedString.Key: Any] = [.font: font_, .foregroundColor: ink.withAlphaComponent(alpha)]
    let text = (title as NSString).size(withAttributes: attributes)
    let icon = glyph
    let total = text.width + (icon.map { $0.size.width + 6 } ?? 0)
    var x = bounds.midX - total / 2
    if let icon {
      let tinted = NSImage(size: icon.size, flipped: false) { rect in
        icon.draw(in: rect); ink.withAlphaComponent(alpha).set(); rect.fill(using: .sourceAtop); return true
      }
      tinted.draw(in: NSRect(x: x, y: bounds.midY - icon.size.height / 2, width: icon.size.width, height: icon.size.height))
      x += icon.size.width + 6
    }
    (title as NSString).draw(at: NSPoint(x: x, y: bounds.midY - text.height / 2), withAttributes: attributes)
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area); tracking = area
  }
  override func mouseEntered(with event: NSEvent) { hovering = true }
  override func mouseExited(with event: NSEvent) { hovering = false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    pressing = true; animateScale(0.97, spring: false)
  }
  override func mouseUp(with event: NSEvent) {
    guard pressing else { return }
    pressing = false; animateScale(1, spring: true)
    if bounds.contains(convert(event.locationInWindow, from: nil)) { sendAction(action, to: target) }
  }
  override func keyDown(with event: NSEvent) {
    if isEnabled, event.keyCode == 49 || event.keyCode == 36 { sendAction(action, to: target) } else { super.keyDown(with: event) }
  }
  override func accessibilityPerformPress() -> Bool {
    guard isEnabled else { return false }
    sendAction(action, to: target); return true
  }
}

/// A round button that holds one glyph. It always has a name for the pointer and for VoiceOver.
final class IconButton: NSControl {
  var symbolName: String { didSet { if symbolName != oldValue { needsDisplay = true } } }
  /// The glyph takes this color when the control is on, for example a live microphone.
  var active: ColorToken? { didSet { needsDisplay = true } }
  private let diameter: CGFloat
  /// On the desktop, with no panel behind it, the button carries its own ground.
  var floating = false { didSet { needsDisplay = true } }
  var danger = false { didSet { needsDisplay = true } }
  private var hovering = false { didSet { needsDisplay = true } }
  private var pressing = false { didSet { needsDisplay = true } }
  private var tracking: NSTrackingArea?
  init(symbol: String, label: String, diameter: CGFloat = 28, target: AnyObject?, action: Selector?) {
    symbolName = symbol; self.diameter = diameter
    super.init(frame: NSRect(x: 0, y: 0, width: diameter, height: diameter))
    self.target = target; self.action = action
    wantsLayer = true; toolTip = label
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel(label)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override var intrinsicContentSize: NSSize { NSSize(width: diameter, height: diameter) }
  override func draw(_ dirtyRect: NSRect) {
    let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
    if floating {
      Theme.color(.raised).setFill(); circle.fill()
      Theme.color(.borderSubtle).setStroke(); circle.lineWidth = 1; circle.stroke()
    }
    if hovering || pressing { Theme.color(pressing ? .fillPressed : .fill).setFill(); circle.fill() }
    let ink = Theme.color(danger && hovering ? .danger : active ?? (hovering ? .label : .labelSecondary))
    guard let glyph = Theme.symbol(symbolName, size: diameter * 0.40, weight: .bold) else { return }
    let tinted = NSImage(size: glyph.size, flipped: false) { rect in glyph.draw(in: rect); ink.set(); rect.fill(using: .sourceAtop); return true }
    tinted.draw(in: NSRect(x: bounds.midX - glyph.size.width / 2, y: bounds.midY - glyph.size.height / 2, width: glyph.size.width, height: glyph.size.height))
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area); tracking = area
  }
  override func mouseEntered(with event: NSEvent) { hovering = true }
  override func mouseExited(with event: NSEvent) { hovering = false; pressing = false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { pressing = true; animateScale(0.9, spring: false) }
  override func mouseUp(with event: NSEvent) {
    guard pressing else { return }
    pressing = false; animateScale(1, spring: true)
    if bounds.contains(convert(event.locationInWindow, from: nil)) { sendAction(action, to: target) }
  }
  override func accessibilityPerformPress() -> Bool { sendAction(action, to: target); return true }
}

/// A few bars that move with a voice.
final class LevelBarsView: NSView {
  var levels: [Double] = Array(repeating: 0.14, count: 5) { didSet { needsDisplay = true } }
  var tint = ColorToken.labelSecondary { didSet { needsDisplay = true } }
  override var intrinsicContentSize: NSSize { NSSize(width: 34, height: 22) }
  override func draw(_ dirtyRect: NSRect) {
    Theme.color(tint).setFill()
    let width: CGFloat = 3.2, gap: CGFloat = 3.6
    let total = CGFloat(levels.count) * width + CGFloat(levels.count - 1) * gap
    var x = bounds.midX - total / 2
    for level in levels {
      let height = max(width, bounds.height * CGFloat(level))
      NSBezierPath(roundedRect: NSRect(x: x, y: bounds.midY - height / 2, width: width, height: height), xRadius: width / 2, yRadius: width / 2).fill()
      x += width + gap
    }
  }
}
