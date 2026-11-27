import AppKit
import ClawdTimeAppCore
import SwiftUI

/// The Settings window. It opens from the gear of the setup window, from
/// Settings… in the menu bar menu and with Command-comma. It reads the
/// settings again each time it opens, and the permissions each time it
/// comes to the front, so a change made in System Settings shows at once.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
  let model: SettingsModel
  private let makeView: () -> SettingsRootView
  private let closed: () -> Void
  private var window: NSWindow?

  init(model: SettingsModel, makeView: @escaping () -> SettingsRootView, closed: @escaping () -> Void) {
    self.model = model
    self.makeView = makeView
    self.closed = closed
  }

  var isVisible: Bool { window?.isVisible == true }

  func show() {
    if window == nil {
      let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: SettingsRootView.size),
        styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
      window.titleVisibility = .hidden
      window.titlebarAppearsTransparent = true
      window.isMovableByWindowBackground = true
      window.title = "ClawdTime Settings"
      window.contentView = NSHostingView(rootView: makeView())
      window.isReleasedWhenClosed = false
      window.delegate = self
      window.center()
      self.window = window
    }
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    Task { await model.load() }
  }

  func windowDidBecomeKey(_ notification: Notification) {
    guard model.work == nil else { return }
    Task { await model.checkPermissions() }
  }

  func windowWillClose(_ notification: Notification) { closed() }
}

/// The gear at the top right of the setup window. It sits in the title bar,
/// so the setup screens keep their own layout.
final class SettingsGearButton: NSButton {
  private var onPress: () -> Void = {}

  static func attach(to window: NSWindow, open: @escaping () -> Void) {
    let button = SettingsGearButton(frame: NSRect(x: 4, y: 2, width: 24, height: 24))
    button.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "Settings")
    button.isBordered = false
    button.imagePosition = .imageOnly
    button.contentTintColor = Theme.nsColor(.secondaryText)
    button.toolTip = "Settings (Command-comma)"
    button.setAccessibilityLabel("Settings")
    button.onPress = open
    button.target = button
    button.action = #selector(pressed)
    let holder = NSView(frame: NSRect(x: 0, y: 0, width: 40, height: 28))
    holder.addSubview(button)
    let accessory = NSTitlebarAccessoryViewController()
    accessory.view = holder
    accessory.layoutAttribute = .trailing
    window.addTitlebarAccessoryViewController(accessory)
  }

  @objc private func pressed() { onPress() }
}
