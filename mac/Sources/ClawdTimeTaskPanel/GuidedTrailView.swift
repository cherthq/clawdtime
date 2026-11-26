import AppKit
import QuartzCore
import TaskPanelCore

/// The trail of the calm cursor: a few small round marks in the orange of the cursor, behind its tip, that
/// get smaller and fainter. `GuidedTrail` says where they are. Only layers move: nothing is drawn again. The
/// view takes no click and is no element of the Accessibility tree.
final class GuidedTrailView: NSView {
  private var dots: [CALayer] = []
  private var dark: Bool?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    for _ in 0..<GuidedTrail.count {
      let dot = CALayer()
      dot.opacity = 0
      layer?.addSublayer(dot)
      dots.append(dot)
    }
    setAccessibilityElement(false)
    paint()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); paint() }

  private func paint() {
    let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    guard dark != self.dark else { return }
    self.dark = dark
    let orange = GuidedCursorArt.fill(dark: dark)
    let color = CGColor(srgbRed: CGFloat(orange.red), green: CGFloat(orange.green), blue: CGFloat(orange.blue), alpha: 1)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for dot in dots { dot.backgroundColor = color }
    CATransaction.commit()
  }

  /// Shows `marks`, in screen points from the bottom left. `origin` is the place of the window on the screen.
  func show(_ marks: [GuidedTrail.Mark], origin: CGPoint) {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for (index, dot) in dots.enumerated() {
      guard index < marks.count else { dot.opacity = 0; continue }
      let mark = marks[index], radius = CGFloat(mark.radius)
      dot.bounds = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
      dot.cornerRadius = radius
      dot.position = CGPoint(x: mark.point.x - origin.x, y: mark.point.y - origin.y)
      dot.opacity = Float(mark.opacity)
    }
    CATransaction.commit()
  }
  /// No mark shows.
  func clear() { show([], origin: .zero) }
}
