import AppKit
import SwiftUI
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

final class FakeLoginItem: LoginItemControlling {
  var isEnabled = false
  var needsApproval = false
  var changes: [Bool] = []
  func setEnabled(_ enabled: Bool) throws { changes.append(enabled); isEnabled = enabled }
}

/// The window's screens, built off screen: no window is shown and nothing is clicked.
@MainActor
final class SetupViewTests: XCTestCase {
  private func render(_ setup: SetupCoordinator, login: LoginItemControlling = FakeLoginItem()) -> NSHostingView<SetupRootView> {
    let owner = ProcessOwner(launcher: URL(fileURLWithPath: "/nonexistent/clawdtime"))
    let view = NSHostingView(rootView: SetupRootView(setup: setup, owner: owner, loginItem: login))
    view.frame = NSRect(origin: .zero, size: SetupRootView.size)
    view.layoutSubtreeIfNeeded()
    _ = view.fittingSize
    return view
  }

  private func scripted() -> (SetupCoordinator, ScriptedEngine) {
    let engine = ScriptedEngine()
    let setup = SetupCoordinator(makeEngine: { _ in engine }, owner: nil, open: { _ in false }, answerDelay: 0)
    return (setup, engine)
  }

  func testEveryScreenAndEveryInputKindBuilds() {
    let (setup, engine) = scripted()
    XCTAssertEqual(Screen(setup.state), .welcome)
    _ = render(setup)
    setup.begin()
    XCTAssertEqual(Screen(setup.state).key, "checking")
    _ = render(setup)
    engine.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    let steps = [
      #"{"type":"step","id":"preflight","state":"in_progress","title":"Check this Mac"}"#,
      #"{"type":"step","id":"model","state":"needs_input","title":"Model key","input":{"kind":"secret","prompt":"Model key"}}"#,
      #"{"type":"step","id":"desktop","state":"needs_input","input":{"kind":"text","prompt":"Project folder"}}"#,
      #"{"type":"step","id":"computer","state":"needs_input","input":{"kind":"confirm","prompt":"Allow computer use?"}}"#,
      #"{"type":"step","id":"permissions","state":"failed","detail":"Screen Recording is off.","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"}}"#,
      #"{"type":"step","id":"phone","state":"needs_input","input":{"kind":"phone","prompt":"Phone number"}}"#,
      #"{"type":"step","id":"phone","state":"needs_input","input":{"kind":"code","prompt":"Code"}}"#,
      #"{"type":"step","id":"pairing","state":"needs_input","input":{"kind":"choice","options":[{"id":"1","label":"Built-in display"},{"id":"2","label":"Studio display","detail":"Right"}],"multiple":true}}"#,
      #"{"type":"step","id":"connection","state":"needs_input","input":{"kind":"choice","options":[{"id":"view","label":"View only"}]}}"#,
    ]
    for line in steps {
      engine.emit(line)
      guard case .step = Screen(setup.state) else { return XCTFail(line) }
      _ = render(setup)
    }
    engine.emit(#"{"type":"done","ready":true,"report":[{"id":"model","state":"ready","detail":"Stored"},{"id":"phone","state":"skipped"}]}"#)
    XCTAssertEqual(Screen(setup.state), .finished(ready: true))
    _ = render(setup)
    setup.stop()
    XCTAssertEqual(Screen(setup.state), .stopped)
    _ = render(setup)
    setup.reportRuntimeProblem("The runtime has no bin/clawdtime.")
    XCTAssertEqual(Screen(setup.state).key, "failed")
    _ = render(setup)
  }

  func testASettingsStepOffersSettingsAndCheckAgainNotYesOrNo() throws {
    let permissions = try XCTUnwrap(EngineEvent.decode(line: #"{"type":"step","id":"permissions","state":"needs_input","title":"Permissions","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"},"input":{"kind":"confirm","prompt":"Check again"}}"#))
    guard case .step(let step) = permissions else { return XCTFail("a step") }
    XCTAssertTrue(StepCard.checksSettings(step), "the answer is Check again, after the person acts in System Settings")
    let consent = try XCTUnwrap(EngineEvent.decode(line: #"{"type":"step","id":"computer","state":"needs_input","input":{"kind":"confirm","prompt":"Turn on computer use?"}}"#))
    guard case .step(let question) = consent else { return XCTFail("a step") }
    XCTAssertFalse(StepCard.checksSettings(question), "a real question keeps Yes and No")
  }

  func testAFailedStepHasOnePrimaryRetryWithTheEnginesLabel() throws {
    func step(_ line: String) throws -> StepEvent {
      guard case .step(let step) = try EngineEvent.decode(line: line) else { throw CocoaError(.coderInvalidValue) }
      return step
    }
    XCTAssertEqual(StepCard.retryLabel(try step(#"{"type":"step","id":"phone","state":"failed","recovery":{"label":"Send a new code","action":"retry"}}"#)), "Send a new code")
    XCTAssertEqual(StepCard.retryLabel(try step(#"{"type":"step","id":"desktop","state":"failed"}"#)), "Try again")
    XCTAssertEqual(StepCard.retryLabel(try step(#"{"type":"step","id":"permissions","state":"failed","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security"}}"#)), "Try again")
    XCTAssertNil(StepCard.retryLabel(try step(#"{"type":"step","id":"model","state":"needs_input","input":{"kind":"secret"}}"#)))
  }

  func testEachQuestionHasItsOwnScreen() throws {
    func step(_ line: String) throws -> StepEvent {
      guard case .step(let step) = try EngineEvent.decode(line: line) else { throw CocoaError(.coderInvalidValue) }
      return step
    }
    let view = try step(#"{"type":"step","id":"pairing","state":"needs_input","question":"view-question-0001","input":{"kind":"confirm","prompt":"Allow this display to be shown during your verified calls?"}}"#)
    let control = try step(#"{"type":"step","id":"pairing","state":"needs_input","question":"control-question-01","input":{"kind":"confirm","prompt":"Allow your verified phone to ask for computer actions on this Mac?"}}"#)
    XCTAssertNotEqual(Screen.step(view).key, Screen.step(control).key, "a new question is a new screen, with new buttons")
  }

  func testNoConsentQuestionHasADefaultButton() throws {
    func step(_ line: String) throws -> StepEvent {
      guard case .step(let step) = try EngineEvent.decode(line: line) else { throw CocoaError(.coderInvalidValue) }
      return step
    }
    let consent = [
      #"{"type":"step","id":"computer","state":"needs_input","question":"computer-question-01","input":{"kind":"confirm","prompt":"Turn on computer use?","consent":true}}"#,
      #"{"type":"step","id":"pairing","state":"needs_input","question":"view-question-0001","input":{"kind":"confirm","prompt":"Allow this display to be shown during your verified calls?","consent":true}}"#,
      #"{"type":"step","id":"phone","state":"needs_input","question":"phone-question-0001","input":{"kind":"confirm","prompt":"Send a sign-in code to this number now?","consent":true}}"#,
      #"{"type":"step","id":"pairing","state":"needs_input","question":"replace-question-01","input":{"kind":"choice","prompt":"Your number already has a paired Mac.","consent":true,"options":[{"id":"replace","label":"Pair this Mac in its place"},{"id":"keep","label":"Keep the other Mac"}]}}"#,
      // A yes or no question is consent even when the engine does not say so.
      #"{"type":"step","id":"connection","state":"needs_input","question":"connect-question-01","input":{"kind":"confirm","prompt":"Connect this Mac to the shared number now?"}}"#,
    ]
    for line in consent {
      let question = try step(line)
      XCTAssertTrue(StepCard.isConsent(question), line)
      XCTAssertNil(StepCard.defaultButton(question), "Return answers no consent question: \(line)")
    }
    let key = try step(#"{"type":"step","id":"model","state":"needs_input","question":"model-question-0001","input":{"kind":"secret","prompt":"OpenAI API key"}}"#)
    XCTAssertEqual(StepCard.defaultButton(key), "Continue")
    let settings = try step(#"{"type":"step","id":"permissions","state":"needs_input","question":"settings-question-01","recovery":{"label":"Open System Settings","action":"open_settings","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"},"input":{"kind":"confirm","prompt":"Check again"}}"#)
    XCTAssertFalse(StepCard.isConsent(settings))
    XCTAssertEqual(StepCard.defaultButton(settings), "Check again")
  }

  func testAFieldOfAnotherKindStartsEmpty() {
    XCTAssertTrue(StepCard.clearsField(shown: .phone, next: .code), "the number never carries into the code field")
    XCTAssertFalse(StepCard.clearsField(shown: .phone, next: nil), "a working state keeps the field")
    XCTAssertFalse(StepCard.clearsField(shown: .phone, next: .phone), "a failed number can be fixed")
    XCTAssertFalse(StepCard.clearsField(shown: nil, next: .secret))
  }

  func testTheMainMenuCanPasteAndQuit() {
    let menu = MainMenu.make()
    let items = menu.items.flatMap { $0.submenu?.items ?? [] }
    XCTAssertTrue(items.contains { $0.action == #selector(NSText.paste(_:)) && $0.keyEquivalent == "v" })
    XCTAssertTrue(items.contains { $0.action == #selector(NSApplication.terminate(_:)) && $0.keyEquivalent == "q" })
  }

  func testOpenAtLoginStaysOffUntilThePersonTurnsItOn() {
    let (setup, engine) = scripted()
    setup.begin()
    engine.emit(#"{"type":"hello","protocol":2,"version":"0.4.0"}"#)
    engine.emit(#"{"type":"done","ready":true,"report":[]}"#)
    let login = FakeLoginItem()
    _ = render(setup, login: login)
    XCTAssertTrue(login.changes.isEmpty, "showing the readiness view changes nothing")
    XCTAssertFalse(login.isEnabled)
  }

  func testTheMenuSaysWhatRuns() {
    XCTAssertEqual(MenuText.summary(desktop: .off, connection: .off), "ClawdTime is stopped")
    XCTAssertEqual(MenuText.summary(desktop: .starting, connection: .off), "Starting the desktop")
    XCTAssertEqual(MenuText.summary(desktop: .running, connection: .running), "Running · phone connection on")
    XCTAssertEqual(MenuText.summary(desktop: .running, connection: .off), "Running on this Mac only")
    XCTAssertEqual(MenuText.summary(desktop: .running, connection: .stopping), "Stopping")
    XCTAssertEqual(MenuText.summary(desktop: .ended("The desktop stopped with status 1."), connection: .off), "The desktop stopped with status 1.")
  }

  func testTheAppStartsWithSetupNotDone() {
    let defaults = UserDefaults(suiteName: "ClawdTimeAppTests-\(UUID().uuidString)")!
    let app = AppDelegate(runtimeOverride: nil, defaults: defaults, loginItem: FakeLoginItem())
    XCTAssertFalse(app.setupDone)
  }
}
