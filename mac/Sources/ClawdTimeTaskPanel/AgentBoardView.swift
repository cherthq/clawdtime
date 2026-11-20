import AppKit
import TaskPanelCore

private func stateColor(_ state: AgentBoard.State) -> NSColor {
  switch state {
  case .needsYou: return NSColor(calibratedRed: 0.90, green: 0.47, blue: 0.02, alpha: 1)
  case .working: return NSColor(calibratedRed: 0.10, green: 0.44, blue: 0.95, alpha: 1)
  case .idle, .unknown: return NSColor(white: 0.62, alpha: 1)
  }
}

/// Filled for a known state, a ring when the state is unknown.
private final class StateDot: NSView {
  var state: AgentBoard.State = .unknown { didSet { needsDisplay = true } }
  override var intrinsicContentSize: NSSize { NSSize(width: 10, height: 10) }
  override func draw(_ dirtyRect: NSRect) {
    let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
    if state == .unknown { stateColor(state).setStroke(); circle.lineWidth = 1.5; circle.stroke() }
    else { stateColor(state).setFill(); circle.fill() }
  }
}

/// One session. A click brings its terminal forward; it sends nothing to the session.
final class AgentRow: NSView {
  private(set) var sessionId: String
  var onOpen: ((String) -> Void)?
  private let dot = StateDot()
  private let title = NSTextField(labelWithString: "")
  private let subtitle = NSTextField(labelWithString: "")
  private let time = NSTextField(labelWithString: "")
  private var canOpen = false
  private var hovering = false { didSet { needsDisplay = true } }
  private var pressed = false { didSet { needsDisplay = true } }
  private var tracking: NSTrackingArea?

  init(session: AgentBoard.Session, now: Double) {
    sessionId = session.id
    super.init(frame: .zero)
    title.font = .systemFont(ofSize: 13, weight: .medium); title.textColor = NSColor(white: 0.13, alpha: 1)
    subtitle.font = .systemFont(ofSize: 11); subtitle.textColor = NSColor(white: 0.40, alpha: 1)
    time.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular); time.alignment = .right
    for field in [title, subtitle] {
      field.lineBreakMode = .byTruncatingTail; field.maximumNumberOfLines = 1
      field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    time.setContentHuggingPriority(.required, for: .horizontal)
    time.setContentCompressionResistancePriority(.required, for: .horizontal)
    let text = NSStackView(views: [title, subtitle]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 1
    // The text column takes the free width, so the time sits at the right edge.
    text.setContentHuggingPriority(.defaultLow, for: .horizontal)
    for field in [title, subtitle] { field.setContentHuggingPriority(.defaultLow, for: .horizontal) }
    dot.setContentHuggingPriority(.required, for: .horizontal)
    let row = NSStackView(views: [dot, text, time]); row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 10
    row.distribution = .fill
    addSubview(row); row.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 5), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5)])
    setAccessibilityElement(true); setAccessibilityRole(.button)
    update(session, now: now)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }

  func update(_ session: AgentBoard.Session, now: Double) {
    sessionId = session.id; canOpen = session.canFocus
    dot.state = session.state
    title.stringValue = AgentBoardText.title(session)
    subtitle.stringValue = AgentBoardText.subtitle(session)
    time.stringValue = AgentBoardText.elapsed(since: session.since, now: now)
    time.textColor = session.state == .needsYou ? stateColor(.needsYou) : NSColor(white: 0.45, alpha: 1)
    toolTip = AgentBoardText.focusHint(session)
    setAccessibilityLabel(AgentBoardText.accessibility(session, now: now))
    setAccessibilityHelp(AgentBoardText.focusHint(session))
    setAccessibilityEnabled(canOpen)
  }
  // The whole row is one target: its labels never take the click.
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { pressed = canOpen }
  override func mouseUp(with event: NSEvent) {
    let inside = bounds.contains(convert(event.locationInWindow, from: nil))
    let open = pressed && inside; pressed = false
    if open { onOpen?(sessionId) }
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
  override func mouseEntered(with event: NSEvent) { hovering = true }
  override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }
  override func draw(_ dirtyRect: NSRect) {
    guard canOpen, hovering || pressed else { return }
    NSColor.black.withAlphaComponent(pressed ? 0.10 : 0.05).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8).fill()
  }
}

/// The board of every coding-agent session on this Mac.
final class AgentBoardView: NSView {
  var onOpen: ((String) -> Void)?
  private let heading = NSTextField(labelWithString: "Agents")
  private let summary = NSTextField(labelWithString: "")
  private let rows = NSStackView()
  private let footer = NSTextField(wrappingLabelWithString: "")
  private var shownIds: [String] = []

  init() {
    super.init(frame: .zero)
    heading.font = .systemFont(ofSize: 13, weight: .semibold); heading.textColor = NSColor(white: 0.13, alpha: 1)
    summary.font = .systemFont(ofSize: 12); summary.textColor = NSColor(white: 0.40, alpha: 1)
    summary.lineBreakMode = .byTruncatingTail
    summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    footer.font = .systemFont(ofSize: 11); footer.textColor = NSColor(white: 0.40, alpha: 1)
    rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 0
    let head = NSStackView(views: [heading, summary]); head.orientation = .horizontal; head.alignment = .firstBaseline; head.spacing = 8
    head.distribution = .fill
    heading.setContentHuggingPriority(.required, for: .horizontal)
    heading.setContentCompressionResistancePriority(.required, for: .horizontal)
    summary.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let all = NSStackView(views: [head, rows, footer]); all.orientation = .vertical; all.alignment = .leading; all.spacing = 6
    all.detachesHiddenViews = true
    addSubview(all); all.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([all.leadingAnchor.constraint(equalTo: leadingAnchor), all.trailingAnchor.constraint(equalTo: trailingAnchor),
      all.topAnchor.constraint(equalTo: topAnchor), all.bottomAnchor.constraint(equalTo: bottomAnchor),
      head.widthAnchor.constraint(equalTo: all.widthAnchor),
      rows.widthAnchor.constraint(equalTo: all.widthAnchor), footer.widthAnchor.constraint(equalTo: all.widthAnchor)])
    setAccessibilityLabel("Agents")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }

  /// `message` is the result of the last open request, shown until it expires.
  func show(_ board: AgentBoard, now: Double, message: String) {
    summary.stringValue = AgentBoardText.summary(board.counts)
    let visible = AgentBoardText.rows(board)
    let ids = visible.shown.map(\.id)
    if ids == shownIds {
      // Same sessions in the same order: update in place so hover and focus stay.
      for (view, session) in zip(rows.arrangedSubviews, visible.shown) { (view as? AgentRow)?.update(session, now: now) }
    } else {
      rows.arrangedSubviews.forEach { rows.removeArrangedSubview($0); $0.removeFromSuperview() }
      for session in visible.shown {
        let row = AgentRow(session: session, now: now)
        row.onOpen = { [weak self] id in self?.onOpen?(id) }
        rows.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
      }
      shownIds = ids
    }
    rows.isHidden = ids.isEmpty
    let more = visible.hidden > 0 ? "\(visible.hidden) more idle" : ""
    let empty = board.sessions.isEmpty ? "Start a coding agent in a terminal and it appears here." : ""
    footer.stringValue = [message, more, empty].first { !$0.isEmpty } ?? ""
    footer.isHidden = footer.stringValue.isEmpty
  }
}
