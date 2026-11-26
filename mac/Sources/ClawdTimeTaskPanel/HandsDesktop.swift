import AppKit
import ApplicationServices
import OSLog
import TaskPanelCore

/// Foreground desktop work through public AppKit, Accessibility and Quartz APIs.
/// No Space IDs, private CGS calls, Dock preference mutation or shortcut cycling.
@MainActor final class HandsDesktop {
  private static let transitionLog = Logger(subsystem: "com.clawdtime.task-panel", category: "desktop-transition")
  @MainActor private final class SwitchTrace {
    var samples = DesktopSwitchSamples<NavigationSurface>()
    var dispatched = false
    var compositeSource = false
    var compositeArrival = false
    var nativeFailure: HandError?
    var lastSurfaceReason = "not_sampled"
    var lastSurfaceRefusal = "none"
    var spaceBaseline: Int
    var environmentBaseline: Int
    var environmentAtResult: Int?
    init(spaces: Int, environment: Int) { spaceBaseline = spaces; environmentBaseline = environment }
    func surfaceReason(_ reason: String) {
      lastSurfaceReason = reason
      if reason != "source_ready" && reason != "directional_composition_ready" { lastSurfaceRefusal = reason }
    }
  }
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
    /// Windows of the same app that a person can see in front of this one, top first: a list of suggestions,
    /// a card. They are no part of what makes two surfaces equal: the window is the same one with them or without.
    var covers: [DesktopCover] = []
    /// How many windows of the same app lie in front at all, seen or not, and the ones that show nothing.
    var front = 0
    var unseen: [DesktopUnseen] = []
    /// What one look holds on to: the window, and the windows in front of it as they were.
    struct Look: Equatable { let surface: Surface; let covers: [DesktopCover] }
    var look: Look { Look(surface: self, covers: covers) }
    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.pid == rhs.pid && CFEqual(lhs.window, rhs.window) && DesktopArrival.sameLiveTitle(lhs.title, rhs.title) && lhs.frame == rhs.frame
        && lhs.windowID == rhs.windowID && lhs.displayID == rhs.displayID && lhs.map == rhs.map && lhs.ordinary == rhs.ordinary && lhs.fullScreen == rhs.fullScreen && lhs.fullScreenConfirmed == rhs.fullScreenConfirmed
    }
  }
  /// Directional-only evidence. A composite is never recorded in the input lease.
  private enum NavigationSurface: Equatable, @unchecked Sendable {
    case strict(Surface)
    case composite(Surface, DesktopDirectionalGroup)
    var parent: Surface { switch self { case .strict(let value), .composite(let value, _): return value } }
    var composite: Bool { if case .composite = self { return true }; return false }
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
  /// The lease holds the window with the windows in front of it. A list that opened, closed or changed its size
  /// after the look retires the look, so no click and no single key goes out on another picture.
  private var lease = DesktopObservationLease<Surface.Look>()
  /// For a click, a drag, a scroll or one key: the windows in front as they were when the input began, the
  /// ones that show nothing among them, and the places of a pointing command.
  private var inputFront: (covers: [DesktopCover], unseen: [DesktopUnseen])?
  private var inputPlaces: [CGPoint] = []
  private var inputAllowCover = false
  private var inputObservedCovers: [DesktopCover] = []
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
        // Another desktop: every old coordinate is retired, also in the worker.
        self.lease.retire()
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
        MainActor.assumeIsolated { self?.retire() }
      }))
    }
    let center = NotificationCenter.default
    tokens.append((center, center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.retire() }
    }))
  }
  deinit { for (center, token) in tokens { center.removeObserver(token) } }
  func invalidate() { lease.invalidate(); history.invalidate(); environmentChanges += 1 }
  /// The desktop or the display changed, the session went away, or the hands move to another app or desktop.
  /// Only this changes the epoch that observations carry to the worker (`surfaceEpoch`).
  private func retire() { lease.retire(); history.invalidate(); environmentChanges += 1 }
  /// The epoch of every observation: it changes with the desktop or the display, never with a window of the app in front.
  var surfaceEpoch: Int { lease.surfaceEpoch }
  /// Idle/run completion consumes input evidence but retains a verified previous
  /// desktop in this panel session. External Space/session/display changes do not.
  func retireObservation() { lease.consume(); inputSurface = nil; inputEpoch = nil; inputFront = nil; inputPlaces = []; inputAllowCover = false; inputObservedCovers = [] }
  private func phase(_ value: DesktopTransitionPhase) { onTransition?(value, epoch) }
  private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
  /// Zero when the list of displays cannot be read: then nothing that needs one display runs.
  private var activeDisplays: Int {
    var count: UInt32 = 0
    return CGGetActiveDisplayList(0, nil, &count) == .success ? Int(count) : 0
  }
  private var singleDisplay: Bool { activeDisplays == 1 }

  /// Read-only preflight using the same AX/Quartz matcher as real transitions.
  /// No controller, observers, lease, capture or input source is constructed.
  static func sourceDiagnostics() -> PanelDesktopSnapshot {
    var report = PanelDesktopSnapshot()
    var count: UInt32 = 0
    let counted = CGGetActiveDisplayList(0, nil, &count) == .success
    report.activeDisplays = counted ? Int(count) : 0
    report.checks["displayInventoryAvailable"] = counted
    report.checks["accessibility"] = AXIsProcessTrusted()
    report.checks["screenRecording"] = CGPreflightScreenCaptureAccess()
    guard report.checks["accessibility"] == true else { report.reason = "accessibility_unavailable"; return report }
    guard let display = HandsDisplay.main else { report.reason = "main_display_unavailable"; return report }
    guard let app = NSWorkspace.shared.frontmostApplication else { report.reason = "front_app_unavailable"; return report }
    let pid = app.processIdentifier
    report.checks["frontAppIsProbe"] = pid == getpid()
    report.checks["frontAppSameBundleAsProbe"] = app.bundleIdentifier != nil && app.bundleIdentifier == Bundle.main.bundleIdentifier
    guard pid != getpid() else { report.reason = "front_app_is_probe"; return report }
    // The facts of a move to another app or desktop come from the strict rule that a move uses.
    let surface = DesktopAX.visibleSurface(pid: pid, display: display, covers: false,
      diagnostic: { report.reason = $0 }, fact: { report.checks[$0] = $1 })
    // The hands' input has one rule more: small windows of the app may lie in front of its window.
    let input = DesktopAX.visibleSurface(pid: pid, display: display, covers: true, diagnostic: { _ in },
      fact: { name, value in if name.hasPrefix("ownWindows") { report.checks[name] = value } })
    report.checks["inputSurfaceReady"] = input != nil
    report.checks["frontAppUnchanged"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    guard report.checks["frontAppUnchanged"] == true else { report.reason = "front_app_changed"; return report }
    guard let surface else {
      report.checks["noOrdinaryWindow"] = DesktopAX.noOrdinaryWindow(display: display.id)
      report.checks["directionalCompositionEligible"] = report.activeDisplays == 1 &&
        DesktopAX.directionalSurface(pid: pid, display: display, diagnostic: { report.directionalReason = $0 },
          fact: { report.checks[$0] = $1 }, count: { report.counts[$0] = $1 }) != nil &&
        NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
      return report
    }
    report.checks["ordinaryWindow"] = surface.ordinary
    report.checks["fullScreen"] = surface.fullScreen
    report.checks["fullScreenConfirmed"] = surface.fullScreenConfirmed
    report.checks["containedInMainDisplay"] = CGDisplayBounds(display.id).contains(surface.frame)
    report.checks["fullScreenGeometry"] = DesktopSurfaceScope.fullScreenGeometry(window: surface.frame, display: CGDisplayBounds(display.id))
    let permitted = DesktopSurfaceScope.permits(window: surface.frame, display: CGDisplayBounds(display.id), ordinary: surface.ordinary,
      fullScreen: surface.fullScreen, activeDisplays: report.activeDisplays, transition: true, fullScreenConfirmed: surface.fullScreenConfirmed)
    report.checks["transitionSourcePermitted"] = permitted
    report.reason = permitted ? "source_ready" : !counted || count != 1 ? "display_scope" : !surface.ordinary ? "window_not_ordinary" :
      report.checks["containedInMainDisplay"] != true ? "window_outside_main_display" : "fullscreen_scope"
    return report
  }

  /// A focused AX window must agree with an ordinary Quartz window on the current
  /// display. A front-app name alone, or an off-Space AX tree, is insufficient.
  /// For a transition that window must be the top one. For the hands' input, small
  /// windows of the same app may lie in front of it: `DesktopWindowVisibility.focusedWindow`.
  func surface(transition: Bool = false, diagnostic: ((String) -> Void)? = nil) async -> Surface? {
    guard let display = HandsDisplay.main,
      let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { diagnostic?("front_app_or_display_unavailable"); return nil }
    let pid = app.processIdentifier
    let read = await Task.detached(priority: .userInitiated) {
      var reason = "ax_quartz_unavailable"
      // A move to another app or desktop starts only from a focused window with nothing of its app in front,
      // as before. Only the hands' input has the rule for small windows in front.
      let surface = DesktopAX.visibleSurface(pid: pid, display: display, covers: !transition, diagnostic: { reason = $0 })
      return (surface, reason)
    }.value
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { diagnostic?("front_app_changed"); return nil }
    guard let value = read.0 else { diagnostic?(read.1); return nil }
    guard DesktopSurfaceScope.permits(window: value.frame, display: CGDisplayBounds(display.id), ordinary: value.ordinary,
      fullScreen: value.fullScreen, activeDisplays: singleDisplay ? 1 : 2, transition: transition, fullScreenConfirmed: value.fullScreenConfirmed)
      else { diagnostic?("source_scope_unavailable"); return nil }
    diagnostic?("source_ready")
    return value
  }

  /// Separate reader for a requested left/right move; strict app/input matching stays unchanged.
  private func navigationSurface(allowComposite: Bool, trace: SwitchTrace) async -> NavigationSurface? {
    if let strict = await surface(transition: true, diagnostic: { trace.surfaceReason($0) }) { return .strict(strict) }
    guard allowComposite, singleDisplay, let display = HandsDisplay.main,
      let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { return nil }
    let pid = app.processIdentifier
    let read = await Task.detached(priority: .userInitiated) {
      var reason = "directional_composition_unavailable"
      let value = DesktopAX.directionalSurface(pid: pid, display: display, diagnostic: { reason = $0 })
      return (value, reason)
    }.value
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, singleDisplay else {
      trace.surfaceReason("front_app_or_display_changed"); return nil
    }
    trace.surfaceReason(read.1)
    return read.0
  }

  /// A composite source is fixed before waiting; a replacement never becomes the new source.
  private func settleNavigationSource(_ expected: NavigationSurface, allowed: () async -> HandError?, trace: SwitchTrace) async -> HandError? {
    let began = now, initialEpoch = epoch, initialSpaces = spaceChanges, initialEnvironment = environmentChanges
    var settling = DesktopSettlement<NavigationSurface>(at: began)
    while true {
      if let error = await allowed() { return error }
      guard singleDisplay, epoch == initialEpoch, spaceChanges == initialSpaces, environmentChanges == initialEnvironment else { return .staleObservation }
      let current = await navigationSurface(allowComposite: true, trace: trace)
      if let error = await allowed() { return error }
      guard current == expected, epoch == initialEpoch, spaceChanges == initialSpaces,
        environmentChanges == initialEnvironment, singleDisplay else { return .staleObservation }
      switch settling.sample(current, at: now) {
      case .ready: return nil
      case .expired: return .staleObservation
      case .waiting: break
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  /// A directional receipt is a fresh picture of the unchanged composition, never an input lease.
  private func observeNavigationArrival(_ expected: NavigationSurface, observer: HandsObserver, pointer: CGPoint,
                                        allowed: () async -> HandError?, initialSpaces: Int, initialEnvironment: Int,
                                        trace: SwitchTrace) async -> Looked {
    retireObservation()
    let captureEpoch = epoch
    let result = await captureNavigationArrival(expected, captureEpoch: captureEpoch, observer: observer, pointer: pointer,
      allowed: allowed, initialSpaces: initialSpaces, initialEnvironment: initialEnvironment, trace: trace)
    return Looked(result: result, epoch: captureEpoch)
  }
  private func captureNavigationArrival(_ expected: NavigationSurface, captureEpoch: Int, observer: HandsObserver, pointer: CGPoint,
                                        allowed: () async -> HandError?, initialSpaces: Int, initialEnvironment: Int,
                                        trace: SwitchTrace) async -> Result<Observation, HandError> {
    if let error = await allowed() { return .failure(error) }
    let before = await navigationSurface(allowComposite: true, trace: trace)
    if let error = await allowed() { return .failure(error) }
    guard DesktopDirectionalEvidence.captureMatches(expected: expected, observed: before, expectedEpoch: captureEpoch,
      observedEpoch: epoch, spaceChanges: spaceChanges - initialSpaces, environmentChanges: environmentChanges - initialEnvironment,
      activeDisplays: activeDisplays) else { return .failure(.staleObservation) }
    let captured = await observer.observe(image: true, elements: false, accessibility: true, pointer: pointer)
    if let error = await allowed() { return .failure(error) }
    let after = await navigationSurface(allowComposite: true, trace: trace)
    if let error = await allowed() { return .failure(error) }
    guard DesktopDirectionalEvidence.captureMatches(expected: expected, observed: after, expectedEpoch: captureEpoch,
      observedEpoch: epoch, spaceChanges: spaceChanges - initialSpaces, environmentChanges: environmentChanges - initialEnvironment,
      activeDisplays: activeDisplays) else { return .failure(.staleObservation) }
    guard case .success(let seen) = captured else { return captured }
    return .success(Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app, elements: [],
      image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: surfaceEpoch))
  }

  /// Screenshot and AX evidence bracketed by independently checked window identity.
  /// An observation can still describe a desktop with no usable window, but grants
  /// no input lease in that case (open_app remains available).
  func observe(observer: HandsObserver, image: Bool, elements: Bool, accessibility: Bool, pointer: CGPoint) async -> Result<Observation, HandError> {
    await leasedLook(observer: observer, image: image, elements: elements, accessibility: accessibility, pointer: pointer).result
  }
  /// A look, and the input epoch of the lease just after it. A transition compares that epoch with `epoch`
  /// before it gives the look as its arrival: nothing retired the look in between. The observation itself
  /// carries `surfaceEpoch`, which only a change of the desktop or the display moves.
  struct Looked { let result: Result<Observation, HandError>; let epoch: Int }
  private func leasedLook(observer: HandsObserver, image: Bool, elements: Bool, accessibility: Bool, pointer: CGPoint) async -> Looked {
    let result = await readLook(observer: observer, image: image, elements: elements, accessibility: accessibility, pointer: pointer)
    return Looked(result: result, epoch: epoch)
  }
  private func readLook(observer: HandsObserver, image: Bool, elements: Bool, accessibility: Bool, pointer: CGPoint) async -> Result<Observation, HandError> {
    let beforeEpoch = epoch
    let before = accessibility ? await surface() : nil
    let coverFrames = before?.covers.map(\.frame) ?? []
    let read = await observer.observe(image: image, elements: elements, accessibility: accessibility, pointer: pointer, coverFrames: coverFrames)
    let after = accessibility ? await surface() : nil
    guard beforeEpoch == epoch, before?.look == after?.look else { invalidate(); return .failure(.staleObservation) }
    guard case .success(let seen) = read else { invalidate(); return read }
    if let after {
      // Another window retires the way back to the desktop before, as it always did. The same window with
      // another list in front of it is a new look, and the way back stays.
      let held = lease.held?.surface
      lease.record(after.look, at: now)
      if let held, held != after { history.invalidate() }
    }
    else { invalidate() }
    return .success(Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app,
      elements: seen.elements, image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: surfaceEpoch))
  }

  /// Called after the guided cursor, before any physical pointer/keyboard event.
  /// `steady` is for a click, a drag, a scroll and one key: until its first event goes, the windows in front
  /// must stay as they were, because one that comes up would take the click, and a list that changed is not
  /// the list that the planner saw. Typed text is not steady: a list of suggestions changes its size while the
  /// hands type, and the text goes to the place of the keyboard whatever lies in front.
  ///
  /// Keys go to the app's focused window. That window is the surface, and it is read again before every key and
  /// every few typed characters: a window in front that took the keyboard would be the focused window, and the
  /// surface would not be the same. `places` are the places of a pointing command, from the top left of the
  /// main display.
  func beginInput(steady: Bool = false, places: [CGPoint] = [], allowCover: Bool = false) async -> Bool {
    let expected = epoch
    let current = await surface()
    guard expected == epoch, lease.permits(current?.look, at: now) else { invalidate(); return false }
    inputSurface = current; inputEpoch = epoch
    inputFront = steady ? current.map { ($0.covers, $0.unseen) } : nil
    inputPlaces = places
    inputAllowCover = allowCover
    inputObservedCovers = current?.covers ?? []
    return true
  }
  /// One of the places is under a window of the app that lies in front of the surface. The look does not say
  /// what is there, so no click goes to it unless the command explicitly targets an observed cover that has not changed.
  func inputHides(_ places: [CGPoint], allowCover: Bool = false) -> Bool {
    guard let covers = inputSurface?.covers else { return false }
    let allow = allowCover || inputAllowCover
    return places.contains { place in
      guard DesktopFocusedWindow.hides(covers, place) else { return false }
      return !(allow && DesktopFocusedWindow.permitsObservedCover(place, observed: inputObservedCovers, current: covers))
    }
  }
  /// Cheap event-loop guard between await points; geometry is checked again just
  /// before a click/key and periodically during typing.
  var inputGenerationCurrent: Bool { inputSurface != nil && inputEpoch == epoch }
  func inputStillCurrent(steady: Bool = true) async -> Bool {
    guard inputGenerationCurrent, let expected = inputSurface else { return false }
    let current = await surface()
    guard inputGenerationCurrent, let current, current == expected else { invalidate(); return false }
    // Before the first event of a steady input the windows in front must be as they were, also the ones that
    // show nothing: one that starts to show could take the click. After it they may change, because the first
    // press of a double click can open a list. Even then no place of the command may lie under an unobserved
    // or changed cover.
    if steady, let held = inputFront, held.covers != current.covers || held.unseen != current.unseen { invalidate(); return false }
    for place in inputPlaces {
      if inputAllowCover && DesktopFocusedWindow.hides(inputObservedCovers, place) {
        guard DesktopFocusedWindow.permitsObservedCover(place, observed: inputObservedCovers, current: current.covers) else {
          invalidate(); return false
        }
      } else if DesktopFocusedWindow.hides(current.covers, place) {
        invalidate(); return false
      }
    }
    return true
  }
  func endInput() { inputSurface = nil; inputEpoch = nil; inputFront = nil; inputPlaces = []; inputAllowCover = false; inputObservedCovers = []; lease.consume() }

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
      retire(); phase(.switching); dispatched = true
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
    retire(); phase(.switching)
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
        let captured = await leasedLook(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        // The same rule as the worker's: the app in front is the app that the name stood for.
        guard case .success(let seen) = captured.result, let current = await surface(transition: true), current == matches,
          captured.epoch == epoch, DesktopArrival.sameApp(resolved: bundleID, front: seen.app.bundleId),
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
    retire(); phase(.switching)
    defer { if !ready { invalidate(); phase(.blocked) } }
    // The request is out from here. What fails after it is unknown, never a refusal:
    // Stop, a takeover or a lost right in the middle, and an app that never came forward.
    let unknown: Result<Arrival, HandError> = .failure(DesktopEffectOutcome.failure(.targetNotVisible, dispatched: true))
    let wait = DesktopAppWait(at: now)
    let options = NSWorkspace.OpenConfiguration()
    options.activates = true
    // What macOS answers is not the evidence. The app in front (or, for Screenshot,
    // the visible screencaptureui overlay toolbar window) is.
    NSWorkspace.shared.openApplication(at: url, configuration: options) { _, _ in }
    phase(.waiting)
    let usesOverlay = DesktopArrival.usesScreenshotOverlay(bundleID: bundleID)
    while true {
      if await allowed() != nil { return unknown }
      let snapshot = usesOverlay
        ? DesktopAX.screenshotArrivalEvidence()
        : (evidence: DesktopArrival.AppArrivalEvidence(frontBundleID: NSWorkspace.shared.frontmostApplication?.bundleIdentifier),
           appsByPID: [Int: NSRunningApplication]())
      let matched = DesktopArrival.match(resolved: bundleID, evidence: snapshot.evidence)
      switch wait.sample(inFront: matched.arrived, at: now) {
      case .expired: return unknown
      case .waiting: break
      case .inFront:
        let overlayApp: NSRunningApplication?
        if case .overlayApp(_, let pid) = matched { overlayApp = snapshot.appsByPID[pid] }
        else { overlayApp = nil }
        // The picture and the tree are the evidence for the worker. The same app is in
        // front (or the screencaptureui overlay toolbar remains visible) before and after they are taken.
        let read = await observer.observe(image: true, elements: true, accessibility: true, pointer: pointer(), appOverride: overlayApp)
        if await allowed() != nil { return unknown }
        switch matched {
        case .overlayApp(let arrivedBundle, _):
          let confirm = DesktopAX.screenshotArrivalEvidence()
          if case .success(let seen) = read,
            DesktopArrival.match(resolved: bundleID, evidence: confirm.evidence).arrived,
            DesktopArrival.sameApp(resolved: arrivedBundle, front: seen.app.bundleId) {
            // This result permits no input. The worker looks again before it acts.
            invalidate()
            ready = true; phase(.ready)
            let arrived = Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app, elements: seen.elements,
              image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: surfaceEpoch)
            return .success(Arrival(observation: arrived, bundleID: DesktopArrival.identity(arrivedBundle)))
          }
        case .frontApp(let arrivedBundle):
          if case .success(let seen) = read, DesktopArrival.sameApp(resolved: arrivedBundle, front: seen.app.bundleId),
            DesktopArrival.sameApp(resolved: arrivedBundle, front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier) {
            // This result permits no input. The worker looks again before it acts.
            invalidate()
            ready = true; phase(.ready)
            let arrived = Observation(at: seen.at, screen: seen.screen, cursor: seen.cursor, app: seen.app, elements: seen.elements,
              image: seen.image, imageWidth: seen.imageWidth, imageHeight: seen.imageHeight, surfaceEpoch: surfaceEpoch)
            return .success(Arrival(observation: arrived, bundleID: DesktopArrival.identity(arrivedBundle)))
          }
        case .notArrived: break
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
    history.invalidate(); lease.retire(); switching = true; phase(.switching)
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
        let captured = await leasedLook(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironment, spaceChanges - initialSpaces <= 1,
          case .success(let seen) = captured.result, let current = await surface(transition: true), current == stable,
          current.pid != origin.pid, captured.epoch == epoch, now - began < 5 else { return failure(.staleObservation) }
        ready = true; phase(.ready)
        return .success(seen)
      }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
  }

  /// Explicit adjacent move, never an implicit retry of failed app activation.
  /// An operator-attested enabled shortcut is sent once; a Space notification
  /// and changed stable native surface independently witness arrival.
  func switchDesktop(direction requested: DesktopDirection, sequence: Int, configuration: () -> DesktopShortcutPair?,
                     send: (DesktopResolvedShortcut, () async -> HandError?) async -> Result<Void, HandError>,
                     allowed: @escaping () async -> HandError?, observer: HandsObserver,
                     pointer: () -> CGPoint) async -> Result<Observation?, HandError> {
    let began = now
    let trace = SwitchTrace(spaces: spaceChanges, environment: environmentChanges)
    let result = await performDesktopSwitch(direction: requested, configuration: configuration, send: send,
      allowed: allowed, observer: observer, pointer: pointer, trace: trace)
    let outcome: String
    switch result {
    case .success: outcome = "verified"
    case .failure(let error): outcome = error.rawValue; if trace.nativeFailure == nil { trace.nativeFailure = error }
    }
    // Only bounded machine facts; no surface object, identity, title, frame or request text is formatted.
    let summary = "seq=\(sequence) direction=\(requested.rawValue) dispatched=\(trace.dispatched) compositeSource=\(trace.compositeSource) compositeArrival=\(trace.compositeArrival) spaceDelta=\(spaceChanges - trace.spaceBaseline) environmentDelta=\((trace.environmentAtResult ?? environmentChanges) - trace.environmentBaseline) samples=\(trace.samples.total) candidates=\(trace.samples.candidates) consecutive=\(trace.samples.consecutive) emptySamples=\(trace.samples.empty) lastSurface=\(trace.lastSurfaceReason) lastSurfaceRefusal=\(trace.lastSurfaceRefusal) nativeFailure=\(trace.nativeFailure?.rawValue ?? "none") outcome=\(outcome) elapsedMs=\(Int(max(0, now - began) * 1000))"
    Self.transitionLog.notice("\(summary, privacy: .public)")
    return result
  }

  private func performDesktopSwitch(direction requested: DesktopDirection, configuration: () -> DesktopShortcutPair?,
                     send: (DesktopResolvedShortcut, () async -> HandError?) async -> Result<Void, HandError>,
                     allowed: @escaping () async -> HandError?, observer: HandsObserver,
                     pointer: () -> CGPoint, trace: SwitchTrace) async -> Result<Observation?, HandError> {
    guard enabled else { return .failure(.desktopDisabled) }
    guard singleDisplay else { return .failure(.unsupportedDesktop) }
    if let error = await allowed() { return .failure(error) }
    let beforeEpoch = epoch
    guard let origin = await navigationSurface(allowComposite: requested != .previous, trace: trace), beforeEpoch == epoch else {
      // No window is in front. A desktop with no window at all can still be left; the arrival is then a window.
      // The desktop of before has no name here, so "previous" stays unavailable.
      guard beforeEpoch == epoch, requested != .previous, let display = HandsDisplay.main,
        await surface(transition: true, diagnostic: { trace.surfaceReason($0) }) == nil, DesktopAX.noOrdinaryWindow(display: display.id) else { return .failure(.unsupportedDesktop) }
      return await leaveEmptyDesktop(direction: requested, display: display, configuration: configuration, send: send,
        allowed: allowed, observer: observer, pointer: pointer, trace: trace)
    }
    let direction: DesktopDirection
    let expected: NavigationSurface?
    if requested == .previous {
      guard let previous = history.previous(from: origin.parent) else { return .failure(.desktopHistoryUnavailable) }
      direction = previous.direction; expected = .strict(previous.target)
    } else { direction = requested; expected = nil }
    if origin.composite {
      if let error = await settleNavigationSource(origin, allowed: allowed, trace: trace) { return .failure(error) }
    }
    trace.compositeSource = origin.composite
    guard let pair = configuration(), let shortcut = pair.shortcut(for: direction) else { return .failure(.desktopShortcutUnavailable) }
    if let error = await allowed() { return .failure(error) }
    guard beforeEpoch == epoch, await navigationSurface(allowComposite: requested != .previous, trace: trace) == origin, beforeEpoch == epoch else { return .failure(.staleObservation) }
    guard configuration() == pair else { return .failure(.desktopShortcutUnavailable) }
    let initialSpaceChanges = spaceChanges, initialEnvironmentChanges = environmentChanges
    trace.spaceBaseline = initialSpaceChanges; trace.environmentBaseline = initialEnvironmentChanges
    let began = now
    var dispatched = false, ready = false
    // History is retired before the attempt. Nothing restores it on failure.
    history.invalidate(); lease.retire(); switching = true; phase(.switching)
    defer {
      trace.environmentAtResult = environmentChanges
      switching = false
      if !ready { invalidate(); phase(.blocked) }
    }
    func failure(_ error: HandError) -> Result<Observation?, HandError> {
      trace.nativeFailure = error
      return .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched))
    }
    let dispatchEpoch = epoch
    switch await send(shortcut, { [self] in
      if let error = await allowed() { return error }
      guard dispatchEpoch == epoch, spaceChanges == initialSpaceChanges, environmentChanges == initialEnvironmentChanges,
        await navigationSurface(allowComposite: requested != .previous, trace: trace) == origin, dispatchEpoch == epoch else { return .staleObservation }
      if let error = await allowed() { return error }
      guard dispatchEpoch == epoch, singleDisplay, spaceChanges == initialSpaceChanges,
        environmentChanges == initialEnvironmentChanges else { return .staleObservation }
      return nil
    }) {
    case .failure(let error): return failure(error)
    case .success: dispatched = true; trace.dispatched = true
    }
    phase(.waiting)
    var settlement = DesktopSwitchSettlement(origin: origin, expected: expected, at: began)
    while true {
      if let error = await allowed() { return failure(error) }
      guard environmentChanges == initialEnvironmentChanges, singleDisplay else { return failure(.unsupportedDesktop) }
      let changes = spaceChanges - initialSpaceChanges
      guard changes <= 1 else { return failure(.targetNotVisible) }
      let sampleEpoch = epoch
      let candidate = await navigationSurface(allowComposite: requested != .previous, trace: trace)
      let stableCandidate = candidate.flatMap { value -> NavigationSurface? in
        guard sampleEpoch == epoch, value.parent.displayID == origin.parent.displayID, value.parent.map == origin.parent.map else { return nil }
        if (origin.composite || value.composite) && value != origin {
          guard DesktopDirectionalEvidence.changedParent(fromPID: Int(origin.parent.pid), fromWindow: origin.parent.windowID,
            toPID: Int(value.parent.pid), toWindow: value.parent.windowID) else { return nil }
        }
        return value
      }
      // No window was read, and the window server lists none: that is the look of a desktop with no window.
      let empty = candidate == nil && sampleEpoch == epoch && DesktopAX.noOrdinaryWindow(display: origin.parent.displayID)
      trace.samples.record(spaceChanges - initialSpaceChanges == 1 && stableCandidate != origin && (expected.map({ $0 == stableCandidate }) ?? true) ? stableCandidate : nil, epoch: epoch, isEmpty: empty)
      let decision = settlement.sample(stableCandidate, empty: empty, spaceChanges: spaceChanges - initialSpaceChanges, epoch: epoch, at: now)
      if settlement.arrivedEmpty {
        // One Space change, and for a second no window anywhere on the display: the desktop of arrival is empty.
        // It is observed as it is. An observation with no window gives no lease for input.
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1 else { return failure(.staleObservation) }
        let captured = await leasedLook(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        // The observation of a desktop with no window retires the lease once itself: one more environment change.
        guard now - began < 6, environmentChanges == initialEnvironmentChanges + 1, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured.result, await surface(transition: true, diagnostic: { trace.surfaceReason($0) }) == nil, DesktopAX.noOrdinaryWindow(display: origin.parent.displayID),
          captured.epoch == epoch else { return failure(.staleObservation) }
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
        guard let arrival = stableCandidate else { return failure(.staleObservation) }
        trace.compositeArrival = arrival.composite
        let compositionUsed = origin.composite || arrival.composite
        let captured = compositionUsed
          ? await observeNavigationArrival(arrival, observer: observer, pointer: pointer(), allowed: allowed,
              initialSpaces: initialSpaceChanges, initialEnvironment: initialEnvironmentChanges, trace: trace)
          : await leasedLook(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured.result, let target = await navigationSurface(allowComposite: requested != .previous, trace: trace), target == arrival,
          captured.epoch == epoch, now - began < 5 else { return failure(.staleObservation) }
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, singleDisplay, environmentChanges == initialEnvironmentChanges,
          spaceChanges - initialSpaceChanges == 1, captured.epoch == epoch else { return failure(.staleObservation) }
        if compositionUsed { retireObservation(); history.invalidate() }
        else { history.verified(direction, from: origin.parent, to: target.parent) }
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
                                 pointer: () -> CGPoint, trace: SwitchTrace) async -> Result<Observation?, HandError> {
    guard let pair = configuration(), let shortcut = pair.shortcut(for: direction) else { return .failure(.desktopShortcutUnavailable) }
    if let error = await allowed() { return .failure(error) }
    guard configuration() == pair else { return .failure(.desktopShortcutUnavailable) }
    let initialSpaceChanges = spaceChanges, initialEnvironmentChanges = environmentChanges
    trace.spaceBaseline = initialSpaceChanges; trace.environmentBaseline = initialEnvironmentChanges
    let began = now
    var dispatched = false, ready = false
    history.invalidate(); lease.retire(); switching = true; phase(.switching)
    defer {
      trace.environmentAtResult = environmentChanges
      switching = false
      if !ready { invalidate(); phase(.blocked) }
    }
    func failure(_ error: HandError) -> Result<Observation?, HandError> {
      trace.nativeFailure = error
      return .failure(DesktopEffectOutcome.failure(error, dispatched: dispatched))
    }
    let dispatchEpoch = epoch
    switch await send(shortcut, { [self] in
      if let error = await allowed() { return error }
      guard dispatchEpoch == epoch, spaceChanges == initialSpaceChanges, environmentChanges == initialEnvironmentChanges,
        await surface(transition: true, diagnostic: { trace.surfaceReason($0) }) == nil, DesktopAX.noOrdinaryWindow(display: display.id), dispatchEpoch == epoch else { return .staleObservation }
      return nil
    }) {
    case .failure(let error): return failure(error)
    case .success: dispatched = true; trace.dispatched = true
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
      let candidate = await surface(transition: true, diagnostic: { trace.surfaceReason($0) })
      let stableCandidate = candidate.flatMap { value -> Surface? in
        guard sampleEpoch == epoch, value.displayID == display.id, value.map == display.map else { return nil }
        return value
      }
      looks += 1
      if changes != 0 || candidate != nil || !DesktopAX.noOrdinaryWindow(display: display.id) { stayedEmpty = false }
      // A window counts as the arrival only after the one Space change.
      trace.samples.record(changes == 1 ? stableCandidate.map { .strict($0) } : nil, epoch: epoch, isEmpty: false)
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
        let captured = await leasedLook(observer: observer, image: true, elements: true, accessibility: true, pointer: pointer())
        if let error = await allowed() { return failure(error) }
        guard now - began < 5, environmentChanges == initialEnvironmentChanges, spaceChanges - initialSpaceChanges == 1,
          case .success(let seen) = captured.result, let target = await surface(transition: true, diagnostic: { trace.surfaceReason($0) }), target == stableCandidate,
          captured.epoch == epoch, now - began < 5 else { return failure(.staleObservation) }
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
    /// Reads running `screencaptureui` processes and on-screen window metadata in Quartz display coordinates
    /// so `DesktopArrival.match` can verify `open_app("Screenshot")` without weakening normal app checks.
    static func screenshotArrivalEvidence() -> (evidence: DesktopArrival.AppArrivalEvidence, appsByPID: [Int: NSRunningApplication]) {
      let overlayApps = NSRunningApplication.runningApplications(withBundleIdentifier: DesktopArrival.screenshotOverlayBundleID)
        .filter { !$0.isTerminated }
      let appsByPID = Dictionary(overlayApps.map { (Int($0.processIdentifier), $0) }, uniquingKeysWith: { first, _ in first })
      let overlayPIDs = Set(appsByPID.keys)
      let display = activeDisplayBounds()
      let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
      let overlayWindows: [DesktopArrival.OverlayWindow] = rawWindows.compactMap { row in
        guard let owner = row[kCGWindowOwnerPID as String] as? Int,
          overlayPIDs.contains(owner),
          let layer = row[kCGWindowLayer as String] as? Int,
          let raw = row[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return DesktopArrival.OverlayWindow(
          pid: owner,
          ownerName: row[kCGWindowOwnerName as String] as? String,
          layer: layer,
          frame: bounds,
          alpha: row[kCGWindowAlpha as String] as? Double,
          onScreen: (row[kCGWindowIsOnscreen as String] as? Bool) ?? true)
      }
      let evidence = DesktopArrival.AppArrivalEvidence(
        frontBundleID: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        overlayPIDs: overlayPIDs,
        overlayWindows: overlayWindows,
        display: display)
      return (evidence, appsByPID)
    }
    private static func activeDisplayBounds() -> CGRect {
      var count: UInt32 = 0
      guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return CGDisplayBounds(CGMainDisplayID())
      }
      var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
      guard CGGetActiveDisplayList(count, &ids, &count) == .success, count > 0 else {
        return CGDisplayBounds(CGMainDisplayID())
      }
      return ids.prefix(Int(count)).reduce(CGRect.null) { $0.union(CGDisplayBounds($1)) }
    }
    /// True when the window server lists no ordinary window on this display: a desktop with no window.
    /// The panel's own windows, the Dock, the menu bar and what lies on the desktop itself do not count.
    /// False when the list cannot be read: nothing is said of a desktop that was not seen.
    static func noOrdinaryWindow(display: CGDirectDisplayID) -> Bool {
      guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
      let bounds = CGDisplayBounds(display)
      return !windows.contains { row in
        guard OwnWindows.judged(layer: row[kCGWindowLayer as String] as? Int, owner: row[kCGWindowOwnerPID as String] as? Int,
                                own: Int(getpid())) else { return false }
        // A row with no frame cannot be placed: it counts as a window, so the desktop is not called empty.
        guard let raw = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return true }
        return !bounds.intersection(frame).isEmpty
      }
    }
    /// `covers`: small windows of the same app may lie in front of the focused window. That is the rule for the
    /// hands' input. Without it the focused window must be the top one, as a move to another app or desktop needs.
    static func visibleSurface(pid: pid_t, display: HandsDisplay, covers: Bool = true,
                               diagnostic: ((String) -> Void)? = nil, fact: ((String, Bool) -> Void)? = nil) -> Surface? {
      guard case .strict(let value) = readSurface(pid: pid, display: display, directional: false, covers: covers,
        diagnostic: diagnostic, fact: fact) else { return nil }
      return value
    }
    static func directionalSurface(pid: pid_t, display: HandsDisplay, diagnostic: ((String) -> Void)?,
                                   fact: ((String, Bool) -> Void)? = nil, count: ((String, Int) -> Void)? = nil) -> NavigationSurface? {
      readSurface(pid: pid, display: display, directional: true, covers: false, diagnostic: diagnostic, fact: fact, count: count)
    }
    private static func readSurface(pid: pid_t, display: HandsDisplay, directional: Bool, covers allowed: Bool,
                                    diagnostic: ((String) -> Void)?, fact: ((String, Bool) -> Void)?, count: ((String, Int) -> Void)? = nil) -> NavigationSurface? {
      let app = app(pid)
      guard let focused = element(value(app, kAXFocusedWindowAttribute)) else { diagnostic?("ax_focused_window_unavailable"); return nil }
      // A sheet hangs from a window and takes the focus: "Do you want to save?". It has no title and no
      // minimized state of its own. Without it as a surface, no button of a sheet could ever be pressed.
      let sheet = (value(focused, kAXRoleAttribute) as? String) == "AXSheet"
      let minimized = value(focused, kAXMinimizedAttribute) as? Bool
      fact?("focusedSheet", sheet); fact?("minimizedKnown", minimized != nil); fact?("minimized", minimized == true)
      guard sheet ? minimized != true : minimized == false else { diagnostic?("ax_minimized_or_unknown"); return nil }
      guard let title = sheet ? ((value(focused, kAXTitleAttribute) as? String) ?? "") : (value(focused, kAXTitleAttribute) as? String)
        else { diagnostic?("ax_title_unavailable"); return nil }
      guard let bounds = frame(focused) else { diagnostic?("ax_frame_unavailable"); return nil }
      guard !CGDisplayBounds(display.id).intersection(bounds).isEmpty else { diagnostic?("window_outside_main_display"); return nil }
      guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { diagnostic?("quartz_inventory_unavailable"); return nil }
      let ordinary: [[String: Any]]
      if directional {
        // Never compact-map away an unpositioned/foreign leading ordinary row.
        guard windows.count <= 512 else { diagnostic?("directional_inventory_limit"); return nil }
        var rows: [[String: Any]] = []
        for row in windows {
          guard let layer = row[kCGWindowLayer as String] as? Int else { diagnostic?("quartz_inventory_incomplete"); return nil }
          if layer != 0 { continue }
          guard let owner = row[kCGWindowOwnerPID as String] as? Int,
            let id = row[kCGWindowNumber as String] as? Int, id > 0,
            let raw = row[kCGWindowBounds as String] as? NSDictionary, CGRect(dictionaryRepresentation: raw) != nil
            else { diagnostic?("quartz_inventory_incomplete"); return nil }
          if OwnWindows.judged(layer: layer, owner: owner, own: Int(getpid())) { rows.append(row) }
        }
        ordinary = rows
      } else {
        ordinary = windows.filter { row in
        // ClawdTime's own windows, such as the mascot and the guided cursor, are never the surface or a cover.
        guard OwnWindows.judged(layer: row[kCGWindowLayer as String] as? Int, owner: row[kCGWindowOwnerPID as String] as? Int, own: Int(getpid())),
          let raw = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw) else { return false }
        return !CGDisplayBounds(display.id).intersection(frame).isEmpty
      }
      }
      let evidence: [DesktopWindowEvidence]
      if directional {
        let rows = ordinary.map { row in
          DesktopDirectionalRow(id: row[kCGWindowNumber as String] as? Int, pid: row[kCGWindowOwnerPID as String] as? Int,
            frame: (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) },
            title: row[kCGWindowName as String] as? String, alpha: row[kCGWindowAlpha as String] as? Double)
        }
        guard let complete = DesktopDirectionalEvidence.inventory(rows) else { diagnostic?("quartz_inventory_incomplete"); return nil }
        evidence = complete
      } else {
        evidence = ordinary.compactMap { row -> DesktopWindowEvidence? in
        guard let owner = row[kCGWindowOwnerPID as String] as? Int, let id = row[kCGWindowNumber as String] as? Int,
          let raw = row[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return .init(id: id, pid: owner, title: row[kCGWindowName as String] as? String, frame: bounds,
          alpha: row[kCGWindowAlpha as String] as? Double)
      }
      }
      // Dropping an incomplete leading row must not expose the window behind it.
      guard evidence.count == ordinary.count else { diagnostic?("quartz_inventory_incomplete"); return nil }
      fact?("quartzHasVisibleWindow", !evidence.isEmpty)
      fact?("quartzTopOwnedByFrontApp", evidence.first?.pid == Int(pid))
      fact?("quartzHasOwnerFrameMatch", evidence.contains { $0.pid == Int(pid) && abs($0.frame.minX - bounds.minX) <= 1 && abs($0.frame.minY - bounds.minY) <= 1 && abs($0.frame.width - bounds.width) <= 1 && abs($0.frame.height - bounds.height) <= 1 })
      fact?("quartzHasOwnerTitleMatch", evidence.contains { row in row.pid == Int(pid) && (row.title == title || [" - ", " – ", " — "].contains { separator in !(row.title ?? "").isEmpty && title.hasPrefix((row.title ?? "") + separator) }) })
      let confirmed = (value(focused, "AXFullScreen") as? Bool) == true
      fact?("ordinaryWindow", (value(focused, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole)
      fact?("fullScreen", fullScreen(focused)); fact?("fullScreenConfirmed", confirmed)
      fact?("containedInMainDisplay", CGDisplayBounds(display.id).contains(bounds))
      fact?("fullScreenGeometry", DesktopSurfaceScope.fullScreenGeometry(window: bounds, display: CGDisplayBounds(display.id)))
      // Only a focused window that is not the top one needs the app's own list of windows: for the strip of
      // a full-screen app, and for small windows of the app in front (a list of suggestions, a card). The
      // list says which of the app's windows stand alone. Ordinary focused windows avoid these extra
      // off-Space reads and their latency.
      var frames: [CGRect]?, standalone: [CGRect]?
      if !directional, evidence.first?.frame != bounds,
        let axWindows = value(app, kAXWindowsAttribute) as? [AXUIElement], axWindows.count <= 32 {
        let all = axWindows.compactMap(frame)
        if all.count == axWindows.count {
          frames = all
          standalone = axWindows.indices.filter {
            DesktopWindowVisibility.standsAlone(role: value(axWindows[$0], kAXRoleAttribute) as? String,
              subrole: value(axWindows[$0], kAXSubroleAttribute) as? String)
          }.map { all[$0] }
        }
      }
      let windowID: Int
      var covers: [DesktopCover] = [], unseen: [DesktopUnseen] = [], front = 0
      var group: DesktopDirectionalGroup?
      if directional {
        guard !sheet, (value(focused, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole
          else { diagnostic?("directional_parent_not_ordinary"); return nil }
        guard let matched = DesktopDirectionalEvidence.group(pid: Int(pid), title: title, parent: bounds,
          display: CGDisplayBounds(display.id), fullScreenConfirmed: confirmed, visible: evidence, diagnostic: diagnostic, count: count)
          else { return nil }
        fact?("directionalToolbarCoverage", matched.usesToolbarCoverage)
        group = matched; windowID = matched.parentID
      } else {
        // Without `allowed` the list of windows that stand alone is withheld, and the match is the strict one.
        guard let matched = DesktopWindowVisibility.focusedWindow(pid: Int(pid), title: title, frame: bounds,
          fullScreenConfirmed: confirmed, display: CGDisplayBounds(display.id), visible: evidence, accessibleFrames: frames,
          standaloneFrames: allowed ? standalone : nil, sheet: sheet) else { diagnostic?("ax_quartz_window_mismatch"); return nil }
        windowID = matched.id; covers = matched.covers; front = matched.front; unseen = matched.unseen
        fact?("ownWindowsInFront", front > 0); fact?("ownWindowsSeenInFront", !covers.isEmpty)
      }
      let parent = Surface(pid: pid, window: focused, title: title, frame: bounds, windowID: windowID, displayID: display.id, map: display.map,
        ordinary: (value(focused, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole,
        fullScreen: fullScreen(focused), fullScreenConfirmed: confirmed, covers: covers, front: front, unseen: unseen)
      diagnostic?(group == nil ? "ax_quartz_matched" : "directional_composition_ready")
      return group.map { .composite(parent, $0) } ?? .strict(parent)
    }
  }
}
