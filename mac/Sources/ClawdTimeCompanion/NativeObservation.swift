import AppKit
import DeviceCore

/// One bounded read-only observation. False foreground flags are evidence, not
/// permission to activate; this function contains no effect or capture methods.
@MainActor func nativeObservation(_ bytes: Data) throws -> [String: Any] {
  let request = try NativeObservationRequest.decode(bytes, now: Date().timeIntervalSince1970 * 1000)
  let resolver = NativeTargetResolver()
  guard let resolved = resolver.resolve(request) else { throw HelperError(409, resolver.refusalReason) }
  let result = resolver.observation(resolved.2, app: resolved.0, window: resolved.1, lifetime: resolved.3)
  guard processLifetime(resolved.0) == resolved.3, !resolved.0.isTerminated else {
    throw HelperError(409, "prepared_target_changed")
  }
  guard resolver.available(request) else { throw HelperError(409, resolver.refusalReason) }
  return result
}
