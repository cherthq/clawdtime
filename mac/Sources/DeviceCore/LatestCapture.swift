import Foundation

/// One replaceable, timestamped source sample; never restamps a cached image.
public final class LatestCapture<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: (Value, TimeInterval)?
  private var closed = false
  public init() {}
  public func put(_ sample: Value, capturedAt: TimeInterval) {
    lock.lock(); defer { lock.unlock() }
    guard !closed, capturedAt.isFinite else { return }
    if let value, value.1 >= capturedAt { return }
    value = (sample, capturedAt)
  }
  public func latest(now: TimeInterval, maximumAge: TimeInterval) -> Value? {
    lock.lock(); defer { lock.unlock() }
    guard !closed, let value, now >= value.1, now - value.1 < maximumAge else { return nil }
    return value.0
  }
  public func close() {
    lock.lock(); defer { lock.unlock() }
    closed = true; value = nil
  }
}
