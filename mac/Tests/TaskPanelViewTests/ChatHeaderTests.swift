import AppKit
import XCTest
@testable import ClawdTimeTaskPanel
import TaskPanelCore

/// The New chat button in the header of the chat. The view is built off screen: no window is shown.
@MainActor
final class ChatHeaderTests: XCTestCase {
  func testTheNewChatButtonStandsNextToCloseWithItsLabelAndStartsANewChat() throws {
    let chat = ChatView(frame: NSRect(x: 0, y: 0, width: ChatView.width, height: 400))
    var asked = 0
    chat.onNewChat = { asked += 1 }
    let button = try XCTUnwrap(chat.newChat)
    XCTAssertEqual(button.accessibilityLabel(), "Start a new chat")
    XCTAssertEqual(button.accessibilityRole(), .button)
    XCTAssertEqual(button.toolTip, "Start a new chat")
    XCTAssertEqual(button.symbolName, "square.and.pencil")
    // It stands in the header, just before Close.
    let header = try XCTUnwrap(button.superview as? NSStackView)
    let place = try XCTUnwrap(header.arrangedSubviews.firstIndex(of: button))
    XCTAssertEqual(header.arrangedSubviews.last, header.arrangedSubviews[place + 1])
    XCTAssertEqual(header.arrangedSubviews[place + 1].accessibilityLabel(), "Close the chat")
    XCTAssertTrue(button.isEnabled)
    XCTAssertTrue(button.accessibilityPerformPress())
    XCTAssertEqual(asked, 1)
  }

  func testTheNewChatButtonDoesNothingWhileAnAnswerIsDueOrWithNoService() throws {
    let chat = ChatView(frame: NSRect(x: 0, y: 0, width: ChatView.width, height: 400))
    var asked = 0
    chat.onNewChat = { asked += 1 }
    let button = try XCTUnwrap(chat.newChat)
    var model = ChatModel()
    model.pending = "Open Mail and find the invoice"
    chat.render(model)
    XCTAssertFalse(button.isEnabled)
    _ = button.accessibilityPerformPress()
    model = ChatModel(); model.voice = .thinking
    chat.render(model)
    XCTAssertFalse(button.isEnabled)
    _ = button.accessibilityPerformPress()
    model = ChatModel(); model.connected = false
    chat.render(model)
    XCTAssertFalse(button.isEnabled)
    _ = button.accessibilityPerformPress()
    XCTAssertEqual(asked, 0)
    // The answer came: the button works again.
    chat.render(ChatModel())
    XCTAssertTrue(button.isEnabled)
    _ = button.accessibilityPerformPress()
    XCTAssertEqual(asked, 1)
  }
}
