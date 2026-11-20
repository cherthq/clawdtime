import AppKit
import ApplicationServices
import Carbon
import DeviceCore

private struct LocalRevalidation: Decodable {
  let plannedFrameId: String
  let currentFrameId: String
  let action: LocalPlannedAction
}

private struct LocalStatus: Encodable {
  let nativeCaptureDrain = true
  let captureActive: Bool
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
  var localHelperConflict: Bool {
    localOnly && NSWorkspace.shared.runningApplications.contains {
      !$0.isTerminated && LocalInputExclusion.conflictingHelper(bundleId: $0.bundleIdentifier,
        pid: $0.processIdentifier, helperPID: ProcessInfo.processInfo.processIdentifier)
    }
  }
  var localExecutionAvailable: Bool { session.available && !localHelperConflict }

  /// Authenticated by handle before dispatch. Local mode is loopback and opt-in.
  func handleLocal(_ request: HTTPRequest) async throws -> HTTPResponse {
    guard config.bind == "127.0.0.1" else { throw HelperError(403, "Local execution requires loopback.") }
    if request.method == "GET", request.path == "/local/v1/status" {
      return try .json(LocalStatus(captureActive: capture.busy, deviceId: config.deviceId,
        localEnabled: !(config.localExecutors ?? []).isEmpty,
        armed: policy.armed, available: localExecutionAvailable,
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
      try localPolicy.begin(value, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
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
      if localPolicy.lease?.id == id { localPolicy.stop(); localTargetProofs.clear(); updateIndicator() }
      // The caller may have aborted its frame request while the native callback
      // still runs. A revoked lease alone is not capture cleanup confirmation.
      do { try await CaptureDrain.wait { self.capture.busy } }
      catch { throw HelperError(503, "Local capture cleanup remains unconfirmed.") }
      return try .json(["stopped": true, "captureStopped": true])
    }
    if parts.count == 5, parts[4] == "revalidate", request.method == "POST" {
      let lease = try localPolicy.require(id, now: Date(), available: localExecutionAvailable)
      let applications = config.localExecutors?.first { $0.executorId == lease.executorId && $0.displayId == lease.displayId }?.allowedApplications ?? []
      let input = try decode(LocalRevalidation.self, request.body)
      try input.action.validate()
      guard validID(input.plannedFrameId), validID(input.currentFrameId), localPolicy.frame?.id == input.currentFrameId,
        let (old, current) = localTargetProofs.pair(planned: input.plannedFrameId, current: input.currentFrameId, lease: lease, now: Date()) else {
        return try .json(["valid": false])
      }
      let valid: Bool
      if input.action.type == "activate" {
        valid = old.snapshot.activationMatching(current.snapshot, action: input.action).map {
          LocalWindowCapture.validate($0, displayId: lease.displayId, applications: applications)
        } ?? false
      } else {
        valid = old.snapshot.matching(current.snapshot, action: input.action).map {
          LocalTargetCapture.validate($0, action: input.action, displayId: lease.displayId)
        } ?? false
      }
      guard valid, let proof = try localTargetProofs.issue(planned: input.plannedFrameId, current: input.currentFrameId, action: input.action, lease: lease, now: Date()) else {
        return try .json(["valid": false])
      }
      struct Valid: Encodable { let valid = true; let proofId: String; let plannedFrameId: String; let currentFrameId: String }
      return try .json(Valid(proofId: proof, plannedFrameId: input.plannedFrameId, currentFrameId: input.currentFrameId))
    }
    if parts.count == 5, parts[4] == "actions", request.method == "POST" {
      let action = try decode(InputAction.self, request.body)
      if let existing = try localLedger.existing(action, leaseId: id) { return try .json(existing) }
      guard ledger.unresolvedActionCount == 0 else { throw HelperError(409, "Call input outcome remains unresolved.") }
      // Establish exact identity before emitting the definite-no-input code.
      let lease = try localPolicy.boundActionLease(action, id: id, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
      let applications = config.localExecutors?.first { $0.executorId == lease.executorId && $0.displayId == lease.displayId }?.allowedApplications ?? []
      var provenWindow: LocalWindowWitness?
      var provenTarget: LocalTargetWitness?
      if let proof = action.localProofId {
        do {
          let (old, current) = try localTargetProofs.consume(proof, action: action, lease: lease, now: Date())
          if action.type == "activate" {
            guard let window = old.snapshot.activationMatching(current.snapshot, action: LocalPlannedAction(action)) else { throw HelperError(409, "Local window no longer matches.") }
            provenWindow = window
          } else {
            guard let target = old.snapshot.matching(current.snapshot, action: LocalPlannedAction(action)) else { throw HelperError(409, "Local target no longer matches.") }
            provenTarget = target
          }
        } catch {
          localPolicy.invalidateFrame()
          return try .json(["code": "input_not_dispatched", "error": "Local target proof was refused before dispatch."], status: 409)
        }
      }
      func preflight() throws -> NativeInputBatch {
        _ = try localPolicy.validateAction(action, id: id, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
        guard frameBounds == CGDisplayBounds(lease.displayId), CGPreflightScreenCaptureAccess() else {
          throw HelperError(409, "Display or permission changed.")
        }
        if action.type == "activate" {
          try LocalWindowPolicy.requireNativeActivation(accessibility: AXIsProcessTrusted(), secureInput: IsSecureEventInputEnabled(), displayActive: CGDisplayIsActive(lease.displayId) != 0)
          guard let window = provenWindow, LocalWindowCapture.validate(window, displayId: lease.displayId, applications: applications) else {
            throw HelperError(409, "Activation requires a current proof for an explicitly allowed existing window.")
          }
          _ = try localPolicy.validateAction(action, id: id, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
          try LocalWindowPolicy.requireNativeActivation(accessibility: AXIsProcessTrusted(), secureInput: IsSecureEventInputEnabled(), displayActive: CGDisplayIsActive(lease.displayId) != 0)
          return NativeInputBatch(events: [], activation: window)
        }
        if let target = provenTarget {
          guard LocalTargetCapture.validate(target, action: LocalPlannedAction(action), displayId: lease.displayId) else {
            throw HelperError(409, "Local target changed before input.")
          }
          // AX reads are bounded but take time. Recheck freshness/lease after them.
          _ = try localPolicy.validateAction(action, id: id, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
        }
        return try prepareInput(action, displayId: lease.displayId, localFocus: localFrameFocus, requireLocalFocus: true)
      }
      do { _ = try preflight() }
      catch {
        localPolicy.invalidateFrame()
        return try .json(["code": "input_not_dispatched", "error": "Input was refused before dispatch; observe and review again."], status: 409)
      }
      try localLedger.begin(action, lease: lease, now: Date())
      let batch: NativeInputBatch
      do { batch = try preflight() }
      catch {
        localPolicy.invalidateFrame()
        return try .json(localLedger.reject(action.id, now: Date()))
      }
      // From here events may have reached the OS. Storage/connection failures are
      // uncertain; never relabel them as a pre-input refusal or replay them.
      do {
        try batch.post()
        localPolicy.invalidateFrame()
        return try .json(localLedger.finish(action.id, submitted: true, now: Date(), windowActivation: action.type == "activate"))
      } catch {
        localPolicy.invalidateFrame()
        _ = try? localLedger.finish(action.id, submitted: false, now: Date())
        throw error
      }
    }
    let lease = try localPolicy.require(id, now: Date(), available: localExecutionAvailable)
    if parts.count == 5, parts[4] == "renew", request.method == "POST" {
      let next = try decode(LocalExecutionLease.self, request.body)
      guard next.id == id else { throw HelperError(409, "Wrong local renewal identity.") }
      try localPolicy.renew(next, now: Date(), available: localExecutionAvailable, accessibility: AXIsProcessTrusted())
      return try .json(next)
    }
    if parts.count == 5, parts[4] == "frame", request.method == "GET" {
      guard Date().timeIntervalSince(lastFrameRequest) >= 0.2 else { throw HelperError(429, "Frame rate is limited to five per second.") }
      lastFrameRequest = Date()
      let startedAt = Date(), generation = localPolicy.generation, sharedGeneration = policy.generation
      let bounds = CGDisplayBounds(lease.displayId)
      localPolicy.invalidateFrame()
      let focused = LocalFocusWitness.current()
      let applications = config.localExecutors?.first { $0.executorId == lease.executorId && $0.displayId == lease.displayId }?.allowedApplications ?? []
      var targetsBefore = LocalTargetCapture.capture(displayId: lease.displayId)
      targetsBefore.windows = LocalWindowCapture.capture(displayId: lease.displayId, applications: applications)
      let frame = try await capture.capture(lease.displayId, localExecution: true)
      var targetsAfter = LocalTargetCapture.capture(displayId: lease.displayId)
      targetsAfter.windows = LocalWindowCapture.capture(displayId: lease.displayId, applications: applications)
      _ = try localPolicy.require(id, now: Date(), available: localExecutionAvailable)
      guard generation == localPolicy.generation, sharedGeneration == policy.generation,
        (0...2).contains(Date().timeIntervalSince(startedAt)), CGDisplayBounds(lease.displayId) == bounds,
        CGPreflightScreenCaptureAccess(), LocalFocusWitness.same(focused, LocalFocusWitness.current()) else { throw HelperError(409, "Local capture became stale or lost authority.") }
      let stamp = FrameStamp(id: UUID().uuidString, leaseId: id, displayId: lease.displayId,
        capturedAt: startedAt, width: frame.width, height: frame.height)
      try localPolicy.recordFrame(stamp)
      try localLedger.observedFrame(leaseId: id, capturedAt: stamp.capturedAt)
      frameBounds = bounds; localFrameFocus = focused
      let targets = targetsBefore.intersect(targetsAfter)
      localTargetProofs.register(stamp, snapshot: targets)
      let targetHeader = try targets.wire()
      return HTTPResponse(contentType: "image/jpeg", headers: ["X-Frame-Id": stamp.id,
        "X-Captured-At": frameCaptureTimestamp(stamp.capturedAt), "X-Frame-Width": String(frame.width),
        "X-Frame-Height": String(frame.height), "X-Focus-Identity": focused?.digest ?? "none", "X-Local-Targets": targetHeader, "X-Local-Windows": try targets.windowWire()], body: frame.jpeg)
    }
    throw HelperError(404, "Unknown local route.")
  }
}
