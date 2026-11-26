import AppKit
import ApplicationServices
import TaskPanelCore

/// The hands of computer use. A worker in the task service decides one action at
/// a time; this asks for the next command, runs it on this Mac and posts one
/// result. Only this app sees the screen and sends input, because macOS gives
/// those rights to one app that the person can see and stop.
///
/// What it keeps true:
/// - One command at a time, and one result for each sequence number, sent once.
/// - With a right missing nothing runs, and macOS shows a prompt only when the
///   person clicks the menu item.
/// - While a run is active a bar with Stop is on the screen. After Stop, a
///   command that waits is answered and not run.
/// - ClawdTime's own windows are not in the picture, a click never lands on
///   them, and typed keys never go to them.
/// - Before a click, a scroll, a drag or typed keys, the guided cursor glides
///   to the place with the label of the command. A screen share shows it.
///   While the screen is recorded or shown on a call it glides at the calm
///   pace, and `CLAWDTIME_CURSOR_PACE` can choose a pace.
/// - After the glide and just before the event, Stop is read once more: at this
///   Mac and at the service. If the person moved the mouse or pressed a key in
///   that time, nothing is sent and the worker asks.
/// - While macOS guards the keyboard (Secure Event Input), the tap sees none of
///   the person's keys, and so no Escape held for Stop. No input of any kind goes
///   then, the bar says why, and the worker asks.
/// - The worker's picture leaves the mascot out, so it may act on a field under
///   the mascot. Before a pointing command or typed text there, the mascot, its
///   bar and its bubble go to a free corner, and the event waits until they are there.
@MainActor final class HandsController: NSObject {
  private let pet: PetController
  private let input = HandsInput()
  private let observer = HandsObserver()
  private let desktop = HandsDesktop()
  /// Narrow transition seam for a presentation consumer; no presentation contract here.
  var onDesktopTransition: ((DesktopTransitionPhase, Int) -> Void)?
  private let bar = HandsBar()
  private let guide: GuidedCursor
  private let presentation = HandsPresentation()
  private var client: PanelClient?
  private var loop: Task<Void, Never>?
  private var ledger = HandsLedger()
  private var stop = HandsStop()
  private var run: HandsNext.Run?
  /// The worker runs, or a command waits: the bar is up and the tap listens.
  private var live = false
  private var label = ""
  /// When the bar came into view.
  private var barUp: Date?
  /// Short per-command cache for the remote service check inside `lastCheck()`, coalescing redundant
  /// loopback polls within 80 ms while keeping all synchronous local safety checks unconditional.
  private var remoteCheckAt: Date?
  private var typingMark = 0
  /// The time that the guided cursor took before the inputs of this command. Nil when it did not go out.
  private var glided: Double?
  /// What the command that ran last cost: its looks and its glide.
  private var cost: HandsCost {
    var spent = observer.spent
    if let glided { spent.add(HandsCost(glideMs: HandsCost.milliseconds(glided))) }
    return spent
  }
  /// The guided cursor goes to `target`, and its time counts for this command.
  private func travel(to target: CGPoint, label: String) async {
    glided = (glided ?? 0) + (await guide.travel(to: target, label: label, pace: pace))
  }
  /// `CLAWDTIME_CURSOR_PACE`, read once at the start.
  private let paceSetting = ProcessInfo.processInfo.environment[CursorPace.setting]
  private let recording = ScreenRecordingWatch()
  /// The service said with the last read that a call shows the screen.
  private var shownOnCall = false
  /// The pace of the guided cursor now. A setting that names a pace wins. Otherwise it is calm while macOS
  /// records the screen or a call shows it. The processes are read only when no setting names a pace and no
  /// call shows the screen.
  private var pace: CursorPace {
    if let named = CursorPace.named(paceSetting) { return named }
    if shownOnCall { return CursorPace.choose(setting: nil, recording: false, shownOnCall: true) }
    return CursorPace.choose(setting: nil, recording: recording.recording, shownOnCall: false)
  }
  private var inputRefusal: HandError?
  /// macOS guarded the keyboard during this command, as it does for a password field. The tap then saw none of
  /// the person's keys, Escape held for Stop among them, so the person counts as one who holds the keyboard.
  private var keyboardHeld = false
  /// What the bar says after a command that the hands held back for the person, until the next command.
  private var heldDetail: String?
  /// The app that the name of the last open_app stood for. It goes out with the result.
  private var resolvedApp: String?
  private let menuItems = NSHashTable<NSMenuItem>.weakObjects()
  private var rights: (accessibility: Bool, screenRecording: Bool, at: Date)?
  /// A run begins: the chat gets out of the way.
  var onRunStarted: (() -> Void)?
  /// A run of these hands is in view, with its bar and Stop.
  var running: Bool { live }
  /// True when these hands do the computer work of the service. The panel then keeps its chat open
  /// on a sent message: `onRunStarted` closes it when a run really starts.
  private(set) var engine = false
  private var engineRead: Date?

