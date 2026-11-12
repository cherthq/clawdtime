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
  var timer: Timer?
  var lastFrameRequest = Date.distantPast
  var frameBounds: CGRect?
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
  @objc func stop() {
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
    guard let lease = policy.lease else {
      panel?.orderOut(nil)
      return
    }
    let title = "◉ \(lease.mode == "control" ? "CONTROL" : "VIEW") · \(lease.displayId)"
    if panel == nil {
      let p = NSPanel(
        contentRect: NSRect(x: 30, y: 30, width: 300, height: 85),
        styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
      p.title = "ClawdTime, screen sharing"
      p.level = .floating
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      p.isMovableByWindowBackground = true
      p.hidesOnDeactivate = false
      let text = NSTextField(labelWithString: "")
      text.frame = NSRect(x: 12, y: 48, width: 280, height: 23)
      p.contentView?.addSubview(text)
      label = text
      let button = NSButton(
        title: "STOP sharing and control", target: self, action: #selector(stop))
      button.frame = NSRect(x: 12, y: 10, width: 275, height: 30)
      p.contentView?.addSubview(button)
      panel = p
    }
    label?.stringValue = title
    panel?.orderFrontRegardless()
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
            retiredPanelCommands: controlPanel.retiredCommands))
      }
      if request.method == "POST", request.path == "/v1/panel" {
        let telemetry = try decode(PanelTelemetry.self, request.body)
        guard telemetry.policyRevision == policy.preferences.revision else {
          throw HelperError(409, "Panel status uses an old local policy.")
        }
        try controlPanel.update(telemetry, lease: policy.lease, now: Date())
        refreshSetup(force: true)
        return try .json(["accepted": true])
      }
      if request.method == "GET", request.path == "/v1/permissions" {
        // Authenticated metadata only: no TCC request, lease, frame or input.
        return try .json(config.displays)
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
        if ledger.unresolvedActionCount > 0 && (lease.mode == "control" || (lease.protocolVersion == 2 && lease.executor != "none")) {
          throw HelperError(409, "Reconcile outstanding input before granting an executor.")
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
        _ = try ledger.begin(action, lease: lease, now: Date())
        do {
          _ = try policy.validateAction(
            action, leaseId: leaseId, now: Date(), sessionAvailable: session.available,
            accessibility: AXIsProcessTrusted())
          try postInput(action, displayId: lease.displayId)
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
        let frame = try await capture.capture(lease.displayId)
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
        return HTTPResponse(
          contentType: "image/jpeg",
          headers: [
            "X-Frame-Id": stamp.id,
            "X-Captured-At": frameCaptureTimestamp(stamp.capturedAt),
            "X-Frame-Width": String(frame.width), "X-Frame-Height": String(frame.height),
          ], body: frame.jpeg)
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
