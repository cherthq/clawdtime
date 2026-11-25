import AppKit
import TaskPanelCore

/// The window of a sheet beside the mascot. It takes the keys only when the person writes in it.
final class SheetWindow: NSPanel {
  var onCancel: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override func cancelOperation(_ sender: Any?) { onCancel?() }
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
  /// Return sends, when this is set. Shift and Return starts a new line.
  var onReturn: (() -> Void)?
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
  func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    guard let onReturn, selector == #selector(NSResponder.insertNewline(_:)) else { return false }
    if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }
    onReturn(); return true
  }
  override func draw(_ dirtyRect: NSRect) {
    let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 10, yRadius: 10)
    Theme.color(.fill).setFill(); shape.fill()
    if window?.firstResponder === text { Theme.color(.accentText).setStroke(); shape.lineWidth = 1.5; shape.stroke() }
  }
}

/// What a sheet shows: a view of one width that knows how tall it wants to be.
protocol SheetContent: NSView {
  static var width: CGFloat { get }
  var maxHeight: CGFloat { get set }
  var fittingHeight: CGFloat { get }
  /// Something is half written: a click elsewhere does not put the sheet away.
  var hasDraft: Bool { get }
  var onResize: (() -> Void)? { get set }
}

/// A sheet's window: it opens out of the mascot with a spring and closes back into it.
/// The chat is the sheet.
final class SheetController<Content: SheetContent>: NSObject {
  let window: SheetWindow
  let view: Content
  private let holder = NSView()
  private var progress = Spring(0, response: MotionToken.surface.response, dampingRatio: MotionToken.surface.dampingRatio)
  private var anchor = CGPoint(x: 1, y: 1)
  private(set) var isOpen = false
  private var petFrame = CGRect.zero
  private var screenFrame = CGRect.zero
  private var outside: Any?
  var onClosed: (() -> Void)?

  init(_ view: Content) {
    self.view = view
    window = SheetWindow(contentRect: NSRect(x: 0, y: 0, width: Content.width, height: 400), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
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
    let size = CGSize(width: Content.width, height: view.fittingHeight)
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
    // A click anywhere else puts the sheet away, unless something is half written.
    if outside == nil {
      outside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
        guard let self, self.isOpen, !self.view.hasDraft else { return }
        let point = NSEvent.mouseLocation
        if !self.window.frame.contains(point) && !self.petFrame.contains(point) { self.close() }
      }
    }
  }
  func close(immediately: Bool = false) {
    guard isOpen || (immediately && window.isVisible) else { return }
    isOpen = false; progress.target = 0
    if immediately { progress.snap(to: 0); window.orderOut(nil); apply() }
    else if Theme.reduceMotion { progress.snap(); apply() }
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
