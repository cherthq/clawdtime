import AppKit
import SwiftUI
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// Every page of the Settings window, drawn off screen in light and dark
/// mode over a made-up runtime: no window opens. With CLAWDTIME_APP_SHOTS set
/// to a folder, each picture is written there as settings-NAME-light.png and
/// settings-NAME-dark.png, for a person to look at.
@MainActor
final class SettingsScreenshotTests: XCTestCase {
  private struct Shot {
    var name: String
    var tab: SettingsTab
    var editing: String? = nil
    var removing: String? = nil
    var prepare: (FakeSettingsRuntime, FakeDesktop, SettingsModel) async -> Void = { _, _, _ in }
  }

  private static let customModel = #"{"version":1,"ok":true,"reason":null,"problem":null,"provider":"custom","providerName":"a custom service","model":"local-vision","name":"custom/local-vision","from":"store","variable":null,"baseUrl":"http://127.0.0.1:8080/v1","key":{"source":null,"variable":null}}"#

  private static let shots: [Shot] = [
    Shot(name: "keys", tab: .keys),
    Shot(name: "key-entry", tab: .keys, editing: "openai"),
    Shot(name: "key-remove", tab: .keys, removing: "anthropic"),
    Shot(name: "key-saved", tab: .keys, prepare: { runtime, _, model in
      runtime.answer(["computer", "doctor", "--json"], SettingsFixtures.doctor(admission: "blocked", session: "active"))
      await model.setKey(provider: "openai", key: madeUpKey)
    }),
    Shot(name: "key-problem", tab: .keys, prepare: { runtime, _, model in
      runtime.answer(["keys", "set", "openai"], CommandResult(status: 1, errors: [
        "The key has a space, a line end or another character that a key does not have. Paste only the key. Nothing was stored.",
      ]))
      await model.setKey(provider: "openai", key: "two words")
    }),
    Shot(name: "model", tab: .model),
    Shot(name: "model-custom", tab: .model, prepare: { runtime, _, model in
      runtime.answer(["computer", "model", "--json"], customModel)
      await model.readModel()
    }),
    Shot(name: "model-missing-key", tab: .model, prepare: { runtime, _, model in
      runtime.answer(["computer", "model", "--json"], SettingsFixtures.missingKey)
      await model.readModel()
    }),
    Shot(name: "model-environment", tab: .model, prepare: { runtime, _, model in
      runtime.answer(["computer", "model", "--json"], SettingsFixtures.environmentModel)
      await model.readModel()
    }),
    Shot(name: "permissions", tab: .permissions),
    Shot(name: "general", tab: .general),
  ]

  /// The view drawn by AppKit into a bitmap, with no window.
  private func picture(_ view: some View, dark: Bool) throws -> Data {
    let appearance = try XCTUnwrap(NSAppearance(named: dark ? .darkAqua : .aqua))
    var data: Data?
    appearance.performAsCurrentDrawingAppearance {
      let hosting = NSHostingView(rootView: AnyView(view.environment(\.colorScheme, dark ? .dark : .light)))
      hosting.appearance = appearance
      hosting.frame = NSRect(origin: .zero, size: SettingsRootView.size)
      hosting.layoutSubtreeIfNeeded()
      guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return }
      hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
      data = bitmap.representation(using: .png, properties: [:])
    }
    return try XCTUnwrap(data)
  }

  func testEverySettingsPageDrawsInLightAndDark() async throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_APP_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    let native = try temporaryFolder(self).appendingPathComponent("native", isDirectory: true)
    try writeScript(native.appendingPathComponent("ClawdTimeTaskPanel"), "exit 1\n")
    try writeScript(native.appendingPathComponent("ClawdTimeTaskCapture"), "exit 1\n")
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
      let view = SettingsRootView(model: model, owner: owner, setup: setup, loginItem: FakeLoginItem(),
                                  tab: shot.tab, editing: shot.editing, removing: shot.removing)
      for dark in [false, true] {
        let png = try picture(view, dark: dark)
        XCTAssertGreaterThan(png.count, 10_000, shot.name)
        try folder.map { try png.write(to: $0.appendingPathComponent("settings-\(shot.name)-\(dark ? "dark" : "light").png")) }
      }
      // No key reached an argument in any picture's run.
      XCTAssertFalse(runtime.recorded.contains { $0.arguments.joined().contains(madeUpKey) }, shot.name)
    }
  }
}
