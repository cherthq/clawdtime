import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// What the hands send: keys, typed text, wheel turns, and what they may open.
/// These are plans only. No event is made or sent here.
final class HandsInputTests: XCTestCase {
  func testAKeyComboBecomesAKeyCodeAndModifierFlags() throws {
    // The flag values are the ones that Core Graphics events carry.
    XCTAssertEqual(KeyCombo.command, CGEventFlags.maskCommand.rawValue)
    XCTAssertEqual(KeyCombo.shift, CGEventFlags.maskShift.rawValue)
    XCTAssertEqual(KeyCombo.option, CGEventFlags.maskAlternate.rawValue)
    XCTAssertEqual(KeyCombo.control, CGEventFlags.maskControl.rawValue)
    XCTAssertEqual(KeyCombo.function, CGEventFlags.maskSecondaryFn.rawValue)

    XCTAssertEqual(KeyCombo.parse("cmd+shift+4"), KeyCombo(keyCode: 21, flags: KeyCombo.command | KeyCombo.shift, character: "4"))
    XCTAssertEqual(KeyCombo.parse("return"), KeyCombo(keyCode: 36, flags: 0, character: nil))
    XCTAssertEqual(KeyCombo.parse("escape"), KeyCombo(keyCode: 53, flags: 0, character: nil))
    XCTAssertEqual(KeyCombo.parse("tab"), KeyCombo(keyCode: 48, flags: 0, character: nil))
    XCTAssertEqual(KeyCombo.parse("cmd+s"), KeyCombo(keyCode: 1, flags: KeyCombo.command, character: "s"))
    XCTAssertEqual(KeyCombo.returnKey, 36); XCTAssertEqual(KeyCombo.tabKey, 48); XCTAssertEqual(KeyCombo.escapeKey, 53)

    // Every modifier, by each of its names, in any order before the key.
    let all = KeyCombo.command | KeyCombo.shift | KeyCombo.option | KeyCombo.control | KeyCombo.function
    XCTAssertEqual(KeyCombo.parse("fn+ctrl+alt+shift+cmd+a")?.flags, all)
    XCTAssertEqual(KeyCombo.parse("command+control+option+shift+fn+a")?.flags, all)
    XCTAssertEqual(KeyCombo.parse("meta+opt+a")?.flags, KeyCombo.command | KeyCombo.option)
    XCTAssertEqual(KeyCombo.parse("Cmd+Shift+S"), KeyCombo.parse("cmd+shift+s"))
    XCTAssertEqual(KeyCombo.parse("cmd + s"), KeyCombo.parse("cmd+s"))

    // Named keys, with the codes of a United States keyboard.
    let named: [String: UInt16] = ["space": 49, "delete": 51, "backspace": 51, "enter": 36, "esc": 53, "forwarddelete": 117,
      "home": 115, "end": 119, "pageup": 116, "page_down": 121, "left": 123, "right": 124, "down": 125, "up": 126,
      "arrowup": 126, "f1": 122, "f5": 96, "f12": 111]
    for (name, code) in named { XCTAssertEqual(KeyCombo.parse(name)?.keyCode, code, name) }
    let printed: [String: UInt16] = ["a": 0, "z": 6, "q": 12, "w": 13, "m": 46, "0": 29, "1": 18, "9": 25, "-": 27, "=": 24,
      "[": 33, "]": 30, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "\\": 42, "`": 50]
    for (name, code) in printed {
      XCTAssertEqual(KeyCombo.parse("cmd+" + name), KeyCombo(keyCode: code, flags: KeyCombo.command, character: name), name)
    }
    // The plus key shares its sign with the separator.
    XCTAssertEqual(KeyCombo.parse("cmd++"), KeyCombo(keyCode: 24, flags: KeyCombo.command | KeyCombo.shift, character: nil, printing: true))
    XCTAssertEqual(KeyCombo.parse("cmd+plus"), KeyCombo.parse("cmd++"))
    XCTAssertEqual(KeyCombo.parse("+")?.keyCode, 24)
    XCTAssertEqual(KeyCombo.parse("cmd+-"), KeyCombo(keyCode: 27, flags: KeyCombo.command, character: "-"))
    XCTAssertEqual(KeyCombo.parse("cmd+minus"), KeyCombo.parse("cmd+-"))
  }

  func testAKeyThatPrintsIsTextAndAShortcutIsNot() {
    // A key that puts a character into a field is text. The hands keep text out of a password field.
    for combo in ["a", "shift+a", "alt+a", "fn+a", "7", "-", "minus", "+", "plus", "shift+plus", "space", "shift+space", ".", "`"] {
      XCTAssertEqual(KeyCombo.parse(combo)?.typesText, true, combo)
    }
    // With Command or Control it is a shortcut. A key with a name moves, confirms or deletes.
    for combo in ["cmd+a", "ctrl+a", "cmd+shift+4", "ctrl+alt+space", "cmd++", "return", "enter", "tab", "shift+tab", "escape",
                  "delete", "forwarddelete", "left", "up", "home", "pagedown", "f5"] {
      XCTAssertEqual(KeyCombo.parse(combo)?.typesText, false, combo)
    }
  }

