import CoreGraphics
import Foundation

/// One requested adjacent desktop, or the inverse of the panel's last verified step.
public enum DesktopDirection: String, Codable, Sendable, CaseIterable {
  case left, right, previous
  public var inverse: DesktopDirection? {
    switch self { case .left: return .right; case .right: return .left; case .previous: return nil }
  }
}

/// Keep only a verified adjacent move. No desktop numbers or private Space IDs.
public struct DesktopSwitchHistory<Surface: Equatable> {
  private var step: (direction: DesktopDirection, from: Surface, to: Surface)?
  public init() {}
  public mutating func invalidate() { step = nil }
  public mutating func verified(_ direction: DesktopDirection, from: Surface, to: Surface) {
    guard direction != .previous, from != to else { step = nil; return }
    step = (direction, from, to)
  }
  public func previous(from current: Surface) -> (direction: DesktopDirection, target: Surface)? {
    guard let step, step.to == current, let inverse = step.direction.inverse else { return nil }
    return (inverse, step.from)
  }
}

/// Full-screen acceptance requires affirmative AX evidence and a window that
/// spans the sole display, allowing only the system menu/notch inset at its top.
/// A half-screen Split View window or an inferred full-screen frame is insufficient.
public enum DesktopSurfaceScope {
  public static func fullScreenGeometry(window: CGRect, display: CGRect) -> Bool {
    display.contains(window) && abs(window.minX - display.minX) <= 1 && abs(window.maxX - display.maxX) <= 1 &&
      abs(window.maxY - display.maxY) <= 1 && window.minY - display.minY <= 80 && window.height >= display.height * 0.85
  }
  public static func permits(window: CGRect, display: CGRect, ordinary: Bool, fullScreen: Bool,
                             activeDisplays: Int, transition: Bool, fullScreenConfirmed: Bool = false) -> Bool {
    guard !window.isNull, !window.isEmpty, !window.intersection(display).isEmpty else { return false }
    guard transition else { return true }
    guard activeDisplays == 1, ordinary, display.contains(window) else { return false }
    return !fullScreen || (fullScreenConfirmed && fullScreenGeometry(window: window, display: display))
  }
}

/// Metadata only: a Quartz row has no screen pixels or window contents.
public struct DesktopWindowEvidence {
  public let id: Int, pid: Int
  public let title: String?
  public let frame: CGRect
  public init(id: Int, pid: Int, title: String?, frame: CGRect) {
    self.id = id; self.pid = pid; self.title = title; self.frame = frame
  }
}
public enum DesktopWindowVisibility {
  private static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
  }
  /// Match exactly one focused AX window to visible Quartz metadata. At most one
  /// same-app full-width auxiliary top strip may precede it, and only when AX
  /// confirms full screen and does not expose the strip as a real window/dialog.
  public static func focusedWindowID(pid: Int, title: String, frame: CGRect, fullScreenConfirmed: Bool,
                                     display: CGRect, visible: [DesktopWindowEvidence], accessibleFrames: [CGRect]?) -> Int? {
    let matches = visible.indices.filter { visible[$0].pid == pid && visible[$0].title == title && sameFrame(visible[$0].frame, frame) }
    guard matches.count == 1, let index = matches.first else { return nil }
    if index == 0 { return visible[index].id }
    guard index == 1, fullScreenConfirmed, DesktopSurfaceScope.fullScreenGeometry(window: frame, display: display),
      let accessibleFrames else { return nil }
    let strip = visible[0]
    guard strip.pid == pid, strip.id != visible[index].id,
      abs(strip.frame.minX - frame.minX) <= 1, abs(strip.frame.width - frame.width) <= 1,
      abs(strip.frame.minY - frame.minY) <= 1, strip.frame.height > 0, strip.frame.height <= 80,
      strip.frame.height <= frame.height * 0.12, frame.contains(strip.frame),
      !accessibleFrames.contains(where: { sameFrame($0, strip.frame) }) else { return nil }
    return visible[index].id
  }
}

/// App switching can stay within a Space or enter another. A changed PID and
/// stable independently observed window are required; desktop history is separate.
public struct AppSwitchSettlement<Surface: Equatable> {
  private let originPID: Int
  private var settlement: DesktopSettlement<Surface>
  private var lastEpoch: Int?
  public init(originPID: Int, at: TimeInterval) { self.originPID = originPID; settlement = .init(at: at) }
  public mutating func sample(_ surface: Surface?, pid: Int?, epoch: Int, at: TimeInterval) -> DesktopSettlement<Surface>.Decision {
    if lastEpoch != epoch { _ = settlement.sample(nil, at: at); lastEpoch = epoch }
    return settlement.sample(pid != nil && pid != originPID ? surface : nil, at: at)
  }
}

public struct DesktopResolvedShortcut: Equatable, Sendable {
  public let code: UInt16
  public let flags: UInt64
  public init(code: UInt16, flags: UInt64) { self.code = code; self.flags = flags }
}
public struct DesktopShortcutPair: Equatable, Sendable {
  public let left: DesktopResolvedShortcut, right: DesktopResolvedShortcut
  public func shortcut(for direction: DesktopDirection) -> DesktopResolvedShortcut? {
    switch direction { case .left: return left; case .right: return right; case .previous: return nil }
  }
}

