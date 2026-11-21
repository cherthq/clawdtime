import AppKit
import ApplicationServices
import TaskPanelCore

/// The hands of computer use. A worker in the task service decides one action at
/// a time; this asks for the next command, runs it on this Mac and posts one
/// result. Only this app sees the screen and sends input, because macOS gives
/// those rights to one app that the person can see and stop.
///
/// What it keeps true:
/// - One command at a time, and one result for each sequence number, sent once.
/// - With a right missing nothing runs, and macOS shows a prompt only when the
///   person clicks the menu item.
/// - While a run is active a bar with Stop is on the screen. After Stop, a
///   command that waits is answered and not run.
/// - ClawdTime's own windows are not in the picture, a click never lands on
///   them, and typed keys never go to them.
@MainActor final class HandsController: NSObject {
  private let pet: PetController
  private let input = HandsInput()
  private let observer = HandsObserver()
  private let bar = HandsBar()
  private let guide: GuidedCursor
  private var client: PanelClient?
  private var loop: Task<Void, Never>?
  private var ledger = HandsLedger()
  private var stop = HandsStop()
  private var run: HandsNext.Run?
  /// The worker runs, or a command waits: the bar is up and the tap listens.
  private var live = false
  private var label = ""
  /// When the bar came into view.
  private var barUp: Date?
  private var typingMark = 0
  private let menuItems = NSHashTable<NSMenuItem>.weakObjects()
  private var rights: (accessibility: Bool, screenRecording: Bool, at: Date)?
  /// A run begins: the app's own sheets get out of the way.
  var onRunStarted: (() -> Void)?

  init(pet: PetController) {
    self.pet = pet
    guide = GuidedCursor(pet: pet)
    super.init()
    bar.onStop = { [weak self] in self?.stopByPerson() }
    input.onEscapeHold = { [weak self] in self?.stopByPerson() }
  }

  // MARK: the loop

  /// Starts to ask the task service for commands. It asks often while the worker runs, and seldom otherwise.
  func start(client: PanelClient) {
    guard loop == nil else { return }
    self.client = client
    loop = Task { [weak self] in
      var failures = 0
      while !Task.isCancelled {
        guard let self else { return }
        var active = false
        do {
          let next = try await client.handsNext(after: self.ledger.last)
          failures = 0
          active = next.run.active || next.command != nil
          self.present(next)
          // A number that was taken before is never run again.
          if let pending = next.command, self.ledger.claim(pending.seq) {
            let result = await self.perform(pending)
            // Exactly one POST for this number. A failure is not sent again: the
            // worker reads a missing answer as an unknown outcome.
            try? await client.handsResult(result)
            self.showBar()
          }
        } catch {
          failures += 1
          // A service that is gone commands nothing: the bar goes too.
          if failures >= HandsPace.failuresBeforeQuiet { self.quiet() }
        }
        try? await Task.sleep(nanoseconds: UInt64(HandsPace.delay(active: active, failures: failures) * 1_000_000_000))
      }
    }
  }
  func shutdown() {
    loop?.cancel(); loop = nil
    input.halted = true
    input.letGo()
    quiet()
  }
  /// The task service that answers now. Another instance counts its commands from the start again.
  func service(instance: String) { ledger.service(instance) }

  private func present(_ next: HandsNext) {
    // A command that waits counts as a run: the person sees the bar before anything is done.
    let active = next.run.active || next.command != nil
    run = next.run
    stop.observe(active: active)
    if !stop.stopped { input.halted = false }
    guard active else { quiet(); return }
    if !live {
      live = true; label = ""
      onRunStarted?()
    }
    if let pending = next.command { label = ElementCleaner.line(pending.label, limit: 120) }
    shield(true)
    // The tap needs the Accessibility right. It starts as soon as the right is there.
    input.watch()
    showBar()
  }
  /// Nothing runs: the bar, the guided cursor and the tap go, and the windows show in captures again.
  private func quiet() {
    guard live || bar.isShown else { return }
    live = false; label = ""
    bar.hide(); guide.hide(); guide.typing(false)
    input.unwatch()
    shield(false)
  }
  private func showBar() {
    guard live else { return }
    let detail: String
    if stop.stopped { detail = "Stopped. Nothing more runs on this Mac." }
    else if run?.state == "waiting_for_person" { detail = "Waiting for you" }
    else if !label.isEmpty { detail = label }
    else { detail = ElementCleaner.line(run?.goal ?? "", limit: 80) }
    if !bar.isShown { barUp = Date() }
    bar.show(detail: detail, stopped: stop.stopped, canStop: !stop.stopped)
  }

