import AppKit
import ApplicationServices
import TaskPanelCore

/// Foreground desktop work through public AppKit, Accessibility and Quartz APIs.
/// No Space IDs, private CGS calls, Dock preference mutation or shortcut cycling.
@MainActor final class HandsDesktop {
  struct Surface: Equatable, @unchecked Sendable {
    let pid: pid_t
    let window: AXUIElement
    let title: String
    let frame: CGRect
    let windowID: Int
    let displayID: CGDirectDisplayID
    let map: ScreenMap
    let ordinary: Bool
    let fullScreen: Bool
    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.pid == rhs.pid && CFEqual(lhs.window, rhs.window) && lhs.title == rhs.title && lhs.frame == rhs.frame
        && lhs.windowID == rhs.windowID && lhs.displayID == rhs.displayID && lhs.map == rhs.map && lhs.ordinary == rhs.ordinary && lhs.fullScreen == rhs.fullScreen
    }
  }
  private struct Target: @unchecked Sendable {
    let pid: pid_t
    let window: AXUIElement
    let title: String
    let minimized: Bool
  }
  private var lease = DesktopObservationLease<Surface>()
  private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
  private var inputSurface: Surface?
  private var inputEpoch: Int?
  private var history = DesktopSwitchHistory<Surface>()
  private var switching = false
  private var spaceChanges = 0
  private var environmentChanges = 0
  /// Bridge this to presentation only. Consumers must discard old targets on
  /// switching/waiting/blocked; ready still requires their own fresh geometry.
  var onTransition: ((DesktopTransitionPhase, Int) -> Void)?
  var epoch: Int { lease.epoch }
  var enabled: Bool { ProcessInfo.processInfo.environment["CLAWDTIME_DESKTOP_SWITCHING"] != "off" }

  init() {
    let workspace = NSWorkspace.shared.notificationCenter
    tokens.append((workspace, workspace.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.spaceChanges += 1
        self.lease.invalidate()
        if !self.switching { self.history.invalidate() }
      }
    }))
    tokens.append((workspace, workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      // App focus (including the panel opening/closing its chat) is not a Space
      // address. Invalidate input now; previous also verifies its exact source.
      MainActor.assumeIsolated { self?.lease.invalidate() }
    }))
    for name in [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.screensDidSleepNotification] {
      tokens.append((workspace, workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.invalidate() }
      }))
    }
    let center = NotificationCenter.default
    tokens.append((center, center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.invalidate() }
    }))
  }
  deinit { for (center, token) in tokens { center.removeObserver(token) } }
  func invalidate() { lease.invalidate(); history.invalidate(); environmentChanges += 1 }
  /// Idle/run completion consumes input evidence but retains a verified previous
  /// desktop in this panel session. External Space/session/display changes do not.
  func retireObservation() { lease.consume(); inputSurface = nil; inputEpoch = nil }
  private func phase(_ value: DesktopTransitionPhase) { onTransition?(value, epoch) }
  private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
  private var singleDisplay: Bool {
    var count: UInt32 = 0
    return CGGetActiveDisplayList(0, nil, &count) == .success && count == 1
  }

  /// A focused AX window must agree with the top ordinary Quartz window on the
  /// current display. A front-app name alone, or an off-Space AX tree, is insufficient.
  func surface(transition: Bool = false) async -> Surface? {
    guard let display = HandsDisplay.main,
      let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { return nil }
    let pid = app.processIdentifier
    let value = await Task.detached(priority: .userInitiated) {
      DesktopAX.visibleSurface(pid: pid, display: display)
    }.value
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, let value,
      DesktopSurfaceScope.permits(window: value.frame, display: CGDisplayBounds(display.id), ordinary: value.ordinary,
        fullScreen: value.fullScreen, activeDisplays: singleDisplay ? 1 : 2, transition: transition) else { return nil }
    return value
  }

  /// Screenshot and AX evidence bracketed by independently checked window identity.
  /// An observation can still describe a desktop with no usable window, but grants
  /// no input lease in that case (open_app remains available).
  func observe(observer: HandsObserver, image: Bool, elements: Bool, accessibility: Bool, pointer: CGPoint) async -> Result<Observation, HandError> {
    let beforeEpoch = epoch
    let before = accessibility ? await surface() : nil
    let read = await observer.observe(image: image, elements: elements, accessibility: accessibility, pointer: pointer)
    let after = accessibility ? await surface() : nil
    guard beforeEpoch == epoch, before == after else { invalidate(); return .failure(.staleObservation) }
    guard case .success(let seen) = read else { invalidate(); return read }
    if let after {
      let previousEpoch = epoch
      lease.record(after, at: now)
      if epoch != previousEpoch { history.invalidate() }
    }
    else { invalidate() }
    return .success(Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app,
      elements: seen.elements, image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: epoch))
  }

  /// Called after the guided cursor, before any physical pointer/keyboard event.
  func beginInput() async -> Bool {
    let expected = epoch
    let current = await surface()
    guard expected == epoch, lease.permits(current, at: now) else { invalidate(); return false }
    inputSurface = current; inputEpoch = epoch
    return true
  }
  /// Cheap event-loop guard between await points; geometry is checked again just
  /// before a click/key and periodically during typing.
  var inputGenerationCurrent: Bool { inputSurface != nil && inputEpoch == epoch }
  func inputStillCurrent() async -> Bool {
    guard inputGenerationCurrent, let expected = inputSurface else { return false }
    let current = await surface()
    guard inputGenerationCurrent, current == expected else { invalidate(); return false }
    return true
  }
  func endInput() { inputSurface = nil; inputEpoch = nil; lease.consume() }

  /// One activation attempt. Every effect is preceded by the controller's Stop,
  /// takeover, permission and session checks. Once anything is dispatched, failure
  /// is unknown even if the OS returned false or Stop interrupted the wait.
  func activate(url: URL, windowTitle: String?, allowed: () async -> HandError?, observer: HandsObserver,
                pointer: () -> CGPoint) async -> Result<Observation?, HandError> {
    guard enabled else { return .failure(.desktopDisabled) }
    guard singleDisplay else { return .failure(.unsupportedDesktop) }
    guard windowTitle.map({ HandsTarget.windowTitle($0) != nil }) ?? true,
      let bundleID = Bundle(url: url)?.bundleIdentifier else { return .failure(.refused) }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard running.count <= 1 else { return .failure(.ambiguousTarget) }
    // Never switch away from a known full-screen source in this first qualification scope.
    if let front = NSWorkspace.shared.frontmostApplication {
      let full = await Task.detached { DesktopAX.frontIsFullScreen(pid: front.processIdentifier) }.value
      if full { return .failure(.unsupportedDesktop) }
    }
    var dispatched = false
    var ready = false
    defer { if !ready { invalidate(); phase(.blocked) } }
    func failure(_ error: HandError) -> Result<Observation?, HandError> { .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched)) }
    var app: NSRunningApplication
    if let found = running.first { app = found }
    else {
      if let error = await allowed() { return failure(error) }
      invalidate(); phase(.switching); dispatched = true
      let options = NSWorkspace.OpenConfiguration()
      options.activates = false
      do { app = try await NSWorkspace.shared.openApplication(at: url, configuration: options) }
      catch { return failure(.failed) }
    }
    guard app.bundleIdentifier == bundleID, !app.isTerminated else { return failure(.notFound) }
    let pid = app.processIdentifier
    var selected = await Task.detached { DesktopAX.select(pid: pid, title: windowTitle) }.value
    // A newly launched app may publish its first window a little later. Only read;
    // never launch it a second time or replay an activation to compensate.
    if dispatched {
      for _ in 0..<6 {
        if case .success = selected { break }
        if case .failure(.targetNotVisible) = selected {} else { break }
        if let error = await allowed() { return failure(error) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        selected = await Task.detached { DesktopAX.select(pid: pid, title: windowTitle) }.value
      }
    }
    guard case .success(let target) = selected else {
      if case .failure(let error) = selected { return failure(error) }
      return failure(.targetNotVisible)
    }
    if let error = await allowed() { return failure(error) }
    guard singleDisplay else { return failure(.unsupportedDesktop) }
    invalidate(); phase(.switching)
    // A minimized target is explicitly restored once, never replaced by a sibling.
    if target.minimized {
      dispatched = true
      let restored = await Task.detached { AXUIElementSetAttributeValue(target.window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success }.value
      guard restored else { return failure(.failed) }
      if let error = await allowed() { return failure(error) }
    }
    // Prefer the exact main window before activating the application. Otherwise
    // macOS may choose an unrelated sibling window on a different Space.
    let settable = await Task.detached { () -> Bool in
      var result = DarwinBoolean(false)
      return AXUIElementIsAttributeSettable(target.window, kAXMainAttribute as CFString, &result) == .success && result.boolValue
    }.value
    if settable {
      if let error = await allowed() { return failure(error) }
      dispatched = true
      let selectedMain = await Task.detached { AXUIElementSetAttributeValue(target.window, kAXMainAttribute as CFString, kCFBooleanTrue) == .success }.value
      guard selectedMain else { return failure(.failed) }
    }
    if let error = await allowed() { return failure(error) }
    dispatched = true
    // Raise exactly the selected AX object, never all of the application's windows.
    let raised = await Task.detached { AXUIElementPerformAction(target.window, kAXRaiseAction as CFString) == .success }.value
    guard raised else { return failure(.failed) }
    if let error = await allowed() { return failure(error) }
    _ = app.activate(options: [])
    phase(.waiting)
    var settlement = DesktopSettlement<Surface>(at: now)
    var settlementEpoch = epoch
    while true {
      if let error = await allowed() { return failure(error) }
      guard singleDisplay else { return failure(.unsupportedDesktop) }
      let startEpoch = epoch
      if settlementEpoch != startEpoch { _ = settlement.sample(nil, at: now); settlementEpoch = startEpoch }
      let observed = await surface(transition: true)
      let matches = observed.flatMap { value -> Surface? in
        value.pid == target.pid && CFEqual(value.window, target.window) && value.title == target.title && startEpoch == epoch ? value : nil
      }
      switch settlement.sample(matches, at: now) {
      case .expired: return failure(.targetNotVisible)
      case .waiting: break
      case .ready:
        if let error = await allowed() { return failure(error) }
        let captured = await observe(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard case .success(let seen) = captured, let current = await surface(transition: true), current == matches,
          seen.surfaceEpoch == epoch else { return failure(.staleObservation) }
        ready = true; phase(.ready)
        return .success(seen)
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  /// Explicit adjacent move, never an implicit retry of failed app activation.
  /// An operator-attested enabled shortcut is sent once; a Space notification
  /// and changed stable native surface independently witness arrival.
  func switchDesktop(direction requested: DesktopDirection, configuration: () -> DesktopShortcutPair?,
                     send: (DesktopResolvedShortcut, () async -> HandError?) async -> Result<Void, HandError>,
                     allowed: @escaping () async -> HandError?, observer: HandsObserver,
                     pointer: () -> CGPoint) async -> Result<Observation?, HandError> {
    guard enabled else { return .failure(.desktopDisabled) }
    guard singleDisplay else { return .failure(.unsupportedDesktop) }
    if let error = await allowed() { return .failure(error) }
    let beforeEpoch = epoch
    guard let origin = await surface(transition: true), beforeEpoch == epoch else { return .failure(.unsupportedDesktop) }
    let direction: DesktopDirection
    let expected: Surface?
    if requested == .previous {
      guard let previous = history.previous(from: origin) else { return .failure(.desktopHistoryUnavailable) }
      direction = previous.direction; expected = previous.target
    } else { direction = requested; expected = nil }
    guard let pair = configuration(), let shortcut = pair.shortcut(for: direction) else { return .failure(.desktopShortcutUnavailable) }
    if let error = await allowed() { return .failure(error) }
    guard beforeEpoch == epoch, await surface(transition: true) == origin, beforeEpoch == epoch else { return .failure(.staleObservation) }
    guard configuration() == pair else { return .failure(.desktopShortcutUnavailable) }
    let initialSpaceChanges = spaceChanges, initialEnvironmentChanges = environmentChanges
    let began = now
    var dispatched = false, ready = false
    // History is retired before the attempt. Nothing restores it on failure.
    history.invalidate(); lease.invalidate(); switching = true; phase(.switching)
    defer {
      switching = false
      if !ready { invalidate(); phase(.blocked) }
    }
    func failure(_ error: HandError) -> Result<Observation?, HandError> {
      .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched))
    }
    let dispatchEpoch = epoch
    switch await send(shortcut, { [self] in
      if let error = await allowed() { return error }
      guard dispatchEpoch == epoch, spaceChanges == initialSpaceChanges, environmentChanges == initialEnvironmentChanges,
        await surface(transition: true) == origin, dispatchEpoch == epoch else { return .staleObservation }
      return nil
    }) {
    case .failure(let error): return failure(error)
    case .success: dispatched = true
    }
    phase(.waiting)
    var settlement = DesktopSwitchSettlement(origin: origin, expected: expected, at: began)
    while true {
      if let error = await allowed() { return failure(error) }
      guard environmentChanges == initialEnvironmentChanges, singleDisplay else { return failure(.unsupportedDesktop) }
      let changes = spaceChanges - initialSpaceChanges
      guard changes <= 1 else { return failure(.targetNotVisible) }
      let sampleEpoch = epoch
      let candidate = await surface(transition: true)
      let stableCandidate = candidate.flatMap { value -> Surface? in
        guard sampleEpoch == epoch, value.displayID == origin.displayID, value.map == origin.map else { return nil }
        return value
      }
      switch settlement.sample(stableCandidate, spaceChanges: spaceChanges - initialSpaceChanges, epoch: epoch, at: now) {
      case .expired: return failure(.targetNotVisible)
      case .waiting: break
      case .ready:
        if let error = await allowed() { return failure(error) }
        let captured = await observe(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured, let target = await surface(transition: true), target == stableCandidate,
          seen.surfaceEpoch == epoch, now - began < 5 else { return failure(.staleObservation) }
        history.verified(direction, from: origin, to: target)
        ready = true; phase(.ready)
        return .success(seen)
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  private enum DesktopAX {
    static func value(_ node: AXUIElement, _ attribute: String) -> CFTypeRef? {
      AXUIElementSetMessagingTimeout(node, 0.1)
      var value: CFTypeRef?
      guard AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success else { return nil }
      return value
    }
    static func element(_ value: CFTypeRef?) -> AXUIElement? {
      guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
      return (value as! AXUIElement)
    }
    static func app(_ pid: pid_t) -> AXUIElement {
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.15)
      return app
    }
    static func frame(_ window: AXUIElement) -> CGRect? {
      guard let p = value(window, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
        let s = value(window, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
      var point = CGPoint.zero, size = CGSize.zero
      guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
        point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
      return CGRect(origin: point, size: size)
    }
    static func fullScreen(_ window: AXUIElement) -> Bool {
      // AXFullScreen is a defensive optional observation, not a public Space
      // classifier. Missing it does not qualify full-screen support. Full-display
      // geometry is also excluded; physical full-screen acceptance is pending.
      (value(window, "AXFullScreen") as? Bool) == true || frame(window) == CGDisplayBounds(CGMainDisplayID())
    }
    static func frontIsFullScreen(pid: pid_t) -> Bool {
      guard let window = element(value(app(pid), kAXFocusedWindowAttribute)) else { return false }
      return fullScreen(window)
    }
    static func select(pid: pid_t, title: String?) -> Result<Target, HandError> {
      guard let windows = value(app(pid), kAXWindowsAttribute) as? [AXUIElement] else { return .failure(.targetNotVisible) }
      guard windows.count <= 32 else { return .failure(.ambiguousTarget) }
      let deadline = ProcessInfo.processInfo.systemUptime + 2
      var ordinary: [AXUIElement] = []
      for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else { return .failure(.targetNotVisible) }
        AXUIElementSetMessagingTimeout(window, 0.15)
        if (value(window, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole,
          title == nil || (value(window, kAXTitleAttribute) as? String) == title { ordinary.append(window) }
      }
      let candidates = ordinary
      guard candidates.count <= 1 else { return .failure(.ambiguousTarget) }
      guard let window = candidates.first else { return .failure(.targetNotVisible) }
      AXUIElementSetMessagingTimeout(window, 0.15)
      guard !fullScreen(window), let bounds = frame(window), CGDisplayBounds(CGMainDisplayID()).contains(bounds) else { return .failure(.unsupportedDesktop) }
      guard let minimized = value(window, kAXMinimizedAttribute) as? Bool,
        let title = value(window, kAXTitleAttribute) as? String else { return .failure(.targetNotVisible) }
      return .success(Target(pid: pid, window: window, title: title, minimized: minimized))
    }
    static func visibleSurface(pid: pid_t, display: HandsDisplay) -> Surface? {
      let app = app(pid)
      guard let focused = element(value(app, kAXFocusedWindowAttribute)),
        (value(focused, kAXMinimizedAttribute) as? Bool) == false,
        let title = value(focused, kAXTitleAttribute) as? String, let bounds = frame(focused),
        !CGDisplayBounds(display.id).intersection(bounds).isEmpty,
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
      let ordinary = windows.filter { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0, (row[kCGWindowOwnerPID as String] as? Int) != Int(getpid()),
          let raw = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return false }
        return !CGDisplayBounds(display.id).intersection(frame).isEmpty
      }
      func matching(_ row: [String: Any]) -> Bool {
        guard (row[kCGWindowOwnerPID as String] as? Int) == Int(pid), (row[kCGWindowName as String] as? String) == title,
          let raw = row[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: raw) else { return false }
        return abs(frame.minX - bounds.minX) <= 1 && abs(frame.minY - bounds.minY) <= 1 && abs(frame.width - bounds.width) <= 1 && abs(frame.height - bounds.height) <= 1
      }
      guard let first = ordinary.first, matching(first), ordinary.filter(matching).count == 1,
        let windowID = first[kCGWindowNumber as String] as? Int else { return nil }
      return Surface(pid: pid, window: focused, title: title, frame: bounds, windowID: windowID, displayID: display.id, map: display.map,
        ordinary: (value(focused, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole, fullScreen: fullScreen(focused))
    }
  }
}
