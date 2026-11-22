import CoreGraphics
import Foundation

/// Transient video hints. These coordinates never enter the input executor.
/// The payload intentionally cannot carry labels, field values or screenshots.
public struct CallPresentationEvent: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case target, typing, context, transition, reset }
  public struct Rect: Codable, Equatable, Sendable {
    public var x: Double, y: Double, w: Double, h: Double
    public init(_ rect: CGRect) { x = rect.minX; y = rect.minY; w = rect.width; h = rect.height }
    public var cgRect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
    public var valid: Bool { [x, y, w, h].allSatisfy(\.isFinite) && w > 0 && h > 0 }
  }
  public struct Surface: Codable, Equatable, Sendable {
    public var displayId: String, width: Double, height: Double, scale: Double
    public var appId: String, windowId: String, window: Rect
    public init(displayId: String, width: Double, height: Double, scale: Double, appId: String, windowId: String, window: Rect) {
      self.displayId = displayId; self.width = width; self.height = height; self.scale = scale
      self.appId = appId; self.windowId = windowId; self.window = window
    }
    public var bounds: CGRect { CGRect(x: 0, y: 0, width: width, height: height) }
    public var valid: Bool {
      [width, height, scale].allSatisfy { $0.isFinite && $0 > 0 } && width <= 32768 && height <= 32768 && scale <= 8 &&
        Self.identity(displayId) && Self.identity(appId) && Self.identity(windowId) && window.valid && bounds.contains(window.cgRect)
    }
    private static func identity(_ value: String) -> Bool {
      !value.isEmpty && value.utf8.count <= 200 && value.range(of: "^[A-Za-z0-9_.:-]+$", options: .regularExpression) != nil
    }
  }
  public var version = 1
  public var producerId: String
  public var sequence: Int
  public var commandSeq: Int
  public var at: Double
  public var expiresAt: Double
  public var kind: Kind
  public var reducedMotion: Bool
  public var surface: Surface?
  public var target: Rect?

  public init(producerId: String, sequence: Int, commandSeq: Int, at: Double, kind: Kind, reducedMotion: Bool,
              surface: Surface? = nil, target: Rect? = nil, lifetime: Double = 1400) {
    self.producerId = producerId; self.sequence = sequence; self.commandSeq = commandSeq
    self.at = at; expiresAt = at + lifetime; self.kind = kind; self.reducedMotion = reducedMotion
    self.surface = surface; self.target = target
  }
  public func validate() throws {
    guard version == 1, UUID(uuidString: producerId) != nil, sequence > 0, commandSeq > 0,
      at.isFinite, at > 0, expiresAt.isFinite, expiresAt > at, expiresAt - at <= 2000 else { throw PanelFailure.response }
    if let surface, !surface.valid { throw PanelFailure.response }
    if kind != .reset && kind != .transition && surface == nil { throw PanelFailure.response }
    if kind == .target || kind == .typing {
      guard let target, target.valid, let surface, surface.bounds.contains(target.cgRect) else { throw PanelFailure.response }
    } else if target != nil { throw PanelFailure.response }
    if (kind == .reset || kind == .transition) && surface != nil { throw PanelFailure.response }
  }
}

/// Identity and geometry changes retire the previous target before a new one can
/// be presented. The following observation establishes the new surface. Pure
/// policy: there is no screen access, input, transport or persisted state here.
public struct CallPresentationSurfaceGate: Sendable {
  public private(set) var surface: CallPresentationEvent.Surface?
  public init() {}
  public mutating func observe(_ next: CallPresentationEvent.Surface?) -> Bool {
    guard let next, next.valid else { surface = nil; return false }
    let changed = surface.map { $0 != next } ?? false
    surface = next
    return !changed
  }
  public mutating func reset() { surface = nil }
}

/// A target first seen on a changed surface waits for one matching observation.
/// It is neither replayed input nor a reusable coordinate: a different command,
/// geometry, or a 900 ms delay discards it. Typing carries intent only; callers
/// must read fresh field bounds after every geometry change.
public struct CallPresentationIntent: Sendable {
  private struct Deferred: Sendable {
    var target: CallPresentationEvent.Rect
    var surface: CallPresentationEvent.Surface
    var commandSeq: Int
    var at: Double
  }
  public private(set) var typing = false
  private var deferred: Deferred?
  public init() {}
  public mutating func beginCommand() { typing = false; deferred = nil }
  public mutating func beginTyping() { typing = true; deferred = nil }
  public mutating func endTyping() { typing = false }
  public mutating func geometryChanged() { deferred = nil }
  public mutating func retire() { typing = false; deferred = nil }
  public mutating func deferTarget(_ target: CallPresentationEvent.Rect, on surface: CallPresentationEvent.Surface, commandSeq: Int, at: Double) {
    deferred = target.valid && surface.valid && surface.bounds.contains(target.cgRect)
      ? Deferred(target: target, surface: surface, commandSeq: commandSeq, at: at) : nil
  }
  public mutating func takeTarget(on surface: CallPresentationEvent.Surface, commandSeq: Int, now: Double) -> CallPresentationEvent.Rect? {
    defer { deferred = nil }
    guard let deferred, deferred.surface == surface, deferred.commandSeq == commandSeq,
      now >= deferred.at, now - deferred.at <= 900 else { return nil }
    return deferred.target
  }
}

/// Widen before shortcuts that can change the visible app/window/desktop. This
/// is only video policy: it does not assume a Mission Control shortcut is enabled.
public enum CallPresentationKeyPolicy {
  public static func mayChangeSurface(_ key: KeyCombo) -> Bool {
    if key.flags & KeyCombo.command != 0 {
      if key.keyCode == KeyCombo.tabKey || ["`", "h", "m", "q", "w"].contains(key.character ?? "") { return true }
      if key.flags & KeyCombo.control != 0 && key.character == "f" { return true }
    }
    return key.flags & KeyCombo.control != 0 && [123, 124, 125, 126].contains(key.keyCode)
  }
}
