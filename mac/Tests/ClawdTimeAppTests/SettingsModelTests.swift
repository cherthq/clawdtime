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

  /// The settings that apply at once. Every other one applies when the desktop starts again.
  static let now: Set<String> = ["mascot.style", "mascot.size", "mascot.eye", "voice.replies", "voice.speed", "memory", "away"]

  static let voices = #"["alloy","ash","ballad","cedar","coral","echo","fable","marin","nova","onyx","sage","shimmer","verse"]"#

  /// `clawdtime settings --json` of a made-up Mac. `speed` is the preset in use; `ask` and `browser` choose those rows.
  static func settings(speed: String = "balanced", ask: String = "risky", browserFrom: String = "environment",
                       presets: Bool = true) -> String {
    func row(_ id: String, _ kind: String, _ value: String, _ def: String, _ from: String = "default", variable: String? = nil,
             choices: String? = nil, range: (Double, Double)? = nil) -> String {
      let applies = now.contains(id) ? "now" : "restart"
      var text = #"{"id":"\#(id)","kind":"\#(kind)","value":\#(value),"default":\#(def),"from":"\#(from)","applies":"\#(applies)","variable":\#(variable.map { #""\#($0)""# } ?? "null")"#
      if let choices { text += #","choices":\#(choices)"# }
      if let range { text += #","min":\#(range.0),"max":\#(range.1)"# }
      return text + "}"
    }
    let rows = [
      row("mascot.style", "choice", #""jet""#, #""flint""#, "store", choices: #"["flint","jet","jade","lapis","amber","garnet","amethyst","pebble","core","neon","iris"]"#),
      row("mascot.size", "number", "0.9", "0.7", "store", range: (0.5, 1.5)),
      row("mascot.eye", "boolean", "false", "false"),
      row("cursor.pace", "choice", #""auto""#, #""auto""#, variable: "CLAWDTIME_CURSOR_PACE", choices: #"["auto","calm","fast"]"#),
      row("voice.replies", "boolean", "true", "true"),
      row("voice.name", "choice", #""coral""#, #""alloy""#, "store", variable: "CLAWDTIME_VOICE", choices: voices),
      row("voice.speed", "number", "1", "1", range: (0.5, 2)),
      row("vocabulary", "text", #""Brightwave, Ledgerly""#, #""""#, "store", variable: "CLAWDTIME_VOCABULARY"),
      row("memory", "boolean", "true", "false", "store"),
      row("away", "boolean", "false", "false"),
      row("speed", "choice", #""\#(speed)""#, #""best""#, choices: presets ? #"["fast","balanced","best"]"# : "[]"),
      row("model.planner", "model", #""gpt-6.2-sol""#, #""gpt-6.2-astra""#, "store", variable: "CLAWDTIME_COMPUTER_MODEL"),
      row("model.chat", "model", #""gpt-4.1-mini""#, #""gpt-6.2-astra""#, "store", variable: "CLAWDTIME_SUPERVISOR_MODEL"),
      row("computer", "boolean", "true", "false", "store"),
      row("computer.ask", "choice", #""\#(ask)""#, #""risky""#, ask == "risky" ? "default" : "store", variable: "CLAWDTIME_COMPUTER_TRUST", choices: #"["risky","never"]"#),
      row("computer.browser", "choice", #""own""#, #""off""#, browserFrom, variable: "CLAWDTIME_COMPUTER_BROWSER", choices: #"["off","on","own"]"#),
      row("reach", "boolean", "true", "true", variable: "CLAWDTIME_COMPUTER_REACH"),
      row("reach.wait", "number", "45", "45", variable: "CLAWDTIME_COMPUTER_REACH_SECONDS", range: (0, 600)),
    ]
    let list = presets ? #"[{"id":"fast","planner":"gpt-5.4","chat":"gpt-4.1-mini","summary":"About 1.5 s for each step. 76 of 76 screens right, 22 of 23 long tasks done."},{"id":"balanced","planner":"gpt-6.2-sol","chat":"gpt-4.1-mini","summary":"About 2 s for each step. 74 of 76 screens right, 23 of 23 long tasks done."},{"id":"best","planner":"gpt-6.2-astra","chat":"gpt-6.2-astra","summary":"About 3 s for each step. 76 of 76 screens right, 23 of 23 long tasks done."}]"# : "[]"
    return #"{"version":1,"store":"/Users/riverchat/.local/share/clawdtime/settings.json","problem":null,"settings":[\#(rows.joined(separator: ","))],"speed":{"provider":"\#(presets ? "openai" : "groq")","presets":\#(list)}}"#
  }

  static let privacy = #"""
  {"version":1,"folder":"/Users/riverchat/.local/share/clawdtime","items":[
  {"id":"chat","name":"Chat history","what":"Your conversations with ClawdTime.","path":"/Users/riverchat/.local/share/clawdtime/agents","exists":true,"count":4,"bytes":182340,"removable":true},
  {"id":"voice","name":"Spoken replies","what":"The last recording and spoken answer of a talk.","path":"/Users/riverchat/.local/share/clawdtime/agents/voice","exists":true,"count":1,"bytes":48211,"removable":true},
  {"id":"memory","name":"Memory","what":"What you told ClawdTime to keep, while memory is on.","path":"/Users/riverchat/.local/share/clawdtime/memory/facts.json","exists":true,"count":7,"bytes":2310,"removable":false},
  {"id":"requests","name":"Record of computer requests","what":"Each request and its steps, by kind and name. No picture and no typed text.","path":"/Users/riverchat/.local/share/clawdtime/computer/journal.json","exists":true,"count":1,"bytes":40112,"removable":false},
  {"id":"timing","name":"Step times","what":"The time of each step, when step timing is on.","path":"/Users/riverchat/.local/share/clawdtime/computer/timing.json","exists":false,"count":0,"bytes":0,"removable":true},
  {"id":"keys","name":"Model keys","what":"The keys of your model providers. Only you can read the file.","path":"/Users/riverchat/.local/share/clawdtime/computer/keys.json","exists":true,"count":2,"bytes":310,"removable":false},
  {"id":"settings","name":"Settings","what":"The choices that you make in Settings.","path":"/Users/riverchat/.local/share/clawdtime/settings.json","exists":true,"count":1,"bytes":240,"removable":false},
  {"id":"pairing","name":"Phone pairing","what":"The pairing of this Mac with the shared number.","path":"/Users/riverchat/.config/clawdtime/shared/connection.json","exists":true,"count":1,"bytes":620,"removable":false},
  {"id":"logs","name":"Logs","what":"What the desktop and the phone connection wrote.","path":"/Users/riverchat/Library/Logs/ClawdTime","exists":true,"count":3,"bytes":912003,"removable":false}]}
  """#.replacingOccurrences(of: "\n", with: "")

  static func phone(paired: Bool = true, connection: String = "running") -> String {
    paired
      ? #"{"version":1,"pairing":"paired","origin":"https://coordinator.example","view":true,"control":true,"connection":"\#(connection)","owner":{"ending":"ends in 00","consent":"yes"},"calls":"ready (Chert Calls API). When a question waits, ClawdTime reaches you this way","texts":"ready. When a question waits, ClawdTime reaches you this way"}"#
      : #"{"version":1,"pairing":"none","origin":null,"view":null,"control":null,"connection":"off","owner":null,"calls":"not reported: start the desktop service with the computer worker on. It says this within a minute","texts":"not reported: start the desktop service with the computer worker on. It says this within a minute"}"#
  }

  static func update(newer: Bool, page: String? = "https://github.com/cherthq/clawdtime/releases/latest") -> String {
    #"{"version":1,"current":"0.4.0","latest":"\#(newer ? "0.5.0" : "0.4.0")","commit":"\#(String(repeating: "a", count: 40))","newer":\#(newer),"page":\#(page.map { #""\#($0)""# } ?? "null")}"#
  }
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
    answer(["settings", "--json"], SettingsFixtures.settings())
    answer(["settings", "privacy", "--json"], SettingsFixtures.privacy)
    answer(["settings", "phone", "--json"], SettingsFixtures.phone())
    answer(["settings", "update", "--json"], SettingsFixtures.update(newer: true))
    answer(["settings", "forget-memory", "--yes", "--json"], #"{"version":1,"ok":true,"removed":7}"#)
    answer(["settings", "delete-history", "--yes", "--json"], #"{"version":1,"ok":true,"moved":["/Users/riverchat/.local/share/clawdtime/agents/chat.jsonl"],"kept":["memory"],"applies":"restart"}"#)
    answer(["settings", "phone", "unpair", "--yes", "--json"], #"{"version":1,"result":"unpaired","sentence":"This Mac is unpaired. The pairing file is in the Trash."}"#)
  }

  /// `settings set NAME VALUE --json` and `settings reset NAME --json`, as the runtime answers them.
  private func change(_ arguments: [String]) -> CommandResult? {
    guard arguments.count >= 4, arguments[0] == "settings", ["set", "reset"].contains(arguments[1]), arguments.last == "--json" else { return nil }
    let id = arguments[2]
    let value = arguments[1] == "set" ? arguments[3] : "default"
    let json = Double(value) != nil || value == "on" || value == "off" ? (value == "on" ? "true" : value == "off" ? "false" : value) : #""\#(value)""#
    let applies = SettingsFixtures.now.contains(id) ? "now" : "restart"
    return CommandResult(status: 0, output: Data(#"{"version":1,"ok":true,"id":"\#(id)","value":\#(json),"from":"store","applies":"\#(applies)","shadowed":null}"#.utf8))
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
      return answers[arguments.joined(separator: " ")] ?? change(arguments) ?? CommandResult(status: 0)
    }
  }
}

@MainActor
final class FakeDesktop: DesktopRestarting {
  var desktopStatus: OwnedStatus = .running
  var connectionStatus: OwnedStatus = .off
  var restarts = 0
  var drops = 0
  func restartDesktop() { restarts += 1 }
  func dropConnection(then: @escaping @MainActor () -> Void) {
    drops += 1
    connectionStatus = .off
    then()
  }
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
    XCTAssertEqual(runtime.recorded.map(\.arguments), [["keys", "list", "--json"], ["computer", "model", "--json"], ["settings", "--json"], ["--check-access"], ["--preflight"]])
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
