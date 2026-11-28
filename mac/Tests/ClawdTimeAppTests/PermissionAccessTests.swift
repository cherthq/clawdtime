import Foundation
import XCTest
@testable import ClawdTimeAppCore

/// Records each request to macOS. Nothing asks macOS for real: no dialog opens.
@MainActor
final class FakePermissionPrompt: PermissionPrompting {
  var asked: [PermissionKind] = []
  func request(_ kind: PermissionKind) { asked.append(kind) }
}

/// Records each command. Nothing runs: tccutil never runs in a test.
final class FakeResetRunner: CommandRunning, @unchecked Sendable {
  struct Call: Equatable { var executable: String; var arguments: [String] }
  private let lock = NSLock()
  private var log: [Call] = []
  var status: Int32 = 0
  var calls: [Call] { lock.withLock { log } }
  func run(_ executable: URL, _ arguments: [String], input: Data?) async -> CommandResult {
    lock.withLock {
      log.append(Call(executable: executable.path, arguments: arguments))
      return CommandResult(status: status)
    }
  }
}

/// Setup asks macOS for a missing permission once in a run, says when macOS
/// still holds the permission of an older build, and resets only
/// ClawdTime's own entries when the person clicks the reset.
@MainActor
final class PermissionAccessTests: XCTestCase {
  private var engine: ScriptedEngine!
  private var prompt: FakePermissionPrompt!
  private var runner: FakeResetRunner!

  private func coordinator() -> SetupCoordinator {
    engine = ScriptedEngine()
    prompt = FakePermissionPrompt()
    runner = FakeResetRunner()
    let setup = SetupCoordinator(makeEngine: { [unowned self] _ in self.engine }, owner: nil, open: { _ in true }, answerDelay: 0,
                                 permissions: PermissionRequests(prompt: prompt), resetRunner: runner)
    setup.begin()
    engine.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    return setup
  }

  private static let settingsRecovery = #""recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}"#