  // MARK: Stop

  /// The person pressed Stop on the bar, or held Escape. From now nothing more
  /// runs here, whatever the service answers. The request to the worker goes once.
  private func stopByPerson() {
    guard live, !stop.stopped else { return }
    stop.press()
    input.halted = true
    guide.hide(); guide.typing(false)
    showBar()
    guard let client else { return }
    // Cooperative: an action already underway may finish. The request is never replayed.
    Task { _ = try? await client.stopExecution() }
  }

  // MARK: one command

  private func perform(_ pending: HandsNext.Pending) async -> HandResult {
    let seq = pending.seq, command = pending.command
    // The bar with Stop is in view for a moment before the first action of a run.
    if let since = barUp {
      let age = Date().timeIntervalSince(since)
      if age < 0.25 { await pause(0.25 - age) }
    }
    if stop.stopped { return .failure(seq, .stoppedByPerson) }
    // Both checks are silent. With a right missing nothing runs.
    let accessibility = AXIsProcessTrusted()
    let screenRecording = !command.needsScreenRecording || CGPreflightScreenCaptureAccess()
    if let missing = command.missingRight(accessibility: accessibility, screenRecording: screenRecording) { return .failure(seq, missing) }
    input.beginCommand()
    let outcome = await act(command, accessibility: accessibility)
    // Without the tap nobody listened, so nothing is said about the person.
    let interrupted = input.watching && input.personActed
    switch outcome {
    case .success(let seen):
      let result = HandResult.done(seq, observation: seen, interrupted: interrupted)
      // What the service would refuse is not sent: the worker hears that the command failed.
      return (try? result.validate()) != nil ? result : .failure(seq, .failed, interrupted: interrupted)
    case .failure(let error):
      return .failure(seq, error, interrupted: interrupted)
    }
  }

  private func act(_ command: HandCommand, accessibility: Bool) async -> Result<Observation?, HandError> {
    if case .wait(let ms) = command {
      var left = Double(ms) / 1000
      while left > 0 {
        if stop.stopped { return .failure(.stoppedByPerson) }
        let slice = min(0.05, left)
        await pause(slice); left -= slice
      }
      return .success(nil)
    }
    // A locked screen, or another person's session in front: the hands do nothing.
    guard sessionOpen else { return .failure(.refused) }
    switch command {
    case .observe(let image, let elements):
      shield(true)
      return await observer.observe(image: image, elements: elements, accessibility: accessibility, pointer: input.pointer).map { Optional($0) }
    case .move, .click, .drag, .scroll:
      return await point(command)
    case .type(let text):
      // The hands never type into ClawdTime itself, and never into a password field.
      guard await keyboardFree(), !(await focusIsSecure()) else { return .failure(.refused) }
      showTyping(); defer { endTyping() }
      // A Tab or a Return in the text can move the keyboard, so the same two checks run again on the way.
      switch await input.type(text, allowed: { [self] in await mayType() }) {
      case .done: return .success(nil)
      case .stopped: return .failure(.stoppedByPerson)
      case .refused: return .failure(.refused)
      }
    case .key(let combo):
      guard let keys = KeyCombo.parse(combo), await keyboardFree() else { return .failure(.refused) }
      // A key that prints a character is text: it stays out of a password field too. Return, Tab and shortcuts may go.
      if keys.typesText, await focusIsSecure() { return .failure(.refused) }
      // Stop may have come during the waits above.
      if stop.stopped { return .failure(.stoppedByPerson) }
      showTyping(); defer { endTyping() }
      return await input.key(keys) ? .success(nil) : .failure(.stoppedByPerson)
    case .openApp(let name):
      guard let safe = HandsTarget.appName(name) else { return .failure(.refused) }
      guard let app = Self.application(named: safe) else { return .failure(.notFound) }
      let settings = NSWorkspace.OpenConfiguration()
      settings.activates = true
      do { _ = try await NSWorkspace.shared.openApplication(at: app, configuration: settings); return .success(nil) }
      catch { return .failure(.failed) }
    case .openURL(let text):
      // Only a web address. Another scheme can start a program or a call.
      guard let url = HandsTarget.webURL(text) else { return .failure(.refused) }
      return NSWorkspace.shared.open(url) ? .success(nil) : .failure(.failed)
    case .wait:
      return .success(nil)
    }
  }

