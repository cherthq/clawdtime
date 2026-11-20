import AppKit
import TaskPanelCore

/// Everything the board shows, as plain values. The app builds one; the board draws it.
struct BoardModel {
  var status = PetStatus(mood: .offline, headline: "Not connected", detail: "", bubble: nil)
  var board: AgentBoard?
  var now = Date().timeIntervalSince1970 * 1000
  var projectPath = ""
  var modeText = ""
  var notice = ""
  var stage = ""
  var task: PanelTask?
  var canSubmit = false
  var showRevision = false
  var allowSubmit = false, allowDecide = false, allowAccept = false, allowCancel = false
  var allowStopSharing = false, allowStopCall = false
  var sharingActive = false
  var callStatus = ""
  /// What agents ask the person now. Each can be answered right here.
  var decisions: [PendingDecisions.Request] = []
}

private final class FlippedView: NSView { override var isFlipped: Bool { true } }

final class BoardWindow: NSPanel {
  var onCancel: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override func cancelOperation(_ sender: Any?) { onCancel?() }
}

/// One session. A click brings its terminal forward.
final class AgentRowView: NSView {
  private(set) var sessionId: String
  var onOpen: ((String) -> Void)?
  private let mark = StateMark()
  private let title = Theme.label("", font: Theme.sans(14, weight: 600))
  private let subtitle = Theme.label("", font: Theme.sans(12), color: .labelSecondary)
  private let time = Theme.label("", font: Theme.mono(11.5), color: .labelSecondary)
  private let arrow = NSImageView()
  private var canOpen = false
  private var waiting = false { didSet { if waiting != oldValue { needsDisplay = true } } }
  private var hovering = false { didSet { needsDisplay = true; arrow.animator().alphaValue = hovering && canOpen ? 1 : 0 } }
  private var pressing = false { didSet { needsDisplay = true } }
  private var tracking: NSTrackingArea?

  init(session: AgentBoard.Session, now: Double) {
    sessionId = session.id
    super.init(frame: .zero)
    wantsLayer = true
    time.alignment = .right
    time.setContentHuggingPriority(.required, for: .horizontal); time.setContentCompressionResistancePriority(.required, for: .horizontal)
    arrow.image = Theme.symbol("arrow.up.forward", size: 10, weight: .bold); arrow.contentTintColor = Theme.color(.labelSecondary)
    arrow.alphaValue = 0
    arrow.setContentHuggingPriority(.required, for: .horizontal)
    let text = NSStackView(views: [title, subtitle]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 1
    text.setContentHuggingPriority(.defaultLow, for: .horizontal)
    for field in [title, subtitle] { field.setContentHuggingPriority(.defaultLow, for: .horizontal) }
    let row = NSStackView(views: [mark, text, time, arrow]); row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 10
    row.distribution = .fill; row.setCustomSpacing(6, after: time)
    addSubview(row); row.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      row.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: 46)])
    setAccessibilityElement(true); setAccessibilityRole(.button)
    update(session, now: now)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }

  func update(_ session: AgentBoard.Session, now: Double) {
    sessionId = session.id; canOpen = session.canFocus; waiting = session.state == .needsYou
    mark.state = session.state
    title.stringValue = AgentBoardText.title(session)
    // The face sets a narrow space: the separators get room to breathe.
    subtitle.stringValue = AgentBoardText.subtitle(session).replacingOccurrences(of: " · ", with: "  ·  ")
    subtitle.textColor = Theme.color(waiting ? .warning : .labelSecondary)
    time.stringValue = AgentBoardText.elapsed(since: session.since, now: now)
    time.textColor = Theme.color(session.state == .needsYou ? .warning : .labelSecondary)
    toolTip = AgentBoardText.focusHint(session)
    setAccessibilityLabel(AgentBoardText.accessibility(session, now: now)); setAccessibilityHelp(AgentBoardText.focusHint(session))
    setAccessibilityEnabled(canOpen)
    syncHover()
  }
  /// Rows change place while the pointer rests. The highlight follows the pointer, not the row.
  func syncHover() {
    guard let window else { return }
    let inside = window.isVisible && window.frame.contains(NSEvent.mouseLocation) &&
      bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil))
    if hovering != inside { hovering = inside }
  }
  // The whole row is one target: its labels never take the click.
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    guard canOpen else { return }
    pressing = true; animateScale(0.985, spring: false)
  }
  override func mouseUp(with event: NSEvent) {
    guard pressing else { return }
    pressing = false; animateScale(1, spring: true)
    if bounds.contains(convert(event.locationInWindow, from: nil)) { onOpen?(sessionId) }
  }
  override func accessibilityPerformPress() -> Bool {
    guard canOpen else { return false }
    onOpen?(sessionId); return true
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area); tracking = area
  }
  override func mouseEntered(with event: NSEvent) {
    hovering = true
    // Only one row is under the pointer.
    for view in superview?.subviews ?? [] where view !== self { (view as? AgentRowView)?.syncHover() }
  }
  override func mouseExited(with event: NSEvent) { hovering = false; if pressing { pressing = false; animateScale(1, spring: true) } }
  override func draw(_ dirtyRect: NSRect) {
    let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: 1), xRadius: 12, yRadius: 12)
    // A session that waits for the person sits on the warning tint, always.
    if waiting { Theme.color(.warningTint).setFill(); shape.fill() }
    guard canOpen, hovering || pressing else { return }
    Theme.color(pressing ? .fillPressed : .fill).withAlphaComponent(waiting ? 0.5 : 1).setFill(); shape.fill()
  }
}