  /// The permissions question, as the engine asks it.
  private func ask(_ question: String, missing: [String] = ["accessibility", "screen_recording"], stale: Bool = false) {
    let list = missing.map { #""\#($0)""# }.joined(separator: ",")
    engine.emit(#"{"type":"step","id":"permissions","state":"needs_input","question":"\#(question)","input":{"kind":"confirm","prompt":"Check again"},\#(Self.settingsRecovery),"permissions":{"missing":[\#(list)],"stale":\#(stale)}}"#)
  }

  func testSetupAsksMacOSOnceForEachMissingPermissionInARun() {
    let setup = coordinator()
    XCTAssertTrue(prompt.asked.isEmpty, "nothing is asked before the step")
    ask("permissions-question-01")
    XCTAssertEqual(prompt.asked, [.accessibility, .screenRecording], "macOS shows its own dialog and lists this build")
    // The person checks again, and the engine asks again: macOS is not asked again.
    setup.perform(.recheck)
    ask("permissions-question-02")
    ask("permissions-question-03", stale: true)
    XCTAssertEqual(prompt.asked, [.accessibility, .screenRecording], "never more than once in a setup run")
    // A new run may ask once again.
    setup.stop()
    engine.leave(code: 0)
    setup.begin()
    engine.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    ask("permissions-question-04", missing: ["screen_recording"])
    XCTAssertEqual(prompt.asked, [.accessibility, .screenRecording, .screenRecording])
  }

  func testSetupAsksOnlyForWhatTheEngineSaysIsMissing() {
    let setup = coordinator()
    defer { withExtendedLifetime(setup) {} }
    ask("permissions-question-01", missing: ["screen_recording"])
    XCTAssertEqual(prompt.asked, [.screenRecording])
    // Another step, or a permission this app does not know, asks nothing.
    engine.emit(#"{"type":"step","id":"computer","state":"needs_input","question":"computer-question-01","input":{"kind":"confirm","consent":true},"permissions":{"missing":["accessibility"],"stale":false}}"#)
    ask("permissions-question-02", missing: ["camera"])
    XCTAssertEqual(prompt.asked, [.screenRecording])
  }

  func testTheResetIsOfferedOnlyWhenMacOSHoldsAnOlderBuildsPermission() {
    let setup = coordinator()
    ask("permissions-question-01")
    XCTAssertFalse(setup.canResetPermissions, "not before the person said the switches are on")
    XCTAssertNil(setup.resetPermissions())
    XCTAssertTrue(runner.calls.isEmpty)
    ask("permissions-question-02", stale: true)
    XCTAssertTrue(setup.canResetPermissions)
  }

  func testTheResetRunsOnlyClawdTimesOwnTwoCommandsThenAsksAgain() async {
    let setup = coordinator()
    ask("permissions-question-01")
    ask("permissions-question-02", stale: true)
    XCTAssertEqual(prompt.asked.count, 2)
    await setup.resetPermissions()?.value
    XCTAssertEqual(runner.calls, [
      .init(executable: "/usr/bin/tccutil", arguments: ["reset", "Accessibility", "com.clawdtime.app"]),
      .init(executable: "/usr/bin/tccutil", arguments: ["reset", "ScreenCapture", "com.clawdtime.app"]),
    ])
    // Only this bundle id: never every app, never another service.
    for call in runner.calls {
      XCTAssertEqual(call.arguments.count, 3)
      XCTAssertEqual(call.arguments.last, PermissionReset.bundleID)
    }
    XCTAssertEqual(setup.permissionReset, .done)
    // macOS lists this build again, with its own dialog.
    XCTAssertEqual(prompt.asked, [.accessibility, .screenRecording, .accessibility, .screenRecording])
    // The engine is not told anything: it checks again by itself.
    XCTAssertTrue(engine.sent.isEmpty)
  }

  func testTheResetResetsOnlyWhatIsStillOff() async {
    let setup = coordinator()
    ask("permissions-question-01", missing: ["accessibility"], stale: true)
    await setup.resetPermissions()?.value
    XCTAssertEqual(runner.calls, [.init(executable: "/usr/bin/tccutil", arguments: ["reset", "Accessibility", "com.clawdtime.app"])])
  }

  func testAFailedResetSaysSoAndAsksNothing() async {
    let setup = coordinator()
    ask("permissions-question-01", stale: true)
    runner.status = 1
    await setup.resetPermissions()?.value
    XCTAssertEqual(setup.permissionReset, .failed)
    XCTAssertEqual(prompt.asked, [.accessibility, .screenRecording], "the first request only")
  }

  func testTheCommandsAreTheSameAsTheTerminalPrints() {
    XCTAssertEqual(PermissionReset.arguments(.accessibility), ["reset", "Accessibility", "com.clawdtime.app"])
    XCTAssertEqual(PermissionReset.arguments(.screenRecording), ["reset", "ScreenCapture", "com.clawdtime.app"])
    XCTAssertEqual(PermissionReset.command(.accessibility), "tccutil reset Accessibility com.clawdtime.app")
    XCTAssertEqual(PermissionReset.command(.screenRecording), "tccutil reset ScreenCapture com.clawdtime.app")
    XCTAssertEqual(PermissionReset.tool.path, "/usr/bin/tccutil")
  }

  // MARK: Settings

  private var runtime: FakeSettingsRuntime!

  private func settings() throws -> SettingsModel {
    runtime = FakeSettingsRuntime()
    prompt = FakePermissionPrompt()
    let folder = try temporaryFolder(self)
    try writeScript(folder.appendingPathComponent("native/ClawdTimeTaskPanel"), "exit 1\n")
    try writeScript(folder.appendingPathComponent("native/ClawdTimeTaskCapture"), "exit 1\n")
    // Accessibility is off for this build; Screen Recording is on.
    runtime.answer(["--check-access"], #"{"accessibility":false,"screenRecording":true,"version":1}"#)
    return SettingsModel(
      runner: runtime, launcher: folder.appendingPathComponent("bin/clawdtime"),
      native: folder.appendingPathComponent("native", isDirectory: true), desktop: FakeDesktop(),
      about: AboutInfo(app: "0.4.0", runtime: "0.4.0", commit: nil), open: { _ in true }, prompt: prompt)
  }

  private var resets: [[String]] { runtime.recorded.filter { $0.executable == "tccutil" }.map(\.arguments) }

  func testSettingsSaysSoOnlyAfterOpenSystemSettingsAndACheckThatStillFails() async throws {
    let model = try settings()
    await model.checkPermissions()
    XCTAssertEqual(model.stalePermissions, [], "off, but the person did not go to System Settings")
    model.openSettings(.accessibility)
    // The page's own repeated check while System Settings is in front says nothing new.
    await model.checkPermissions(quietly: true)
    XCTAssertEqual(model.stalePermissions, [])
    // The person comes back: the window checks again, and it is still off.
    await model.checkPermissions()
    XCTAssertEqual(model.stalePermissions, [.accessibility])
    XCTAssertEqual(SettingsModel.staleWords(model.stalePermissions),
                   "Accessibility is still off for ClawdTime. If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime. Remove ClawdTime from the list with the minus button, then turn it on again. Or click Reset ClawdTime permissions.")
    // Once it is on, nothing is stale.
    runtime.answer(["--check-access"], #"{"accessibility":true,"screenRecording":true,"version":1}"#)
    await model.checkPermissions(quietly: true)
    XCTAssertEqual(model.stalePermissions, [])
    XCTAssertTrue(resets.isEmpty)
  }

  func testTheSettingsResetRunsOnlyClawdTimesCommandsThenAsksAgain() async throws {
    let model = try settings()
    await model.resetPermissions()
    XCTAssertTrue(resets.isEmpty, "no reset while nothing is stale")
    model.openSettings(.accessibility)
    await model.checkPermissions()
    await model.resetPermissions()
    XCTAssertEqual(resets, [["reset", "Accessibility", "com.clawdtime.app"]], "only what is stale, only this bundle id")
    XCTAssertEqual(model.permissionReset, .done)
    XCTAssertEqual(prompt.asked, [.accessibility], "macOS lists this build again")
    XCTAssertEqual(model.stalePermissions, [])
  }
}