  init(pet: PetController) {
    self.pet = pet
    guide = GuidedCursor(pet: pet)
    super.init()
    bar.onStop = { [weak self] in self?.stopByPerson() }
    input.onEscapeHold = { [weak self] in self?.stopByPerson() }
    input.mayContinue = { [weak self] in
      guard let self else { return false }
      return !self.stop.stopped && self.sessionOpen && self.input.watching && !self.input.personActed && !self.keyboardHidden()
        && AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() && self.desktop.inputGenerationCurrent
    }
    input.beforeInput = { [weak self] in
      guard let self else { return false }
      if let error = await self.lastCheck() { self.inputRefusal = error; return false }
      // Before the first event of this command the windows in front must be as they were. After it they may change.
      guard await self.desktop.inputStillCurrent(steady: !self.input.submittedInput) else { self.inputRefusal = .staleObservation; return false }
      return true
    }
    input.ownWindowAt = { [weak self] place in
      guard let self else { return true }
      guard self.ownWindowTakes(place) else { return false }
      self.inputRefusal = .targetNotVisible
      return true
    }
    input.ownKeyboard = { [weak self] in
      guard let self else { return true }
      guard Self.keyboardIsOwn else { return false }
      self.inputRefusal = .refused
      return true
    }
    desktop.onTransition = { [weak self] phase, epoch in
      guard let self else { return }
      switch phase {
      case .switching: self.label = "Switching the work surface"; self.guide.hide()
      case .waiting: self.label = "Waiting for the work surface to settle"
      case .ready: self.label = "Work surface verified"
      case .blocked: self.label = "Desktop switch blocked; no further input"
      }
      self.showBar()
      // Desktop verification owns readiness; presentation stays wide until that
      // lifecycle releases it and a separate fresh context has been observed.
      if let presentationPhase = CallPresentationTransitionPhase(rawValue: phase.rawValue) {
        self.presentationTransition(phase: presentationPhase, epoch: epoch)
      }
      self.onDesktopTransition?(phase, epoch)
    }
  }

  // MARK: the loop

