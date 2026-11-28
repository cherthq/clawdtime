import AppKit
import XCTest
@testable import ClawdTimeApp

/// The words of the welcome screen, and the prompt that the last screen copies
/// for a coding agent. Nothing here touches the clipboard of the person.
@MainActor
final class SetupCopyPromptTests: XCTestCase {
  func testTheWelcomeScreenSaysWhatClawdTimeIsInOneLine() {
    XCTAssertEqual(WelcomeView.title, "Talk to your Mac. It does the work.")
    // The line links Built on Chert to Chert, the company of the FaceTime lines.
    XCTAssertEqual(WelcomeView.ambition,
                   "ClawdTime: a computer use agent you can FaceTime. [Built on Chert](https://www.trychert.com).")
    let plain = WelcomeView.ambition.replacingOccurrences(of: "[Built on Chert](https://www.trychert.com)", with: "Built on Chert")
    XCTAssertEqual(plain, "ClawdTime: a computer use agent you can FaceTime. Built on Chert.")
  }

  func testThePromptTellsACodingAgentHowToGiveTasksToClawdTime() {
    let prompt = FinishedView.agentPrompt(command: nil)
    XCTAssertTrue(prompt.contains("clawdtime chat \"TASK\""))
    XCTAssertTrue(prompt.contains("\nclawdtime agents\n"))
    XCTAssertTrue(prompt.contains("clawdtime help"))
    XCTAssertTrue(prompt.contains("Never ask me for a key."))
    // With no command of its own, the prompt names the usual place of the app.
    XCTAssertTrue(prompt.hasSuffix("use the full path: /Applications/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime"))
    XCTAssertFalse(prompt.contains("\u{2014}") || prompt.contains("\u{2013}"))
    // Simplified Technical English: an instruction has 20 words or fewer.
    for line in prompt.split(separator: "\n") {
      for sentence in line.split(separator: ". ") {
        XCTAssertLessThanOrEqual(sentence.split(separator: " ").count, 20, String(sentence))
      }
    }
  }

  func testThePromptNamesTheCommandOfThisAppAndQuotesAPathWithASpace() {
    let moved = FinishedView.agentPrompt(command: "/Users/fixture/Downloads/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime")
    XCTAssertTrue(moved.hasSuffix("use the full path: /Users/fixture/Downloads/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime"))
    let spaced = FinishedView.agentPrompt(command: "/Volumes/Fixture Disk/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime")
    XCTAssertTrue(spaced.hasSuffix("use the full path: '/Volumes/Fixture Disk/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime'"))
    let quote = FinishedView.agentPrompt(command: "/Volumes/It's/clawdtime")
    XCTAssertTrue(quote.hasSuffix("use the full path: '/Volumes/It'\\''s/clawdtime'"))
  }

  func testCopyPutsThePromptOnThePasteboardAsPlainText() {
    // A private pasteboard: the clipboard of the person stays as it is.
    let board = NSPasteboard(name: NSPasteboard.Name("clawdtime-test-\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    board.setString("before", forType: .string)
    FinishedView.copyToPasteboard("the prompt", board: board)
    XCTAssertEqual(board.string(forType: .string), "the prompt")
    // Plain text only: no rich text that a terminal would paste as markup.
    XCTAssertFalse(board.types?.contains(.rtf) ?? true)
  }
}
