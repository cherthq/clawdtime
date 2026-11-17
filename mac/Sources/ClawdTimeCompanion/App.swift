import AppKit
import ApplicationServices
import DeviceCore

struct HelperStatus: Codable {
  let deviceId: String
  let armed: Bool
  let available: Bool
  let screenPermission: Bool
  let controlPermission: Bool
  let activeLeaseId: String?
  let controlPolicy: String
  let policyRevision: Int
  let unresolvedActionCount: Int
  let historicalObservedActionCount: Int
  let historicalUnverifiedActionCount: Int
  let panelCommand: PanelCommand?
  let retiredPanelCommands: [PanelCommand]
  let presentationVersion: Int
  let textControlVersion: Int
  let cameraVersion: Int
  let localEnableGeneration: Int
}

@MainActor final class DeviceApp: NSObject, NSApplicationDelegate {
  let config: HelperConfig
  let policy: DevicePolicy
  let ledger: ReceiptStore
  let preferences: ControlPreferenceStore
  let controlPanel = ControlPanelState()
  let capture = ScreenCapture()
  let session = LocalSessionGuard()
  var server: HTTPServer?
  var status: NSStatusItem?
  var panel: NSPanel?
  var label: NSTextField?
  var activityView: ActivityPanelView?
  var timer: Timer?
  var lastFrameRequest = Date.distantPast
  var frameBounds: CGRect?
  var cameraMetadata: CameraFrameMetadata?
  var setupWindow: NSWindow?
  var setupStateLabel: NSTextField?
  var setupScreenLabel: NSTextField?
  var setupControlLabel: NSTextField?
  var setupDisplaysLabel: NSTextField?
  var connectionLabel: NSTextField?
  var callLabel: NSTextField?
  var executionLabel: NSTextField?
  var policyChoice: NSPopUpButton?
  var muteButton: NSButton?
  var endButton: NSButton?
  var pauseButton: NSButton?
  var lastSetupRefresh = Date.distantPast
  init(config: HelperConfig, ledgerURL: URL) throws {
    self.config = config
    self.ledger = try ReceiptStore(url: ledgerURL)
    self.preferences = try ControlPreferenceStore(
      url: ledgerURL.deletingLastPathComponent().appendingPathComponent("control-policy.json"),
      deviceId: config.deviceId)
    self.policy = try DevicePolicy(config: config, preferences: preferences.value)
    super.init()
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    status = NSStatusBar.system.statusItem(withLength: 22)
    let menu = NSMenu()
    menu.addItem(withTitle: "Control Panel…", action: #selector(showSetup), keyEquivalent: "")
      .target = self
    menu.addItem(withTitle: "Review text control request…", action: #selector(reviewTextGrant), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Enable remote sharing locally", action: #selector(arm), keyEquivalent: ""
    ).target = self
    menu.addItem(withTitle: "STOP sharing and control", action: #selector(stop), keyEquivalent: "s")
      .target = self
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Grant Screen Recording…", action: #selector(screenPermission), keyEquivalent: ""
    ).target = self
    menu.addItem(
      withTitle: "Grant Accessibility…", action: #selector(controlPermission), keyEquivalent: ""
    ).target = self
    menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q").target = self
    status?.menu = menu
    NotificationCenter.default.addObserver(
      self, selector: #selector(stop), name: NSApplication.didChangeScreenParametersNotification,
      object: nil)
    let center = NSWorkspace.shared.notificationCenter
    for name in [
      NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification,
      NSWorkspace.screensDidSleepNotification,
    ] {
      center.addObserver(self, selector: #selector(unavailable), name: name, object: nil)
    }
    for name in [
      NSWorkspace.didWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification,
      NSWorkspace.screensDidWakeNotification,
    ] {
      center.addObserver(self, selector: #selector(restored), name: name, object: nil)
    }
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(unavailable), name: NSNotification.Name("com.apple.screenIsLocked"),
      object: nil)
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(restored), name: NSNotification.Name("com.apple.screenIsUnlocked"),
      object: nil)
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        _ = try? self.policy.check(now: Date(), sessionAvailable: self.session.available)
        self.updateIndicator()
      }
    }
    do {
      server = try HTTPServer(config: config) { [weak self] request in
        guard let self else { return .error(HelperError(503, "Device unavailable.")) }
        return await self.handle(request)
      }
      server?.start()
    } catch {
      policy.stop(disarm: true)
      showError("Unable to bind helper listener.")
    }
    updateIndicator()
    if config.displays.isEmpty || !CGPreflightScreenCaptureAccess()
      || (config.displays.contains { !$0.controllers.isEmpty } && !AXIsProcessTrusted())
    {
      showSetup()
    }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showSetup()
    return true
  }
  @objc func arm() {
    session.forcedUnavailable = false
    guard session.available else {
      showError("Unlock this Mac's active user session first.")
      return
    }
    policy.arm()
    updateIndicator()
  }
  @objc func reviewTextGrant() {
    guard let grant = policy.pendingTextGrant else {
      showError("No text-control request is awaiting local review.")
      return
    }
    let alert = NSAlert()
    alert.messageText = "Allow this text session to control the selected display?"
    alert.informativeText = "Project: \(grant.projectRoot)\nSession: \(grant.sessionId)\nMember: \(grant.memberId)\nDisplay: \(grant.displayId)\nActions: \(grant.actions.joined(separator: ", "))\nExpires: \(Date(timeIntervalSince1970: grant.expiresAt / 1000))\nStop sharing revokes this grant."
    alert.addButton(withTitle: "Allow scoped session")
    alert.addButton(withTitle: "Reject")
    if alert.runModal() == .alertFirstButtonReturn {
      do {
        guard ledger.unresolvedActionCount == 0 else {
          throw HelperError(409, "Reconcile outstanding input before allowing control.")
        }
        try policy.approveTextGrant(id: grant.id, now: Date(), sessionAvailable: session.available)
      } catch { showError(error.localizedDescription) }
    } else { policy.rejectTextGrant() }
    updateIndicator()
  }
  @objc func stop() {
    controlPanel.clearActivity(stop: true)
    policy.stop(disarm: true)
    updateIndicator()
  }
  @objc func unavailable() {
    session.forcedUnavailable = true
    stop()
  }
  @objc func restored() {
    session.forcedUnavailable = false
    stop()
  }
  @objc func screenPermission() {
    _ = CGRequestScreenCaptureAccess()
    refreshSetup(force: true)
  }
  @objc func controlPermission() {
    _ = AXIsProcessTrustedWithOptions(
      [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    refreshSetup(force: true)
  }
  @objc func quit() {
    stop()
    server?.stop()
    NSApp.terminate(nil)
  }
  func showError(_ text: String) {
    let alert = NSAlert()
    alert.messageText = text
    alert.runModal()
  }
  func updateIndicator() {
    if policy.lease == nil { controlPanel.clearActivity(stop: true) }
    refreshSetup()
    let state =
      policy.lease.map {
        "\($0.mode == "control" ? "Controlling" : "Viewing") display \($0.displayId)"
      }
      ?? (policy.armed ? "Ready for authorized requests" : "Stopped locally")
    let symbol =
      policy.lease == nil
      ? (policy.armed ? "display" : "display.trianglebadge.exclamationmark") : "record.circle.fill"
    status?.button?.title = ""
    status?.button?.image =
      NSImage(
        systemSymbolName: symbol, accessibilityDescription: "ClawdTime Companion: \(state)")
      ?? NSImage(systemSymbolName: "display", accessibilityDescription: "ClawdTime Companion")
    status?.button?.setAccessibilityLabel("ClawdTime Companion: \(state)")
    status?.button?.toolTip = "ClawdTime Companion, \(state). Click for Control Panel or Stop."
    status?.button?.contentTintColor = policy.lease == nil ? nil : .systemRed
    let telemetry = controlPanel.current(now: Date())
    guard policy.lease != nil || telemetry != nil || controlPanel.command != nil else {
      panel?.orderOut(nil)
      return
    }
    if panel == nil {
      let p = NSPanel(contentRect: NSRect(x: 30, y: 30, width: 480, height: 270),
        styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
      p.title = "ClawdTime activity"
      p.level = .floating
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      p.isMovableByWindowBackground = true
      p.hidesOnDeactivate = false
      let view = ActivityPanelView(frame: NSRect(x: 0, y: 0, width: 480, height: 270))
      for (button, action) in [(view.stop, #selector(stop)), (view.mute, #selector(toggleMute)),
        (view.pause, #selector(requestPause)), (view.end, #selector(endCall)),
        (view.details, #selector(toggleActivityDetails)), (view.setup, #selector(showSetup))] {
        button.target = self; button.action = action
      }
      p.contentView = view
      activityView = view; panel = p
    }
    activityView?.update(PanelPresentation(telemetry: telemetry, pending: controlPanel.command, sharing: "\(state) · Mac \(config.deviceId)"))
    if let panel, let screen = panel.screen ?? NSScreen.main {
      panel.setFrame(ActivityPanelView.constrained(panel.frame, to: screen.visibleFrame), display: true)
    }
    panel?.orderFrontRegardless()
  }
  @objc func toggleActivityDetails() {
    guard let panel, let activityView else { return }
    activityView.expanded.toggle()
    panel.setContentSize(NSSize(width: 480, height: activityView.expanded ? 480 : 270))
    updateIndicator()
  }
  func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let raw = try decoder.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: raw) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      guard let date = formatter.date(from: raw) else {
        throw HelperError(400, "Invalid ISO timestamp.")
      }
      return date
    }
    do { return try decoder.decode(type, from: data) } catch let error as HelperError {
      throw error
    } catch { throw HelperError(400, "Invalid request body.") }
  }
  func handle(_ request: HTTPRequest) async -> HTTPResponse {
    do {
      guard authenticated(request.headers["authorization"] ?? "", secret: config.secret) else {
        throw HelperError(401, "Authentication required.")
      }
      let parts = request.path.split(separator: "/").map(String.init)
      if request.method == "GET", request.path == "/v1/status" {
        return try .json(
          HelperStatus(
            deviceId: config.deviceId, armed: policy.armed, available: session.available,
            screenPermission: CGPreflightScreenCaptureAccess(),
            controlPermission: AXIsProcessTrusted(), activeLeaseId: policy.lease?.id,
            controlPolicy: policy.preferences.policy.rawValue, policyRevision: policy.preferences.revision,
            unresolvedActionCount: ledger.unresolvedActionCount,
            historicalObservedActionCount: ledger.historicalObservedActionCount,
            historicalUnverifiedActionCount: ledger.historicalUnverifiedActionCount,
            panelCommand: controlPanel.command,
            retiredPanelCommands: controlPanel.retiredCommands, presentationVersion: 1,
            textControlVersion: 1, cameraVersion: 1, localEnableGeneration: policy.localEnableGeneration))
      }
      if request.method == "POST", request.path == "/v1/text-grants" {
        let grant = try decode(TextControlGrant.self, request.body)
        guard ledger.unresolvedActionCount == 0 else {
          throw HelperError(409, "Reconcile outstanding input before requesting control.")
        }
        try policy.proposeTextGrant(grant, now: Date(), sessionAvailable: session.available)
        return try .json(["state": policy.textGrant?.id == grant.id ? "active" : "pending", "id": grant.id])
      }
      if request.method == "DELETE", parts.count == 3, parts[0] == "v1", parts[1] == "text-grants", validID(parts[2]) {
        policy.revokeTextGrant(id: parts[2])
        updateIndicator()
        return try .json(["revoked":true])
      }
      if request.method == "GET", parts.count == 3, parts[0] == "v1", parts[1] == "text-grants", validID(parts[2]) {
        _ = try? policy.check(now: Date(), sessionAvailable: session.available)
        struct GrantStatus: Encodable { let state: String; let grant: TextControlGrant? }
        if let grant = policy.textGrant, grant.id == parts[2] {
          return try .json(GrantStatus(state: "active", grant: grant))
        }
        return try .json(GrantStatus(state: policy.pendingTextGrant?.id == parts[2] ? "pending" : "unavailable", grant: nil))
      }
      if request.method == "POST", request.path == "/v1/panel" {
        let telemetry = try decode(PanelTelemetry.self, request.body)
        guard telemetry.policyRevision == policy.preferences.revision else {
          throw HelperError(409, "Panel status uses an old local policy.")
        }
        try controlPanel.update(telemetry, lease: policy.lease, now: Date())
        updateIndicator()
        refreshSetup(force: true)
        return try .json(["accepted": true])
      }
      if request.method == "GET", request.path == "/v1/permissions" {
        // Authenticated metadata only: no TCC request, lease, frame or input.
        return try .json(config.displays)
      }
      if request.method == "GET", request.path == "/v1/camera-surfaces" {
        return try .json(await capture.cameraSurfaces())
      }
      if request.method == "GET", request.path == "/v1/displays" {
        return try .json(await capture.displays())
      }
      if request.method == "POST", request.path == "/v1/leases" {
        let lease = try decode(Lease.self, request.body)
        guard CGPreflightScreenCaptureAccess(), CGDisplayIsActive(lease.displayId) != 0 else {
          throw HelperError(403, "Screen Recording and a configured active display are required.")
        }
        guard !ledger.isHistoricallyRetiredLease(lease.id) else {
          throw HelperError(409, "This historical lease is retired; its input cannot be replayed.")
        }
        if ledger.unresolvedActionCount > 0 && (lease.mode == "control" || ([2, 3].contains(lease.protocolVersion ?? 0) && lease.executor != "none")) {
          throw HelperError(409, "Reconcile outstanding input before granting an executor.")
        }
        if policy.lease == nil, let surface = lease.surface {
          _ = try await capture.cameraTarget(surface, initial: true)
        }
        try policy.begin(
          lease, now: Date(), sessionAvailable: session.available,
          accessibility: AXIsProcessTrusted())
        updateIndicator()
        return try .json(lease)
      }
      guard parts.count >= 3, parts[0] == "v1", parts[1] == "leases", validID(parts[2]) else {
        throw HelperError(404, "Unknown route.")
      }
      let leaseId = parts[2]
      if parts.count == 5, parts[3] == "actions", request.method == "GET" {
        return try .json(ledger.get(parts[4], leaseId: leaseId))
      }
      if parts.count == 4, parts[3] == "actions", request.method == "POST" {
        let action = try decode(InputAction.self, request.body)
        if let existing = try ledger.existing(action, leaseId: leaseId) {
          return try .json(existing)
        }
        let lease = try policy.validateAction(
          action, leaseId: leaseId, now: Date(), sessionAvailable: session.available,
          accessibility: AXIsProcessTrusted())
        guard frameBounds == CGDisplayBounds(lease.displayId) else {
          policy.invalidateFrame()
          throw HelperError(409, "Display geometry changed; obtain a new frame.")
        }
        var inputBounds: CGRect? = nil
        if let surface = lease.surface {
          guard surface.kind == "display" else {
            throw HelperError(403, "Selected-window fallback input is unavailable until exact hit-target qualification; use native tools or an authorized display.")
          }
          let (_, geometry) = try await capture.cameraTarget(surface)
          guard let metadata = cameraMetadata, metadata.surface == surface,
            metadata.source == geometry else {
            policy.invalidateFrame()
            throw HelperError(409, "Selected window geometry changed; obtain a new frame.")
          }
          _ = try policy.validateAction(action, leaseId: leaseId, now: Date(), sessionAvailable: session.available,
            accessibility: AXIsProcessTrusted())
          inputBounds = CGRect(x: geometry.originX, y: geometry.originY, width: geometry.pointWidth, height: geometry.pointHeight)
        }
        _ = try ledger.begin(action, lease: lease, now: Date())
        do {
          _ = try policy.validateAction(
            action, leaseId: leaseId, now: Date(), sessionAvailable: session.available,
            accessibility: AXIsProcessTrusted())
          try postInput(action, displayId: lease.displayId, surfaceBounds: inputBounds)
          policy.invalidateFrame()
          return try .json(
            ledger.finish(
              action.id, state: "submitted", evidence: "cg_event_posted_not_application_verified",
              now: Date()))
        } catch {
          _ = try ledger.finish(
            action.id, state: "unknown", evidence: "input_outcome_unconfirmed", now: Date())
          throw error
        }
      }
      let lease = try policy.requireLease(leaseId, now: Date(), sessionAvailable: session.available)
      if request.method == "DELETE", parts.count == 3 {
        policy.stop()
        updateIndicator()
        return try .json(["stopped": true])
      }
      if request.method == "POST", parts.count == 4, parts[3] == "renew" {
        let renewed = try decode(Lease.self, request.body)
        guard renewed.id == leaseId else { throw HelperError(409, "Wrong lease renewal.") }
        if renewed.executorEpoch != lease.executorEpoch && ledger.unresolvedActionCount > 0 {
          throw HelperError(409, "Reconcile outstanding input before changing executor.")
        }
        try policy.renew(
          renewed, now: Date(), sessionAvailable: session.available,
          accessibility: AXIsProcessTrusted())
        return try .json(renewed)
      }
      if request.method == "GET", parts.count == 4, parts[3] == "frame" {
        guard Date().timeIntervalSince(lastFrameRequest) >= 0.2 else {
          throw HelperError(429, "Frame rate is limited to five per second.")
        }
        lastFrameRequest = Date()
        let startedAt = Date()
        let generation = policy.generation
        let bounds = CGDisplayBounds(lease.displayId)
        policy.invalidateFrame()
        cameraMetadata = nil
        let frame: CapturedFrame
        if let surface = lease.surface {
          let captured = try await capture.cameraFrame(surface)
          cameraMetadata = captured.metadata
          frame = CapturedFrame(jpeg: captured.jpeg, width: captured.metadata.source.width, height: captured.metadata.source.height)
        } else { frame = try await capture.capture(lease.displayId) }
        _ = try policy.requireLease(leaseId, now: Date(), sessionAvailable: session.available)
        guard policy.generation == generation, Date().timeIntervalSince(startedAt) <= 2,
          CGDisplayBounds(lease.displayId) == bounds
        else {
          throw HelperError(409, "Capture ended or switched while awaiting the frame.")
        }
        let stamp = FrameStamp(
          id: UUID().uuidString, leaseId: leaseId, displayId: lease.displayId,
          capturedAt: startedAt, width: frame.width, height: frame.height)
        try policy.recordFrame(stamp)
        try ledger.observedFrame(leaseId: leaseId, capturedAt: stamp.capturedAt)
        frameBounds = bounds
        var headers = [
            "X-Frame-Id": stamp.id,
            "X-Captured-At": frameCaptureTimestamp(stamp.capturedAt),
            "X-Frame-Width": String(frame.width), "X-Frame-Height": String(frame.height),
        ]
        if let metadata = cameraMetadata {
          headers["X-Camera-Frame"] = try JSONEncoder().encode(metadata).base64EncodedString()
        }
        return HTTPResponse(
          contentType: "image/jpeg",
          headers: headers, body: frame.jpeg)

      }
      throw HelperError(404, "Unknown route.")
    } catch {
      updateIndicator()
      return .error(error)
    }
  }
}

@main struct Main {
  @MainActor static func main() {
    umask(0o077)
    do {
      let args = CommandLine.arguments
      let cameraModes = ["--camera-list", "--camera-frame", "--camera-probe", "--camera-inspect", "--camera-find-window", "--camera-inspect-query"]
      if args.contains(where: { $0.hasPrefix("--camera-") && !cameraModes.contains($0) }) {
        throw HelperError(400, "Unsupported camera development mode; rebuild the development helper.")
      }
      if cameraModes.contains(where: args.contains) {
        let allowed = Set(cameraModes + ["--surface", "--query"])
        guard args.dropFirst().allSatisfy({ allowed.contains($0) || $0.hasPrefix("{") }),
          cameraModes.filter(args.contains).count == 1 else { throw HelperError(400, "Invalid camera preview arguments.") }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        Task { @MainActor in
          do {
            let capture = ScreenCapture()
            if args.contains("--camera-list") {
              print(String(data: try JSONEncoder().encode(await capture.cameraSurfaces()), encoding: .utf8)!)
            } else if args.contains("--camera-find-window") || args.contains("--camera-inspect-query") {
              guard let index = args.firstIndex(of: "--query"), index + 1 < args.count,
                let bytes = args[index + 1].data(using: .utf8) else { throw HelperError(400, "Exact --query JSON required.") }
              struct Query: Decodable { let bundleId: String; let title: String }
              let query = try JSONDecoder().decode(Query.self, from: bytes)
              if args.contains("--camera-inspect-query") {
                print(String(data: try JSONEncoder().encode(await capture.cameraInspectQuery(bundleId: query.bundleId, title: query.title)), encoding: .utf8)!)
              } else {
                let surface = try await capture.cameraFindWindow(bundleId: query.bundleId, title: query.title)
                print(String(data: try JSONEncoder().encode(surface), encoding: .utf8)!)
              }
            } else {
              guard let index = args.firstIndex(of: "--surface"), index + 1 < args.count,
                let bytes = args[index + 1].data(using: .utf8) else { throw HelperError(400, "Explicit --surface JSON required.") }
              let surface = try JSONDecoder().decode(CameraSurface.self, from: bytes)
              if args.contains("--camera-inspect") {
                print(String(data: try JSONEncoder().encode(await capture.cameraInspect(surface)), encoding: .utf8)!)
                exit(0)
              }
              if args.contains("--camera-probe") {
                // Explicit development-only capture of the same chosen surface.
                // Bounded count/runtime, no configuration, listener or pixel output.
                let deadline = DispatchWorkItem {
                  fputs("Camera probe stopped at its 35-second development deadline.\n", stderr)
                  exit(2)
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 35, execute: deadline)
                defer { deadline.cancel() }
                guard LocalSessionGuard().available else { throw HelperError(423, "Active unlocked local session required.") }
                _ = try await capture.cameraTarget(surface, initial: true)
                let started = Date()
                var frames = 0
                do {
                  while frames < 120 && Date().timeIntervalSince(started) < 30 {
                    guard LocalSessionGuard().available else { throw HelperError(423, "Active unlocked local session required.") }
                    let frameStarted = Date()
                    _ = try await capture.cameraFrame(surface)
                    guard LocalSessionGuard().available, Date().timeIntervalSince(frameStarted) < 2 else {
                      throw HelperError(409, "Capture session changed or frame became stale.")
                    }
                    frames += 1
                    try await Task.sleep(nanoseconds: 200_000_000)
                  }
                } catch {
                  print("{\"frames\":\(frames),\"completed\":false,\"elapsedMs\":\(Int(Date().timeIntervalSince(started) * 1000))}")
                  throw error
                }
                print("{\"frames\":\(frames),\"completed\":true,\"elapsedMs\":\(Int(Date().timeIntervalSince(started) * 1000))}")
                exit(0)
              }
              let started = Date()
              guard LocalSessionGuard().available else { throw HelperError(423, "Active unlocked local session required.") }
              let frame = try await capture.cameraFrame(surface)
              guard LocalSessionGuard().available, Date().timeIntervalSince(started) < 2 else { throw HelperError(423, "Local session unavailable or capture stale.") }
              struct Output: Encodable { var frameId: String; var capturedAt: String; var camera: CameraFrameMetadata; var jpegBase64: String }
              print(String(data: try JSONEncoder().encode(Output(frameId: UUID().uuidString,
                capturedAt: frameCaptureTimestamp(started), camera: frame.metadata, jpegBase64: frame.jpeg.base64EncodedString())), encoding: .utf8)!)
            }
            exit(0)
          } catch {
            if let failure = error as? CaptureFailure {
              fputs("Camera preview unavailable: \(failure.reason.rawValue), native_code=\(failure.nativeCode.map(String.init) ?? "none")\n", stderr)
            } else {
              fputs("Camera preview unavailable: \((error as? HelperError)?.message ?? "capture failed")\n", stderr)
            }
            exit((error as? HelperError)?.status == 425 ? 75 : 2)
          }
        }
        application.run()
        return
      }
      let reconciliationMode = args.contains("--reconcile-legacy-receipts")
      if reconciliationMode && (args.contains("--list-displays") || args.contains("--check-config")) {
        throw HelperError(400, "Reconciliation cannot be combined with another helper mode.")
      }
      if !reconciliationMode && args.contains(where: { ["--receipt-snapshot", "--receipt-audit", "--dry-run"].contains($0) }) {
        throw HelperError(400, "Receipt audit arguments require offline reconciliation mode.")
      }
      if args.contains("--list-displays") {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count <= 32 else {
          throw HelperError(503, "Cannot enumerate active displays.")
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
          throw HelperError(503, "Cannot enumerate active displays.")
        }
        let displays = ids.prefix(Int(count)).map {
          DisplayInfo(id: $0, width: CGDisplayPixelsWide($0), height: CGDisplayPixelsHigh($0))
        }
        print(String(data: try JSONEncoder().encode(displays), encoding: .utf8)!)
        return
      }
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask)[0]
      let config = try loadConfiguration(arguments: args, applicationSupport: applicationSupport)
      if args.contains("--check-config") {
        print("Configuration is valid. No listener, capture or input was started.")
        return
      }
      let base = applicationSupport.appendingPathComponent("ClawdTimeCompanion", isDirectory: true).appendingPathComponent(
          config.deviceId, isDirectory: true)
      if reconciliationMode {
        let switches: Set<String> = ["--reconcile-legacy-receipts", "--dry-run"]
        let valued: Set<String> = ["--config", "--receipt-snapshot", "--receipt-audit"]
        var values: [String: String] = [:]
        var seen = Set<String>()
        var index = 1
        while index < args.count {
          let flag = args[index]
          guard seen.insert(flag).inserted else { throw HelperError(400, "Duplicate reconciliation argument.") }
          if switches.contains(flag) { index += 1; continue }
          guard valued.contains(flag), index + 1 < args.count, args[index + 1].hasPrefix("/") else {
            throw HelperError(400, "Offline reconciliation requires explicit absolute private paths.")
          }
          values[flag] = args[index + 1]
          index += 2
        }
        guard values["--config"] != nil, let snapshot = values["--receipt-snapshot"], let audit = values["--receipt-audit"] else {
          throw HelperError(400, "Provide --config, --receipt-snapshot and --receipt-audit for offline reconciliation.")
        }
        let result = try ReceiptStore.reconcileLegacy(
          journal: base.appendingPathComponent("action-receipts.json"),
          snapshot: URL(fileURLWithPath: snapshot), audit: URL(fileURLWithPath: audit),
          deviceId: config.deviceId, dryRun: args.contains("--dry-run"))
        print(String(data: try JSONEncoder().encode(result), encoding: .utf8)!)
        return
      }
      let delegate = try DeviceApp(
        config: config, ledgerURL: base.appendingPathComponent("action-receipts.json"))
      let app = NSApplication.shared
      app.delegate = delegate
      app.run()
      withExtendedLifetime(delegate) {}
    } catch {
      fputs(
        "ClawdTime companion helper: \((error as? HelperError)?.message ?? "startup failed")\n",
        stderr)
      exit(1)
    }
  }
}
