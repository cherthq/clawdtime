import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import TaskPanelCore

/// What makes one look cheap: the size of the picture, its JPEG, and a walk of the tree that
/// leaves out what does not show and stops in time. Plain data: no screen is read, no window opens.
final class HandsSpeedTests: XCTestCase {
  // MARK: the picture

  func testThePictureOfCommonScreensHasALongSideOf1280AndTheShapeOfTheScreen() throws {
    // A laptop at 1440 by 900 points, drawn with 2880 by 1800 pixels.
    let air = try XCTUnwrap(ScreenMap(width: 1440, height: 900, scale: 2))
    XCTAssertEqual([air.imageWidth, air.imageHeight], [1280, 800])
    // A laptop of 3024 by 1964 pixels, which is 1512 by 982 points.
    let pro = try XCTUnwrap(ScreenMap(width: 1512, height: 982, scale: 2))
    XCTAssertEqual([pro.imageWidth, pro.imageHeight], [1280, 831])
    // A display of 5120 by 2880 pixels, which is 2560 by 1440 points.
    let wide = try XCTUnwrap(ScreenMap(width: 2560, height: 1440, scale: 2))
    XCTAssertEqual([wide.imageWidth, wide.imageHeight], [1280, 720])
    // The same display at one pixel for each point gives the same picture.
    let plain = try XCTUnwrap(ScreenMap(width: 5120, height: 2880, scale: 1))
    XCTAssertEqual([plain.imageWidth, plain.imageHeight], [1280, 720])
    // A display that stands on its side: the long side is the height, and it has the same limit.
    let tall = try XCTUnwrap(ScreenMap(width: 1080, height: 1920, scale: 1))
    XCTAssertEqual([tall.imageWidth, tall.imageHeight], [720, 1280])
    // A small display is never made larger.
    let small = try XCTUnwrap(ScreenMap(width: 1024, height: 640, scale: 1))
    XCTAssertEqual([small.imageWidth, small.imageHeight], [1024, 640])
    for map in [air, pro, wide, plain, tall, small] {
      XCTAssertLessThanOrEqual(max(map.imageWidth, map.imageHeight), ScreenMap.maxImageSide)
      // The shape stays: a point maps to the same place, to a pixel.
      XCTAssertEqual(Double(map.imageWidth) / Double(map.imageHeight), map.width / map.height, accuracy: 0.002)
      let corner = map.point(pixel: CGPoint(x: map.imageWidth, y: map.imageHeight))
      XCTAssertEqual(Double(corner.x), map.width, accuracy: 0.000_001); XCTAssertEqual(Double(corner.y), map.height, accuracy: 0.000_001)
    }
    // The language model reads such a picture with no loss of its own: 32 by 32 pixel parts, at most 2,500 of them.
    for map in [air, pro, wide, tall] {
      let parts = Int((Double(map.imageWidth) / 32).rounded(.up)) * Int((Double(map.imageHeight) / 32).rounded(.up))
      XCTAssertLessThan(parts, 2500)
    }
  }

