import Foundation

/// A compositor fingerprint for one directional Space move, never an input target.
public struct DesktopDirectionalOverlay: Equatable, Sendable {
  public let id: Int
  public let frame: CGRect
  public init(id: Int, frame: CGRect) { self.id = id; self.frame = frame }
}
public struct DesktopDirectionalGroup: Equatable, Sendable {
  public let parentID: Int
  public let overlays: [DesktopDirectionalOverlay]
}
public struct DesktopDirectionalRow {
  public let id: Int?, pid: Int?, frame: CGRect?, title: String?
  public init(id: Int?, pid: Int?, frame: CGRect?, title: String?) { self.id = id; self.pid = pid; self.frame = frame; self.title = title }
}
public enum DesktopDirectionalEvidence {
  public static func inventory(_ rows: [DesktopDirectionalRow]) -> [DesktopWindowEvidence]? {
    guard rows.count <= 128 else { return nil }
    var result: [DesktopWindowEvidence] = []
    for row in rows {
      guard let id = row.id, id > 0, let pid = row.pid, pid > 0, let frame = row.frame, finite(frame) else { return nil }
      result.append(.init(id: id, pid: pid, title: row.title, frame: frame))
    }
    guard Set(result.map(\.id)).count == result.count else { return nil }
    return result
  }
  /// All ordinary Quartz rows must be supplied in their original order. A missing
  /// owner/id/frame is not a row that may be silently dropped by the caller.
  public static func group(pid: Int, title: String, parent: CGRect, display: CGRect,
                           fullScreenConfirmed: Bool, visible: [DesktopWindowEvidence]) -> DesktopDirectionalGroup? {
    guard pid > 0, fullScreenConfirmed, finite(parent), finite(display),
      DesktopSurfaceScope.fullScreenGeometry(window: parent, display: display),
      visible.count <= 128, Set(visible.map(\.id)).count == visible.count else { return nil }
    let matches = visible.indices.filter {
      visible[$0].pid == pid && DesktopWindowVisibility.sameTitle(listed: visible[$0].title, accessible: title) && sameFrame(visible[$0].frame, parent)
    }
    guard matches.count == 1, let index = matches.first, (1...8).contains(index) else { return nil }
    let prefix = Array(visible[...index])
    guard Set(prefix.map(\.id)).count == prefix.count,
      prefix.allSatisfy({ $0.id > 0 && $0.pid == pid && finite($0.frame) }) else { return nil }
    let overlays = prefix.dropLast()
    guard overlays.allSatisfy({ row in
      // Preserve offscreen portions verbatim. This is evidence of the whole
      // composition, not a claim that an overlay is harmless or the parent unobscured.
      let rect = row.frame
      return !rect.intersection(display).isEmpty && rect.width <= parent.width && rect.height <= parent.height &&
        rect.width * rect.height < parent.width * parent.height
    }) else { return nil }
    return .init(parentID: visible[index].id, overlays: overlays.map { .init(id: $0.id, frame: $0.frame) })
  }
  private static func finite(_ rect: CGRect) -> Bool {
    !rect.isNull && !rect.isEmpty && rect.minX.isFinite && rect.minY.isFinite && rect.maxX.isFinite && rect.maxY.isFinite &&
      rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0
  }
  private static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
  }
  /// Overlay changes alone cannot certify departure from a pinned/same parent.
  public static func changedParent(fromPID: Int, fromWindow: Int, toPID: Int, toWindow: Int) -> Bool {
    fromPID != toPID || fromWindow != toWindow
  }
  public static func captureMatches<Surface: Equatable>(expected: Surface, observed: Surface?, expectedEpoch: Int,
                                                       observedEpoch: Int, spaceChanges: Int, environmentChanges: Int,
                                                       activeDisplays: Int) -> Bool {
    observed == expected && expectedEpoch == observedEpoch && spaceChanges == 1 && environmentChanges == 0 && activeDisplays == 1
  }
}
