import Foundation
import CoreGraphics

/// Presentation-only state. None of these transitions sends a service operation.
public enum PanelDisplayMode: Equatable {
  case expanded, collapsed, badge
  public var toggled: Self { self == .expanded ? .collapsed : .expanded }
  public func reopened(hasVisibleWindows: Bool) -> Self {
    // Activating an already-visible compact toolbar must not expand the task body.
    self == .collapsed && hasVisibleWindows ? .collapsed : .expanded
  }
}
public enum PanelLayout {
  public static func clamp(_ frame: CGRect, to visible: CGRect, margin: CGFloat = 10) -> CGRect {
    let safe = visible.insetBy(dx: min(margin, visible.width / 4), dy: min(margin, visible.height / 4))
    let size = CGSize(width: min(frame.width, safe.width), height: min(frame.height, safe.height))
    return CGRect(x: max(safe.minX, min(frame.minX, safe.maxX - size.width)),
      y: max(safe.minY, min(frame.minY, safe.maxY - size.height)), width: size.width, height: size.height)
  }
  public static func toolbar(in visible: CGRect) -> CGRect {
    let width = min(430, max(0, visible.width - 20))
    return clamp(CGRect(x: visible.midX - width / 2, y: visible.maxY - 66, width: width, height: 56), to: visible)
  }
  public static func body(in visible: CGRect) -> CGRect {
    let bar = toolbar(in: visible)
    let height = max(0, min(610, bar.minY - visible.minY - 24))
    let width = min(560, max(0, visible.width - 20))
    return CGRect(x: visible.midX - width / 2, y: bar.minY - 10 - height, width: width, height: height)
  }
  public static func badge(in visible: CGRect, previous: CGRect? = nil) -> CGRect {
    clamp(previous ?? CGRect(x: visible.maxX - 84, y: visible.maxY - 84, width: 62, height: 62), to: visible)
  }
}
