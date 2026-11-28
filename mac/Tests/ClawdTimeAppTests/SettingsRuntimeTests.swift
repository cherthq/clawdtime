import Foundation
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// Every setting goes through `clawdtime settings`: the window reads its
/// JSON, sends one change at a time, and edits no file itself.
@MainActor
final class SettingsRuntimeTests: XCTestCase {
  private var runtime: FakeSettingsRuntime!
  private var desktop: FakeDesktop!
  private var opened: [URL] = []

  private func make() async throws -> SettingsModel {
    runtime = FakeSettingsRuntime()
    desktop = FakeDesktop()
    opened = []
    let folder = try temporaryFolder(self)
    let model = SettingsModel(
      runner: runtime, launcher: folder.appendingPathComponent("bin/clawdtime"), native: nil, desktop: desktop,
      about: AboutInfo(app: "0.4.0", runtime: "0.4.0", commit: nil),
      open: { [weak self] url in self?.opened.append(url); return true })
    await model.load()
    return model
  }

  private var changes: [[String]] {
    runtime.recorded.map(\.arguments).filter { $0.first == "settings" && ["set", "reset"].contains($0.dropFirst().first ?? "") }
  }

  func testItReadsEverySettingAndWhereItComesFrom() async throws {
    let model = try await make()
    let report = try XCTUnwrap(model.runtime)
    XCTAssertEqual(report.settings.count, 18)
    XCTAssertEqual(model.value("mascot.style"), .text("jet"))
    XCTAssertEqual(model.value("mascot.size"), .number(0.9))
    XCTAssertEqual(model.value("memory"), .bool(true))
    XCTAssertEqual(model.setting("reach.wait")?.max, 600)
    XCTAssertEqual(model.setting("voice.name")?.choices?.count, 13)
    XCTAssertTrue(model.isFixed("computer.browser"), "a variable of the environment holds it")
    XCTAssertFalse(model.isFixed("voice.name"))
    XCTAssertEqual(report.speed.presets.map(\.id), ["fast", "balanced", "best"])
    XCTAssertEqual(model.value("speed"), .text("balanced"))
  }

  func testAChangeGoesToTheRuntimeAndRestartsTheDesktopOnlyWhenItMust() async throws {
    let model = try await make()
    // Works at once: no restart.
    let style = await model.set("mascot.style", .text("jade"))
    XCTAssertTrue(style)
    let memory = await model.set("memory", .bool(false))
    XCTAssertTrue(memory)
    let size = await model.set("mascot.size", .number(1.25))
    XCTAssertTrue(size)
    XCTAssertEqual(desktop.restarts, 0)
    XCTAssertNil(model.restart)
    // Read when the desktop starts: it restarts while idle.
    let voice = await model.set("voice.name", .text("marin"))
    XCTAssertTrue(voice)
    XCTAssertEqual(desktop.restarts, 1)
    XCTAssertEqual(model.restart, .restarting)
    let wait = await model.set("reach.wait", .number(90))
    XCTAssertTrue(wait)
    let reset = await model.reset("vocabulary")
    XCTAssertTrue(reset)
    XCTAssertEqual(changes, [
      ["settings", "set", "mascot.style", "jade", "--json"],
      ["settings", "set", "memory", "off", "--json"],
      ["settings", "set", "mascot.size", "1.25", "--json"],
      ["settings", "set", "voice.name", "marin", "--json"],
      ["settings", "set", "reach.wait", "90", "--json"],
      ["settings", "reset", "vocabulary", "--json"],
    ])
    // Each change reads the settings again.
    XCTAssertEqual(runtime.recorded.filter { $0.arguments == ["settings", "--json"] }.count, 7)
    XCTAssertTrue(runtime.recorded.allSatisfy { $0.input == nil })
  }

  func testTheSpeedAndTheModelsAreReadAgainTogether() async throws {
    let model = try await make()
    let before = runtime.recorded.filter { $0.arguments == ["computer", "model", "--json"] }.count
    let done = await model.set("speed", .text("fast"))
    XCTAssertTrue(done)
    XCTAssertEqual(runtime.recorded.filter { $0.arguments == ["computer", "model", "--json"] }.count, before + 1)
    let chat = await model.set("model.chat", .text("anthropic/claude-opus-5-5"))
    XCTAssertTrue(chat)
    XCTAssertEqual(changes.last, ["settings", "set", "model.chat", "anthropic/claude-opus-5-5", "--json"])
  }

