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
    /// The later run, Get calls on your phone.
    var phone = false
    /// The app runs the desktop already, as after Start talking.
    var desktopRuns = false
  }

  private static let hello = #"{"type":"hello","protocol":2,"version":"0.4.0"}"#
  /// The steps of the first run, and of the later phone run, as the engine names them.
  private static let first = ["preflight", "model", "desktop", "computer", "permissions", "ready"]
  private static let later = ["preflight", "desktop", "permissions", "phone", "pairing", "connection", "ready"]
  private static func pending(_ ids: [String]) -> [String] {
    ids.map { #"{"type":"step","id":"\#($0)","state":"pending","title":"\#(titles[$0]!)"}"# }
  }
  private static func ready(_ ids: [String]) -> [String] {
    ids.map { #"{"type":"step","id":"\#($0)","state":"ready","title":"\#(titles[$0]!)","detail":"Done."}"# }
  }
  private static let titles = [
    "preflight": "Check this Mac", "model": "Model key", "desktop": "Start ClawdTime", "computer": "Computer use",
    "permissions": "Permissions", "phone": "Your phone", "pairing": "Pair this Mac", "connection": "Phone connection", "ready": "Ready",
  ]
  private static let firstRun = [hello] + pending(first)
  private static let staleLine = #"{"type":"step","id":"permissions","state":"needs_input","title":"Permissions","question":"shot-question-0007b","detail":"Accessibility and Screen & System Audio Recording are still off for ClawdTime. If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime. Remove ClawdTime from the list with the minus button, then turn it on again. Or click Reset ClawdTime permissions.","details":["Checked for ClawdTimeTaskPanel: /Applications/ClawdTime.app/Contents/Resources/runtime/app/native/ClawdTimeTaskPanel"],"recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"},"input":{"kind":"confirm","prompt":"Check again"},"permissions":{"missing":["accessibility","screen_recording"],"stale":true}}"#
  private static let phoneRun = [hello] + pending(later)

  private static let shots: [Shot] = [
    Shot(name: "01-welcome", lines: []),
    Shot(name: "02-checking", lines: [hello]),
    Shot(name: "03-preflight-working", lines: firstRun + [
      #"{"type":"step","id":"preflight","state":"in_progress","title":"Check this Mac","detail":"Checking this Mac."}"#,
    ]),
    Shot(name: "04-model-found", lines: firstRun + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"in_progress","title":"Model key","detail":"Checking the OpenAI key from your shell settings."}"#,
    ]),
    Shot(name: "05-model-provider", lines: firstRun + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0001","detail":"ClawdTime uses a language model to plan each action. Your key stays on this Mac.","details":["For another provider, run clawdtime keys set PROVIDER, then run clawdtime onboard again."],"input":{"kind":"choice","prompt":"Which model provider do you use?","default":"openai","options":[{"id":"openai","label":"OpenAI","detail":"The default. ClawdTime uses gpt-6.2-astra."},{"id":"anthropic","label":"Anthropic","detail":"ClawdTime uses claude-opus-5-5."}]}}"#,
    ]),
    Shot(name: "06-model-key", lines: firstRun + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0002","detail":"Paste your OpenAI API key. It is not shown.","recovery":{"label":"Get a key from OpenAI","action":"open_url","url":"https://platform.openai.com/api-keys"},"input":{"kind":"secret","prompt":"OpenAI API key"}}"#,
    ]),
    Shot(name: "07-model-refused", lines: firstRun + ready(["preflight"]) + [
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","question":"shot-question-0003","detail":"OpenAI refused this key. Nothing was stored. Paste another key.","recovery":{"label":"Get a key from OpenAI","action":"open_url","url":"https://platform.openai.com/api-keys"},"input":{"kind":"secret","prompt":"OpenAI API key"}}"#,
    ]),
    Shot(name: "08-start-clawdtime", lines: firstRun + ready(["preflight", "model"]) + [
      #"{"type":"step","id":"desktop","state":"in_progress","title":"Start ClawdTime","question":"shot-question-0004","detail":"Starting ClawdTime on this Mac."}"#,
    ]),
    Shot(name: "09-start-failed", lines: firstRun + ready(["preflight", "model"]) + [
      #"{"type":"step","id":"desktop","state":"failed","title":"Start ClawdTime","question":"shot-question-0005","detail":"ClawdTime did not answer after it started. Nothing was replaced. Wait a moment, then try again.","recovery":{"label":"Try again","action":"retry"}}"#,
    ]),
    Shot(name: "10-computer-consent", lines: firstRun + ready(["preflight", "model", "desktop"]) + [
      #"{"type":"step","id":"computer","state":"needs_input","title":"Computer use","question":"shot-question-0006","detail":"ClawdTime can then see your screen. It can click and type for you. It asks you before an action that you cannot undo. To stop it, say stop or press Stop work in the panel.","input":{"kind":"confirm","prompt":"Turn on computer use?","consent":true}}"#,
    ]),
    Shot(name: "11-computer-restart", lines: firstRun + ready(["preflight", "model", "desktop"]) + [
      #"{"type":"step","id":"computer","state":"in_progress","title":"Computer use","detail":"Starting ClawdTime again, so that it can use this Mac."}"#,
    ]),
    Shot(name: "12-permissions", lines: firstRun + ready(["preflight", "model", "desktop", "computer"]) + [
      #"{"type":"step","id":"permissions","state":"needs_input","title":"Permissions","question":"shot-question-0007","detail":"In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTime. In Screen & System Audio Recording, turn on ClawdTime. Setup continues when they are on.","details":["Checked for ClawdTimeTaskPanel: /Applications/ClawdTime.app/Contents/Resources/runtime/app/native/ClawdTimeTaskPanel"],"recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"},"input":{"kind":"confirm","prompt":"Check again"}}"#,
    ]),
    // macOS holds the permission of an older build: the engine's own words, after a check again.
    Shot(name: "12b-permissions-stale", lines: firstRun + ready(["preflight", "model", "desktop", "computer"]) + [staleLine]),
    Shot(name: "12c-permissions-reset", lines: firstRun + ready(["preflight", "model", "desktop", "computer"]) + [staleLine],
         after: { $0.resetPermissions() }),
    Shot(name: "13-ready-start-talking", lines: firstRun + finishedLines(ready: true)),
    Shot(name: "14-ready-with-skips", lines: firstRun + skippedLines(ready: true)),
    Shot(name: "15-not-ready-model-skipped", lines: firstRun + skippedLines(ready: false)),
    Shot(name: "16-handed-off", lines: firstRun + finishedLines(ready: true), after: { $0.finish(chat: true) }),
    Shot(name: "17-engine-stopped", lines: firstRun, after: { _ in }),
    Shot(name: "18-runtime-missing", lines: [], after: { $0.reportRuntimeProblem("The runtime has no bin/clawdtime.") }),
    Shot(name: "19-stopped", lines: firstRun, after: { $0.stop() }),
    // Get calls on your phone: the later, optional run.
    Shot(name: "20-phone-number", lines: phoneRun + ready(["preflight", "desktop", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0008","detail":"ClawdTime checks that the phone is yours. Your number goes only to the coordinator.","input":{"kind":"phone","prompt":"Your own phone number, with country code"}}"#,
    ], phone: true),
    Shot(name: "21-phone-consent", lines: phoneRun + ready(["preflight", "desktop", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0009","detail":"The coordinator at https://coordinator.example texts one code to the number you gave. Nothing is sent before you say yes.","input":{"kind":"confirm","prompt":"Send a sign-in code to this number now?","consent":true}}"#,
    ], phone: true),
    Shot(name: "22-phone-code", lines: phoneRun + ready(["preflight", "desktop", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"needs_input","title":"Your phone","question":"shot-question-0010","detail":"Enter the code from the text. If no text comes, this number may not be invited yet.","input":{"kind":"code","prompt":"Sign-in code"}}"#,
    ], phone: true),
    Shot(name: "23-phone-expired", lines: phoneRun + ready(["preflight", "desktop", "permissions"]) + [
      #"{"type":"step","id":"phone","state":"failed","title":"Your phone","question":"shot-question-0011","detail":"The code expired. Ask for a new one.","recovery":{"label":"Send a new code","action":"retry"}}"#,
    ], phone: true),
    Shot(name: "24-pairing-display", lines: phoneRun + ready(["preflight", "desktop", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0012","detail":"Choose the display first. Then you choose what calls may do with it.","input":{"kind":"choice","prompt":"Which display may your calls show?","options":[{"id":"1","label":"Main display","detail":"2560 by 1440"},{"id":"2","label":"Display 2","detail":"1920 by 1080"}]}}"#,
    ], phone: true),
    Shot(name: "25-pairing-view", lines: phoneRun + ready(["preflight", "desktop", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0013","input":{"kind":"confirm","prompt":"Allow this display to be shown during your verified calls?","consent":true}}"#,
    ], phone: true),
    Shot(name: "26-pairing-replace", lines: phoneRun + ready(["preflight", "desktop", "permissions", "phone"]) + [
      #"{"type":"step","id":"pairing","state":"needs_input","title":"Pair this Mac","question":"shot-question-0014","input":{"kind":"choice","prompt":"Your number already has a paired Mac.","consent":true,"options":[{"id":"replace","label":"Pair this Mac in its place","detail":"The other Mac loses access at once. Its open call ends, and its tasks get no callback."},{"id":"keep","label":"Keep the other Mac","detail":"Nothing changes. This Mac works in local mode."}]}}"#,
    ], phone: true),
    Shot(name: "27-phone-connection", lines: phoneRun + ready(["preflight", "desktop", "permissions", "phone", "pairing"]) + [
      #"{"type":"step","id":"connection","state":"needs_input","title":"Phone connection","question":"shot-question-0015","detail":"ClawdTime keeps the connection while the app runs. Calls from your verified phone can then reach this Mac.","input":{"kind":"confirm","prompt":"Connect this Mac to the shared number when setup ends?","consent":true}}"#,
    ], phone: true),
    Shot(name: "28-phone-ready", lines: phoneRun + phoneLines(ready: true), phone: true, desktopRuns: true),
    Shot(name: "29-phone-not-ready", lines: phoneRun + phoneLines(ready: false), phone: true, desktopRuns: true),
  ]

  /// A first run where the person skipped steps: the report says what is left and how to finish it.
  private static func skippedLines(ready: Bool) -> [String] {
    let rows: [(String, String, String)] = [
      ("preflight", "ready", "This Mac can run ClawdTime."),
      ready ? ("model", "ready", "ClawdTime found your OpenAI key in your shell settings. It checked the key. It keeps the key in the protected key store.")
        : ("model", "skipped", "No model key is stored, so ClawdTime cannot plan or chat yet. To add one later, run clawdtime onboard, or clawdtime keys set PROVIDER."),
      ("desktop", "ready", "ClawdTime started." + (ready ? "" : " It has no model key yet. It reads one the next time it starts.")),
      ("computer", "skipped", "Computer use stays off. Turn it on later: clawdtime computer on"),
      ("permissions", "skipped", "Computer use is off, so no permission is needed."),
      ready ? ("ready", "ready", "ClawdTime is ready on this Mac. To get calls on your phone later, choose Get calls on your phone. Skipped for now: Computer use. Run clawdtime onboard to finish it.")
        : ("ready", "skipped", "ClawdTime cannot work on this Mac yet. Skipped for now: Model key, Computer use. Run clawdtime onboard to finish them."),
    ]
    let report = rows.map { #"{"id":"\#($0.0)","state":"\#($0.1)","detail":"\#($0.2)"}"# }.joined(separator: ",")
    return [#"{"type":"done","ready":\#(ready),"report":[\#(report)]}"#]
  }

  private static func finishedLines(ready: Bool) -> [String] {
    let rows: [(String, String, String)] = [
      ("preflight", "ready", "This Mac can run ClawdTime."),
      ("model", "ready", "A key for OpenAI is in the protected key store."),
      ("desktop", "ready", "ClawdTime started."),
      ("computer", "ready", "Computer use is on."),
      ("permissions", "ready", "Accessibility and Screen Recording are on for ClawdTime."),
      ("ready", "ready", "ClawdTime is ready on this Mac. To get calls on your phone later, choose Get calls on your phone."),
    ]
    let report = rows.map { #"{"id":"\#($0.0)","state":"\#($0.1)","detail":"\#($0.2)"}"# }.joined(separator: ",")
    return [#"{"type":"done","ready":\#(ready),"report":[\#(report)]}"#]
  }

  private static func phoneLines(ready: Bool) -> [String] {
    let rows: [(String, String, String)] = [
      ("preflight", "ready", "This Mac can run ClawdTime. Shared mode with https://coordinator.example."),
      ("desktop", "ready", "ClawdTime runs already. Its work is kept."),
      ("permissions", "ready", "Accessibility and Screen Recording are on for ClawdTime. Screen Recording is on for calls."),
      ready ? ("phone", "ready", "Your phone is verified.") : ("phone", "skipped", "No text was sent. To pair your phone later, run clawdtime onboard --phone."),
      ready ? ("pairing", "ready", "This Mac is paired. View allowed. Computer actions declined. Reports allowed.")
        : ("pairing", "skipped", "Your phone is not verified, so this Mac is not paired. To pair it later, run clawdtime onboard --phone."),
      ready ? ("connection", "ready", "ClawdTime connects this Mac to the shared number when setup ends.") : ("connection", "skipped", "This Mac is not paired with this coordinator."),
      ready ? ("ready", "ready", "ClawdTime is ready on this Mac and paired with your phone. To try a call, call the shared number from your verified phone, then run clawdtime shared prove on this Mac.")
        : ("ready", "skipped", "Calls from your phone cannot reach this Mac yet."),
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

  /// A desktop that says it is ready and waits: the app runs it already.
  private func runningDesktop() throws -> URL {
    let folder = try temporaryFolder(self)
    return try writeScript(folder.appendingPathComponent("runtime/bin/clawdtime"), """
    trap 'exit 0' TERM
    echo '{"type":"ready"}'
    while :; do sleep 1; done
    """)
  }

  func testEverySetupScreenDrawsInLightAndDark() throws {
    let folder = ProcessInfo.processInfo.environment["CLAWDTIME_APP_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    if let folder { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    for shot in Self.shots {
      let engine = ScriptedEngine()
      // A fake request and a fake reset: no dialog opens and tccutil never runs.
      let setup = SetupCoordinator(makeEngine: { _ in engine }, owner: RecordingOwner(), open: { _ in false }, answerDelay: 0,
                                   permissions: PermissionRequests(prompt: FakePermissionPrompt()), resetRunner: FakeResetRunner())
      if !shot.lines.isEmpty || shot.name.hasSuffix("stopped") {
        if shot.phone { setup.beginPhone() } else { setup.begin() }
        for line in shot.lines { engine.emit(line) }
      }
      if shot.name == "17-engine-stopped" {
        engine.onExit?(1, ["The desktop did not answer its readiness check.", "Setup stopped on an unexpected problem."])
      }
      shot.after?(setup)
      let resetDeadline = Date().addingTimeInterval(5)
      while setup.permissionReset == .running && Date() < resetDeadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
      let owner = ProcessOwner(launcher: shot.desktopRuns ? try runningDesktop() : URL(fileURLWithPath: "/nonexistent/clawdtime"), grace: 1)
      if shot.desktopRuns {
        owner.start(connection: false)
        let deadline = Date().addingTimeInterval(10)
        while owner.desktop != .running && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
      }
      defer { if shot.desktopRuns { var done = false; owner.stop { done = true }; while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) } } }
      let view = SetupRootView(setup: setup, owner: owner, loginItem: FakeLoginItem())
      for dark in [false, true] {
        let png = try picture(view, dark: dark)
        XCTAssertGreaterThan(png.count, 10_000, shot.name)
        try folder.map { try png.write(to: $0.appendingPathComponent("\(shot.name)-\(dark ? "dark" : "light").png")) }
      }
    }
  }
}
