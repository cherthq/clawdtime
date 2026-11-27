import AppKit
import ClawdTimeAppCore
import Combine
import SwiftUI

/// The app: the setup window on first launch, then the menu bar. It owns the
/// engine during setup and, through `ProcessOwner`, the desktop and the
/// connection afterward. Quit ends all of them. It answers the `clawdtime://`
/// links of `AppLink`, which the panel's menu opens.
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
  private var settings: SettingsWindowController?
  private var watch: AnyCancellable?
  private var quitting = false
  /// Links that came before the app finished launching.
  private(set) var waitingLinks: [AppLink] = []
  /// This app's bundle, passed to the panel so that it opens Settings and Stop here.
  private let appBundle: URL? = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundleURL : nil

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
    owner = ProcessOwner(launcher: launcher, logs: logs, desktop: .desktop(app: appBundle))
    setup = SetupCoordinator(
      makeEngine: { local in
        guard let layout else { throw RuntimeProblem.missing("runtime folder") }
        return EngineProcess(executable: layout.launcher, arguments: SetupProtocol.arguments(local: local))
      },
      owner: owner,
      open: { NSWorkspace.shared.open($0) },
      // The second click of a double click never answers the next question,
      // even with a slow double-click setting (capped at 1.5 seconds).
      answerDelay: min(1.5, max(SetupCoordinator.defaultAnswerDelay, NSEvent.doubleClickInterval + 0.1)))
    setup.onFinish = { [weak self] in self?.didFinishSetup() }
    settings = makeSettings(layout)
    watch = setup.$state.sink { [weak self] state in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.stateChanged(state) } }
    }
    // The app's own item, from the first launch: setup, Settings and Stop are always one click away.
    installMenuBar()
    defer { answerWaitingLinks() }

    if let problem {
      NSApp.setActivationPolicy(.regular)
      showWindow()
      setup.reportRuntimeProblem(problem)
      return
    }
    if setupDone {
      // Setup was done before: check it again quietly, and show the window only if a step needs the person.
      NSApp.setActivationPolicy(.accessory)
      setup.finishWhenReady = true
      setup.begin()
    } else {
      NSApp.setActivationPolicy(.regular)
      showWindow()
    }
  }

  private func stateChanged(_ state: SetupState) {
    guard !quitting else { return }
    menuBar?.refresh()
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
    menuBar?.refresh()
    if setup.finishWhenReady && window?.isVisible != true { return }
    window?.close()
  }

  private func installMenuBar() {
    guard menuBar == nil else { return }
    let owner: ProcessOwner = owner
    let panelHasAppMenu = appBundle != nil
    menuBar = MenuBarController(
      owner: owner,
      shown: { [weak self] in
        OwnStatusItem.shown(setupDone: self?.setupDone ?? false, desktop: owner.desktop, panelOpen: owner.panelOpen, panelHasAppMenu: panelHasAppMenu)
      },
      busy: { [weak self] in self?.setup.engineIsRunning ?? false },
      openWindow: { [weak self] in self?.showWindow() },
      openSettings: { [weak self] in self?.showSettings(nil) },
      stop: { [weak self] in self?.setup.stop() },
      start: { [weak self] in
        guard let self else { return }
        // Before setup is done, Start runs setup in its window.
        self.setup.finishWhenReady = self.setupDone
        if !self.setupDone { self.showWindow() }
        self.setup.begin()
      })
  }

  /// `clawdtime://open`, `clawdtime://settings` and `clawdtime://stop`. Any other link does nothing.
  func application(_ application: NSApplication, open urls: [URL]) {
    let links = AppLink.links(in: urls)
    guard setup != nil else { waitingLinks += links; return }
    links.forEach(answer)
  }

  private func answerWaitingLinks() {
    let links = waitingLinks
    waitingLinks = []
    links.forEach(answer)
  }

  private func answer(_ link: AppLink) {
    guard !quitting else { return }
    switch link {
    case .open: showWindow()
    case .settings: showSettings(nil)
    case .stop: setup.stop()
    }
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
      SettingsGearButton.attach(to: window) { [weak self] in self?.showSettings(nil) }
      self.window = window
    }
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    // After setup the app lives in the menu bar alone.
    if setupDone && settings?.isVisible != true { NSApp.setActivationPolicy(.accessory) }
  }

  /// Settings… in both menus and the gear of the setup window. The main menu
  /// sends it with no target, so it reaches this delegate.
  @objc func showSettings(_ sender: Any?) { settings?.show() }

  private func makeSettings(_ layout: RuntimeLayout?) -> SettingsWindowController {
    let model = SettingsModel(
      runner: ProcessCommandRunner(), launcher: layout?.launcher,
      native: layout?.root.appendingPathComponent("app/native", isDirectory: true),
      desktop: owner, about: AboutInfo.current(layout), open: { NSWorkspace.shared.open($0) })
    let actions = SettingsActions(
      runSetup: { [weak self] in
        guard let self else { return }
        self.setup.finishWhenReady = false
        self.showWindow()
        self.setup.begin()
      },
      stop: { [weak self] in self?.setup.stop() })
    return SettingsWindowController(
      model: model,
      makeView: { [unowned self] in
        SettingsRootView(model: model, owner: self.owner, setup: self.setup, loginItem: self.loginItem, actions: actions)
      },
      closed: { [weak self] in
        guard let self else { return }
        if self.setupDone && self.window?.isVisible != true { NSApp.setActivationPolicy(.accessory) }
      })
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
