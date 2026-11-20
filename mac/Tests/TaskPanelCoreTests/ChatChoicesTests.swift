import Foundation
import XCTest
@testable import TaskPanelCore

/// A chat message may carry the answers to a question, as buttons.
final class ChatChoicesTests: XCTestCase {
  private func transcript(_ message: String) -> String {
    #"{"version":1,"model":true,"speech":false,"voiceDirectory":"/v","messages":["# + message + "]}"
  }

  func testChoicesOfClawdTimesMessageDecodeAndAreOffered() throws {
    let json = transcript(#"{"role":"assistant","text":"The task asks which database to use: staging or production.","at":2,"via":"chat","choices":["Staging","Production"]}"#)
    let chat = try JSONDecoder().decode(ChatTranscript.self, from: Data(json.utf8))
    try chat.validate()
    XCTAssertEqual(chat.messages[0].choices, ["Staging", "Production"])
    XCTAssertEqual(chat.messages[0].offered, ["Staging", "Production"])
  }

  func testAMessageWithoutChoicesOffersNoneAndAnOlderServiceStillDecodes() throws {
    let json = transcript(#"{"role":"assistant","text":"All quiet.","at":2,"via":"voice"}"#)
    let chat = try JSONDecoder().decode(ChatTranscript.self, from: Data(json.utf8))
    try chat.validate()
    XCTAssertNil(chat.messages[0].choices)
    XCTAssertEqual(chat.messages[0].offered, [])
  }

  func testThePersonsOwnMessageNeverShowsButtons() {
    let mine = ChatTranscript.Message(role: "user", text: "Staging", at: 3, via: "chat", choices: ["Staging"])
    XCTAssertEqual(mine.offered, [])
  }

  func testTooManyOrTooLongChoicesAreRefused() throws {
    let five = transcript(#"{"role":"assistant","text":"x","at":2,"via":"chat","choices":["a","b","c","d","e"]}"#)
    XCTAssertThrowsError(try JSONDecoder().decode(ChatTranscript.self, from: Data(five.utf8)).validate())
    let long = ChatTranscript(version: 1, model: true, speech: false, voiceDirectory: "/v",
      messages: [.init(role: "assistant", text: "x", at: 2, via: "chat", choices: [String(repeating: "a", count: 81)])])
    XCTAssertThrowsError(try long.validate())
    XCTAssertEqual(long.messages[0].offered, [], "a choice that is too long is never a button")
    let empty = ChatTranscript(version: 1, model: true, speech: false, voiceDirectory: "/v",
      messages: [.init(role: "assistant", text: "x", at: 2, via: "chat", choices: [""])])
    XCTAssertThrowsError(try empty.validate())
    // A reply to one typed message carries its choices too.
    let reply = try JSONDecoder().decode(ChatReply.self,
      from: Data(#"{"reply":{"role":"assistant","text":"Which one?","at":4,"via":"chat","choices":["Yes","No"]}}"#.utf8))
    XCTAssertEqual(reply.reply.offered, ["Yes", "No"])
  }

  func testTheMessageThatIsBeingAnsweredIsDrawnOnce() {
    let mine = { (text: String) in ChatTranscript.Message(role: "user", text: text, at: 1, via: "chat") }
    let answer = ChatTranscript.Message(role: "assistant", text: "Okay.", at: 2, via: "chat")
    // The service has not written the message down yet: it shows as being sent.
    XCTAssertFalse(ChatTranscript.holdsPending([mine("status"), answer], pending: "open chrome"))
    XCTAssertFalse(ChatTranscript.holdsPending([], pending: "open chrome"))
    // The transcript holds it now: the same words are not drawn a second time.
    XCTAssertTrue(ChatTranscript.holdsPending([answer, mine("open chrome")], pending: "open chrome"))
    XCTAssertTrue(ChatTranscript.holdsPending([mine("open chrome ")], pending: " open chrome"))
    // The same words sent twice in a row: the second is new until the service wrote it down.
    XCTAssertFalse(ChatTranscript.holdsPending([mine("yes"), answer], pending: "yes"))
    // Nothing is being sent, or the last words are other words.
    XCTAssertFalse(ChatTranscript.holdsPending([mine("open chrome")], pending: nil))
    XCTAssertFalse(ChatTranscript.holdsPending([mine("open slack")], pending: "open chrome"))
  }
}
