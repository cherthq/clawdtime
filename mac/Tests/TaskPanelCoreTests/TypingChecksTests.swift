import XCTest
@testable import TaskPanelCore

/// Typed text can move the keyboard on its way: a Tab from a name to a password field, a Return that opens a
/// window, or the app itself. The hands read the place of the keyboard again before each Return and each Tab,
/// after each of them, and every few characters. These are plans only: no event is made here.
final class TypingChecksTests: XCTestCase {
  func testTheKeyboardIsReadBeforeAndAfterEveryReturnAndTab() {
    // A name, Tab to the next field, a password.
    let steps = TypingPlan.steps("Stonepad\tsecret", perStep: 8)
    XCTAssertEqual(steps, [.text("Stonepad"), .key(KeyCombo.tabKey), .text("secret")])
    // The caller reads it before the first step; the Tab and the text after it both wait for a read.
    XCTAssertEqual(TypingPlan.checks(steps), [false, true, true])

    // Two lines: Return comes after a read, and the next line too.
    let lines = TypingPlan.steps("Hi\nThanks\n", perStep: 8)
    XCTAssertEqual(lines, [.text("Hi"), .key(KeyCombo.returnKey), .text("Thanks"), .key(KeyCombo.returnKey)])
    XCTAssertEqual(TypingPlan.checks(lines), [false, true, true, true])

    // Return first: the caller's read covers it, and the text after it waits for a read.
    XCTAssertEqual(TypingPlan.checks([.key(KeyCombo.returnKey), .text("ok")]), [false, true])
  }

  func testTheKeyboardIsReadAfterAtMostAFewCharacters() {
    XCTAssertLessThanOrEqual(TypingPlan.checkEvery, 8)
    // 24 characters in steps of 8: each step after the first waits for a read.
    let steps = TypingPlan.steps(String(repeating: "a", count: 24), perStep: 8)
    XCTAssertEqual(steps.count, 3)
    XCTAssertEqual(TypingPlan.checks(steps), [false, true, true])
    // One character at a time: a read after each eight.
    let single = TypingPlan.steps(String(repeating: "b", count: 17), perStep: 1)
    let checks = TypingPlan.checks(single)
    XCTAssertEqual(checks.indices.filter { checks[$0] }, [8, 16])
    // No step goes more than `checkEvery` characters past a read.
    let mixed = TypingPlan.steps("street 12\tcity of rivers and hills\nzip 94000", perStep: 8)
    var since = 0
    for (step, check) in zip(mixed, TypingPlan.checks(mixed)) {
      if check { since = 0 }
      XCTAssertLessThan(since, TypingPlan.checkEvery)
      if case .text(let piece) = step { since += piece.count }
      if case .key = step { XCTAssertTrue(check || since == 0) }
    }
    XCTAssertEqual(TypingPlan.checks([]), [])
  }
}