/// Environment values attest the settings' meaning; public Carbon inventory can
/// independently verify only that those distinct combinations are enabled.
public enum DesktopShortcutConfiguration {
  private static let standardFlags = KeyCombo.command | KeyCombo.shift | KeyCombo.option | KeyCombo.control
  // Carbon kEventKeyModifierFnMask. CopySymbolicHotKeys can include this
  // inherent arrow-key bit even when Settings displays only Control + Arrow.
  private static let carbonFunction: UInt64 = 131072
  private static func adjacentArrow(_ code: UInt16) -> Bool { code == 123 || code == 124 }

  private static func resolved(_ key: DesktopHotKey) -> DesktopResolvedShortcut? {
    let carbonMask: UInt64 = 256 | 512 | 2048 | 4096 | (adjacentArrow(key.code) ? carbonFunction : 0)
    guard key.carbonModifiers & ~carbonMask == 0 else { return nil }
    var flags: UInt64 = 0
    if key.carbonModifiers & 256 != 0 { flags |= KeyCombo.command }
    if key.carbonModifiers & 512 != 0 { flags |= KeyCombo.shift }
    if key.carbonModifiers & 2048 != 0 { flags |= KeyCombo.option }
    if key.carbonModifiers & 4096 != 0 { flags |= KeyCombo.control }
    if key.carbonModifiers & carbonFunction != 0 { flags |= KeyCombo.function }
    return .init(code: key.code, flags: flags)
  }

  private static func resolve(_ combo: KeyCombo, code: UInt16, enabled: [DesktopHotKey]) -> DesktopResolvedShortcut? {
    // Explicit Fn combinations remain unsupported. Only the public inventory
    // may supply the inherent Fn bit, and only for named left/right arrows.
    guard combo.flags & ~standardFlags == 0 else { return nil }
    let exact = DesktopResolvedShortcut(code: code, flags: combo.flags)
    let candidates = enabled.compactMap(resolved)
    if candidates.contains(exact) { return exact }
    guard !combo.printing, combo.keyCode == code, adjacentArrow(code) else { return nil }
    let inherentFunction = DesktopResolvedShortcut(code: code, flags: combo.flags | KeyCombo.function)
    return candidates.contains(inherentFunction) ? inherentFunction : nil
  }

  public static func validate(left: KeyCombo?, right: KeyCombo?, leftCode: UInt16?, rightCode: UInt16?,
                              enabled: [DesktopHotKey]?) -> DesktopShortcutPair? {
    guard let left, let right, let leftCode, let rightCode, let enabled,
      let resolvedLeft = resolve(left, code: leftCode, enabled: enabled),
      let resolvedRight = resolve(right, code: rightCode, enabled: enabled) else { return nil }
    let pair = DesktopShortcutPair(left: resolvedLeft, right: resolvedRight)
    guard pair.left != pair.right else { return nil }
    return pair
  }
  public static func isEnabled(_ shortcut: DesktopResolvedShortcut, in enabled: [DesktopHotKey]?) -> Bool {
    let mask = standardFlags | (adjacentArrow(shortcut.code) ? KeyCombo.function : 0)
    guard shortcut.flags & ~mask == 0, let enabled else { return false }
    // Final dispatch verification is exact, including the resolved Fn bit:
    // removing/changing an inventory entry must not silently retarget input.
    return enabled.contains { resolved($0) == shortcut }
  }
}

/// A notification alone, a changed window alone, and an unchanged pinned window
/// are insufficient. Repeated evidence must follow exactly one Space change.
///
/// The same looks also say when nothing moved: no Space change was reported and
/// every look, from the first to the one that ends the wait, showed the surface of
/// before. That is the last desktop on that side, or a shortcut that did nothing.
/// It is known, so it is not an unknown result. One look that shows nothing or
/// another surface, or one Space change, and the result stays unknown.
public struct DesktopSwitchSettlement<Surface: Equatable> {
  private let origin: Surface
  private let expected: Surface?
  private var settlement: DesktopSettlement<Surface>
  private var lastEpoch: Int?
  private var looks = 0
  private var stayed = true
  public init(origin: Surface, expected: Surface? = nil, at: TimeInterval) {
    self.origin = origin; self.expected = expected; settlement = .init(at: at)
  }
  /// Ask this only when the wait is over. Three looks at least, as an arrival needs.
  public var notMoved: Bool { stayed && looks >= 3 }
  public mutating func sample(_ surface: Surface?, spaceChanges: Int, epoch: Int, at: TimeInterval) -> DesktopSettlement<Surface>.Decision {
    looks += 1
    if spaceChanges != 0 || surface != origin { stayed = false }
    if lastEpoch != epoch { _ = settlement.sample(nil, at: at); lastEpoch = epoch }
    guard spaceChanges == 1, let surface, surface != origin, expected.map({ $0 == surface }) ?? true else {
      return settlement.sample(nil, at: at)
    }
    return settlement.sample(surface, at: at)
  }
}
