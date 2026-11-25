import AppKit
import TaskPanelCore

/// Approve and No work without taking the keyboard from the app in front.
private final class AskWindow: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// The card of one question: who asks, the question, Approve and No.
final class ExecutionAskView: NSView {
  static let width: CGFloat = 340
  var onApprove: (() -> Void)?
  var onNo: (() -> Void)?
  private let title = Theme.label("ClawdTime asks you", font: Theme.sans(12.5, weight: 600), color: .labelSecondary)
  private let question = Theme.label("", font: Theme.sans(14, weight: 500), lines: 8)
  private var approve: PillButton!
  private var no: PillButton!
  private let stack = NSStackView()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = 20; layer?.cornerCurve = .continuous; layer?.masksToBounds = true
    layer?.borderWidth = 1
    approve = PillButton("Approve", kind: .accent, small: true, target: self, action: #selector(approvePressed))
    no = PillButton("No", kind: .secondary, small: true, target: self, action: #selector(noPressed))
    let buttons = NSStackView(views: [approve, no]); buttons.orientation = .horizontal; buttons.spacing = 8
    question.preferredMaxLayoutWidth = Self.width - 36
    for view in [title, question, buttons] as [NSView] { stack.addArrangedSubview(view) }
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
    stack.setCustomSpacing(14, after: question)
    addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 16),
      question.widthAnchor.constraint(equalTo: stack.widthAnchor),
    ])
    setAccessibilityElement(true); setAccessibilityRole(.group); setAccessibilityLabel("ClawdTime asks you")
    refreshColors()
  }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); refreshColors() }
  private func refreshColors() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      layer?.backgroundColor = Theme.color(.raised).cgColor
      layer?.borderColor = Theme.color(.borderSubtle).cgColor
    }
  }
  /// Shows one question. The buttons work only when an answer can go now.
  func show(_ text: String, enabled: Bool) {
    question.stringValue = text; question.toolTip = text
    question.setAccessibilityLabel(text)
    approve.isEnabled = enabled; no.isEnabled = enabled
    approve.setAccessibilityLabel("Approve: " + text); no.setAccessibilityLabel("No: " + text)
  }
  /// As tall as the question, with the edge below the buttons.
  var fittingHeight: CGFloat { layoutSubtreeIfNeeded(); return ceil(16 + stack.fittingSize.height + 16) }
  @objc private func approvePressed() { onApprove?() }
  @objc private func noPressed() { onNo?() }
}

/// The small window beside the mascot. It shows only while a question of the worker waits for the
/// person, with Approve and No, and it hides at once when none waits. It says nothing else about
/// the work. Stop is on the bar at the top of the screen during every run, so it is not here.
@MainActor final class ExecutionAskPanel {
  /// The key of the question that was in view, and whether the person approved.
  var onAnswer: ((String, Bool) -> Void)?
  private let window: AskWindow
  let view = ExecutionAskView(frame: NSRect(x: 0, y: 0, width: ExecutionAskView.width, height: 160))
  private var shownKey: String?
  private var enabled = false

  init() {
    window = AskWindow(contentRect: NSRect(x: 0, y: 0, width: ExecutionAskView.width, height: 160),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
    window.level = .floating; window.isFloatingPanel = true; window.becomesKeyOnlyIfNeeded = true
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = true
    window.animationBehavior = .none
    window.contentView = view
    window.setAccessibilityLabel("ClawdTime asks you")
    view.onApprove = { [weak self] in self?.answer(true) }
    view.onNo = { [weak self] in self?.answer(false) }
  }
  var isShown: Bool { window.isVisible }
  /// `ask` nil: nothing waits, and the window goes at once.
  func render(_ ask: ExecutionAsk?, canAnswer: Bool, pet: CGRect, screen: CGRect) {
    guard let ask else { shownKey = nil; enabled = false; if window.isVisible { window.orderOut(nil) }; return }
    shownKey = ask.key; enabled = canAnswer
    view.show(ask.text, enabled: canAnswer)
    place(pet: pet, screen: screen)
    // Never activate the app or ask for key or main status here.
    if !window.isVisible { window.orderFrontRegardless() }
  }
  /// Follows the mascot when the person moves it.
  func place(pet: CGRect, screen: CGRect) {
    guard shownKey != nil else { return }
    let size = CGSize(width: ExecutionAskView.width, height: view.fittingHeight)
    let frame = PetLayout.panel(size: size, pet: pet, in: screen).frame
    if window.frame != frame { window.setFrame(frame, display: true) }
  }
  private func answer(_ approve: Bool) {
    guard enabled, let shownKey else { return }
    // One answer for this question. The next read says what came of it.
    enabled = false
    onAnswer?(shownKey, approve)
  }
}
