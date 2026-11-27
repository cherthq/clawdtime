import AppKit
import SwiftUI
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// Every screen of the setup window, drawn off screen in light and dark mode:
/// no window opens. With CLAWDTIME_APP_SHOTS set to a folder, each picture is
/// written there as a PNG, for a person to look at. The texts are the engine's
/// own, so the pictures show real lengths.
@MainActor
final class SetupScreenshotTests: XCTestCase {
  private struct Shot {
    var name: String
    var lines: [String]
    var after: ((SetupCoordinator) -> Void)? = nil
  }

  private static let hello = #"{"type":"hello","protocol":2,"version":"0.4.0"}"#
  private static let pending = ["preflight", "model", "desktop", "computer", "permissions", "phone", "pairing", "connection", "ready"]
    .map { #"{"type":"step","id":"\#($0)","state":"pending","title":"\#(titles[$0]!)"}"# }
  private static func ready(_ ids: [String]) -> [String] {
    ids.map { #"{"type":"step","id":"\#($0)","state":"ready","title":"\#(titles[$0]!)","detail":"Done."}"# }
  }
  private static let titles = [
    "preflight": "Check this Mac", "model": "Model key", "desktop": "Desktop", "computer": "Computer use",
    "permissions": "Permissions", "phone": "Your phone", "pairing": "Pair this Mac", "connection": "Shared connection", "ready": "Ready",
  ]

  private static let shots: [Shot] = [
    Shot(name: "01-welcome", lines: []),
    Shot(name: "02-checking", lines: [hello]),
    Shot(name: "03-preflight-working", lines: [hello] + pending + [
      #"{"type":"step","id":"preflight","state":"in_progress","title":"Check this Mac","detail":"Checking this Mac."}"#,
    ]),
    Shot(name: "04-model-provider", lines: [hello] + pending + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0001","detail":"ClawdTime plans each action with a language model. Your key stays on this Mac. For another provider, run clawdtime keys set PROVIDER, then run this again.","input":{"kind":"choice","prompt":"Which model provider do you use?","options":[{"id":"openai","label":"OpenAI","detail":"Plans with gpt-5.4."},{"id":"anthropic","label":"Anthropic","detail":"Plans with claude-opus-5-5."}]}}"#,
    ]),
    Shot(name: "05-model-key", lines: [hello] + pending + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0002","detail":"Paste your OpenAI API key. It is not shown.","input":{"kind":"secret","prompt":"OpenAI API key"}}"#,
    ]),
    Shot(name: "06-model-refused", lines: [hello] + pending + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0003","detail":"OpenAI refused this key. Nothing was stored. Paste another key.","input":{"kind":"secret","prompt":"OpenAI API key"}}"#,
    ]),
    Shot(name: "07-desktop-starting", lines: [hello] + pending + ready(["preflight", "model"]) + [
      #"{"type":"step","id":"desktop","state":"in_progress","title":"Desktop","detail":"Starting the desktop."}"#,
    ]),
    Shot(name: "08-desktop-failed", lines: [hello] + pending + ready(["preflight", "model"]) + [
      #"{"type":"step","id":"desktop","state":"failed","title":"Desktop","question":"shot-question-0004","detail":"The desktop did not answer its readiness check. Nothing was replaced. Wait a moment, then try again.","recovery":{"label":"Try again","action":"retry"}}"#,
    ]),
    Shot(name: "09-computer-consent", lines: [hello] + pending + ready(["preflight", "model", "desktop"]) + [
      #"{"type":"step","id":"computer","state":"needs_input","title":"Computer use","question":"shot-question-0005","detail":"ClawdTime can then see your screen, and click and type for you. Every action is checked in code. A click that cannot be undone needs your yes. Stop it any time: say stop, or press Stop work in the panel.","input":{"kind":"confirm","prompt":"Turn on computer use?","consent":true}}"#,
    ]),
    Shot(name: "10-computer-restart", lines: [hello] + pending + ready(["preflight", "model", "desktop"]) + [
      #"{"type":"step","id":"computer","state":"in_progress","title":"Computer use","detail":"Starting the desktop again, so that it can use this Mac."}"#,
    ]),
    Shot(name: "11-permissions", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer"]) + [
      #"{"type":"step","id":"permissions","state":"needs_input","title":"Permissions","question":"shot-question-0006","detail":"In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTimeTaskPanel. In Screen & System Audio Recording, turn on ClawdTimeTaskPanel and ClawdTimeTaskCapture. Then check again.","details":["ClawdTimeTaskPanel: /Applications/ClawdTime.app/Contents/Resources/runtime/app/native/ClawdTimeTaskPanel","ClawdTimeTaskCapture: /Applications/ClawdTime.app/Contents/Resources/runtime/app/native/ClawdTimeTaskCapture"],"recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"},"input":{"kind":"confirm","prompt":"Check again"}}"#,
    ]),
    Shot(name: "12-phone-number", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0007","detail":"ClawdTime checks that the phone is yours. Your number goes only to the coordinator.","input":{"kind":"phone","prompt":"Your own phone number, with country code"}}"#,
    ]),
    Shot(name: "13-phone-consent", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0008","detail":"The coordinator at https://coordinator.example texts one code to the number you gave. Nothing is sent before you say yes.","input":{"kind":"confirm","prompt":"Send a sign-in code to this number now?","consent":true}}"#,
    ]),
    Shot(name: "14-phone-code", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0009","detail":"Enter the code from the text. If no text comes, this number may not be invited yet.","input":{"kind":"code","prompt":"Sign-in code"}}"#,
    ]),
    Shot(name: "15-phone-expired", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"failed","title":"Your phone","question":"shot-question-0010","detail":"The code expired. Ask for a new one.","recovery":{"label":"Send a new code","action":"retry"}}"#,
    ]),
    Shot(name: "16-pairing-display", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0011","detail":"Choose the display first. Then you choose what calls may do with it.","input":{"kind":"choice","prompt":"Which display may your calls show?","options":[{"id":"1","label":"Main display","detail":"2560 by 1440"},{"id":"2","label":"Display 2","detail":"1920 by 1080"}]}}"#,
    ]),
    Shot(name: "17-pairing-view", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0012","input":{"kind":"confirm","prompt":"Allow this display to be shown during your verified calls?","consent":true}}"#,
    ]),
    Shot(name: "18-pairing-replace", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0013","input":{"kind":"choice","prompt":"Your number already has a paired Mac.","consent":true,"options":[{"id":"replace","label":"Pair this Mac in its place","detail":"The other Mac loses access at once. Its open call ends, and its tasks get no callback."},{"id":"keep","label":"Keep the other Mac","detail":"Nothing changes. This Mac works in local mode."}]}}"#,
    ]),
    Shot(name: "19-connection", lines: [hello] + pending + ready(["preflight", "model", "desktop", "computer", "permissions", "phone", "pairing"]) + [
      #"{"type":"step","id":"connection","state":"needs_input","title":"Shared connection","question":"shot-question-0014","detail":"ClawdTime keeps the connection while the app runs. Calls from your verified phone can then reach this Mac.","input":{"kind":"confirm","prompt":"Connect this Mac to the shared number when setup ends?","consent":true}}"#,
    ]),
    Shot(name: "20-finished-ready", lines: [hello] + pending + finishedLines(ready: true)),
    Shot(name: "21-finished-not-ready", lines: [hello] + pending + finishedLines(ready: false)),
    Shot(name: "22-handed-off", lines: [hello] + pending + finishedLines(ready: true), after: { $0.finish() }),
    Shot(name: "23-engine-stopped", lines: [hello] + pending, after: { _ in }),
    Shot(name: "24-runtime-missing", lines: [], after: { $0.reportRuntimeProblem("The runtime has no bin/clawdtime.") }),
    Shot(name: "25-stopped", lines: [hello] + pending, after: { $0.stop() }),
  ]

  private static func finishedLines(ready: Bool) -> [String] {
    let rows: [(String, String, String)] = [
      ("preflight", "ready", "macOS and Apple silicon checked. Shared mode with https://coordinator.example."),
      ("model", "ready", "A key for OpenAI is in the protected key store."),
      ("desktop", "ready", "The desktop started."),
      ("computer", "ready", "Computer use is on."),
      ("permissions", ready ? "ready" : "failed", ready ? "Accessibility and Screen Recording are on for the panel. Screen Recording is on for the capture helper." : "In System Settings, open Privacy & Security. In Screen & System Audio Recording, turn on ClawdTimeTaskPanel. Then check again."),
      ("phone", "ready", "Your phone is verified."),
      ("pairing", "ready", "This Mac is paired. View allowed. Computer actions declined. Reports allowed."),
      ("connection", "ready", "ClawdTime connects this Mac to the shared number when setup ends."),
      ("ready", ready ? "ready" : "failed", ready ? "ClawdTime is ready on this Mac and paired with your phone. To try a call, call the shared number from your verified phone, then run clawdtime shared prove on this Mac." : "Setup is not finished. Run clawdtime onboard again to continue where it stopped."),
    ]
    let report = rows.map { #"{"id":"\#($0.0)","state":"\#($0.1)","detail":"\#($0.2)"}"# }.joined(separator: ",")
    return [#"{"type":"done","ready":\#(ready),"report":[\#(report)]}"#]
  }

  /// The view drawn by AppKit into a bitmap, with no window: fields and
  /// switches draw as they do on screen.
  private func picture(_ view: some View, dark: Bool) throws -> Data {
    let appearance = try XCTUnwrap(NSAppearance(named: dark ? .darkAqua : .aqua))
    var data: Data?
    appearance.performAsCurrentDrawingAppearance {
      let hosting = NSHostingView(rootView: AnyView(view.environment(\.colorScheme, dark ? .dark : .light)))
      hosting.appearance = appearance
      hosting.frame = NSRect(origin: .zero, size: SetupRootView.size)
      hosting.layoutSubtreeIfNeeded()
      guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return }
      hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
      data = bitmap.representation(using: .png, properties: [:])
    }
    return try XCTUnwrap(data)
  }

  func testEverySetupScreenDrawsInLightAndDark() throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_APP_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    for shot in Self.shots {
      let engine = ScriptedEngine()
      let setup = SetupCoordinator(makeEngine: { _ in engine }, owner: RecordingOwner(), open: { _ in false }, answerDelay: 0)
      if !shot.lines.isEmpty || shot.name.hasSuffix("stopped") {
        setup.begin()
        for line in shot.lines { engine.emit(line) }
      }
      if shot.name == "23-engine-stopped" {
        engine.onExit?(1, ["The desktop did not answer its readiness check.", "Setup stopped on an unexpected problem."])
      }
      shot.after?(setup)
      let owner = ProcessOwner(launcher: URL(fileURLWithPath: "/nonexistent/clawdtime"))
      let view = SetupRootView(setup: setup, owner: owner, loginItem: FakeLoginItem())
      for dark in [false, true] {
        let png = try picture(view, dark: dark)
        XCTAssertGreaterThan(png.count, 10_000, shot.name)
        try folder.map { try png.write(to: $0.appendingPathComponent("\(shot.name)-\(dark ? "dark" : "light").png")) }
      }
    }
  }
}
