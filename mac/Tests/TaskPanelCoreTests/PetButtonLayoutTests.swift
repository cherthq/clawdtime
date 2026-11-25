import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// The close button and the side button stand in one column on one side of the mascot:
/// the close button on top, the side button just under it.
final class PetButtonLayoutTests: XCTestCase {
  let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
  let scales = [PetLayout.scaleRange.lowerBound, PetLayout.defaultScale, 1, PetLayout.scaleRange.upperBound]
  /// A tucked mascot shows its buttons under the pointer, where it comes out to `revealHover`.
  /// They must also stay on the screen while it waits for the person.
  let reveals = [PetLayout.revealAttention, PetLayout.revealHover]

  private func onScreen(_ button: CGRect, in window: CGRect) -> CGRect { button.offsetBy(dx: window.minX, dy: window.minY) }
  private func assertColumn(_ both: (close: CGRect, side: CGRect), size: CGSize, file: StaticString = #filePath, line: UInt = #line) {
    let d = PetLayout.buttonDiameter
    XCTAssertEqual(both.close.size, CGSize(width: d, height: d), file: file, line: line)
    XCTAssertEqual(both.side.size, CGSize(width: d, height: d), file: file, line: line)
    XCTAssertEqual(both.close.minX, both.side.minX, "one column", file: file, line: line)
    XCTAssertEqual(both.close.minY - both.side.maxY, PetLayout.buttonGap, "the side button just under the close button", file: file, line: line)
    XCTAssertEqual(both.close.maxY, size.height - PetLayout.buttonInset, "the close button on top", file: file, line: line)
    XCTAssertGreaterThanOrEqual(both.side.minY, 0, "inside the window", file: file, line: line)
  }

