import Darwin
import Foundation

/// A long-lived child the app owns. It starts in its own process group, so the
/// app can end it and anything it left behind. Its stdin is /dev/null, its
/// stdout comes back line by line, and both streams go to a private log file.
public final class ChildProcess: @unchecked Sendable {
  public enum Ending: Equatable, Sendable {
    case exited(Int32), signaled(Int32)
    init(status: Int32) {
      let signal = status & 0x7F
      self = signal == 0 ? .exited((status >> 8) & 0xFF) : .signaled(signal)
    }
  }

  public let pid: pid_t
  private let lock = NSLock()
  private var ended: Ending?
  /// The read end of stdout. It lives as long as the child object does.
  private var reader: FileHandle?

  public enum SpawnError: Error, Equatable { case pipe, spawn(Int32) }

  private init(pid: pid_t) { self.pid = pid }

  /// Starts `executable` with `arguments`. `onLine` gets each stdout line and
  /// `onExit` the ending, both on `queue`.
  public static func spawn(
    executable: URL, arguments: [String], environment: [String: String], log: URL?,
    queue: DispatchQueue = .main, onLine: @escaping (String) -> Void, onExit: @escaping (Ending) -> Void
  ) throws -> ChildProcess {
    var pipe: [Int32] = [0, 0]
    guard Darwin.pipe(&pipe) == 0 else { throw SpawnError.pipe }
    let (readEnd, writeEnd) = (pipe[0], pipe[1])

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, writeEnd, 1)
    if let log {
      posix_spawn_file_actions_addopen(&actions, 2, log.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    } else {
      posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    }

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // Its own process group; default signal handlers and an empty mask; no
    // other descriptor of the app leaks into it.
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT))
    posix_spawnattr_setpgroup(&attributes, 0)
    var all = sigset_t(), none = sigset_t()
    sigfillset(&all); sigemptyset(&none)
    posix_spawnattr_setsigdefault(&attributes, &all)
    posix_spawnattr_setsigmask(&attributes, &none)

    let argv = ([executable.path] + arguments).map { strdup($0) } + [nil]
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
      argv.forEach { free($0) }
      envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let result = posix_spawn(&pid, executable.path, &actions, &attributes, argv, envp)
    close(writeEnd)
    guard result == 0 else {
      close(readEnd)
      throw SpawnError.spawn(result)
    }

    let child = ChildProcess(pid: pid)
    let logHandle = log.flatMap { try? FileHandle(forWritingTo: $0) }
    _ = try? logHandle?.seekToEnd()
    let reader = FileHandle(fileDescriptor: readEnd, closeOnDealloc: true)
    child.reader = reader
    let io = DispatchQueue(label: "com.clawdtime.app.child-\(pid)")
    var buffer = LineBuffer(limit: 64 * 1024)
    reader.readabilityHandler = { handle in
      let data = handle.availableData
      io.async {
        if data.isEmpty {
          handle.readabilityHandler = nil
          if let last = buffer.finish() { queue.async { onLine(last) } }
          try? logHandle?.close()
          child.lock.withLock { child.reader = nil }
          return
        }
        try? logHandle?.write(contentsOf: data)
        for line in buffer.append(data) { queue.async { onLine(line) } }
      }
    }
    let waiter = Thread {
      var status: Int32 = 0
      while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
      let ending = Ending(status: status)
      child.lock.withLock { child.ended = ending }
      // Lines already read reach `onLine` before the exit does.
      io.async { queue.async { onExit(ending) } }
    }
    waiter.name = "com.clawdtime.app.wait-\(pid)"
    waiter.start()
    return child
  }

  public var isRunning: Bool { lock.withLock { ended == nil } }
  public var ending: Ending? { lock.withLock { ended } }

  /// Signals the child alone.
  public func signal(_ signal: Int32) {
    guard isRunning else { return }
    kill(pid, signal)
  }

  /// Signals the child's whole process group, which outlives the child itself.
  public func signalGroup(_ signal: Int32) {
    kill(-pid, signal)
  }
}
