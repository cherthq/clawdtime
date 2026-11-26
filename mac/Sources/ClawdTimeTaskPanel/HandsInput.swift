import AppKit
import ApplicationServices
import Carbon.HIToolbox
import TaskPanelCore

/// The listening tap hands every event to the input object that made it. It
/// only listens: it never changes or holds an event.
private func handsTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  let input = refcon.map { Unmanaged<HandsInput>.fromOpaque($0).takeUnretainedValue() }
  // The tap's source is on the main run loop, so this is the main thread.
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    // macOS switched the tap off. This notice carries no event: nothing of it is read.
    if let input { MainActor.assumeIsolated { input.listenAgain() } }
    return nil
  }
  if let input {
    let mark = event.getIntegerValueField(.eventSourceUserData)
    let isKey = type == .keyDown || type == .keyUp
    let keyCode = isKey ? event.getIntegerValueField(.keyboardEventKeycode) : -1
    let repeated = isKey && event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    MainActor.assumeIsolated { input.saw(type, mark: mark, keyCode: keyCode, repeated: repeated) }
  }
  return Unmanaged.passUnretained(event)
}

/// The input half of the hands: pointer and keyboard events through Core
/// Graphics, each one marked as ClawdTime's own, and a listening tap that tells
/// the person's input from them. Nothing here asks macOS for a right.
@MainActor final class HandsInput {
  /// The mark on every event that the hands send.
  static let mark: Int64 = 0x436C_6177_6454
  private let source: CGEventSource?
  /// Stop was pressed: nothing more is sent, and a held button is let go.
  var halted = false
  /// Rechecked between event-loop waits; never suppresses a necessary button/key release.
  var mayContinue: (() -> Bool)?
  /// Recheck the independently observed window after pointer travel and before input.
  var beforeInput: (() async -> Bool)?
  /// Read at once, with no wait between it and the event, right before each press of a button and each turn of
  /// the wheel. True: a window of ClawdTime that takes clicks lies at the place, in screen points from the top left.
  /// Nothing goes there.
  var ownWindowAt: ((CGPoint) -> Bool)?
  /// Read the same way right before each key and each piece of typed text. True: the keys would go to ClawdTime.
  var ownKeyboard: (() -> Bool)?
  private func ownPointer(_ place: CGPoint) -> Bool { ownWindowAt?(place) ?? false }
  private var keyboardIsOwn: Bool { ownKeyboard?() ?? false }
  private var interrupted: Bool { halted || personActed || mayContinue?() == false }
  private func allowed() async -> Bool {
    guard !interrupted else { return false }
    let permitted = await beforeInput?() ?? true
    return permitted && !interrupted
  }
  /// The person moved the mouse or pressed a key since the command began.
  private(set) var personActed = false
  /// Any meaningful input already submitted may have affected the UI.
  private(set) var submittedInput = false
  /// The person held Escape for a moment.
  var onEscapeHold: (() -> Void)?
  private var tap: CFMachPort?
  private var tapSource: CFRunLoopSource?
  private var escapeDown: Date?
  private var watchTried: Date?
  /// Where a drag holds the button down now.
  private var held: CGPoint?

  init() {
    source = CGEventSource(stateID: .combinedSessionState)
    source?.userData = Self.mark
    // The person's own mouse and keys are never held back after an event of the hands.
    source?.localEventsSuppressionInterval = 0
  }

