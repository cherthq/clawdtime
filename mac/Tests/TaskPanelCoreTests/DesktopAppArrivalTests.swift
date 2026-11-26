import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// `open_app` for an app named alone: the process in front decides, with the bundle identifier that the name stood
/// for. A sheet, a late window or a window on another desktop is no reason to leave the arrival unknown, and a wrong
/// app or a window alone is never an arrival.
final class DesktopAppArrivalTests: XCTestCase {
  private let named = "com.example.stonepad"
  private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
  private let stonepad = DesktopArrival.RunningApp(pid: 501, bundleID: "com.example.stonepad")
  private let finder = DesktopArrival.RunningApp(pid: 300, bundleID: "com.apple.finder")
  /// A sheet hangs from the top of a window that does not show yet: "Syncing your notes".
  private func sheet(_ pid: Int = 501) -> DesktopArrival.OverlayWindow {
    .init(pid: pid, layer: 0, frame: CGRect(x: 516, y: 120, width: 480, height: 220))
  }
  private func window(_ pid: Int, layer: Int = 0) -> DesktopArrival.OverlayWindow {
    .init(pid: pid, layer: layer, frame: CGRect(x: 200, y: 100, width: 900, height: 600))
  }
  /// The menu bar and the Dock of the system: above the level of an app's windows, never its window.
  private let menuBar = DesktopArrival.OverlayWindow(pid: 90, layer: 24, frame: CGRect(x: 0, y: 0, width: 1512, height: 33))
  private let dock = DesktopArrival.OverlayWindow(pid: 91, layer: 20, frame: CGRect(x: 300, y: 900, width: 900, height: 80))

  private func sighting(front: DesktopArrival.RunningApp?, frontClaims: Bool? = nil, apps: [DesktopArrival.RunningApp]? = nil,
                        claims: [Int: Bool] = [:], windows: [DesktopArrival.OverlayWindow] = []) -> DesktopArrival.AppSighting {
    .init(front: front, frontClaims: frontClaims, apps: apps ?? [stonepad], claims: claims, windows: windows, display: display)
  }

