import AppKit
import TaskPanelCore

/// What the chat screen shows.
struct ChatModel {
  var messages: [ChatTranscript.Message] = []
  /// What the person sent and ClawdTime has not answered yet.
  var pending: String?
  /// A language model answers. Without one ClawdTime tells the state and takes a clear yes or no.
  var modelReady = true
  var connected = true
  var voice = VoiceController.Phase.off
  var notice = ""
  /// The person turned memory on.
  var memory = false
}

private final class ChatFlippedView: NSView { override var isFlipped: Bool { true } }

/// One message. The person's words sit in a bubble on the right; ClawdTime's are plain text on the left.
private final class ChatRowView: NSView {
  init(text: String, mine: Bool, via: String, faded: Bool = false) {
    super.init(frame: .zero)
    let label = Theme.label(text, font: Theme.sans(13.5), lines: 0)
    label.isSelectable = true; label.allowsEditingTextAttributes = false
    label.preferredMaxLayoutWidth = mine ? 262 : 322
    label.alphaValue = faded ? 0.6 : 1
    let bubble = NSView()
    if mine {
      bubble.wantsLayer = true
      bubble.layer?.cornerRadius = 16; bubble.layer?.cornerCurve = .continuous
      bubble.layer?.backgroundColor = Theme.color(.fill).cgColor
    }
    bubble.addSubview(label); addSubview(bubble)
    for view in [label, bubble] as [NSView] { view.translatesAutoresizingMaskIntoConstraints = false }
    let inset: CGFloat = mine ? 12 : 0
    var constraints = [
      label.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: inset), label.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -inset),
      label.topAnchor.constraint(equalTo: bubble.topAnchor, constant: mine ? 8 : 0), label.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: mine ? -8 : 0),
      bubble.topAnchor.constraint(equalTo: topAnchor), bubble.bottomAnchor.constraint(equalTo: bottomAnchor),
      mine ? bubble.trailingAnchor.constraint(equalTo: trailingAnchor) : bubble.leadingAnchor.constraint(equalTo: leadingAnchor),
    ]
    // A small glyph says that the words were spoken, here or on a call.
    if via != "chat", let glyph = Theme.symbol(via == "call" ? "phone.fill" : "waveform", size: 9, weight: .bold) {
      let mark = NSImageView(image: glyph); mark.contentTintColor = Theme.color(.labelSecondary)
      mark.setAccessibilityLabel(via == "call" ? "Said on a call" : "Said aloud")
      addSubview(mark); mark.translatesAutoresizingMaskIntoConstraints = false
      constraints += [mark.centerYAnchor.constraint(equalTo: bubble.centerYAnchor),
        mine ? mark.trailingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: -6) : mark.leadingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: 6)]
    }
    NSLayoutConstraint.activate(constraints)
    setAccessibilityElement(true); setAccessibilityRole(.staticText)
    setAccessibilityLabel((mine ? "You: " : "ClawdTime: ") + text)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    for bubble in subviews where bubble.layer?.cornerRadius == 16 {
      effectiveAppearance.performAsCurrentDrawingAppearance { bubble.layer?.backgroundColor = Theme.color(.fill).cgColor }
    }
  }
}

