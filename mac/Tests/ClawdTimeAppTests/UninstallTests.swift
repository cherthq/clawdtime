import AppKit
import SwiftUI
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// `clawdtime uninstall --plan --json` of a made-up Mac.
enum UninstallFixtures {
  static let plan = #"""
  {"version":1,"unpair":{"origin":"https://coordinator.example"},"pairingProblem":null,"move":[
  {"path":"/Users/riverchat/Library/Application Support/ClawdTime","display":"~/Library/Application Support/ClawdTime","what":"the runtime","settings":false},
  {"path":"/Users/riverchat/.local/bin/clawdtime","display":"~/.local/bin/clawdtime","what":"the clawdtime command","settings":false},
  {"path":"/Users/riverchat/.local/share/clawdtime","display":"~/.local/share/clawdtime","what":"settings, keys, chats and receipts","settings":true},
  {"path":"/Users/riverchat/.config/clawdtime","display":"~/.config/clawdtime","what":"the pairing and its receipts","settings":true},
  {"path":"/Users/riverchat/.config/clawdtime/shared/connection.json","display":"~/.config/clawdtime/shared/connection.json","what":"the pairing of this Mac, once it is unpaired","settings":false,"afterUnpair":true}],
  "keep":[{"path":"/Users/riverchat/clawdtime-work","display":"~/clawdtime-work","why":"your project folder"}],
  "notes":[],"blocked":null}
  """#.replacingOccurrences(of: "\n", with: "")

  static let output = """
  clawdtime uninstall does this:
    1. Stops the shared connection, the desktop service and the panel, when they run.

