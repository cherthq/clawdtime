import AppKit
import Darwin
import Foundation
import TaskPanelCore

private let accent = NSColor.systemTeal

final class TaskWindow: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}
final class Card: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame); wantsLayer = true; layer?.cornerRadius = 14; layer?.borderWidth = 1
    refreshColors()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); refreshColors() }
  private func refreshColors() {
    layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
  }
}
final class ChoiceButton: NSButton {
  private var measuredWidth: CGFloat = 0
  override var intrinsicContentSize: NSSize {
    let available = max(180, bounds.width > 0 ? bounds.width - 28 : 300)
    let rect = (title as NSString).boundingRect(with: NSSize(width: available, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font ?? NSFont.systemFont(ofSize: 13)])
    return NSSize(width: NSView.noIntrinsicMetric, height: max(36, ceil(rect.height) + 18))
  }
  override func layout() {
    super.layout()
    if measuredWidth != bounds.width { measuredWidth = bounds.width; invalidateIntrinsicContentSize() }
  }
}
final class Composer: NSTextView {
  var placeholder = "What would you like to work on?"
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    if string.isEmpty {
      (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height),
        withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.placeholderTextColor])
    }
  }
  override var string: String { didSet { needsDisplay = true } }
}

@MainActor final class TaskPanelApp: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
  var exitStatus: Int32 = 0
  private var reopenName: Notification.Name?
  private var configuration: PanelConfiguration?
  private var configPath: URL?
  private var receipts: PanelReceiptStore?
  private var client: PanelClient?
  private var state = PanelState()
  private var pollTask: Task<Void, Never>?
  private var panel: TaskWindow?
  private var statusItem: NSStatusItem?
  private let projectLabel = label("Selected project", size: 14, weight: .semibold)
  private let projectPath = label("", size: 11, color: .secondaryLabelColor)
  private let modeLabel = label("Connecting…", size: 11, weight: .medium, color: .secondaryLabelColor)
  private let stage = label("Ready when you are", size: 19, weight: .semibold)
  private let goal = label("Describe the work. ClawdTime will keep its progress here.", size: 13, color: .secondaryLabelColor)
  private let summary = label("", size: 13)
  private let notice = label("", size: 12, color: .systemOrange)
  private let checks = NSStackView()
  private let choices = NSStackView()
  private let question = label("", size: 14, weight: .medium)
  private let callLabel = label("No active call", size: 11, color: .secondaryLabelColor)
  private let taskInput = Composer()
  private let answerInput = Composer()
  private var taskCard: NSView!
  private var decisionCard: NSView!
  private var reviewCard: NSView!
  private var startButton: NSButton!
  private var answerButton: NSButton!
  private var acceptButton: NSButton!
  private var reviseButton: NSButton!
  private var cancelButton: NSButton!
  private var stopSharingButton: NSButton!
  private var stopCallButton: NSButton!
  private var showRevision = false
  private var lastTaskId: String?

  static func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                    color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color
    field.isSelectable = true; field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
  }
  private func button(_ title: String, _ action: Selector, primary: Bool = false) -> NSButton {
    let result = NSButton(title: title, target: self, action: action)
    result.bezelStyle = .rounded; result.font = .systemFont(ofSize: 13, weight: .medium)
    if primary { result.bezelColor = accent; result.contentTintColor = .white }
    result.controlSize = .large
    return result
  }
  private func stack(_ views: [NSView], vertical: Bool = true, spacing: CGFloat = 10) -> NSStackView {
    let result = NSStackView(views: views); result.orientation = vertical ? .vertical : .horizontal
    result.alignment = vertical ? .leading : .centerY; result.spacing = spacing
    result.detachesHiddenViews = true
    return result
  }
  private func fullWidth(_ child: NSView, in parent: NSView) {
    child.translatesAutoresizingMaskIntoConstraints = false
    child.widthAnchor.constraint(equalTo: parent.widthAnchor).isActive = true
  }
  private func card(_ views: [NSView]) -> NSView {
    let card = Card(frame: .zero)
    let contents = stack(views, spacing: 12)
    card.addSubview(contents); contents.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([contents.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
      contents.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
      contents.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
      contents.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)])
    for view in views { fullWidth(view, in: contents) }
    return card
  }
  private func composer(_ text: Composer, placeholder: String) -> NSView {
    text.placeholder = placeholder; text.delegate = self; text.font = .systemFont(ofSize: 14)
    text.isRichText = false; text.importsGraphics = false; text.isAutomaticQuoteSubstitutionEnabled = false
    text.isAutomaticDashSubstitutionEnabled = false; text.isAutomaticTextReplacementEnabled = false
    text.textContainerInset = NSSize(width: 8, height: 10)
    text.backgroundColor = .textBackgroundColor
    text.isVerticallyResizable = true; text.isHorizontallyResizable = false
    text.textContainer?.widthTracksTextView = true; text.autoresizingMask = [.width]
    text.minSize = NSSize(width: 0, height: 90); text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    let scroll = NSScrollView(); scroll.documentView = text; scroll.hasVerticalScroller = true
    scroll.borderType = .noBorder; scroll.wantsLayer = true; scroll.layer?.cornerRadius = 9
    scroll.heightAnchor.constraint(equalToConstant: 96).isActive = true
    text.setAccessibilityLabel(placeholder)
    return scroll
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    configureMenus()
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: "--config"), args.count == index + 2, args[index + 1].hasPrefix("/") {
      load(URL(fileURLWithPath: args[index + 1]))
    } else {
      showStartupFailure(.configuration)
    }
  }
  private func configureMenus() {
    let menu = NSMenu()
    let appItem = NSMenuItem(); menu.addItem(appItem)
    let submenu = NSMenu(title: "ClawdTime")
    submenu.addItem(withTitle: "Show ClawdTime", action: #selector(showPanel), keyEquivalent: "0").target = self
    submenu.addItem(.separator())
    submenu.addItem(withTitle: "Quit panel", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = submenu
    let editItem = NSMenuItem(); let edit = NSMenu(title: "Edit")
    for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
      edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
    }
    editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem?.button?.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "ClawdTime task panel")
    statusItem?.button?.toolTip = "ClawdTime — task panel"
    let statusMenu = NSMenu()
    statusMenu.addItem(withTitle: "Show ClawdTime", action: #selector(showPanel), keyEquivalent: "").target = self
    statusMenu.addItem(.separator())
    statusMenu.addItem(withTitle: "Quit panel — keep work running", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    statusItem?.menu = statusMenu
  }
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
        DistributedNotificationCenter.default().postNotificationName(name, object: nil, userInfo: nil, deliverImmediately: true)
        showStartupFailure(.alreadyOpen); return
      }
      reopenName = name
      DistributedNotificationCenter.default().addObserver(self, selector: #selector(showPanel), name: name, object: nil, suspensionBehavior: .deliverImmediately)
      self.configuration = config; self.configPath = path.standardizedFileURL
      receipts = store; client = PanelClient(configuration: config); state.pending = store.entries
      buildWindow(); render(); showPanel(nil); beginPolling()
    } catch let failure as PanelFailure { showStartupFailure(failure) }
      catch { showStartupFailure(.configuration) }
  }
  private func showStartupFailure(_ failure: PanelFailure) {
    // Fixed errors only: never print credentials, URLs or peer response bodies.
    FileHandle.standardError.write(Data(((failure.errorDescription ?? "Panel unavailable.") + "\n").utf8))
    if case .alreadyOpen = failure { exitStatus = 0 } else { exitStatus = 2 }
    NSApp.terminate(nil)
  }
  private func buildWindow() {
    let window = TaskWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 690),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "ClawdTime"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
    window.level = .floating; window.isFloatingPanel = true; window.hidesOnDeactivate = false
    window.isReleasedWhenClosed = false; window.delegate = self
    window.contentMinSize = NSSize(width: 380, height: 430); window.contentMaxSize = NSSize(width: 560, height: 1100)
    window.backgroundColor = NSColor.windowBackgroundColor
    let content = NSView(); window.contentView = content
    stopSharingButton = button("Stop sharing", #selector(stopSharing))
    stopCallButton = button("Stop call", #selector(stopCall))
    let stops = stack([stopSharingButton, stopCallButton], vertical: false); stops.distribution = .fillEqually
    cancelButton = button("Cancel task…", #selector(cancelTask)); cancelButton.contentTintColor = .systemRed
    let divider = NSBox(); divider.boxType = .separator
    let controls = card([callLabel, stops, divider, cancelButton])
    let footer = Self.label("Work continues when you close this panel.", size: 11, color: .secondaryLabelColor)
    footer.alignment = .center
    let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
    scroll.autohidesScrollers = true
    let document = NSView(); scroll.documentView = document
    content.addSubview(scroll); content.addSubview(footer); content.addSubview(controls)
    controls.translatesAutoresizingMaskIntoConstraints = false
    scroll.translatesAutoresizingMaskIntoConstraints = false; footer.translatesAutoresizingMaskIntoConstraints = false
    document.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor), scroll.topAnchor.constraint(equalTo: content.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: controls.topAnchor, constant: -12),
      controls.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      controls.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      controls.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10),
      footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
      footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
      footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)])
    let symbol = NSImageView(image: NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: nil)!)
    symbol.contentTintColor = accent; symbol.widthAnchor.constraint(equalToConstant: 34).isActive = true
    symbol.heightAnchor.constraint(equalToConstant: 34).isActive = true
    let header = stack([symbol, stack([Self.label("ClawdTime", size: 21, weight: .semibold), modeLabel], spacing: 3)], vertical: false, spacing: 11)
    projectPath.lineBreakMode = .byTruncatingMiddle; projectPath.maximumNumberOfLines = 1
    let project = stack([projectLabel, projectPath], spacing: 3)
    startButton = button("Start task", #selector(submitTask), primary: true)
    taskCard = card([Self.label("A task to move forward", size: 13, weight: .semibold),
      composer(taskInput, placeholder: "Describe the work you want done…"), startButton])
    goal.maximumNumberOfLines = 5; summary.maximumNumberOfLines = 8
    checks.orientation = .vertical; checks.alignment = .leading; checks.spacing = 7
    let progress = card([stage, goal, summary, checks])
    answerInput.placeholder = "Your answer or requested revision…"
    answerButton = button("Send answer", #selector(sendAnswer), primary: true)
    choices.orientation = .vertical; choices.alignment = .leading; choices.spacing = 6
    decisionCard = card([question, choices, composer(answerInput, placeholder: "Your answer or requested revision…"), answerButton])
    acceptButton = button("Accept result", #selector(acceptResult), primary: true)
    reviseButton = button("Revise", #selector(reviseResult))
    let reviewButtons = stack([acceptButton, reviseButton], vertical: false)
    reviewButtons.distribution = .fillEqually
    reviewCard = card([Self.label("Your review", size: 13, weight: .semibold),
      Self.label("Accept the verified result, or ask for a revision.", size: 12, color: .secondaryLabelColor), reviewButtons])
    let all = stack([header, project, notice, taskCard, progress, decisionCard, reviewCard], spacing: 16)
    document.addSubview(all); all.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([all.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 20),
      all.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -20),
      all.topAnchor.constraint(equalTo: document.topAnchor, constant: 16),
      all.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -16)])
    for child in all.arrangedSubviews { fullWidth(child, in: all) }
    window.center(); panel = window
  }
  @objc func showPanel(_ sender: Any?) {
    panel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(nil); return true }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
  func applicationWillTerminate(_ notification: Notification) {
    DistributedNotificationCenter.default().removeObserver(self)
    pollTask?.cancel(); client?.close()
  }

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
          self.state.connected = false; delay = min(5, delay * 2)
        }
        self.render()
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      }
    }
  }
  private func render() {
    guard panel != nil else { return }
    let snapshot = state.snapshot, task = snapshot?.task
    projectLabel.stringValue = snapshot?.projectLabel ?? URL(fileURLWithPath: configuration?.projectRoot ?? "/").lastPathComponent
    projectPath.stringValue = configuration?.projectRoot ?? ""; projectPath.toolTip = projectPath.stringValue
    modeLabel.stringValue = snapshot?.worker == "simulation" ? "Simulation · tasks stay queued" : (state.connected ? "Codex · independently checked" : "Connecting to your task service…")
    stage.stringValue = state.stage
    goal.stringValue = task?.goal ?? "Describe the work. Progress and decisions will appear here."
    goal.toolTip = task?.goal
    summary.stringValue = task?.summary ?? ""
    summary.isHidden = summary.stringValue.isEmpty
    if task?.id != lastTaskId { showRevision = false; lastTaskId = task?.id }
    taskCard.isHidden = snapshot?.canSubmit == false
    decisionCard.isHidden = !(task?.decision != nil || (showRevision && task?.canDecide == true))
    question.stringValue = task?.decision?.question ?? "What would you like to revise?"
    choices.arrangedSubviews.forEach { choices.removeArrangedSubview($0); $0.removeFromSuperview() }
    for (index, option) in (task?.decision?.options ?? []).enumerated() {
      let choice = ChoiceButton(title: option, target: self, action: #selector(chooseAnswer))
      choice.bezelStyle = .regularSquare; choice.font = .systemFont(ofSize: 13, weight: .medium)
      choice.alignment = .left; choice.setContentCompressionResistancePriority(.required, for: .vertical)
      choice.tag = index; choice.toolTip = option; choice.isEnabled = state.allows(.decide)
      choice.cell?.wraps = true; choice.cell?.lineBreakMode = .byWordWrapping
      choices.addArrangedSubview(choice)
      choice.widthAnchor.constraint(equalTo: choices.widthAnchor).isActive = true
    }
    choices.isHidden = choices.arrangedSubviews.isEmpty
    answerButton.title = task?.decision == nil ? "Send revision" : "Send answer"
    reviewCard.isHidden = task?.canAccept != true
    startButton.isEnabled = state.allows(.submit) && validText(taskInput.string)
    answerButton.isEnabled = state.allows(.decide) && validText(answerInput.string)
    acceptButton.isEnabled = state.allows(.accept); reviseButton.isEnabled = state.allows(.decide)
    cancelButton.isEnabled = state.allows(.cancel)
    stopSharingButton.isEnabled = state.allows(.stopSharing); stopCallButton.isEnabled = state.allows(.stopCall)
    callLabel.stringValue = snapshot?.controls.callActive == true ? (snapshot?.controls.sharingActive == true ? "Call active · sharing" : "Call active · sharing stopped") : "No active call"
    checks.arrangedSubviews.forEach { checks.removeArrangedSubview($0); $0.removeFromSuperview() }
    for check in task?.checks ?? [] {
      let passed = check.state == "passed", failed = check.state == "failed"
      let icon = NSImageView(image: NSImage(systemSymbolName: passed ? "checkmark.circle.fill" : failed ? "xmark.circle.fill" : "circle.dotted", accessibilityDescription: check.state)!)
      icon.contentTintColor = passed ? .systemGreen : failed ? .systemOrange : .secondaryLabelColor
      icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
      let title = Self.label(check.name + " · " + check.state.replacingOccurrences(of: "_", with: " "), size: 12)
      title.toolTip = check.summary
      checks.addArrangedSubview(stack([icon, title], vertical: false, spacing: 7))
    }
    checks.isHidden = checks.arrangedSubviews.isEmpty
    if !state.connected {
      notice.stringValue = "Connection unavailable. Existing work continues; no requests are repeated."
    } else if state.pending.contains(where: \.unresolved) {
      notice.stringValue = "A request is unconfirmed. Checking its receipt; it will not be sent again."
    } else if state.waitingForSnapshot {
      notice.stringValue = "Request recorded. Refreshing task progress…"
    } else if let message = snapshot?.notice, !message.isEmpty {
      notice.stringValue = message
    } else if let last = snapshot?.operations.last, last.state == "refused" {
      notice.stringValue = "Request not applied. " + last.message
    } else { notice.stringValue = "" }
    notice.isHidden = notice.stringValue.isEmpty
  }
  private func validText(_ value: String) -> Bool { (1...8000).contains(value.count) && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  func textDidChange(_ notification: Notification) { taskInput.needsDisplay = true; answerInput.needsDisplay = true; render() }
  @objc private func submitTask(_ sender: Any?) { perform(.submit, text: taskInput.string) }
  @objc private func chooseAnswer(_ sender: NSButton) {
    guard let option = state.decisionOption(at: sender.tag) else { return }
    answerInput.string = option; answerInput.needsDisplay = true
    render(); panel?.makeFirstResponder(answerInput)
  }
  @objc private func sendAnswer(_ sender: Any?) { perform(.decide, text: answerInput.string) }
  @objc private func acceptResult(_ sender: Any?) { perform(.accept) }
  @objc private func stopSharing(_ sender: Any?) { perform(.stopSharing) }
  @objc private func stopCall(_ sender: Any?) { perform(.stopCall) }
  @objc private func reviseResult(_ sender: Any?) { showRevision = true; render(); panel?.makeFirstResponder(answerInput) }
  @objc private func cancelTask(_ sender: Any?) {
    guard state.allows(.cancel), let task = state.snapshot?.task, let panel else { return }
    let alert = NSAlert(); alert.messageText = "Cancel this task?"
    alert.informativeText = "This requests cancellation of the coding work. It is separate from stopping a call or sharing."
    alert.alertStyle = .warning; alert.addButton(withTitle: "Keep working"); alert.addButton(withTitle: "Cancel task")
    alert.beginSheetModal(for: panel) { [weak self] response in
      guard response == .alertSecondButtonReturn, let self else { return }
      guard self.state.snapshot?.task?.id == task.id, self.state.snapshot?.task?.runId == task.runId,
        self.state.snapshot?.task?.revision == task.revision else {
        self.notice.stringValue = "The task changed. Review its current state before canceling."; self.notice.isHidden = false; return
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
            if action == .submit && taskInput.string == text { taskInput.string = "" }
            if action == .decide && answerInput.string == text { answerInput.string = ""; showRevision = false }
          }
        } catch { try? receipts.markUnknown(id) }
        state.pending = receipts.entries; render()
      }
    } catch {
      notice.stringValue = (error as? PanelFailure)?.errorDescription ?? "Request unavailable. No action was sent."
      notice.isHidden = false; state.pending = receipts.entries
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
