import CoreGraphics
import Foundation

/// What the window of the guided cursor must be. The person at the Mac and a
/// person who watches a shared screen on a phone both see where ClawdTime acts,
/// and no click ever lands on the cursor itself.
public struct GuidedOverlay: Equatable, Sendable {
  /// The level of the window, as macOS counts it. The menu bar has 24, the
  /// status items 25 and a menu that is open 101.
  public let level: Int
  /// Every click and every scroll goes through to what is under the window.
  public let ignoresMouseEvents: Bool
  /// The window shows on every Space, and beside an app that fills the screen.
  public let onEverySpace: Bool, besideFullScreenApps: Bool
  /// A screen share and a recording show the window. The picture that the
  /// worker itself takes leaves every window of ClawdTime out by a filter of
  /// its own, so the planner never sees the cursor or its label.
  public let inScreenShare: Bool
  public init(level: Int, ignoresMouseEvents: Bool, onEverySpace: Bool, besideFullScreenApps: Bool, inScreenShare: Bool) {
    self.level = level; self.ignoresMouseEvents = ignoresMouseEvents
    self.onEverySpace = onEverySpace; self.besideFullScreenApps = besideFullScreenApps; self.inScreenShare = inScreenShare
  }
  /// The guided cursor: at the level of a screen saver, which is above every window of every app.
  public static let cursor = GuidedOverlay(level: 1000, ignoresMouseEvents: true, onEverySpace: true, besideFullScreenApps: true, inScreenShare: true)
}

/// The sizes of the guided cursor, in points. They are chosen for a phone that
/// shows the whole screen in a picture 720 pixels high: the pointer, its ring
/// and the letters of the label stay clear there.
public enum GuidedLook {
  /// The pointer, from its tip to the end of its tail.
  public static let pointer = 28.0
  /// The ring around the tip: across, and the width of its line.
  public static let ring = 44.0, ringLine = 3.5
  /// A click opens a second ring to this many times the first.
  public static let pulse = 1.7
  /// The label: its letters, the height of its pill, the space inside the pill at each end,
  /// its greatest width, and the most characters that it shows.
  public static let letters = 20.0, pill = 38.0, pillInset = 15.0, pillMax = 440.0, labelLimit = 44
  /// The space between the ring and the pill, how far under the tip the middle of the pill
  /// is, and how far the pill keeps from the edge of the screen.
  public static let gap = 8.0, drop = 26.0, margin = 8.0
  /// The room around the pill for its soft shadow.
  public static let shade = 8.0

  /// How many pixels `points` take in a picture of the screen that is `shownHeight` pixels high.
  public static func pixels(_ points: Double, screenHeight: Double, shownHeight: Double) -> Double {
    guard points.isFinite, screenHeight.isFinite, shownHeight.isFinite, screenHeight > 0 else { return 0 }
    return max(0, points) * max(0, shownHeight) / screenHeight
  }
  /// The width of the pill for letters that are `text` points wide. With no letters there is no pill.
  public static func pillWidth(text: Double) -> Double {
    guard text.isFinite, text > 0 else { return 0 }
    return min(pillMax, (text + 2 * pillInset).rounded(.up))
  }
  /// What the pill says: the label of the command as one clean line, cut with an ellipsis.
  public static func label(_ text: String) -> String { ElementCleaner.line(text, limit: labelLimit) }
}

/// Where the parts of the guided cursor are for one place of its tip. All
/// points count from the bottom left, as windows do.
public struct GuidedLayout: Equatable, Sendable {
  public enum Side: Equatable, Sendable { case right, left }
  /// The window on the screen. It holds the ring, the pointer and the pill.
  public let window: CGRect
  /// The tip of the pointer inside the window.
  public let tip: CGPoint
  /// The pill inside the window. Empty when there is no label.
  public let pill: CGRect
  /// The pill is on this side of the tip, and under or over it.
  public let side: Side, under: Bool

  /// The square around the tip that holds the ring, its pulse and the pointer.
  public static var reach: Double { (GuidedLook.ring * GuidedLook.pulse / 2 + GuidedLook.ringLine).rounded(.up) }

