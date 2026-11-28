import AppKit
import SwiftUI
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// Every section of the Settings window, drawn off screen in light and dark
/// mode over a made-up runtime: no window opens. With CLAWDTIME_APP_SHOTS set
/// to a folder, each picture is written there as settings-NAME-light.png and
/// settings-NAME-dark.png, for a person to look at. A long section is drawn
/// whole, taller than the window.
@MainActor
final class SettingsScreenshotTests: XCTestCase {
  private struct Shot {
    var name: String
    var section: SettingsSection
    var query = ""
    var preview = SettingsPreview()
    var height: CGFloat = SettingsRootView.size.height
    var prepare: (FakeSettingsRuntime, FakeDesktop, SettingsModel) async -> Void = { _, _, _ in }
  }

  /// The planner of the Balanced preset, so that the Models pictures agree with themselves.
  private static let solModel = #"{"version":1,"ok":true,"reason":null,"problem":null,"provider":"openai","providerName":"OpenAI","model":"gpt-6.2-sol","name":"gpt-6.2-sol","from":"store","variable":null,"baseUrl":null,"key":{"source":"store","variable":null}}"#
  private static let balanced: (FakeSettingsRuntime, FakeDesktop, SettingsModel) async -> Void = { runtime, _, model in
    runtime.answer(["computer", "model", "--json"], solModel)
    await model.readModel()
  }

  private static let shots: [Shot] = [
    Shot(name: "general", section: .general, height: 900),
    Shot(name: "search", section: .general, query: "voice"),
    Shot(name: "assistant", section: .assistant, height: 860),
    Shot(name: "assistant-forget", section: .assistant, preview: SettingsPreview(confirming: "forget"), height: 900),
    Shot(name: "models", section: .models, height: 900, prepare: balanced),
    Shot(name: "models-advanced", section: .models, preview: SettingsPreview(advanced: true), height: 1420, prepare: balanced),
    Shot(name: "models-key-entry", section: .models, preview: SettingsPreview(editingKey: "openai"), height: 960),
    Shot(name: "models-custom", section: .models, height: 760, prepare: { runtime, _, model in
      runtime.answer(["settings", "--json"], SettingsFixtures.settings(speed: "custom"))
      await model.readSettings()
    }),
    Shot(name: "models-saved", section: .models, height: 760, prepare: { runtime, _, model in
      runtime.answer(["computer", "doctor", "--json"], SettingsFixtures.doctor(admission: "blocked", session: "active"))
      await model.set("speed", .text("fast"))
    }),
    Shot(name: "computer", section: .computer),
    Shot(name: "computer-never", section: .computer, prepare: { runtime, _, model in
      runtime.answer(["settings", "--json"], SettingsFixtures.settings(ask: "never", browserFrom: "store"))
      await model.readSettings()
    }),
    Shot(name: "permissions", section: .permissions),
    Shot(name: "phone", section: .phone, height: 760, prepare: { _, _, model in await model.readPhone() }),
    Shot(name: "phone-unpair", section: .phone, preview: SettingsPreview(confirming: "unpair"), height: 800, prepare: { _, _, model in
      await model.readPhone()
    }),
    Shot(name: "phone-not-paired", section: .phone, height: 720, prepare: { runtime, _, model in
      runtime.answer(["settings", "phone", "--json"], SettingsFixtures.phone(paired: false))
      await model.readPhone()
    }),
    Shot(name: "privacy", section: .privacy, height: 900, prepare: { _, _, model in await model.readPrivacy() }),
    Shot(name: "privacy-delete", section: .privacy, preview: SettingsPreview(confirming: "history"), height: 940, prepare: { _, _, model in
      await model.readPrivacy()
    }),
    Shot(name: "about", section: .about),
    Shot(name: "about-update", section: .about, prepare: { _, _, model in await model.checkUpdate() }),
    Shot(name: "problem", section: .assistant, prepare: { runtime, _, model in
      runtime.answer(["settings", "set", "vocabulary", "Brightwave", "--json"], CommandResult(status: 1, errors: [
        "settings.json is not valid, so it is not used and not changed. Look at it, and move it away to start again.",
      ]))
      await model.set("vocabulary", .text("Brightwave"))
    }),
  ]

  /// The view drawn by AppKit into a bitmap, with no window.
  private func picture(_ view: some View, size: CGSize, dark: Bool) throws -> Data {
    let appearance = try XCTUnwrap(NSAppearance(named: dark ? .darkAqua : .aqua))
    var data: Data?
    appearance.performAsCurrentDrawingAppearance {
      let hosting = NSHostingView(rootView: AnyView(view.environment(\.colorScheme, dark ? .dark : .light)))
      hosting.appearance = appearance
      hosting.frame = NSRect(origin: .zero, size: size)
      hosting.layoutSubtreeIfNeeded()
      guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return }
      hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
      data = bitmap.representation(using: .png, properties: [:])
    }
    return try XCTUnwrap(data)
  }

  func testEverySettingsSectionDrawsInLightAndDark() async throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_APP_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    let native = try temporaryFolder(self).appendingPathComponent("native", isDirectory: true)
    try writeScript(native.appendingPathComponent("ClawdTimeTaskPanel"), "exit 1\n")
    try writeScript(native.appendingPathComponent("ClawdTimeTaskCapture"), "exit 1\n")
    var drawn: Set<SettingsSection> = []
    for shot in Self.shots {
      let runtime = FakeSettingsRuntime()
      let desktop = FakeDesktop()
      let model = SettingsModel(
        runner: runtime, launcher: URL(fileURLWithPath: "/nonexistent/clawdtime"), native: native, desktop: desktop,
        about: AboutInfo(app: "0.4.0", runtime: "0.4.0", commit: "91961f05185c1f011b0afa99a0552cbaf27fa19c"),
        open: { _ in true })
      await model.load()
      await shot.prepare(runtime, desktop, model)
      let setup = SetupCoordinator(makeEngine: { _ in ScriptedEngine() }, owner: RecordingOwner(), open: { _ in false }, answerDelay: 0)
      let owner = ProcessOwner(launcher: URL(fileURLWithPath: "/nonexistent/clawdtime"))
      let uninstall = UninstallModel(runner: runtime, launcher: nil, loginItem: FakeLoginItem(), stopApp: { $0() },
                                     forgetSetup: {}, trashApp: {}, quit: {})
      let size = CGSize(width: SettingsRootView.size.width, height: shot.height)
      let view = SettingsRootView(model: model, owner: owner, setup: setup, loginItem: FakeLoginItem(), uninstall: uninstall,
                                  section: shot.section, query: shot.query, preview: shot.preview, height: size.height)
      for dark in [false, true] {
        let png = try picture(view, size: size, dark: dark)
        XCTAssertGreaterThan(png.count, 10_000, shot.name)
        try folder.map { try png.write(to: $0.appendingPathComponent("settings-\(shot.name)-\(dark ? "dark" : "light").png")) }
      }
      drawn.insert(shot.section)
      // No key reached an argument in any picture's run.
      XCTAssertFalse(runtime.recorded.contains { $0.arguments.joined().contains(madeUpKey) }, shot.name)
    }
    XCTAssertEqual(drawn, Set(SettingsSection.allCases), "every section has a picture")
  }
}
