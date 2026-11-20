import AppKit
import Darwin
import Foundation
import TaskPanelCore

/// The app: one mascot on the desktop and one board that opens out of it. The task
/// service owns every fact. This process shows them, sends the person's actions once,
/// and keeps a receipt for each.
@MainActor final class TaskPanelApp: NSObject, NSApplicationDelegate {
  var exitStatus: Int32 = 0
  private var reopenName: Notification.Name?
  private var configuration: PanelConfiguration?
  private var configPath: URL?
  private var receipts: PanelReceiptStore?
  private var client: PanelClient?
  private var state = PanelState()
  private var pollTask: Task<Void, Never>?
  private var board: AgentBoard?
  private var decisions: PendingDecisions?
  private var awayItems: [NSMenuItem] = []
  private var showRevision = false
  private var lastTaskId: String?
  private var startTucked = false
  private var localNotice = ""
  private let pet = PetController()
  private let boardPanel = BoardController()
  private var statusItem: NSStatusItem?
  private var stopSharingItems: [NSMenuItem] = []
  private var stopCallItems: [NSMenuItem] = []
  private var styleItems: [NSMenuItem] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    // An accessory: no Dock icon and no menu bar takeover. It lives beside the work.
    NSApp.setActivationPolicy(.accessory)
    Theme.registerFonts()
    configureMenus()
    if let launch = PanelLaunch(arguments: CommandLine.arguments) {
      startTucked = launch.tucked
      load(URL(fileURLWithPath: launch.configPath))
    } else {
      showStartupFailure(.configuration)
    }
  }

  // MARK: menus

  private func actions(into menu: NSMenu) {
    menu.addItem(withTitle: "Show ClawdTime", action: #selector(showPanel), keyEquivalent: "0").target = self
    menu.addItem(withTitle: "Open or close the board", action: #selector(toggleBoard), keyEquivalent: "b").target = self
    menu.addItem(withTitle: "Tuck against the edge", action: #selector(tuck), keyEquivalent: "").target = self
    let styles = NSMenuItem(title: "Mascot", action: nil, keyEquivalent: "")
    let styleMenu = NSMenu(title: "Mascot")
    for style in MascotStyle.allCases {
      let item = styleMenu.addItem(withTitle: style.title + ": " + style.summary, action: #selector(chooseStyle(_:)), keyEquivalent: "")
      item.target = self; item.representedObject = style.rawValue
      styleItems.append(item)
    }
    styles.submenu = styleMenu; menu.addItem(styles)
    let away = menu.addItem(withTitle: "Away: answer by phone", action: #selector(toggleAway(_:)), keyEquivalent: "")
    away.target = self; awayItems.append(away)
    menu.addItem(.separator())
    let sharing = menu.addItem(withTitle: "Stop sharing", action: #selector(stopSharing), keyEquivalent: "")
    sharing.target = self; stopSharingItems.append(sharing)
    let call = menu.addItem(withTitle: "Stop call", action: #selector(stopCall), keyEquivalent: "")
    call.target = self; stopCallItems.append(call)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit ClawdTime. Work keeps running.", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.autoenablesItems = false
  }
  private func contextMenu() -> NSMenu {
    let menu = NSMenu(); actions(into: menu); refreshMenus(); return menu
  }
  private func configureMenus() {
    let menu = NSMenu()
    let appItem = NSMenuItem(); menu.addItem(appItem)
    let submenu = NSMenu(title: "ClawdTime"); actions(into: submenu); appItem.submenu = submenu
    // Copy and paste in the answer fields need the Edit commands, even with no menu bar.
    let editItem = NSMenuItem(); let edit = NSMenu(title: "Edit")
    for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
      edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
    }
    editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem?.button?.image = Self.markImage()
    statusItem?.button?.toolTip = "ClawdTime"
    let statusMenu = NSMenu(); actions(into: statusMenu); statusItem?.menu = statusMenu
  }
  /// The stone and its ring, as a template image for the menu bar.
  private static func markImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      NSColor.black.setFill(); NSColor.black.setStroke()
      NSBezierPath(roundedRect: NSRect(x: 4.5, y: 4.5, width: 9, height: 8.5), xRadius: 4, yRadius: 4).fill()
      let ring = NSBezierPath(ovalIn: NSRect(x: 1.2, y: 6, width: 15.6, height: 5.6))
      var tilt = AffineTransform(translationByX: 9, byY: 9); tilt.rotate(byDegrees: -18); tilt.translate(x: -9, y: -9)
      ring.transform(using: tilt); ring.lineWidth = 1.3; ring.stroke()
      return true
    }
    image.isTemplate = true
    return image
  }
  @objc private func chooseStyle(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let style = MascotStyle(rawValue: raw) else { return }
    pet.style = style; refreshMenus()
  }
  private func refreshMenus() {
    for item in styleItems { item.state = (item.representedObject as? String) == pet.style.rawValue ? .on : .off }
    for item in awayItems {
      item.state = decisions?.away == true ? .on : .off
      item.title = decisions?.callReady == false ? "Away: answer by phone (no phone link yet)" : "Away: answer by phone"
    }
    for item in stopSharingItems { item.isEnabled = state.allows(.stopSharing) }
    for item in stopCallItems { item.isEnabled = state.allows(.stopCall) }
  }

  // MARK: start

  private func load(_ path: URL) {
    do {
      let config = try PrivatePanelFiles.configuration(at: path)
      if let configuration {
        guard config == configuration, path.standardizedFileURL == configPath else { throw PanelFailure.alreadyOpen }
        showPanel(nil); return
      }
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      let binding = PrivatePanelFiles.digest(try encoder.encode(config))
      let name = Notification.Name("com.clawdtime.task-panel.show." + config.desktopId + "." + config.configurationFingerprint)
      let store: PanelReceiptStore
      do { store = try PanelReceiptStore(directory: config.receiptDirectory, binding: binding) }
      catch PanelFailure.alreadyOpen {
        // A tucked start asks for no attention, so it does not raise the open panel.
        if !startTucked {
          DistributedNotificationCenter.default().postNotificationName(name, object: nil, userInfo: nil, deliverImmediately: true)
        }
        showStartupFailure(.alreadyOpen); return
      }
      reopenName = name
      DistributedNotificationCenter.default().addObserver(self, selector: #selector(showPanel), name: name, object: nil, suspensionBehavior: .deliverImmediately)
      self.configuration = config; self.configPath = path.standardizedFileURL
      receipts = store; client = PanelClient(configuration: config); state.pending = store.entries
      wire(); render()
      pet.show()
      if !startTucked { openBoard() }
      beginPolling()
    } catch let failure as PanelFailure { showStartupFailure(failure) }
      catch { showStartupFailure(.configuration) }
  }
  private func showStartupFailure(_ failure: PanelFailure) {
    // Fixed errors only: never print credentials, URLs or peer response bodies.
    FileHandle.standardError.write(Data(((failure.errorDescription ?? "Panel unavailable.") + "\n").utf8))
    if case .alreadyOpen = failure { exitStatus = 0 } else { exitStatus = 2 }
    NSApp.terminate(nil)
  }

  private func wire() {
    pet.onToggleBoard = { [weak self] in self?.toggleBoard(nil) }
    pet.onOpenSession = { [weak self] id in self?.openAgent(id) }
    pet.onDecide = { [weak self] id, decision in self?.decide(id, decision, nil, false) }
    pet.onStopSharing = { [weak self] in self?.perform(.stopSharing) }
    pet.onStopCall = { [weak self] in self?.perform(.stopCall) }
    pet.onHide = { [weak self] in self?.closeBoard(); self?.pet.hide() }
    pet.onMoved = { [weak self] in self?.followPet() }
    pet.menu = { [weak self] in self?.contextMenu() ?? NSMenu() }
    pet.afterFrame = { [weak self] step in
      guard let self else { return }
      self.boardPanel.step(step)
      self.pet.wantsBoost = !self.boardPanel.settled
    }
    boardPanel.onClosed = { [weak self] in self?.pet.boardOpen = false }
    let view = boardPanel.view
    view.onOpenSession = { [weak self] id in self?.openAgent(id) }
    view.onDecide = { [weak self] id, decision, text, remember in self?.decide(id, decision, text, remember) }
    view.onSubmit = { [weak self] text in self?.perform(.submit, text: text) }
    view.onAnswer = { [weak self] text in self?.perform(.decide, text: text) }
    view.onAccept = { [weak self] in self?.perform(.accept) }
    view.onCancelTask = { [weak self] in self?.cancelTask() }
    view.onRevise = { [weak self] in self?.showRevision = true; self?.render() }
    view.onStopSharing = { [weak self] in self?.perform(.stopSharing) }
    view.onStopCall = { [weak self] in self?.perform(.stopCall) }
    view.onDock = { [weak self] in self?.tuck(nil) }
    view.onClose = { [weak self] in self?.closeBoard() }
  }

  // MARK: mascot and board

  private var petScreen: CGRect { (pet.window.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero }
  private func followPet() { if boardPanel.isOpen { boardPanel.follow(pet: pet.frame, screen: petScreen) } }
  private func openBoard() {
    if pet.isDocked { pet.undock() }
    pet.boardOpen = true
    boardPanel.open(pet: pet.frame, screen: petScreen)
  }
  private func closeBoard() { boardPanel.close() }
  @objc private func toggleBoard(_ sender: Any?) {
    if !pet.visible { pet.show() }
    if boardPanel.isOpen { closeBoard() } else { openBoard() }
  }
  @objc private func tuck(_ sender: Any?) {
    if !pet.visible { pet.show() }
    closeBoard(); pet.dock()
  }
  @objc func showPanel(_ sender: Any?) {
    pet.show()
    if !boardPanel.isOpen { openBoard() }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(nil); return true }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationWillTerminate(_ notification: Notification) {
    DistributedNotificationCenter.default().removeObserver(self)
    pet.mascot.stop()
    pollTask?.cancel(); client?.close()
  }

  // MARK: data

  private func beginPolling() {
    pollTask = Task { [weak self] in
      var delay: Double = 1
      while !Task.isCancelled {
        guard let self, let client = self.client else { return }
        do {
          let readGeneration = self.state.mutationGeneration
          let snapshot = try await client.state()
          self.state.receive(snapshot, readGeneration: readGeneration)
          for operation in snapshot.operations { try self.receipts?.observe(operation) }
          self.state.pending = self.receipts?.entries ?? []
          // The board is optional. A service without one never affects the task state.
          self.board = try? await client.agents()
          // Reading this also tells the agents' hooks that someone is here to answer.
          self.decisions = try? await client.decisions()
          self.render()
          let waiting = self.state.pending.filter(\.unresolved).map(\.eventId)
          let found = await withTaskGroup(of: PanelOperation?.self) { group in
            for id in waiting { group.addTask { try? await client.operation(id) } }
            var results: [PanelOperation] = []
            for await value in group { if let value { results.append(value) } }
            return results
          }
          for result in found {
            if result.resolved, let action = result.action,
              self.receipts?.entries.contains(where: { $0.eventId == result.eventId && $0.unresolved }) == true {
              self.state.taskMutationBoundary(action)
            }
            try self.receipts?.observe(result)
          }
          self.state.pending = self.receipts?.entries ?? []; delay = 1
        } catch {
          self.state.connected = false; self.board = nil; self.decisions = nil; delay = min(5, delay * 2)
        }
        self.render()
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      }
    }
  }

  private func render() {
    let snapshot = state.snapshot, task = snapshot?.task
    let now = Date().timeIntervalSince1970 * 1000
    let liveBoard = board.flatMap { $0.isFresh(now: now) ? $0 : nil }
    if task?.id != lastTaskId { showRevision = false; lastTaskId = task?.id; localNotice = "" }
    let taskNeedsPerson = task?.decision != nil || task?.canAccept == true
    let sharing = snapshot?.controls.sharingActive == true || snapshot?.controls.callActive == true
    let asked = (decisions?.pending ?? []).filter { $0.holdUntil > now }
    let status = PetStatus.make(board: liveBoard, connected: state.connected, taskNeedsPerson: taskNeedsPerson, sharing: sharing,
                                quietSeconds: pet.mascot.quietSeconds, now: now, decisions: asked)
    pet.status = status
    // Stop is always one click away: on the mascot, in the board and in every menu.
    pet.setStop(sharing: state.allows(.stopSharing), call: state.allows(.stopCall))
    refreshMenus()

    var model = BoardModel()
    model.status = status; model.board = liveBoard; model.now = now; model.decisions = asked
    model.projectPath = configuration?.projectRoot ?? ""
    model.modeText = snapshot?.worker == "simulation" ? "Simulation · tasks stay queued" : state.connected ? "Codex · independently checked" : "Connecting"
    model.stage = state.stage; model.task = task
    model.canSubmit = snapshot?.canSubmit != false && state.connected
    model.showRevision = showRevision
    model.allowSubmit = state.allows(.submit); model.allowDecide = state.allows(.decide)
    model.allowAccept = state.allows(.accept); model.allowCancel = state.allows(.cancel)
    model.allowStopSharing = state.allows(.stopSharing); model.allowStopCall = state.allows(.stopCall)
    model.sharingActive = sharing; model.callStatus = state.callStatus
    if !state.connected {
      model.notice = "Connection unavailable. Existing work continues; no requests are repeated."
    } else if state.pending.contains(where: \.unresolved) {
      model.notice = "A request is unconfirmed. Checking its receipt; it will not be sent again."
    } else if state.waitingForSnapshot {
      model.notice = "Request recorded. Refreshing task progress."
    } else if !localNotice.isEmpty {
      model.notice = localNotice
    } else if let message = snapshot?.notice, !message.isEmpty {
      model.notice = message
    } else if let last = snapshot?.operations.last, last.state == "refused" {
      model.notice = "Request not applied. " + last.message
    }
    boardPanel.view.render(model)
  }

  // MARK: actions

  @objc private func stopSharing(_ sender: Any?) { perform(.stopSharing) }
  @objc private func stopCall(_ sender: Any?) { perform(.stopCall) }

  /// The person's answer to an agent. The agent's hook hands it over; the trove keeps it.
  private func decide(_ id: String, _ decision: String, _ text: String?, _ remember: Bool) {
    guard let client else { return }
    Task {
      let ok = (try? await client.answerDecision(id, decision: decision, text: text, remember: remember)) == true
      pet.react(success: ok)
      boardPanel.view.showToast(!ok ? "That request no longer waits here. Answer it in its terminal."
        : decision == "allow" ? (remember ? "Allowed, and remembered for this project." : "Allowed. It continues.")
        : decision == "deny" ? "Denied. It is told." : "Answered. It continues.")
      decisions = try? await client.decisions()
      render()
    }
  }
  @objc private func toggleAway(_ sender: Any?) {
    guard let client else { return }
    let next = !(decisions?.away ?? false)
    Task {
      try? await client.setAway(next)
      decisions = try? await client.decisions()
      refreshMenus()
      boardPanel.view.showToast(next ? "Away. Requests wait for an answer by phone." : "Here. Requests are answered on this Mac.")
    }
  }
  /// Brings one session's terminal forward. This is not a task operation: it has no
  /// receipt and it is safe to repeat.
  private func openAgent(_ id: String) {
    guard let client else { return }
    Task {
      let result = try? await client.focusAgent(id)
      let opened = result?.ok == true
      pet.react(success: opened)
      boardPanel.view.showToast(result?.message ?? "The task service did not answer. Nothing was opened.")
      if opened {
        // The terminal is what the person asked for: the board gets out of its way.
        try? await Task.sleep(nanoseconds: 420_000_000)
        closeBoard()
      }
    }
  }
  private func cancelTask() {
    guard state.allows(.cancel), let task = state.snapshot?.task else { return }
    let alert = NSAlert(); alert.messageText = "Cancel this task?"
    alert.informativeText = "This requests cancellation of the coding work. It is separate from stopping a call or sharing."
    alert.alertStyle = .warning; alert.addButton(withTitle: "Keep working"); alert.addButton(withTitle: "Cancel task")
    alert.beginSheetModal(for: boardPanel.window) { [weak self] response in
      guard response == .alertSecondButtonReturn, let self else { return }
      guard self.state.snapshot?.task?.id == task.id, self.state.snapshot?.task?.runId == task.runId,
        self.state.snapshot?.task?.revision == task.revision else {
        self.localNotice = "The task changed. Review its current state before canceling."; self.render(); return
      }
      self.perform(.cancel)
    }
  }
  private func perform(_ action: PanelAction, text: String = "") {
    guard let client, let receipts else { return }
    let id = "panel_" + UUID().uuidString.lowercased()
    do {
      let payload = try JSONSerialization.data(withJSONObject: state.payload(action, text: text, eventId: id), options: [.sortedKeys])
      try receipts.reserve(action: action, eventId: id, payload: payload)
      state.taskMutationBoundary(action)
      state.pending = receipts.entries; render()
      Task {
        do {
          let operation = try await client.submit(payload, eventId: id, action: action)
          if operation.resolved { state.taskMutationBoundary(action) }
          try receipts.observe(operation)
          if operation.state == "done" {
            let view = boardPanel.view
            if action == .submit && view.taskInput.string == text { view.clearTaskInput() }
            if action == .decide && view.answerInput.string == text { view.clearAnswerInput(); showRevision = false }
            pet.react(success: true)
          } else if operation.state == "refused" { pet.react(success: false) }
        } catch { try? receipts.markUnknown(id) }
        state.pending = receipts.entries; render()
      }
    } catch {
      localNotice = (error as? PanelFailure)?.errorDescription ?? "Request unavailable. No action was sent."
      state.pending = receipts.entries; render()
    }
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = TaskPanelApp()
  app.delegate = delegate
  app.run()
  Darwin.exit(delegate.exitStatus)
}
