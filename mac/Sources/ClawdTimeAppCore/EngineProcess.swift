import Foundation

/// What the setup window needs from the engine. Tests replace it.
public protocol EngineControlling: AnyObject {
  var onEvent: ((EngineEvent) -> Void)? { get set }
  var onUnreadableLine: (() -> Void)? { get set }
  var onExit: ((Int32, [String]) -> Void)? { get set }
  func start() throws
  func send(_ command: EngineCommand)
  /// Sends `cancel`, closes stdin, and ends the engine if it has not left after the grace time.
  func cancel(grace: TimeInterval)
}

/// The environment for every process the app starts. A Mac app opened from
/// Finder has a short PATH, so the system folders are always on it. Nothing
/// secret is ever added here.
public func childEnvironment(_ base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
  var environment = base
  let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  var path = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
  for folder in system where !path.contains(folder) { path.append(folder) }
  environment["PATH"] = path.joined(separator: ":")
  if environment["HOME"] == nil { environment["HOME"] = NSHomeDirectory() }
  // A terminal is never attached: the engine speaks JSON only.
  environment.removeValue(forKey: "TERM_PROGRAM")
  return environment
}

/// `runtime/bin/clawdtime onboard --json`, with pipes on stdin, stdout and stderr.
public final class EngineProcess: EngineControlling, @unchecked Sendable {
  public var onEvent: ((EngineEvent) -> Void)?
  public var onUnreadableLine: (() -> Void)?
  public var onExit: ((Int32, [String]) -> Void)?

  public let executable: URL
  public let arguments: [String]
  private let environment: [String: String]
  private let deliver: DispatchQueue
  private let io = DispatchQueue(label: "com.clawdtime.app.engine-io")
  private let process = Process()
  private let input = Pipe(), output = Pipe(), errors = Pipe()
  // Only touched on `io`.
  private var lines = LineBuffer()
  private var errorLines = LineBuffer(limit: 8192)
  private var tail = TailBuffer()
  private var inputClosed = false
  private var outputClosed = false
  private var exitStatus: Int32?
  private var finished = false

  public init(executable: URL, arguments: [String], environment: [String: String] = childEnvironment(), deliver: DispatchQueue = .main) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.deliver = deliver
  }

  public var processIdentifier: Int32 { process.processIdentifier }
  public var isRunning: Bool { process.isRunning }

  public func start() throws {
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errors
    // A write after the engine has gone fails with EPIPE instead of a signal.
    _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      self?.io.async { self?.consumeOutput(data) }
    }
    errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      self?.io.async { self?.consumeErrors(data) }
    }
    process.terminationHandler = { [weak self] process in
      let status = process.terminationStatus
      self?.io.async { self?.exited(status) }
    }
    try process.run()
  }

  public func send(_ command: EngineCommand) {
    let data = command.line()
    io.async { [self] in
      guard !inputClosed else { return }
      do { try input.fileHandleForWriting.write(contentsOf: data) } catch { closeInputNow() }
    }
  }

  public func closeInput() { io.async { [self] in closeInputNow() } }

  public func cancel(grace: TimeInterval) {
    send(.cancel)
    closeInput()
    io.asyncAfter(deadline: .now() + grace) { [self] in
      guard process.isRunning else { return }
      process.terminate()
      io.asyncAfter(deadline: .now() + grace) { [self] in
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      }
    }
  }

  private func closeInputNow() {
    guard !inputClosed else { return }
    inputClosed = true
    try? input.fileHandleForWriting.close()
  }

  private func consumeOutput(_ data: Data) {
    if data.isEmpty {
      output.fileHandleForReading.readabilityHandler = nil
      if let last = lines.finish() { handle(line: last) }
      outputClosed = true
      finishIfDone()
      return
    }
    for line in lines.append(data) { handle(line: line) }
  }

  private func handle(line: String) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    do {
      let event = try EngineEvent.decode(line: line)
      deliver.async { [weak self] in self?.onEvent?(event) }
    } catch {
      deliver.async { [weak self] in self?.onUnreadableLine?() }
    }
  }

  private func consumeErrors(_ data: Data) {
    if data.isEmpty {
      errors.fileHandleForReading.readabilityHandler = nil
      if let last = errorLines.finish() { tail.append(last) }
      return
    }
    for line in errorLines.append(data) { tail.append(line) }
  }

  private func exited(_ status: Int32) {
    exitStatus = status
    closeInputNow()
    finishIfDone()
    // A child that kept stdout open must not hold the exit back for long.
    io.asyncAfter(deadline: .now() + 2) { [self] in
      outputClosed = true
      finishIfDone()
    }
  }

  private func finishIfDone() {
    guard !finished, outputClosed, let status = exitStatus else { return }
    finished = true
    let details = tail.lines
    deliver.async { [weak self] in self?.onExit?(status, details) }
  }
}