  /// Where the pointer is, in screen points from the top left of the main display.
  var pointer: CGPoint { CGEvent(source: nil)?.location ?? .zero }
  /// A password field has the keyboard: macOS guards it, and the hands stay out.
  var secureInput: Bool { IsSecureEventInputEnabled() }
  /// A command begins: what the person did before it does not count.
  func beginCommand() { personActed = false; submittedInput = false }

  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }
  private func post(_ event: CGEvent?, flags: CGEventFlags = []) {
    guard let event else { return }
    // Only the modifiers that the command names: a key that the person holds does not join in.
    if [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .scrollWheel].contains(event.type) { submittedInput = true }
    event.flags = flags
    event.setIntegerValueField(.eventSourceUserData, value: Self.mark)
    event.post(tap: .cghidEventTap)
  }
  private func mouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left, clicks: Int64 = 0) {
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    if clicks > 0 { event?.setIntegerValueField(.mouseEventClickState, value: clicks) }
    post(event)
  }

  // MARK: pointer

  /// Moves the real pointer of the Mac along a short, slightly curved way, as a hand does, so that the person
  /// sees it travel. Its events carry the mark, so the watch never reads them as the person's. False when Stop cut it.
  @discardableResult func move(to target: CGPoint) async -> Bool {
    let from = pointer
    let length = hypot(Double(target.x - from.x), Double(target.y - from.y))
    guard length.isFinite else { return false }
    if length < GuidedPath.inPlace {
      if interrupted { return false }
      if length > 0.5 { mouse(.mouseMoved, at: target) }
      return !interrupted
    }
    let path = GuidedPath(from: from, to: target, duration: GuidedPath.moveDuration(length: length), arc: GuidedPath.moveArc)
    for point in path.points(every: 1.0 / 120) {
      if interrupted { return false }
      mouse(.mouseMoved, at: point)
      await pause(1.0 / 120)
    }
    return !interrupted
  }
  /// One click or a double click, left or right. False when Stop came before the press.
  func click(at point: CGPoint, button: HandCommand.Button, count: Int) async -> Bool {
    guard await move(to: point) else { return false }
    await pause(0.015)
    guard await allowed() else { return false }
    let right = button == .right
    for press in 1...max(1, min(2, count)) {
      if interrupted { return false }
      if press > 1 { guard await allowed() else { return false } }
      // After the last wait and the last check of the service: a window of ClawdTime that came up at the place,
      // such as a request with Approve on it, gets no press.
      if interrupted || ownPointer(point) { return false }
      // A button that went down always comes up: nothing between the two can stop.
      mouse(right ? .rightMouseDown : .leftMouseDown, at: point, button: right ? .right : .left, clicks: Int64(press))
      await pause(0.012)
      mouse(right ? .rightMouseUp : .leftMouseUp, at: point, button: right ? .right : .left, clicks: Int64(press))
      if press < count { await pause(0.045) }
    }
    return true
  }
  /// Presses at one place, moves to another and lets go. False when Stop cut it;
  /// the button is let go where the pointer then is.
  func drag(from: CGPoint, to: CGPoint) async -> Bool {
    guard await move(to: from) else { return false }
    await pause(0.02)
    if interrupted { return false }
    guard await allowed() else { return false }
    // Neither the place of the press nor the place of the drop lies under a window of ClawdTime.
    if interrupted || ownPointer(from) || ownPointer(to) { return false }
    mouse(.leftMouseDown, at: from, clicks: 1)
    held = from
    // An app starts a drag only after the button stays down for a moment.
    await pause(0.05)
    let length = hypot(Double(to.x - from.x), Double(to.y - from.y))
    let path = GuidedPath(from: from, to: to, duration: GuidedPath.dragDuration(length: length), arc: 0)
    var cut = false
    for point in path.points(every: 1.0 / 60) {
      if interrupted || held == nil { break }
      // A window of ClawdTime that came up on the way ends the drag where it is: the button comes up there, and
      // the drag did not finish.
      if ownPointer(point) { cut = true; break }
      mouse(.leftMouseDragged, at: point)
      held = point
      await pause(1.0 / 60)
    }
    await pause(0.025)
    let finished = !cut && !interrupted && held != nil
    letGo()
    return finished
  }
  /// Lets go of a button that a drag holds, where the pointer is. A button that
  /// went down always comes up: after Stop, and when ClawdTime quits in the middle.
  func letGo() {
    guard let place = held else { return }
    held = nil
    mouse(.leftMouseUp, at: place, clicks: 1)
  }
  /// Turns the wheel over one place. False when Stop cut it.
  func scroll(at point: CGPoint, dx: Double, dy: Double) async -> Bool {
    guard await move(to: point) else { return false }
    for (index, tick) in ScrollPlan.ticks(dx: dx, dy: dy).enumerated() {
      if index % 2 == 0 {
        guard await allowed() else { return false }
      }
      if interrupted || ownPointer(point) { return false }
      let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: tick.vertical, wheel2: tick.horizontal, wheel3: 0)
      event?.location = point
      post(event)
      await pause(0.008)
    }
    return true
  }

  // MARK: keyboard

  private func press(_ code: UInt16, flags: CGEventFlags = []) async {
    post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), flags: flags)
    await pause(0.01)
    post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false), flags: flags)
  }
  /// How typing ended: all of it went, Stop cut it, or the keyboard moved to a place where the hands do not type.
  enum Typed { case done, stopped, refused }
  /// Types text as Unicode, so every script goes whatever the keyboard layout
  /// is. A line break is the Return key. The caller checks the place of the
  /// keyboard before the first character. `allowed` asks again when that place
  /// can have changed: after a Return or a Tab, and every few characters.
  func type(_ text: String, allowed: () async -> Bool) async -> Typed {
    let steps = TypingPlan.steps(text, perStep: 8)
    var unchecked = 0
    for (index, step) in steps.enumerated() {
      if interrupted { return .stopped }
      if unchecked >= 40 {
        guard await allowed() else { return .refused }
        unchecked = 0
      }
      // After the last check: the keyboard did not move to a window of ClawdTime, such as its chat.
      if keyboardIsOwn { return .refused }
      switch step {
      case .text(let piece):
        let units = Array(piece.utf16)
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
          post(event)
        }
        unchecked += piece.count
      case .key(let code):
        await press(code)
        if index < steps.count - 1 {
          // The key can move the keyboard to another field, for example from a name to a password. The app gets a moment to do it.
          await pause(0.05)
          guard await allowed() else { return .refused }
          unchecked = 0
        }
      }
      await pause(0.004)
    }
    return .done
  }
  /// One key with its modifiers. False when Stop came first.
  func key(_ combo: KeyCombo) async -> Bool {
    if interrupted { return false }
    guard await allowed(), keyIsPermitted(combo) else { return false }
    // After the last check of the service: the keyboard is still outside ClawdTime.
    if interrupted || keyboardIsOwn { return false }
    // The combo names a character. On a keyboard of another country that
    // character is on another key, so the key is found on the layout in use.
    let code = combo.character.flatMap(Self.keyCode(printing:)) ?? combo.keyCode
    await press(code, flags: CGEventFlags(rawValue: combo.flags))
    return true
  }
  /// Inventory is read immediately before dispatch, on the main thread as
  /// Carbon requires. Only Mission Control, Space and Desktop switching hotkeys
  /// are reserved so system shortcuts such as Spotlight and Screenshot remain permitted.
  func keyIsPermitted(_ combo: KeyCombo) -> Bool {
    let code = combo.character.flatMap(Self.keyCode(printing:)) ?? combo.keyCode
    let reserved = DesktopShortcuts.reservedHotKeys(
      appleSymbolicHotKeys: Self.appleSymbolicHotKeys(),
      enabled: Self.enabledHotKeys(),
      configuredPair: desktopShortcuts())
    return DesktopShortcuts.permits(combo, resolvedCode: code, configured: reserved)
  }
  private static func appleSymbolicHotKeys() -> [String: Any]? {
    let domain = "com.apple.symbolichotkeys" as CFString
    CFPreferencesAppSynchronize(domain)
    return CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, domain) as? [String: Any]
  }
  private static func enabledHotKeys() -> [DesktopHotKey]? {
    var array: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&array) == noErr, let raw = array?.takeRetainedValue() as? [[String: Any]] else { return nil }
    var parsed: [DesktopHotKey] = []
    for item in raw {
      guard let enabled = item[kHISymbolicHotKeyEnabled as String] as? Bool else { return nil }
      if !enabled { continue }
      guard let key = item[kHISymbolicHotKeyCode as String] as? UInt16,
        let modifiers = item[kHISymbolicHotKeyModifiers as String] as? UInt64 else { return nil }
      parsed.append(DesktopHotKey(code: key, carbonModifiers: modifiers))
    }
    return parsed
  }
  /// No defaults: the operator must attest both configured actions. Layout
  /// resolution and public enabled-shortcut inventory are checked independently.
  func desktopShortcuts() -> DesktopShortcutPair? {
    Self.configuredDesktopShortcuts(environment: ProcessInfo.processInfo.environment)
  }
  /// Shared with the read-only access check without constructing an input source.
  static func configuredDesktopShortcuts(environment: [String: String]) -> DesktopShortcutPair? {
    let left = environment["CLAWDTIME_SPACE_LEFT_SHORTCUT"].flatMap(KeyCombo.parse)
    let right = environment["CLAWDTIME_SPACE_RIGHT_SHORTCUT"].flatMap(KeyCombo.parse)
    func code(_ combo: KeyCombo?) -> UInt16? {
      guard let combo else { return nil }
      if let character = combo.character { return Self.keyCode(printing: character) }
      // A synthesized plus assumes a US layout; do not attest that assumption.
      if combo.printing && combo.keyCode != 49 { return nil }
      return combo.keyCode
    }
    return DesktopShortcutConfiguration.validate(left: left, right: right, leftCode: code(left), rightCode: code(right), enabled: enabledHotKeys())
  }
  /// Sole bypass of the generic reserved-hotkey guard. The desktop coordinator
  /// owns qualification and sends exactly one pair; key-up always releases it.
  func dispatchDesktopShortcut(_ shortcut: DesktopResolvedShortcut, allowed: () async -> HandError?) async -> Result<Void, HandError> {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: shortcut.code, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: shortcut.code, keyDown: false) else { return .failure(.failed) }
    if let refusal = await allowed() { return .failure(refusal) }
    guard !halted, !Task.isCancelled else { return .failure(.stoppedByPerson) }
    guard watching, !personActed else { return .failure(.refused) }
    guard AXIsProcessTrusted() else { return .failure(.noAccessibility) }
    guard CGPreflightScreenCaptureAccess() else { return .failure(.noScreenRecording) }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      session[kCGSessionOnConsoleKey as String] as? Bool == true, session["CGSSessionScreenIsLocked"] as? Bool != true else { return .failure(.refused) }
    guard DesktopShortcutConfiguration.isEnabled(shortcut, in: Self.enabledHotKeys()) else { return .failure(.desktopShortcutUnavailable) }
    guard !keyboardIsOwn else { return .failure(.refused) }
    post(down, flags: CGEventFlags(rawValue: shortcut.flags))
    await pause(0.02)
    post(up, flags: CGEventFlags(rawValue: shortcut.flags))
    return .success(())
  }

  /// A dedicated one-shot app switch, never a generic-key escape from navigation
  /// verification. Releasing Tab and Command completes the selection.
  func dispatchPreviousApp(allowed: () async -> HandError?) async -> Result<Void, HandError> {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: false),
      let release = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: false) else { return .failure(.failed) }
    if let refusal = await allowed() { return .failure(refusal) }
    guard !halted, !Task.isCancelled else { return .failure(.stoppedByPerson) }
    guard watching, !personActed else { return .failure(.refused) }
    guard AXIsProcessTrusted() else { return .failure(.noAccessibility) }
    guard CGPreflightScreenCaptureAccess() else { return .failure(.noScreenRecording) }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      session[kCGSessionOnConsoleKey as String] as? Bool == true, session["CGSSessionScreenIsLocked"] as? Bool != true else { return .failure(.refused) }
    guard !keyboardIsOwn else { return .failure(.refused) }
    post(down, flags: .maskCommand)
    // Once down was submitted, always release both keys, including on Stop.
    await pause(0.02)
    post(up, flags: .maskCommand)
    post(release, flags: [])
    return .success(())
  }

  /// The key that prints `character` with no modifier on the keyboard layout in use.
  private static func keyCode(printing character: String) -> UInt16? {
    guard let layout = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let property = TISGetInputSourceProperty(layout, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
    return data.withUnsafeBytes { bytes -> UInt16? in
      guard let table = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for code in UInt16(0)..<128 {
        var dead: UInt32 = 0, length = 0
        var printed = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(table, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
          OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, printed.count, &length, &printed)
        if status == noErr, length > 0, String(utf16CodeUnits: printed, count: length) == character { return code }
      }
      return nil
    }
  }

  // MARK: the person's own input

  /// True while the tap listens.
  var watching: Bool { tap != nil }
  /// Starts to listen for the person's mouse and keys. The Accessibility right
  /// covers a listening tap. With no right nothing is made, so no prompt shows.
  func watch() {
    // The run asks for this many times a second. The right is read every two seconds at most.
    guard tap == nil, watchTried.map({ Date().timeIntervalSince($0) > 2 }) ?? true else { return }
    watchTried = Date()
    guard AXIsProcessTrusted() else { return }
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged,
                                .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
    let mask = kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    guard let made = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
                                       callback: handsTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return }
    let loop = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, made, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), loop, .commonModes)
    CGEvent.tapEnable(tap: made, enable: true)
    tap = made; tapSource = loop
  }
  func unwatch() {
    guard let tap else { return }
    CGEvent.tapEnable(tap: tap, enable: false)
    if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
    CFMachPortInvalidate(tap)
    self.tap = nil; tapSource = nil; escapeDown = nil; watchTried = nil
  }
  fileprivate func listenAgain() { if let tap { CGEvent.tapEnable(tap: tap, enable: true) } }
  fileprivate func saw(_ type: CGEventType, mark: Int64, keyCode: Int64, repeated: Bool) {
    // An event with the mark is the hands' own.
    guard mark != Self.mark else { return }
    personActed = true
    guard keyCode == Int64(KeyCombo.escapeKey) else { return }
    if type == .keyUp { escapeDown = nil; return }
    guard type == .keyDown, !repeated else { return }
    let pressed = Date()
    escapeDown = pressed
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      // Still the same press, and the key itself is still down: this is Stop.
      guard let self, self.escapeDown == pressed, CGEventSource.keyState(.hidSystemState, key: KeyCombo.escapeKey) else { return }
      self.escapeDown = nil
      self.onEscapeHold?()
    }
  }
}
