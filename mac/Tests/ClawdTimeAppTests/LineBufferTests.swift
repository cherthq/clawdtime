import XCTest
@testable import ClawdTimeAppCore

final class LineBufferTests: XCTestCase {
  func testLinesSplitAcrossChunksAreJoined() {
    var buffer = LineBuffer()
    XCTAssertEqual(buffer.append(Data("{\"type\":".utf8)), [])
    XCTAssertEqual(buffer.append(Data("\"hello\"}\n{\"a\":1}\r\n{\"b\"".utf8)), ["{\"type\":\"hello\"}", "{\"a\":1}"])
    XCTAssertEqual(buffer.append(Data(":2}\n".utf8)), ["{\"b\":2}"])
    XCTAssertNil(buffer.finish())
  }

  func testTheLastLineWithoutANewlineComesOutAtTheEnd() {
    var buffer = LineBuffer()
    XCTAssertEqual(buffer.append(Data("one\ntwo".utf8)), ["one"])
    XCTAssertEqual(buffer.finish(), "two")
    XCTAssertNil(buffer.finish())
  }

  func testALineOverTheLimitIsDroppedWholeAndTheNextOneSurvives() {
    var buffer = LineBuffer(limit: 8)
    XCTAssertEqual(buffer.append(Data("0123456789".utf8)), [])
    XCTAssertEqual(buffer.append(Data("abcdef\nok\n".utf8)), ["ok"])
    XCTAssertEqual(buffer.droppedLines, 1)
    XCTAssertEqual(buffer.append(Data("0123456789abc\nfine\n".utf8)), ["fine"])
    XCTAssertEqual(buffer.droppedLines, 2)
  }

  func testTheTailKeepsTheLastLinesOnly() {
    var tail = TailBuffer(capacity: 2)
    for line in ["one", "  ", "two", "three"] { tail.append(line) }
    XCTAssertEqual(tail.lines, ["two", "three"])
  }
}
