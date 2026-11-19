import Foundation

public enum TaskCaptureStreamPolicy {
  public static func withinLifecycleDeadline(elapsedSeconds: Double) -> Bool {
    elapsedSeconds.isFinite && elapsedSeconds >= 0 && elapsedSeconds < 1.25
  }

  public static func admits(complete: Bool, valid: Bool, frameHostTime: UInt64,
                            requestHostTime: UInt64, callbackHostTime: UInt64,
                            width: Int, height: Int, expectedWidth: Int, expectedHeight: Int) -> Bool {
    complete && valid && requestHostTime > 0 && frameHostTime >= requestHostTime
      && frameHostTime <= callbackHostTime && width > 0 && height > 0
      && width == expectedWidth && height == expectedHeight
  }
}

/// Fences a process deadline against normal completion. A claimed deadline can
/// never later become a successful completion; neither transition is repeatable.
public final class TaskCaptureDeadline: @unchecked Sendable {
  private let lock = NSLock()
  private enum State { case pending, complete, expired }
  private var state = State.pending
  public init() {}
  public func expire() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .pending else { return false }
    state = .expired; return true
  }
  public func finish() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == .pending else { return false }
    state = .complete; return true
  }
}

/// One transient frame. Invalidation rejects pending and late callbacks and drops
/// retained data. The stream owner still has to join the actual stop operation.
public final class TaskCaptureFrameMailbox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var accepting = true
  private var result: Result<Value, Error>?
  private var waiter: CheckedContinuation<Value, Error>?
  public init() {}
  @discardableResult public func offer(_ value: Result<Value, Error>) -> Bool {
    lock.lock()
    guard accepting, result == nil else { lock.unlock(); return false }
    result = value
    let pending = waiter; waiter = nil
    lock.unlock()
    pending?.resume(with: value)
    return true
  }
  public func invalidate() {
    lock.lock()
    accepting = false; result = nil
    let pending = waiter; waiter = nil
    lock.unlock()
    pending?.resume(throwing: CancellationError())
  }
  public func value() async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if !accepting { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
      if let result { lock.unlock(); continuation.resume(with: result); return }
      guard waiter == nil else { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
      waiter = continuation; lock.unlock()
    }
  }
}

public enum TaskCaptureStreamError: Error { case cleanupUnconfirmed }

/// No detached start/stop and no retry. Cancellation while start is pending must
/// wait for that start to settle, then stop once. The native helper separately
/// enforces a hard process deadline for a framework callback that never settles.
public enum TaskCaptureStreamAttempt {
  public static func acquire<Value>(start: () async throws -> Void,
                                    frame: () async throws -> Value,
                                    invalidate: @escaping @Sendable () -> Void,
                                    stop: () async throws -> Void) async throws -> Value {
    try await withTaskCancellationHandler(operation: {
      var stopAttempted = false
      var startAttempted = false
      do {
        try Task.checkCancellation()
        startAttempted = true
        try await start()
        try Task.checkCancellation()
        let value = try await frame()
        try Task.checkCancellation()
        invalidate()
        stopAttempted = true
        do { try await stop() } catch { throw TaskCaptureStreamError.cleanupUnconfirmed }
        try Task.checkCancellation()
        return value
      } catch {
        invalidate()
        if startAttempted && !stopAttempted {
          do { try await stop() } catch { throw TaskCaptureStreamError.cleanupUnconfirmed }
        }
        throw error
      }
    }, onCancel: invalidate)
  }
}
