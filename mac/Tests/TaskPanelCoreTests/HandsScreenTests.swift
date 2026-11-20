import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// What the hands see: the picture against the screen, and the elements of the
/// Accessibility tree after they are cleaned. Plain data, no screen is read.
final class HandsScreenTests: XCTestCase {
  func close(_ a: CGPoint, _ b: CGPoint, _ accuracy: Double = 0.000_001, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(Double(a.x), Double(b.x), accuracy: accuracy, file: file, line: line)
    XCTAssertEqual(Double(a.y), Double(b.y), accuracy: accuracy, file: file, line: line)
  }

  func testAtScaleOneAPixelOfASmallScreenIsAPoint() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1280, height: 800, scale: 1))
    XCTAssertEqual(map.imageWidth, 1280); XCTAssertEqual(map.imageHeight, 800)
    close(map.point(pixel: CGPoint(x: 640, y: 400)), CGPoint(x: 640, y: 400))
    close(map.pixel(point: CGPoint(x: 33, y: 777)), CGPoint(x: 33, y: 777))
    // A display with fewer pixels than the limit is never made larger.
    let small = try XCTUnwrap(ScreenMap(width: 1024, height: 768, scale: 1))
    XCTAssertEqual(small.imageWidth, 1024); XCTAssertEqual(small.imageHeight, 768)
  }

  func testAtScaleOneAWideScreenIsMadeSmallerAndMappedBack() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1920, height: 1080, scale: 1))
    XCTAssertEqual(map.imageWidth, 1280); XCTAssertEqual(map.imageHeight, 720)
    close(map.point(pixel: CGPoint(x: 0, y: 0)), .zero)
    close(map.point(pixel: CGPoint(x: 1280, y: 720)), CGPoint(x: 1920, y: 1080))
    close(map.point(pixel: CGPoint(x: 640, y: 360)), CGPoint(x: 960, y: 540))
    close(map.pixel(point: CGPoint(x: 960, y: 540)), CGPoint(x: 640, y: 360))
  }

  func testAtScaleTwoThePictureCountsPointsAndNotThePixelsOfTheDisplay() throws {
    // 1512 by 982 points, drawn with 3024 by 1964 pixels.
    let map = try XCTUnwrap(ScreenMap(width: 1512, height: 982, scale: 2))
    XCTAssertEqual(map.imageWidth, 1280); XCTAssertEqual(map.imageHeight, 831)
    close(map.point(pixel: CGPoint(x: 1280, y: 831)), CGPoint(x: 1512, y: 982))
    close(map.point(pixel: CGPoint(x: 640, y: 415.5)), CGPoint(x: 756, y: 491))
    // There and back gives the same point, for a point in the middle of an element.
    for point in [CGPoint(x: 0, y: 0), CGPoint(x: 100.5, y: 40.25), CGPoint(x: 756, y: 491), CGPoint(x: 1511, y: 981)] {
      close(map.point(pixel: map.pixel(point: point)), point)
    }
    // A dense display that is narrow in points keeps one pixel for one point at most.
    let narrow = try XCTUnwrap(ScreenMap(width: 600, height: 400, scale: 2))
    XCTAssertEqual(narrow.imageWidth, 1200); XCTAssertEqual(narrow.imageHeight, 800)
    close(narrow.point(pixel: CGPoint(x: 1200, y: 800)), CGPoint(x: 600, y: 400))
    XCTAssertLessThanOrEqual(try XCTUnwrap(ScreenMap(width: 5120, height: 1440, scale: 2)).imageWidth, ScreenMap.maxImageWidth)
  }

  func testOnlyAPointOnTheMainDisplayIsActedOn() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1512, height: 982, scale: 2))
    for point in [CGPoint(x: 0, y: 0), CGPoint(x: 1512, y: 982), CGPoint(x: 700, y: 10)] { XCTAssertTrue(map.contains(point)) }
    for point in [CGPoint(x: -1, y: 10), CGPoint(x: 10, y: -0.5), CGPoint(x: 1513, y: 10), CGPoint(x: 10, y: 2000),
                  CGPoint(x: CGFloat.nan, y: 1), CGPoint(x: 1, y: CGFloat.infinity)] { XCTAssertFalse(map.contains(point)) }
    close(map.clamp(CGPoint(x: 1512, y: 982)), CGPoint(x: 1511, y: 981))
    close(map.clamp(CGPoint(x: 5, y: 6)), CGPoint(x: 5, y: 6))
    // The height counted from the top, and from the bottom as windows count it.
    close(map.flip(CGPoint(x: 100, y: 0)), CGPoint(x: 100, y: 982))
    close(map.flip(map.flip(CGPoint(x: 100, y: 40))), CGPoint(x: 100, y: 40))
    XCTAssertEqual(map.flip(CGRect(x: 10, y: 20, width: 100, height: 30)), CGRect(x: 10, y: 932, width: 100, height: 30))
    for (width, height, scale) in [(0.0, 800.0, 1.0), (1280, 0, 1), (1280, 800, 0), (.nan, 800, 1), (1280, .infinity, 2)] {
      XCTAssertNil(ScreenMap(width: width, height: height, scale: scale))
    }
  }

  func raw(_ role: String, subrole: String? = nil, label: String? = nil, title: String? = nil, description: String? = nil,
           placeholder: String? = nil, value: String? = nil, frame: CGRect = CGRect(x: 10, y: 20, width: 100, height: 30),
           enabled: Bool = true, focused: Bool = false) -> RawElement {
    RawElement(role: role, subrole: subrole, label: label, title: title, description: description, placeholder: placeholder,
               value: value, frame: frame, enabled: enabled, focused: focused)
  }

  func testEveryTextIsOneCleanBoundedLine() {
    XCTAssertEqual(ElementCleaner.line("  Save\n\tas…  \r\n now "), "Save as… now")
    // Marks that change the direction of text, or hide in it, are taken out.
    XCTAssertEqual(ElementCleaner.line("pay\u{202E}eeyolpme\u{200B} now\u{0}\u{7}"), "pay eeyolpme now")
    XCTAssertEqual(ElementCleaner.line("a\u{2028}b\u{2029}c\u{A0}d"), "a b c d")
    XCTAssertEqual(ElementCleaner.line(""), ""); XCTAssertEqual(ElementCleaner.line(" \n "), "")
    XCTAssertEqual(ElementCleaner.line(String(repeating: "a", count: 200)).utf16.count, 200)
    let long = ElementCleaner.line(String(repeating: "a", count: 5000))
    XCTAssertEqual(long.utf16.count, 200); XCTAssertTrue(long.hasSuffix("…"))
    // The limit counts UTF-16 units, as the service does, and never cuts a character.
    let waves = ElementCleaner.line(String(repeating: "👋", count: 150))
    XCTAssertLessThanOrEqual(waves.utf16.count, 200)
    XCTAssertEqual(waves, String(repeating: "👋", count: 99) + "…")
    XCTAssertEqual(ElementCleaner.line("AXButton and more", limit: 8), "AXButto…")
  }

  func testAnElementTakesItsNameFromTheLabelThenTheTitleThenTheDescription() throws {
    let all = try XCTUnwrap(ElementCleaner.element(raw("AXButton", label: "Label", title: "Title", description: "Description")))
    XCTAssertEqual(all.title, "Label")
    XCTAssertEqual(ElementCleaner.element(raw("AXButton", label: " \n", title: "Title", description: "Description"))?.title, "Title")
    XCTAssertEqual(ElementCleaner.element(raw("AXButton", description: "Close\nwindow"))?.title, "Close window")
    XCTAssertEqual(ElementCleaner.element(raw("AXTextField", placeholder: "Search", value: ""))?.title, "Search")
    // A text on the screen has no name: what it says is its name. It holds no value.
    let text = try XCTUnwrap(ElementCleaner.element(raw("AXStaticText", value: "Total: 12")))
    XCTAssertEqual(text.title, "Total: 12"); XCTAssertNil(text.value)
    // The frame, the role and the three states pass through.
    let field = try XCTUnwrap(ElementCleaner.element(raw("AXTextField", title: "Name", value: "Ada\nLovelace",
      frame: CGRect(x: 10.04, y: 20.26, width: 100, height: 30), enabled: false, focused: true), id: 7))
    XCTAssertEqual(field, ScreenElement(id: 7, role: "AXTextField", title: "Name", value: "Ada Lovelace", x: 10, y: 20.3, w: 100, h: 30,
                                        enabled: false, focused: true, secure: false))
    XCTAssertEqual(ElementCleaner.element(raw("AXTextField", title: "Name", value: ""))?.value, "")
    XCTAssertEqual(ElementCleaner.element(raw("AXCheckBox", title: "Remember me", value: "1"))?.value, "1")
    // A button's value is not what it holds.
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", value: "1"))?.value)
    XCTAssertEqual(ElementCleaner.element(raw("AXTextArea", title: "Body", value: String(repeating: "word ", count: 2000)))?.value?.utf16.count, 200)
    XCTAssertEqual(ElementCleaner.element(raw(String(repeating: "R", count: 90), title: "x"))?.role.utf16.count, 60)
  }

  func testASecureFieldNeverGivesWhatItHolds() throws {
    for field in [raw("AXTextField", subrole: "AXSecureTextField", title: "Password", value: "hunter2"),
                  raw("AXSecureTextField", title: "Password", value: "hunter2"),
                  raw("AXTextField", subrole: "AXSecureTextField", value: "hunter2"),
                  raw("AXStaticText", subrole: "AXSecureTextField", value: "hunter2")] {
      let cleaned = try XCTUnwrap(ElementCleaner.element(field))
      XCTAssertTrue(cleaned.secure)
      XCTAssertNil(cleaned.value)
      XCTAssertFalse(cleaned.title.contains("hunter2"))
      XCTAssertFalse(String(decoding: try JSONEncoder().encode(cleaned), as: UTF8.self).contains("hunter2"))
      XCTAssertNoThrow(try cleaned.validate())
    }
    XCTAssertTrue(ElementCleaner.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
    XCTAssertFalse(ElementCleaner.isSecure(role: "AXTextField", subrole: "AXSearchField"))
    XCTAssertFalse(ElementCleaner.isSecure(role: "AXTextField", subrole: nil))
  }

  func testAnElementThatSaysNothingIsLeftOut() {
    // A part of the layout with no name says nothing. A control with no name is still a place to act.
    XCTAssertNil(ElementCleaner.element(raw("AXGroup")))
    XCTAssertNil(ElementCleaner.element(raw("AXStaticText", value: " ")))
    XCTAssertNotNil(ElementCleaner.element(raw("AXGroup", title: "Sidebar")))
    XCTAssertNotNil(ElementCleaner.element(raw("AXButton")))
    // No size, or a size that is not a number.
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 1, y: 1, width: 0, height: 20))))
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 1, y: 1, width: 20, height: 0.5))))
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: CGFloat.nan, y: 1, width: 20, height: 20))))
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 1, y: 1, width: CGFloat.infinity, height: 20))))
    // Outside the window it is left out. Half outside, only the part that shows is given.
    let window = CGRect(x: 0, y: 0, width: 800, height: 600)
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 900, y: 10, width: 50, height: 20)), within: window))
    XCTAssertNil(ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 10, y: 5000, width: 50, height: 20)), within: window))
    let half = ElementCleaner.element(raw("AXButton", title: "Save", frame: CGRect(x: 760, y: 580, width: 100, height: 100)), within: window)
    XCTAssertEqual([half?.x, half?.y, half?.w, half?.h], [760, 580, 40, 20])
  }

  func testAtMostFourHundredElementsAreGivenAndControlsStayFirst() throws {
    // Six hundred texts, then fifty buttons at the end of the tree.
    let texts = (0..<600).map { raw("AXStaticText", value: "line \($0)") }
    let buttons = (0..<50).map { raw("AXButton", title: "button \($0)") }
    let cleaned = ElementCleaner.clean(texts + buttons + [raw("AXGroup"), raw("AXTextField", subrole: "AXSecureTextField", value: "hunter2")])
    XCTAssertEqual(cleaned.count, 400)
    XCTAssertEqual(cleaned.map(\.id), Array(0..<400))
    // Every control is there, after the texts that fit, in the order of the tree.
    XCTAssertEqual(cleaned.filter { $0.role == "AXButton" }.map(\.title), (0..<50).map { "button \($0)" })
    XCTAssertEqual(cleaned.filter(\.secure).count, 1)
    XCTAssertEqual(cleaned.filter { $0.role == "AXStaticText" }.map(\.title), (0..<349).map { "line \($0)" })
    XCTAssertEqual(cleaned.last?.secure, true)
    XCTAssertNoThrow(try HandResult.done(1, observation: Observation(at: 1, screen: .init(width: 1512, height: 982, scale: 2),
      cursor: .init(x: 0, y: 0), app: .init(name: "Notes", bundleId: "com.apple.Notes", window: ""), elements: cleaned)).validate())

    // Under the limit nothing is left out and the numbers still count from zero.
    let few = ElementCleaner.clean([raw("AXGroup"), raw("AXButton", title: "One"), raw("AXGroup"), raw("AXLink", title: "Two")])
    XCTAssertEqual(few.map(\.title), ["One", "Two"]); XCTAssertEqual(few.map(\.id), [0, 1])
    XCTAssertEqual(ElementCleaner.clean(Array(repeating: raw("AXButton", title: "b"), count: 2000)).count, 400)
    XCTAssertEqual(ElementCleaner.clean([]).count, 0)
  }
}