  func testAFreeMascotHasBothButtonsInOneColumnOnTheRightWithCloseOnTop() {
    XCTAssertEqual(PetLayout.buttonSide(docked: nil), .right)
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      let both = PetLayout.buttons(size: size, side: .right)
      assertColumn(both, size: size)
      XCTAssertEqual(both.close.maxX, size.width - PetLayout.buttonInset, "scale \(scale)")
      XCTAssertGreaterThan(both.close.midX, size.width / 2)
    }
    // At the start size: the close button at the top right corner, the side button 32 points under it.
    let start = PetLayout.buttons(size: PetLayout.size(scale: PetLayout.defaultScale), side: .right)
    XCTAssertEqual(start.close, CGRect(x: 74, y: 74, width: 26, height: 26))
    XCTAssertEqual(start.side, CGRect(x: 74, y: 42, width: 26, height: 26))
  }

  func testDockedLeftTheColumnStandsOnTheRightAndStaysOnTheScreen() {
    XCTAssertEqual(PetLayout.buttonSide(docked: .left), .right)
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      let both = PetLayout.buttons(size: size, side: PetLayout.buttonSide(docked: .left))
      assertColumn(both, size: size)
      XCTAssertEqual(both.close.maxX, size.width - PetLayout.buttonInset)
      for reveal in reveals {
        let window = PetLayout.docked(side: .left, y: 400, reveal: reveal, in: screen, size: size)
        XCTAssertTrue(screen.contains(onScreen(both.close, in: window)), "scale \(scale), reveal \(reveal)")
        XCTAssertTrue(screen.contains(onScreen(both.side, in: window)), "scale \(scale), reveal \(reveal)")
        // The edge it tucks into stays free.
        XCTAssertGreaterThan(onScreen(both.side, in: window).minX, screen.minX + 4)
      }
    }
  }

  func testDockedRightTheColumnStandsOnTheLeftAndStaysOnTheScreen() {
    XCTAssertEqual(PetLayout.buttonSide(docked: .right), .left)
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      let both = PetLayout.buttons(size: size, side: PetLayout.buttonSide(docked: .right))
      assertColumn(both, size: size)
      XCTAssertEqual(both.close.minX, PetLayout.buttonInset)
      for reveal in reveals {
        let window = PetLayout.docked(side: .right, y: 400, reveal: reveal, in: screen, size: size)
        XCTAssertTrue(screen.contains(onScreen(both.close, in: window)), "scale \(scale), reveal \(reveal)")
        XCTAssertTrue(screen.contains(onScreen(both.side, in: window)), "scale \(scale), reveal \(reveal)")
        XCTAssertLessThan(onScreen(both.side, in: window).maxX, screen.maxX - 4)
      }
    }
  }

  func testNearTheTopEdgeBothButtonsStayOnTheScreenWithCloseAbove() {
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      let free = CGRect(origin: PetLayout.clamp(origin: CGPoint(x: 900, y: 5000), size: size, in: screen), size: size)
      let windows = [(free, PetLayout.buttonSide(docked: nil)),
                     (PetLayout.docked(side: .left, y: 5000, reveal: PetLayout.revealHover, in: screen, size: size), PetLayout.buttonSide(docked: .left)),
                     (PetLayout.docked(side: .right, y: 5000, reveal: PetLayout.revealHover, in: screen, size: size), PetLayout.buttonSide(docked: .right))]
      for (window, side) in windows {
        let both = PetLayout.buttons(size: size, side: side)
        let close = onScreen(both.close, in: window), under = onScreen(both.side, in: window)
        XCTAssertTrue(screen.contains(close), "scale \(scale), \(side)"); XCTAssertTrue(screen.contains(under), "scale \(scale), \(side)")
        XCTAssertLessThanOrEqual(close.maxY, screen.maxY - 6)
        XCTAssertGreaterThan(close.minY, under.maxY)
      }
    }
  }

  func testPressesReachBothButtonsWhileTheyShowAndPassThroughElsewhere() {
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      let free = CGRect(origin: CGPoint(x: 700, y: 400), size: size)
      let left = PetLayout.docked(side: .left, y: 400, reveal: PetLayout.revealHover, in: screen, size: size)
      let right = PetLayout.docked(side: .right, y: 400, reveal: PetLayout.revealHover, in: screen, size: size)
      for (window, side) in [(free, PetSide.right), (left, .right), (right, .left)] {
        let both = PetLayout.buttons(size: size, side: side)
        for button in [both.close, both.side] {
          let middle = CGPoint(x: window.minX + button.midX, y: window.minY + button.midY)
          XCTAssertTrue(PetLayout.takesPress(pointer: middle, window: window, buttons: side, shown: 1), "scale \(scale), \(side)")
          // The rim of the circle counts too.
          let rim = CGPoint(x: window.minX + (side == .right ? button.maxX - 1 : button.minX + 1), y: window.minY + button.midY)
          XCTAssertTrue(PetLayout.takesPress(pointer: rim, window: window, buttons: side, shown: 1), "scale \(scale), \(side)")
        }
        // The other top corner, where the close button stood before, lets clicks through to what is behind.
        let corner = CGPoint(x: side == .right ? window.minX + 12 : window.maxX - 12, y: window.maxY - 12)
        XCTAssertFalse(PetLayout.takesPress(pointer: corner, window: window, buttons: side, shown: 1), "scale \(scale), \(side)")
        // Hidden buttons take nothing: the top of the column is clear of the stone and passes the click on.
        let top = CGPoint(x: window.minX + both.close.midX, y: window.minY + both.close.midY)
        XCTAssertFalse(PetLayout.takesPress(pointer: top, window: window, buttons: side, shown: 0.2), "scale \(scale), \(side)")
        // Outside the window nothing is taken, even right next to the column.
        let beside = CGPoint(x: side == .right ? window.maxX + 2 : window.minX - 2, y: window.minY + both.close.midY)
        XCTAssertFalse(PetLayout.takesPress(pointer: beside, window: window, buttons: side, shown: 1))
      }
      // The stone takes a press whether the buttons show or not.
      XCTAssertTrue(PetLayout.takesPress(pointer: CGPoint(x: free.midX, y: free.midY), window: free, buttons: .right, shown: 0))
    }
  }

  func testTheAreaOfTheButtonsCoversBothCirclesAndStaysInTheWindow() {
    for scale in scales {
      let size = PetLayout.size(scale: scale)
      for side in [PetSide.left, .right] {
        let area = PetLayout.buttonsArea(size: size, side: side), both = PetLayout.buttons(size: size, side: side)
        XCTAssertTrue(area.contains(both.close)); XCTAssertTrue(area.contains(both.side))
        XCTAssertTrue(CGRect(origin: .zero, size: size).contains(area))
        // It never reaches the other half of the window.
        XCTAssertTrue(side == .right ? area.minX > size.width / 2 - 10 : area.maxX < size.width / 2 + 10, "scale \(scale), \(side)")
      }
    }
  }
}