  /// Starts to ask the task service for commands. A service that holds a read answers as soon as a command
  /// waits, so the hands read again at once. Another service is asked often while the worker runs, and
  /// seldom otherwise. `HandsPace` holds the rule.
  func start(client: PanelClient) {
    guard loop == nil else { return }
    self.client = client
    presentation.connect(client, overlayBounds: { [weak self] in
      guard let self, let map = HandsDisplay.main?.map, let bounds = self.guide.visiblePresentationBounds else { return nil }
      return map.flip(bounds)
    }) { [weak self] in
      guard let self else { return false }
      return self.live && !self.stop.stopped && !(self.input.watching && self.input.personActed) && self.sessionOpen
    }
    loop = Task { [weak self] in
      var failures = 0
      while !Task.isCancelled {
        guard let self else { return }
        var active = false, held = false, ran = false
        // The gap between two reads counts from the start of this one.
        let began = Date()
        do {
          // Which engine the service has changes only when the service starts again, or with the
          // switch. A read every few seconds is enough.
          if self.engineRead.map({ Date().timeIntervalSince($0) > 10 }) ?? true {
            self.engine = (try? await client.handsAreEngine()) ?? false
            self.engineRead = Date()
          }
          let read = try await client.handsNext(after: self.ledger.last, wait: HandsPace.hold)
          held = read.held
          self.shownOnCall = read.shown
          let next = read.next
          failures = 0
          active = next.run.active || next.command != nil
          self.present(next)
          // A number that was taken before is never run again.
          if let pending = next.command, self.ledger.claim(pending.seq) {
            let result = await self.perform(pending)
            ran = true
            // Exactly one POST for this number. A failure is not sent again: the
            // worker reads a missing answer as an unknown outcome. What the command
            // cost goes with it, as numbers only.
            do { try await client.handsResult(result, cost: self.cost) }
            catch { self.presentation.reset(); self.desktop.invalidate() } // No replay; disconnected history is no longer usable.
            self.showBar()
          }
        } catch {
          failures += 1
          self.presentation.reset()
          // A service that is gone commands nothing: the bar goes too.
          if failures >= HandsPace.failuresBeforeQuiet { self.desktop.invalidate(); self.quiet() }
        }
        let pause = HandsPace.delay(active: active, failures: failures, elapsed: Date().timeIntervalSince(began), held: held, ran: ran)
        if pause > 0 { try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000)) }
      }
    }
  }
  func shutdown() {
    loop?.cancel(); loop = nil
    remoteCheckAt = nil
    input.halted = true
    desktop.invalidate()
    input.letGo()
    quiet()
  }
  /// The task service that answers now. Another instance counts its commands from the start again.
  func service(instance: String) {
    // Another service can have another engine: read it again at once.
    if instance != serviceInstance { presentation.reset(); serviceInstance = instance; engineRead = nil; desktop.invalidate() }
    ledger.service(instance)
  }
  private var serviceInstance: String?

  private func present(_ next: HandsNext) {
    // A command that waits counts as a run: the person sees the bar before anything is done.
    let active = next.run.active || next.command != nil
    run = next.run
    stop.observe(active: active)
    if !stop.stopped { input.halted = false }
    guard active else { quiet(); return }
    if !live {
      live = true; label = ""
      onRunStarted?()
    }
    if let pending = next.command { label = ElementCleaner.line(pending.label, limit: 120) }
    if stop.stopped || next.run.state == "waiting_for_person" || next.run.state == "stopping" { presentation.reset() }
    shield(true)
    // The tap needs the Accessibility right. It starts as soon as the right is there.
    input.watch()
    showBar()
  }
  /// Nothing runs: the bar, the guided cursor and the tap go, and the windows show in captures again.
  private func quiet() {
    remoteCheckAt = nil
    presentation.reset()
    guard live || bar.isShown else { return }
    live = false; label = ""; heldDetail = nil
    desktop.retireObservation()
    bar.hide(); guide.hide(); guide.typing(false)
    input.unwatch()
    shield(false)
  }
  private func showBar() {
    guard live else { return }
    let detail: String
    if stop.stopped { detail = "Stopped. Nothing more runs on this Mac." }
    else if run?.state == "waiting_for_person" { detail = "Waiting for you" }
    else if !label.isEmpty { detail = label }
    else { detail = ElementCleaner.line(run?.goal ?? "", limit: 80) }
    if !bar.isShown { barUp = Date() }
    bar.show(detail: heldDetail.flatMap { stop.stopped ? nil : $0 } ?? detail, stopped: stop.stopped, canStop: !stop.stopped)
  }

  // MARK: Stop

  /// The person pressed Stop on the bar, or held Escape. From now nothing more
  /// runs here, whatever the service answers. The request to the worker goes once.
  private func stopByPerson() {
    guard live, !stop.stopped else { return }
    remoteCheckAt = nil
    stop.press()
    presentation.reset()
    desktop.invalidate()
    input.halted = true
    guide.hide(); guide.typing(false)
    showBar()
    guard let client else { return }
    // Cooperative: an action already underway may finish. The request is never replayed.
    Task { _ = try? await client.stopExecution() }
  }

  // MARK: one command

  private func perform(_ pending: HandsNext.Pending) async -> HandResult {
    let seq = pending.seq, command = pending.command
    // What this command costs counts from zero, also when it ends before it begins.
    observer.spent = HandsCost(); glided = nil
    remoteCheckAt = nil
    defer { remoteCheckAt = nil }
    // The bar with Stop is in view for a moment before the first mutating action of a run.
    let mutates: Bool
    switch command {
    case .observe, .zoom, .wait: mutates = false
    default: mutates = true
    }
    if mutates, let since = barUp {
      let age = Date().timeIntervalSince(since)
      if age < 0.25 { await pause(0.25 - age) }
    }
    if stop.stopped { return .failure(seq, .stoppedByPerson) }
    // Both checks are silent. With a right missing nothing runs.
    let accessibility = AXIsProcessTrusted()
    let screenRecording = !command.needsScreenRecording || CGPreflightScreenCaptureAccess()
    if let missing = command.missingRight(accessibility: accessibility, screenRecording: screenRecording) { return .failure(seq, missing) }
    input.beginCommand()
    inputRefusal = nil
    resolvedApp = nil
    keyboardHeld = false
    if heldDetail != nil { heldDetail = nil; showBar() }
    // While macOS guards the keyboard the tap sees none of the person's keys, Escape held among them. No input of
    // any kind goes then: the person holds the keyboard, and the worker asks.
    if mutates, keyboardHidden() { return heldForKeyboard(seq) }
    presentation.begin(seq)
    let outcome = await act(command, sequence: seq, label: pending.label, accessibility: accessibility)
    // Without the tap nobody listened, so nothing is said about the person.
    let interrupted = HandsGate.interrupted(watching: input.watching, personActed: input.personActed, keyboardHidden: keyboardHeld)
    if interrupted { presentation.reset() }
    if keyboardHeld, input.watching { heldDetail = HandsGate.keyboardHiddenDetail; showBar() }
    switch outcome {
    case .success(let seen):
      let result = HandResult.done(seq, observation: seen, interrupted: interrupted, resolvedBundleId: resolvedApp)
      // Contract failure cannot erase an already-submitted external effect.
      guard (try? result.validate()) != nil else {
        presentation.reset()
        desktop.invalidate()
        return .failure(seq, DesktopInputOutcome.invalidResult(command: command, submitted: input.submittedInput), interrupted: interrupted)
      }
      return result
    case .failure(let error):
      presentation.reset()
      // A partially submitted click/type/scroll is never described as a refusal
      // that can be retried. A takeover before input still pauses the worker.
      let reported = DesktopInputOutcome.failure(error, submitted: input.submittedInput, interrupted: interrupted)
      return .failure(seq, reported, interrupted: interrupted)
    }
  }

  private func act(_ command: HandCommand, sequence: Int, label: String, accessibility: Bool) async -> Result<Observation?, HandError> {
    if case .wait(let ms) = command {
      var left = Double(ms) / 1000
      while left > 0 {
        if stop.stopped { return .failure(.stoppedByPerson) }
        let slice = min(0.05, left)
        await pause(slice); left -= slice
      }
      return .success(nil)
    }
    // A locked screen, or another person's session in front: the hands do nothing.
    guard sessionOpen else { return .failure(.refused) }
    switch command {
    case .observe(let image, let elements):
      shield(true)
      return await desktop.observe(observer: observer, image: image, elements: elements, accessibility: accessibility, pointer: input.pointer).map { Optional($0) }
    case .zoom(let x, let y, let w, let h, let width, let height):
      // A picture only: no app gets input, the Accessibility tree is not read, and the look of the hands stays.
      shield(true)
      presentation.point(CGRect(x: x, y: y, width: w, height: h))
      return await observer.closer(x: x, y: y, w: w, h: h, width: width, height: height, pointer: input.pointer).map { Optional($0) }
    case .move, .click, .drag, .scroll:
      return await point(command, label: label)
    case .type(let text):
      // The hands never type into ClawdTime itself, and never into a password field.
      guard await keyboardFree(), !(await focusIsSecure()) else { return .failure(.refused) }
      if stop.stopped { return .failure(.stoppedByPerson) }
      // The guided cursor goes to the field first. That takes a moment, so Stop and the two checks run again after it.
      // The mascot leaves the field on the way.
      defer { guide.rest() }
      await pointAtKeyboard(label, makeRoom: true)
      if let refusal = await lastCheck() { return .failure(refusal) }
      guard await desktop.beginInput() else { return .failure(.staleObservation) }
      defer { desktop.endInput() }
      guard await mayType() else { return .failure(.refused) }
      showTyping(); defer { endTyping() }
      // A Tab or a Return in the text can move the keyboard, so the same two checks run again on the way.
      switch await input.type(text, allowed: { [self] in await mayType() }) {
      case .done: return .success(nil)
      case .stopped: return .failure(inputFailure())
      case .refused: return .failure(.refused)
      }
    case .key(let combo):
      guard let keys = KeyCombo.parse(combo), input.keyIsPermitted(keys), await keyboardFree() else { return .failure(.refused) }
      // No key goes into a password field: not a character, and not a shortcut such as Command V either.
      guard SecureField.permitsKey(keys, focusSecure: await focusIsSecure()) else { return .failure(.refused) }
      if stop.stopped { return .failure(.stoppedByPerson) }
      defer { guide.rest() }
      let changesSurface = CallPresentationKeyPolicy.mayChangeSurface(keys)
      if changesSurface { presentationTransition() }
      await pointAtKeyboard(label, presentTyping: !changesSurface)
      // Stop may have come during the waits above, and the keyboard may be in another place now.
      if let refusal = await lastCheck() { return .failure(refusal) }
      guard await desktop.beginInput(steady: true) else { return .failure(.staleObservation) }
      defer { desktop.endInput() }
      guard !Self.keyboardIsOwn else { return .failure(.refused) }
      guard SecureField.permitsKey(keys, focusSecure: await focusIsSecure()) else { return .failure(.refused) }
      showTyping(); defer { endTyping() }
      return await input.key(keys) ? .success(nil) : .failure(inputFailure())
    case .openApp(let name, let window):
      guard let safe = HandsTarget.appName(name) else { return .failure(.refused) }
      let resolved = Self.application(named: safe)
      guard case .success(let app) = resolved else {
        if case .failure(let error) = resolved { return .failure(error) }
        return .failure(.notFound)
      }
      defer { guide.rest() }
      await say(label)
      if let refusal = await lastCheck() { return .failure(refusal) }
      switch await desktop.activate(url: app, windowTitle: window, allowed: { [self] in await lastCheck() },
        observer: observer, pointer: { [self] in input.pointer }) {
      case .success(let arrival):
        resolvedApp = arrival.bundleID
        return .success(arrival.observation)
      case .failure(let error): return .failure(error)
      }
    case .switchPreviousApp:
      defer { guide.rest() }
      await say(label)
      if let refusal = await lastCheck() { return .failure(refusal) }
      return await desktop.switchPreviousApp(send: { [self] gate in await input.dispatchPreviousApp(allowed: gate) },
        allowed: { [self] in await lastCheck() }, observer: observer, pointer: { [self] in input.pointer })
    case .switchDesktop(let direction):
      defer { guide.rest() }
      await say(label)
      if let refusal = await lastCheck() { return .failure(refusal) }
      return await desktop.switchDesktop(direction: direction, sequence: sequence, configuration: { [self] in input.desktopShortcuts() },
        send: { [self] shortcut, gate in await input.dispatchDesktopShortcut(shortcut, allowed: gate) },
        allowed: { [self] in await lastCheck() }, observer: observer, pointer: { [self] in input.pointer })
    case .openURL(let text, let browser):
      // Only a web address. Another scheme can start a program or a call.
      guard let url = HandsTarget.webURL(text) else { return .failure(.refused) }
      // A browser by its name: one app that opens web addresses has it, or nothing is opened.
      var opener: URL?
      if let browser {
        guard let safe = HandsTarget.appName(browser) else { return .failure(.refused) }
        switch Self.opener(named: safe, of: url) {
        case .success(let app): opener = app
        case .failure(let error): return .failure(error)
        }
      }
      presentationTransition()
      defer { guide.rest() }
      await say(label)
      if let refusal = await lastCheck() { return .failure(refusal) }
      desktop.invalidate()
      guard let opener else { return NSWorkspace.shared.open(url) ? .success(nil) : .failure(.failed) }
      // The app takes the address itself: no key goes out, and the address bar is not touched.
      do {
        _ = try await NSWorkspace.shared.open([url], withApplicationAt: opener, configuration: NSWorkspace.OpenConfiguration())
        return .success(nil)
      } catch { return .failure(.failed) }
    case .quitApp(let name):
      guard let safe = HandsTarget.appName(name) else { return .failure(.refused) }
      guard case .success(let url) = Self.application(named: safe) else { return .failure(.notFound) }
      let path = url.resolvingSymlinksInPath().path
      // Only an app that runs and shows in the Dock, and never this panel.
      guard let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.activationPolicy == .regular && $0.processIdentifier != getpid() && $0.bundleURL?.resolvingSymlinksInPath().path == path
      }) else { return .failure(.notFound) }
      defer { guide.rest() }
      await say(label)
      if let refusal = await lastCheck() { return .failure(refusal) }
      presentationTransition()
      desktop.invalidate()
      // The polite quit, as the app's own Quit: no key goes out, and nothing is forced. An app that asks
      // about work that is not saved stays, and the worker then looks at what it asks.
      guard app.terminate() else { return .failure(.failed) }
      for _ in 0..<20 {
        if app.isTerminated { return .success(nil) }
        try? await Task.sleep(nanoseconds: 150_000_000)
      }
      return app.isTerminated ? .success(nil) : .failure(.failed)
    case .wait:
      return .success(nil)
    }
  }

  /// A canceled event is not necessarily a user Stop. Keep takeover, permission
  /// loss and stale desktop identity distinct; perform() upgrades partial effects.
  private func inputFailure() -> HandError {
    if stop.stopped || Task.isCancelled || input.halted { return .stoppedByPerson }
    if input.personActed || keyboardHeld { return .refused }
    if let inputRefusal { return inputRefusal }
    if !AXIsProcessTrusted() { return .noAccessibility }
    if !CGPreflightScreenCaptureAccess() { return .noScreenRecording }
    if !sessionOpen || !input.watching { return .refused }
    return desktop.inputGenerationCurrent ? .refused : .staleObservation
  }

  /// The last check before an event goes out, after the glide of the cursor: Stop at this Mac,
  /// the person's own mouse and keys since the command began, and Stop at the service, which is
  /// read once now. Nil: the event may go. `HandsGate` holds the rule.
  private func lastCheck() async -> HandError? {
    if Task.isCancelled || stop.stopped { return .stoppedByPerson }
    guard sessionOpen, input.watching else { return .refused }
    guard AXIsProcessTrusted() else { return .noAccessibility }
    guard CGPreflightScreenCaptureAccess() else { return .noScreenRecording }
    // Stop at this Mac, the person's own input and a keyboard that macOS guards need no read of the service.
    if let refusal = HandsGate.refusal(stopped: stop.stopped, watching: input.watching, personActed: input.personActed,
                                       keyboardHidden: keyboardHidden(), run: .init(active: true, goal: "", step: 0, state: "running")) { return refusal }
    // Coalesce redundant loopback service polls within 80 ms inside the same command.
    if let checkedAt = remoteCheckAt, Date().timeIntervalSince(checkedAt) < 0.08 { return nil }
    // The number of this command is taken already, so this read gives no command: only what the worker does now.
    let now = try? await client?.handsNext(after: ledger.last)
    guard sessionOpen, input.watching else { remoteCheckAt = nil; return .refused }
    guard AXIsProcessTrusted() else { remoteCheckAt = nil; return .noAccessibility }
    guard CGPreflightScreenCaptureAccess() else { remoteCheckAt = nil; return .noScreenRecording }
    let refusal = HandsGate.refusal(stopped: stop.stopped || Task.isCancelled, watching: input.watching, personActed: input.personActed,
                                    keyboardHidden: keyboardHidden(), run: now?.run)
    remoteCheckAt = refusal == nil ? Date() : nil
    return refusal
  }
  /// macOS guards the keyboard now (Secure Event Input). Each time it does during a command, the command counts as
  /// held back for the person.
  private func keyboardHidden() -> Bool {
    guard input.secureInput else { return false }
    keyboardHeld = true
    return true
  }
  /// The answer to an input that waits while macOS guards the keyboard: nothing was sent, and the person holds it.
  private func heldForKeyboard(_ seq: Int) -> HandResult {
    presentation.reset()
    if input.watching { heldDetail = HandsGate.keyboardHiddenDetail; showBar() }
    return .failure(seq, .refused, interrupted: HandsGate.interrupted(watching: input.watching, personActed: input.personActed, keyboardHidden: true))
  }

  /// Before typed text or a key: the guided cursor glides to the field that has the keyboard,
  /// with the label of the command. With no field known it stays where it last pointed.
  /// `makeRoom`: the mascot leaves the field and the place of the cursor first, and this returns when it is there.
  private func pointAtKeyboard(_ label: String, presentTyping: Bool = true, makeRoom clear: Bool = false) async {
    guard let map = HandsDisplay.main?.map else { return }
    let presentationGeneration = presentation.currentGeneration
    let surface = presentTyping ? presentation.currentSurface : nil
    // The Accessibility tree is read off the main thread, as everywhere here. It counts from the top.
    let field = await Task.detached(priority: .userInitiated) {
      let info = HandsTree.focusInfo()
      return (frame: info.frame, safeForPresentation: !presentTyping || info.secure == false)
    }.value
    let focus = field.frame
    let screen = CGRect(x: 0, y: 0, width: map.width, height: map.height)
    let target = GuidedFocus.place(focus: focus.map(map.flip), shown: guide.place, pointer: map.flip(input.pointer), screen: screen)
    if presentTyping {
      presentation.type(in: field.safeForPresentation ? focus : nil,
        overlay: map.flip(guide.presentationBounds(at: target, label: label)), observedSurface: surface,
        observedGeneration: presentationGeneration)
    }
    let moving = clear && makeRoom(for: [PetLayout.target(map.flip(target))] + (focus.map { [$0] } ?? []), map: map)
    await travel(to: target, label: label)
    if moving { await waitForRoom() }
  }
  /// The mascot, its bar and its bubble go out of the way of `targets`, in points from the top left of the
  /// main display, when they lie on one. True when the mascot moves: the input then waits for `waitForRoom`.
  private func makeRoom(for targets: [CGRect], map: ScreenMap) -> Bool {
    pet.makeRoom(for: targets.map(map.flip))
  }
  /// Waits until the mascot stands where it went, at most `PetLayout.roomWait` seconds. Stop ends the wait,
  /// and the check after it refuses the input.
  private func waitForRoom() async {
    let began = Date()
    while !pet.roomMade, !stop.stopped, Date().timeIntervalSince(began) < PetLayout.roomWait { await pause(1.0 / 120) }
  }
  /// A command with no place of its own, such as opening an app: the cursor says it where it is.
  private func say(_ label: String) async {
    guard let map = HandsDisplay.main?.map else { return }
    let screen = CGRect(x: 0, y: 0, width: map.width, height: map.height)
    await travel(to: GuidedFocus.place(focus: nil, shown: guide.place, pointer: map.flip(input.pointer), screen: screen), label: label)
  }

  /// A pointing command: the guided cursor glides to the target with the label of the command, then the real event goes.
  private func point(_ command: HandCommand, label: String) async -> Result<Observation?, HandError> {
    guard let map = HandsDisplay.main?.map, !command.places.isEmpty, command.places.allSatisfy(map.contains) else { return .failure(.refused) }
    let places = command.places.map(map.clamp)
    var restore: [() -> Void] = []
    defer { restore.forEach { $0() }; guide.rest() }
    // All geometry stays in the original top-left screen-point space. The
    // renderer alone maps it into the outgoing call video.
    let xs = places.map(\.x), ys = places.map(\.y)
    let action = CGRect(x: xs.min()! - 1, y: ys.min()! - 1,
      width: max(2, xs.max()! - xs.min()! + 2), height: max(2, ys.max()! - ys.min()! + 2))
    let overlay = map.flip(guide.presentationBounds(at: map.flip(places[0]), label: label))
    presentation.point(action.union(overlay))
    // The mascot leaves the places while the cursor glides. The event waits until it is there.
    let moving = makeRoom(for: places.map(PetLayout.target), map: map)
    await travel(to: map.flip(places[0]), label: label)
    if moving { await waitForRoom() }
    if let refusal = await lastCheck() { return .failure(refusal) }
    if case .drag = command, places.count == 2 {
      // A drag that presses on a password field or drops on one is refused: its text would go out of it or into it.
      let ends = (places[0], places[1])
      let secure = await Task.detached(priority: .userInitiated) { (HandsTree.isSecure(at: ends.0), HandsTree.isSecure(at: ends.1)) }.value
      guard SecureField.permitsDrag(source: secure.0, target: secure.1) else { return .failure(.refused) }
    }
    let allowCover: Bool
    if case .click(_, _, _, _, let allow) = command { allowCover = allow == true } else { allowCover = false }
    // ClawdTime's windows are not in the picture that the worker saw. A click on
    // one of them goes through to what is behind it, which is what the worker meant.
    // They let clicks through only from here: during the glide the bar keeps its Stop.
    guard await desktop.beginInput(steady: true, places: places, allowCover: allowCover) else { return .failure(.staleObservation) }
    defer { desktop.endInput() }
    // A place under a small window of the app in front (a list of suggestions, a card) gets no click unless
    // the command explicitly targets an observed cover that has not changed.
    guard !desktop.inputHides(places, allowCover: allowCover) else { return .failure(.targetNotVisible) }
    restore = passThrough(places.map(map.flip))
    guard await input.move(to: places[0]) else { return .failure(inputFailure()) }
    // A window of ClawdTime that came up on the way, for example a request with Approve on it, gets no click either.
    restore += passThrough(places.map(map.flip))
    let done: Bool
    switch command {
    case .click(_, _, let button, let count, _):
      guide.pulse()
      done = await input.click(at: places[0], button: button, count: count)
    case .drag:
      done = await input.drag(from: places[0], to: places[1])
    case .scroll(_, _, let dx, let dy):
      done = await input.scroll(at: places[0], dx: dx, dy: dy)
    default:
      done = true
    }
    return done ? .success(nil) : .failure(inputFailure())
  }

  // MARK: ClawdTime keeps out of its own way

  /// The windows of this app under `places` let clicks through. The result puts them back.
  private func passThrough(_ places: [CGPoint]) -> [() -> Void] {
    var restore: [() -> Void] = []
    if pet.visible, places.contains(where: pet.frame.contains) {
      pet.letClicksThrough(true)
      restore.append { [pet] in pet.letClicksThrough(false) }
    }
    for window in NSApp.windows where window !== pet.window && window.isVisible && !window.ignoresMouseEvents && places.contains(where: window.frame.contains) {
      window.ignoresMouseEvents = true
      restore.append { [weak window] in window?.ignoresMouseEvents = false }
    }
    return restore
  }
  /// A window of ClawdTime that shows and takes clicks lies at `place`, in screen points from the top left. It came
  /// up after `passThrough`, or it takes clicks again. With no main display nothing is known, and the place is not free.
  private func ownWindowTakes(_ place: CGPoint) -> Bool {
    guard let map = HandsDisplay.main?.map else { return true }
    return OwnWindows.takePointer(at: map.flip(place), NSApp.windows.map(OwnWindowState.init(window:)))
  }
  /// The keys would go to ClawdTime: its chat or another of its windows has the keyboard, or it is the app in front.
  private static var keyboardIsOwn: Bool { OwnWindows.holdKeyboard(keyWindow: NSApp.keyWindow != nil, active: NSApp.isActive) }
  /// Keys go to the window that has the keyboard. When that is a window of
  /// ClawdTime, for example its chat, this waits a moment for it to close.
  private func keyboardFree() async -> Bool {
    for _ in 0..<12 where Self.keyboardIsOwn { await pause(0.05) }
    return !Self.keyboardIsOwn
  }
  /// In the middle of typed text: the keyboard is still outside ClawdTime and outside a password field.
  private func mayType() async -> Bool {
    guard !Self.keyboardIsOwn, await lastCheck() == nil, await desktop.inputStillCurrent(steady: false) else { return false }
    guard !(await focusIsSecure()) else { return false }
    // The reads above wait: the keyboard is read once more after them.
    return !Self.keyboardIsOwn
  }
  /// The field that has the keyboard is a password field: the Accessibility
  /// tree says so, or macOS guards the keyboard as it does for one. An app that
  /// does not name its fields is covered by the second sign. Either one is enough.
  private func focusIsSecure() async -> Bool {
    let secure = await Task.detached(priority: .userInitiated) { HandsTree.focusIsSecure() }.value
    return secure == true || input.secureInput
  }
  /// While the worker runs, every window of this app has a sharing type that
  /// keeps it out of captures. The bar always has it. The guided cursor and its
  /// trail never have it: a screen share shows where ClawdTime acts.
  private func shield(_ on: Bool) {
    for window in NSApp.windows where window !== bar.window && !guide.isOverlay(window) {
      let type: NSWindow.SharingType = on ? .none : .readOnly
      if window.sharingType != type { window.sharingType = type }
    }
  }
  /// The person's own session is in front and the screen is not locked.
  private var sessionOpen: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session[kCGSessionOnConsoleKey as String] as? Bool == true && session["CGSSessionScreenIsLocked"] as? Bool != true
  }
  private func showTyping() { typingMark += 1; guide.typing(true) }
  /// Presentation-only transition seam for app/desktop activation. Call before
  /// switching; fresh surface observations establish the next video context.
  func presentationTransition() { presentation.transition() }
  /// Optional persistent lifecycle seam. Bridge a monotonic desktop producer's
  /// phase raw value to CallPresentationTransitionPhase; no desktop dependency
  /// is needed for this branch to build. Stop/reset fence observed old epochs.
  func presentationTransition(phase: CallPresentationTransitionPhase, epoch: Int) {
    presentation.transition(phase: phase, epoch: epoch)
  }
  /// The typing pose stays a moment after the last key, so one key press shows too.
  private func endTyping() {
    presentation.endTyping()
    let mark = typingMark
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 240_000_000)
      guard let self, self.typingMark == mark else { return }
      self.guide.typing(false)
    }
  }
  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  /// An app by the name that a person says, or by its bundle identifier.
  private static func application(named name: String) -> Result<URL, HandError> {
    let workspace = NSWorkspace.shared
    if name.contains("."), !name.contains(" "), let found = workspace.urlForApplication(withBundleIdentifier: name) { return .success(found) }
    let files = FileManager.default
    var candidates: [DesktopAppCandidate] = workspace.runningApplications.compactMap { app in
      guard app.activationPolicy == .regular, let url = app.bundleURL, let name = app.localizedName else { return nil }
      return DesktopAppCandidate(path: url.resolvingSymlinksInPath().path, names: [name])
    }
    for folder in appFolders {
      for file in ((try? files.contentsOfDirectory(atPath: folder)) ?? []) where file.hasSuffix(".app") {
        let url = URL(fileURLWithPath: folder + "/" + file).resolvingSymlinksInPath()
        let shown = files.displayName(atPath: url.path)
        candidates.append(DesktopAppCandidate(path: url.path,
          names: [String(file.dropLast(4)), shown.hasSuffix(".app") ? String(shown.dropLast(4)) : shown]))
      }
    }
    return DesktopAppSelection.path(named: name, candidates: candidates).map { URL(fileURLWithPath: $0) }
  }
  /// The folders where `open_app` looks for an app by its name.
  private static let appFolders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                                   NSHomeDirectory() + "/Applications", "/System/Library/CoreServices", "/System/Library/CoreServices/Applications"]
  /// Where macOS keeps its own browser now. It lists that browser there, not under /Applications.
  private static let systemAppsInCryptex = "/System/Volumes/Preboot/Cryptexes/App/System/Applications"
  /// The app that a person means by a name, among the apps that this Mac lists for a web address. Only an app
  /// in the folders of `open_app`, or the system browser in its own place: a browser of a test kit in a cache folder,
  /// or a copy in Downloads, is never chosen by its name.
  private static func opener(named name: String, of url: URL) -> Result<URL, HandError> {
    let files = FileManager.default
    let folders = Set((appFolders + [systemAppsInCryptex]).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
    let listed = NSWorkspace.shared.urlsForApplications(toOpen: url).filter { app in
      let path = app.resolvingSymlinksInPath()
      return folders.contains(path.deletingLastPathComponent().path)
    }
    let candidates = listed.map { app -> DesktopAppCandidate in
      let path = app.resolvingSymlinksInPath().path
      let shown = files.displayName(atPath: path)
      return DesktopAppCandidate(path: path,
        names: [app.deletingPathExtension().lastPathComponent, shown.hasSuffix(".app") ? String(shown.dropLast(4)) : shown])
    }
    return DesktopAppSelection.opener(named: name, candidates: candidates).map { URL(fileURLWithPath: $0) }
  }

  // MARK: rights

  /// The one menu item for the two rights. A click asks macOS for both; its second line shows each.
  func menuItem() -> NSMenuItem {
    let item = NSMenuItem(title: "Computer use: access and navigation setup", action: #selector(grantAccess), keyEquivalent: "")
    item.target = self
    item.toolTip = "ClawdTime needs both to act on this Mac when you ask it to. After you allow screen recording, macOS may ask you to start ClawdTime again."
    menuItems.add(item)
    describe(item)
    return item
  }
  /// Shows the state of each right on every copy of the menu item.
  func refreshMenu() { for item in menuItems.allObjects { describe(item) } }
  private func describe(_ item: NSMenuItem) {
    // Both reads are silent. They are kept for a few seconds: the menus refresh every second.
    if rights.map({ Date().timeIntervalSince($0.at) > 5 }) ?? true {
      rights = (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), Date())
    }
    let accessibility = rights?.accessibility == true, screenRecording = rights?.screenRecording == true
    let state = "Accessibility: \(accessibility ? "granted" : "not granted") · Screen recording: \(screenRecording ? "granted" : "not granted")"
    if #available(macOS 14.4, *) { item.subtitle = state } else { item.title = "Computer use: access and navigation setup (" + state + ")" }
    item.state = accessibility && screenRecording ? .on : .off
  }
  /// The person clicked the menu item. Only here may macOS show its prompts.
  @objc private func grantAccess() {
    if !AXIsProcessTrusted() {
      _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    if !CGPreflightScreenCaptureAccess() {
      // macOS shows its prompt for screen recording once. After that the person switches it on in System Settings.
      let defaults = UserDefaults.standard
      if defaults.bool(forKey: "hands.askedScreenRecording"),
        let pane = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
        NSWorkspace.shared.open(pane)
      } else {
        defaults.set(true, forKey: "hands.askedScreenRecording")
        _ = CGRequestScreenCaptureAccess()
      }
    }
    rights = nil
    refreshMenu()
    if AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() { navigationSetup() }
  }
  /// A person opens this setup summary. Reading settings never changes them and
  /// missing preference data is displayed as unknown, not a guessed default.
  private func navigationSetup() {
    let environment = ProcessInfo.processInfo.environment
    let left = environment["CLAWDTIME_SPACE_LEFT_SHORTCUT"].flatMap { KeyCombo.parse($0) == nil ? nil : $0 }
    let right = environment["CLAWDTIME_SPACE_RIGHT_SHORTCUT"].flatMap { KeyCombo.parse($0) == nil ? nil : $0 }
    let shortcuts: String
    if let left, let right, input.desktopShortcuts() != nil {
      shortcuts = "Left: \(left) · Right: \(right). Both combinations are enabled. Confirm they are assigned to Move left/right a space in Keyboard → Keyboard Shortcuts → Mission Control."
    } else {
      shortcuts = "Desktop shortcuts are not ready. Enable Move left/right a space in Keyboard → Keyboard Shortcuts → Mission Control, then configure ClawdTime with those exact combinations and relaunch it."
    }
    let setting = CFPreferencesCopyAppValue("workspaces-auto-swoosh" as CFString, "com.apple.dock" as CFString)
    let appSpaces: String
    if let setting, CFGetTypeID(setting) == CFBooleanGetTypeID() {
      appSpaces = (setting as! Bool) ? "The saved app-to-Space setting is enabled." : "The saved app-to-Space setting is disabled; activating an app may leave its window on another Space."
    } else { appSpaces = "The app-to-Space setting could not be confirmed." }
    let alert = NSAlert()
    alert.messageText = "App and desktop switching"
    alert.informativeText = "Accessibility and Screen Recording are granted.\n\n" + shortcuts + "\n\n" + appSpaces +
      " Check Desktop & Dock → Mission Control → When switching to an application, switch to a Space with open windows for the application.\n\nPrevious app uses Command–Tab once. A named app comes forward with the window that it chooses, on any number of displays. A named window and a desktop switch need one display; full-screen windows need verifiable window evidence, and Split View remains unsupported for them."
    alert.addButton(withTitle: "Done")
    alert.addButton(withTitle: "Open System Settings")
    if alert.runModal() == .alertSecondButtonReturn,
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") { NSWorkspace.shared.open(url) }
  }
}

extension OwnWindowState {
  /// A window of this app as AppKit has it now. The frame counts from the bottom left of the main display.
  @MainActor init(window: NSWindow) {
    self.init(frame: window.frame, visible: window.isVisible, takesClicks: !window.ignoresMouseEvents)
  }
}