  /// `tip` is where the tip of the pointer is on the screen, `pillWidth` comes from
  /// `GuidedLook.pillWidth`, and `screen` is the frame of the screen that the tip is on.
  /// The pill is to the right of the tip and a little under it, as a tooltip is. Near the
  /// right edge it goes to the left of the tip, and near the bottom edge over it, so the
  /// label is whole on the screen wherever the hands act.
  public init(tip: CGPoint, pillWidth: Double, screen: CGRect) {
    let reach = Self.reach
    // Every part is first placed from the tip, so the parts keep the same places inside the
    // window while the cursor glides, to the last digit. Only the window moves then.
    let box = CGRect(x: -reach, y: -reach, width: reach * 2, height: reach * 2)
    let width = pillWidth.isFinite ? max(0, min(GuidedLook.pillMax, pillWidth)) : 0
    guard width > 0, tip.x.isFinite, tip.y.isFinite else {
      let at = tip.x.isFinite && tip.y.isFinite ? tip : .zero
      window = box.offsetBy(dx: at.x, dy: at.y); self.tip = CGPoint(x: reach, y: reach); pill = .zero; side = .right; under = true
      return
    }
    let x = Double(tip.x), y = Double(tip.y)
    let away = GuidedLook.ring / 2 + GuidedLook.gap
    let fitsRight = x + away + width <= Double(screen.maxX) - GuidedLook.margin
    let fitsLeft = x - away - width >= Double(screen.minX) + GuidedLook.margin
    // The right side is the usual one. The left side is taken only when it helps.
    let side: Side = fitsRight || !fitsLeft ? .right : .left
    let fitsUnder = y - GuidedLook.drop - GuidedLook.pill / 2 >= Double(screen.minY) + GuidedLook.margin
    var dx = side == .right ? away : -away - width
    var dy = (fitsUnder ? -GuidedLook.drop : GuidedLook.drop) - GuidedLook.pill / 2
    // At the very edge of the screen the pill moves in, so all of it stays in view.
    func within(_ value: Double, _ low: Double, _ high: Double) -> Double { high < low ? low : max(low, min(high, value)) }
    let left = within(x + dx, Double(screen.minX) + GuidedLook.margin, Double(screen.maxX) - GuidedLook.margin - width)
    if left != x + dx { dx = left - x }
    let bottom = within(y + dy, Double(screen.minY) + GuidedLook.margin, Double(screen.maxY) - GuidedLook.margin - GuidedLook.pill)
    if bottom != y + dy { dy = bottom - y }
    let label = CGRect(x: dx, y: dy, width: width, height: GuidedLook.pill)
    let frame = box.union(label.insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade))
    window = frame.offsetBy(dx: tip.x, dy: tip.y)
    self.tip = CGPoint(x: -frame.minX, y: -frame.minY)
    pill = label.offsetBy(dx: -frame.minX, dy: -frame.minY)
    self.side = side; under = fitsUnder
  }

  /// The painted pointer/pulse and label/shadow envelope, in bottom-left screen
  /// points. This excludes transparent window padding. A video crop uses the
  /// envelope, so the label stays attached even when its side flips at an edge.
  public var paintedBounds: CGRect {
    let at = CGPoint(x: window.minX + tip.x, y: window.minY + tip.y)
    let radius = max((GuidedLook.ring + GuidedLook.ringLine) * GuidedLook.pulse / 2,
                     (GuidedLook.ring + GuidedLook.ringLine + 3) / 2)
    let ring = CGRect(x: at.x - radius, y: at.y - radius, width: radius * 2, height: radius * 2)
    // The pointer outline is 15 units wide and 23.4 high. Its shadow fits in the
    // same shade allowance as the pill; normally the pulse already encloses it.
    let pointer = CGRect(x: at.x, y: at.y - GuidedLook.pointer,
      width: GuidedLook.pointer * 15 / 23.4, height: GuidedLook.pointer).insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade)
    let glyphs = ring.union(pointer)
    guard !pill.isEmpty else { return glyphs }
    return glyphs.union(pill.offsetBy(dx: window.minX, dy: window.minY).insetBy(dx: -GuidedLook.shade, dy: -GuidedLook.shade))
  }
}

/// Where the guided cursor goes before the hands type or press a key. Such a
/// command names no place, so the place comes from what the screen says.
public enum GuidedFocus {
  /// A field up to this high is one line of text. A higher one is an area of text.
  public static let lineField = 60.0
  /// How far inside the leading edge the tip is, and how far under the top edge of an area.
  public static let inside = 18.0, underTop = 30.0

  /// `focus` is the frame of the element that has the keyboard, when the Accessibility tree
  /// gives one. All points count from the bottom left of `screen`.
  ///
  /// - A field of one line: the tip is at its lower edge, a little inside its leading edge.
  ///   The pointer hangs under the tip, so it is under the text and hides none of it.
  /// - An area of text: the cursor stays where it last pointed when that is inside the area,
  ///   which is the place that the hands clicked. Otherwise it goes near the top leading corner.
  /// - No frame: the cursor stays where it last pointed. With no such place it shows at the
  ///   real pointer.
  public static func place(focus: CGRect?, shown: CGPoint?, pointer: CGPoint, screen: CGRect) -> CGPoint {
    let last = shown.flatMap { $0.x.isFinite && $0.y.isFinite && screen.contains($0) ? $0 : nil }
    if let focus, !focus.isNull, !focus.isInfinite, focus.origin.x.isFinite, focus.origin.y.isFinite,
      focus.width.isFinite, focus.height.isFinite {
      let visible = focus.intersection(screen)
      if !visible.isNull, visible.width >= 1, visible.height >= 1 {
        let x = Double(visible.minX) + min(inside, Double(visible.width) / 2)
        if Double(visible.height) <= lineField { return CGPoint(x: x, y: Double(visible.minY)) }
        if let last, visible.contains(last) { return last }
        return CGPoint(x: x, y: Double(visible.maxY) - min(underTop, Double(visible.height) / 2))
      }
    }
    return last ?? pointer
  }
}
