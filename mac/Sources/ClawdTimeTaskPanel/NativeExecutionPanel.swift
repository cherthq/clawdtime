import AppKit
import TaskPanelCore

/// Buttons work without taking the target application's keyboard focus.
private final class NativeExecutionWindow: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
private final class NativeActionText: NSTextView {
  override var acceptsFirstResponder: Bool { false }
}

@MainActor final class NativeExecutionPanel {
  var onDecision: ((String, Bool) -> Void)?
  var onStop: (() -> Void)?
  private let window: NativeExecutionWindow
  private let status = Theme.label("", font: Theme.sans(12), color: .labelSecondary, lines: 3)
  private let actionText = NativeActionText()
  private let scroll = NSScrollView()
  private let decisions = NSStackView()
  private var approve: PillButton!
  private var deny: PillButton!
  private var stop: PillButton!
  private var actionId: String?
  private var decisionEnabled = false
  private var stopEnabled = false

  init() {
    window = NativeExecutionWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 240),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
    window.level = .floating; window.isFloatingPanel = true; window.becomesKeyOnlyIfNeeded = true
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = true
    window.isMovableByWindowBackground = true
    let surface = GlassSurface(radius: 18)
    window.contentView = surface
    let title = Theme.label("ClawdTime · computer work", font: Theme.sans(14, weight: 600))
    stop = PillButton("Stop work", kind: .danger, small: true, symbol: "stop.fill", target: self, action: #selector(stopPressed))
    stop.toolTip = "Request a stop. An action already underway may finish."
    approve = PillButton("Approve action", kind: .primary, small: true, target: self, action: #selector(approvePressed))
    deny = PillButton("Deny action", kind: .secondary, small: true, target: self, action: #selector(denyPressed))
    decisions.orientation = .horizontal; decisions.spacing = 8
    decisions.addArrangedSubview(approve); decisions.addArrangedSubview(deny)
    actionText.isEditable = false; actionText.isSelectable = false
    actionText.drawsBackground = false; actionText.font = Theme.sans(13)
    actionText.textColor = Theme.color(.label); actionText.textContainerInset = .zero
    actionText.isVerticallyResizable = true; actionText.isHorizontallyResizable = false
    actionText.textContainer?.widthTracksTextView = true
    actionText.autoresizingMask = [.width]
    scroll.documentView = actionText; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
    let stack = NSStackView(views: [title, status, scroll, decisions, stop])
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10; stack.detachesHiddenViews = true
    surface.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: surface.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: surface.bottomAnchor, constant: -16),
      status.widthAnchor.constraint(equalTo: stack.widthAnchor),
      scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), scroll.heightAnchor.constraint(equalToConstant: 120),
    ])
    status.preferredMaxLayoutWidth = 328
    window.setAccessibilityLabel("ClawdTime native work approvals")
  }
  func render(_ model: ChatModel, submissionPending: Bool, pet: CGRect, screen: CGRect) {
    guard NativeExecutionPresentation.visible(model.execution, submissionPending: submissionPending, stopping: model.executionStopping) else {
      window.orderOut(nil); actionId = nil; return
    }
    let pending = model.execution?.pendingAction
    actionId = pending?.id
    decisionEnabled = model.connected && model.executionCanDecide
    stopEnabled = model.connected && model.executionCanStop
    status.stringValue = model.executionNotice ?? (submissionPending && model.execution?.canStop != true ? "Preparing your request. Your other app keeps keyboard focus." : model.execution?.message ?? "")
    actionText.string = pending?.description ?? ""
    actionText.setAccessibilityLabel(pending?.description ?? "No pending action")
    actionText.frame = NSRect(x: 0, y: 0, width: 328, height: 120)
    actionText.sizeToFit()
    scroll.isHidden = pending == nil; decisions.isHidden = pending == nil
    approve.isEnabled = decisionEnabled; deny.isEnabled = decisionEnabled; stop.isEnabled = stopEnabled
    let height: CGFloat = pending == nil ? 140 : 300
    let placement = PetLayout.panel(size: CGSize(width: 360, height: height), pet: pet, in: screen)
    window.setFrame(placement.frame, display: true)
    // Never activate the app or ask for key/main status here.
    if !window.isVisible { window.orderFrontRegardless() }
  }
  @objc private func approvePressed() { decide(true) }
  @objc private func denyPressed() { decide(false) }
  private func decide(_ approve: Bool) {
    guard decisionEnabled, let actionId else { return }
    onDecision?(actionId, approve)
  }
  @objc private func stopPressed() { if stopEnabled { onStop?() } }
}