/// What shows while ClawdTime works on its answer: the breathing dots and a few plain words, so the wait is never a blank.
private final class ThinkingRowView: NSStackView {
  init() {
    super.init(frame: .zero)
    orientation = .horizontal; alignment = .centerY; spacing = 8
    addArrangedSubview(ThinkingDotsView())
    addArrangedSubview(Theme.label("Working on it", font: Theme.sans(12.5), color: .labelSecondary))
    setAccessibilityElement(true); setAccessibilityRole(.staticText); setAccessibilityLabel("ClawdTime is working on its answer")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
}

/// Three dots that breathe while ClawdTime works on its answer.
private final class ThinkingDotsView: NSView {
  private var dots: [CALayer] = []
  override init(frame: NSRect) {
    super.init(frame: NSRect(x: 0, y: 0, width: 34, height: 18))
    wantsLayer = true
    for index in 0..<3 {
      let dot = CALayer(); dot.frame = CGRect(x: CGFloat(index) * 11, y: 6, width: 6, height: 6); dot.cornerRadius = 3
      layer?.addSublayer(dot); dots.append(dot)
    }
    setAccessibilityElement(true); setAccessibilityRole(.staticText); setAccessibilityLabel("ClawdTime is working on its answer")
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override var intrinsicContentSize: NSSize { NSSize(width: 34, height: 18) }
  override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); restart() }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); restart() }
  private func restart() {
    var color = NSColor.gray.cgColor
    effectiveAppearance.performAsCurrentDrawingAppearance { color = Theme.color(.labelSecondary).cgColor }
    for (index, dot) in dots.enumerated() {
      dot.backgroundColor = color; dot.removeAllAnimations(); dot.opacity = 0.75
      guard window != nil, !Theme.reduceMotion else { continue }
      let pulse = CAKeyframeAnimation(keyPath: "opacity"); pulse.values = [0.25, 1, 0.25]; pulse.keyTimes = [0, 0.4, 1]
      let lift = CAKeyframeAnimation(keyPath: "transform.translation.y"); lift.values = [0, 3, 0]; lift.keyTimes = [0, 0.4, 1]
      let group = CAAnimationGroup(); group.animations = [pulse, lift]; group.duration = 1.1; group.repeatCount = .infinity
      group.beginTime = CACurrentMediaTime() + Double(index) * 0.16
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
      dot.add(group, forKey: "think")
    }
  }
}