  Stopped the desktop service.
  Unpaired this Mac from the shared number at https://coordinator.example.
  ClawdTime is uninstalled.
  """
}

@MainActor
final class UninstallTests: XCTestCase {
  private var runtime: FakeSettingsRuntime!
  private var login: FakeLoginItem!
  private var events: [String] = []

  private func make(trash: @escaping () throws -> Void = {}) -> UninstallModel {
    runtime = FakeSettingsRuntime()
    runtime.answer(UninstallCommand.plan, UninstallFixtures.plan)
    login = FakeLoginItem()
    login.isEnabled = true
    events = []
    return UninstallModel(
      runner: runtime, launcher: URL(fileURLWithPath: "/Applications/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime"),
      loginItem: login,
      stopApp: { [weak self] done in self?.events.append("stop"); done() },
      forgetSetup: { [weak self] in self?.events.append("forget") },
      trashApp: { [weak self] in self?.events.append("trash"); try trash() },
      quit: { [weak self] in self?.events.append("quit") })
  }

  func testTheCommandsOfTheSheet() {
    XCTAssertEqual(UninstallCommand.plan, ["uninstall", "--plan", "--json"])
    XCTAssertEqual(UninstallCommand.arguments(keepSettings: false), ["uninstall", "--yes"])
    XCTAssertEqual(UninstallCommand.arguments(keepSettings: true), ["uninstall", "--yes", "--keep-settings"])
  }

  func testTheSheetListsWhatTheRuntimeWillMove() async throws {
    let model = make()
    await model.load()
    XCTAssertEqual(model.phase, .ready)
    let plan = try XCTUnwrap(model.plan)
    XCTAssertEqual(plan.unpair?.origin, "https://coordinator.example")
    XCTAssertEqual(plan.moves(keepSettings: false).map(\.display), [
      "~/Library/Application Support/ClawdTime", "~/.local/bin/clawdtime", "~/.local/share/clawdtime", "~/.config/clawdtime",
    ])
    // With the box on, the settings stay and the revoked pairing alone goes.
    XCTAssertEqual(plan.moves(keepSettings: true).map(\.display), [
      "~/Library/Application Support/ClawdTime", "~/.local/bin/clawdtime", "~/.config/clawdtime/shared/connection.json",
    ])
    XCTAssertEqual(plan.kept(keepSettings: true).map(\.display), [
      "~/clawdtime-work", "~/.local/share/clawdtime", "~/.config/clawdtime",
    ])
    XCTAssertEqual(runtime.recorded.map(\.arguments), [["uninstall", "--plan", "--json"]])
    XCTAssertTrue(events.isEmpty, "reading the plan changes nothing")
  }

  func testUninstallStopsTheAppFirstThenRunsTheBundledCommand() async {
    let model = make()
    runtime.answer(UninstallCommand.arguments(keepSettings: true), CommandResult(status: 0, output: Data(UninstallFixtures.output.utf8)))
    await model.load()
    model.keepSettings = true
    await model.uninstall()
    XCTAssertEqual(events, ["stop"], "settings kept: setup stays done")
    XCTAssertEqual(runtime.recorded.last?.arguments, ["uninstall", "--yes", "--keep-settings"])
    XCTAssertEqual(runtime.recorded.last?.executable, "clawdtime")
    XCTAssertNil(runtime.recorded.last?.input, "the command reads nothing")
  }

  func testSuccessShowsTheResultRemovesTheLoginItemThenTrashesTheAppAndQuits() async {
    let model = make()
    runtime.answer(UninstallCommand.arguments(keepSettings: false), CommandResult(status: 0, output: Data(UninstallFixtures.output.utf8)))
    await model.load()
    await model.uninstall()
    guard case .finished(let text) = model.phase else { return XCTFail("\(model.phase)") }
    XCTAssertTrue(text.hasPrefix("Stopped the desktop service."), text)
    XCTAssertFalse(text.contains("does this"), "the plan is in the sheet already")
    XCTAssertEqual(login.changes, [false])
    XCTAssertEqual(events, ["stop", "forget"])
    model.finish()
    XCTAssertEqual(events, ["stop", "forget", "trash", "quit"])
  }

  func testAFailedUninstallKeepsTheAppAndItsLoginItem() async {
    let model = make()
    runtime.answer(UninstallCommand.arguments(keepSettings: false), CommandResult(
      status: 1, output: Data("\nThe desktop service did not stop. Nothing was unpaired or moved.\n".utf8)))
    await model.load()
    await model.uninstall()
    guard case .failed(let text) = model.phase else { return XCTFail("\(model.phase)") }
    XCTAssertTrue(text.contains("Nothing was unpaired or moved."), text)
    XCTAssertEqual(login.changes, [])
    XCTAssertEqual(events, ["stop"])
  }

  func testARefusalBeforeThePlanIsShownWhole() async {
    let model = make()
    runtime.answer(UninstallCommand.arguments(keepSettings: false), CommandResult(
      status: 1, output: Data("An install runs now (process 4242). Wait for it to end, then run this again. Nothing changed.\n".utf8)))
    await model.load()
    await model.uninstall()
    XCTAssertEqual(model.phase, .failed("An install runs now (process 4242). Wait for it to end, then run this again. Nothing changed."))
  }

  func testARuntimeThatDoesNotStart() async {
    let model = make()
    runtime.answer(UninstallCommand.arguments(keepSettings: false), CommandResult.notStarted)
    await model.load()
    await model.uninstall()
    XCTAssertEqual(model.phase, .failed(UninstallModel.Text.notStarted))
    XCTAssertEqual(login.changes, [])
  }

  func testAPlanThatCannotBeRead() async {
    let model = make()
    runtime.answer(UninstallCommand.plan, "not json")
    await model.load()
    XCTAssertEqual(model.phase, .unavailable(UninstallModel.Text.unreadable))
    await model.uninstall()
    XCTAssertEqual(runtime.recorded.count, 1, "no plan, no uninstall")
  }

  func testAnAppThatCannotBeMovedSaysSoAndStillQuits() async {
    struct Refused: Error {}
    let model = make(trash: { throw Refused() })
    runtime.answer(UninstallCommand.arguments(keepSettings: false), CommandResult(status: 0, output: Data(UninstallFixtures.output.utf8)))
    await model.load()
    await model.uninstall()
    model.finish()
    XCTAssertEqual(model.phase, .appNotMoved(UninstallModel.Text.appNotMoved))
    XCTAssertEqual(events.suffix(1), ["trash"])
    model.finish()
    XCTAssertEqual(events.suffix(1), ["quit"])
  }

  /// Each step drawn off screen: no window opens. With CLAWDTIME_APP_SHOTS
  /// set to a folder, each picture is written there for a person to look at.
  func testTheSheetDrawsEachStepOffScreen() async throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_APP_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    let model = make()
    await model.load()
    let steps: [(String, UninstallModel.Phase)] = [
      ("loading", .loading), ("ready", .ready), ("running", .running),
      ("finished", .finished(UninstallCommand.result(Data(UninstallFixtures.output.utf8)))),
      ("failed", .failed("The desktop service did not stop. Nothing was unpaired or moved.")),
      ("app-not-moved", .appNotMoved(UninstallModel.Text.appNotMoved)),
    ]
    for (name, phase) in steps {
      model.show(phase)
      let view = NSHostingView(rootView: UninstallSheet(model: model, cancel: {}))
      view.frame = NSRect(origin: .zero, size: UninstallSheet.size)
      view.layoutSubtreeIfNeeded()
      XCTAssertGreaterThan(view.fittingSize.height, 100, name)
      guard let folder, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      try bitmap.representation(using: .png, properties: [:])?.write(to: folder.appendingPathComponent("uninstall-\(name).png"))
    }
  }
}