private final class PlaceholderTextView: NSTextView {
  var placeholder = ""
  var onFocus: (() -> Void)?
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard string.isEmpty else { return }
    (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height),
      withAttributes: [.font: font ?? Theme.sans(14), .foregroundColor: Theme.color(.labelSecondary)])
  }
  override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); onFocus?(); return result }
  override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); onFocus?(); return result }
}

/// A field for a few lines of text, on the resting fill of the design system.
final class ComposerView: NSView, NSTextViewDelegate {
  private let text = PlaceholderTextView()
  private let scroll = NSScrollView()
  var onChange: (() -> Void)?
  /// The field grew or shrank: its container lays out again.
  var onExpandChange: (() -> Void)?
  var placeholder: String {
    get { text.placeholder }
    set { if text.placeholder != newValue { text.placeholder = newValue; text.setAccessibilityLabel(newValue); text.needsDisplay = true } }
  }
  private let full: CGFloat
  private let compact: CGFloat?
  private var heightConstraint: NSLayoutConstraint!
  var string: String {
    get { text.string }
    set { if text.string != newValue { text.string = newValue; text.needsDisplay = true; refreshHeight() } }
  }
  /// One line at rest. It opens when the person clicks into it or has written something.
  var isExpanded: Bool { compact == nil || window?.firstResponder === text || !text.string.isEmpty }
  private func refreshHeight() {
    let wanted = isExpanded ? full : (compact ?? full)
    guard heightConstraint.constant != wanted else { return }
    heightConstraint.constant = wanted
    onExpandChange?()
  }
  init(placeholder: String, height: CGFloat, compactHeight: CGFloat? = nil) {
    full = height; compact = compactHeight
    super.init(frame: .zero)
    text.placeholder = placeholder; text.delegate = self
    text.font = Theme.sans(14); text.textColor = Theme.color(.label); text.insertionPointColor = Theme.color(.accentText)
    text.isRichText = false; text.importsGraphics = false
    text.isAutomaticQuoteSubstitutionEnabled = false; text.isAutomaticDashSubstitutionEnabled = false; text.isAutomaticTextReplacementEnabled = false
    text.textContainerInset = NSSize(width: 8, height: 9); text.drawsBackground = false
    text.isVerticallyResizable = true; text.isHorizontallyResizable = false
    text.textContainer?.widthTracksTextView = true; text.autoresizingMask = [.width]
    text.setAccessibilityLabel(placeholder)
    text.onFocus = { [weak self] in
      self?.needsDisplay = true
      // The first responder changes after this call returns.
      DispatchQueue.main.async { self?.refreshHeight(); self?.needsDisplay = true }
    }
    scroll.documentView = text; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
    scroll.drawsBackground = false; scroll.borderType = .noBorder
    addSubview(scroll); scroll.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor)])
    heightConstraint = heightAnchor.constraint(equalToConstant: compactHeight ?? height)
    heightConstraint.isActive = true
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  func focus() { window?.makeFirstResponder(text) }
  func textDidChange(_ notification: Notification) { text.needsDisplay = true; refreshHeight(); onChange?() }
  override func draw(_ dirtyRect: NSRect) {
    let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 10, yRadius: 10)
    Theme.color(.fill).setFill(); shape.fill()
    if window?.firstResponder === text { Theme.color(.accentText).setStroke(); shape.lineWidth = 1.5; shape.stroke() }
  }
}

/// One answer that the worker offers. A click fills the answer field; Send is still needed.
private final class ChoiceView: NSControl {
  private let label: NSTextField
  private var hovering = false { didSet { needsDisplay = true } }
  private var tracking: NSTrackingArea?
  init(_ text: String, index: Int, target: AnyObject, action: Selector) {
    label = Theme.label(text, font: Theme.sans(13, weight: 500), lines: 4)
    super.init(frame: .zero)
    tag_ = index; self.target = target; self.action = action
    wantsLayer = true
    addSubview(label); label.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 9), label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9)])
    setAccessibilityElement(true); setAccessibilityRole(.button); setAccessibilityLabel(text)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  private var tag_ = 0
  override var tag: Int { get { tag_ } set { tag_ = newValue } }
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func draw(_ dirtyRect: NSRect) {
    Theme.color(hovering ? .fillPressed : .fill).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area); tracking = area
  }
  override func mouseEntered(with event: NSEvent) { hovering = true }
  override func mouseExited(with event: NSEvent) { hovering = false }
  override func mouseDown(with event: NSEvent) { guard isEnabled else { return }; animateScale(0.985, spring: false) }
  override func mouseUp(with event: NSEvent) {
    animateScale(1, spring: true)
    if isEnabled, bounds.contains(convert(event.locationInWindow, from: nil)) { sendAction(action, to: target) }
  }
  override func accessibilityPerformPress() -> Bool { sendAction(action, to: target); return true }
}

