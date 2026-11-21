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

/// A generic input lease may describe a full-screen or partially visible main-
/// display window on a multi-display setup. Desktop switching is narrower.
public enum DesktopSurfaceScope {
  public static func permits(window: CGRect, display: CGRect, ordinary: Bool, fullScreen: Bool,
                             activeDisplays: Int, transition: Bool) -> Bool {
    guard !window.isNull, !window.isEmpty, !window.intersection(display).isEmpty else { return false }
    return !transition || (activeDisplays == 1 && ordinary && !fullScreen && display.contains(window))
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
public struct DesktopSwitchSettlement<Surface: Equatable> {
  private let origin: Surface
  private let expected: Surface?
  private var settlement: DesktopSettlement<Surface>
  private var lastEpoch: Int?
  public init(origin: Surface, expected: Surface? = nil, at: TimeInterval) {
    self.origin = origin; self.expected = expected; settlement = .init(at: at)
  }
  public mutating func sample(_ surface: Surface?, spaceChanges: Int, epoch: Int, at: TimeInterval) -> DesktopSettlement<Surface>.Decision {
    if lastEpoch != epoch { _ = settlement.sample(nil, at: at); lastEpoch = epoch }
    guard spaceChanges == 1, let surface, surface != origin, expected.map({ $0 == surface }) ?? true else {
      return settlement.sample(nil, at: at)
    }
    return settlement.sample(surface, at: at)
  }
}
