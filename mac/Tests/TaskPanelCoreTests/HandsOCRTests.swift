import CoreGraphics
import CoreText
import Foundation
import XCTest
@testable import TaskPanelCore

/// Vision OCR grounding tests using synthetic CoreGraphics/CoreText images.
/// No real screen is captured and no window is shown.
final class HandsOCRTests: XCTestCase {
  /// Renders high-contrast black text labels onto a white canvas at top-left coordinates.
  private func renderCanvas(width: Int, height: Int, labels: [(text: String, topLeft: CGPoint, fontSize: CGFloat)]) throws -> CGImage {
    let context = try XCTUnwrap(CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    for item in labels {
      let font = CTFontCreateWithName("Helvetica" as CFString, item.fontSize, nil)
      let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
      ]
      let attrString = NSAttributedString(string: item.text, attributes: attributes)
      let line = CTLineCreateWithAttributedString(attrString)
      let ascent = CTFontGetAscent(font)
      // Convert top-left origin to CGContext bottom-left baseline.
      let baselineY = CGFloat(height) - item.topLeft.y - ascent
      context.textPosition = CGPoint(x: item.topLeft.x, y: baselineY)
      CTLineDraw(line, context)
    }
    return try XCTUnwrap(context.makeImage())
  }

  private func makeElement(id: Int = 0, role: String = "AXButton", title: String = "Item", value: String? = nil,
                           frame: CGRect = CGRect(x: 10, y: 10, width: 80, height: 24),
                           enabled: Bool = true, focused: Bool = false, secure: Bool = false) -> ScreenElement {
    ScreenElement(id: id, role: role, title: title, value: value,
                  x: Double(frame.minX), y: Double(frame.minY), w: Double(frame.width), h: Double(frame.height),
                  enabled: enabled, focused: focused, secure: secure)
  }

  func testShouldRunRespectsSparseThresholdAndControlFilter() {
    XCTAssertEqual(ScreenOCR.sparseThreshold, 12)
    XCTAssertTrue(ElementCleaner.controls.contains("AXButton"))
    XCTAssertTrue(ElementCleaner.controls.contains("AXTextField"))
    // Empty or sparse AX trees trigger OCR.
    XCTAssertTrue(ScreenOCR.shouldRun(axElements: []))
    let elevenButtons = (0..<11).map { makeElement(id: $0, role: "AXButton", title: "B\($0)") }
    XCTAssertTrue(ScreenOCR.shouldRun(axElements: elevenButtons))
    // 12 useful controls suppress OCR.
    let twelveButtons = (0..<12).map { makeElement(id: $0, role: "AXButton", title: "B\($0)") }
    XCTAssertFalse(ScreenOCR.shouldRun(axElements: twelveButtons))
    // Non-control container elements (AXGroup/AXWindow) and disabled controls do not suppress OCR.
    let containers = (0..<20).map { makeElement(id: $0, role: "AXGroup", title: "Pane \($0)") }
    let disabled = (0..<15).map { makeElement(id: 20 + $0, role: "AXButton", title: "Off \($0)", enabled: false) }
    XCTAssertTrue(ScreenOCR.shouldRun(axElements: containers + disabled))
    // 12 non-empty static texts count as useful and suppress OCR.
    let twelveTexts = (0..<12).map { makeElement(id: $0, role: "AXStaticText", title: "Line \($0)") }
    XCTAssertFalse(ScreenOCR.shouldRun(axElements: twelveTexts))
  }

