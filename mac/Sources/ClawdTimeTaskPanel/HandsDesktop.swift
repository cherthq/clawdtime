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
    let fullScreenConfirmed: Bool
    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.pid == rhs.pid && CFEqual(lhs.window, rhs.window) && lhs.title == rhs.title && lhs.frame == rhs.frame
        && lhs.windowID == rhs.windowID && lhs.displayID == rhs.displayID && lhs.map == rhs.map && lhs.ordinary == rhs.ordinary && lhs.fullScreen == rhs.fullScreen && lhs.fullScreenConfirmed == rhs.fullScreenConfirmed
    }
  }
  private struct Target: @unchecked Sendable {
    let pid: pid_t
    let window: AXUIElement
    let title: String
    let minimized: Bool
  }
  /// A verified arrival at an app: what was seen, and which app the name stood for.
  struct Arrival {
    let observation: Observation
    let bundleID: String
  }
  private enum WindowSelection {
    case selected(Target)
    case failure(HandError)
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
  /// Zero when the list of displays cannot be read: then nothing that needs one display runs.
  private var activeDisplays: Int {
    var count: UInt32 = 0
    return CGGetActiveDisplayList(0, nil, &count) == .success ? Int(count) : 0
  }
  private var singleDisplay: Bool { activeDisplays == 1 }

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
        fullScreen: value.fullScreen, activeDisplays: singleDisplay ? 1 : 2, transition: transition, fullScreenConfirmed: value.fullScreenConfirmed) else { return nil }
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
  ///
  /// A request has one of two meanings, and "arrived" follows it:
  /// - Only an app is named ("open Chrome"): the app comes forward with the window
  ///   that it chooses. Arrived: that app is in front. See `bringForward`.
  /// - A window title is named: that one window is raised and independently verified.
  ///   Only here can a request be ambiguous, and only here does one display count.
  func activate(url: URL, windowTitle: String?, allowed: () async -> HandError?, observer: HandsObserver,
                pointer: () -> CGPoint) async -> Result<Arrival, HandError> {
    guard enabled else { return .failure(.desktopDisabled) }
    guard windowTitle.map({ HandsTarget.windowTitle($0) != nil }) ?? true,
      let bundleID = Bundle(url: url)?.bundleIdentifier else { return .failure(.refused) }
    if let refusal = DesktopActivationRule.refusal(windowNamed: windowTitle != nil, displays: activeDisplays) { return .failure(refusal) }
    guard let windowTitle else {
      return await bringForward(url: url, bundleID: bundleID, allowed: allowed, observer: observer, pointer: pointer)
    }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard running.count <= 1 else { return .failure(.ambiguousTarget) }
    // If the source is full screen, require the same affirmative AX/geometry
    // evidence as destination verification. Split View is not qualified.
    if let front = NSWorkspace.shared.frontmostApplication {
      let full = await Task.detached { DesktopAX.frontIsFullScreen(pid: front.processIdentifier) }.value
      if full, await surface(transition: true) == nil { return .failure(.unsupportedDesktop) }
    }
    var dispatched = false
    var ready = false
    defer { if !ready { invalidate(); phase(.blocked) } }
    func failure(_ error: HandError) -> Result<Arrival, HandError> { .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched)) }
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
    // A launch may publish its windows later: a cold start takes seconds. Bounded
    // reads only: never launch a second time or choose an arbitrary sibling.
    if dispatched {
      let discoveryDeadline = now + DesktopAppWait.limit
      while true {
        if case .selected = selected { break }
        if case .failure(let error) = selected, error != .targetNotVisible { break }
        guard now < discoveryDeadline else { return failure(.targetNotVisible) }
        if let error = await allowed() { return failure(error) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        selected = await Task.detached { DesktopAX.select(pid: pid, title: windowTitle) }.value
      }
    }
    // A running app that shows no window with this title, or no window at all: a
    // title names one window, so nothing is activated to go and look for it.
    guard case .selected(let target) = selected else {
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
        // The same rule as the worker's: the app in front is the app that the name stood for.
        guard case .success(let seen) = captured, let current = await surface(transition: true), current == matches,
          seen.surfaceEpoch == epoch, DesktopArrival.sameApp(resolved: bundleID, front: seen.app.bundleId),
          DesktopArrival.sameTitle(seen.app.window, windowTitle) else { return failure(.staleObservation) }
        ready = true; phase(.ready)
        return .success(Arrival(observation: seen, bundleID: DesktopArrival.identity(bundleID)))
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  /// A request that names only an app. One open request goes to macOS, as a click on
  /// the app's icon in the Dock does: a running app comes forward with the window that
  /// it chooses, and an app that does not run starts. Arrived means: that app is in
  /// front. How many displays there are, how many windows the app has and where a
  /// window lies do not matter. A person who says "open Chrome" means the app.
  private func bringForward(url: URL, bundleID: String, allowed: () async -> HandError?, observer: HandsObserver,
                            pointer: () -> CGPoint) async -> Result<Arrival, HandError> {
    // Nothing went out yet: this is a refusal with its own reason.
    if let error = await allowed() { return .failure(error) }
    var ready = false
    // Old coordinates are retired before the app comes forward.
    invalidate(); phase(.switching)
    defer { if !ready { invalidate(); phase(.blocked) } }
    // The request is out from here. What fails after it is unknown, never a refusal:
    // Stop, a takeover or a lost right in the middle, and an app that never came forward.
    let unknown: Result<Arrival, HandError> = .failure(DesktopEffectOutcome.failure(.targetNotVisible, dispatched: true))
    let wait = DesktopAppWait(at: now)
    let options = NSWorkspace.OpenConfiguration()
    options.activates = true
    // What macOS answers is not the evidence. The app in front is.
    NSWorkspace.shared.openApplication(at: url, configuration: options) { _, _ in }
    phase(.waiting)
    while true {
      if await allowed() != nil { return unknown }
      let inFront = DesktopArrival.sameApp(resolved: bundleID, front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
      switch wait.sample(inFront: inFront, at: now) {
      case .expired: return unknown
      case .waiting: break
      case .inFront:
        // The picture and the tree are the evidence for the worker. The same app is in
        // front before and after they are taken.
        let read = await observer.observe(image: true, elements: true, accessibility: true, pointer: pointer())
        if await allowed() != nil { return unknown }
        if case .success(let seen) = read, DesktopArrival.sameApp(resolved: bundleID, front: seen.app.bundleId),
          DesktopArrival.sameApp(resolved: bundleID, front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier) {
          // This result permits no input. The worker looks again before it acts.
          invalidate()
          ready = true; phase(.ready)
          let arrived = Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app, elements: seen.elements,
            image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: epoch)
          return .success(Arrival(observation: arrived, bundleID: DesktopArrival.identity(bundleID)))
        }
        if wait.over(at: now) { return unknown }
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  /// The OS chooses its most recently used app. We never guess that app from
  /// our own desktop history or cycle the switcher until something looks right.
  func switchPreviousApp(send: (() async -> HandError?) async -> Result<Void, HandError>,
                         allowed: @escaping () async -> HandError?, observer: HandsObserver,
                         pointer: () -> CGPoint) async -> Result<Observation?, HandError> {
    guard enabled else { return .failure(.desktopDisabled) }
    // No other app to go back to: the keys would change nothing. Refuse before
    // anything is sent, so that this never ends as an unknown result.
    let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
      .map { Int($0.processIdentifier) }
    guard DesktopAppSwitch.hasPrevious(regular: regular, front: NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) },
      own: Int(getpid())) else { return .failure(.notFound) }
    guard singleDisplay else { return .failure(.unsupportedDesktop) }
    if let error = await allowed() { return .failure(error) }
    let beforeEpoch = epoch
    guard let origin = await surface(transition: true), beforeEpoch == epoch else { return .failure(.unsupportedDesktop) }
    let initialEnvironment = environmentChanges, initialSpaces = spaceChanges
    let began = now
    var dispatched = false, ready = false
    history.invalidate(); lease.invalidate(); switching = true; phase(.switching)
    defer { switching = false; if !ready { invalidate(); phase(.blocked) } }
    func failure(_ error: HandError) -> Result<Observation?, HandError> {
      .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched))
    }
    let dispatchEpoch = epoch
    switch await send({ [self] in
      if let error = await allowed() { return error }
      guard dispatchEpoch == epoch, environmentChanges == initialEnvironment, spaceChanges == initialSpaces,
        await surface(transition: true) == origin, dispatchEpoch == epoch else { return .staleObservation }
      return nil
    }) {
    case .failure(let error): return failure(error)
    case .success: dispatched = true
    }
    phase(.waiting)
    var settling = AppSwitchSettlement<Surface>(originPID: Int(origin.pid), at: began)
    while true {
      if let error = await allowed() { return failure(error) }
      guard singleDisplay, environmentChanges == initialEnvironment, spaceChanges - initialSpaces <= 1 else { return failure(.unsupportedDesktop) }
      let sampleEpoch = epoch
      let candidate = await surface(transition: true)
      let stable = candidate.flatMap { value -> Surface? in
        sampleEpoch == epoch && value.displayID == origin.displayID && value.map == origin.map ? value : nil
      }
      switch settling.sample(stable, pid: stable.map { Int($0.pid) }, epoch: epoch, at: now) {
      case .expired: return failure(.targetNotVisible)
      case .waiting: break
      case .ready:
        if let error = await allowed() { return failure(error) }
        let captured = await observe(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironment, spaceChanges - initialSpaces <= 1,
          case .success(let seen) = captured, let current = await surface(transition: true), current == stable,
          current.pid != origin.pid, seen.surfaceEpoch == epoch, now - began < 5 else { return failure(.staleObservation) }
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
    guard let origin = await surface(transition: true), beforeEpoch == epoch else {
      // No window is in front. A desktop with no window at all can still be left; the arrival is then a window.
      // The desktop of before has no name here, so "previous" stays unavailable.
      guard beforeEpoch == epoch, requested != .previous, let display = HandsDisplay.main,
        await surface(transition: true) == nil, DesktopAX.noOrdinaryWindow(display: display.id) else { return .failure(.unsupportedDesktop) }
      return await leaveEmptyDesktop(direction: requested, display: display, configuration: configuration, send: send,
        allowed: allowed, observer: observer, pointer: pointer)
    }
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
      // No window was read, and the window server lists none: that is the look of a desktop with no window.
      let empty = candidate == nil && sampleEpoch == epoch && DesktopAX.noOrdinaryWindow(display: origin.displayID)
      let decision = settlement.sample(stableCandidate, empty: empty, spaceChanges: spaceChanges - initialSpaceChanges, epoch: epoch, at: now)
      if settlement.arrivedEmpty {
        // One Space change, and for a second no window anywhere on the display: the desktop of arrival is empty.
        // It is observed as it is. An observation with no window gives no lease for input.
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1 else { return failure(.staleObservation) }
        let captured = await observe(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        // The observation of a desktop with no window retires the lease once itself: one more environment change.
        guard now - began < 6, environmentChanges == initialEnvironmentChanges + 1, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured, await surface(transition: true) == nil, DesktopAX.noOrdinaryWindow(display: origin.displayID),
          seen.surfaceEpoch == epoch else { return failure(.staleObservation) }
        ready = true; phase(.ready)
        return .success(seen)
      }
      switch decision {
      case .expired:
        // The whole wait showed the surface of before and no Space change: the desktop
        // did not move. That is known, so it is said as it is and not as unknown.
        if settlement.notMoved, spaceChanges == initialSpaceChanges, environmentChanges == initialEnvironmentChanges {
          return .failure(.desktopUnchanged)
        }
        return failure(.targetNotVisible)
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

  /// One desktop left or right from a desktop with no window. Nothing names the desktop of before, so the
  /// evidence is on the side of the arrival: exactly one Space change, and then a window that holds, by the
  /// same rule as for every arrival. Two empty desktops look the same: such a move stays unknown.
  private func leaveEmptyDesktop(direction: DesktopDirection, display: HandsDisplay, configuration: () -> DesktopShortcutPair?,
                                 send: (DesktopResolvedShortcut, () async -> HandError?) async -> Result<Void, HandError>,
                                 allowed: @escaping () async -> HandError?, observer: HandsObserver,
                                 pointer: () -> CGPoint) async -> Result<Observation?, HandError> {
    guard let pair = configuration(), let shortcut = pair.shortcut(for: direction) else { return .failure(.desktopShortcutUnavailable) }
    if let error = await allowed() { return .failure(error) }
    guard configuration() == pair else { return .failure(.desktopShortcutUnavailable) }
    let initialSpaceChanges = spaceChanges, initialEnvironmentChanges = environmentChanges
    let began = now
    var dispatched = false, ready = false
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
        await surface(transition: true) == nil, DesktopAX.noOrdinaryWindow(display: display.id), dispatchEpoch == epoch else { return .staleObservation }
      return nil
    }) {
    case .failure(let error): return failure(error)
    case .success: dispatched = true
    }
    phase(.waiting)
    var settlement = DesktopSettlement<Surface>(at: began)
    var stayedEmpty = true, looks = 0
    while true {
      if let error = await allowed() { return failure(error) }
      guard environmentChanges == initialEnvironmentChanges, singleDisplay else { return failure(.unsupportedDesktop) }
      let changes = spaceChanges - initialSpaceChanges
      guard changes <= 1 else { return failure(.targetNotVisible) }
      let sampleEpoch = epoch
      let candidate = await surface(transition: true)
      let stableCandidate = candidate.flatMap { value -> Surface? in
        guard sampleEpoch == epoch, value.displayID == display.id, value.map == display.map else { return nil }
        return value
      }
      looks += 1
      if changes != 0 || candidate != nil || !DesktopAX.noOrdinaryWindow(display: display.id) { stayedEmpty = false }
      // A window counts as the arrival only after the one Space change.
      switch settlement.sample(changes == 1 ? stableCandidate : nil, at: now) {
      case .expired:
        // The whole wait showed the empty desktop and no Space change: it did not move. That is known.
        if stayedEmpty, looks >= 3, spaceChanges == initialSpaceChanges, environmentChanges == initialEnvironmentChanges {
          return .failure(.desktopUnchanged)
        }
        return failure(.targetNotVisible)
      case .waiting: break
      case .ready:
        if let error = await allowed() { return failure(error) }
        let captured = await observe(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured, let target = await surface(transition: true), target == stableCandidate,
          seen.surfaceEpoch == epoch, now - began < 5 else { return failure(.staleObservation) }
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
      // A full-display frame without affirmative AXFullScreen remains unqualified.
      // Explicit full-screen support also requires the sole-display geometry gate.
      (value(window, "AXFullScreen") as? Bool) == true || frame(window) == CGDisplayBounds(CGMainDisplayID())
    }
    static func frontIsFullScreen(pid: pid_t) -> Bool {
      guard let window = element(value(app(pid), kAXFocusedWindowAttribute)) else { return false }
      return fullScreen(window)
    }
    /// The one standard window of the app that has this title. Only a request that
    /// names a window comes here, so only such a request can be ambiguous.
    static func select(pid: pid_t, title: String) -> WindowSelection {
      guard let windows = value(app(pid), kAXWindowsAttribute) as? [AXUIElement] else { return .failure(.targetNotVisible) }
      guard windows.count <= 32 else { return .failure(.ambiguousTarget) }
      let deadline = ProcessInfo.processInfo.systemUptime + 2
      var ordinary: [AXUIElement] = [], titles: [String?] = []
      for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else { return .failure(.targetNotVisible) }
        AXUIElementSetMessagingTimeout(window, 0.15)
        guard (value(window, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole else { continue }
        ordinary.append(window); titles.append(value(window, kAXTitleAttribute) as? String)
      }
      let window: AXUIElement
      switch DesktopWindowChoice.index(titled: title, among: titles) {
      case .failure(let error): return .failure(error)
      case .success(let index): window = ordinary[index]
      }
      AXUIElementSetMessagingTimeout(window, 0.15)
      guard let bounds = frame(window), DesktopSurfaceScope.permits(window: bounds,
        display: CGDisplayBounds(CGMainDisplayID()), ordinary: true, fullScreen: fullScreen(window),
        activeDisplays: 1, transition: true, fullScreenConfirmed: (value(window, "AXFullScreen") as? Bool) == true)
        else { return .failure(.unsupportedDesktop) }
      guard let minimized = value(window, kAXMinimizedAttribute) as? Bool,
        let title = value(window, kAXTitleAttribute) as? String else { return .failure(.targetNotVisible) }
      return .selected(Target(pid: pid, window: window, title: title, minimized: minimized))
    }
    /// True when the window server lists no ordinary window on this display: a desktop with no window.
    /// The panel's own windows, the Dock, the menu bar and what lies on the desktop itself do not count.
    /// False when the list cannot be read: nothing is said of a desktop that was not seen.
    static func noOrdinaryWindow(display: CGDirectDisplayID) -> Bool {
      guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
      let bounds = CGDisplayBounds(display)
      return !windows.contains { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0, (row[kCGWindowOwnerPID as String] as? Int) != Int(getpid()) else { return false }
        // A row with no frame cannot be placed: it counts as a window, so the desktop is not called empty.
        guard let raw = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return true }
        return !bounds.intersection(frame).isEmpty
      }
    }
    static func visibleSurface(pid: pid_t, display: HandsDisplay) -> Surface? {
      let app = app(pid)
      guard let focused = element(value(app, kAXFocusedWindowAttribute)) else { return nil }
      // A sheet hangs from a window and takes the focus: "Do you want to save?". It has no title and no
      // minimized state of its own. Without it as a surface, no button of a sheet could ever be pressed.
      let sheet = (value(focused, kAXRoleAttribute) as? String) == "AXSheet"
      let minimized = value(focused, kAXMinimizedAttribute) as? Bool
      guard sheet ? minimized != true : minimized == false,
        let title = sheet ? ((value(focused, kAXTitleAttribute) as? String) ?? "") : (value(focused, kAXTitleAttribute) as? String),
        let bounds = frame(focused),
        !CGDisplayBounds(display.id).intersection(bounds).isEmpty,
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
      let ordinary = windows.filter { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0, (row[kCGWindowOwnerPID as String] as? Int) != Int(getpid()),
          let raw = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return false }
        return !CGDisplayBounds(display.id).intersection(frame).isEmpty
      }
      let evidence = ordinary.compactMap { row -> DesktopWindowEvidence? in
        guard let owner = row[kCGWindowOwnerPID as String] as? Int, let id = row[kCGWindowNumber as String] as? Int,
          let raw = row[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return .init(id: id, pid: owner, title: row[kCGWindowName as String] as? String, frame: bounds)
      }
      // Dropping an incomplete leading row must not expose the window behind it.
      guard evidence.count == ordinary.count else { return nil }
      let confirmed = (value(focused, "AXFullScreen") as? Bool) == true
      // Only the auxiliary-strip case needs an additional AX window inventory.
      // Ordinary focused windows avoid extra off-Space reads and their latency.
      var frames: [CGRect]?
      if confirmed, evidence.first?.frame != bounds {
        let axWindows = value(app, kAXWindowsAttribute) as? [AXUIElement]
        frames = axWindows.flatMap { windows in
          guard windows.count <= 32 else { return nil }
          let frames = windows.compactMap(frame)
          return frames.count == windows.count ? frames : nil
        }
      }
      guard let windowID = DesktopWindowVisibility.focusedWindowID(pid: Int(pid), title: title, frame: bounds,
        fullScreenConfirmed: confirmed, display: CGDisplayBounds(display.id), visible: evidence, accessibleFrames: frames,
        sheet: sheet) else { return nil }
      return Surface(pid: pid, window: focused, title: title, frame: bounds, windowID: windowID, displayID: display.id, map: display.map,
        ordinary: (value(focused, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole,
        fullScreen: fullScreen(focused), fullScreenConfirmed: confirmed)
    }
  }
}
