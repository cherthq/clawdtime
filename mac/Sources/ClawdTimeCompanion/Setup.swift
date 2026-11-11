import AppKit
import ApplicationServices

extension DeviceApp {
  @objc func showSetup() {
    if setupWindow == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 540, height: 500),
        styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
      window.title = "ClawdTime Companion Setup"
      window.isReleasedWhenClosed = false
      window.center()
      let content = window.contentView!
      let stack = NSStackView()
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 16
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
      _ = text("Share this Mac on your terms.", bold: true)
      _ = text(
        "Grant viewing and control separately. Nothing shares or clicks until you enable this Mac locally and your paired agent requests attention."
      )
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
        "Enable permits authorized requests; it does not start capture. Stop disarms this Mac immediately. macOS may require a relaunch after a permission change."
      )
      setupWindow = window
    }
    refreshSetup(force: true)
    NSApp.activate(ignoringOtherApps: true)
    setupWindow?.makeKeyAndOrderFront(nil)
  }

  func refreshSetup(force: Bool = false) {
    guard setupWindow != nil, force || Date().timeIntervalSince(lastSetupRefresh) >= 1 else {
      return
    }
    lastSetupRefresh = Date()
    let state =
      policy.lease.map {
        "\($0.mode == "control" ? "Controlling" : "Viewing") display \($0.displayId)"
      }
      ?? (policy.armed
        ? "Enabled locally · waiting for an authorized request"
        : "Stopped locally · sharing and control are off")
    setupStateLabel?.stringValue = state
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
  }
}
