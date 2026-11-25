import CoreGraphics
import Foundation
import Vision

/// On-device Vision OCR grounding for windows whose Accessibility tree is sparse
/// (such as canvas apps, WebGL views, remote screens or unaccessible custom UI).
/// Runs strictly in memory on the transient capture image, excludes password fields
/// and password-mask bullet strings, and constrains hits to valid window rectangles.
public enum ScreenOCR {
  /// Run OCR when the Accessibility tree yielded fewer than this many useful elements.
  public static let sparseThreshold = 12
  /// Maximum OCR text elements emitted from a single capture.
  public static let maxElements = 120
  /// Extra margin around every secure (password) element that OCR must never read.
  public static let securePadding: CGFloat = 8
  /// Intersection-over-Union threshold at which an OCR box counts as duplicating an AX element.
  public static let dedupeIoUThreshold: CGFloat = 0.5
  private static let maskCharacters: Set<Character> = ["•", "●", "◦", "*", "·"]

  /// True when `text` consists solely of password-mask bullet/dot characters and whitespace.
  public static func isPasswordMask(_ text: String) -> Bool {
    let trimmed = ElementCleaner.line(text)
    guard !trimmed.isEmpty else { return false }
    return trimmed.allSatisfy { maskCharacters.contains($0) || $0.isWhitespace }
  }

  private struct ExistingBox {
    let role: String
    let rect: CGRect
    let titleLower: String
    let valueLower: String?
  }

  /// True when the Accessibility tree returned too few useful controls or texts to ground the screen alone.
  public static func shouldRun(axElements: [ScreenElement]) -> Bool {
    let useful = axElements.filter { item in
      guard item.enabled else { return false }
      return ElementCleaner.controls.contains(item.role)
        || item.secure
        || (item.role == "AXStaticText" && !item.title.isEmpty)
    }.count
    return useful < sparseThreshold
  }

  /// Converts a Vision normalized bounding box (bottom-left origin, 0...1) into top-left screen points via `map`.
  public static func screenRect(normalized box: CGRect, map: ScreenMap) -> CGRect {
    CGRect(
      x: box.minX * CGFloat(map.width),
      y: (1 - box.maxY) * CGFloat(map.height),
      width: box.width * CGFloat(map.width),
      height: box.height * CGFloat(map.height)
    ).standardized
  }

  /// Intersection over Union of two screen rectangles.
  public static func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
    let inter = a.standardized.intersection(b.standardized)
    guard !inter.isNull, !inter.isEmpty else { return 0 }
    let interArea = inter.width * inter.height
    let unionArea = a.standardized.width * a.standardized.height + b.standardized.width * b.standardized.height - interArea
    guard unionArea > 0 else { return 0 }
    return interArea / unionArea
  }

  /// Recognizes visible text in `image` using macOS Vision (`.fast`), maps boxes into top-left screen points,
  /// excludes anything intersecting a `secure: true` element expanded by 8pt, drops password-mask bullet/dot
  /// strings (`•`, `●`, `◦`, `*`, `·`, whitespace), constrains detections to separate window rectangles in
  /// `rects` (when non-empty, keeping a box only when its center lies inside at least one rect), deduplicates
  /// against `existing` AX elements, and emits at most `maxElements` `RawElement` entries with role `"OCRText"`.
  public static func recognize(_ image: CGImage, map: ScreenMap, existing: [ScreenElement], within rects: [CGRect] = []) -> [RawElement] {
    let screenBounds = CGRect(x: 0, y: 0, width: map.width, height: map.height)
    let limitRects: [CGRect] = rects.compactMap { candidate in
      let clipped = candidate.standardized.intersection(screenBounds)
      return (!clipped.isNull && !clipped.isEmpty) ? clipped : nil
    }
    if !rects.isEmpty && limitRects.isEmpty { return [] }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return []
    }
    guard let observations = request.results, !observations.isEmpty else { return [] }

    let secureZones: [CGRect] = existing.filter(\.secure).map {
      CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h).standardized.insetBy(dx: -securePadding, dy: -securePadding)
    }

    let existingBoxes: [ExistingBox] = existing.map { item in
      ExistingBox(
        role: item.role,
        rect: CGRect(x: item.x, y: item.y, width: item.w, height: item.h).standardized,
        titleLower: ElementCleaner.line(item.title).lowercased(),
        valueLower: item.value.map { ElementCleaner.line($0).lowercased() }
      )
    }

    var candidates: [(text: String, rect: CGRect)] = []
    candidates.reserveCapacity(min(observations.count, maxElements))

    for observation in observations {
      guard let top = observation.topCandidates(1).first else { continue }
      let cleaned = ElementCleaner.line(top.string)
      guard !cleaned.isEmpty, !isPasswordMask(cleaned) else { continue }

      let rawRect = screenRect(normalized: observation.boundingBox, map: map)
      guard rawRect.minX.isFinite, rawRect.minY.isFinite, rawRect.width.isFinite, rawRect.height.isFinite,
            rawRect.width >= 1, rawRect.height >= 1 else { continue }

      // Never emit text intersecting any password field expanded by 8pt.
      if secureZones.contains(where: { $0.intersects(rawRect) }) { continue }

      let rect: CGRect
      if !rects.isEmpty {
        let center = CGPoint(x: rawRect.midX, y: rawRect.midY)
        var bestClip: CGRect?
        var bestArea: CGFloat = 0
        for limit in limitRects where limit.contains(center) {
          let clipped = rawRect.intersection(limit)
          guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { continue }
          let area = clipped.width * clipped.height
          if area > bestArea {
            bestArea = area
            bestClip = clipped
          }
        }
        guard let clipped = bestClip else { continue }
        rect = clipped
      } else {
        let clipped = rawRect.intersection(screenBounds)
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { continue }
        rect = clipped
      }

      if isDuplicate(textLower: cleaned.lowercased(), rect: rect, existing: existingBoxes) { continue }
      candidates.append((cleaned, rect))
    }

    // Deterministic reading order: top to bottom (8pt row bands), left to right.
    candidates.sort { a, b in
      let rowA = Int((a.rect.minY / 8).rounded(.down))
      let rowB = Int((b.rect.minY / 8).rounded(.down))
      if rowA != rowB { return rowA < rowB }
      return a.rect.minX < b.rect.minX
    }

    return candidates.prefix(maxElements).map { item in
      RawElement(role: "OCRText", title: item.text, frame: item.rect, enabled: true, focused: false)
    }
  }

  private static func isDuplicate(textLower: String, rect: CGRect, existing: [ExistingBox]) -> Bool {
    let center = CGPoint(x: rect.midX, y: rect.midY)
    for ax in existing {
      guard ax.rect.width >= 1, ax.rect.height >= 1 else { continue }
      if iou(rect, ax.rect) >= dedupeIoUThreshold { return true }
      // Inside a non-container AX element (e.g. a wider button, field or multi-line static text)
      // whose title or value already carries this text.
      guard ax.role != "AXWindow", ax.role != "AXGroup", ax.role != "AXScrollArea", ax.role != "AXWebArea" else { continue }
      guard ax.rect.insetBy(dx: -4, dy: -4).contains(center) else { continue }
      if !ax.titleLower.isEmpty && (ax.titleLower == textLower || (textLower.count >= 3 && ax.titleLower.contains(textLower))) {
        return true
      }
      if let valueLower = ax.valueLower, !valueLower.isEmpty,
         (valueLower == textLower || (textLower.count >= 3 && valueLower.contains(textLower))) {
        return true
      }
    }
    return false
  }
}