  func testAnAppWithOnlyASheetHasArrived() {
    // macOS lists the app in front, and all it shows is a sheet: no standard window, no title.
    let listed = sighting(front: stonepad, windows: [menuBar, sheet(), window(300), dock])
    XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: listed), .shown(pid: 501))
    var wait = DesktopAppArrivalWait(at: 100)
    XCTAssertEqual(wait.sample(DesktopArrival.appArrival(resolved: named, sighting: listed), at: 100.2), .arrived(pid: 501, shown: true))
    // A welcome sheet in a floating panel counts the same way.
    let panel = sighting(front: stonepad, windows: [window(501, layer: 3)])
    XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: panel), .shown(pid: 501))
    // macOS still lists the app before it, which answers that it is no longer active. The named app answers that it
    // is, and its sheet is the top window on the screen.
    let lagging = sighting(front: finder, frontClaims: false, claims: [501: true], windows: [menuBar, sheet(), window(300), dock])
    XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: lagging), .shown(pid: 501))
    // The case of the letters of the bundle identifier does not matter, as everywhere.
    XCTAssertEqual(DesktopArrival.appArrival(resolved: "COM.EXAMPLE.STONEPAD", sighting: listed), .shown(pid: 501))
  }

  func testAWindowThatAppearsAfterOneSecondIsInThePictureOfTheArrival() {
    var wait = DesktopAppArrivalWait(at: 100)
    let front = sighting(front: stonepad, windows: [window(300)])
    let opened = sighting(front: stonepad, windows: [window(501), window(300)])
    XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: front), .inFront(pid: 501))
    // In front with no window yet: the wait gives the window its time.
    XCTAssertEqual(wait.sample(DesktopArrival.appArrival(resolved: named, sighting: front), at: 100.1), .waiting)
    XCTAssertEqual(wait.sample(DesktopArrival.appArrival(resolved: named, sighting: front), at: 100.6), .waiting)
    // One second later the window opens: the arrival comes with it.
    XCTAssertEqual(wait.sample(DesktopArrival.appArrival(resolved: named, sighting: opened), at: 101.1), .arrived(pid: 501, shown: true))
  }

  func testAnAppInFrontWithNoWindowStillArrivesAfterTheGrace() {
    // Its window is on another desktop, or it shows none: in front is in front, as before.
    var wait = DesktopAppArrivalWait(at: 100)
    let front = DesktopArrival.appArrival(resolved: named, sighting: sighting(front: stonepad))
    XCTAssertEqual(DesktopAppArrivalWait.windowGrace, 1.5)
    XCTAssertEqual(wait.sample(front, at: 100.5), .waiting)
    XCTAssertEqual(wait.sample(front, at: 101.9), .waiting)
    XCTAssertEqual(wait.sample(front, at: 102), .arrived(pid: 501, shown: false))
    // In front only at the very end of the wait: in front all the same, with no more time.
    var late = DesktopAppArrivalWait(at: 100)
    XCTAssertEqual(late.sample(.absent, at: 105.5), .waiting)
    XCTAssertEqual(late.sample(front, at: 106), .arrived(pid: 501, shown: false))
    // Another app in between starts the grace again.
    var broken = DesktopAppArrivalWait(at: 100)
    XCTAssertEqual(broken.sample(front, at: 100), .waiting)
    XCTAssertEqual(broken.sample(.absent, at: 101), .waiting)
    XCTAssertEqual(broken.sample(front, at: 102), .waiting)
    XCTAssertEqual(broken.sample(front, at: 103.5), .arrived(pid: 501, shown: false))
  }

  func testAWrongAppStaysUnknown() {
    let helper = DesktopArrival.RunningApp(pid: 777, bundleID: "com.example.stonepad.helper")
    let stray = DesktopArrival.RunningApp(pid: 888, bundleID: "com.example.stonepad")
    let other = DesktopArrival.RunningApp(pid: 502, bundleID: "com.example.stonepad")
    let cases: [(String, DesktopArrival.AppSighting)] = [
      // Another app is in front, and the named app's window shows behind it.
      ("another app in front", sighting(front: finder, frontClaims: true, windows: [window(300), window(501)])),
      ("another app in front that gives no answer", sighting(front: finder, claims: [501: false], windows: [window(300), window(501)])),
      // An app with a name like it, of another bundle identifier, with its sheet on top.
      ("a helper with another bundle identifier", sighting(front: helper, frontClaims: false, apps: [stonepad, helper], windows: [sheet(777)])),
      // A process with the bundle identifier that macOS does not list as the named app: the process decides.
      ("a process that is not one of the app's", sighting(front: stray, windows: [window(888)])),
      ("nothing in front, nothing answers", sighting(front: nil, windows: [window(501)])),
      // The named app answers that it is active, but the app that macOS lists says so too, or says nothing.
      ("both answer that they are active", sighting(front: finder, frontClaims: true, claims: [501: true], windows: [sheet(), window(300)])),
      ("the listed app gives no answer", sighting(front: finder, claims: [501: true], windows: [sheet(), window(300)])),
      // The named app answers that it is active, but the top window on the screen is another app's.
      ("its window is not the top one", sighting(front: finder, frontClaims: false, claims: [501: true], windows: [window(300), window(501)])),
      // An answer alone, with no window or sheet of it on the screen.
      ("an answer with no window", sighting(front: finder, frontClaims: false, claims: [501: true], windows: [window(300)])),
      ("a window that does not show", sighting(front: finder, frontClaims: false, claims: [501: true],
        windows: [.init(pid: 501, layer: 0, frame: CGRect(x: 200, y: 100, width: 900, height: 600), alpha: 0)])),
      ("a window off the screen", sighting(front: finder, frontClaims: false, claims: [501: true],
        windows: [.init(pid: 501, layer: 0, frame: CGRect(x: 4000, y: 100, width: 900, height: 600))])),
      // Two processes of the app answer that they are active: which one is in front is not known.
      ("two processes answer", sighting(front: finder, frontClaims: false, apps: [stonepad, other], claims: [501: true, 502: true],
        windows: [sheet(), window(502)])),
    ]
    for (label, seen) in cases {
      XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: seen), .absent, label)
      var wait = DesktopAppArrivalWait(at: 100)
      let arrival = DesktopArrival.appArrival(resolved: named, sighting: seen)
      for at in stride(from: 100.0, to: 106, by: 0.5) { XCTAssertEqual(wait.sample(arrival, at: at), .waiting, label) }
      XCTAssertEqual(wait.sample(arrival, at: 106), .expired, label)
    }
    // The menu bar or the Dock of the system is no window of the app in front: it is in front with none.
    XCTAssertEqual(DesktopArrival.appArrival(resolved: named, sighting: sighting(front: stonepad, windows: [menuBar, dock, window(300)])),
                   .inFront(pid: 501))
    // What fails after the open request went out is unknown, never a refusal that may be sent again.
    XCTAssertEqual(DesktopEffectOutcome.failure(.targetNotVisible, dispatched: true), .transitionUnknown)
  }

  func testTheWaitKeepsTheLimitAndAClockThatMakesNoSenseEndsIt() {
    var wait = DesktopAppArrivalWait(at: 100)
    XCTAssertFalse(wait.over(at: 105.99))
    XCTAssertTrue(wait.over(at: 100 + DesktopAppWait.limit))
    for at in [Double.nan, .infinity, 99] {
      XCTAssertEqual(wait.sample(.shown(pid: 501), at: at), .expired)
      XCTAssertEqual(wait.sample(.inFront(pid: 501), at: at), .expired)
      XCTAssertEqual(wait.sample(.absent, at: at), .expired)
    }
  }
}
