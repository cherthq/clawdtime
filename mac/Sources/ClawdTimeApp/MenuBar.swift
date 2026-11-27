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

/// The app's menu bar item: Open ClawdTime, Settings…, status, Stop (or
/// Start), Quit. It shows while setup is not done and while the app's desktop
/// does not run with its panel. Once it does, the panel's item offers Settings
/// and Stop ClawdTime too, so this one goes: one ClawdTime item, never two and
/// never none.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
  private var item: NSStatusItem?
  private let menu = NSMenu()
  private let owner: ProcessOwner
  private let shown: () -> Bool
  private let busy: () -> Bool
  private let openWindow: () -> Void
  private let openSettings: () -> Void
  private let stop: () -> Void
  private let start: () -> Void
  private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let stopItem = NSMenuItem(title: "Stop", action: #selector(toggle), keyEquivalent: "")
  private var watch: AnyCancellable?

  /// `shown`: the app's item shows now. `busy`: setup runs, so Stop has work to end.
  init(owner: ProcessOwner, shown: @escaping () -> Bool, busy: @escaping () -> Bool = { false },
       openWindow: @escaping () -> Void, openSettings: @escaping () -> Void = {},
       stop: @escaping () -> Void, start: @escaping () -> Void) {
    self.owner = owner
    self.shown = shown
    self.busy = busy
    self.openWindow = openWindow
    self.openSettings = openSettings
    self.stop = stop
    self.start = start
    super.init()
    menu.delegate = self
    let open = NSMenuItem(title: "Open ClawdTime", action: #selector(openClawdTime), keyEquivalent: "o")
    open.target = self
    let settings = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
    settings.target = self
    statusLine.isEnabled = false
    stopItem.target = self
    let quit = NSMenuItem(title: "Quit ClawdTime", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.items = [open, settings, .separator(), statusLine, stopItem, .separator(), quit]
    watch = owner.objectWillChange.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.refresh() } }
    }
    refresh()
  }

  var isShown: Bool { item != nil }

  func refresh() {
    let active = owner.isActive || busy()
    statusLine.title = MenuText.summary(desktop: owner.desktop, connection: owner.connection)
    stopItem.title = active ? "Stop" : "Start"
    stopItem.isEnabled = owner.desktop != .stopping && owner.connection != .stopping
    if shown() {
      if item == nil { item = makeItem() }
    } else if let item {
      NSStatusBar.system.removeStatusItem(item)
      self.item = nil
    }
    item?.button?.toolTip = "ClawdTime: \(statusLine.title)"
    item?.button?.appearsDisabled = !active
  }

  private func makeItem() -> NSStatusItem {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = item.button {
      button.image = NSImage(systemSymbolName: "video.circle", accessibilityDescription: "ClawdTime")
      button.image?.isTemplate = true
    }
    item.menu = menu
    return item
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  @objc private func openClawdTime() { openWindow() }
  @objc private func showSettings() { openSettings() }
  @objc private func toggle() { owner.isActive || busy() ? stop() : start() }
}
