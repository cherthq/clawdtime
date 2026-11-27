import CryptoKit
import Foundation
import XCTest
@testable import ClawdTimeAppCore

/// A made-up key. It is only ever written to the fake engine's stdin.
let madeUpKey = "sk-made-up-0000-STONEPAD"

/// A temporary folder with a space in its name, removed after the test.
func temporaryFolder(_ test: XCTestCase) throws -> URL {
  let folder = FileManager.default.temporaryDirectory
    .appendingPathComponent("ClawdTime App Tests \(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  test.addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
  return folder
}

/// Writes an executable /bin/sh script.
@discardableResult
func writeScript(_ url: URL, _ body: String) throws -> URL {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try ("#!/bin/sh\n" + body).write(to: url, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
  return url
}

/// A fake `clawdtime onboard --json`. It records its arguments and environment
/// next to itself, speaks the protocol, and checks that the key arrives on stdin.
enum FakeEngine {
  static func record(_ folder: URL) -> String {
    let quoted = folder.path.replacingOccurrences(of: "'", with: "'\\''")
    return """
    record='\(quoted)'
    printf '%s\\n' "$@" > "$record/args"
    env > "$record/env"

    """
  }

  /// The whole flow: hello, preflight, a secret model key, a skippable phone step, done.
  static func fullFlow(_ folder: URL) -> String {
    record(folder) + """
    echo '{"type":"hello","protocol":1,"version":"0.4.0"}'
    echo '{"type":"step","id":"preflight","state":"in_progress","title":"Check this Mac"}'
    echo '{"type":"step","id":"preflight","state":"ready","title":"Check this Mac","detail":"Apple silicon, macOS 15"}'
    echo '{"type":"step","id":"model","state":"needs_input","title":"Model key","detail":"Paste the key of your model provider.","input":{"kind":"secret","prompt":"Model key"}}'
    IFS= read -r line || exit 4
    case "$line" in
      '{"id":"model","type":"input","value":"\(madeUpKey)"}') echo ok > "$record/key-arrived" ;;
      *) echo '{"type":"step","id":"model","state":"failed","title":"Model key","detail":"wrong input"}'; exit 5 ;;
    esac
    echo '{"type":"log","level":"info","message":"Key stored in protected storage."}'
    echo '{"type":"step","id":"model","state":"ready","title":"Model key","detail":"Stored."}'
    echo '{"type":"step","id":"phone","state":"needs_input","title":"Your phone","input":{"kind":"phone","prompt":"Phone number"}}'
    IFS= read -r line || exit 4
    case "$line" in
      '{"action":"skip","id":"phone","type":"action"}') echo '{"type":"step","id":"phone","state":"skipped","title":"Your phone"}' ;;
      *) exit 6 ;;
    esac
    echo '{"type":"done","ready":true,"report":[{"id":"preflight","state":"ready"},{"id":"model","state":"ready"},{"id":"desktop","state":"ready"},{"id":"phone","state":"skipped"},{"id":"connection","state":"skipped"}]}'
    exit 0
    """
  }

  /// Says hello, then waits for cancel; leaves 0 on cancel.
  static func waitsForCancel(_ folder: URL, protocolVersion: Int = 1) -> String {
    record(folder) + """
    echo '{"type":"hello","protocol":\(protocolVersion),"version":"0.4.0"}'
    while IFS= read -r line; do
      case "$line" in
        '{"type":"cancel"}') echo cancel > "$record/cancelled"; exit 0 ;;
      esac
    done
    exit 0
    """
  }
}

/// A runtime folder with the release layout and a manifest of real hashes.
enum FakeRuntime {
  @discardableResult
  static func make(at root: URL, engine: String, version: String = "0.4.0", arch: String = "arm64") throws -> URL {
    try writeScript(root.appendingPathComponent("bin/clawdtime"), engine)
    try writeScript(root.appendingPathComponent("node/bin/node"), "exit 0\n")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("app/native"), withIntermediateDirectories: true)
    try #"{"name":"clawdtime","version":"\#(version)","type":"module"}"#.write(to: root.appendingPathComponent("app/package.json"), atomically: true, encoding: .utf8)
    try #"{"version":"\#(version)","commit":"0000000000000000000000000000000000000000"}"#.write(to: root.appendingPathComponent("app/release.json"), atomically: true, encoding: .utf8)
    try writeScript(root.appendingPathComponent("app/native/ClawdTimeTaskPanel"), "exit 0\n")
    try writeManifest(root, version: version, arch: arch)
    return root
  }

  static func writeManifest(_ root: URL, version: String = "0.4.0", arch: String = "arm64", extra: [String: String] = [:]) throws {
    var files: [String: String] = [:]
    for path in ["bin/clawdtime", "node/bin/node", "app/package.json", "app/release.json", "app/native/ClawdTimeTaskPanel"] {
      let data = try Data(contentsOf: root.appendingPathComponent(path))
      files[path] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    files.merge(extra) { $1 }
    let manifest: [String: Any] = ["name": "clawdtime", "version": version, "commit": "0000000000000000000000000000000000000000", "arch": arch, "node": "24.0.0", "files": files]
    try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(to: root.appendingPathComponent("manifest.json"))
  }
}

/// An engine that the test drives by hand, with no process.
final class ScriptedEngine: EngineControlling {
  var onEvent: ((EngineEvent) -> Void)?
  var onUnreadableLine: (() -> Void)?
  var onExit: ((Int32, [String]) -> Void)?
  var started = false
  var sent: [EngineCommand] = []
  var cancelled = false
  func start() throws { started = true }
  func send(_ command: EngineCommand) { sent.append(command) }
  func cancel(grace: TimeInterval) { cancelled = true; sent.append(.cancel) }
  func emit(_ line: String) { onEvent?(try! EngineEvent.decode(line: line)) }
}

@MainActor
final class RecordingOwner: ProcessOwning {
  var starts: [Bool] = []
  var stops = 0
  var isActive: Bool { !starts.isEmpty && stops == 0 }
  func start(connection: Bool) { starts.append(connection) }
  func stop(completion: @escaping @MainActor () -> Void) { stops += 1; completion() }
}
