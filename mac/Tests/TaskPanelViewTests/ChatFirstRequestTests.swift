import AppKit
import XCTest
@testable import ClawdTimeTaskPanel
import TaskPanelCore

/// The end of setup: the empty chat offers one first request. The view is built off screen: no window is shown.
@MainActor
final class ChatFirstRequestTests: XCTestCase {
  private func chips(in view: NSView) -> [PillButton] {
    view.subviews.flatMap { ($0 as? PillButton).map { [$0] } ?? chips(in: $0) }
  }

  func testTheEmptyChatOffersTheOneFirstRequestAndAClickSendsItOnce() throws {
    let chat = ChatView(frame: NSRect(x: 0, y: 0, width: ChatView.width, height: 400))
    XCTAssertGreaterThan(chips(in: chat).count, 1)
    let first = FirstRequest.suggestion(computerUse: true)
    chat.offerFirstRequest(first)
    let offered = chips(in: chat)
    XCTAssertEqual(offered.map(\.title), [first])
    var sent: [String] = []
    chat.onSend = { sent.append($0) }
    // Nothing goes out by itself: only the click sends it.
    XCTAssertEqual(sent, [])
    let chip = try XCTUnwrap(offered.first)
    _ = chip.target?.perform(chip.action, with: chip)
    XCTAssertEqual(sent, [first])
    // With no service, the click sends nothing.
    var model = ChatModel(); model.connected = false
    chat.render(model)
    _ = chip.target?.perform(chip.action, with: chip)
    XCTAssertEqual(sent, [first])
  }

  /// The chat as setup opens it, drawn off screen in light and dark. With
  /// CLAWDTIME_PANEL_SHOTS set to a folder, each picture is written there.
  func testTheChatThatSetupOpensDrawsInLightAndDark() throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_PANEL_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    for (name, computerUse) in [("chat-first-request", true), ("chat-first-request-no-computer-use", false)] {
      for dark in [false, true] {
        let appearance = try XCTUnwrap(NSAppearance(named: dark ? .darkAqua : .aqua))
        let chat = ChatView(frame: NSRect(x: 0, y: 0, width: ChatView.width, height: 400))
        chat.appearance = appearance
        chat.offerFirstRequest(FirstRequest.suggestion(computerUse: computerUse))
        chat.render(ChatModel())
        chat.frame.size.height = chat.fittingHeight
        chat.layoutSubtreeIfNeeded()
        // A window that is never ordered on screen, as the panel preview draws.
        let window = NSWindow(contentRect: chat.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = appearance
        window.contentView = chat
        chat.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(chat.bitmapImageRepForCachingDisplay(in: chat.bounds))
        appearance.performAsCurrentDrawingAppearance {
          chat.cacheDisplay(in: chat.bounds, to: bitmap)
        }
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 2_000, name)
        try folder.map { try png.write(to: $0.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")) }
      }
    }
  }
}