  func testAKeyComboThatIsNotKnownIsRefused() {
    let refused = ["", " ", "cmd", "cmd+shift", "shift+", "+s", "cmd++s", "a+b", "s+cmd", "cmd+cmd+s", "cmd+command+s",
                   "hyper+s", "cmd+banana", "cmd+ß", "cmd+!", "cmd+?", "f13", "ab", "cmd+ab", "return+return", "cmd,s", "cmd-s",
                   "ctrl+alt+", "++", "cmd+\n", String(repeating: "cmd+", count: 10) + "s"]
    for combo in refused { XCTAssertNil(KeyCombo.parse(combo), combo) }
    // Forty characters is the contract's limit.
    XCTAssertNotNil(KeyCombo.parse("command+control+option+shift+fn+pagedown"))
    XCTAssertNil(KeyCombo.parse("command+control+option+shift+fn+page_down "))
  }

  func testTypedTextIsCutIntoWholeCharactersAndLineBreaksBecomeKeys() {
    XCTAssertEqual(TypingPlan.steps("hi"), [.text("h"), .text("i")])
    XCTAssertEqual(TypingPlan.steps(""), [])
    // A line break is the Return key and a tab is the Tab key, also at the ends.
    XCTAssertEqual(TypingPlan.steps("a\nb\tc"), [.text("a"), .key(36), .text("b"), .key(48), .text("c")])
    XCTAssertEqual(TypingPlan.steps("\r\na\r\n"), [.key(36), .text("a"), .key(36)])
    XCTAssertEqual(TypingPlan.steps("a\rb"), [.text("a"), .key(36), .text("b")])
    // Any Unicode goes whole: an accent, a script, a joined sign of several code points.
    let family = "👨‍👩‍👧‍👦", accented = "e\u{301}"
    XCTAssertEqual(TypingPlan.steps("é世👋" + family + accented), [.text("é"), .text("世"), .text("👋"), .text(family), .text(accented)])
    // Other control codes are not text.
    XCTAssertEqual(TypingPlan.steps("a\u{0}\u{1B}\u{7F}b"), [.text("a"), .text("b")])

    // Several characters in one event: never more than twenty UTF-16 units, never a cut character.
    XCTAssertEqual(TypingPlan.steps("hello world", perStep: 4), [.text("hell"), .text("o wo"), .text("rld")])
    let waves = String(repeating: "👋", count: 25)
    let pieces = TypingPlan.steps(waves, perStep: 100)
    XCTAssertEqual(pieces, [.text(String(repeating: "👋", count: 10)), .text(String(repeating: "👋", count: 10)), .text(String(repeating: "👋", count: 5))])
    let long = "a" + String(repeating: "\u{301}", count: 30)
    let cut = TypingPlan.steps(long)
    XCTAssertEqual(cut.count, 2)
    for step in cut + pieces {
      guard case .text(let piece) = step else { return XCTFail("A key in plain text") }
      XCTAssertLessThanOrEqual(piece.utf16.count, TypingPlan.unitsPerEvent)
    }
    // Nothing is lost and nothing is added.
    func joined(_ steps: [TypingStep]) -> String { steps.map { if case .text(let piece) = $0 { return piece }; return "" }.joined() }
    XCTAssertEqual(joined(cut).unicodeScalars.count, long.unicodeScalars.count)
    XCTAssertEqual(joined(pieces), waves)
    let text = "Grüße, 世界! 👋 naïve café"
    XCTAssertEqual(joined(TypingPlan.steps(text)), text)
    XCTAssertEqual(joined(TypingPlan.steps(text, perStep: 7)), text)
  }

  func testBatchedTypingPerStep8PreservesGraphemesEmojiCJKKeysAndUTF16Limit() {
    // Plain ASCII splits cleanly into 8-character chunks.
    XCTAssertEqual(TypingPlan.steps("abcdefghijklmnopq", perStep: 8), [.text("abcdefgh"), .text("ijklmnop"), .text("q")])
    // Newlines and tabs always flush before and emit dedicated key events.
    XCTAssertEqual(TypingPlan.steps("first line\nsecond\tthird", perStep: 8),
      [.text("first li"), .text("ne"), .key(KeyCombo.returnKey), .text("second"), .key(KeyCombo.tabKey), .text("third")])
    // CJK text (1 UTF-16 unit per BMP character) batches at 8 characters per step.
    let cjk = "你好世界测试文本一二三"
    let cjkSteps = TypingPlan.steps(cjk, perStep: 8)
    XCTAssertEqual(cjkSteps, [.text("你好世界测试文本"), .text("一二三")])
    // Surrogate-pair emoji (2 UTF-16 units each): 8 emoji = 16 UTF-16 units <= 20, fits in one step.
    let eightWaves = String(repeating: "👋", count: 8)
    XCTAssertEqual(TypingPlan.steps(eightWaves + "!", perStep: 8), [.text(eightWaves), .text("!")])
    // Multi-code-point ZWJ grapheme cluster (11 UTF-16 units each): never split across events, bounded by 20 UTF-16 units.
    let family = "👨‍👩‍👧‍👦"
    XCTAssertEqual(family.utf16.count, 11)
    let families = TypingPlan.steps(family + family + family, perStep: 8)
    XCTAssertEqual(families, [.text(family), .text(family), .text(family)])
    // Mixed combining accents, emoji, CJK, and line breaks round-trip with every chunk <= 20 UTF-16 units.
    let mixed = "Café e\u{301} \(family) 👋世界\n\t다음줄 1234567890"
    let mixedSteps = TypingPlan.steps(mixed, perStep: 8)
    var rebuilt = ""
    for step in mixedSteps {
      switch step {
      case .text(let piece):
        XCTAssertLessThanOrEqual(piece.utf16.count, TypingPlan.unitsPerEvent)
        XCTAssertLessThanOrEqual(piece.count, 8)
        rebuilt += piece
      case .key(KeyCombo.returnKey): rebuilt += "\n"
      case .key(KeyCombo.tabKey): rebuilt += "\t"
      case .key(let other): XCTFail("Unexpected key code \(other)")
      }
    }
    XCTAssertEqual(rebuilt, mixed)
  }

