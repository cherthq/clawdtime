import Foundation
import XCTest
@testable import TaskPanelCore

/// "Arrived" has one definition, shared with `verifiedActivation` in the worker
/// (`tests/connectors-computer-desktop.test.ts` holds the same names and titles).
final class DesktopArrivalTests: XCTestCase {
  /// The candidates as the panel lists them: a running app by the name it gives itself,
  /// and an app in a folder by its file name and by the name that Finder shows.
  private let candidates = [
    DesktopAppCandidate(path: "/Applications/iTerm.app", names: ["iTerm2"]),
    DesktopAppCandidate(path: "/Applications/iTerm.app", names: ["iTerm", "iTerm"]),
    DesktopAppCandidate(path: "/Applications/Visual Studio Code.app", names: ["Code"]),
    DesktopAppCandidate(path: "/Applications/Visual Studio Code.app", names: ["Visual Studio Code", "Visual Studio Code"]),
    DesktopAppCandidate(path: "/Applications/Safari.app", names: ["Safari", "Safari"]),
  ]

  func testEveryNameFormOfOneAppFindsThatApp() throws {
    for (said, path) in [("iTerm", "/Applications/iTerm.app"), ("iTerm2", "/Applications/iTerm.app"), ("iterm", "/Applications/iTerm.app"),
                         ("Visual Studio Code", "/Applications/Visual Studio Code.app"), ("Code", "/Applications/Visual Studio Code.app"),
                         ("Safari.app", "/Applications/Safari.app"), ("Safari", "/Applications/Safari.app")] {
      let name = try XCTUnwrap(HandsTarget.appName(said))
      XCTAssertEqual(try DesktopAppSelection.path(named: name, candidates: candidates).get(), path, said)
    }
  }

  func testArrivedMeansTheResolvedAppIsInFront() {
    // The name that was said is not part of the rule: only the app that it stood for.
    XCTAssertTrue(DesktopArrival.sameApp(resolved: "com.googlecode.iterm2", front: "com.googlecode.iterm2"))
    XCTAssertTrue(DesktopArrival.sameApp(resolved: "com.microsoft.VSCode", front: "com.microsoft.vscode"))
    XCTAssertTrue(DesktopArrival.sameApp(resolved: "com.apple.Safari", front: " com.apple.Safari "))
    XCTAssertFalse(DesktopArrival.sameApp(resolved: "com.apple.Safari", front: "com.apple.finder"))
    XCTAssertFalse(DesktopArrival.sameApp(resolved: "com.apple.Safari", front: nil))
    XCTAssertFalse(DesktopArrival.sameApp(resolved: "com.apple.Safari", front: ""))
    XCTAssertFalse(DesktopArrival.sameApp(resolved: "", front: ""))
  }

