import AppKit
import Darwin
import Foundation
import TaskPanelCore

/// The app: one mascot on the desktop and one board that opens out of it. The task
/// service owns every fact. This process shows them, sends the person's actions once,
/// and keeps a receipt for each.
@MainActor final class TaskPanelApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
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
  /// What the watcher found: a long wait, a stall, a bad end, finished work.
  private var incidents: Incidents?
  /// Finished work that the mascot has already jumped for.
  private var celebrated: Set<String> = []
  private var awayItems: [NSMenuItem] = []
  private var memoryItems: [NSMenuItem] = []
  private var showRevision = false
  private var lastTaskId: String?
  private var startTucked = false
  private var localNotice = ""
  private let pet = PetController()
  private let boardPanel = SheetController(BoardView(frame: NSRect(x: 0, y: 0, width: BoardView.width, height: 400)))
  private let chatPanel = SheetController(ChatView(frame: NSRect(x: 0, y: 0, width: ChatView.width, height: 400)))
  private let voice = VoiceController()
  private var transcript: ChatTranscript?
  private var executionControl = ChatExecutionControl()
  private let nativeExecutionPanel = NativeExecutionPanel()
  private var nativeSubmissionPending = false
  private var chatPending: String?
  private var chatNotice = ""
  /// The last spoken turn, shown on the mascot while the chat is closed.
  private var said: (bubble: PetStatus.Bubble, until: Date)?
  private var statusItem: NSStatusItem?
  private var stopSharingItems: [NSMenuItem] = []
  private var stopCallItems: [NSMenuItem] = []
  private var styleItems: [NSMenuItem] = []
  private var eyeItems: [NSMenuItem] = []
  private var sizeSliders: [NSSlider] = []

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
    menu.addItem(withTitle: "Chat with ClawdTime", action: #selector(toggleChat), keyEquivalent: "k").target = self
    menu.addItem(withTitle: "Talk to ClawdTime", action: #selector(toggleTalk), keyEquivalent: "t").target = self
    menu.addItem(withTitle: "Tuck against the edge", action: #selector(tuck), keyEquivalent: "").target = self
    let styles = NSMenuItem(title: "Mascot", action: nil, keyEquivalent: "")
    let styleMenu = NSMenu(title: "Mascot")
    // Each style shows its picture. The pictures are drawn when the menu first opens.
    styleMenu.delegate = self
    // The menu does not enable or disable its rows by itself, so the size row, which has no action, stays enabled.
    styleMenu.autoenablesItems = false
    // The size: a slider from half of the full size to one and a half.
    styleMenu.addItem(sizeItem())
    styleMenu.addItem(.separator())
    for style in MascotStyle.allCases {
      let item = styleMenu.addItem(withTitle: style.title, action: #selector(chooseStyle(_:)), keyEquivalent: "")
      if #available(macOS 14.4, *) { item.subtitle = style.summary } else { item.title = style.title + ": " + style.summary }
      item.target = self; item.representedObject = style.rawValue
      styleItems.append(item)
    }
    styleMenu.addItem(.separator())
    // Flint is the plain Chert mark. This gives it an eye in its window.
    let eye = styleMenu.addItem(withTitle: "Eye on Flint", action: #selector(toggleFlintEye(_:)), keyEquivalent: "")
    eye.target = self; eyeItems.append(eye)
    styles.submenu = styleMenu; menu.addItem(styles)
    let away = menu.addItem(withTitle: "Away: answer by phone", action: #selector(toggleAway(_:)), keyEquivalent: "")
    away.target = self; awayItems.append(away)
    // Off by default. On, ClawdTime keeps what the person tells it, on this Mac.
    let memory = menu.addItem(withTitle: "Memory: keep what I tell ClawdTime", action: #selector(toggleMemory(_:)), keyEquivalent: "")
    memory.target = self; memoryItems.append(memory)
    menu.addItem(.separator())
    let sharing = menu.addItem(withTitle: "Stop sharing", action: #selector(stopSharing), keyEquivalent: "")
    sharing.target = self; stopSharingItems.append(sharing)
    let call = menu.addItem(withTitle: "Stop call", action: #selector(stopCall), keyEquivalent: "")
    call.target = self; stopCallItems.append(call)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit ClawdTime. Work keeps running.", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.autoenablesItems = false
  }
  /// A menu row with the size slider. The mascot changes size while the person drags.
  private func sizeItem() -> NSMenuItem {
    let item = NSMenuItem()
    let row = NSView(frame: NSRect(x: 0, y: 0, width: 250, height: 30))
    let label = NSTextField(labelWithString: "Size")
    label.font = .menuFont(ofSize: 0); label.textColor = .labelColor
    label.frame = NSRect(x: 22, y: 6, width: 40, height: 18)
    let slider = NSSlider(value: pet.scale, minValue: PetLayout.scaleRange.lowerBound, maxValue: PetLayout.scaleRange.upperBound,
      target: self, action: #selector(sizeChanged(_:)))
    slider.isContinuous = true; slider.controlSize = .small
    slider.frame = NSRect(x: 64, y: 5, width: 170, height: 20)
    slider.toolTip = "The size of the mascot"; slider.setAccessibilityLabel("Mascot size")
    row.addSubview(label); row.addSubview(slider)
    item.view = row
    sizeSliders.append(slider)
    return item
  }
  @objc private func sizeChanged(_ sender: NSSlider) {
    pet.scale = sender.doubleValue
    for slider in sizeSliders where slider !== sender { slider.doubleValue = pet.scale }
  }
  @objc private func toggleFlintEye(_ sender: NSMenuItem) {
    pet.flintEye.toggle(); refreshMenus()
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
  /// The Chert mark, as a template image for the menu bar: the core with its window, and the flake.
  private static func markImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      // The points of the mark on its own 900 point frame, y down.
      func outline(_ points: [(CGFloat, CGFloat)]) -> NSBezierPath {
        let shape = NSBezierPath()
        for (index, point) in points.enumerated() {
          let place = NSPoint(x: 1.3 + (point.0 - 250) * 0.0385, y: 16.4 - (point.1 - 262) * 0.0385)
          if index == 0 { shape.move(to: place) } else { shape.line(to: place) }
        }
        shape.close(); shape.lineJoinStyle = .round; shape.lineWidth = 1.0
        return shape
      }
      NSColor.black.setFill(); NSColor.black.setStroke()
      for piece in [[(455, 262), (527, 318), (467, 385), (535, 632), (328, 640), (250, 402)], [(590, 362), (650, 407), (588, 558), (527, 404)]] as [[(CGFloat, CGFloat)]] {
        let shape = outline(piece); shape.fill(); shape.stroke()
      }
      // The window is cut out of the core.
      NSGraphicsContext.current?.compositingOperation = .destinationOut
      outline([(322, 436), (456, 521), (439, 596), (360, 600), (316, 454)]).fill()
      return true
    }
    image.isTemplate = true
    return image
  }
  func menuWillOpen(_ menu: NSMenu) {
    for item in menu.items {
      guard let raw = item.representedObject as? String, let style = MascotStyle(rawValue: raw) else { continue }
      item.image = MascotCatalog.flatImage(style, flintEye: pet.flintEye)
    }
  }
  @objc private func chooseStyle(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let style = MascotStyle(rawValue: raw) else { return }
    pet.style = style; refreshMenus()
  }
  private func refreshMenus() {
    for item in styleItems { item.state = (item.representedObject as? String) == pet.style.rawValue ? .on : .off }
    for item in eyeItems { item.state = pet.flintEye ? .on : .off }
    for slider in sizeSliders { slider.doubleValue = pet.scale }
    for item in awayItems {
      item.state = decisions?.away == true ? .on : .off
      item.title = decisions?.callReady == false ? "Away: answer by phone (no phone link yet)" : "Away: answer by phone"
    }
    for item in memoryItems { item.state = transcript?.memory == true ? .on : .off }
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
    pet.onDismissIncident = { [weak self] id in self?.dismissIncident(id) }
    pet.onStopSharing = { [weak self] in self?.perform(.stopSharing) }
    pet.onStopCall = { [weak self] in self?.perform(.stopCall) }
    pet.onHide = { [weak self] in self?.closeBoard(); self?.chatPanel.close(); self?.voice.stop(); self?.pet.hide() }
    pet.onMoved = { [weak self] in self?.followPet() }
    pet.menu = { [weak self] in self?.contextMenu() ?? NSMenu() }
    pet.afterFrame = { [weak self] step in
      guard let self else { return }
      self.boardPanel.step(step); self.chatPanel.step(step)
      self.pet.wantsBoost = !self.boardPanel.settled || !self.chatPanel.settled
    }
    boardPanel.onClosed = { [weak self] in self?.pet.boardOpen = self?.chatPanel.isOpen ?? false }
    chatPanel.onClosed = { [weak self] in self?.pet.boardOpen = self?.boardPanel.isOpen ?? false }
    // The bar under the mascot, and the conversation it starts.
    pet.onChat = { [weak self] in self?.toggleChat(nil) }
    pet.onTalk = { [weak self] in self?.startTalk() }
    pet.onMic = { [weak self] in self?.voice.micOn.toggle() }
    pet.onSpeaker = { [weak self] in self?.voice.speakerOn.toggle() }
    pet.onEndTalk = { [weak self] in self?.voice.stop() }
    pet.voiceLevel = { [weak self] in self?.voice.level ?? 0 }
    voice.onChange = { [weak self] in self?.renderTalk() }
    voice.onError = { [weak self] message in self?.chatNotice = message; self?.openChat(); self?.renderChat() }
    voice.answer = { [weak self] recording in await self?.heard(recording) }
    let chat = chatPanel.view
    chat.onSend = { [weak self] text in self?.sendChat(text) }
    chat.onTalk = { [weak self] in self?.toggleTalk(nil) }
    chat.onStopWork = { [weak self] in self?.stopExecution() }
    nativeExecutionPanel.onDecision = { [weak self] id, approve in self?.decideExecution(id, approve: approve) }
    nativeExecutionPanel.onStop = { [weak self] in self?.stopExecution() }
    chat.onExecutionDecision = { [weak self] id, approve in self?.decideExecution(id, approve: approve) }
    chat.onClose = { [weak self] in self?.chatPanel.close() }
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
  private func followPet() {
    if boardPanel.isOpen { boardPanel.follow(pet: pet.frame, screen: petScreen) }
    if chatPanel.isOpen { chatPanel.follow(pet: pet.frame, screen: petScreen) }
  }
  private func openBoard() {
    if pet.isDocked { pet.undock() }
    // One sheet at a time: the board and the chat share the place beside the mascot.
    chatPanel.close()
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
    closeBoard(); chatPanel.close(); voice.stop(); pet.dock()
  }

  // MARK: talking to ClawdTime

  private func openChat() {
    if !pet.visible { pet.show() }
    if pet.isDocked { pet.undock() }
    boardPanel.close()
    pet.boardOpen = true
    renderChat()
    chatPanel.open(pet: pet.frame, screen: petScreen)
    // The person opened it to write: the field takes the keys.
    chatPanel.window.makeKey(); chatPanel.view.focus()
    refreshChat()
  }
  @objc private func toggleChat(_ sender: Any?) {
    if chatPanel.isOpen { chatPanel.close() } else { openChat() }
  }
  @objc private func toggleTalk(_ sender: Any?) {
    if voice.phase == .off { startTalk() } else { voice.stop() }
  }
  private func readChat(_ client: PanelClient) async {
    let generation = executionControl.generation
    if let fresh = try? await client.chat() {
      transcript = fresh
      executionControl.receive(fresh.execution, readGeneration: generation)
    }
  }
  private func releaseNativeEditor() {
    guard NativeExecutionPresentation.releasesEditor(executionControl.execution) else { return }
    // Release only our UI. AppKit returns focus; no AX activation or target
    // restoration is attempted. Native capture still verifies the real focus.
    chatPanel.close(immediately: true)
    boardPanel.close(immediately: true)
  }
  private func decideExecution(_ id: String, approve: Bool) {
    guard let client, state.connected, executionControl.beginDecision(id) else { return }
    releaseNativeEditor()
    renderChat()
    Task {
      let result = try? await client.decideExecution(actionId: id, approve: approve)
      executionControl.finishDecision(id, value: result)
      renderChat()
      await readChat(client); renderChat()
    }
  }
  private func stopExecution() {
    guard let client, state.connected, executionControl.beginStop() else { return }
    renderChat()
    Task {
      let result = try? await client.stopExecution()
      executionControl.finishStop(result)
      renderChat()
      // Only a new read may reconcile a missing or unconfirmed response.
      await readChat(client)
      renderChat()
    }
  }
  private func refreshChat() {
    guard let client else { return }
    Task {
      await readChat(client)
      renderChat()
    }
  }
  private func renderChat() {
    var model = ChatModel()
    model.messages = transcript?.messages ?? []
    model.pending = chatPending
    model.modelReady = transcript?.model ?? true
    model.connected = state.connected
    model.voice = voice.phase
    model.notice = chatNotice
    model.memory = transcript?.memory == true
    model.execution = executionControl.execution
    model.executionStopping = executionControl.stopping
    model.executionCanStop = executionControl.canStop
    model.executionCanDecide = executionControl.canDecide
    model.executionNotice = executionControl.notice
    chatPanel.view.render(model)
    nativeExecutionPanel.render(model, submissionPending: nativeSubmissionPending, pet: pet.frame, screen: petScreen)
  }
  private func renderTalk() {
    pet.setTalk(on: voice.phase != .off, micOn: voice.micOn, speakerOn: voice.speakerOn, speaking: voice.phase == .speaking, thinking: voice.phase == .thinking)
    renderChat()
  }
  /// One typed message. The words show at once; the answer follows.
  private func sendChat(_ text: String) {
    guard let client, chatPending == nil else { return }
    nativeSubmissionPending = NativeExecutionPresentation.releasesEditor(executionControl.execution)
    releaseNativeEditor()
    chatPending = text; chatNotice = ""; renderChat()
    Task {
      let reply = try? await client.say(text)
      await readChat(client)
      chatPending = nil; nativeSubmissionPending = false
      if reply == nil { chatNotice = "ClawdTime did not answer. Check the current work status before trying again." }
      pet.react(success: reply != nil)
      renderChat()
      // It may have answered a request or changed away mode.
      decisions = try? await client.decisions()
      render()
    }
  }
  /// One spoken sentence: its words and the answer join the chat. Returns the answer as sound.
  private func heard(_ recording: String) async -> URL? {
    guard let client else { return nil }
    nativeSubmissionPending = NativeExecutionPresentation.releasesEditor(executionControl.execution)
    releaseNativeEditor(); renderChat()
    let result = try? await client.hear(recording)
    nativeSubmissionPending = false
    await readChat(client)
    if result == nil { chatNotice = "ClawdTime did not answer. Check the current work status before trying again." } else if result?.reply != nil { chatNotice = "" }
    if let result, let reply = result.reply {
      let caption = PetStatus.Bubble.said(heard: result.heard, reply: reply.text, at: reply.at)
      said = (caption.bubble, Date().addingTimeInterval(caption.seconds))
    }
    renderChat()
    decisions = try? await client.decisions()
    render()
    guard let name = result?.audioName, let directory = transcript?.voiceDirectory else { return nil }
    return URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(name)
  }
  private func startTalk() {
    guard let client else { return }
    Task {
      await readChat(client)
      guard let transcript else { chatNotice = "The task service did not answer. ClawdTime cannot listen now."; openChat(); return }
      guard transcript.speech else {
        chatNotice = "Speech needs an OpenAI key. Set CLAWDTIME_OPENAI_API_KEY and start ClawdTime again. Typing works now."
        openChat(); return
      }
      chatNotice = ""
      voice.directory = URL(fileURLWithPath: transcript.voiceDirectory, isDirectory: true)
      voice.start()
    }
  }
  @objc func showPanel(_ sender: Any?) {
    pet.show()
    if !boardPanel.isOpen && !chatPanel.isOpen { openBoard() }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(nil); return true }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationWillTerminate(_ notification: Notification) {
    DistributedNotificationCenter.default().removeObserver(self)
    pet.mascot.stop(); voice.stop()
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
          // The watcher is optional, as the board is: a service without one changes nothing.
          self.incidents = try? await client.incidents()
          // The chat is read while it is in view, and once at the start.
          if self.chatPanel.isOpen || self.voice.phase != .off || self.transcript == nil || self.executionControl.execution?.mode == "native" {
            await self.readChat(client)
          }
          self.render(); self.renderChat()
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
          self.state.connected = false; self.board = nil; self.decisions = nil; self.incidents = nil; delay = min(5, delay * 2)
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
    let found = liveBoard == nil ? [] : (incidents?.incidents ?? [])
    let status = PetStatus.make(board: liveBoard, connected: state.connected, taskNeedsPerson: taskNeedsPerson, sharing: sharing,
                                quietSeconds: pet.mascot.quietSeconds, now: now, decisions: asked, incidents: found)
    // Work that is done: the mascot jumps once, when the news first shows.
    if let id = status.bubble?.incidentId, found.first(where: { $0.id == id })?.kind == "finished", celebrated.insert(id).inserted {
      pet.mascot.jump()
    }
    // In a spoken conversation the bubble is the caption: what it heard, what it answered.
    if let said, said.until > Date(), !chatPanel.isOpen {
      pet.status = PetStatus(mood: status.mood, headline: status.headline, detail: status.detail, bubble: said.bubble)
    } else { pet.status = status }
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
  @objc private func toggleMemory(_ sender: Any?) {
    guard let client else { return }
    let next = transcript?.memory != true
    Task {
      try? await client.setMemory(next)
      await readChat(client)
      refreshMenus(); renderChat()
      boardPanel.view.showToast(transcript?.memory == true ? "Memory is on. ClawdTime keeps what you tell it." : "Memory is off. Nothing is kept.")
    }
  }
  /// The person has seen what the watcher found. It leaves every view.
  private func dismissIncident(_ id: String) {
    guard let client else { return }
    Task {
      _ = try? await client.dismissIncident(id)
      incidents = try? await client.incidents()
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