/// A tinted note: what is wrong, in one sentence.
private final class NoticeView: NSView {
  let label = Theme.label("", font: Theme.sans(12.5), color: .warning, lines: 4)
  override init(frame: NSRect) {
    super.init(frame: frame)
    addSubview(label); label.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 9), label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9)])
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func draw(_ dirtyRect: NSRect) {
    Theme.color(.warningTint).setFill(); NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
  }
}

/// One request of an agent, with its answer one click away. The agent's own hook
/// hands the answer to the agent; nothing is typed into its terminal.
final class DecisionCardView: NSView {
  let requestId: String
  /// decision, text, remember
  var onDecide: ((String, String?, Bool) -> Void)?
  private let title = Theme.label("", font: Theme.sans(13, weight: 600), lines: 2)
  private let summary = Theme.label("", font: Theme.mono(12), lines: 4)
  private let hint = Theme.label("", font: Theme.sans(11.5), color: .warning, lines: 2)
  private let options: [String]
  private var remember = false
  private var rememberButton: PillButton?

  init(request: PendingDecisions.Request, now: Double) {
    requestId = request.id; options = request.options
    super.init(frame: .zero)
    let box = NSView(); box.wantsLayer = true; box.layer?.cornerRadius = 8
    box.addSubview(summary); summary.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([summary.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 9), summary.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -9),
      summary.topAnchor.constraint(equalTo: box.topAnchor, constant: 7), summary.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -7)])
    summaryBox = box
    let controls = NSStackView(); controls.orientation = request.isQuestion ? .vertical : .horizontal
    controls.alignment = request.isQuestion ? .leading : .centerY; controls.spacing = 8
    if request.isQuestion {
      for (index, option) in request.options.enumerated() {
        let choice = PillButton(option, kind: .secondary, target: self, action: #selector(choose(_:))); choice.tag = index
        controls.addArrangedSubview(choice)
      }
      controls.addArrangedSubview(PillButton("Skip the question", kind: .ghost, small: true, target: self, action: #selector(deny)))
    } else {
      controls.addArrangedSubview(PillButton(request.kind == "plan" ? "Approve the plan" : "Approve", kind: .accent, target: self, action: #selector(approve)))
      controls.addArrangedSubview(PillButton("Deny", kind: .secondary, target: self, action: #selector(deny)))
      if request.canRemember {
        let toggle = PillButton("Always in this project", kind: .ghost, small: true, target: self, action: #selector(toggleRemember))
        toggle.toolTip = "Also make a rule: the same request in this project is allowed with no question."
        rememberButton = toggle; controls.addArrangedSubview(toggle)
      }
    }
    let stack = NSStackView(views: [title, box, controls, hint]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
    addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 12), stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
      box.widthAnchor.constraint(equalTo: stack.widthAnchor), title.widthAnchor.constraint(equalTo: stack.widthAnchor), hint.widthAnchor.constraint(equalTo: stack.widthAnchor)])
    setAccessibilityElement(false)
    update(request, now: now)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  private var summaryBox: NSView!
  func update(_ request: PendingDecisions.Request, now: Double) {
    title.stringValue = DecisionText.title(request)
    summary.stringValue = DecisionText.summary(request)
    hint.stringValue = [DecisionText.history(request), DecisionText.remaining(request, now: now)].filter { !$0.isEmpty }.joined(separator: "  ·  ")
  }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
  override func draw(_ dirtyRect: NSRect) {
    Theme.color(.warningTint).setFill(); NSBezierPath(roundedRect: bounds, xRadius: 14, yRadius: 14).fill()
    effectiveAppearance.performAsCurrentDrawingAppearance { summaryBox.layer?.backgroundColor = Theme.color(.raised).cgColor }
  }
  @objc private func approve() { onDecide?("allow", nil, remember) }
  @objc private func deny() { onDecide?("deny", nil, false) }
  @objc private func choose(_ sender: NSControl) {
    guard options.indices.contains(sender.tag) else { return }
    onDecide?("answer", options[sender.tag], false)
  }
  @objc private func toggleRemember() {
    remember.toggle()
    rememberButton?.kind = remember ? .secondary : .ghost
    rememberButton?.title = remember ? "Always in this project: on" : "Always in this project"
  }
}

/// The card: a headline that says the most urgent thing, the sessions, and the task.
final class BoardView: NSView {
  var onOpenSession: ((String) -> Void)?
  /// request id, decision, text, remember
  var onDecide: ((String, String, String?, Bool) -> Void)?
  var onSubmit: ((String) -> Void)?
  var onAnswer: ((String) -> Void)?
  var onAccept: (() -> Void)?
  var onCancelTask: (() -> Void)?
  var onRevise: (() -> Void)?
  var onStopSharing: (() -> Void)?
  var onStopCall: (() -> Void)?
  var onDock: (() -> Void)?
  var onClose: (() -> Void)?
  var onTextChange: (() -> Void)?
  /// The height the card wants. The window follows it.
  var onResize: (() -> Void)?

  static let width: CGFloat = 392
  /// The controller sets this from the screen the mascot is on.
  var maxHeight: CGFloat = 640
  private let fade = CAGradientLayer()
  private var agentsBlock: NSView!, taskBlock: NSView!, ruleView: NSView!
  private var taskFirst = false
  private let headline = Theme.label("", font: Theme.display(23), lines: 2)
  private let detail = Theme.label("", font: Theme.sans(12.5), color: .labelSecondary)
  private let scroll = NSScrollView()
  private let document = FlippedView()
  private let stack = NSStackView()
  private var scrollHeight: NSLayoutConstraint!
  // Agents
  private let pills = NSStackView()
  private let waitingPill = StatusPill(text: "", ink: .warning, ground: .warningTint)
  private let workingPill = StatusPill(text: "", ink: .info, ground: .infoTint)
  private let idlePill = StatusPill(text: "", ink: .labelSecondary, ground: .fill)
  private let rows = NSStackView()
  private var shownIds: [String] = []
  private var showAll = false
  private var moreButton: PillButton!
  private let emptyNote = Theme.label("Start a coding agent in a terminal and it appears here.", font: Theme.sans(12.5), color: .labelSecondary, lines: 2)
  // Requests of agents that can be answered here
  private let decisionStack = NSStackView()
  private var shownDecisions: [String] = []
  // Stop and notices
  private let stopBar = NSStackView()
  private let stopLabel = Theme.label("", font: Theme.sans(12.5, weight: 600), color: .danger)
  private var stopSharing: PillButton!, stopCall: PillButton!
  private let notice = NoticeView()
  // Task
  private let taskTitle = Theme.label("Task", font: Theme.sans(12, weight: 600), color: .labelSecondary)
  private let mode = Theme.label("", font: Theme.mono(11), color: .labelSecondary)
  private let stage = Theme.label("", font: Theme.sans(15, weight: 600), lines: 2)
  private let goal = Theme.label("", font: Theme.sans(13), color: .labelSecondary, lines: 4)
  private let summary = Theme.label("", font: Theme.sans(13), lines: 8)
  private let checks = NSStackView()
  private var shownChecks: [String] = []
  let taskInput = ComposerView(placeholder: "Give ClawdTime a task", height: 68, compactHeight: 38)
  private var start: PillButton!
  private var startRow: NSView!
  private let question = Theme.label("", font: Theme.sans(14, weight: 600), lines: 6)
  private let choices = NSStackView()
  private var shownChoices: [String] = []
  let answerInput = ComposerView(placeholder: "Your answer or requested revision", height: 68)
  private var send: PillButton!, accept: PillButton!, revise: PillButton!, cancel: PillButton!
  private let decisionBlock = NSStackView(), reviewBlock = NSStackView(), composeBlock = NSStackView(), progressBlock = NSStackView()
  private let footer = Theme.label("", font: Theme.mono(11), color: .labelSecondary)
  private let toast = Theme.label("", font: Theme.sans(12, weight: 600), color: .onPrimary)
  private let toastGround = NSView()
  private var model = BoardModel()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = CGFloat(DesignTokens.radiusSheet); layer?.cornerCurve = .continuous; layer?.masksToBounds = true
    layer?.borderWidth = 1

    let side = IconButton(symbol: "arrow.right.to.line", label: "Tuck ClawdTime against the edge of the screen", target: self, action: #selector(dock))
    let close = IconButton(symbol: "xmark", label: "Close the board", target: self, action: #selector(closeBoard))
    let words = NSStackView(views: [headline, detail]); words.orientation = .vertical; words.alignment = .leading; words.spacing = 2
    words.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let buttons = NSStackView(views: [side, close]); buttons.orientation = .horizontal; buttons.spacing = 2
    let gap = NSView(); gap.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    gap.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    headline.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    let header = NSStackView(views: [words, gap, buttons]); header.orientation = .horizontal; header.alignment = .top; header.distribution = .fill
    header.spacing = 6

    moreButton = PillButton("", kind: .ghost, small: true, target: self, action: #selector(toggleMore))
    stopSharing = PillButton("Stop sharing", kind: .danger, small: true, symbol: "stop.fill", target: self, action: #selector(stopSharingPressed))
    stopCall = PillButton("Stop call", kind: .danger, small: true, symbol: "phone.down.fill", target: self, action: #selector(stopCallPressed))
    start = PillButton("Start task", kind: .primary, target: self, action: #selector(submit))
    send = PillButton("Send answer", kind: .primary, target: self, action: #selector(answer))
    accept = PillButton("Accept result", kind: .accent, target: self, action: #selector(acceptPressed))
    revise = PillButton("Revise", kind: .secondary, target: self, action: #selector(revisePressed))
    cancel = PillButton("Cancel task", kind: .ghost, small: true, target: self, action: #selector(cancelPressed))

    func vertical(_ stack: NSStackView, _ views: [NSView], spacing: CGFloat) {
      stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing; stack.detachesHiddenViews = true
      for view in views { stack.addArrangedSubview(view) }
    }
    func fill(_ views: [NSView], in stack: NSStackView) { for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true } }
    func trailing(_ view: NSView) -> NSStackView {
      let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
      let row = NSStackView(views: [spacer, view]); row.orientation = .horizontal; row.distribution = .fill; return row
    }

    stopBar.orientation = .horizontal; stopBar.spacing = 8; stopBar.distribution = .fill
    stopLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    for view in [stopLabel, stopSharing!, stopCall!] as [NSView] { stopBar.addArrangedSubview(view) }

    pills.orientation = .horizontal; pills.spacing = 6; pills.detachesHiddenViews = true
    for pill in [waitingPill, workingPill, idlePill] { pills.addArrangedSubview(pill) }
    rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 0
    let agents = NSStackView(); vertical(agents, [pills, rows, emptyNote, moreButton], spacing: 8)
    fill([rows, emptyNote], in: agents)

    checks.orientation = .vertical; checks.alignment = .leading; checks.spacing = 6
    choices.orientation = .vertical; choices.alignment = .leading; choices.spacing = 6
    let taskHead = NSStackView(views: [taskTitle, mode]); taskHead.orientation = .horizontal; taskHead.distribution = .fill
    taskTitle.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let startRow = trailing(start)
    self.startRow = startRow; startRow.isHidden = true
    vertical(composeBlock, [taskInput, startRow], spacing: 8); fill([taskInput, startRow], in: composeBlock)
    vertical(progressBlock, [stage, goal, summary, checks], spacing: 6); fill([stage, goal, summary, checks], in: progressBlock)
    let sendRow = trailing(send)
    vertical(decisionBlock, [question, choices, answerInput, sendRow], spacing: 8); fill([question, choices, answerInput, sendRow], in: decisionBlock)
    let reviewButtons = NSStackView(views: [accept, revise]); reviewButtons.orientation = .horizontal; reviewButtons.spacing = 8
    vertical(reviewBlock, [reviewButtons], spacing: 8)
    let footerRow = NSStackView(views: [footer, cancel]); footerRow.orientation = .horizontal; footerRow.distribution = .fill
    footer.lineBreakMode = .byTruncatingMiddle; footer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let rule = NSBox(); rule.boxType = .custom; rule.borderWidth = 0; rule.fillColor = Theme.color(.rule)
    rule.heightAnchor.constraint(equalToConstant: 1).isActive = true
    let task = NSStackView(); vertical(task, [taskHead, progressBlock, composeBlock, decisionBlock, reviewBlock, footerRow], spacing: 10)
    fill([taskHead, progressBlock, composeBlock, decisionBlock, footerRow], in: task)

    decisionStack.orientation = .vertical; decisionStack.alignment = .leading; decisionStack.spacing = 8
    vertical(stack, [stopBar, decisionStack, notice, agents, rule, task], spacing: 14)
    fill([stopBar, decisionStack, notice, agents, rule, task], in: stack)
    agentsBlock = agents; taskBlock = task; ruleView = rule
    scroll.wantsLayer = true
    // The scroll view's layer runs top to bottom: the fade is at the end, the bottom.
    fade.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
    fade.locations = [0, 0.90, 1]; fade.isHidden = true
    document.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
    // No scroll bar: the fade at the bottom edge says that there is more.
    scroll.documentView = document; scroll.drawsBackground = false; scroll.hasVerticalScroller = false
    scroll.borderType = .noBorder
    document.translatesAutoresizingMaskIntoConstraints = false

    toastGround.wantsLayer = true; toastGround.layer?.cornerRadius = 14; toastGround.alphaValue = 0
    toastGround.addSubview(toast); toast.translatesAutoresizingMaskIntoConstraints = false
    for view in [header, scroll, toastGround] as [NSView] { addSubview(view); view.translatesAutoresizingMaskIntoConstraints = false }
    scrollHeight = scroll.heightAnchor.constraint(equalToConstant: 200)
    let pad = CGFloat(DesignTokens.space5)
    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad), header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      header.topAnchor.constraint(equalTo: topAnchor, constant: 18),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 14), scrollHeight,
      document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor), document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
      document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
      stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: pad), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -pad),
      stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 2), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -18),
      toastGround.centerXAnchor.constraint(equalTo: centerXAnchor), toastGround.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
      toastGround.heightAnchor.constraint(equalToConstant: 28),
      toast.leadingAnchor.constraint(equalTo: toastGround.leadingAnchor, constant: 14), toast.trailingAnchor.constraint(equalTo: toastGround.trailingAnchor, constant: -14),
      toast.centerYAnchor.constraint(equalTo: toastGround.centerYAnchor),
      toastGround.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -28),
    ])
    taskInput.onChange = { [weak self] in self?.refreshButtons(); self?.onTextChange?() }
    taskInput.onExpandChange = { [weak self] in
      guard let self else { return }
      self.startRow.isHidden = !self.taskInput.isExpanded
      self.onResize?()
    }
    answerInput.onExpandChange = { [weak self] in self?.onResize?() }
    answerInput.onChange = { [weak self] in self?.refreshButtons(); self?.onTextChange?() }
    setAccessibilityLabel("ClawdTime board")
    refreshColors()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); refreshColors() }
  override func layout() {
    super.layout()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    fade.frame = scroll.bounds
    scroll.layer?.mask = fade.isHidden ? nil : fade
    CATransaction.commit()
  }
  private func refreshColors() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      layer?.backgroundColor = Theme.color(.raised).cgColor
      layer?.borderColor = Theme.color(.borderSubtle).cgColor
      toastGround.layer?.backgroundColor = Theme.color(.primary).cgColor
    }
  }
  /// The card is as tall as its content, up to a limit; then the content scrolls.
  var fittingHeight: CGFloat {
    layoutSubtreeIfNeeded()
    let content = stack.fittingSize.height + 20
    let head = scroll.frame.minY > 0 ? bounds.height - scroll.frame.maxY : 78
    let available = maxHeight - max(60, head)
    scrollHeight.constant = min(content, available)
    // More below: the last rows fade out, so the edge reads as a scroll, not as an end.
    let overflows = content > available + 0.5
    if fade.isHidden == overflows { fade.isHidden = !overflows; needsLayout = true }
    return max(60, head) + scrollHeight.constant
  }
  var hasDraft: Bool { !taskInput.string.isEmpty || !answerInput.string.isEmpty }

  private func validText(_ value: String) -> Bool { (1...8000).contains(value.count) && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private func refreshButtons() {
    start.isEnabled = model.allowSubmit && validText(taskInput.string)
    send.isEnabled = model.allowDecide && validText(answerInput.string)
  }

  func render(_ model: BoardModel) {
    self.model = model
    headline.stringValue = model.status.headline; detail.stringValue = model.status.detail

    let stoppable = model.allowStopSharing || model.allowStopCall
    stopBar.isHidden = !stoppable && !model.sharingActive
    stopLabel.stringValue = model.callStatus
    stopSharing.isEnabled = model.allowStopSharing; stopCall.isEnabled = model.allowStopCall
    stopSharing.isHidden = !model.allowStopSharing && !model.sharingActive
    stopCall.isHidden = !model.allowStopCall
    notice.label.stringValue = model.notice; notice.isHidden = model.notice.isEmpty

    let asked = Array(model.decisions.prefix(3))
    if asked.map(\.id) == shownDecisions {
      for (view, request) in zip(decisionStack.arrangedSubviews, asked) { (view as? DecisionCardView)?.update(request, now: model.now) }
    } else {
      decisionStack.arrangedSubviews.forEach { decisionStack.removeArrangedSubview($0); $0.removeFromSuperview() }
      for request in asked {
        let card = DecisionCardView(request: request, now: model.now)
        card.onDecide = { [weak self] decision, text, remember in self?.onDecide?(request.id, decision, text, remember) }
        decisionStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: decisionStack.widthAnchor).isActive = true
      }
      shownDecisions = asked.map(\.id)
    }
    decisionStack.isHidden = asked.isEmpty

    if let board = model.board {
      let counts = board.counts
      waitingPill.text = "\(counts.needsYou) \(counts.needsYou == 1 ? "needs" : "need") you"; waitingPill.isHidden = counts.needsYou == 0
      workingPill.text = "\(counts.working) working"; workingPill.isHidden = counts.working == 0
      let quiet = counts.idle + counts.unknown
      idlePill.text = "\(quiet) idle"; idlePill.isHidden = quiet == 0
      pills.isHidden = board.sessions.isEmpty
      // Sessions that wait or work always show. Quiet ones fill what is left of six rows.
      let visible = AgentBoardText.rows(board, quietLimit: showAll ? 500 : max(2, 6 - counts.needsYou - counts.working))
      let ids = visible.shown.map(\.id)
      if ids == shownIds {
        for (view, session) in zip(rows.arrangedSubviews, visible.shown) { (view as? AgentRowView)?.update(session, now: model.now) }
      } else {
        rows.arrangedSubviews.forEach { rows.removeArrangedSubview($0); $0.removeFromSuperview() }
        for session in visible.shown {
          let row = AgentRowView(session: session, now: model.now)
          row.onOpen = { [weak self] id in self?.onOpenSession?(id) }
          rows.addArrangedSubview(row)
          // Rows reach 10 points past the text column, so the hover ground has air.
          row.widthAnchor.constraint(equalTo: rows.widthAnchor, constant: 20).isActive = true
          row.leadingAnchor.constraint(equalTo: rows.leadingAnchor, constant: -10).isActive = true
        }
        shownIds = ids
      }
      rows.isHidden = ids.isEmpty
      emptyNote.isHidden = !board.sessions.isEmpty
      let hidden = visible.hidden
      moreButton.isHidden = hidden == 0 && !showAll
      moreButton.title = showAll ? "Show fewer" : "Show \(hidden) more idle"
    } else {
      pills.isHidden = true; rows.isHidden = true; moreButton.isHidden = true; emptyNote.isHidden = true; shownIds = []
      rows.arrangedSubviews.forEach { rows.removeArrangedSubview($0); $0.removeFromSuperview() }
    }

    let task = model.task
    taskInput.placeholder = model.modeText.hasPrefix("Simulation") ? "Simulation: a task here only queues" : "Give ClawdTime a task"
    // A task that waits for the person comes before the agents.
    let wantsFirst = task?.decision != nil || task?.canAccept == true
    if wantsFirst != taskFirst {
      taskFirst = wantsFirst
      for view in [agentsBlock!, ruleView!, taskBlock!] { stack.removeArrangedSubview(view) }
      for view in (wantsFirst ? [taskBlock!, ruleView!, agentsBlock!] : [agentsBlock!, ruleView!, taskBlock!]) {
        stack.addArrangedSubview(view)
      }
    }
    mode.stringValue = model.modeText
    composeBlock.isHidden = !(model.canSubmit && task == nil)
    progressBlock.isHidden = task == nil
    stage.stringValue = model.stage
    goal.stringValue = task?.goal ?? ""; goal.isHidden = goal.stringValue.isEmpty
    summary.stringValue = task?.summary ?? ""; summary.isHidden = summary.stringValue.isEmpty
    let checkKeys = (task?.checks ?? []).map { $0.name + "|" + $0.state }
    if checkKeys != shownChecks {
      shownChecks = checkKeys
      checks.arrangedSubviews.forEach { checks.removeArrangedSubview($0); $0.removeFromSuperview() }
      for check in task?.checks ?? [] {
        let passed = check.state == "passed", failed = check.state == "failed"
        let icon = NSImageView(image: Theme.symbol(passed ? "checkmark.circle.fill" : failed ? "xmark.circle.fill" : "circle.dotted", size: 12) ?? NSImage())
        icon.contentTintColor = Theme.color(passed ? .success : failed ? .danger : .labelSecondary)
        let text = Theme.label(check.name + " · " + check.state.replacingOccurrences(of: "_", with: " "), font: Theme.sans(12.5), color: .label)
        text.toolTip = check.summary
        let row = NSStackView(views: [icon, text]); row.orientation = .horizontal; row.spacing = 7
        checks.addArrangedSubview(row)
      }
    }
    checks.isHidden = checkKeys.isEmpty

    let deciding = task?.decision != nil || (model.showRevision && task?.canDecide == true)
    decisionBlock.isHidden = !deciding
    question.stringValue = task?.decision?.question ?? "What would you like to revise?"
    let options = task?.decision?.options ?? []
    if options != shownChoices {
      shownChoices = options
      choices.arrangedSubviews.forEach { choices.removeArrangedSubview($0); $0.removeFromSuperview() }
      for (index, option) in options.enumerated() {
        let choice = ChoiceView(option, index: index, target: self, action: #selector(choose(_:)))
        choices.addArrangedSubview(choice)
        choice.widthAnchor.constraint(equalTo: choices.widthAnchor).isActive = true
      }
    }
    for view in choices.arrangedSubviews { (view as? NSControl)?.isEnabled = model.allowDecide }
    choices.isHidden = options.isEmpty
    send.title = task?.decision == nil ? "Send revision" : "Send answer"
    reviewBlock.isHidden = task?.canAccept != true
    accept.isEnabled = model.allowAccept; revise.isEnabled = model.allowDecide
    cancel.isHidden = task == nil; cancel.isEnabled = model.allowCancel
    footer.stringValue = model.projectPath; footer.toolTip = model.projectPath
    refreshButtons()
    onResize?()
  }

  /// One line that confirms what just happened. It leaves by itself.
  func showToast(_ text: String) {
    toast.stringValue = text
    toastGeneration += 1
    let generation = toastGeneration
    NSAnimationContext.runAnimationGroup { context in context.duration = 0.16; toastGround.animator().alphaValue = 1 }
    toastGround.animateScale(1, spring: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) { [weak self] in
      guard let self, generation == self.toastGeneration else { return }
      NSAnimationContext.runAnimationGroup { context in context.duration = 0.2; self.toastGround.animator().alphaValue = 0 }
    }
  }
  private var toastGeneration = 0
  func clearTaskInput() { taskInput.string = ""; refreshButtons() }
  func clearAnswerInput() { answerInput.string = ""; refreshButtons() }

  @objc private func dock() { onDock?() }
  @objc private func closeBoard() { onClose?() }
  @objc private func toggleMore() { showAll.toggle(); render(model) }
  @objc private func stopSharingPressed() { onStopSharing?() }
  @objc private func stopCallPressed() { onStopCall?() }
  @objc private func submit() { onSubmit?(taskInput.string) }
  @objc private func answer() { onAnswer?(answerInput.string) }
  @objc private func acceptPressed() { onAccept?() }
  @objc private func revisePressed() { onRevise?(); answerInput.focus() }
  @objc private func cancelPressed() { onCancelTask?() }
  @objc private func choose(_ sender: NSControl) {
    guard shownChoices.indices.contains(sender.tag) else { return }
    answerInput.string = shownChoices[sender.tag]; refreshButtons(); answerInput.focus()
  }
}

/// The board's window: it opens out of the mascot with a spring and closes back into it.
final class BoardController: NSObject {
  let window: BoardWindow
  let view = BoardView(frame: NSRect(x: 0, y: 0, width: BoardView.width, height: 400))
  private let holder = NSView()
  private var progress = Spring(0, response: MotionToken.surface.response, dampingRatio: MotionToken.surface.dampingRatio)
  private var anchor = CGPoint(x: 1, y: 1)
  private(set) var isOpen = false
  private var petFrame = CGRect.zero
  private var screenFrame = CGRect.zero
  private var outside: Any?
  var onClosed: (() -> Void)?

  override init() {
    window = BoardWindow(contentRect: NSRect(x: 0, y: 0, width: BoardView.width, height: 400), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    super.init()
    window.level = .floating; window.isFloatingPanel = true; window.becomesKeyOnlyIfNeeded = true
    window.hidesOnDeactivate = false; window.isReleasedWhenClosed = false
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = true
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.animationBehavior = .none
    holder.wantsLayer = true
    holder.addSubview(view); view.autoresizingMask = [.width, .height]
    window.contentView = holder
    window.onCancel = { [weak self] in self?.close() }
    view.onResize = { [weak self] in self?.place() }
  }

  var settled: Bool { progress.settled }

  private func place() {
    guard isOpen || window.isVisible else { return }
    view.maxHeight = max(320, min(660, screenFrame.height - 72))
    let size = CGSize(width: BoardView.width, height: view.fittingHeight)
    let placed = PetLayout.panel(size: size, pet: petFrame, in: screenFrame)
    anchor = placed.anchor
    if window.frame != placed.frame { window.setFrame(placed.frame, display: true); view.frame = holder.bounds; apply() }
  }
  /// Follows the mascot when the person moves it.
  func follow(pet: CGRect, screen: CGRect) { petFrame = pet; screenFrame = screen; place() }

  func open(pet: CGRect, screen: CGRect) {
    petFrame = pet; screenFrame = screen; isOpen = true
    progress.target = 1
    if Theme.reduceMotion { progress.snap() }
    if !window.isVisible { window.alphaValue = 0; window.orderFrontRegardless() }
    place(); apply()
    // A click anywhere else puts the board away, unless something is half written.
    if outside == nil {
      outside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
        guard let self, self.isOpen, !self.view.hasDraft else { return }
        let point = NSEvent.mouseLocation
        if !self.window.frame.contains(point) && !self.petFrame.contains(point) { self.close() }
      }
    }
  }
  func close() {
    guard isOpen else { return }
    isOpen = false; progress.target = 0
    if Theme.reduceMotion { progress.snap(); apply() }
    if let outside { NSEvent.removeMonitor(outside); self.outside = nil }
    onClosed?()
  }
  /// One step of the open or close motion.
  func step(_ interval: Double) {
    guard !progress.settled || (window.isVisible && !isOpen) else { return }
    progress.step(interval); apply()
  }
  private func apply() {
    let value = CGFloat(progress.value)
    guard let layer = view.layer else { return }
    if !isOpen && value < 0.02 {
      window.orderOut(nil); progress.snap(to: 0)
      layer.transform = CATransform3DIdentity; return
    }
    // It grows out of the point nearest the mascot.
    let scale = 0.90 + 0.10 * value
    let pivot = CGPoint(x: holder.bounds.width * anchor.x, y: holder.bounds.height * anchor.y)
    var transform = CATransform3DMakeTranslation(pivot.x, pivot.y, 0)
    transform = CATransform3DScale(transform, scale, scale, 1)
    transform = CATransform3DTranslate(transform, -pivot.x, -pivot.y, 0)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.transform = transform
    CATransaction.commit()
    window.alphaValue = max(0, min(1, value * 1.7))
    window.invalidateShadow()
  }
}