  func testTheResultSaysWhichAppTheNameStoodFor() throws {
    let seen = Observation(at: 1, screen: .init(width: 100, height: 80, scale: 2), cursor: .init(x: 0, y: 0),
      app: .init(name: "iTerm2", bundleId: "com.googlecode.iterm2", window: "~"), elements: [], surfaceEpoch: 3)
    let result = HandResult.done(7, observation: seen, resolvedBundleId: DesktopArrival.identity("com.googlecode.iterm2"))
    try result.validate()
    let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
    XCTAssertEqual(object["resolvedBundleId"] as? String, "com.googlecode.iterm2")
    XCTAssertTrue(DesktopArrival.sameApp(resolved: result.resolvedBundleId ?? "", front: result.observation?.app.bundleId))
    // Every other command leaves the key out, as before.
    let plain = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(HandResult.done(7))) as? [String: Any])
    XCTAssertNil(plain["resolvedBundleId"])
    XCTAssertThrowsError(try HandResult.done(7, resolvedBundleId: String(repeating: "a", count: 201)).validate())
  }

  func testATitleIsComparedAsAnObservationCarriesIt() {
    let long = String(repeating: "a", count: 250)
    let cut = String(repeating: "a", count: 198) + " bcd"
    // The same pairs are in the worker's test: both sides clean a title the same way.
    for (asked, cleaned) in [("Budget\u{00A0}2026", "Budget 2026"), ("Notes\u{200E} \u{2014} Draft", "Notes \u{2014} Draft"),
                             ("  padded\ttitle\u{2028}here ", "padded title here"), ("Cafe\u{0301} menu", "Cafe\u{0301} menu"),
                             (long, String(repeating: "a", count: 199) + "\u{2026}"), (cut, String(repeating: "a", count: 198) + "\u{2026}")] {
      XCTAssertEqual(ElementCleaner.line(asked), cleaned)
      XCTAssertTrue(DesktopArrival.sameTitle(asked, cleaned))
      XCTAssertTrue(DesktopArrival.sameTitle(cleaned, asked))
    }
    XCTAssertTrue(DesktopArrival.sameTitle("Budget\u{00A0}2026", "Budget 2026"))
    XCTAssertFalse(DesktopArrival.sameTitle("Budget 2026", "Budget 2027"))
    XCTAssertFalse(DesktopArrival.sameTitle("Budget 2026", "budget 2026"))
    XCTAssertFalse(DesktopArrival.sameTitle("Budget2026", "Budget 2026"))
    // The same letters stored in two ways are one title, as in the worker.
    XCTAssertTrue(DesktopArrival.sameTitle("R\u{00E9}sum\u{00E9}.pdf", "Re\u{0301}sume\u{0301}.pdf"))
    // A title that cleans to nothing names no window: it never fits an untitled one.
    for nothing in ["", " ", "\u{200B}", "\u{200B}\u{00A0}\u{FEFF}"] {
      XCTAssertFalse(DesktopArrival.sameTitle(nothing, ""))
      XCTAssertFalse(DesktopArrival.sameTitle("", nothing))
      XCTAssertFalse(DesktopArrival.sameTitle(nothing, nothing))
    }
  }

  func testDynamicLiveTitlesMatchAcrossVolatileDecorationsAndRefuseEmptyCollapse() {
    // Unread counts in parens and brackets.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("(3) Inbox - Mail"), "Inbox - Mail")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("[12+] Slack - #general"), "Slack - #general")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("Inbox (4)"), "Inbox")
    XCTAssertTrue(DesktopArrival.sameLiveTitle("(3) Inbox", "(4) Inbox"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Inbox (3)", "Inbox (4)"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Inbox (3) - Mail", "Inbox (4) - Mail"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("(3) Inbox - Mail", "(4) Inbox - Mail"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Inbox - Mail", "(1) Inbox - Mail"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("[12+] Notifications", "[13+] Notifications"))
    // Dirty dots.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("• HandsController.swift — ClawdTime"), "HandsController.swift — ClawdTime")
    XCTAssertTrue(DesktopArrival.sameLiveTitle("• draft.md", "draft.md"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Notes •", "Notes"))
    // Elapsed timers and clocks at edges or in brackets/parens.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("Recording - 04:12"), "Recording")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("04:12 - FaceTime"), "FaceTime")
    XCTAssertTrue(DesktopArrival.sameLiveTitle("FaceTime 04:12", "FaceTime 04:13"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("04:12 - FaceTime", "04:13 - FaceTime"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Call 04:12", "Call 04:13"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Meet - 1:04:12", "Meet - 1:04:13"))
    // Percentages.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("Exporting (45%)"), "Exporting")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("Download 45%"), "Download")
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Download 45%", "Download 46%"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Uploading 45% - Drive", "Uploading 46% - Drive"))
    // Tab counts.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("Docs - Chrome - 4 tabs"), "Docs - Chrome")
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Docs - Chrome - 4 tabs", "Docs - Chrome - 5 tabs"))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("Safari — 1 tab", "Safari — 2 tabs"))
    // Combined dynamic decorations.
    XCTAssertTrue(DesktopArrival.sameLiveTitle("(3) • Inbox - Mail 04:12", "(4) Inbox - Mail 04:13"))
    // Genuine window changes, numbered filenames and mid-title timestamps remain distinct.
    XCTAssertFalse(DesktopArrival.sameLiveTitle("(3) Inbox - Mail", "(3) Sent - Mail"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("Budget (2026)", "Budget (2025)"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("Report (1).pdf", "Report (2).pdf"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("Report 10:00 Summary", "Report 11:00 Summary"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("Q3 45% Growth", "Q3 50% Growth"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("Notes", "Reminders"))
    // Empty collapse is refused: volatile-only titles keep their original text and never falsely match each other.
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("(3)"), "(3)")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("04:12"), "04:12")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("45%"), "45%")
    XCTAssertEqual(DesktopArrival.normalizeDynamicTitle("[12+]"), "[12+]")
    XCTAssertFalse(DesktopArrival.sameLiveTitle("(3)", "(4)"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("(3)", "45%"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("04:12", "04:13"))
    XCTAssertFalse(DesktopArrival.sameLiveTitle("(3)", ""))
    // Identical titles (including untitled sheets) remain equal.
    XCTAssertTrue(DesktopArrival.sameLiveTitle("", ""))
    XCTAssertTrue(DesktopArrival.sameLiveTitle("04:12", "04:12"))
  }
}