  func testNormalizedBoundingBoxMapsFromBottomLeftToTopLeftScreenPoints() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1440, height: 900, scale: 2))
    // Top-left quadrant in Vision normalized space: x=0.1..0.3, y=0.8..0.9 -> top-left y=(1-0.9)*900=90, h=90.
    let topLeft = ScreenOCR.screenRect(normalized: CGRect(x: 0.1, y: 0.8, width: 0.2, height: 0.1), map: map)
    XCTAssertEqual(topLeft.minX, 144, accuracy: 0.01)
    XCTAssertEqual(topLeft.minY, 90, accuracy: 0.01)
    XCTAssertEqual(topLeft.width, 288, accuracy: 0.01)
    XCTAssertEqual(topLeft.height, 90, accuracy: 0.01)
    // Bottom-right quadrant: x=0.7..0.9, y=0.05..0.15 -> top-left y=(1-0.15)*900=765, h=90.
    let bottomRight = ScreenOCR.screenRect(normalized: CGRect(x: 0.7, y: 0.05, width: 0.2, height: 0.1), map: map)
    XCTAssertEqual(bottomRight.minX, 1008, accuracy: 0.01)
    XCTAssertEqual(bottomRight.minY, 765, accuracy: 0.01)
    XCTAssertEqual(bottomRight.width, 288, accuracy: 0.01)
    XCTAssertEqual(bottomRight.height, 90, accuracy: 0.01)
  }

  func testRecognizesSyntheticTextWithCorrectTopLeftCoordinates() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1000, height: 600, scale: 1))
    let image = try renderCanvas(width: 1000, height: 600, labels: [
      ("Connect", CGPoint(x: 80, y: 60), 34),
      ("Settings", CGPoint(x: 620, y: 440), 34),
    ])
    let elements = ScreenOCR.recognize(image, map: map, existing: [], within: [])
    let connect = try XCTUnwrap(elements.first { ($0.title ?? "").localizedCaseInsensitiveContains("CONNECT") }, "OCR did not find CONNECT in \(elements)")
    let settings = try XCTUnwrap(elements.first { ($0.title ?? "").localizedCaseInsensitiveContains("SETTINGS") }, "OCR did not find SETTINGS in \(elements)")

    XCTAssertEqual(connect.role, "OCRText")
    XCTAssertTrue(connect.enabled)
    XCTAssertFalse(connect.focused)
    // CONNECT was drawn near top-left (x=80, y=60).
    XCTAssertEqual(connect.frame.minX, 80, accuracy: 30)
    XCTAssertEqual(connect.frame.minY, 60, accuracy: 30)
    // SETTINGS was drawn near bottom-right (x=620, y=440).
    XCTAssertEqual(settings.frame.minX, 620, accuracy: 30)
    XCTAssertEqual(settings.frame.minY, 440, accuracy: 30)
    XCTAssertLessThan(connect.frame.minY, settings.frame.minY)
  }

  func testExcludesOCRTextIntersectingSecureElementExpandedBy8pt() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1000, height: 600, scale: 1))
    let image = try renderCanvas(width: 1000, height: 600, labels: [
      ("SECRETKEY", CGPoint(x: 120, y: 120), 34),
      ("PUBLICBTN", CGPoint(x: 120, y: 360), 34),
    ])
    // First locate SECRETKEY to build a secure element just 5pt away (within the 8pt exclusion padding).
    let baseline = ScreenOCR.recognize(image, map: map, existing: [], within: [])
    let secretBox = try XCTUnwrap(baseline.first { ($0.title ?? "").localizedCaseInsensitiveContains("SECRET") }?.frame)
    // Place the secure field right next to the text (gap = 5pt < 8pt expansion).
    let nearbySecure = makeElement(
      id: 0,
      role: "AXSecureTextField",
      title: "Password",
      frame: CGRect(x: secretBox.minX, y: secretBox.maxY + 5, width: secretBox.width, height: 28),
      secure: true
    )
    let filtered = ScreenOCR.recognize(image, map: map, existing: [nearbySecure], within: [])
    XCTAssertFalse(filtered.contains { ($0.title ?? "").localizedCaseInsensitiveContains("SECRET") },
      "OCR leaked text within 8pt of secure element: \(filtered)")
    XCTAssertTrue(filtered.contains { ($0.title ?? "").localizedCaseInsensitiveContains("PUBLIC") },
      "Non-secure text far away should still be recognized: \(filtered)")
  }

  func testDeduplicatesAgainstExistingAXElementsByTitleValueAndIoU() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1000, height: 600, scale: 1))
    let image = try renderCanvas(width: 1000, height: 600, labels: [
      ("SUBMIT", CGPoint(x: 120, y: 100), 34),
      ("HELLO", CGPoint(x: 120, y: 260), 34),
      ("CANVAS", CGPoint(x: 120, y: 420), 34),
    ])
    let baseline = ScreenOCR.recognize(image, map: map, existing: [], within: [])
    let submitFrame = try XCTUnwrap(baseline.first { ($0.title ?? "").localizedCaseInsensitiveContains("SUBMIT") }?.frame)
    let helloFrame = try XCTUnwrap(baseline.first { ($0.title ?? "").localizedCaseInsensitiveContains("HELLO") }?.frame)

    // 1. Wide AXButton containing SUBMIT with matching title (low IoU, deduplicated by title inside box).
    let wideButton = makeElement(
      id: 0,
      role: "AXButton",
      title: "Submit",
      frame: submitFrame.insetBy(dx: -80, dy: -20)
    )
    // 2. AXTextField with different title ("Greeting") overlapping HELLO with high IoU (>= 0.5).
    let overlappingField = makeElement(
      id: 1,
      role: "AXTextField",
      title: "Greeting",
      value: "Other",
      frame: helloFrame
    )

    let deduped = ScreenOCR.recognize(image, map: map, existing: [wideButton, overlappingField], within: [])
    XCTAssertFalse(deduped.contains { ($0.title ?? "").localizedCaseInsensitiveContains("SUBMIT") },
      "SUBMIT should be deduplicated by matching AX button title")
    XCTAssertFalse(deduped.contains { ($0.title ?? "").localizedCaseInsensitiveContains("HELLO") },
      "HELLO should be deduplicated by IoU >= 0.5")
    XCTAssertTrue(deduped.contains { ($0.title ?? "").localizedCaseInsensitiveContains("CANVAS") },
      "CANVAS has no AX match and should remain")

    // Bounds filtering excludes OCR outside the requested window region.
    let upperOnly = ScreenOCR.recognize(image, map: map, existing: [], within: [CGRect(x: 0, y: 0, width: 1000, height: 220)])
    XCTAssertTrue(upperOnly.contains { ($0.title ?? "").localizedCaseInsensitiveContains("SUBMIT") })
    XCTAssertFalse(upperOnly.contains { ($0.title ?? "").localizedCaseInsensitiveContains("CANVAS") })
  }

  func testSeparateWindowRectsRejectOCRInGapBetweenWindows() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1000, height: 600, scale: 1))
    let image = try renderCanvas(width: 1000, height: 600, labels: [
      ("WINDOWONE", CGPoint(x: 120, y: 60), 34),
      ("BACKGROUNDDATA", CGPoint(x: 120, y: 260), 34),
      ("POPOVERMENU", CGPoint(x: 120, y: 460), 34),
    ])
    let windowRect = CGRect(x: 40, y: 20, width: 500, height: 140)
    let popoverRect = CGRect(x: 40, y: 420, width: 500, height: 140)

    // A single merged union would cover y=20..560 and leak BACKGROUNDDATA from the gap.
    let merged = ScreenOCR.recognize(image, map: map, existing: [], within: [windowRect.union(popoverRect)])
    XCTAssertTrue(merged.contains { ($0.title ?? "").localizedCaseInsensitiveContains("BACKGROUND") })

    // Passing the separate window rectangles keeps both windows and drops the gap text.
    let separate = ScreenOCR.recognize(image, map: map, existing: [], within: [windowRect, popoverRect])
    XCTAssertTrue(separate.contains { ($0.title ?? "").localizedCaseInsensitiveContains("WINDOWONE") },
      "Parent window text should be kept: \(separate)")
    XCTAssertTrue(separate.contains { ($0.title ?? "").localizedCaseInsensitiveContains("POPOVER") },
      "Popover window text should be kept: \(separate)")
    XCTAssertFalse(separate.contains { ($0.title ?? "").localizedCaseInsensitiveContains("BACKGROUND") },
      "Gap text between disjoint windows must not leak: \(separate)")

    // Non-empty off-screen rects never fall back to full-screen recognition.
    let offscreen = ScreenOCR.recognize(image, map: map, existing: [], within: [CGRect(x: 2000, y: 2000, width: 200, height: 200)])
    XCTAssertTrue(offscreen.isEmpty)
  }

  func testDropsPasswordMaskBulletStrings() throws {
    for masked in ["••••••", "• • • •", "●●●●", "◦◦◦◦", "******", "······", " • * · "] {
      XCTAssertTrue(ScreenOCR.isPasswordMask(masked), "Expected mask text to be detected: \(masked)")
    }
    for visible in ["", "   ", "• Submit", "* Required", "Password", "a•b"] {
      XCTAssertFalse(ScreenOCR.isPasswordMask(visible), "Expected non-mask text to stay: \(visible)")
    }

    let map = try XCTUnwrap(ScreenMap(width: 1000, height: 400, scale: 1))
    let image = try renderCanvas(width: 1000, height: 400, labels: [
      ("••••••", CGPoint(x: 120, y: 80), 38),
      ("******", CGPoint(x: 120, y: 180), 38),
      ("SIGNIN", CGPoint(x: 120, y: 280), 34),
    ])
    let recognized = ScreenOCR.recognize(image, map: map, existing: [], within: [])
    XCTAssertTrue(recognized.contains { ($0.title ?? "").localizedCaseInsensitiveContains("SIGNIN") },
      "Normal button text should remain: \(recognized)")
    XCTAssertFalse(recognized.contains { ScreenOCR.isPasswordMask($0.title ?? "") },
      "Password-mask bullet/asterisk strings must be dropped: \(recognized)")
  }
}
