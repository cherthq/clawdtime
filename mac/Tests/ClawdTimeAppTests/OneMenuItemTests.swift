import Darwin
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// One ClawdTime item in the menu bar: the app's own until the panel it runs
/// offers Settings and Stop, and the app's own again when that panel is gone.
@MainActor
final class OneMenuItemTests: XCTestCase {
  func testTheAppShowsItsOwnItemUnlessSetupIsDoneAndItsDesktopRunsWithThePanel() {
    // Setup done, the desktop runs, its panel is open and offers the app's rows: the panel's item is the only one.
    XCTAssertFalse(OwnStatusItem.shown(setupDone: true, desktop: .running, panelOpen: true, panelHasAppMenu: true))
    // Every other case keeps the app's own item, so Open, Settings and Stop are always one click away.
    let statuses: [OwnedStatus] = [.off, .starting, .running, .stopping, .ended("The desktop stopped.")]
    for setupDone in [false, true] {
      for desktop in statuses {
        for panelOpen in [false, true] {
          for panelHasAppMenu in [false, true] {
            let alone = setupDone && desktop == .running && panelOpen && panelHasAppMenu
            XCTAssertEqual(OwnStatusItem.shown(setupDone: setupDone, desktop: desktop, panelOpen: panelOpen, panelHasAppMenu: panelHasAppMenu), !alone,
                           "setup done \(setupDone), desktop \(desktop), panel open \(panelOpen), app rows \(panelHasAppMenu)")
          }
        }
      }
    }
  }

  func testTheAppAnswersOnlyItsThreeLinks() {
    XCTAssertEqual(AppLink.scheme, "clawdtime")
    XCTAssertEqual(AppLink(url: URL(string: "clawdtime://settings")!), .settings)
    XCTAssertEqual(AppLink(url: URL(string: "clawdtime://open")!), .open)
    XCTAssertEqual(AppLink(url: URL(string: "clawdtime://stop")!), .stop)
    XCTAssertEqual(AppLink(url: URL(string: "ClawdTime://Settings/")!), .settings, "the scheme and the name ignore case")
    for text in ["clawdtime://start", "clawdtime://settings?model=x", "clawdtime://stop#now", "clawdtime://open/setup", "clawdtime://user@stop",
                 "clawdtime://stop:80", "clawdtime:stop", "clawdtime://", "https://settings", "file:///Applications/ClawdTime.app", "clawdtimes://stop"] {
      XCTAssertNil(AppLink(url: URL(string: text)!), text)
    }
    let delivered = [URL(string: "clawdtime://stop")!, URL(string: "clawdtime://start")!, URL(string: "clawdtime://settings")!]
    XCTAssertEqual(AppLink.links(in: delivered), [.stop, .settings], "an unknown link does nothing")
  }

  func testLinksThatComeBeforeTheAppFinishedLaunchingWaitForIt() {
    let defaults = UserDefaults(suiteName: "ClawdTimeAppTests-\(UUID().uuidString)")!
    let app = AppDelegate(runtimeOverride: nil, defaults: defaults, loginItem: FakeLoginItem())
    app.application(NSApplication.shared, open: [URL(string: "clawdtime://settings")!, URL(string: "clawdtime://start")!])
    XCTAssertEqual(app.waitingLinks, [.settings])
  }

  func testTheDesktopTellsThePanelWhichAppRunsItAndTheConnectionHearsNothing() throws {
    let bundle = URL(fileURLWithPath: "/Applications/Example Folder/ClawdTime.app", isDirectory: true)
    XCTAssertEqual(ManagedCommand.desktop(app: bundle).environment, ["CLAWDTIME_APP_BUNDLE": "/Applications/Example Folder/ClawdTime.app"])
    XCTAssertEqual(ManagedCommand.desktop(app: bundle).arguments, ManagedCommand.desktop.arguments)
    XCTAssertEqual(ManagedCommand.desktop(app: nil), ManagedCommand.desktop, "outside a bundle the app says nothing")
    XCTAssertEqual(ManagedCommand.desktop.environment, [:])
    XCTAssertEqual(ManagedCommand.connection.environment, [:])

    let folder = try temporaryFolder(self)
    let record = folder.path.replacingOccurrences(of: "'", with: "'\\''")
    let launcher = try writeScript(folder.appendingPathComponent("runtime/bin/clawdtime"), """
    record='\(record)'
    trap 'exit 0' TERM
    case "$1" in
      start)
        printf '%s' "${CLAWDTIME_APP_BUNDLE-none}" > "$record/desktop-app"
        echo '{"type":"ready"}'
        while [ ! -f "$record/close-panel" ]; do sleep 0.05; done
        echo '{"type":"panel","state":"closed"}'
        while :; do sleep 1; done ;;
      shared)
        printf '%s' "${CLAWDTIME_APP_BUNDLE-none}" > "$record/connection-app"
        while :; do sleep 1; done ;;
    esac
    """)
    let owner = ProcessOwner(launcher: launcher, environment: childEnvironment(["PATH": "/usr/bin:/bin"]), desktop: .desktop(app: bundle), grace: 3)
    XCTAssertFalse(owner.panelOpen)
    owner.start(connection: true)
    XCTAssertFalse(owner.panelOpen, "no panel before the ready line")
    waitUntil { owner.connection == .running && FileManager.default.fileExists(atPath: folder.appendingPathComponent("connection-app").path) }
    XCTAssertTrue(owner.panelOpen, "the ready line comes after the panel started")
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("desktop-app"), encoding: .utf8), bundle.path)
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("connection-app"), encoding: .utf8), "none")

    // The person quits the panel: the desktop and its work keep running, and the app shows its own item again.
    FileManager.default.createFile(atPath: folder.appendingPathComponent("close-panel").path, contents: nil)
    waitUntil { !owner.panelOpen }
    XCTAssertFalse(owner.panelOpen)
    XCTAssertEqual(owner.desktop, .running)
    XCTAssertEqual(owner.connection, .running)

    var stopped = false
    owner.stop { stopped = true }
    waitUntil { stopped }
    XCTAssertFalse(owner.panelOpen)
    XCTAssertEqual(owner.desktop, .off)
  }

  func testThePanelLineIsReadOnlyAsItself() {
    XCTAssertTrue(ManagedCommand.isPanelClosedLine(#"{"type":"panel","state":"closed"}"#))
    XCTAssertFalse(ManagedCommand.isPanelClosedLine(#"{"type":"panel","state":"open"}"#))
    XCTAssertFalse(ManagedCommand.isPanelClosedLine(#"{"type":"ready"}"#))
    XCTAssertFalse(ManagedCommand.isPanelClosedLine("The panel closed."))
    XCTAssertFalse(ManagedCommand.isReadyLine(#"{"type":"panel","state":"closed"}"#))
  }

  private func waitUntil(_ timeout: TimeInterval = 10, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  }
}
