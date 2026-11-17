import AppKit
import ApplicationServices
import CryptoKit
import DeviceCore

/// Explicit opt-in preview capability, separate from installed helper actions.
/// Only the authenticated local preview controller may broker this inherited pipe.
@MainActor final class PreviewNativeExecutor {
  private var admission = PreviewNativeAdmission()
  private let installed: Bool
  init(installed: Bool = false) { self.installed = installed }
  private func localAuthority() -> Bool {
    guard installed else { return true }
    FileHandle.standardOutput.write(Data("{\"localAuthority\":1}\n".utf8))
    return FileHandle.standardInput.readData(ofLength: 2) == Data("1\n".utf8)
  }
  private var retained: (NSRunningApplication, AXUIElement, ProcessLifetimeIdentity, Double)?
  private var binding: PreviewNativeRequest?
  private let resolver = NativeTargetResolver()
  private var refusalReason: String { resolver.refusalReason }
  private func available(_ request: PreviewNativeRequest) -> Bool { localAuthority() && resolver.available(request) }
  private func resolve(_ request: PreviewNativeRequest) -> (NSRunningApplication, AXUIElement, PreviewNativeRequest, ProcessLifetimeIdentity)? { resolver.resolve(request) }
  private func observation(_ request: PreviewNativeRequest, app: NSRunningApplication, window: AXUIElement, lifetime: ProcessLifetimeIdentity) -> [String: Any] {
    resolver.observation(request, app: app, window: window, lifetime: lifetime)
  }
  private func response(_ id: String, _ status: String, _ reason: String, attempted: Bool = false) -> [String: Any] {
    ["v": 1, "requestId": id, "status": status, "reason": reason, "effectAttempted": attempted]
  }
  private func handle(_ bytes: Data) async -> [String: Any] {
    guard let request = try? JSONDecoder().decode(PreviewNativeRequest.self, from: bytes) else {
      admission.clear(); retained = nil
      return response("invalid", "rejected", "invalid_request")
    }
    guard admission.begin(request, now: Date().timeIntervalSince1970 * 1000) else {
      retained = nil; return response(request.requestId, "rejected", "native_request_expired_or_invalid")
    }
    guard available(request) else { retained = nil; return response(request.requestId, "rejected", refusalReason) }
    if let binding {
      guard request.sessionId == binding.sessionId, request.leaseId == binding.leaseId, request.displayId == binding.displayId else {
        admission.clear(); retained = nil; return response(request.requestId, "rejected", "binding_changed")
      }
    } else { binding = request }
    if request.op == "qualify" {
      admission.clear(); retained = nil
      guard let resolved = resolve(request) else { return response(request.requestId, "rejected", refusalReason) }
      let token = UUID().uuidString
      retained = (resolved.0, resolved.1, resolved.3, ProcessInfo.processInfo.systemUptime)
      admission.qualify(resolved.2, token: token, uptime: ProcessInfo.processInfo.systemUptime)
      let observed = observation(resolved.2, app: resolved.0, window: resolved.1, lifetime: resolved.3)
      guard processLifetime(resolved.0) == resolved.3 else {
        admission.clear(); retained = nil; return response(request.requestId, "rejected", "app_launch_identity_unavailable")
      }
      var result = response(request.requestId, "qualified", "target_qualified")
      result["targetToken"] = token; result["wireTarget"] = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(resolved.2.target)); result["observation"] = observed
      return result
    }
    let old = retained; retained = nil
    guard admission.consume(request, now: Date().timeIntervalSince1970 * 1000, uptime: ProcessInfo.processInfo.systemUptime),
      let old, let current = resolve(request), current.0.isEqual(old.0), !old.0.isTerminated, current.3 == old.2, CFEqual(current.1, old.1),
      ProcessInfo.processInfo.systemUptime - old.3 < 2, available(request) else {
      return response(request.requestId, "rejected", "qualification_changed")
    }
    // Exactly one native effect per request. A raise needs a fresh qualification
    // after activation; neither an uncertain result nor a timeout is replayed.
    let sent: Bool
    let originalDisplayBounds = CGDisplayBounds(request.displayId)
    if request.op == "activate" {
      let root = AXUIElementCreateApplication(request.target.pid)
      AXUIElementSetMessagingTimeout(root, 0.1)
      let activation = NativeFrontmostRequest.perform(capability: {
        var pid: pid_t = 0
        var settable = DarwinBoolean(false)
        let pidRead = AXUIElementGetPid(root, &pid) == .success
        let attributeRead = AXUIElementIsAttributeSettable(root, kAXFrontmostAttribute as CFString, &settable) == .success
        return NativeFrontmostRequest.available(expectedPID: request.target.pid, observedPID: pidRead ? pid : nil,
          attributeSettable: attributeRead ? settable.boolValue : nil)
      }, authorized: {
        // AX capability inspection may wait on the app. Do not carry an old
        // target/permission/deadline across it into the one setter call.
        guard let final = self.resolve(request), final.0.isEqual(current.0), !old.0.isTerminated,
          final.3 == old.2, CFEqual(final.1, old.1),
          !Task.isCancelled, ProcessInfo.processInfo.systemUptime - old.3 < 2,
          processLifetime(current.0) == old.2, self.available(request) else { return false }
        var pid: pid_t = 0
        return AXUIElementGetPid(root, &pid) == .success && pid == request.target.pid
          && !Task.isCancelled && ProcessInfo.processInfo.systemUptime - old.3 < 2 && self.available(request)
      }, setFrontmost: {
        // Public Accessibility app activation, not a window raise or a launch.
        // Never fall through to another activation method on failure.
        guard self.available(request), !Task.isCancelled else { return false }
        return AXUIElementSetAttributeValue(root, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success
      })
      switch activation {
      case .unavailable: return response(request.requestId, "rejected", "activation_attribute_unavailable")
      case .authorityChanged: return response(request.requestId, "rejected", "qualification_changed")
      case .attempted(false): return response(request.requestId, "unknown", "native_request_unconfirmed", attempted: true)
      case .attempted(true): sent = true
      }
    }
    else {
      guard current.0.isActive, NSWorkspace.shared.frontmostApplication?.isEqual(current.0) == true else {
        return response(request.requestId, "rejected", "app_not_active")
      }
      guard available(request), !Task.isCancelled else { return response(request.requestId, "rejected", "qualification_changed") }
      sent = AXUIElementPerformAction(current.1, kAXRaiseAction as CFString) == .success
    }
    // Only fixed local stage codes cross the pipe, never an AX title or NSError.
    var postRefusal = "post_observation_deadline"
    let settled = await ReadOnlySettle.observations(now: { ProcessInfo.processInfo.systemUptime },
      allowed: {
        guard !Task.isCancelled, ProcessInfo.processInfo.systemUptime - old.3 < 2 else {
          postRefusal = "native_request_expired_or_invalid"; return false
        }
        guard CGDisplayBounds(request.displayId) == originalDisplayBounds else { postRefusal = "display_changed"; return false }
        guard self.available(request) else { postRefusal = self.refusalReason; return false }
        return true
      }, observe: {
        guard let verified = self.resolve(request) else {
          let reason = self.refusalReason; postRefusal = reason
          if self.resolver.refusalIsCGGeometry,
            self.resolver.retainsTransitionIdentity(request, app: current.0, window: current.1,
              lifetime: old.2, displayBounds: originalDisplayBounds) {
            return ReadOnlySettleObservation<[String: Any]>.pending
          }
          return .unavailable
        }
        guard verified.0.isEqual(current.0), !current.0.isTerminated,
          verified.3 == old.2, CFEqual(verified.1, current.1) else { postRefusal = "qualification_changed"; return .unavailable }
        let state = self.observation(request, app: current.0, window: current.1, lifetime: current.3)
        guard processLifetime(current.0) == old.2 else { postRefusal = "app_launch_identity_unavailable"; return .unavailable }
        return .observed(state, verified: ["appActive", "windowFocused", "windowOnScreen"].allSatisfy({ state[$0] as? Bool == true }))
      }, sleep: { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) })
    switch settled {
    case .verified(let state):
      var result = response(request.requestId, "verified", "target_foreground", attempted: true)
      result["observation"] = state; return result
    case .unverified(let state):
      var result = response(request.requestId, sent ? "submitted" : "unknown", sent ? "foreground_unverified" : "native_request_unconfirmed", attempted: true)
      if let state { result["observation"] = state }; return result
    case .unavailable:
      return response(request.requestId, "unknown", postRefusal, attempted: true)
    }
  }
  func run() {
    // Watchdog bounds hung AX/IPC calls independently of the main actor.
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
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["op"] as? String == "stop" { exit(0) }
        let done = DispatchSemaphore(value: 0)
        let deadline = DispatchWorkItem { exit(2) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: deadline)
        Task { @MainActor in
          let result = await self.handle(data)
          guard let output = try? JSONSerialization.data(withJSONObject: result), output.count <= 8192 else { exit(2) }
          FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10]))
          deadline.cancel(); done.signal()
        }
        done.wait()
      }
    }
  }
}