  /// A picture like a screen, drawn in memory: flat parts, lines of small marks like text, and a part with fine detail.
  func screen(width: Int, height: Int) throws -> CGImage {
    let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: 0.85, green: 0.87, blue: 0.9, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width / 5, height: height))
    context.setFillColor(CGColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1))
    var seed: UInt64 = 7
    func next() -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int(seed >> 33) }
    for row in stride(from: 40, to: height - 40, by: 34) {
      var x = width / 5 + 40
      while x < width - 60 {
        let word = 8 + next() % 60
        for letter in stride(from: x, to: x + word, by: 9) { context.fill(CGRect(x: letter, y: row, width: 6, height: 12 + next() % 6)) }
        x += word + 14
      }
    }
    for y in stride(from: 0, to: 200, by: 2) {
      for x in stride(from: 0, to: 300, by: 2) {
        context.setFillColor(CGColor(red: Double(next() % 255) / 255, green: Double(x % 255) / 255, blue: Double(y % 255) / 255, alpha: 1))
        context.fill(CGRect(x: width - 340 + x, y: 40 + y, width: 2, height: 2))
      }
    }
    return try XCTUnwrap(context.makeImage())
  }

  func testThePictureIsAJpegOfModerateQualityThatFitsTheContract() throws {
    let map = try XCTUnwrap(ScreenMap(width: 1512, height: 982, scale: 2))
    let image = try screen(width: map.imageWidth, height: map.imageHeight)
    let sent = try XCTUnwrap(ScreenPicture.encode(image))
    // A JPEG: it starts with the mark of one.
    XCTAssertEqual(Array(sent.prefix(3)), [0xFF, 0xD8, 0xFF])
    XCTAssertLessThanOrEqual(sent.count, ScreenPicture.budget)
    XCTAssertLessThanOrEqual(sent.base64EncodedString().utf8.count, Observation.maxImageCharacters)
    let read = try XCTUnwrap(CGImageSourceCreateWithData(sent as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
    XCTAssertEqual([read.width, read.height], [1280, 831])
    // The first quality that fits is sent, and it is moderate.
    XCTAssertEqual(ScreenPicture.qualities.first, 0.5)
    XCTAssertEqual(sent, ScreenPicture.jpeg(image, quality: 0.5))
    // It is smaller than the picture at the quality of before.
    let before = try XCTUnwrap(ScreenPicture.jpeg(image, quality: 0.6))
    XCTAssertLessThan(sent.count, before.count)
    // A lower quality comes only when the picture does not fit; with no quality that fits, nothing is sent.
    let lowest = try XCTUnwrap(ScreenPicture.jpeg(image, quality: 0.25))
    XCTAssertEqual(ScreenPicture.encode(image, budget: lowest.count), lowest)
    XCTAssertNil(ScreenPicture.encode(image, budget: 10))
  }

  // MARK: the walk of the tree

  /// A made-up tree. Each node has a role, a frame and children; asking it costs one tick of the clock.
  final class Tree {
    struct Node { var role: String; var title: String; var frame: CGRect?; var children: [Int]; var visibleChildren: [Int] = [] }
    var nodes: [Node] = []
    var asked: [Int] = []
    var now = 0.0
    var tick = 0.001
    func add(_ role: String, _ title: String = "", _ frame: CGRect?, _ children: [Int] = []) -> Int {
      nodes.append(Node(role: role, title: title, frame: frame, children: children)); return nodes.count - 1
    }
    func visit(_ id: Int) -> WalkVisit<Int> {
      asked.append(id); now += tick
      let node = nodes[id]
      let element = node.frame.map { RawElement(role: node.role, title: node.title, frame: $0) }
      let children = AccessibilityWalk.children(role: node.role, all: node.children, visibleChildren: node.visibleChildren, visibleRows: [], header: nil)
      return WalkVisit(element: element, frame: node.frame, children: children)
    }
    func walk(_ root: Int, _ limits: WalkLimits = .look, visible: CGRect) -> (elements: [RawElement], visited: Int, end: WalkEnd) {
      AccessibilityWalk.walk(from: root, limits: limits, visible: visible, clock: { self.now }, visit: visit)
    }
  }
  let window = CGRect(x: 0, y: 0, width: 800, height: 600)

  func testTheWalkReadsTheTreeInItsOrderAndSkipsWhatDoesNotShow() {
    let tree = Tree()
    // A list of 500 rows of 20 points: rows 0 to 29 show, the rest are below the window.
    let rows = (0..<500).map { row in
      tree.add("AXRow", "", CGRect(x: 0, y: Double(row) * 20, width: 400, height: 20),
               [tree.add("AXStaticText", "row \(row)", CGRect(x: 4, y: Double(row) * 20 + 2, width: 200, height: 16))])
    }
    let list = tree.add("AXList", "", CGRect(x: 0, y: 0, width: 400, height: 10_000), rows)
    let save = tree.add("AXButton", "Save", CGRect(x: 600, y: 20, width: 60, height: 24))
    // A group that gives no frame, with a button that shows: the walk goes in.
    let open = tree.add("AXButton", "Open", CGRect(x: 600, y: 60, width: 60, height: 24))
    let group = tree.add("AXGroup", "", nil, [open])
    // A group with no size, as some apps give: the walk goes in too.
    let close = tree.add("AXButton", "Close", CGRect(x: 600, y: 100, width: 60, height: 24))
    let flat = tree.add("AXGroup", "", CGRect(x: 600, y: 100, width: 0, height: 0), [close])
    // A part of the window to the right of what shows, with a button under it.
    let hidden = tree.add("AXButton", "Hidden", CGRect(x: 900, y: 10, width: 60, height: 24))
    let aside = tree.add("AXGroup", "", CGRect(x: 850, y: 0, width: 300, height: 600), [hidden])
    let root = tree.add("AXWindow", "Notes", window, [list, save, group, flat, aside])
    let walked = tree.walk(root, visible: window)
    XCTAssertEqual(walked.end, .whole)
    let titles = walked.elements.map { $0.title ?? "" }.filter { !$0.isEmpty }
    // Every row that shows, in the order of the tree, then the buttons; nothing that does not show.
    XCTAssertEqual(titles, ["Notes"] + (0..<30).map { "row \($0)" } + ["Save", "Open", "Close"])
    XCTAssertFalse(titles.contains("Hidden"))
    // A row below the window is asked once, for its frame, and nothing under it is asked.
    XCTAssertFalse(tree.asked.contains(tree.nodes[rows[100]].children[0]))
    XCTAssertFalse(tree.asked.contains(hidden))
    XCTAssertEqual(walked.visited, tree.asked.count)
    XCTAssertLessThan(walked.visited, 600)
  }

  func testAListThatNamesTheRowsThatShowIsWalkedOnlyThere() {
    let tree = Tree()
    let rows = (0..<5000).map { row in tree.add("AXRow", "row \(row)", CGRect(x: 0, y: Double(row - 2000) * 20, width: 400, height: 20)) }
    let list = tree.add("AXList", "", CGRect(x: 0, y: -40_000, width: 400, height: 100_000), rows)
    tree.nodes[list].visibleChildren = Array(rows[2000..<2030])
    let root = tree.add("AXWindow", "", window, [list])
    let walked = tree.walk(root, visible: window)
    XCTAssertEqual(walked.end, .whole)
    XCTAssertEqual(walked.elements.compactMap(\.title).filter { $0.hasPrefix("row") }, (2000..<2030).map { "row \($0)" })
    // The window, the list and its thirty rows: 4,968 rows are never asked.
    XCTAssertEqual(walked.visited, 32)
    // A table gives its header and the rows that show; another element gives what it names; else all.
    XCTAssertEqual(AccessibilityWalk.children(role: "AXTable", all: [1, 2, 3, 4], visibleChildren: [], visibleRows: [3], header: 9), [9, 3])
    XCTAssertEqual(AccessibilityWalk.children(role: "AXOutline", all: [1, 2, 3], visibleChildren: [], visibleRows: [2, 3], header: nil), [2, 3])
    XCTAssertEqual(AccessibilityWalk.children(role: "AXTable", all: [1, 2], visibleChildren: [], visibleRows: [], header: 9), [1, 2])
    XCTAssertEqual(AccessibilityWalk.children(role: "AXList", all: [1, 2, 3], visibleChildren: [2], visibleRows: [], header: nil), [2])
    XCTAssertEqual(AccessibilityWalk.children(role: "AXGroup", all: [1, 2], visibleChildren: [], visibleRows: [5], header: 9), [1, 2])
  }

  func testTheWalkStopsAtItsLimitsOfElementsDepthAndTime() {
    // A long chain: each level holds the next.
    let tree = Tree()
    var below: [Int] = []
    for level in (0..<120).reversed() {
      below = [tree.add("AXGroup", "level \(level)", CGRect(x: 0, y: 0, width: 100, height: 100), below)]
    }
    let deep = tree.walk(below[0], WalkLimits(visits: 1000, depth: 40, seconds: 10), visible: window)
    // The root is at depth 0, so 41 levels are read.
    XCTAssertEqual(deep.visited, 41)
    XCTAssertEqual(deep.elements.last?.title, "level 40")
    XCTAssertEqual(WalkLimits.look.depth, 60)

    // A wide window of 5,000 buttons that all show.
    let wide = Tree()
    let buttons = (0..<5000).map { wide.add("AXButton", "b\($0)", CGRect(x: Double($0 % 40) * 20, y: Double($0 / 40 % 30) * 20, width: 18, height: 18)) }
    let root = wide.add("AXWindow", "", window, buttons)
    let counted = wide.walk(root, WalkLimits(visits: 300, depth: 40, seconds: 10), visible: window)
    XCTAssertEqual(counted.end, .visits); XCTAssertEqual(counted.visited, 300)
    // The elements that came first in the tree are the ones kept.
    XCTAssertEqual(counted.elements.last?.title, "b298")

    // An app that answers slowly: one answer takes 1/64 of a second, and the walk has 0.6 seconds.
    let slow = Tree(); slow.tick = 1.0 / 64
    let many = (0..<5000).map { slow.add("AXButton", "s\($0)", CGRect(x: 10, y: 10, width: 18, height: 18)) }
    let timed = slow.walk(slow.add("AXWindow", "", window, many), visible: window)
    XCTAssertEqual(timed.end, .time)
    XCTAssertEqual(timed.visited, 39)
    XCTAssertLessThanOrEqual(slow.now, WalkLimits.look.seconds + slow.tick)
    // The limits of a look.
    XCTAssertEqual(WalkLimits.look, WalkLimits(visits: 2000, depth: 60, seconds: 0.6))
    XCTAssertEqual(WalkLimits(visits: 0, depth: -3, seconds: .nan), WalkLimits(visits: 1, depth: 0, seconds: 0))
  }

  func testAFrameIsOffTheScreenOnlyWhenItIsKnownAndNoPartOfItShows() {
    XCTAssertTrue(AccessibilityWalk.offScreen(CGRect(x: 900, y: 10, width: 50, height: 20), visible: window))
    XCTAssertTrue(AccessibilityWalk.offScreen(CGRect(x: 10, y: -40, width: 50, height: 20), visible: window))
    // Touching the edge is no part that shows; half a point in is not a point.
    XCTAssertTrue(AccessibilityWalk.offScreen(CGRect(x: 800, y: 10, width: 50, height: 20), visible: window))
    XCTAssertTrue(AccessibilityWalk.offScreen(CGRect(x: 799.5, y: 10, width: 50, height: 20), visible: window))
    XCTAssertFalse(AccessibilityWalk.offScreen(CGRect(x: 790, y: 590, width: 50, height: 20), visible: window))
    // A frame that says nothing never hides what is under it.
    for frame in [nil, CGRect(x: 900, y: 10, width: 0, height: 20), CGRect(x: 900, y: 10, width: 50, height: 0.5),
                  CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10)] {
      XCTAssertFalse(AccessibilityWalk.offScreen(frame, visible: window))
    }
    // A frame with a negative size is the same frame.
    XCTAssertFalse(AccessibilityWalk.offScreen(CGRect(x: 100, y: 100, width: -50, height: -20), visible: window))
  }

  // MARK: which elements are kept

  func testWithTooManyElementsTheKeyboardAndTheControlsThatCanBeUsedAreKeptFirstInTheOrderOfTheTree() {
    func raw(_ role: String, _ title: String, enabled: Bool = true, focused: Bool = false, subrole: String? = nil) -> RawElement {
      RawElement(role: role, subrole: subrole, title: title, frame: CGRect(x: 10, y: 10, width: 40, height: 20), enabled: enabled, focused: focused)
    }
    let texts = (0..<300).map { raw("AXStaticText", "text \($0)") }
    let off = (0..<150).map { raw("AXButton", "off \($0)", enabled: false) }
    let on = (0..<150).map { raw("AXButton", "on \($0)") }
    let field = raw("AXTextField", "Search", focused: true)
    let password = raw("AXTextField", "Password", subrole: "AXSecureTextField")
    let cleaned = ElementCleaner.clean(texts + off + on + [field, password])
    XCTAssertEqual(cleaned.count, ElementCleaner.maxElements)
    XCTAssertEqual(cleaned.map(\.id), Array(0..<400))
    let titles = cleaned.map(\.title)
    // The field with the keyboard and the password field, every control that can be used, the controls that are off, and no text.
    XCTAssertTrue(titles.contains("Search")); XCTAssertTrue(titles.contains("Password"))
    XCTAssertEqual(titles.filter { $0.hasPrefix("on ") }.count, 150)
    XCTAssertEqual(titles.filter { $0.hasPrefix("off ") }.count, 150)
    XCTAssertEqual(titles.filter { $0.hasPrefix("text ") }, (0..<98).map { "text \($0)" })
    // They stay in the order of the tree: the texts, then the controls that are off, then the rest.
    XCTAssertEqual(titles.first, "text 0"); XCTAssertEqual(titles.suffix(2), ["Search", "Password"])
    XCTAssertEqual(titles.firstIndex(of: "off 0")!, 98)
    // When the controls that can be used alone fill the list, those that are off give way.
    let crowded = ElementCleaner.clean(off + (0..<450).map { raw("AXLink", "link \($0)") })
    XCTAssertEqual(crowded.filter { !$0.enabled }.count, 0)
    XCTAssertEqual(crowded.count, 400)
    XCTAssertEqual([ElementCleaner.rank(cleaned.first { $0.focused }!), ElementCleaner.rank(cleaned.first { $0.title == "on 0" }!),
                    ElementCleaner.rank(cleaned.first { $0.title == "off 0" }!), ElementCleaner.rank(cleaned.first { $0.title == "text 0" }!)], [0, 1, 2, 3])
  }
}
