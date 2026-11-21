import AppKit
import ApplicationServices
import DeviceCore

extension DeviceApp {
  @objc func showSetup() {
    if setupWindow == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 620, height: 740),
        styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
      window.title = localOnly ? "ClawdTime Local Control" : "ClawdTime Control Panel"
      window.isReleasedWhenClosed = false
      window.center()
      let content = window.contentView!
      let stack = NSStackView()
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 12; stack.detachesHiddenViews = true
      stack.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(stack)
      NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
        stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
        stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
      ])
      func text(_ value: String, bold: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = bold ? .boldSystemFont(ofSize: 18) : .systemFont(ofSize: 13)
        field.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(field)
        field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return field
      }
      _ = text(localOnly ? "ClawdTime Local Control" : "ClawdTime Control Panel", bold: true)
      _ = text(
        localOnly ? "ClawdTime handles explicitly enabled local computer tasks. Permission, local Enable and action approval remain separate." : "Your coding agent owns the conversation. Sharing and computer control have separate permissions."
      )
      connectionLabel = text("")
      setupStateLabel = text("")
      func permissionRow(_ title: String, action: Selector) -> NSTextField {
        let row = NSStackView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .centerY
        row.distribution = .fill
        let label = NSTextField(labelWithString: "")
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        row.addArrangedSubview(label)
        row.addArrangedSubview(button)
        stack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return label
      }
      setupScreenLabel = permissionRow(
        "Grant Screen Recording…", action: #selector(screenPermission))
      setupControlLabel = permissionRow(
        "Grant Accessibility…", action: #selector(controlPermission))
      setupDisplaysLabel = text("")
      _ = text("Computer control", bold: true)
      let choices = NSPopUpButton(frame: .zero, pullsDown: false)
      choices.addItems(withTitles: ComputerControlPolicy.allCases.map(\.label))
      choices.target = self
      choices.action = #selector(changeControlPolicy)
      stack.addArrangedSubview(choices)
      policyChoice = choices
      _ = text("Saved preferences never grant a call or macOS access. Changing mode stops sharing; Enable locally remains separate.")
      callLabel = text("")
      executionLabel = text("")
      let callButtons = NSStackView()
      callButtons.orientation = .horizontal
      callButtons.spacing = 12
      let mute = NSButton(title: "Mute", target: self, action: #selector(toggleMute))
      let end = NSButton(title: "End call", target: self, action: #selector(endCall))
      let pause = NSButton(title: "Request pause", target: self, action: #selector(requestPause))
      for button in [mute, end, pause] { button.bezelStyle = .rounded; callButtons.addArrangedSubview(button) }
      muteButton = mute; endButton = end; pauseButton = pause
      stack.addArrangedSubview(callButtons)
      callButtons.isHidden = localOnly; callLabel?.isHidden = localOnly
      let buttons = NSStackView()
      buttons.translatesAutoresizingMaskIntoConstraints = false
      buttons.orientation = .horizontal
      buttons.spacing = 12
      let enable = NSButton(title: "Enable locally", target: self, action: #selector(arm))
      enable.bezelStyle = .rounded
      let stop = NSButton(
        title: "STOP sharing and control", target: self, action: #selector(self.stop))
      stop.bezelStyle = .rounded
      stop.contentTintColor = .systemRed
      buttons.addArrangedSubview(enable)
      buttons.addArrangedSubview(stop)
      stack.addArrangedSubview(buttons)
      _ = text(
        "Stop blocks new ClawdTime capture and input. An action already underway may finish; native agent tools stop cooperatively. Pending outcomes must be reconciled. macOS permission changes may require relaunch."
      )
      setupWindow = window
    }
    refreshSetup(force: true)
    NSApp.activate(ignoringOtherApps: true)
    setupWindow?.makeKeyAndOrderFront(nil)
  }

  @objc func changeControlPolicy() {
    guard let index = policyChoice?.indexOfSelectedItem,
      ComputerControlPolicy.allCases.indices.contains(index) else { return }
    let next = ComputerControlPolicy.allCases[index]
    guard next != policy.preferences.policy else { return }
    // Stop our path immediately, even when an unresolved outcome prevents widening.
    stopWork(reason: .policyUpdated)
    do {
      if (unresolvedInputCount) > 0 && next != .viewOnly {
        throw HelperError(409, "Reconcile outstanding input before changing computer-control mode. Sharing is stopped.")
      }
      try policy.updatePreferences(preferences.set(next))
    } catch { showError((error as? HelperError)?.message ?? "Local policy could not be saved. Sharing remains stopped.") }
    refreshSetup(force: true)
  }
  func queuePanelCommand(_ type: String) {
    do { try controlPanel.request(type, now: Date()) }
    catch { showError((error as? HelperError)?.message ?? "Call control unavailable.") }
    refreshSetup(force: true)
  }
  @objc func toggleMute() {
    queuePanelCommand(controlPanel.current(now: Date())?.callState == "muted" ? "unmute" : "mute")
  }
  @objc func endCall() { queuePanelCommand("end") }
  @objc func requestPause() { queuePanelCommand("pause") }

  func refreshSetup(force: Bool = false) {
    guard setupWindow != nil, force || Date().timeIntervalSince(lastSetupRefresh) >= 1 else {
      return
    }
    lastSetupRefresh = Date()
    let state =
      policy.lease.map {
        "\($0.mode == "control" ? "Controlling" : "Viewing") display \($0.displayId)"
      }
      ?? localPolicy.lease.map { "Local work on display \($0.displayId)" }
      ?? (policy.armed
        ? "Enabled locally · waiting for an authorized request"
        : "Stopped locally · sharing and control are off")
    setupStateLabel?.stringValue = state
    if let index = ComputerControlPolicy.allCases.firstIndex(of: policy.preferences.policy) {
      policyChoice?.selectItem(at: index)
    }
    let telemetry = controlPanel.current(now: Date())
    connectionLabel?.stringValue = telemetry.map {
      "Connected · \($0.agent == "codex" ? "Codex" : "Claude Code") · \($0.projectLabel ?? "Current project")\n\($0.personLabel ?? "Paired person confirmed") · Current coding chat"
    } ?? "Connection: waiting for current agent and call status. Pairing remains configured on this Mac."
    if localOnly {
      connectionLabel?.stringValue = localHelperConflict
        ? "Local work unavailable: quit the other ClawdTime helper first."
        : "Standalone local executor · no phone call required"
    }
    callLabel?.stringValue = "Call: " + (telemetry?.callState ?? "Status unavailable")
    let executionNames = ["working": "Working", "waiting": "Waiting", "pending_approval": "Waiting for native approval", "uncertain": "Action outcome unresolved"]
    let executorNames = ["native": "Agent tools", "clawdtime": "ClawdTime fallback", "none": "No computer-control executor"]
    executionLabel?.stringValue = telemetry.map {
      "\(executorNames[$0.executor] ?? "Unknown executor") · \(executionNames[$0.executionState] ?? "Unknown status")"
    } ?? "Execution: no current status"
    if localOnly {
      executionLabel?.stringValue = localPolicy.lease.map { "Local executor \($0.executorId) · task \($0.taskId)" } ?? "No active local task"
    }
    if localLedger.unresolvedActions > 0 {
      executionLabel?.stringValue += "\n\(localLedger.unresolvedActions) unresolved local action(s) block computer control."
    }
    if ledger.unresolvedActionCount > 0 {
      executionLabel?.stringValue += "\n\(ledger.unresolvedActionCount) unresolved input outcome(s) block computer control."
    }
    if ledger.historicalObservedActionCount > 0 {
      executionLabel?.stringValue += "\n\(ledger.historicalObservedActionCount) historical input(s): later frame recorded; ownership closed."
    }
    if ledger.historicalUnverifiedActionCount > 0 {
      executionLabel?.stringValue += "\n\(ledger.historicalUnverifiedActionCount) historical input(s): result unverified; ownership closed, no replay."
    }
    if !controlPanel.retiredCommands.isEmpty { executionLabel?.stringValue += "\nEarlier call control outcome(s) remain unresolved." }
    if controlPanel.command != nil { executionLabel?.stringValue += "\nCall control awaiting acknowledgement." }
    let enabled = telemetry != nil && telemetry?.callState != "ended" && controlPanel.command == nil
    muteButton?.isEnabled = enabled; endButton?.isEnabled = enabled; pauseButton?.isEnabled = enabled
    muteButton?.title = telemetry?.callState == "muted" ? "Unmute" : "Mute"
    setupScreenLabel?.stringValue =
      "View permission: \(CGPreflightScreenCaptureAccess() ? "Granted" : "Not granted")"
    setupControlLabel?.stringValue =
      "Control permission: \(AXIsProcessTrusted() ? "Granted" : "Not granted")"
    setupDisplaysLabel?.stringValue =
      config.displays.isEmpty
      ? "Configured displays: none. An operator must explicitly select a display before sharing."
      : "Configured displays:\n"
        + config.displays.map {
          "Display \($0.displayId) · \(CGDisplayIsActive($0.displayId) != 0 ? "online" : "unavailable") · \($0.viewers.count) viewer(s), \($0.controllers.count) controller(s)"
        }.joined(separator: "\n")
    if let locals = config.localExecutors, !locals.isEmpty {
      setupDisplaysLabel?.stringValue += "\nLocal executors: " + locals.map { "\($0.executorId) on display \($0.displayId)" }.joined(separator: ", ")
    }
  }
}