  /// A pointing command: the guided cursor travels from the mascot to the target, then the real event goes.
  private func point(_ command: HandCommand) async -> Result<Observation?, HandError> {
    guard let map = HandsDisplay.main?.map, !command.places.isEmpty, command.places.allSatisfy(map.contains) else { return .failure(.refused) }
    let places = command.places.map(map.clamp)
    // ClawdTime's windows are not in the picture that the worker saw. A click on
    // one of them goes through to what is behind it, which is what the worker meant.
    var restore = passThrough(places.map(map.flip))
    defer { restore.forEach { $0() }; guide.rest() }
    await guide.travel(to: map.flip(places[0]))
    guard !stop.stopped, await input.move(to: places[0]) else { return .failure(.stoppedByPerson) }
    // A window of ClawdTime that came up on the way, for example a request with Approve on it, gets no click either.
    restore += passThrough(places.map(map.flip))
    let done: Bool
    switch command {
    case .click(_, _, let button, let count):
      guide.pulse()
      done = await input.click(at: places[0], button: button, count: count)
    case .drag:
      done = await input.drag(from: places[0], to: places[1])
    case .scroll(_, _, let dx, let dy):
      done = await input.scroll(at: places[0], dx: dx, dy: dy)
    default:
      done = true
    }
    return done ? .success(nil) : .failure(.stoppedByPerson)
  }

  // MARK: ClawdTime keeps out of its own way

