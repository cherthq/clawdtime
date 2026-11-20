import AppKit
import ApplicationServices
import DeviceCore

private struct LocalStatus: Encodable {
  let deviceId: String
  let localEnabled: Bool
  let armed: Bool
  let available: Bool
  let screenPermission: Bool
  let controlPermission: Bool
  let policyRevision: Int
  let activeSessionId: String?
  let unresolvedActions: Int
}

extension DeviceApp {
  /// Authenticated by handle before dispatch. Local mode is loopback and opt-in.
  func handleLocal(_ request: HTTPRequest) async throws -> HTTPResponse {
    guard config.bind == "127.0.0.1" else { throw HelperError(403, "Local execution requires loopback.") }
    if request.method == "GET", request.path == "/local/v1/status" {
      return try .json(LocalStatus(deviceId: config.deviceId,
        localEnabled: !(config.localExecutors ?? []).isEmpty,
        armed: policy.armed, available: session.available,
        screenPermission: CGPreflightScreenCaptureAccess(), controlPermission: AXIsProcessTrusted(),
        policyRevision: policy.preferences.revision, activeSessionId: localPolicy.lease?.id,
        unresolvedActions: ledger.unresolvedActionCount + localLedger.unresolvedActions))
    }
    guard !(config.localExecutors ?? []).isEmpty else { throw HelperError(403, "Local execution is not configured.") }
    let parts = request.path.split(separator: "/").map(String.init)
    if request.method == "POST", request.path == "/local/v1/sessions" {
      let value = try decode(LocalExecutionLease.self, request.body)
      guard CGPreflightScreenCaptureAccess(), CGDisplayIsActive(value.displayId) != 0 else {
        throw HelperError(403, "Screen Recording and the exact active display are required.")
      }
      guard ledger.unresolvedActionCount + localLedger.unresolvedActions == 0 else {
        throw HelperError(409, "Reconcile outstanding input before starting local work.")
      }
      let existing = localPolicy.lease?.id == value.id
      guard existing || !localLedger.used(value.id) else { throw HelperError(409, "Local session was already used; it cannot be resumed.") }
      try localPolicy.begin(value, now: Date(), available: session.available, accessibility: AXIsProcessTrusted())
      if !existing {
        do { try localLedger.reserve(value) }
        catch { localPolicy.stop(); throw error }
      }
      updateIndicator()
      return try .json(value)
    }
    guard parts.count >= 4, Array(parts.prefix(3)) == ["local", "v1", "sessions"], validID(parts[3]) else {
      throw HelperError(404, "Unknown local route.")
    }
    let id = parts[3]
    if parts.count == 6, parts[4] == "actions", request.method == "GET", validID(parts[5]) {
      return try .json(localLedger.get(parts[5], leaseId: id))
    }
    if parts.count == 5, parts[4] == "stop", request.method == "POST" {
      guard localLedger.used(id) else { throw HelperError(404, "Unknown local session.") }
      // A delayed Stop for an old session cannot stop a different current owner.
      if localPolicy.lease?.id == id { localPolicy.stop(); updateIndicator() }
      return try .json(["stopped": true])
    }
    if parts.count == 5, parts[4] == "actions", request.method == "POST" {
      let action = try decode(InputAction.self, request.body)
      if let existing = try localLedger.existing(action, leaseId: id) { return try .json(existing) }
      guard ledger.unresolvedActionCount == 0 else { throw HelperError(409, "Call input outcome remains unresolved.") }
      let lease = try localPolicy.validateAction(action, id: id, now: Date(), available: session.available, accessibility: AXIsProcessTrusted())
      guard frameBounds == CGDisplayBounds(lease.displayId), CGPreflightScreenCaptureAccess() else {
        localPolicy.invalidateFrame(); throw HelperError(409, "Display or permission changed; obtain a fresh frame.")
      }
      try localLedger.begin(action, lease: lease, now: Date())
      do {
        _ = try localPolicy.validateAction(action, id: id, now: Date(), available: session.available, accessibility: AXIsProcessTrusted())
        try postInput(action, displayId: lease.displayId, localFocus: localFrameFocus, requireLocalFocus: true)
        localPolicy.invalidateFrame()
        return try .json(localLedger.finish(action.id, submitted: true, now: Date()))
      } catch {
        localPolicy.invalidateFrame()
        _ = try? localLedger.finish(action.id, submitted: false, now: Date())
        throw error
      }
    }
    let lease = try localPolicy.require(id, now: Date(), available: session.available)
    if parts.count == 5, parts[4] == "renew", request.method == "POST" {
      let next = try decode(LocalExecutionLease.self, request.body)
      guard next.id == id else { throw HelperError(409, "Wrong local renewal identity.") }
      try localPolicy.renew(next, now: Date(), available: session.available, accessibility: AXIsProcessTrusted())
      return try .json(next)
    }
    if parts.count == 5, parts[4] == "frame", request.method == "GET" {
      guard Date().timeIntervalSince(lastFrameRequest) >= 0.2 else { throw HelperError(429, "Frame rate is limited to five per second.") }
      lastFrameRequest = Date()
      let startedAt = Date(), generation = localPolicy.generation, sharedGeneration = policy.generation
      let bounds = CGDisplayBounds(lease.displayId)
      localPolicy.invalidateFrame()
      let focused = LocalFocusWitness.current()
      let frame = try await capture.capture(lease.displayId, localExecution: true)
      _ = try localPolicy.require(id, now: Date(), available: session.available)
      guard generation == localPolicy.generation, sharedGeneration == policy.generation,
        (0...2).contains(Date().timeIntervalSince(startedAt)), CGDisplayBounds(lease.displayId) == bounds,
        CGPreflightScreenCaptureAccess(), LocalFocusWitness.same(focused, LocalFocusWitness.current()) else { throw HelperError(409, "Local capture became stale or lost authority.") }
      let stamp = FrameStamp(id: UUID().uuidString, leaseId: id, displayId: lease.displayId,
        capturedAt: startedAt, width: frame.width, height: frame.height)
      try localPolicy.recordFrame(stamp)
      try localLedger.observedFrame(leaseId: id, capturedAt: stamp.capturedAt)
      frameBounds = bounds; localFrameFocus = focused
      return HTTPResponse(contentType: "image/jpeg", headers: ["X-Frame-Id": stamp.id,
        "X-Captured-At": frameCaptureTimestamp(stamp.capturedAt), "X-Frame-Width": String(frame.width),
        "X-Frame-Height": String(frame.height), "X-Focus-Identity": focused?.digest ?? "none"], body: frame.jpeg)
    }
    throw HelperError(404, "Unknown local route.")
  }
}
