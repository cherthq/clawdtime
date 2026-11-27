import Darwin
import Foundation

/// The result of one short command of the runtime.
public struct CommandResult: Equatable, Sendable {
  public var status: Int32
  public var output: Data
  /// The last lines of its stderr, for a plain message.
  public var errors: [String]
  public init(status: Int32, output: Data = Data(), errors: [String] = []) {
    self.status = status; self.output = output; self.errors = errors
  }
  /// The command could not start at all.
  public static let notStarted = CommandResult(status: 127)
}

/// Runs one short command and waits for it. `input` goes to its stdin, and
/// nowhere else: a key never goes in the arguments or the environment.
/// Tests replace it.
public protocol CommandRunning: Sendable {
  func run(_ executable: URL, _ arguments: [String], input: Data?) async -> CommandResult
}

/// A real child process with pipes. Its stdin is /dev/null when no input is
/// given. A command that takes longer than the timeout is ended.
public struct ProcessCommandRunner: CommandRunning {
  public var environment: [String: String]
  public var timeout: TimeInterval
  public init(environment: [String: String] = childEnvironment(), timeout: TimeInterval = 30) {
    self.environment = environment; self.timeout = timeout
  }

  public func run(_ executable: URL, _ arguments: [String], input: Data?) async -> CommandResult {
    let environment = environment, timeout = timeout
    return await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(returning: Self.runNow(executable, arguments, input: input, environment: environment, timeout: timeout))
      }
    }
  }

  private static func runNow(_ executable: URL, _ arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) -> CommandResult {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    let output = Pipe(), errors = Pipe()
    let stdin = input.map { _ in Pipe() }
    process.standardInput = stdin ?? FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = errors
    if let stdin { _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) }
    let ended = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in ended.signal() }
    do { try process.run() } catch { return .notStarted }

    let group = DispatchGroup()
    let read = Collected()
    for (handle, isOutput) in [(output.fileHandleForReading, true), (errors.fileHandleForReading, false)] {
      group.enter()
      DispatchQueue.global().async {
        // Bounded: a runaway command cannot fill the app's memory.
        let limit = isOutput ? 1 << 20 : 64 << 10
        var collected = Data()
        while true {
          let chunk = handle.availableData
          if chunk.isEmpty { break }
          if collected.count < limit { collected.append(chunk.prefix(limit - collected.count)) }
        }
        read.lock.withLock { if isOutput { read.output = collected } else { read.errors = collected } }
        group.leave()
      }
    }
    if let stdin, let input {
      try? stdin.fileHandleForWriting.write(contentsOf: input)
      try? stdin.fileHandleForWriting.close()
    }
    if ended.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      if ended.wait(timeout: .now() + 2) == .timedOut {
        kill(process.processIdentifier, SIGKILL)
        ended.wait()
      }
    }
    _ = group.wait(timeout: .now() + 2)
    let text = read.lock.withLock { String(decoding: read.errors, as: UTF8.self) }
    let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    return CommandResult(status: process.terminationStatus, output: read.lock.withLock { read.output }, errors: Array(lines.suffix(8)))
  }
}

/// What the two readers of one command collected.
private final class Collected: @unchecked Sendable {
  let lock = NSLock()
  var output = Data()
  var errors = Data()
}
