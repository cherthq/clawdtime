import AppKit
import QuartzCore
import TaskPanelCore

/// What the bar shows: a live mark, the sentence, what the hands do now, and Stop.
private final class HandsBarView: NSView {
  static let height: CGFloat = 44
  let title = Theme.label("ClawdTime is using this Mac", font: Theme.sans(13, weight: 600))
  let detail = Theme.label("", font: Theme.sans(12), color: .labelSecondary)
  let stop: PillButton
  private let mark = CALayer()
  init(target: AnyObject, action: Selector) {
    stop = PillButton("Stop", kind: .danger, small: true, symbol: "stop.fill", target: target, action: action)
    super.init(frame: .zero)
    wantsLayer = true
    stop.toolTip = "Stop ClawdTime. Holding Escape does the same."
    stop.setAccessibilityLabel("Stop ClawdTime using this Mac")
    mark.cornerRadius = 4
    layer?.addSublayer(mark)
    for view in [title, detail, stop] as [NSView] { addSubview(view) }
    setAccessibilityElement(true); setAccessibilityRole(.group)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }

  /// The bar is as wide as its words, up to a limit. A long label is cut with an ellipsis.
  func fit() -> NSSize {
    let words = title.intrinsicContentSize.width + (detail.stringValue.isEmpty ? 0 : min(280, detail.intrinsicContentSize.width) + 12)
    return NSSize(width: ceil(16 + 8 + 10 + words + 14 + stop.intrinsicContentSize.width + 9), height: Self.height)
  }
  override func layout() {
    super.layout()
    let middle = bounds.midY
    CATransaction.begin(); CATransaction.setDisableActions(true)
    mark.frame = CGRect(x: 16, y: middle - 4, width: 8, height: 8)
    CATransaction.commit()
    let button = stop.intrinsicContentSize
    stop.frame = NSRect(x: bounds.width - button.width - 9, y: middle - 13, width: button.width, height: 26)
    let titleWidth = ceil(title.intrinsicContentSize.width)
    title.frame = NSRect(x: 34, y: middle - 9, width: titleWidth, height: 18)
    let left = title.frame.maxX + 12
    detail.frame = NSRect(x: left, y: middle - 8.5, width: max(0, stop.frame.minX - 14 - left), height: 17)
    setAccessibilityLabel(title.stringValue + (detail.stringValue.isEmpty ? "" : ". " + detail.stringValue))
  }
  override func draw(_ dirtyRect: NSRect) {
    let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    Theme.color(.raised).setFill(); pill.fill()
    Theme.color(.borderSubtle).setStroke(); pill.lineWidth = 1; pill.stroke()
    mark.backgroundColor = Theme.color(.accent).cgColor
  }
  /// The mark breathes while the hands may act. With Reduce Motion, or after Stop, it is still.
  func setLive(_ live: Bool) {
    mark.removeAllAnimations()
    mark.opacity = live ? 1 : 0.35
    guard live, !Theme.reduceMotion else { return }
    let breath = CABasicAnimation(keyPath: "opacity")
    breath.fromValue = 1; breath.toValue = 0.35; breath.duration = 0.9
    breath.autoreverses = true; breath.repeatCount = .infinity
    breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    mark.add(breath, forKey: "breath")
  }
}

/// The bar at the top of the screen while ClawdTime uses the Mac: what it does
/// now, and Stop. It never takes focus and it is kept out of captures.
@MainActor final class HandsBar: NSObject {
  let window: PetWindow
  private var content: HandsBarView!
  private var live: Bool?
  /// The person pressed Stop.
  var onStop: (() -> Void)?

  override init() {
    window = PetWindow.make(size: NSSize(width: 360, height: HandsBarView.height))
    super.init()
    content = HandsBarView(target: self, action: #selector(stopPressed))
    window.contentView = content
    window.hasShadow = true
    window.sharingType = .none
    // Above the windows of every app, also one that fills the screen.
    window.level = .statusBar
  }
  @objc private func stopPressed() { onStop?() }

  var isShown: Bool { window.isVisible }

  /// Shows the bar with what the hands do now. `stopped`: Stop was pressed and nothing more runs.
  func show(detail: String, stopped: Bool, canStop: Bool) {
    content.detail.stringValue = detail
    content.stop.isEnabled = canStop
    content.stop.title = stopped ? "Stopped" : "Stop"
    if live != !stopped || !window.isVisible { live = !stopped; content.setLive(!stopped) }
    // The main display is the one that the hands use.
    let screen = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    let size = content.fit()
    let width = min(size.width, screen.width - 24)
    let place = NSRect(x: (screen.midX - width / 2).rounded(), y: screen.maxY - size.height - 8, width: width, height: size.height)
    if window.frame != place { window.setFrame(place, display: true); window.invalidateShadow() }
    content.needsLayout = true
    guard !window.isVisible else { return }
    // No fade: the bar is in full view before the first action of a run.
    window.alphaValue = 1
    window.orderFrontRegardless()
  }
  func hide() {
    guard window.isVisible else { return }
    live = nil
    window.orderOut(nil)
  }
}