  /// The windows of this app under `places` let clicks through. The result puts them back.
  private func passThrough(_ places: [CGPoint]) -> [() -> Void] {
    var restore: [() -> Void] = []
    if pet.visible, places.contains(where: pet.frame.contains) {
      pet.letClicksThrough(true)
      restore.append { [pet] in pet.letClicksThrough(false) }
    }
    for window in NSApp.windows where window !== pet.window && window.isVisible && !window.ignoresMouseEvents && places.contains(where: window.frame.contains) {
      window.ignoresMouseEvents = true
      restore.append { [weak window] in window?.ignoresMouseEvents = false }
    }
    return restore
  }
  /// Keys go to the window that has the keyboard. When that is a window of
  /// ClawdTime, for example its chat, this waits a moment for it to close.
  private func keyboardFree() async -> Bool {
    for _ in 0..<12 where NSApp.keyWindow != nil { await pause(0.05) }
    return NSApp.keyWindow == nil
  }
  /// In the middle of typed text: the keyboard is still outside ClawdTime and outside a password field.
  private func mayType() async -> Bool {
    guard NSApp.keyWindow == nil else { return false }
    return !(await focusIsSecure())
  }
  /// The field that has the keyboard is a password field: the Accessibility
  /// tree says so, or macOS guards the keyboard as it does for one. An app that
  /// does not name its fields is covered by the second sign. Either one is enough.
  private func focusIsSecure() async -> Bool {
    let secure = await Task.detached(priority: .userInitiated) { HandsTree.focusIsSecure() }.value
    return secure == true || input.secureInput
  }
  /// While the worker runs, every window of this app has a sharing type that
  /// keeps it out of captures. The bar and the guided cursor always have it.
  private func shield(_ on: Bool) {
    for window in NSApp.windows where window !== bar.window && window !== guide.window {
      let type: NSWindow.SharingType = on ? .none : .readOnly
      if window.sharingType != type { window.sharingType = type }
    }
  }
  /// The person's own session is in front and the screen is not locked.
  private var sessionOpen: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session[kCGSessionOnConsoleKey as String] as? Bool == true && session["CGSSessionScreenIsLocked"] as? Bool != true
  }
  private func showTyping() { typingMark += 1; guide.typing(true) }
  /// The typing pose stays a moment after the last key, so one key press shows too.
  private func endTyping() {
    let mark = typingMark
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 240_000_000)
      guard let self, self.typingMark == mark else { return }
      self.guide.typing(false)
    }
  }
  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  /// An app by the name that a person says, or by its bundle identifier.
  private static func application(named name: String) -> URL? {
    let workspace = NSWorkspace.shared
    if name.contains("."), !name.contains(" "), let found = workspace.urlForApplication(withBundleIdentifier: name) { return found }
    func same(_ other: String?) -> Bool { other?.caseInsensitiveCompare(name) == .orderedSame }
    if let running = workspace.runningApplications.first(where: { $0.activationPolicy == .regular && same($0.localizedName) }),
      let found = running.bundleURL { return found }
    let files = FileManager.default
    let folders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                   NSHomeDirectory() + "/Applications", "/System/Library/CoreServices", "/System/Library/CoreServices/Applications"]
    let apps = folders.flatMap { folder in
      ((try? files.contentsOfDirectory(atPath: folder)) ?? []).filter { $0.hasSuffix(".app") }.map { (folder: folder, file: $0) }
    }
    // First by the name of the file, then by the name that the Finder shows in the person's language.
    if let match = apps.first(where: { same(String($0.file.dropLast(4))) }) { return URL(fileURLWithPath: match.folder + "/" + match.file) }
    if let match = apps.first(where: {
      let shown = files.displayName(atPath: $0.folder + "/" + $0.file)
      return same(shown) || same(shown.hasSuffix(".app") ? String(shown.dropLast(4)) : shown)
    }) { return URL(fileURLWithPath: match.folder + "/" + match.file) }
    return nil
  }

  // MARK: rights

  /// The one menu item for the two rights. A click asks macOS for both; its second line shows each.
  func menuItem() -> NSMenuItem {
    let item = NSMenuItem(title: "Computer use: grant access", action: #selector(grantAccess), keyEquivalent: "")
    item.target = self
    item.toolTip = "ClawdTime needs both to act on this Mac when you ask it to. After you allow screen recording, macOS may ask you to start ClawdTime again."
    menuItems.add(item)
    describe(item)
    return item
  }
  /// Shows the state of each right on every copy of the menu item.
  func refreshMenu() { for item in menuItems.allObjects { describe(item) } }
  private func describe(_ item: NSMenuItem) {
    // Both reads are silent. They are kept for a few seconds: the menus refresh every second.
    if rights.map({ Date().timeIntervalSince($0.at) > 5 }) ?? true {
      rights = (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), Date())
    }
    let accessibility = rights?.accessibility == true, screenRecording = rights?.screenRecording == true
    let state = "Accessibility: \(accessibility ? "granted" : "not granted") · Screen recording: \(screenRecording ? "granted" : "not granted")"
    if #available(macOS 14.4, *) { item.subtitle = state } else { item.title = "Computer use: grant access (" + state + ")" }
    item.state = accessibility && screenRecording ? .on : .off
  }
  /// The person clicked the menu item. Only here may macOS show its prompts.
  @objc private func grantAccess() {
    if !AXIsProcessTrusted() {
      _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    if !CGPreflightScreenCaptureAccess() {
      // macOS shows its prompt for screen recording once. After that the person switches it on in System Settings.
      let defaults = UserDefaults.standard
      if defaults.bool(forKey: "hands.askedScreenRecording"),
        let pane = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
        NSWorkspace.shared.open(pane)
      } else {
        defaults.set(true, forKey: "hands.askedScreenRecording")
        _ = CGRequestScreenCaptureAccess()
      }
    }
    rights = nil
    refreshMenu()
  }
}
