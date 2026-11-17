import Foundation

/// Holds captured pixels only until stream-stop acknowledgment or its deadline.
/// All state is lock protected; completion is removed before invocation.
public final class CaptureStopGate<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var pending: Result<Value, Error>?
  private var completion: ((Result<Value, Error>) -> Void)?
  private var timer: DispatchWorkItem?

  public init(result: Result<Value, Error>, timeout: TimeInterval = 0.35,
    completion: @escaping (Result<Value, Error>) -> Void) {
    pending = result; self.completion = completion
    let timer = DispatchWorkItem { [self] in
      resolve(failure: HelperError(503, "Selected camera stream stop was not acknowledged before the deadline."))
    }
    self.timer = timer
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
  }

  public func acknowledged(error: Error?) {
    resolve(failure: error == nil ? nil : HelperError(503, "Selected camera stream did not stop cleanly; frame discarded."))
  }

  private func resolve(failure: Error?) {
    lock.lock()
    guard let completion else { lock.unlock(); return }
    let result: Result<Value, Error>
    if let failure { result = .failure(failure) }
    else if let pending { result = pending }
    else { lock.unlock(); return }
    self.pending = nil; self.completion = nil
    timer?.cancel(); timer = nil
    lock.unlock()
    completion(result)
  }
}