/// The chat screen: the conversation with ClawdTime, and one field to write to it. It is where the
/// person gives ClawdTime work. It shows no status of the work: a question of the worker shows in its
/// own small window, and Stop is on the bar at the top of the screen during every run.
final class ChatView: NSView, SheetContent {
  static let width: CGFloat = 392
  var onSend: ((String) -> Void)?
  var onTalk: (() -> Void)?
  var onClose: (() -> Void)?
  var onResize: (() -> Void)?
  var maxHeight: CGFloat = 640
  private let headline = Theme.label("Talk to ClawdTime", font: Theme.display(21))
  private let detail = Theme.label("", font: Theme.sans(12.5), color: .labelSecondary, lines: 2)
  private let scroll = NSScrollView()
  private let document = ChatFlippedView()
  private let rows = NSStackView()
  private let ideas = NSStackView()
  private let notice = Theme.label("", font: Theme.sans(12.5), color: .warning, lines: 3)
  let input = ComposerView(placeholder: "Ask, or say what to do", height: 58, compactHeight: 38)
  private var send: IconButton!, talk: IconButton!
  private var scrollHeight: NSLayoutConstraint!
  private var header: NSStackView!
  private let foot = NSStackView()
  private let noticeRow = NSView()
  private var shown: [String] = []
  private var model = ChatModel()
  private static let starters = ["Open my latest X posts and tell me the replies", "Find a USB-C charger on Amazon under 30 dollars", "Read my unread messages in Slack"]
  /// The answers under the last message, as the buttons show them.
  private var choices: [String] = []

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = CGFloat(DesignTokens.radiusSheet); layer?.cornerCurve = .continuous; layer?.masksToBounds = true
    layer?.borderWidth = 1
    let close = IconButton(symbol: "xmark", label: "Close the chat", target: self, action: #selector(closePressed))
    let words = NSStackView(views: [headline, detail]); words.orientation = .vertical; words.alignment = .leading; words.spacing = 2
    words.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let gap = NSView(); gap.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    let header = NSStackView(views: [words, gap, close]); header.orientation = .horizontal; header.alignment = .top; header.distribution = .fill
    self.header = header

    rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 12
    ideas.orientation = .vertical; ideas.alignment = .leading; ideas.spacing = 6
    for (index, starter) in Self.starters.enumerated() {
      let chip = PillButton(starter, kind: .secondary, small: true, target: self, action: #selector(starterPressed(_:)))
      chip.tag = index; ideas.addArrangedSubview(chip)
    }
    let content = NSStackView(views: [ideas, rows]); content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
    content.detachesHiddenViews = true
    document.addSubview(content); content.translatesAutoresizingMaskIntoConstraints = false
    document.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = document; scroll.drawsBackground = false; scroll.hasVerticalScroller = false; scroll.borderType = .noBorder

    send = IconButton(symbol: "arrow.up", label: "Send", diameter: 30, target: self, action: #selector(sendPressed))
    talk = IconButton(symbol: "waveform", label: "Talk to ClawdTime", diameter: 30, target: self, action: #selector(talkPressed))
    let controls = NSStackView(views: [talk, send]); controls.orientation = .horizontal; controls.spacing = 2
    let compose = NSStackView(views: [input, controls]); compose.orientation = .horizontal; compose.alignment = .bottom; compose.spacing = 6
    input.setContentHuggingPriority(.defaultLow, for: .horizontal)

    // The notice and the field stand on the bottom edge. A hidden notice takes no room.
    foot.orientation = .vertical; foot.alignment = .leading; foot.spacing = 8; foot.detachesHiddenViews = true
    // The notice lines up with the headline, six points in from the field's edge.
    noticeRow.addSubview(notice); notice.translatesAutoresizingMaskIntoConstraints = false
    foot.addArrangedSubview(noticeRow); foot.addArrangedSubview(compose)
    for view in [header, scroll, foot] as [NSView] { addSubview(view); view.translatesAutoresizingMaskIntoConstraints = false }
    scrollHeight = scroll.heightAnchor.constraint(equalToConstant: 120)
    let pad = CGFloat(DesignTokens.space5)
    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad), header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      header.topAnchor.constraint(equalTo: topAnchor, constant: 18),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12), scrollHeight,
      document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor), document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
      document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
      content.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: pad), content.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -pad),
      content.topAnchor.constraint(equalTo: document.topAnchor, constant: 2), content.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -6),
      rows.widthAnchor.constraint(equalTo: content.widthAnchor),
      foot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), foot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      foot.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 8),
      compose.widthAnchor.constraint(equalTo: foot.widthAnchor), noticeRow.widthAnchor.constraint(equalTo: foot.widthAnchor),
      notice.leadingAnchor.constraint(equalTo: noticeRow.leadingAnchor, constant: 6), notice.trailingAnchor.constraint(equalTo: noticeRow.trailingAnchor, constant: -8),
      notice.topAnchor.constraint(equalTo: noticeRow.topAnchor), notice.bottomAnchor.constraint(equalTo: noticeRow.bottomAnchor),
    ])
    notice.preferredMaxLayoutWidth = Self.width - 44
    input.onChange = { [weak self] in self?.refreshSend() }
    input.onExpandChange = { [weak self] in self?.onResize?() }
    input.onReturn = { [weak self] in self?.sendPressed() }
    setAccessibilityLabel("Chat with ClawdTime")
    refreshColors(); refreshSend(); render(model)
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); refreshColors() }
  private func refreshColors() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      layer?.backgroundColor = Theme.color(.raised).cgColor
      layer?.borderColor = Theme.color(.borderSubtle).cgColor
    }
  }
  private var canSend: Bool {
    let text = input.string.trimmingCharacters(in: .whitespacesAndNewlines)
    return (1...2000).contains(text.count) && model.pending == nil && model.connected
  }
  private func refreshSend() { send.active = canSend ? .accentText : nil; send.alphaValue = canSend ? 1 : 0.5 }

  /// As tall as the conversation, up to a limit; then the conversation scrolls.
  var fittingHeight: CGFloat {
    layoutSubtreeIfNeeded()
    // Top edge, header, gap, conversation, gap, foot, bottom edge.
    let chrome = 18 + header.fittingSize.height + 12 + 8 + foot.fittingSize.height + 14
    scrollHeight.constant = max(30, min(document.fittingSize.height, maxHeight - chrome))
    return chrome + scrollHeight.constant
  }
  var hasDraft: Bool { !input.string.isEmpty || model.pending != nil || model.voice != .off }
  func focus() { input.focus() }

  func render(_ model: ChatModel) {
    self.model = model
    detail.stringValue = !model.connected ? "Not connected. Nothing is sent."
      : model.voice == .listening ? "Listening. Speak, then stop for a moment."
      : model.voice == .thinking ? "Working on its answer."
      : model.voice == .speaking ? "Speaking."
      : model.modelReady ? "It uses this Mac for you: apps, the web and your accounts. It asks before it pays, deletes or sends for you." + (model.memory ? " Memory is on." : "")
      : "No language model key: it tells the state and takes a clear approve or deny."
    let noticeChanged = notice.stringValue != model.notice
    notice.stringValue = model.notice; noticeRow.isHidden = model.notice.isEmpty
    if noticeChanged { onResize?() }
    var keys = model.messages.suffix(60).map { "\($0.role)|\($0.at)|\($0.via)|\($0.text)|\($0.offered.joined(separator: "\u{1F}"))" }
    // The service writes the person's message down before it answers. Once the transcript holds it, it is not drawn a second time.
    let heldAlready = ChatTranscript.holdsPending(model.messages, pending: model.pending)
    if let pending = model.pending { if !heldAlready { keys.append("pending|" + pending) }; keys.append("thinking") }
    if model.voice == .thinking && model.pending == nil { keys.append("thinking") }
    if keys != shown {
      shown = keys
      for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
      func add(_ view: NSView, fill: Bool) {
        rows.addArrangedSubview(view)
        if fill { view.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true }
      }
      for message in model.messages.suffix(60) { add(ChatRowView(text: message.text, mine: message.mine, via: message.via), fill: true) }
      // The question that ClawdTime just passed on comes with its answers as buttons. One click sends that answer.
      choices = model.pending == nil ? (model.messages.last?.offered ?? []) : []
      if !choices.isEmpty {
        let picks = NSStackView(); picks.orientation = .vertical; picks.alignment = .leading; picks.spacing = 6
        for (index, choice) in choices.enumerated() {
          let shown = choice.count > 44 ? String(choice.prefix(41)) + "..." : choice
          let chip = PillButton(shown, kind: .secondary, small: true, target: self, action: #selector(choicePressed(_:)))
          chip.tag = index; chip.toolTip = choice; chip.setAccessibilityLabel("Answer: " + choice)
          picks.addArrangedSubview(chip)
        }
        add(picks, fill: false)
      }
      if let pending = model.pending, !heldAlready { add(ChatRowView(text: pending, mine: true, via: "chat", faded: true), fill: true) }
      if keys.last == "thinking" { add(ThinkingRowView(), fill: false) }
      ideas.isHidden = !model.messages.isEmpty || model.pending != nil
      onResize?()
      // The newest words are at the bottom, and the view stays there.
      layoutSubtreeIfNeeded()
      document.scroll(NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
    }
    talk.active = model.voice == .off ? nil : .accentText
    talk.toolTip = model.voice == .off ? "Talk to ClawdTime" : "End the conversation"
    refreshSend()
  }

  @objc private func closePressed() { onClose?() }
  @objc private func talkPressed() { onTalk?() }
  @objc private func sendPressed() {
    guard canSend else { return }
    let text = input.string.trimmingCharacters(in: .whitespacesAndNewlines)
    input.string = ""
    onSend?(text)
  }
  @objc private func choicePressed(_ sender: NSControl) {
    guard choices.indices.contains(sender.tag), model.pending == nil, model.connected else { return }
    onSend?(choices[sender.tag])
  }
  @objc private func starterPressed(_ sender: NSControl) {
    guard Self.starters.indices.contains(sender.tag), model.pending == nil, model.connected else { return }
    onSend?(Self.starters[sender.tag])
  }
}
