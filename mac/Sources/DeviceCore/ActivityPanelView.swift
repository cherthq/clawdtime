import AppKit

/// Shared real/fixture view. No network, capture, input dispatch or permission APIs.
public final class ActivityPanelView: NSView {
  public let stop = NSButton(title: "Stop sharing", target: nil, action: nil)
  public let mute = NSButton(title: "Mute", target: nil, action: nil)
  public let pause = NSButton(title: "Request pause", target: nil, action: nil)
  public let end = NSButton(title: "End call", target: nil, action: nil)
  public let details = NSButton(title: "Details", target: nil, action: nil)
  public let setup = NSButton(title: "Setup…", target: nil, action: nil)
  private let identity = NSTextField(wrappingLabelWithString: "")
  private let status = NSTextField(wrappingLabelWithString: "")
  private let summary = NSTextField(wrappingLabelWithString: "")
  private let history = NSTextView()
  private let scroll = NSScrollView()
  public var expanded = false
  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let stack = NSStackView()
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -12),
    ])
    for (field, name) in [(identity, "Agent, chat and selected display"), (status, "Call, delivery and work status"), (summary, "Current activity")] {
      field.font = .systemFont(ofSize: 13)
      field.maximumNumberOfLines = field === status ? 4 : 2
      field.lineBreakMode = .byTruncatingTail
      field.setAccessibilityLabel(name)
      stack.addArrangedSubview(field)
      field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    identity.font = .boldSystemFont(ofSize: 13)
    stop.contentTintColor = .systemRed
    for buttons in [[stop, mute, pause], [end, details, setup]] {
      let row = NSStackView(views: buttons)
      row.orientation = .horizontal; row.spacing = 8
      for button in buttons { button.bezelStyle = .rounded; button.setAccessibilityLabel(button.title) }
      stack.addArrangedSubview(row)
    }
    stop.toolTip = "Immediately stops ClawdTime sharing and input. Native agent tools stop cooperatively."
    pause.toolTip = "Request a cooperative pause; pending until acknowledged."
    history.isEditable = false; history.isSelectable = true
    history.font = .systemFont(ofSize: 13)
    history.textColor = .labelColor; history.backgroundColor = .textBackgroundColor
    history.setAccessibilityLabel("Recent activity and outcome details")
    history.autoresizingMask = [.width]
    history.isVerticallyResizable = true
    history.textContainer?.widthTracksTextView = true
    scroll.documentView = history; scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    stack.addArrangedSubview(scroll)
    scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    scroll.heightAnchor.constraint(equalToConstant: 200).isActive = true
    scroll.isHidden = true
    // Stable key navigation including persistent local Stop.
    stop.nextKeyView = mute; mute.nextKeyView = pause; pause.nextKeyView = end
    end.nextKeyView = details; details.nextKeyView = setup; setup.nextKeyView = history
    history.nextKeyView = stop
  }
  required init?(coder: NSCoder) { fatalError("Not supported") }
  public func update(_ model: PanelPresentation) {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }
    identity.stringValue = model.identity
    identity.toolTip = model.identity
    status.stringValue = model.status
    summary.stringValue = model.currentSummary
    history.string = model.detail
    mute.title = model.muteTitle
    for button in [mute, pause, end] { button.isEnabled = model.controlsEnabled }
    stop.isEnabled = true
    details.title = expanded ? "Collapse" : "Details"
    details.setAccessibilityLabel(expanded ? "Collapse activity details" : "Expand activity details")
    scroll.isHidden = !expanded
  }
  public func scaleText(_ factor: CGFloat) {
    for field in [identity, status, summary] { field.font = .systemFont(ofSize: 13 * factor) }
    identity.font = .boldSystemFont(ofSize: 13 * factor)
    history.font = .systemFont(ofSize: 13 * factor)
    for button in [stop, mute, pause, end, details, setup] {
      button.controlSize = factor > 1 ? .large : .regular
      button.font = .systemFont(ofSize: 13 * factor)
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: ceil(24 * factor)).isActive = true
    }
  }
  /// Moving/resizing the presentation never selects or authorizes a display.
  public static func constrained(_ frame: NSRect, to visible: NSRect) -> NSRect {
    let width = min(frame.width, visible.width), height = min(frame.height, visible.height)
    return NSRect(x: min(max(frame.minX, visible.minX), visible.maxX - width),
      y: min(max(frame.minY, visible.minY), visible.maxY - height), width: width, height: height)
  }
}
