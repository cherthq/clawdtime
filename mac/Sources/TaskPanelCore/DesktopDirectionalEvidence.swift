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
  public let usesToolbarCoverage: Bool
}
public struct DesktopDirectionalRow {
  public let id: Int?, pid: Int?, frame: CGRect?, title: String?
  public let alpha: Double?
  public init(id: Int?, pid: Int?, frame: CGRect?, title: String?, alpha: Double?) {
    self.id = id; self.pid = pid; self.frame = frame; self.title = title; self.alpha = alpha
  }
}
public enum DesktopDirectionalEvidence {
  public static func inventory(_ rows: [DesktopDirectionalRow]) -> [DesktopWindowEvidence]? {
    guard rows.count <= 128 else { return nil }
    var result: [DesktopWindowEvidence] = []
    for row in rows {
      guard let id = row.id, id > 0, let pid = row.pid, pid > 0, let frame = row.frame, finite(frame),
        let alpha = row.alpha, alpha.isFinite, alpha > 0, alpha <= 1 else { return nil }
      result.append(.init(id: id, pid: pid, title: row.title, frame: frame))
    }
    guard Set(result.map(\.id)).count == result.count else { return nil }
    return result
  }
  /// All ordinary Quartz rows must be supplied in their original order. A missing
  /// owner/id/frame is not a row that may be silently dropped by the caller.
  public static func group(pid: Int, title: String, parent: CGRect, display: CGRect,
                           fullScreenConfirmed: Bool, visible: [DesktopWindowEvidence],
                           diagnostic: ((String) -> Void)? = nil, count: ((String, Int) -> Void)? = nil) -> DesktopDirectionalGroup? {
    guard pid > 0, finite(parent), finite(display) else { diagnostic?("directional_invalid_parent"); return nil }
    guard visible.count <= 128 else { diagnostic?("directional_inventory_limit"); return nil }
    let matches = visible.indices.filter {
      visible[$0].pid == pid && DesktopWindowVisibility.sameTitle(listed: visible[$0].title, accessible: title) && sameFrame(visible[$0].frame, parent)
    }
    count?("directionalParentMatches", matches.count)
    if matches.count == 1, let index = matches.first { count?("directionalLeadingRows", index) }
    guard fullScreenConfirmed else { diagnostic?("directional_parent_not_fullscreen"); return nil }
    guard Set(visible.map(\.id)).count == visible.count else { diagnostic?("directional_duplicate_identity"); return nil }
    guard matches.count == 1, let index = matches.first else {
      diagnostic?(matches.isEmpty ? "directional_parent_match_missing" : "directional_parent_match_ambiguous"); return nil
    }
    guard (1...8).contains(index) else { diagnostic?("directional_overlay_count"); return nil }
    let prefix = Array(visible[...index])
    guard prefix.allSatisfy({ $0.id > 0 && finite($0.frame) }) else { diagnostic?("directional_invalid_overlay"); return nil }
    guard prefix.allSatisfy({ $0.pid == pid }) else { diagnostic?("directional_foreign_owner"); return nil }
    let overlays = prefix.dropLast()
    guard overlays.allSatisfy({ row in
      // Preserve offscreen portions verbatim. This is evidence of the whole
      // composition, not a claim that an overlay is harmless or the parent unobscured.
      let rect = row.frame
      return !rect.intersection(display).isEmpty && rect.width <= parent.width && rect.height <= parent.height &&
        rect.width * rect.height < parent.width * parent.height
    }) else { diagnostic?("directional_overlay_geometry"); return nil }
    let strictGeometry = DesktopSurfaceScope.fullScreenGeometry(window: parent, display: display)
    guard strictGeometry || toolbarCoversParentTop(parent: parent, display: display, overlays: Array(overlays))
      else { diagnostic?("directional_parent_geometry"); return nil }
    return .init(parentID: visible[index].id, overlays: overlays.map { .init(id: $0.id, frame: $0.frame) }, usesToolbarCoverage: !strictGeometry)
  }
  /// A fullscreen app can expose its content and toolbar as separate compositor
  /// rows. This proves only the directional composition, never an input surface.
  private static func toolbarCoversParentTop(parent: CGRect, display: CGRect, overlays: [DesktopWindowEvidence]) -> Bool {
    guard display.contains(parent), abs(parent.minX - display.minX) <= 1, abs(parent.maxX - display.maxX) <= 1,
      abs(parent.maxY - display.maxY) <= 1, parent.height >= display.height * 0.85 else { return false }
    let strips = overlays.map(\.frame).filter { frame in
      finite(frame) && display.contains(frame) && abs(frame.minX - parent.minX) <= 1 && abs(frame.maxX - parent.maxX) <= 1 &&
        frame.height <= 80 && frame.height <= parent.height * 0.12 && frame.minY < parent.minY
    }.sorted { $0.minY < $1.minY }
    // The existing menu/notch inset stays at 80. Any further gap must have real
    // contiguous coverage, without clipping, inferring a row, or bridging holes.
    var coveredTo = display.minY + 80
    for strip in strips {
      if strip.minY > coveredTo { break }
      coveredTo = max(coveredTo, strip.maxY)
      if coveredTo >= parent.minY { return true }
    }
    return false
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