  func testItRefusesWhatShouldNotReachTheRuntime() async throws {
    let model = try await make()
    let before = runtime.recorded.count
    let unknown = await model.set("nothing.here", .bool(true))
    XCTAssertFalse(unknown)
    XCTAssertEqual(model.problem, SettingsModel.Text.unknownSetting)
    let key = await model.set("vocabulary", .text("Brightwave, \(madeUpKey)"))
    XCTAssertFalse(key)
    XCTAssertEqual(model.problem, SettingsModel.Text.keyAsSetting)
    let option = await model.set("vocabulary", .text("--yes"))
    XCTAssertFalse(option)
    XCTAssertEqual(model.problem, SettingsModel.Text.badText)
    let lines = await model.set("vocabulary", .text("one\ntwo"))
    XCTAssertFalse(lines)
    let choice = await model.set("computer.browser", .text("chrome"))
    XCTAssertFalse(choice)
    XCTAssertEqual(runtime.recorded.count, before, "nothing ran")
  }

  func testARefusalOfTheRuntimeShowsItsSentenceAndChangesNothing() async throws {
    let model = try await make()
    runtime.answer(["settings", "set", "model.chat", "nobody/vision", "--json"], CommandResult(status: 1, errors: [
      "The model setting names no known provider. Use one of: openai, anthropic.",
    ]))
    let done = await model.set("model.chat", .text("nobody/vision"))
    XCTAssertFalse(done)
    XCTAssertEqual(model.problem, "The model setting names no known provider. Use one of: openai, anthropic.")
    XCTAssertNil(model.pending["model.chat"], "the window shows the old value again")
    XCTAssertEqual(model.value("model.chat"), .text("gpt-4.1-mini"))
  }

  func testMemoryHistoryAndThePrivacyReport() async throws {
    let model = try await make()
    let forgot = await model.forgetMemory()
    XCTAssertTrue(forgot)
    XCTAssertEqual(model.done, "Removed 7 facts for good.")
    XCTAssertEqual(model.privacy?.items.count, 9)
    XCTAssertEqual(desktop.restarts, 0)
    let moved = await model.deleteHistory()
    XCTAssertTrue(moved)
    XCTAssertEqual(model.done, "Moved 1 file to the Trash.")
    XCTAssertEqual(desktop.restarts, 1, "the desktop forgets the chat when it starts again")
    let asked = runtime.recorded.map(\.arguments).filter { $0.contains("--yes") }
    XCTAssertEqual(asked, [["settings", "forget-memory", "--yes", "--json"], ["settings", "delete-history", "--yes", "--json"]])
    // Only the state folder and the logs open in the Finder.
    XCTAssertTrue(model.openFolder("/Users/riverchat/.local/share/clawdtime"))
    XCTAssertTrue(model.openFolder("/Users/riverchat/Library/Logs/ClawdTime"))
    XCTAssertFalse(model.openFolder("/Users/riverchat/.local/share/clawdtime/computer/keys.json"))
    XCTAssertFalse(model.openFolder("/Applications"))
    XCTAssertEqual(opened.map(\.path), ["/Users/riverchat/.local/share/clawdtime", "/Users/riverchat/Library/Logs/ClawdTime"])
  }

  func testTheUpdateCheckOpensOnlyAnHttpsPage() async throws {
    let model = try await make()
    XCTAssertNil(model.update, "no network until the person asks")
    let checked = await model.checkUpdate()
    XCTAssertTrue(checked)
    XCTAssertEqual(model.update?.latest, "0.5.0")
    XCTAssertTrue(model.openUpdatePage())
    XCTAssertEqual(opened.last?.absoluteString, "https://github.com/cherthq/clawdtime/releases/latest")
    runtime.answer(["settings", "update", "--json"], SettingsFixtures.update(newer: true, page: "file:///tmp/release"))
    await model.checkUpdate()
    XCTAssertNil(model.updatePage)
    XCTAssertFalse(model.openUpdatePage())
  }

