import AppKit
import ClawdTimeAppCore
import Combine
import SwiftUI

/// The app: the setup window on first launch, then the menu bar. It owns the
/// engine during setup and, through `ProcessOwner`, the desktop and the
/// connection afterward. Quit ends all of them.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  static let setupDoneKey = "ClawdTimeSetupDone"

  private let runtimeOverride: URL?
  private let defaults: UserDefaults
  private let loginItem: LoginItemControlling
  private(set) var setup: SetupCoordinator!
  private(set) var owner: ProcessOwner!
  private var window: NSWindow?
  private var menuBar: MenuBarController?
  private var watch: AnyCancellable?
  private var quitting = false

  init(runtimeOverride: URL?, defaults: UserDefaults = .standard, loginItem: LoginItemControlling = AppLoginItem()) {
    self.runtimeOverride = runtimeOverride
    self.defaults = defaults
    self.loginItem = loginItem
    super.init()
  }

  var setupDone: Bool { defaults.bool(forKey: Self.setupDoneKey) }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
    let runtimeURL = runtimeOverride ?? RuntimeLayout.bundled()
    var layout: RuntimeLayout?
    var problem: String?
    do {
      guard let runtimeURL else { throw RuntimeProblem.missing("runtime folder") }
      layout = try RuntimeLayout.load(runtimeURL)
    } catch {
      problem = String(describing: error)
    }
    let launcher = layout?.launcher ?? URL(fileURLWithPath: "/nonexistent/clawdtime")
    let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
      .appendingPathComponent("Logs/ClawdTime", isDirectory: true)
    owner = ProcessOwner(launcher: launcher, logs: logs)
    setup = SetupCoordinator(
      makeEngine: { local in
        guard let layout else { throw RuntimeProblem.missing("runtime folder") }
        return EngineProcess(executable: layout.launcher, arguments: SetupProtocol.arguments(local: local))
      },
      owner: owner,
      open: { NSWorkspace.shared.open($0) })
    setup.onFinish = { [weak self] in self?.didFinishSetup() }
    watch = setup.$state.sink { [weak self] state in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.stateChanged(state) } }
    }

    if let problem {
      NSApp.setActivationPolicy(.regular)
      showWindow()
      setup.reportRuntimeProblem(problem)
      return
    }
    if setupDone {
      // Setup was done before: check it again quietly, and show the window only if a step needs the person.
      NSApp.setActivationPolicy(.accessory)
      installMenuBar()
      setup.finishWhenReady = true
      setup.begin()
    } else {
      NSApp.setActivationPolicy(.regular)
      showWindow()
    }
  }

  private func stateChanged(_ state: SetupState) {
    guard !quitting else { return }
    switch state.phase {
    case .running:
      if window?.isVisible != true, let step = state.current, step.state == .needsInput || step.state == .failed { showWindow() }
    case .failed:
      if window?.isVisible != true { showWindow() }
    case .finished(let ready):
      if !ready && window?.isVisible != true { showWindow() }
    default: break
    }
  }

  private func didFinishSetup() {
    defaults.set(true, forKey: Self.setupDoneKey)
    installMenuBar()
    if setup.finishWhenReady && window?.isVisible != true { return }
    window?.close()
  }

  private func installMenuBar() {
    guard menuBar == nil else { return }
    menuBar = MenuBarController(
      owner: owner,
      openWindow: { [weak self] in self?.showWindow() },
      stop: { [weak self] in self?.setup.stop() },
      start: { [weak self] in
        guard let self else { return }
        self.setup.finishWhenReady = true
        self.setup.begin()
      })
  }

  func showWindow() {
    if window == nil {
      let root = SetupRootView(setup: setup, owner: owner, loginItem: loginItem, close: { [weak self] in self?.window?.close() })
      let hosting = NSHostingView(rootView: root)
      let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: SetupRootView.size),
        styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
      window.titleVisibility = .hidden
      window.titlebarAppearsTransparent = true
      window.isMovableByWindowBackground = true
      window.title = "ClawdTime"
      window.contentView = hosting
      window.isReleasedWhenClosed = false
      window.delegate = self
      window.center()
      self.window = window
    }
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    // After setup the app lives in the menu bar alone.
    if menuBar != nil { NSApp.setActivationPolicy(.accessory) }
  }

  func applicationDidBecomeActive(_ notification: Notification) { setup?.applicationDidBecomeActive() }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !quitting else { return .terminateLater }
    quitting = true
    setup.shutdown { NSApp.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
}
