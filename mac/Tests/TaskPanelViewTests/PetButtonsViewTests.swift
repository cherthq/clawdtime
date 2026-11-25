import AppKit
import XCTest
@testable import ClawdTimeTaskPanel
import TaskPanelCore

/// Choices kept in memory only: the tests write nothing to the disk.
final class MemoryDefaults: UserDefaults {
  private var values: [String: Any] = [:]
  init() { super.init(suiteName: nil)! }
  override func object(forKey key: String) -> Any? { values[key] }
  override func set(_ value: Any?, forKey key: String) { values[key] = value }
  override func set(_ value: Double, forKey key: String) { values[key] = value }
  override func set(_ value: Bool, forKey key: String) { values[key] = value }
  override func removeObject(forKey key: String) { values[key] = nil }
  override func string(forKey key: String) -> String? { values[key] as? String }
  override func double(forKey key: String) -> Double { values[key] as? Double ?? 0 }
  override func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
  var keys: [String] { values.keys.sorted() }
}

/// The close button and the side button on the mascot. The controller is built off screen:
/// no window is shown and nothing is clicked on the screen. Its choices stay in memory.
@MainActor
final class PetButtonsViewTests: XCTestCase {
  private var defaults = MemoryDefaults()
  override func setUp() {
    super.setUp()
    defaults = MemoryDefaults()
  }

  private func assertColumn(_ pet: PetController, side: PetSide, file: StaticString = #filePath, line: UInt = #line) {
    let size = pet.window.frame.size
    let rest = PetLayout.buttons(size: size, side: side)
    XCTAssertEqual(pet.closeButton.frame, rest.close, file: file, line: line)
    XCTAssertEqual(pet.sideButton.frame, rest.side, file: file, line: line)
    XCTAssertEqual(pet.closeButton.frame.minX, pet.sideButton.frame.minX, "one column", file: file, line: line)
    XCTAssertGreaterThan(pet.closeButton.frame.minY, pet.sideButton.frame.maxY, "close on top", file: file, line: line)
    XCTAssertEqual(pet.closeButton.frame.midX > size.width / 2, side == .right, file: file, line: line)
    // A press on either button reaches the mascot's window: the click-through rule lets it in.
    let window = CGRect(origin: CGPoint(x: 600, y: 300), size: size)
    for button in [pet.closeButton, pet.sideButton] {
      let middle = CGPoint(x: window.minX + button.frame.midX, y: window.minY + button.frame.midY)
      XCTAssertTrue(PetLayout.takesPress(pointer: middle, window: window, buttons: side, shown: 1), file: file, line: line)
    }
  }

  func testAFreeMascotShowsCloseOnTopAndTheSideButtonUnderItOnTheRight() {
    let pet = PetController(defaults: defaults)
    var hidden = 0
    pet.onHide = { hidden += 1 }
    pet.layoutButtons(shown: 1)
    assertColumn(pet, side: .right)
    XCTAssertFalse(pet.closeButton.isHidden); XCTAssertFalse(pet.sideButton.isHidden)
    XCTAssertEqual(pet.closeButton.accessibilityLabel(), "Close ClawdTime. It stays in the menu bar.")
    XCTAssertEqual(pet.closeButton.accessibilityRole(), .button)
    XCTAssertEqual(pet.closeButton.symbolName, "xmark")
    XCTAssertEqual(pet.sideButton.accessibilityRole(), .button)
    XCTAssertTrue(pet.sideButton.accessibilityLabel()?.hasPrefix("Tuck against the") == true)
    XCTAssertEqual(pet.sideButton.symbolName, "arrow.right.to.line")
    XCTAssertTrue(pet.closeButton.accessibilityPerformPress())
    XCTAssertEqual(hidden, 1)
    // The side button tucks the mascot against an edge, and brings it back out.
    XCTAssertTrue(pet.sideButton.accessibilityPerformPress())
    XCTAssertTrue(pet.isDocked)
    XCTAssertTrue(defaults.keys.contains("pet.dock"), "the choice went to the store in memory")
    XCTAssertEqual(pet.sideButton.accessibilityLabel(), "Bring ClawdTime back from the edge")
    XCTAssertTrue(pet.sideButton.accessibilityPerformPress())
    XCTAssertFalse(pet.isDocked)
    XCTAssertTrue(pet.sideButton.accessibilityLabel()?.hasPrefix("Tuck against the") == true)
  }

  func testDockedLeftTheColumnStandsOnTheRightAwayFromTheEdge() {
    let pet = PetController(defaults: defaults)
    pet.dock(.left)
    pet.layoutButtons(shown: 1)
    assertColumn(pet, side: .right)
    XCTAssertEqual(pet.sideButton.symbolName, "arrow.right")
    XCTAssertEqual(pet.sideButton.accessibilityLabel(), "Bring ClawdTime back from the edge")
    XCTAssertEqual(pet.closeButton.accessibilityLabel(), "Close ClawdTime. It stays in the menu bar.")
  }

  func testDockedRightTheColumnStandsOnTheLeftAwayFromTheEdge() {
    let pet = PetController(defaults: defaults)
    pet.dock(.right)
    pet.layoutButtons(shown: 1)
    assertColumn(pet, side: .left)
    XCTAssertEqual(pet.sideButton.symbolName, "arrow.left")
    XCTAssertEqual(pet.sideButton.accessibilityLabel(), "Bring ClawdTime back from the edge")
  }

  func testTheButtonsGrowOutOfTheirPlacesAndHideWhenAway() {
    let pet = PetController(defaults: defaults)
    let rest = PetLayout.buttons(size: pet.window.frame.size, side: .right)
    pet.layoutButtons(shown: 0)
    XCTAssertTrue(pet.closeButton.isHidden); XCTAssertTrue(pet.sideButton.isHidden)
    pet.layoutButtons(shown: 0.5)
    XCTAssertFalse(pet.closeButton.isHidden)
    XCTAssertEqual(pet.closeButton.alphaValue, 0.5, accuracy: 0.001)
    for (button, place) in [(pet.closeButton, rest.close), (pet.sideButton, rest.side)] {
      XCTAssertLessThan(button.frame.width, place.width)
      XCTAssertEqual(button.frame.midX, place.midX, accuracy: 0.001)
      XCTAssertLessThan(button.frame.midY, place.midY, "it rises into place")
    }
    // Still one column, the close button above the side button.
    XCTAssertGreaterThan(pet.closeButton.frame.minY, pet.sideButton.frame.maxY)
  }
}
