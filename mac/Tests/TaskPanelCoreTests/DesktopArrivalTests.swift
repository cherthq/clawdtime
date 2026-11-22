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
  }
}
