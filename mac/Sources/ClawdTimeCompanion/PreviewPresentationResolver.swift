import AppKit
import DeviceCore

/// Read-only pipe capability. Its decoder rejects all effect verbs and tokens;
/// the shared resolver contains no native effect methods.
@MainActor final class PreviewPresentationResolver {
  private let resolver = NativeTargetResolver()
  private let installed: Bool
  init(installed: Bool = false) { self.installed = installed }
  private var binding: PresentationResolveRequest?
  private var seen = Set<String>()
  private func handle(_ data: Data) -> [String: Any] {
    guard let request = try? PresentationResolveRequest.decode(data, now: Date().timeIntervalSince1970 * 1000) else {
      return ["v": 1, "requestId": "invalid", "status": "rejected", "reason": "invalid_request"]
    }
    func refusal(_ reason: String) -> [String: Any] { ["v": 1, "requestId": request.requestId, "status": "rejected", "reason": reason] }
    guard seen.count < (installed ? 256 : 64), seen.insert(request.requestId).inserted else { return refusal("native_request_expired_or_invalid") }
    if let binding { guard request.sameBinding(binding) else { return refusal("binding_changed") } }
    else { binding = request }
    guard let resolved = resolver.resolve(request) else { return refusal(resolver.refusalReason) }
    let observation = resolver.observation(resolved.2, app: resolved.0, window: resolved.1, lifetime: resolved.3)
    guard (installed && request.processIdentity == "unqualified") || observation["processIdentity"] as? String == request.processIdentity,
      processLifetime(resolved.0) == resolved.3 else { return refusal("prepared_target_changed") }
    guard ["appActive","windowFocused","windowOnScreen"].allSatisfy({ observation[$0] as? Bool == true }) else { return refusal("target_not_foreground") }
    guard resolver.available(request) else { return refusal(resolver.refusalReason) }
    return ["v": 1, "requestId": request.requestId, "status": "resolved", "observation": observation]
  }
  func run() {
    DispatchQueue.global().asyncAfter(deadline: .now() + 900) { exit(2) }
    DispatchQueue.global().async { [self] in
      while true {
        var data = Data()
        while data.count <= 8192 {
          let next = FileHandle.standardInput.readData(ofLength: 1)
          if next.isEmpty { exit(0) }
          if next[0] == 10 { break }
          data.append(next)
        }
        guard data.count <= 8192 else { exit(2) }
        let done = DispatchSemaphore(value: 0)
        let deadline = DispatchWorkItem { exit(2) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: deadline)
        Task { @MainActor in
          let result = self.handle(data)
          guard let output = try? JSONSerialization.data(withJSONObject: result), output.count <= 8192 else { exit(2) }
          FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10]))
          deadline.cancel(); done.signal()
        }
        done.wait()
      }
    }
  }
}
