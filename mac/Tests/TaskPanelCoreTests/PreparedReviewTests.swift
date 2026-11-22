import XCTest
@testable import TaskPanelCore

final class PreparedReviewTests: XCTestCase {
    let now: Double = 1_800_000_000_000
    func data(_ changes: [String: Any] = [:]) throws -> Data {
        var value: [String: Any] = ["version": 1, "title": "ClawdTime review synthetic-attempt", "sections": [["heading": "Needs your decision", "text": "Synthetic fixture question."]], "expiresAt": now + 60000]
        for (key, entry) in changes { value[key] = entry }
        return try JSONSerialization.data(withJSONObject: value)
    }
    func testPlainEvidenceIsRetainedAsLiteralText() throws {
        let value = try PreparedReviewDocument.parse(data(["sections": [["heading": "Checks", "text": "<script>not executable</script> https://example.test"]]]), now: now)
        XCTAssertEqual(value.sections.first?.text, "<script>not executable</script> https://example.test")
    }
    func testExpiredAndUnboundedLifetimesRefuse() throws {
        for expiry in [now, now - 1, now + 1_800_001] {
            XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["expiresAt": expiry]), now: now))
        }
    }
    func testUnrecognizedFieldsCannotBecomeRendererCommands() throws {
        XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["script": "fixture"]), now: now))
        XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["sections": [["heading": "Result", "text": "fixture", "url": "https://example.test"]]]), now: now))
    }
    func testWrongAndControlBearingTitlesRefuse() throws {
        for title in ["Other window", "ClawdTime review \nnew line", String(repeating: "x", count: 161)] {
            XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["title": title]), now: now))
        }
    }
    func testOversizedOrEmptyContentRefuses() throws {
        XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["sections": []]), now: now))
        XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["sections": [["heading": "Result", "text": String(repeating: "x", count: 8001)]]]), now: now))
        XCTAssertThrowsError(try PreparedReviewDocument.parse(data(["sections": Array(repeating: ["heading": "Result", "text": "fixture"], count: 13)]), now: now))
    }
    func testInvalidationHasNoArbitraryContentOrCommands() throws {
        XCTAssertEqual(try PreparedReviewCommand.parse(Data("{\"id\":\"fixture-one\",\"op\":\"invalidate\"}".utf8)).id, "fixture-one")
        for text in ["{\"id\":\"one\",\"op\":\"replace\"}", "{\"id\":\"one\",\"op\":\"invalidate\",\"text\":\"new content\"}", "{\"id\":\"../bad\",\"op\":\"invalidate\"}"] {
            XCTAssertThrowsError(try PreparedReviewCommand.parse(Data(text.utf8)))
        }
    }
}