  func testUnpairEndsThePhoneConnectionFirst() async throws {
    let model = try await make()
    await model.readPhone()
    XCTAssertEqual(model.phone?.pairing, .paired)
    XCTAssertEqual(model.phone?.owner?.ending, "ends in 00")
    desktop.connectionStatus = .running
    runtime.answer(["settings", "phone", "--json"], SettingsFixtures.phone(paired: false))
    await model.unpairPhone()
    XCTAssertEqual(desktop.drops, 1)
    XCTAssertEqual(model.done, "This Mac is unpaired. The pairing file is in the Trash.")
    XCTAssertEqual(model.phone?.pairing, PhoneReport.Pairing.none)
    let order = runtime.recorded.map(\.arguments).filter { $0.starts(with: ["settings", "phone"]) }
    XCTAssertEqual(order.last, ["settings", "phone", "--json"])
    XCTAssertTrue(order.contains(["settings", "phone", "unpair", "--yes", "--json"]))
    // With the connection off, nothing is stopped.
    await model.unpairPhone()
    XCTAssertEqual(desktop.drops, 1)
  }

  func testValuesBecomeArgumentsAsTheRuntimeTakesThem() {
    XCTAssertEqual(SettingValue.bool(true).argument, "on")
    XCTAssertEqual(SettingValue.bool(false).argument, "off")
    XCTAssertEqual(SettingValue.number(45).argument, "45")
    XCTAssertEqual(SettingValue.number(0.7).argument, "0.7")
    XCTAssertEqual(SettingValue.number(1.25).argument, "1.25")
    XCTAssertEqual(SettingValue.number(0.5).argument, "0.5")
    XCTAssertEqual(SettingValue.text("gpt-5.4").argument, "gpt-5.4")
  }

  func testTheWordsOfThePages() {
    XCTAssertEqual(SettingsWords.seconds(0), "Call at once")
    XCTAssertEqual(SettingsWords.seconds(45), "45 seconds")
    XCTAssertEqual(SettingsWords.seconds(60), "1 minute")
    XCTAssertEqual(SettingsWords.seconds(90), "1.5 minutes")
    XCTAssertEqual(SettingsWords.seconds(600), "10 minutes")
    XCTAssertEqual(SettingsWords.preset("balanced"), "Balanced")
    XCTAssertEqual(SettingsWords.preset("custom"), "Custom")
    XCTAssertEqual(SettingsWords.tilde(NSHomeDirectory() + "/.local/share/clawdtime"), "~/.local/share/clawdtime")
  }
}

final class SettingsCatalogTests: XCTestCase {
  func testTheSearchFindsARowByAnyOfItsWords() {
    XCTAssertEqual(SettingsCatalog.search("voice").map(\.anchor), ["voiceReplies", "voice", "voiceSpeed", "vocabulary"])
    XCTAssertEqual(SettingsCatalog.search("unpair").map(\.anchor), ["pairing"])
    XCTAssertEqual(SettingsCatalog.search("Screen rec").map(\.anchor), ["permissions"])
    XCTAssertEqual(SettingsCatalog.search("forget mem").map(\.anchor), ["forget"])
    XCTAssertTrue(SettingsCatalog.search("hotkey").map(\.anchor).contains("shortcuts"))
    XCTAssertTrue(SettingsCatalog.search("UPDATE").map(\.anchor).contains("update"))
    XCTAssertEqual(SettingsCatalog.search("   "), [])
    XCTAssertEqual(SettingsCatalog.search("zebra"), [])
  }

  func testEverySectionHasRowsAndEveryRowIsOnce() {
    for section in SettingsSection.allCases {
      XCTAssertFalse(SettingsCatalog.entries.filter { $0.section == section }.isEmpty, section.rawValue)
    }
    let anchors = SettingsCatalog.entries.map(\.anchor)
    XCTAssertEqual(Set(anchors).count, anchors.count)
    XCTAssertEqual(SettingsSection.allCases.map(\.title), ["General", "Assistant", "Models", "Computer use", "Permissions", "Phone", "Privacy", "About"])
  }
}