  func testAScrollInLinesBecomesWheelTurnsOfTheOtherSign() {
    typealias Tick = ScrollPlan.Tick
    // A positive dy moves the content up: a wheel event counts that as negative.
    XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: 3), [Tick(vertical: -3, horizontal: 0)])
    XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: -3), [Tick(vertical: 3, horizontal: 0)])
    XCTAssertEqual(ScrollPlan.ticks(dx: 2, dy: 0), [Tick(vertical: 0, horizontal: -2)])
    XCTAssertEqual(ScrollPlan.ticks(dx: -2, dy: 1), [Tick(vertical: -1, horizontal: 2)])
    XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: 0), [])
    // A long scroll goes as several turns of a few lines.
    XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: 12), [Tick(vertical: -5, horizontal: 0), Tick(vertical: -5, horizontal: 0), Tick(vertical: -2, horizontal: 0)])
    XCTAssertEqual(ScrollPlan.ticks(dx: 7, dy: -2), [Tick(vertical: 2, horizontal: -5), Tick(vertical: 0, horizontal: -2)])
    // A part of a line still moves one line. A number with no meaning moves nothing.
    XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: 0.2), [Tick(vertical: -1, horizontal: 0)])
    XCTAssertEqual(ScrollPlan.ticks(dx: .nan, dy: .infinity), [])
    // One command never scrolls more than the limit.
    let far = ScrollPlan.ticks(dx: 0, dy: 100_000)
    XCTAssertEqual(far.reduce(0) { $0 + Int($1.vertical) }, -ScrollPlan.limit)
    XCTAssertTrue(far.allSatisfy { abs($0.vertical) <= Int32(ScrollPlan.linesPerEvent) })
    // The contract takes any finite number. One too large for a whole number is cut like the others.
    for huge in [1e30, 1e300, Double.greatestFiniteMagnitude] {
      XCTAssertEqual(ScrollPlan.ticks(dx: 0, dy: huge).reduce(0) { $0 + Int($1.vertical) }, -ScrollPlan.limit)
      XCTAssertEqual(ScrollPlan.ticks(dx: -huge, dy: 0).reduce(0) { $0 + Int($1.horizontal) }, ScrollPlan.limit)
    }
  }

  func testOnlyAWebAddressIsOpened() {
    XCTAssertEqual(HandsTarget.webURL("https://example.com/a?b=1#c")?.absoluteString, "https://example.com/a?b=1#c")
    XCTAssertEqual(HandsTarget.webURL("http://127.0.0.1:8080/")?.host, "127.0.0.1")
    XCTAssertNotNil(HandsTarget.webURL("HTTPS://Example.com"))
    // Another scheme can start a program, a file or a call. A name and password in the address are refused too.
    let refused = ["", "example.com", "/etc/passwd", "file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "tel:+15550100",
                   "facetime://someone", "shortcuts://run-shortcut?name=x", "x-apple.systempreferences:com.apple.preference.security",
                   "mailto:someone@example.com", "https://", "https:///path", "https://user:secret@example.com", "https://user@example.com",
                   "https://example.com/a b", "https://example.com/\n", " https://example.com", "https://example.com/" + String(repeating: "a", count: 2000)]
    for url in refused { XCTAssertNil(HandsTarget.webURL(url), url) }
  }

  func testAnAppIsOpenedByItsNameAndNeverByAPath() {
    XCTAssertEqual(HandsTarget.appName("Safari"), "Safari")
    XCTAssertEqual(HandsTarget.appName("  System Settings "), "System Settings")
    XCTAssertEqual(HandsTarget.appName("Notes.app"), "Notes")
    XCTAssertEqual(HandsTarget.appName("com.apple.Safari"), "com.apple.Safari")
    for name in ["", "   ", ".app", "/Applications/Safari.app", "../Safari", "..", ".hidden", "Macintosh HD:Applications:Safari",
                 "Safari\n", "a/b", String(repeating: "n", count: 121)] {
      XCTAssertNil(HandsTarget.appName(name), name)
    }
  }
}
