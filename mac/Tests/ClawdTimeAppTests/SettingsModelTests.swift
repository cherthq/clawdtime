import Foundation
import XCTest
@testable import ClawdTimeApp
@testable import ClawdTimeAppCore

/// The answers of a made-up runtime, in the shapes that `clawdtime keys list
/// --json`, `computer model --json` and `computer doctor --json` print.
enum SettingsFixtures {
  static func keys(anthropic: String? = "store", together: String? = "environment", problem: String? = nil) -> String {
    func source(_ value: String?) -> String { value.map { #""\#($0)""# } ?? "null" }
    let problemJSON = problem.map { #""\#($0)""# } ?? "null"
    return #"""
    {"version":1,"store":"/Users/riverchat/.local/share/clawdtime/computer/keys.json","problem":\#(problemJSON),"providers":[
    {"id":"openai","name":"OpenAI","set":false,"source":null,"variable":null,"stored":false,"defaultModel":"gpt-6.2-astra","needsModel":false,"needsBaseUrl":false},
    {"id":"anthropic","name":"Anthropic","set":\#(anthropic != nil),"source":\#(source(anthropic)),"variable":null,"stored":\#(anthropic != nil),"defaultModel":"claude-opus-5-5","needsModel":false,"needsBaseUrl":false},
    {"id":"together","name":"Together AI","set":\#(together != nil),"source":\#(source(together)),"variable":\#(together == "environment" ? #""TOGETHER_API_KEY""# : "null"),"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"openrouter","name":"OpenRouter","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"groq","name":"Groq","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"fireworks","name":"Fireworks AI","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"xai","name":"xAI","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"gemini","name":"Google Gemini","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"mistral","name":"Mistral","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"deepseek","name":"DeepSeek","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":false},
    {"id":"custom","name":"a custom service","set":false,"source":null,"variable":null,"stored":false,"defaultModel":null,"needsModel":true,"needsBaseUrl":true}]}
    """#.replacingOccurrences(of: "\n", with: "")
  }

  static let model = #"{"version":1,"ok":true,"reason":null,"problem":null,"provider":"anthropic","providerName":"Anthropic","model":"claude-opus-5-5","name":"anthropic/claude-opus-5-5","from":"store","variable":null,"baseUrl":null,"key":{"source":"store","variable":null}}"#
  static let automaticModel = #"{"version":1,"ok":true,"reason":null,"problem":null,"provider":"anthropic","providerName":"Anthropic","model":"claude-opus-5-5","name":"anthropic/claude-opus-5-5","from":"default","variable":null,"baseUrl":null,"key":{"source":"store","variable":null}}"#
  static let missingKey = #"{"version":1,"ok":false,"reason":"missing_key","problem":"The planner model is groq/a-vision-model, but no key for Groq is set.","provider":"groq","providerName":"Groq","model":"a-vision-model","name":"groq/a-vision-model","from":"store","variable":null,"baseUrl":null,"key":null}"#
  static let environmentModel = #"{"version":1,"ok":true,"reason":null,"problem":null,"provider":"openai","providerName":"OpenAI","model":"gpt-4.1","name":"gpt-4.1","from":"environment","variable":"CLAWDTIME_COMPUTER_MODEL","baseUrl":null,"key":{"source":"environment","variable":"OPENAI_API_KEY"}}"#

  static func doctor(admission: String = "available", session: String = "inactive", service: String = "connected") -> String {
    #"{"version":1,"desktop":{"service":"\#(service)","chat":"connected","taskSession":"\#(session)","taskAdmission":"\#(admission)","computer":"configured","computerMode":"worker","physicalVerification":"required"},"checks":[]}"#
  }
  static let panelAccess = #"{"accessibility":true,"desktopShortcutsAvailable":true,"desktopSwitchingEnabled":false,"screenRecording":false,"version":1}"#
  static let capturePreflight = #"{"loginComplete":true,"locked":false,"onConsole":true,"screenPermission":true}"#
}

/// A runtime in memory: it answers each command from a table and records
/// every argument list and every stdin it got.
final class FakeSettingsRuntime: CommandRunning, @unchecked Sendable {
  struct Call: Equatable { var executable: String; var arguments: [String]; var input: Data? }
  private let lock = NSLock()
  private var log: [Call] = []
  private var answers: [String: CommandResult] = [:]

  init() {
    answer(["keys", "list", "--json"], SettingsFixtures.keys())
    answer(["computer", "model", "--json"], SettingsFixtures.model)
    answer(["computer", "doctor", "--json"], SettingsFixtures.doctor())
    answer(["--check-access"], SettingsFixtures.panelAccess)
    answer(["--preflight"], SettingsFixtures.capturePreflight)
  }

  func answer(_ arguments: [String], _ json: String) {
    lock.withLock { answers[arguments.joined(separator: " ")] = CommandResult(status: 0, output: Data(json.utf8)) }
  }
  func answer(_ arguments: [String], _ result: CommandResult) {
    lock.withLock { answers[arguments.joined(separator: " ")] = result }
  }
  var recorded: [Call] { lock.withLock { log } }
  func calls(_ first: String) -> [Call] { recorded.filter { $0.arguments.first == first } }

  func run(_ executable: URL, _ arguments: [String], input: Data?) async -> CommandResult {
    lock.withLock {
      log.append(Call(executable: executable.lastPathComponent, arguments: arguments, input: input))
      return answers[arguments.joined(separator: " ")] ?? CommandResult(status: 0)
    }
  }
}

@MainActor
final class FakeDesktop: DesktopRestarting {
  var desktopStatus: OwnedStatus = .running
  var connectionStatus: OwnedStatus = .off
  var restarts = 0
  func restartDesktop() { restarts += 1 }
}

@MainActor
final class SettingsModelTests: XCTestCase {
  private var runtime: FakeSettingsRuntime!
  private var desktop: FakeDesktop!
  private var opened: [URL] = []

  /// A model over the fake runtime, with a native folder whose two helpers exist.
  private func make(native: Bool = true) throws -> SettingsModel {
    runtime = FakeSettingsRuntime()
    desktop = FakeDesktop()
    opened = []
    let folder = try temporaryFolder(self)
    if native {
      try writeScript(folder.appendingPathComponent("native/ClawdTimeTaskPanel"), "exit 1\n")
      try writeScript(folder.appendingPathComponent("native/ClawdTimeTaskCapture"), "exit 1\n")
    }
    return SettingsModel(
      runner: runtime, launcher: folder.appendingPathComponent("bin/clawdtime"),
      native: folder.appendingPathComponent("native", isDirectory: true), desktop: desktop,
      about: AboutInfo(app: "0.4.0", runtime: "0.4.0", commit: "91961f05185c1f011b0afa99a0552cbaf27fa19c"),
      open: { [weak self] url in self?.opened.append(url); return true })
  }

  func testItReadsTheKeysTheModelAndThePermissions() async throws {
    let model = try make()
    await model.load()
    let keys = try XCTUnwrap(model.keys)
    XCTAssertEqual(keys.providers.count, 11)
    XCTAssertEqual(keys.providers.map(\.id).first, "openai")
    let anthropic = try XCTUnwrap(model.provider("anthropic"))
    XCTAssertEqual(anthropic.source, .store)
    XCTAssertTrue(anthropic.canRemove)
    let together = try XCTUnwrap(model.provider("together"))
    XCTAssertEqual(together.source, .environment)
    XCTAssertEqual(together.variable, "TOGETHER_API_KEY")
    XCTAssertFalse(together.canRemove, "a key from the environment is not removed here")
    XCTAssertTrue(together.needsModel)
    XCTAssertTrue(try XCTUnwrap(model.provider("custom")).needsBaseUrl)
    XCTAssertEqual(model.model?.name, "anthropic/claude-opus-5-5")
    XCTAssertEqual(model.model?.from, .store)
    XCTAssertEqual(model.model?.key?.source, .store)
    XCTAssertEqual(model.permissions, PermissionStatus(panelAccessibility: true, panelScreenRecording: false, captureScreenRecording: true))
    XCTAssertNil(model.problem)
    XCTAssertEqual(runtime.recorded.map(\.arguments), [["keys", "list", "--json"], ["computer", "model", "--json"], ["--check-access"], ["--preflight"]])
    XCTAssertEqual(runtime.recorded.suffix(2).map(\.executable), ["ClawdTimeTaskPanel", "ClawdTimeTaskCapture"])
    XCTAssertTrue(runtime.recorded.allSatisfy { $0.input == nil })
  }

  func testAKeyGoesOnlyToStandardInput() async throws {
    let model = try make()
    await model.load()
    let done1 = await model.setKey(provider: "openai", key: "  \(madeUpKey)\n")
    XCTAssertTrue(done1)
    let set = try XCTUnwrap(runtime.calls("keys").first { $0.arguments[1] == "set" })
    XCTAssertEqual(set.arguments, ["keys", "set", "openai"])
    XCTAssertEqual(set.input, Data(madeUpKey.utf8), "the key, trimmed, on stdin")
    for call in runtime.recorded {
      XCTAssertFalse(call.arguments.joined(separator: " ").contains(madeUpKey))
      XCTAssertFalse(call.arguments.joined(separator: " ").contains("STONEPAD"))
      if call != set { XCTAssertNil(call.input) }
    }
    XCTAssertNil(model.problem)
  }

  func testTheRealRunnerHandsTheKeyToTheProcessOnStdinOnly() async throws {
    let folder = try temporaryFolder(self)
    let quoted = folder.path.replacingOccurrences(of: "'", with: "'\\''")
    // A fake runtime: it lists the providers, and records everything a set gets.
    let launcher = try writeScript(folder.appendingPathComponent("runtime/bin/clawdtime"), """
    record='\(quoted)'
    if [ "$1 $2" = "keys list" ]; then echo '\(SettingsFixtures.keys())'; exit 0; fi
    if [ "$1" = "computer" ]; then echo '\(SettingsFixtures.model)'; exit 0; fi
    printf '%s\\n' "$@" > "$record/args"
    env > "$record/env"
    cat > "$record/stdin"

    """)
    let model = SettingsModel(runner: ProcessCommandRunner(environment: childEnvironment(["PATH": "/usr/bin:/bin"])),
                              launcher: launcher, native: nil, desktop: nil,
                              about: AboutInfo(app: "0.4.0", runtime: nil, commit: nil), open: { _ in false })
    let done2 = await model.readKeys()
    XCTAssertTrue(done2)
    let done3 = await model.setKey(provider: "openai", key: madeUpKey)
    XCTAssertTrue(done3)
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("args"), encoding: .utf8), "keys\nset\nopenai\n")
    XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("stdin"), encoding: .utf8), madeUpKey)
    let environment = try String(contentsOf: folder.appendingPathComponent("env"), encoding: .utf8)
    XCTAssertFalse(environment.contains(madeUpKey), "no key in the environment")
    XCTAssertNil(model.problem)
  }

  func testErrorsAreShownPlainlyAndNeverHoldTheKey() async throws {
    let model = try make()
    await model.load()
    runtime.answer(["keys", "set", "openai"], CommandResult(status: 1, errors: [
      "The key has a space, a line end or another character that a key does not have. Paste only the key. Nothing was stored.",
    ]))
    let done4 = await model.setKey(provider: "openai", key: "two words")
    XCTAssertFalse(done4)
    XCTAssertEqual(model.problem, "The key has a space, a line end or another character that a key does not have. Paste only the key. Nothing was stored.")
    // A line that holds the key is never shown, whatever printed it.
    runtime.answer(["keys", "set", "openai"], CommandResult(status: 1, errors: ["bad \(madeUpKey)"]))
    let done5 = await model.setKey(provider: "openai", key: madeUpKey)
    XCTAssertFalse(done5)
    XCTAssertEqual(model.problem, SettingsModel.Text.failed)
    runtime.answer(["keys", "set", "openai"], .notStarted)
    let done6 = await model.setKey(provider: "openai", key: madeUpKey)
    XCTAssertFalse(done6)
    XCTAssertEqual(model.problem, SettingsModel.Text.notStarted)
    runtime.answer(["computer", "model", "--json"], "not json")
    let done7 = await model.readModel()
    XCTAssertFalse(done7)
    XCTAssertEqual(model.problem, SettingsModel.Text.unreadable)
    runtime.answer(["computer", "model", "--json"], #"{"version":2}"#)
    let done8 = await model.readModel()
    XCTAssertFalse(done8)
    XCTAssertEqual(model.problem, SettingsModel.Text.unreadable)
    model.dismissProblem()
    XCTAssertNil(model.problem)
    let done9 = await model.readKeys()
    XCTAssertTrue(done9)
    XCTAssertNil(model.problem)
  }

  func testItRefusesWhatShouldNotReachTheRuntime() async throws {
    let model = try make()
    await model.load()
    let before = runtime.recorded.count
    let done10 = await model.setKey(provider: "--help", key: madeUpKey)
    XCTAssertFalse(done10)
    XCTAssertEqual(model.problem, SettingsModel.Text.unknownProvider)
    let done11 = await model.setKey(provider: "openai", key: "  \n")
    XCTAssertFalse(done11)
    XCTAssertEqual(model.problem, SettingsModel.Text.emptyKey)
    let done12 = await model.removeKey(provider: "together")
    XCTAssertFalse(done12, "a key from the environment stays")
    let done13 = await model.chooseModel(provider: "openai", model: madeUpKey)
    XCTAssertFalse(done13)
    XCTAssertEqual(model.problem, SettingsModel.Text.keyAsModel)
    let done14 = await model.chooseModel(provider: "openai", model: "--base-url")
    XCTAssertFalse(done14)
    XCTAssertEqual(model.problem, SettingsModel.Text.badModel)
    let done15 = await model.chooseModel(provider: "custom", model: "local-vision")
    XCTAssertFalse(done15)
    XCTAssertEqual(model.problem, SettingsModel.Text.needsBase)
    XCTAssertEqual(runtime.recorded.count, before, "nothing ran")
  }

  func testItChoosesAModelOrTheAutomaticChoice() async throws {
    let model = try make()
    await model.load()
    let done16 = await model.chooseModel(provider: "together", model: " meta-vision-11b ")
    XCTAssertTrue(done16)
    let done17 = await model.chooseModel(provider: "custom", model: "local-vision", baseURL: "http://127.0.0.1:8080/v1")
    XCTAssertTrue(done17)
    let done18 = await model.chooseModel(provider: nil)
    XCTAssertTrue(done18)
    let done19 = await model.removeKey(provider: "anthropic")
    XCTAssertTrue(done19)
    let changes = runtime.recorded.map(\.arguments).filter { !$0.contains("--json") && $0.count > 1 }
    XCTAssertEqual(changes, [
      ["computer", "model", "together/meta-vision-11b"],
      ["computer", "model", "custom/local-vision", "--base-url", "http://127.0.0.1:8080/v1"],
      ["computer", "model", "auto"],
      ["keys", "remove", "anthropic"],
    ])
  }

  func testTheDesktopRestartsOnlyWhenIdle() async throws {
    let model = try make()
    await model.load()
    // Idle: it starts again by itself.
    let done20 = await model.setKey(provider: "openai", key: madeUpKey)
    XCTAssertTrue(done20)
    XCTAssertEqual(desktop.restarts, 1)
    XCTAssertEqual(model.restart, .restarting)
    // A task runs: the window offers the restart.
    runtime.answer(["computer", "doctor", "--json"], SettingsFixtures.doctor(admission: "blocked", session: "active"))
    let done21 = await model.chooseModel(provider: nil)
    XCTAssertTrue(done21)
    XCTAssertEqual(desktop.restarts, 1)
    guard case .offer(let reason)? = model.restart else { return XCTFail("no offer") }
    XCTAssertEqual(reason, "A task is running.")
    model.restartNow()
    XCTAssertEqual(desktop.restarts, 2)
    // The phone connection is on: never by itself.
    runtime.answer(["computer", "doctor", "--json"], SettingsFixtures.doctor())
    desktop.connectionStatus = .running
    let done22 = await model.chooseModel(provider: nil)
    XCTAssertTrue(done22)
    XCTAssertEqual(desktop.restarts, 2)
    XCTAssertEqual(model.restart, .offer("The phone connection is on."))
    // The desktop does not answer: never by itself.
    desktop.connectionStatus = .off
    runtime.answer(["computer", "doctor", "--json"], CommandResult(status: 1))
    let done23 = await model.chooseModel(provider: nil)
    XCTAssertTrue(done23)
    XCTAssertEqual(desktop.restarts, 2)
    XCTAssertEqual(model.restart, .offer("The desktop did not say it is idle."))
    // Not running: it reads the change when it starts.
    desktop.desktopStatus = .off
    let done24 = await model.chooseModel(provider: nil)
    XCTAssertTrue(done24)
    XCTAssertEqual(model.restart, .nextStart)
    XCTAssertEqual(desktop.restarts, 2)
  }

  func testPermissionsAreReadLiveAndOpenTheRightPane() async throws {
    let model = try make()
    await model.checkPermissions()
    XCTAssertEqual(model.permissions?.panelScreenRecording, false)
    runtime.answer(["--check-access"], #"{"accessibility":true,"screenRecording":true,"version":1}"#)
    await model.checkPermissions()
    XCTAssertEqual(model.permissions?.panelScreenRecording, true)
    XCTAssertTrue(model.openSettings(.screenRecording))
    XCTAssertTrue(model.openSettings(.accessibility))
    XCTAssertEqual(opened.map(\.absoluteString), [
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ])
    // A helper that is not in the runtime is never run, and reads as unknown.
    let missing = try make(native: false)
    await missing.checkPermissions()
    XCTAssertEqual(missing.permissions, PermissionStatus(panelAccessibility: nil, panelScreenRecording: nil, captureScreenRecording: nil))
    XCTAssertTrue(runtime.recorded.isEmpty)
  }

  func testNoRuntimeSaysSoPlainly() async {
    let model = SettingsModel(runner: FakeSettingsRuntime(), launcher: nil, native: nil, desktop: nil,
                              about: AboutInfo(app: "0.4.0", runtime: nil, commit: nil), open: { _ in false })
    await model.load()
    XCTAssertEqual(model.problem, SettingsModel.Text.noRuntime)
    XCTAssertNil(model.keys)
  }

  func testTheWordsAreShortAndPlain() throws {
    let report = try JSONDecoder().decode(ModelReport.self, from: Data(SettingsFixtures.missingKey.utf8))
    XCTAssertEqual(SettingsWords.modelProblem(report), "No key for Groq. Add one in Model keys.")
    let environment = try JSONDecoder().decode(ModelReport.self, from: Data(SettingsFixtures.environmentModel.utf8))
    XCTAssertEqual(SettingsWords.modelSource(environment), "Set in the environment: CLAWDTIME_COMPUTER_MODEL. It wins over a choice here.")
    XCTAssertEqual(SettingsWords.modelKey(environment), "Key: from the environment, OPENAI_API_KEY.")
    XCTAssertEqual(SettingsWords.restart(.restarting), "Saved. The desktop restarts to use it.")
    XCTAssertEqual(AboutInfo(app: "0.4.0", runtime: "0.4.0", commit: "91961f05185c1f0").shortCommit, "91961f0")
    let keys = try JSONDecoder().decode(KeysReport.self, from: Data(SettingsFixtures.keys().utf8))
    XCTAssertEqual(SettingsWords.key(keys.providers[2]), "From the environment: TOGETHER_API_KEY.")
    XCTAssertEqual(SettingsWords.defaultModel(keys.providers[2]), "you choose the model")
    XCTAssertEqual(SettingsWords.key(keys.providers[1]), "Stored on this Mac.")
    XCTAssertEqual(SettingsWords.defaultModel(keys.providers[1]), "claude-opus-5-5")
    XCTAssertEqual(SettingsWords.name(keys.providers[10]), "Custom service")
  }

  func testTheMainMenuOpensSettingsWithCommandComma() {
    let items = MainMenu.make().items.flatMap { $0.submenu?.items ?? [] }
    let settings = items.first { $0.title == "Settings…" }
    XCTAssertEqual(settings?.keyEquivalent, ",")
    XCTAssertEqual(settings?.action, #selector(AppDelegate.showSettings(_:)))
    XCTAssertNil(settings?.target, "it goes up the responder chain to the app delegate")
  }
}
