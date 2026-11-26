import Foundation

/// A complete frame can precede ScreenCaptureKit's successful-start callback.
/// Do not stop/publish that frame until both have arrived. Failure closes the gate.
public final class CaptureStartGate<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var ready = false
  private var closed = false
  private var pending: Value?

  public init() {}

  public func receive(_ value: Value) -> Value? {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return nil }
    if ready { closed = true; return value }
    if pending == nil { pending = value }
    return nil
  }

  public func started() -> Value? {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return nil }
    ready = true
    guard let pending else { return nil }
    self.pending = nil; closed = true
    return pending
  }

  public func cancel() {
    lock.lock(); defer { lock.unlock() }
    closed = true; pending = nil
  }
}
