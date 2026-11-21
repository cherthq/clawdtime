import Foundation

/// Content-free facts that affect display identity or capture/input coordinates.
/// Work-area insets (Dock/menu-bar visibleFrame) are deliberately not included.
public struct DisplayConfigurationEntry: Equatable {
  public var id: UInt32
  public var active: Bool
  public var main: Bool
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
  public var modeID: UInt32
  public var modeFlags: UInt32
  public var modeWidth: Int
  public var modeHeight: Int
  public var pixelWidth: Int
  public var pixelHeight: Int
  public var refreshRate: Double
  public var rotation: Double
  public var mirrorOf: UInt32
  public var inMirrorSet: Bool
  public var backingScale: Double?
  public init(id: UInt32, active: Bool, main: Bool, x: Double, y: Double, width: Double, height: Double,
    modeID: UInt32, modeFlags: UInt32, modeWidth: Int, modeHeight: Int, pixelWidth: Int, pixelHeight: Int,
    refreshRate: Double, rotation: Double, mirrorOf: UInt32, inMirrorSet: Bool, backingScale: Double?) {
    self.id = id; self.active = active; self.main = main; self.x = x; self.y = y
    self.width = width; self.height = height; self.modeID = modeID; self.modeFlags = modeFlags
    self.modeWidth = modeWidth; self.modeHeight = modeHeight; self.pixelWidth = pixelWidth; self.pixelHeight = pixelHeight
    self.refreshRate = refreshRate; self.rotation = rotation; self.mirrorOf = mirrorOf
    self.inMirrorSet = inMirrorSet; self.backingScale = backingScale
  }
}
public struct DisplayConfigurationSignature: Equatable {
  public let activeIDs: [UInt32]
  public let displays: [DisplayConfigurationEntry]
  public init?(activeIDs: [UInt32], displays: [DisplayConfigurationEntry]) {
    let ids = Set(displays.map(\.id)), active = Set(activeIDs)
    guard !activeIDs.isEmpty, activeIDs.count <= 32, !displays.isEmpty, displays.count <= 32,
      active.count == activeIDs.count, ids.count == displays.count, !ids.contains(0),
      active.isSubset(of: ids), Set(displays.filter(\.active).map(\.id)) == active,
      displays.filter(\.main).count == 1, displays.first(where: \.main)?.active == true,
      displays.allSatisfy({ d in
        [d.x, d.y, d.width, d.height, d.refreshRate, d.rotation].allSatisfy(\.isFinite)
          && d.width > 0 && d.height > 0 && d.refreshRate >= 0 && (0...360).contains(d.rotation)
          && [d.modeWidth, d.modeHeight, d.pixelWidth, d.pixelHeight].allSatisfy { (1...65536).contains($0) }
          && (d.mirrorOf == 0 || (d.mirrorOf != d.id && ids.contains(d.mirrorOf) && d.inMirrorSet))
          && (d.backingScale.map { $0.isFinite && $0 > 0 && $0 <= 16 } ?? (!d.active || (d.inMirrorSet && !d.main)))
      }) else { return nil }
    self.activeIDs = activeIDs.sorted(); self.displays = displays.sorted { $0.id < $1.id }
  }
}
public enum DisplayConfigurationDecision: Equatable { case unchanged, changed, unavailable }
public final class DisplayConfigurationGuard {
  private var baseline: DisplayConfigurationSignature?
  public init() {}
  /// Two complete identical reads are required. Unknown observations retire the
  /// baseline, so a later known value cannot inherit prior capture authority.
  public func observe(first: DisplayConfigurationSignature?, second: DisplayConfigurationSignature?) -> DisplayConfigurationDecision {
    guard let first, let second, first == second else { baseline = nil; return .unavailable }
    let result: DisplayConfigurationDecision = baseline == first ? .unchanged : .changed
    baseline = first
    return result
  }
}
