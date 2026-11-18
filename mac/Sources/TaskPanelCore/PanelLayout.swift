import Foundation
import CoreGraphics

/// Presentation-only state. None of these transitions sends a service operation.
public enum PanelDisplayMode: Equatable {
  case expanded, collapsed, badge
  public var toggled: Self { self == .expanded ? .collapsed : .expanded }
  public func reopened(hasVisibleWindows: Bool) -> Self {
    hasVisibleWindows ? self : .expanded
  }
}
public struct PanelTransition {
  public private(set) var generation: UInt64 = 0
  public private(set) var target: PanelDisplayMode = .expanded
  public init() {}
  @discardableResult public mutating func request(_ target: PanelDisplayMode) -> UInt64 {
    generation &+= 1; self.target = target; return generation
  }
  public func accepts(_ generation: UInt64) -> Bool { self.generation == generation }
}
public struct PanelPlacement {
  public let anchor: CGPoint
  public let toolbar: CGRect
  public let body: CGRect
  public let badge: CGRect
}
public enum PanelLayout {
  public static func clamp(_ frame: CGRect, to visible: CGRect, margin: CGFloat = 10) -> CGRect {
    let safe = visible.insetBy(dx: min(margin, visible.width / 4), dy: min(margin, visible.height / 4))
    let size = CGSize(width: min(frame.width, safe.width), height: min(frame.height, safe.height))
    return CGRect(x: max(safe.minX, min(frame.minX, safe.maxX - size.width)),
      y: max(safe.minY, min(frame.minY, safe.maxY - size.height)), width: size.width, height: size.height)
  }
  public static func placement(in visible: CGRect, anchor proposed: CGPoint? = nil, mode: PanelDisplayMode) -> PanelPlacement {
    let safe = visible.insetBy(dx: 10, dy: 10)
    let barWidth = min(430, max(0, safe.width)), bodyWidth = min(560, max(0, safe.width))
    let badgeSize = min(62, max(0, min(safe.width, safe.height)))
    let barHeight = min(56, max(0, safe.height))
    let minimumBody = min(300, max(0, safe.height - barHeight - 10))
    let groupWidth = mode == .expanded ? bodyWidth : mode == .badge ? badgeSize : barWidth
    let groupHeight = mode == .expanded ? barHeight + 10 + minimumBody : mode == .badge ? badgeSize : barHeight
    let initial = proposed ?? CGPoint(x: safe.midX, y: safe.maxY)
    let anchor = CGPoint(x: max(safe.minX + groupWidth / 2, min(initial.x, safe.maxX - groupWidth / 2)),
      y: min(safe.maxY, max(initial.y, safe.minY + groupHeight)))
    let bar = CGRect(x: anchor.x - barWidth / 2, y: anchor.y - barHeight, width: barWidth, height: barHeight)
    let bodyHeight = min(610, max(0, bar.minY - 10 - safe.minY))
    let body = CGRect(x: anchor.x - bodyWidth / 2, y: bar.minY - 10 - bodyHeight, width: bodyWidth, height: bodyHeight)
    let badge = CGRect(x: anchor.x - badgeSize / 2, y: anchor.y - badgeSize, width: badgeSize, height: badgeSize)
    return PanelPlacement(anchor: anchor, toolbar: bar, body: body, badge: badge)
  }
  public static func toolbar(in visible: CGRect) -> CGRect { placement(in: visible, mode: .expanded).toolbar }
  public static func body(in visible: CGRect) -> CGRect { placement(in: visible, mode: .expanded).body }
  public static func badge(in visible: CGRect, previous: CGRect? = nil) -> CGRect {
    placement(in: visible, anchor: previous.map { CGPoint(x: $0.midX, y: $0.maxY) }, mode: .badge).badge
  }
  public static func interpolate(_ from: CGRect, _ to: CGRect, progress: Double) -> CGRect {
    let t = max(0, min(1, progress)), eased = t * t * (3 - 2 * t)
    return CGRect(x: from.minX + (to.minX - from.minX) * eased,
      y: from.minY + (to.minY - from.minY) * eased,
      width: from.width + (to.width - from.width) * eased,
      height: from.height + (to.height - from.height) * eased)
  }
}

/// An owned view's ordinary mouse gesture, independent of backend actions.
public struct PanelDrag {
  public let pointerStart: CGPoint
  public let windowStart: CGPoint
  public private(set) var didDrag = false
  public init(pointer: CGPoint, window: CGPoint) { pointerStart = pointer; windowStart = window }
  public mutating func move(to pointer: CGPoint) -> CGPoint? {
    let dx = pointer.x - pointerStart.x, dy = pointer.y - pointerStart.y
    if hypot(dx, dy) >= 3 { didDrag = true }
    guard didDrag else { return nil }
    return CGPoint(x: windowStart.x + dx, y: windowStart.y + dy)
  }
}
