import AppKit
import ClawdTimeAppCore
import Combine

/// The words of the menu, kept apart so tests can read them.
enum MenuText {
  static func status(_ status: OwnedStatus) -> String {
    switch status {
    case .off: "off"
    case .starting: "starting"
    case .running: "running"
    case .stopping: "stopping"
    case .ended(let reason): reason
    }
  }

  static func summary(desktop: OwnedStatus, connection: OwnedStatus) -> String {
    switch (desktop, connection) {
    case (.off, .off): "ClawdTime is stopped"
    case (.stopping, _), (_, .stopping): "Stopping"
    case (.starting, _): "Starting the desktop"
    case (.running, .running): "Running · phone connection on"
    case (.running, .starting): "Running · connecting"
    case (.running, _): "Running on this Mac only"
    case (.ended(let reason), _): reason
    default: "ClawdTime is stopped"
    }
  }
}

/// The menu bar item after setup: Open ClawdTime, status, Stop (or Start), Quit.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
  private let item: NSStatusItem
  private let owner: ProcessOwner
  private let openWindow: () -> Void
  private let openSettings: () -> Void
  private let stop: () -> Void
  private let start: () -> Void
  private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let stopItem = NSMenuItem(title: "Stop", action: #selector(toggle), keyEquivalent: "")
  private var watch: AnyCancellable?

  init(owner: ProcessOwner, openWindow: @escaping () -> Void, openSettings: @escaping () -> Void = {},
       stop: @escaping () -> Void, start: @escaping () -> Void) {
    self.owner = owner
    self.openWindow = openWindow
    self.openSettings = openSettings
    self.stop = stop
    self.start = start
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    super.init()
    if let button = item.button {
      button.image = NSImage(systemSymbolName: "video.circle", accessibilityDescription: "ClawdTime")
      button.image?.isTemplate = true
    }
    let menu = NSMenu()
    menu.delegate = self
    let open = NSMenuItem(title: "Open ClawdTime", action: #selector(openClawdTime), keyEquivalent: "o")
    open.target = self
    let settings = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
    settings.target = self
    statusLine.isEnabled = false
    stopItem.target = self
    let quit = NSMenuItem(title: "Quit ClawdTime", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.items = [open, settings, .separator(), statusLine, stopItem, .separator(), quit]
    item.menu = menu
    watch = owner.objectWillChange.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.refresh() } }
    }
    refresh()
  }

  func refresh() {
    statusLine.title = MenuText.summary(desktop: owner.desktop, connection: owner.connection)
    stopItem.title = owner.isActive ? "Stop" : "Start"
    stopItem.isEnabled = owner.desktop != .stopping && owner.connection != .stopping
    item.button?.toolTip = "ClawdTime: \(statusLine.title)"
    item.button?.appearsDisabled = !owner.isActive
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  @objc private func openClawdTime() { openWindow() }
  @objc private func showSettings() { openSettings() }
  @objc private func toggle() { owner.isActive ? stop() : start() }
}
